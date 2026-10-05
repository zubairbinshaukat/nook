// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display (or at another edge: dock.rs) inside a borderless,
// transparent, always-on-top window that never takes focus.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::dock::{self, Dock, Rect};
use crate::platform::{self, cursor_physical};

/// Logical size of the full window: the largest shape the island takes, which is
/// the session panel at its large size. The window is given that size once and
/// never follows the island as it grows and shrinks; click-through keeps the
/// rest of it out of the way. The large panel is 1120 × 640; the window has a
/// little more, for the spring it opens on to overshoot in without being cut
/// (layout.ts `OVERSHOOT_W`, `OVERSHOOT_H`).
pub const PANEL_MAX_W: f64 = 1120.0 + 16.0;
pub const PANEL_MAX_H: f64 = 640.0 + 14.0;
/// On a display too small for that, as much of it as fits — and never less than
/// the panel at its normal size, which every card fits in.
pub const PANEL_MIN_W: f64 = 720.0;
pub const PANEL_MIN_H: f64 = 320.0;
/// What the large panel leaves free of the display: on both sides together,
/// and under it, above the taskbar.
pub(crate) const SCREEN_MARGIN_W: f64 = 32.0;
pub(crate) const SCREEN_MARGIN_H: f64 = 24.0;
/// Logical size of the invisible strip that wakes the island when it is hidden.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default, PartialEq)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl IslandRect {
    /// Something has been drawn: the page has pushed a shape. Retracted, the
    /// island is a line along the edge it is docked to — no height at the top
    /// and bottom, no width on a side — and still takes the pointer there.
    fn drawn(&self) -> bool {
        self.w > 0.0 || self.h > 0.0
    }

    /// The point is on the island, or within the margin around it.
    fn near(&self, x: f64, y: f64) -> bool {
        self.drawn()
            && x >= self.x - HIT_MARGIN
            && x <= self.x + self.w + HIT_MARGIN
            && y >= self.y - HIT_MARGIN
            && y <= self.y + self.h + HIT_MARGIN
    }
}

/// Logical size of the full window on the display it is on, and the edge the
/// island is docked to. The front end places the island in it, and makes the
/// large panel no larger.
#[derive(Serialize, Clone, Copy, PartialEq)]
pub struct PanelSize {
    pub width: f64,
    pub height: f64,
    pub dock: Dock,
}

/// What the gate is told: the island wants to be polled, and the window is hidden.
#[derive(Default)]
struct Gate {
    wanted: bool,
    hidden: bool,
}

impl Gate {
    fn open(&self) -> bool {
        self.wanted && !self.hidden
    }
}

