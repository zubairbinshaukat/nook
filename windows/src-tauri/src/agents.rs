// The agents list: a small window, off until Settings turns it on, with one row
// per project — what its sessions are doing, how full their context is, what
// the last one said — and a click on a row goes to that project's window.
//
// It is an always-on-top window that takes no focus (a click on it never takes
// the keyboard from the terminal), is not in the taskbar or Alt-Tab, and follows
// the user across virtual desktops (platform `follow_desktops`). The island's
// page works out the rows — it holds the sessions — and hands them over as one
// snapshot (`agents_snapshot`); Rust keeps the latest and gives it to the list.
// Whether the island is hidden changes nothing here: its page runs on.
//
// Visible = the setting is on and the user has not hidden it (the shortcut, the
// tray, its own ×). That is never saved; the setting is, and the place the list
// was left in, which is put back inside a display that is still there.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, State, WebviewWindow, WebviewWindowBuilder};

use crate::island;
use crate::log;
use crate::platform;
use crate::{settings, Shared};

pub const WINDOW_LABEL: &str = "agents";

/// What the list's page hears, and what the island's page hears of it.
const SNAPSHOT_EVENT: &str = "agents-snapshot";
const WANTED_EVENT: &str = "agents-wanted";
/// The list is told when it is shown and hidden, to start and stop its clock.
const VISIBLE_EVENT: &str = "agents-visible";

/// The window's logical width out of the box, and the least and most the user can
/// make it (never more than a display's work area, `clamp_width`).
const WIDTH: f64 = 330.0;
pub const MIN_WIDTH: f64 = 280.0;
pub const MAX_WIDTH: f64 = 640.0;
/// The window is as tall as its rows (the page says how tall they are), never
/// less than `MIN_HEIGHT`, and no taller than a cap: `DEFAULT_CAP` until the user
/// drags the bottom edge, which sets it, up to `MAX_CAP`. Past the cap, or a
/// display's work area, the rows scroll.
pub const MIN_HEIGHT: f64 = 72.0;
const DEFAULT_CAP: f64 = 520.0;
pub const MAX_CAP: f64 = 2000.0;
/// Where it first appears: this far, in logical pixels, from the top right of the main display's work area.
const FIRST_MARGIN: f64 = 16.0;
/// A snapshot is a few rows of short lines; one past this is not one.
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024;
/// The place is saved this long after the last move: dragging is a run of them.
const SAVE_AFTER: Duration = Duration::from_millis(500);

#[derive(Default)]
struct Inner {
    /// The user hid it, by the shortcut, the tray or its ×. Never saved.
    hidden: bool,
    /// The window is on show as far as Rust last put it.
    shown: bool,
    /// The latest snapshot the island's page sent.
    latest: Option<Value>,
    /// How tall the page said its rows are, in logical pixels.
    content: f64,
    /// An edge being dragged, from the press to the release.
    drag: Option<Drag>,
}

#[derive(Default)]
pub struct Agents(Mutex<Inner>);

impl Agents {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Moves on with every move of the window: a save waits for the last.
static MOVES: AtomicU64 = AtomicU64::new(0);

/// A rectangle of the desktop in physical pixels: a display's work area, or the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

fn overlap(a: Rect, b: Rect) -> i64 {
    let w = (a.x + a.w).min(b.x + b.w) as i64 - a.x.max(b.x) as i64;
    let h = (a.y + a.h).min(b.y + b.h) as i64 - a.y.max(b.y) as i64;
    if w > 0 && h > 0 { w * h } else { 0 }
}

fn centre_gap(a: Rect, b: Rect) -> i64 {
    let (dx, dy) = ((a.x + a.w / 2) as i64 - (b.x + b.w / 2) as i64, (a.y + a.h / 2) as i64 - (b.y + b.h / 2) as i64);
    dx * dx + dy * dy
}

/// The display a window is on: the work area it overlaps most, or — when it is
/// on none, as after a display was unplugged — the nearest.
fn area_for(window: Rect, areas: &[Rect]) -> Option<Rect> {
    areas
        .iter()
        .filter(|a| a.w > 0 && a.h > 0)
        .max_by_key(|a| (overlap(window, **a), -centre_gap(window, **a)))
        .copied()
}

/// The width in physical pixels for a wanted logical one: between the least and
/// most, and never wider than the work area (the least wins on a tiny one).
pub fn clamp_width(want: f64, scale: f64, area_w: i32) -> i32 {
    let least = (MIN_WIDTH * scale).round() as i32;
    let most = ((MAX_WIDTH * scale).round() as i32).min(area_w).max(least);
    ((want * scale).round() as i32).clamp(least, most)
}

/// The height in physical pixels of a window whose rows are `content` tall:
/// that, but no more than the user's `cap` or the work area, and never less than
/// the least (which wins on a tiny area). Fewer rows than fit make a shorter
/// window, not an empty one. Logical pixels in, physical out.
pub fn clamp_height(content: f64, cap: f64, scale: f64, area_h: i32) -> i32 {
    let least = (MIN_HEIGHT * scale).round() as i32;
    ((content.min(cap) * scale).round() as i32).min(area_h).max(least)
}

/// What the window is meant to be, in logical pixels: the width the user chose,
/// how tall its rows are, and the most it may be tall.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Wanted {
    pub width: f64,
    pub content: f64,
    pub cap: f64,
}

