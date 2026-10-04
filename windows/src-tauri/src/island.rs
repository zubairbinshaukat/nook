// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

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
const SCREEN_MARGIN_W: f64 = 32.0;
const SCREEN_MARGIN_H: f64 = 24.0;
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

/// Logical size of the full window on the display it is on. The front end
/// centres the island in it, and makes the large panel no larger.
#[derive(Serialize, Clone, Copy, PartialEq)]
pub struct PanelSize {
    pub width: f64,
    pub height: f64,
}

/// Wakes / parks the cursor poll thread — and the metrics one (metrics.rs) — so
/// a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
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
            active: Mutex::new(false),
            cv: Condvar::new(),
            wakes: AtomicU64::new(0),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            panel: Mutex::new(PanelSize { width: PANEL_MIN_W, height: PANEL_MIN_H }),
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

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        if on && !*guard {
            self.wakes.fetch_add(1, Ordering::Relaxed);
        }
        *guard = on;
        self.cv.notify_all();
    }

    pub(crate) fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    /// Sleeps for `period`, or until the gate closes, whichever comes first:
    /// a thread with a slow tick is parked the moment the island hides, not a
    /// tick later. True when the gate is still open.
    pub(crate) fn wait_while_active(&self, period: Duration) -> bool {
        let guard = self.active.lock().unwrap();
        let (guard, _) = self.cv.wait_timeout_while(guard, period, |active| *active).unwrap();
        *guard
    }

    /// Changes every time the gate opens again after having been closed.
    pub(crate) fn wakes(&self) -> u64 {
        self.wakes.load(Ordering::Relaxed)
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
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

/// The full window's logical size for a display this wide and with this much
/// height free under its top edge: the large panel, or what of it fits.
fn panel_size(screen_w: f64, free_h: f64) -> (f64, f64) {
    (
        (screen_w - SCREEN_MARGIN_W).clamp(PANEL_MIN_W, PANEL_MAX_W),
        (free_h - SCREEN_MARGIN_H).clamp(PANEL_MIN_H, PANEL_MAX_H),
    )
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the panel.
pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();

    // The window hangs from the display's top edge, so what counts is the
    // height from there down to where the work area ends (the taskbar).
    let work = m.work_area();
    let free_h = (work.position.y + work.size.height as i32 - mp.y).max(0) as f64 / scale;
    let (full_w, full_h) = panel_size(ms.width as f64 / scale, free_h);
    // In whole physical pixels, and told to the front end as it really is.
    let full_pw = (full_w * scale).round().max(1.0);
    let full_ph = (full_h * scale).round().max(1.0);
    let panel = PanelSize { width: full_pw / scale, height: full_ph / scale };
    if let Some(shared) = app.try_state::<crate::Shared>() {
        let mut known = shared.gate.panel.lock().unwrap();
        if *known != panel {
            *known = panel;
            let _ = app.emit_to(WINDOW_LABEL, "panel-size", panel);
        }
    }

    let (pw, ph) = if collapsed {
        ((STRIP_W * scale).round().max(1.0) as u32, (STRIP_H * scale).round().max(1.0) as u32)
    } else {
        (full_pw as u32, full_ph as u32)
    };
    let x = mp.x + (ms.width as i32 - pw as i32) / 2;
    let y = mp.y;

    // GTK never sizes a non-resizable window below its natural size (200 px
    // here), so on Linux the 6 px wake strip would stay a 200 px block. tao
    // re-applies the config's `resizable: false` after the first configure, so
    // this is asked every time, just before the resize. Undecorated, the window
    // still offers the user nothing to resize it by. (Found by @YossiYad, #44.)
    #[cfg(target_os = "linux")]
    let _ = win.set_resizable(true);
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~40 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
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
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

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
        // meant for whatever sits under the top of the screen.
        Some((0.0, 0.0, STRIP_W, STRIP_H))
    } else {
        let r = *gate.rect.lock().unwrap();
        if r.w <= 0.0 {
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

    #[test]
    fn the_window_is_the_large_panel_or_what_of_it_the_display_has_room_for() {
        // A display with room to spare: the large panel, whole.
        assert_eq!(panel_size(1920.0, 1040.0), (PANEL_MAX_W, PANEL_MAX_H));
        assert_eq!(panel_size(3840.0, 2100.0), (PANEL_MAX_W, PANEL_MAX_H));
        // A small laptop at 150 %: 1024 × 640 logical, 600 free above the taskbar.
        assert_eq!(panel_size(1024.0, 600.0), (1024.0 - SCREEN_MARGIN_W, 600.0 - SCREEN_MARGIN_H));
        // Smaller than the normal panel: the normal panel, as before.
        assert_eq!(panel_size(700.0, 300.0), (PANEL_MIN_W, PANEL_MIN_H));
        assert_eq!(panel_size(0.0, 0.0), (PANEL_MIN_W, PANEL_MIN_H));
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