/// Wakes / parks the cursor poll thread — and the metrics one (metrics.rs) — so
/// a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<Gate>,
    cv: Condvar,
    /// How many times the gate has opened: what was measured before a park is
    /// told from what is measured after it.
    wakes: AtomicU64,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// The full window's size, as last worked out for the display.
    pub panel: Mutex<PanelSize>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(Gate::default()),
            cv: Condvar::new(),
            wakes: AtomicU64::new(0),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            panel: Mutex::new(PanelSize { width: PANEL_MIN_W, height: PANEL_MIN_H, dock: Dock::Top }),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    /// The island's own wish: on show (true) or folded away (false).
    pub fn set_active(&self, on: bool) {
        self.update(|gate| gate.wanted = on);
    }

    /// The window is hidden (visibility.rs): the gate stays closed, whatever the
    /// island wishes, until it is shown again.
    pub fn set_hidden(&self, hidden: bool) {
        self.update(|gate| gate.hidden = hidden);
    }

    fn update(&self, change: impl FnOnce(&mut Gate)) {
        let mut guard = self.active.lock().unwrap();
        let was = guard.open();
        change(&mut guard);
        if guard.open() && !was {
            self.wakes.fetch_add(1, Ordering::Relaxed);
        }
        self.cv.notify_all();
    }

    pub(crate) fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !guard.open() {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    /// Sleeps for `period`, or until the gate closes, whichever comes first:
    /// a thread with a slow tick is parked the moment the island hides, not a
    /// tick later. True when the gate is still open.
    pub(crate) fn wait_while_active(&self, period: Duration) -> bool {
        let guard = self.active.lock().unwrap();
        let (guard, _) = self.cv.wait_timeout_while(guard, period, |gate| gate.open()).unwrap();
        guard.open()
    }

    /// Changes every time the gate opens again after having been closed.
    pub(crate) fn wakes(&self) -> u64 {
        self.wakes.load(Ordering::Relaxed)
    }

    fn is_active(&self) -> bool {
        self.active.lock().unwrap().open()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

/// Hides the window altogether, or shows it again (visibility.rs). Hidden, it
/// takes no mouse and the polls are parked; shown, it is placed again — a
/// display may have changed — and takes the mouse as a fresh window does. The
/// window never takes focus, here either.
///
/// Done on the main thread: window calls made from another one are only
/// queued, and the show must have happened before the foreground is looked at
/// again (platform `show_inactive`). Calls queued in order stay in order, so
/// the last one asked is the one that stays.
pub fn set_shown(app: &AppHandle, shown: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || put_shown(&handle, shown));
}

fn put_shown(app: &AppHandle, shown: bool) {
    let Some(win) = window(app) else { return };
    let Some(shared) = app.try_state::<crate::Shared>() else { return };
    if !shown {
        shared.gate.set_hidden(true);
        let _ = win.hide();
        return;
    }
    let (pref, dock) = {
        let settings = shared.settings.lock().unwrap();
        (settings.screen.clone(), settings.dock())
    };
    // Placed again from the display as it is now: it may have changed while hidden.
    apply_geometry(app, &pref, dock, shared.gate.collapsed.load(Ordering::Relaxed));
    platform::show_inactive(&win);
    refresh_click_through(app, &shared.gate);
    shared.gate.set_hidden(false);
    // Hidden, the page got no frames: the island's size may still be what it
    // was when it went. The page puts it at its size at once (island.ts `onShown`).
    let _ = app.emit_to(WINDOW_LABEL, "island-shown", true);
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// The display the island lives on: the primary one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

fn rect_of(position: &PhysicalPosition<i32>, size: &PhysicalSize<u32>) -> Rect {
    Rect { x: position.x, y: position.y, w: size.width, h: size.height }
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the
/// panel. The arithmetic is dock.rs; this asks the display and applies the answer.
pub fn apply_geometry(app: &AppHandle, pref: &str, dock: Dock, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let monitor = rect_of(m.position(), m.size());
    let work = m.work_area();
    let place = dock::place(dock, monitor, rect_of(&work.position, &work.size), scale, collapsed);

    let panel = PanelSize { width: place.panel.0, height: place.panel.1, dock };
    if let Some(shared) = app.try_state::<crate::Shared>() {
        let mut known = shared.gate.panel.lock().unwrap();
        if *known != panel {
            *known = panel;
            let _ = app.emit_to(WINDOW_LABEL, "panel-size", panel);
        }
    }

    let (pw, ph) = place.size;
    let (x, y) = place.pos;

    // The compositor's own anchor, where there is one (Linux layer-shell).
    platform::set_dock(&win, dock);
    // GTK never sizes a non-resizable window below its natural size (200 px
    // here), so on Linux the 6 px wake strip would stay a 200 px block. tao
    // re-applies the config's `resizable: false` after the first configure, so
    // this is asked every time, just before the resize. Undecorated, the window
    // still offers the user nothing to resize it by. (Found by @YossiYad, #44.)
    #[cfg(target_os = "linux")]
    let _ = win.set_resizable(true);
    // A window resized keeps its top-left corner. At the top that corner is
    // where it stays, as it always did. Elsewhere it moves between the strip
    // and the panel, and the window is kept on its display at every step: in
    // first when it grows (put where the panel goes, then grown), shrunk first
    // when it collapses (then put where the strip goes). Grown first at the
    // bottom, it would hang below the display for a frame, onto one under it.
    let size = PhysicalSize::new(pw, ph);
    let at = PhysicalPosition::new(x, y);
    if dock == Dock::Top || collapsed {
        let _ = win.set_size(size);
        let _ = win.set_position(at);
    } else {
        let _ = win.set_position(at);
        let _ = win.set_size(size);
    }
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(size);
    let _ = win.set_always_on_top(true);
}

/// Position, size, work area and scale of the monitor the island lives on. Any
/// change here means the island has to be placed again.
#[derive(PartialEq)]
struct ScreenKey {
    monitor: Rect,
    work: Rect,
    scale: u64,
}

/// The monitor the island lives on as it is now, or None when there is none to ask.
fn current_screen_key(app: &AppHandle) -> Option<ScreenKey> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let work = m.work_area();
    Some(ScreenKey {
        monitor: rect_of(m.position(), m.size()),
        work: rect_of(&work.position, &work.size),
        scale: m.scale_factor().to_bits(),
    })
}

/// Emits `cursor` (window-logical coordinates) at ~40 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<ScreenKey> = None;
        // Without a cursor to read (Linux) the loop only watches the display
        // layout, and twice a second is plenty for that: waking at 60 Hz just to
        // find no cursor costs CPU for nothing.
        let (period, screen_every) = if platform::CURSOR_POLL { (24, 20) } else { (500, 1) };
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut last_rect = IslandRect { x: f64::MIN, ..IslandRect::default() };
            let mut ticks: u32 = 0;
            // Said again after every wake: what was in front may have changed while nothing looked.
            let mut last_full: Option<bool> = None;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(period));

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks.is_multiple_of(screen_every) {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning");
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                    // On the same slow tick: is a full-screen app in front on
                    // the island's display? The page hides the island when one
                    // comes (but for a request). Only while the island is on
                    // show — hidden, this thread is parked — and only when
                    // Settings ask for it.
                    let wanted = app
                        .try_state::<crate::Shared>()
                        .is_some_and(|shared| shared.settings.lock().unwrap().hide_in_fullscreen);
                    if wanted {
                        let full = platform::fullscreen_in_front(window(&app).as_ref());
                        if last_full != Some(full) {
                            last_full = Some(full);
                            let _ = app.emit_to(WINDOW_LABEL, "fullscreen", full);
                        }
                    } else {
                        last_full = None;
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let moved = (x - last.0).abs() >= 1.0 || (y - last.1).abs() >= 1.0;
                // The island changes shape under a cursor that does not move — the
                // large panel shrinking back, a card opening — and the window is
                // far larger than the island: the flag is decided again whenever
                // either of the two has changed, not only when the cursor has.
                let r = *gate.rect.lock().unwrap();
                if !moved && r == last_rect {
                    continue;
                }
                last_rect = r;

                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let on_island = r.near(x, y);

                if gate.ignoring.load(Ordering::Relaxed) == on_island {
                    gate.ignoring.store(!on_island, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!on_island);
                }

                // The page is only told of a cursor that moved: a shape that
                // changed is its own doing.
                if !moved {
                    continue;
                }
                last = (x, y);
                let _ = win.emit("cursor", CursorPayload { x, y });
            }

            // Parked: the window is (or is about to be) the wake strip, which must
            // take the mouse. The tick that was running when the island collapsed
            // may just have made it click-through, and setters from this thread are
            // queued to the event loop — so clear the flag from here, behind it.
            // Otherwise the hidden island can only be woken by Claude Code events.
            // Only where the poll owns click-through: without it (Linux) the
            // input region does, and it is set by refresh_click_through.
            if platform::CURSOR_POLL {
                if let Some(win) = window(&app) {
                    let _ = win.set_ignore_cursor_events(false);
                }
                gate.forget_ignore_state();
            }
        }
    });
}