/// Where a window of `size` wanted at `want` goes so that all of it is inside a
/// display's work area: the one it overlaps most, or — when it is on none, as
/// after a display was unplugged — the nearest. A window bigger than the area
/// sits at its corner. None only when there is no display to put it on.
pub fn place_in(want: (i32, i32), size: (i32, i32), areas: &[Rect]) -> Option<(i32, i32)> {
    let window = Rect { x: want.0, y: want.1, w: size.0, h: size.1 };
    let area = area_for(window, areas)?;
    let x = want.0.clamp(area.x, (area.x + area.w - size.0).max(area.x));
    let y = want.1.clamp(area.y, (area.y + area.h - size.1).max(area.y));
    Some((x, y))
}

/// Where a window now `height` tall, as `wanted` says, goes at `want` on displays
/// of this `scale`: its physical x, y, width and height. The width and height are
/// held to the display it lands on, then the place is held to that size, so that
/// all of it is on a display.
pub fn layout(want: (i32, i32), height: i32, wanted: Wanted, scale: f64, areas: &[Rect]) -> Option<(i32, i32, i32, i32)> {
    let first = Rect { x: want.0, y: want.1, w: (wanted.width * scale).round() as i32, h: height };
    let area = area_for(first, areas)?;
    let w = clamp_width(wanted.width, scale, area.w);
    let h = clamp_height(wanted.content, wanted.cap, scale, area.h);
    let (x, y) = place_in(want, (w, h), areas)?;
    Some((x, y, w, h))
}

/// Which edge, or bottom corner, of the list is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Bottom,
    BottomLeft,
    BottomRight,
}

impl Side {
    fn left(self) -> bool {
        matches!(self, Side::Left | Side::BottomLeft)
    }

    fn right(self) -> bool {
        matches!(self, Side::Right | Side::BottomRight)
    }

    fn bottom(self) -> bool {
        matches!(self, Side::Bottom | Side::BottomLeft | Side::BottomRight)
    }
}

/// An edge drag: the window's edges when it began, and how far the cursor was
/// from the held ones, so that they stay under the pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Drag {
    pub side: Side,
    pub left: i32,
    pub right: i32,
    pub top: i32,
    pub grab: i32,
    pub grab_y: i32,
}

impl Drag {
    pub fn begin(side: Side, window: Rect, cursor: (i32, i32)) -> Drag {
        let (left, right) = (window.x, window.x + window.w);
        let grab = if side.left() { left - cursor.0 } else if side.right() { right - cursor.0 } else { 0 };
        Drag { side, left, right, top: window.y, grab, grab_y: window.y + window.h - cursor.1 }
    }
}

/// The x and the width the dragged window takes with the cursor at `cursor_x`:
/// the other edge stays where it was, the width stays between the least and most
/// and inside the work area, so the window never leaves it however far the
/// cursor goes.
pub fn dragged(drag: Drag, cursor_x: i32, scale: f64, area: Rect) -> (i32, i32) {
    let least = (MIN_WIDTH * scale).round() as i32;
    let most = (MAX_WIDTH * scale).round() as i32;
    let held = cursor_x + drag.grab;
    if drag.side.right() {
        let w = (held - drag.left).clamp(least, most.min(area.x + area.w - drag.left).max(least));
        (drag.left.min(area.x + area.w - w).max(area.x), w)
    } else if drag.side.left() {
        let w = (drag.right - held).clamp(least, most.min(drag.right - area.x).max(least));
        (drag.right - w, w)
    } else {
        // The bottom edge alone: the width is not its business.
        (drag.left, drag.right - drag.left)
    }
}