/// Re-applies click-through after the window or the island changed shape.
///
/// With the cursor poll (Windows) the window takes the mouse again and the next
/// tick decides from the cursor. Without it (Linux) the input region is set to
/// the island itself, or to the whole wake strip while collapsed.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if platform::CURSOR_POLL {
        set_ignore_cursor(app, false);
        gate.forget_ignore_state();
        return;
    }
    let Some(win) = window(app) else { return };
    let region = if gate.collapsed.load(Ordering::Relaxed) {
        // The wake strip itself, never "the whole window": if the window ever
        // fails to shrink to the strip, the rest of it must not swallow clicks
        // meant for whatever sits under the edge of the screen. The strip is
        // the window, so it starts at its corner, whichever edge it is on.
        let (w, h) = if gate.panel.lock().unwrap().dock.vertical() { (STRIP_H, STRIP_W) } else { (STRIP_W, STRIP_H) };
        Some((0.0, 0.0, w, h))
    } else {
        let r = *gate.rect.lock().unwrap();
        if !r.drawn() {
            // Nothing drawn yet: nothing takes the mouse.
            Some((0.0, 0.0, 0.0, 0.0))
        } else {
            let x0 = (r.x - HIT_MARGIN).max(0.0);
            let y0 = (r.y - HIT_MARGIN).max(0.0);
            let x1 = r.x + r.w + HIT_MARGIN;
            let y1 = r.y + r.h + HIT_MARGIN;
            Some((x0, y0, x1 - x0, y1 - y0))
        }
    };
    platform::set_input_region(&win, region);
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hidden window keeps the gate shut, whatever the island wishes, and
    /// showing it opens the gate again if the island wanted it open.
    #[test]
    fn a_hidden_window_keeps_the_gate_closed() {
        let gate = PollGate::new();
        gate.set_active(true);
        assert!(gate.is_active());
        let wakes = gate.wakes();
        gate.set_hidden(true);
        assert!(!gate.is_active());
        // The page asks for polling while the window is hidden: still parked.
        gate.set_active(false);
        gate.set_active(true);
        assert!(!gate.is_active());
        assert_eq!(gate.wakes(), wakes);
        gate.set_hidden(false);
        assert!(gate.is_active());
        assert_eq!(gate.wakes(), wakes + 1);
        // Folded away while hidden: shown again, the gate stays shut.
        gate.set_hidden(true);
        gate.set_active(false);
        gate.set_hidden(false);
        assert!(!gate.is_active());
    }

    /// Retracted, the island is a line along its edge, and the pointer at that
    /// edge still finds it: with no height at the top, with no width on a side.
    /// Nothing pushed yet, nothing takes the pointer.
    #[test]
    fn a_retracted_island_is_still_found_at_its_edge() {
        let top = IslandRect { x: 476.0, y: 0.0, w: 184.0, h: 0.0 };
        assert!(top.near(568.0, 3.0));
        assert!(!top.near(568.0, 40.0));
        let left = IslandRect { x: 0.0, y: 308.0, w: 0.0, h: 38.0 };
        assert!(left.drawn());
        assert!(left.near(2.0, 327.0));
        assert!(!left.near(40.0, 327.0));
        assert!(!left.near(2.0, 200.0));
        let right = IslandRect { x: 1136.0, y: 308.0, w: 0.0, h: 38.0 };
        assert!(right.near(1134.0, 320.0));
        assert!(!IslandRect::default().near(0.0, 0.0));
    }

    /// The island coming back from hidden is the gate opening again: what
    /// samples the machine must start over at once, and not sleep on.
    #[test]
    fn a_wake_opens_the_gate_and_is_told_from_the_one_before() {
        let gate = Arc::new(PollGate::new());
        assert!(!gate.is_active());
        // Closed: a wait is over at once, and says so.
        assert!(!gate.wait_while_active(Duration::from_secs(5)));

        gate.set_active(true);
        let first = gate.wakes();
        assert!(gate.is_active());
        // Open, and left open: the wait runs its time and the gate is still open.
        assert!(gate.wait_while_active(Duration::from_millis(5)));
        // Opened again while open is no wake.
        gate.set_active(true);
        assert_eq!(gate.wakes(), first);

        // Hidden: whoever waits is let go the moment it happens, long before its period is over.
        let waiter = {
            let gate = gate.clone();
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                (gate.wait_while_active(Duration::from_secs(30)), started.elapsed())
            })
        };
        std::thread::sleep(Duration::from_millis(30));
        gate.set_active(false);
        let (still_open, waited) = waiter.join().unwrap();
        assert!(!still_open && waited < Duration::from_secs(10), "parked after {waited:?}");

        // Shown again: a thread parked on the gate goes on, and sees another wake.
        let parked = {
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait_until_active();
                gate.wakes()
            })
        };
        std::thread::sleep(Duration::from_millis(30));
        gate.set_active(true);
        assert_eq!(parked.join().unwrap(), first + 1);
        // Hidden and shown again inside one period: still open, but not the same wake.
        gate.set_active(false);
        gate.set_active(true);
        assert!(gate.wait_while_active(Duration::from_millis(5)));
        assert_eq!(gate.wakes(), first + 2);
    }
}