/// The height the bottom edge, held by a drag that has one, is dragged to with
/// the cursor at `cursor_y`: from the top of the window down to the cursor, between
/// the least and the work area's bottom. That is the window's height, and what
/// the cap is made of; None for a drag of the sides alone.
pub fn dragged_height(drag: Drag, cursor_y: i32, scale: f64, area: Rect) -> Option<i32> {
    if !drag.side.bottom() {
        return None;
    }
    let least = (MIN_HEIGHT * scale).round() as i32;
    Some((cursor_y + drag.grab_y - drag.top).clamp(least, (area.y + area.h - drag.top).max(least)))
}

/// Where it first appears: the top right of a work area, `margin` from its edges.
pub fn first_position(area: Rect, size: (i32, i32), margin: i32) -> (i32, i32) {
    (area.x + area.w - size.0 - margin, area.y + margin)
}

/// The tray item's words, for what a press does.
pub fn label(shown: bool) -> &'static str {
    if shown { "Hide agents list" } else { "Show agents list" }
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn enabled(app: &AppHandle) -> bool {
    app.try_state::<Shared>().is_some_and(|shared| shared.settings.lock().unwrap().show_agents_list)
}

fn area_of(m: &Monitor) -> Rect {
    let work = m.work_area();
    Rect { x: work.position.x, y: work.position.y, w: work.size.width as i32, h: work.size.height as i32 }
}

fn work_areas(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors().map(|monitors| monitors.iter().map(area_of).collect()).unwrap_or_default()
}

/// Created hidden at launch, like the settings window, and only shown and hidden
/// afterwards (a webview made later comes up blank, see lib.rs). It is made
/// whether or not the list is on, so that turning it on needs no restart; while
/// it is off the window is never shown, and its page does nothing.
pub fn create_window(app: &AppHandle) {
    let url = crate::page_url(app, "agents.html");
    let built = WebviewWindowBuilder::new(app, WINDOW_LABEL, url)
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Agents — Nook")
        .inner_size(WIDTH, MIN_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .build();
    match built {
        Ok(win) => {
            platform::prepare_list_window(&win);
            let handle = app.clone();
            let this = win.clone();
            win.on_window_event(move |event| match event {
                // Closed, it is only hidden: the user's choice, until the next show.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    hide(&handle);
                }
                tauri::WindowEvent::Moved(at) if this.is_visible().unwrap_or(false) => note_moved(&handle, at.x, at.y),
                // Another display's scale: the logical width is put back, and the place held inside the display.
                tauri::WindowEvent::ScaleFactorChanged { .. } if this.is_visible().unwrap_or(false) => {
                    let again = handle.clone();
                    let _ = handle.run_on_main_thread(move || settle(&again));
                }
                _ => {}
            });
        }
        Err(err) => log::line(format!("agents window failed: {err}")),
    }
}

/// At launch, once the shortcuts are in: the list is on show if the setting is on.
pub fn start(app: &AppHandle) {
    apply(app);
}

/// Settings turned the list on or off: its shortcut and its window follow, now.
pub fn set_enabled(app: &AppHandle, on: bool) {
    if on {
        app.state::<Agents>().lock().hidden = false;
    }
    crate::shortcut::allow_agents(app, on);
    apply(app);
}

/// The shortcut, or the tray: shown if hidden, hidden if shown. Nothing when the list is off.
pub fn toggle(app: &AppHandle) {
    if !enabled(app) {
        return;
    }
    {
        let agents = app.state::<Agents>();
        let mut inner = agents.lock();
        inner.hidden = !inner.hidden;
    }
    apply(app);
}

/// Its ×, or the window asked to close.
pub fn hide(app: &AppHandle) {
    app.state::<Agents>().lock().hidden = true;
    apply(app);
}

/// Puts the window as the state says. On the main thread: window calls made from
/// another are only queued, and the show must come before the foreground is
/// looked at again (platform `show_inactive`). Queued in order, the last asked stays.
fn apply(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || put_shown(&handle));
}

fn put_shown(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let on = enabled(app);
    let agents = app.state::<Agents>();
    let show = on && !agents.lock().hidden;
    if show {
        place_saved(app, &win);
        platform::show_inactive(&win);
        platform::follow_desktops(&win, true);
        // Hidden, the page got nothing: the island is asked for the rows again.
        let _ = app.emit_to(island::WINDOW_LABEL, WANTED_EVENT, ());
    } else {
        platform::follow_desktops(&win, false);
        let _ = win.hide();
        agents.lock().drag = None;
    }
    agents.lock().shown = show;
    let _ = app.emit_to(WINDOW_LABEL, VISIBLE_EVENT, show);
    crate::tray::say_agents(app, on, show);
}

/// Where it was left, or the first place, inside a display that is there now.
fn place_saved(app: &AppHandle, win: &WebviewWindow) {
    let saved = app.try_state::<Shared>().and_then(|shared| {
        let s = shared.settings.lock().unwrap();
        s.agents_list_x.zip(s.agents_list_y)
    });
    let Some(want) = saved.or_else(|| first_for(app, win)) else { return };
    place(app, win, want);
}

/// The width the user left it at, in logical pixels, or the default.
fn saved_width(app: &AppHandle) -> f64 {
    app.try_state::<Shared>()
        .and_then(|shared| shared.settings.lock().unwrap().agents_list_w)
        .map_or(WIDTH, f64::from)
}

/// The width the user left it at, how tall its rows are, and the most it may be tall.
fn wanted(app: &AppHandle) -> Wanted {
    let content = app.state::<Agents>().lock().content;
    let cap = app
        .try_state::<Shared>()
        .and_then(|shared| shared.settings.lock().unwrap().agents_list_h)
        .map_or(DEFAULT_CAP, f64::from);
    Wanted { width: saved_width(app), content, cap }
}

/// The first place: the top right of the main display.
fn first_for(app: &AppHandle, win: &WebviewWindow) -> Option<(i32, i32)> {
    let main = app.primary_monitor().ok().flatten()?;
    let size = win.outer_size().ok()?;
    let area = area_of(&main);
    let width = clamp_width(saved_width(app), main.scale_factor(), area.w);
    let margin = (FIRST_MARGIN * main.scale_factor()).round() as i32;
    Some(first_position(area, (width, size.height as i32), margin))
}

/// Puts the window at `want` with the width and height it is meant to have,
/// moved in until all of it is on a display. Twice: a window that crosses to a
/// display of another scale changes size on arriving.
fn place(app: &AppHandle, win: &WebviewWindow, want: (i32, i32)) {
    let areas = work_areas(app);
    let wanted = wanted(app);
    let mut want = want;
    for _ in 0..2 {
        let Ok(size) = win.outer_size() else { return };
        let scale = win.scale_factor().unwrap_or(1.0);
        let Some((x, y, w, h)) = layout(want, size.height as i32, wanted, scale, &areas) else { return };
        if (w, h) != (size.width as i32, size.height as i32) {
            let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
        }
        let _ = win.set_position(PhysicalPosition::new(x, y));
        want = (x, y);
    }
}

/// The window put back as it is meant to be where it is: its width, and inside its display.
fn settle(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    if let Ok(at) = win.outer_position() {
        place(app, &win, (at.x, at.y));
    }
}

/// The window moved (dragged, or put back inside a display): kept, and saved a
/// moment after the last move. A position far off the desktop is a window being
/// parked by the system, and is not kept.
fn note_moved(app: &AppHandle, x: i32, y: i32) {
    if x < -30_000 || y < -30_000 {
        return;
    }
    let Some(shared) = app.try_state::<Shared>() else { return };
    {
        let mut current = shared.settings.lock().unwrap();
        if (current.agents_list_x, current.agents_list_y) == (Some(x), Some(y)) {
            return;
        }
        current.agents_list_x = Some(x);
        current.agents_list_y = Some(y);
    }
    save_soon(app);
}

/// The place or the width changed: saved a moment after the last change.
fn save_soon(app: &AppHandle) {
    let generation = MOVES.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_AFTER).await;
        if MOVES.load(Ordering::SeqCst) != generation {
            return;
        }
        let current = app.state::<Shared>().settings.lock().unwrap().clone();
        if let Err(err) = settings::save(&current) {
            eprintln!("[nook] could not save settings: {err}");
        }
    });
}

// ── What the list's page asks ─────────────────────────────────────────────────

/// The island's page hands over the rows. Only the island may: it holds the
/// sessions. Kept, and told to the list.
#[tauri::command]
pub fn agents_snapshot(app: AppHandle, window: tauri::Window, agents: State<Agents>, snapshot: Value) {
    if window.label() != island::WINDOW_LABEL || serde_json::to_string(&snapshot).map_or(true, |text| text.len() > MAX_SNAPSHOT_BYTES) {
        return;
    }
    agents.lock().latest = Some(snapshot.clone());
    let _ = app.emit_to(WINDOW_LABEL, SNAPSHOT_EVENT, snapshot);
}

/// Whether the list is on show: asked by a page that loaded after it was shown.
#[tauri::command]
pub fn agents_shown(agents: State<Agents>) -> bool {
    agents.lock().shown
}

/// The latest rows, for a list that was loaded after they were sent.
#[tauri::command]
pub fn agents_last(agents: State<Agents>) -> Option<Value> {
    agents.lock().latest.clone()
}

/// The list's page says how tall its rows are, however tall the window is: the
/// window is that tall, within its least, the user's cap and the display, and
/// put back inside the display if that took it out. The width is not touched, so
/// a height is never answered by a width — and a cap is never answered by this:
/// the page reports its rows, not the window, so it does not report again.
#[tauri::command]
pub fn agents_fit(app: AppHandle, agents: State<Agents>, height: f64) {
    let Some(win) = window(&app) else { return };
    if !height.is_finite() {
        return;
    }
    agents.lock().content = height.clamp(0.0, MAX_CAP);
    if let Ok(at) = win.outer_position() {
        place(&app, &win, (at.x, at.y));
    }
}

// ── The width, and the most the height may be ─────────────────────────────────
//
// Not the system's resize (`startResizeDragging`): that needs a sizing frame
// (tao gives a frameless window one only with `resizable`), and then tao's hit
// test turns all four borders and the corners of the window into sizing grips
// too — the top would take the height from the fit, and the header's top edge
// would stop being a place to press. So the page puts a thin handle on each
// side, on the bottom and on its two bottom corners and, with the pointer
// captured, asks for the size as the cursor moves; the cursor is read here, in
// physical pixels, so the scale of the display is no concern of the page's. The
// bottom edge sets a cap, not a height: the window is as tall as its rows, up
// to it.

/// The edge of the list that is held, the one the page names; None for anything else.
fn side_of(word: &str) -> Option<Side> {
    match word {
        "left" => Some(Side::Left),
        "right" => Some(Side::Right),
        "bottom" => Some(Side::Bottom),
        "bottom-left" => Some(Side::BottomLeft),
        "bottom-right" => Some(Side::BottomRight),
        _ => None,
    }
}

/// The window, its place and size, and where the cursor is; only for the list's own page.
fn grip(app: &AppHandle, from: &tauri::Window) -> Option<(WebviewWindow, Rect, (i32, i32), f64)> {
    if from.label() != WINDOW_LABEL {
        return None;
    }
    let win = window(app)?;
    let (at, size) = (win.outer_position().ok()?, win.outer_size().ok()?);
    let cursor = app.cursor_position().ok()?;
    let rect = Rect { x: at.x, y: at.y, w: size.width as i32, h: size.height as i32 };
    let scale = win.scale_factor().ok()?;
    Some((win, rect, (cursor.x.round() as i32, cursor.y.round() as i32), scale))
}

/// An edge was pressed.
#[tauri::command]
pub fn agents_resize_begin(app: AppHandle, window: tauri::Window, agents: State<Agents>, side: String) {
    let Some(side) = side_of(&side) else { return };
    let Some((_, rect, cursor, _)) = grip(&app, &window) else { return };    agents.lock().drag = Some(Drag::begin(side, rect, cursor));
}

/// The pointer moved with the edge held. A window that is not on show, or no
/// edge held, is nothing to do.
#[tauri::command]
pub fn agents_resize_move(app: AppHandle, window: tauri::Window, agents: State<Agents>) {
    let Some(drag) = agents.lock().drag else { return };
    let Some((win, rect, cursor, scale)) = grip(&app, &window) else { return };
    let Some(area) = area_for(rect, &work_areas(&app)) else { return };
    let (x, w) = dragged(drag, cursor.0, scale, area);
    // The cap the bottom edge gives, if one is held, and the height the window has with it.
    let cap = dragged_height(drag, cursor.1, scale, area).map(|h| keep_cap(&app, h, scale));
    let h = cap.map_or(rect.h, |cap| clamp_height(agents.lock().content, cap, scale, area.h));
    if (x, w, h) == (rect.x, rect.w, rect.h) {
        return;
    }
    let (size, at) = (PhysicalSize::new(w as u32, h as u32), PhysicalPosition::new(x, rect.y));
    // Whichever way keeps the window inside its place at every step: out first when it grows, in first when it shrinks.
    if w > rect.w || h > rect.h {
        let _ = win.set_position(at);
        let _ = win.set_size(size);
    } else {
        let _ = win.set_size(size);
        let _ = win.set_position(at);
    }
    if drag.side.left() || drag.side.right() {
        keep_width(&app, w, scale);
    }
}

/// The edge was let go (or the pointer was lost): the width stays as it is.
#[tauri::command]
pub fn agents_resize_end(agents: State<Agents>) {
    agents.lock().drag = None;
}

/// The header was double-clicked: the default width and the default most height,
/// with the left edge and the top where they are.
#[tauri::command]
pub fn agents_resize_reset(app: AppHandle, window: tauri::Window) {
    if window.label() != WINDOW_LABEL {
        return;
    }
    if let Some(shared) = app.try_state::<Shared>() {
        let mut current = shared.settings.lock().unwrap();
        current.agents_list_w = None;
        current.agents_list_h = None;
    }
    settle(&app);
    save_soon(&app);
}

/// Keeps the most height the bottom edge was dragged to, as logical pixels, and
/// saves it a moment later. Gives the cap back, for the window to be sized by.
fn keep_cap(app: &AppHandle, physical: i32, scale: f64) -> f64 {
    let logical = (f64::from(physical) / scale).round().clamp(MIN_HEIGHT, MAX_CAP) as u32;
    if let Some(shared) = app.try_state::<Shared>() {
        {
            let mut current = shared.settings.lock().unwrap();
            if current.agents_list_h == Some(logical) {
                return f64::from(logical);
            }
            current.agents_list_h = Some(logical);
        }
        save_soon(app);
    }
    f64::from(logical)
}

/// Keeps the width the window has now, as logical pixels, and saves it a moment later.
fn keep_width(app: &AppHandle, physical: i32, scale: f64) {
    let logical = (f64::from(physical) / scale).round().clamp(MIN_WIDTH, MAX_WIDTH) as u32;
    let Some(shared) = app.try_state::<Shared>() else { return };
    {
        let mut current = shared.settings.lock().unwrap();
        if current.agents_list_w == Some(logical) {
            return;
        }
        current.agents_list_w = Some(logical);
    }
    save_soon(app);
}

/// The × of the list.
#[tauri::command]
pub fn agents_hide(app: AppHandle) {
    hide(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };
    const SIZE: (i32, i32) = (330, 200);

    #[test]
    fn a_window_inside_a_display_stays_where_it_is() {
        assert_eq!(place_in((100, 80), SIZE, &[AREA]), Some((100, 80)));
        assert_eq!(place_in((1590, 840), SIZE, &[AREA]), Some((1590, 840)));
    }

    #[test]
    fn a_window_over_an_edge_is_moved_in_whole() {
        assert_eq!(place_in((1800, 900), SIZE, &[AREA]), Some((1590, 840)));
        assert_eq!(place_in((-50, -20), SIZE, &[AREA]), Some((0, 0)));
        // Bigger than the area: at its corner, never off it.
        assert_eq!(place_in((300, 300), (400, 2000), &[Rect { x: 10, y: 20, w: 300, h: 500 }]), Some((10, 20)));
    }

    #[test]
    fn a_window_on_a_display_that_is_gone_comes_to_the_nearest_one() {
        // Saved on a second display to the left; only the main one is left.
        assert_eq!(place_in((-1500, 100), SIZE, &[AREA]), Some((0, 100)));
        // Two displays, the saved place nearer the right one.
        let right = Rect { x: 1920, y: 0, w: 1920, h: 1040 };
        assert_eq!(place_in((5000, 100), SIZE, &[AREA, right]), Some((3510, 100)));
        assert_eq!(place_in((-4000, 100), SIZE, &[AREA, right]), Some((0, 100)));
    }

    #[test]
    fn a_window_across_two_displays_goes_to_the_one_it_is_mostly_on() {
        let right = Rect { x: 1920, y: 0, w: 1920, h: 1040 };
        assert_eq!(place_in((1900, 50), SIZE, &[AREA, right]), Some((1920, 50)));
        assert_eq!(place_in((1700, 50), SIZE, &[AREA, right]), Some((1590, 50)));
    }

    #[test]
    fn with_no_display_there_is_no_place() {
        assert_eq!(place_in((0, 0), SIZE, &[]), None);
        assert_eq!(place_in((0, 0), SIZE, &[Rect { x: 0, y: 0, w: 0, h: 0 }]), None);
    }

    #[test]
    fn a_work_area_that_does_not_start_at_zero_is_respected() {
        // A taskbar on the left: the area starts at x = 48.
        let area = Rect { x: 48, y: 0, w: 1872, h: 1080 };
        assert_eq!(place_in((0, 10), SIZE, &[area]), Some((48, 10)));
        assert_eq!(first_position(area, SIZE, 16), (48 + 1872 - 330 - 16, 16));
    }

    #[test]
    fn the_width_is_held_between_its_limits_and_inside_the_display() {
        assert_eq!(clamp_width(330.0, 1.0, 1920), 330);
        assert_eq!(clamp_width(100.0, 1.0, 1920), 280);
        assert_eq!(clamp_width(9000.0, 1.0, 1920), 640);
        assert_eq!(clamp_width(f64::NAN, 1.0, 1920), 280);
        // Scaled: the limits are logical.
        assert_eq!(clamp_width(330.0, 1.5, 3840), 495);
        assert_eq!(clamp_width(100.0, 1.5, 3840), 420);
        assert_eq!(clamp_width(900.0, 1.5, 3840), 960);
        // A work area narrower than the most: never wider than it ...
        assert_eq!(clamp_width(640.0, 1.0, 500), 500);
        // ... and the least wins on one narrower than that.
        assert_eq!(clamp_width(640.0, 1.0, 200), 280);
    }

    #[test]
    fn the_place_is_held_to_the_new_size() {
        let want = |width: f64, content: f64, cap: f64| Wanted { width, content, cap };
        // 330 wide at the right edge, then made 500 wide: it is moved in to fit.
        assert_eq!(layout((1590, 100), 200, want(500.0, 200.0, 520.0), 1.0, &[AREA]), Some((1420, 100, 500, 200)));
        // Wider than the display allows: the width gives way first.
        let narrow = Rect { x: 0, y: 0, w: 400, h: 600 };
        assert_eq!(layout((50, 10), 200, want(640.0, 200.0, 520.0), 1.0, &[narrow]), Some((0, 10, 400, 200)));
        // A display of another scale: the same logical size is more pixels.
        let hi = Rect { x: 0, y: 0, w: 2880, h: 1560 };
        assert_eq!(layout((2500, 0), 300, want(330.0, 200.0, 520.0), 1.5, &[hi]), Some((2385, 0, 495, 300)));
        // A saved place on a display that is gone.
        assert_eq!(layout((-1500, 100), 200, want(330.0, 200.0, 520.0), 1.0, &[AREA]), Some((0, 100, 330, 200)));
        assert_eq!(layout((0, 0), 200, want(330.0, 200.0, 520.0), 1.0, &[]), None);
        // A cap shorter than the rows: the window is the cap; a taller one changes nothing; and a window
        // low on the display is moved up to keep all of it on.
        assert_eq!(layout((100, 100), 200, want(330.0, 500.0, 300.0), 1.0, &[AREA]), Some((100, 100, 330, 300)));
        assert_eq!(layout((100, 100), 200, want(330.0, 200.0, 900.0), 1.0, &[AREA]), Some((100, 100, 330, 200)));
        assert_eq!(layout((100, 900), 200, want(330.0, 500.0, 600.0), 1.0, &[AREA]), Some((100, 540, 330, 500)));
    }

    #[test]
    fn the_height_is_the_rows_within_the_cap_the_display_and_the_least() {
        // Fewer rows than the cap: as tall as the rows, no empty box.
        assert_eq!(clamp_height(200.0, 520.0, 1.0, 1040), 200);
        // More rows than the cap: the cap, and the rows scroll.
        assert_eq!(clamp_height(900.0, 520.0, 1.0, 1040), 520);
        assert_eq!(clamp_height(900.0, 300.0, 1.0, 1040), 300);
        // The least, however short the rows or the cap.
        assert_eq!(clamp_height(10.0, 520.0, 1.0, 1040), 72);
        assert_eq!(clamp_height(0.0, 520.0, 1.0, 1040), 72);
        assert_eq!(clamp_height(900.0, 20.0, 1.0, 1040), 72);
        // A cap taller than the display: the display's work area.
        assert_eq!(clamp_height(1500.0, 2000.0, 1.0, 1040), 1040);
        // ... and the least wins on an area shorter than that.
        assert_eq!(clamp_height(500.0, 520.0, 1.0, 40), 72);
        // Scaled: the limits are logical, the area is not.
        assert_eq!(clamp_height(200.0, 520.0, 1.5, 1560), 300);
        assert_eq!(clamp_height(900.0, 300.0, 1.5, 1560), 450);
        assert_eq!(clamp_height(10.0, 520.0, 1.5, 1560), 108);
        assert_eq!(clamp_height(1500.0, 2000.0, 1.5, 1560), 1560);
    }

    #[test]
    fn dragging_the_bottom_edge_sets_the_height_and_leaves_the_width() {
        let window = Rect { x: 1000, y: 100, w: 330, h: 300 };
        let drag = Drag::begin(Side::Bottom, window, (1100, 402));
        assert_eq!(drag.grab_y, -2);
        assert_eq!(dragged_height(drag, 402, 1.0, AREA), Some(300));
        assert_eq!(dragged_height(drag, 602, 1.0, AREA), Some(500));
        assert_eq!(dragged_height(drag, 120, 1.0, AREA), Some(72));
        // The display ends first: the window stays on it.
        assert_eq!(dragged_height(drag, 5000, 1.0, AREA), Some(940));
        // Scaled limits.
        assert_eq!(dragged_height(drag, 0, 2.0, Rect { x: 0, y: 0, w: 3840, h: 2000 }), Some(144));
        // The width is not the bottom edge's business, at any cursor.
        assert_eq!(dragged(drag, 100, 1.0, AREA), (1000, 330));
        assert_eq!(dragged(drag, 5000, 1.0, AREA), (1000, 330));
        // The sides alone have no height.
        assert_eq!(dragged_height(Drag::begin(Side::Left, window, (1000, 200)), 900, 1.0, AREA), None);
        assert_eq!(dragged_height(Drag::begin(Side::Right, window, (1330, 200)), 900, 1.0, AREA), None);
    }

    #[test]
    fn a_bottom_corner_drags_one_side_and_the_bottom_together() {
        let window = Rect { x: 1000, y: 100, w: 330, h: 300 };
        let right = Drag::begin(Side::BottomRight, window, (1332, 402));
        assert_eq!((right.grab, right.grab_y), (-2, -2));
        assert_eq!(dragged(right, 1432, 1.0, AREA), (1000, 430));
        assert_eq!(dragged_height(right, 502, 1.0, AREA), Some(400));
        let left = Drag::begin(Side::BottomLeft, window, (998, 402));
        assert_eq!(dragged(left, 898, 1.0, AREA), (900, 430));
        assert_eq!(dragged_height(left, 502, 1.0, AREA), Some(400));
        // A bottom corner takes the width the way its side does: never past the most.
        assert_eq!(dragged(left, -3000, 1.0, AREA), (690, 640));
    }

    #[test]
    fn dragging_the_right_edge_moves_only_that_edge() {
        let drag = Drag::begin(Side::Right, Rect { x: 1000, y: 0, w: 330, h: 200 }, (1328, 100));
        assert_eq!(drag.grab, 2);
        assert_eq!(dragged(drag, 1328, 1.0, AREA), (1000, 330));
        assert_eq!(dragged(drag, 1428, 1.0, AREA), (1000, 430));
        assert_eq!(dragged(drag, 1100, 1.0, AREA), (1000, 280));
        assert_eq!(dragged(drag, 5000, 1.0, AREA), (1000, 640));
        // The display ends first.
        let drag = Drag::begin(Side::Right, Rect { x: 1700, y: 0, w: 330, h: 200 }, (2028, 100));
        // (Not even the least fits: the left edge gives way, the window stays on it.)
        assert_eq!(dragged(drag, 2500, 1.0, AREA), (1640, 280));
    }

    #[test]
    fn dragging_the_left_edge_keeps_the_right_one_still() {
        let drag = Drag::begin(Side::Left, Rect { x: 1000, y: 0, w: 330, h: 200 }, (1002, 100));
        assert_eq!(drag.grab, -2);
        assert_eq!(dragged(drag, 1002, 1.0, AREA), (1000, 330));
        assert_eq!(dragged(drag, 902, 1.0, AREA), (900, 430));
        assert_eq!(dragged(drag, 1300, 1.0, AREA), (1050, 280));
        assert_eq!(dragged(drag, -3000, 1.0, AREA), (690, 640));
        // Near the left of the display: it stops there.
        let near = Drag::begin(Side::Left, Rect { x: 100, y: 0, w: 330, h: 200 }, (102, 100));
        assert_eq!(dragged(near, -500, 1.0, AREA), (0, 430));
        // Scaled limits.
        assert_eq!(dragged(drag, 0, 2.0, Rect { x: 0, y: 0, w: 3840, h: 2000 }), (1330 - 1280, 1280));
    }

    #[test]
    fn the_edges_are_named_by_the_page() {
        assert_eq!(side_of("left"), Some(Side::Left));
        assert_eq!(side_of("right"), Some(Side::Right));
        assert_eq!(side_of("bottom"), Some(Side::Bottom));
        assert_eq!(side_of("bottom-left"), Some(Side::BottomLeft));
        assert_eq!(side_of("bottom-right"), Some(Side::BottomRight));
        assert_eq!(side_of("top"), None);
    }

    #[test]
    fn the_tray_says_what_a_press_does() {
        assert_eq!(label(false), "Show agents list");
        assert_eq!(label(true), "Hide agents list");
    }
}
