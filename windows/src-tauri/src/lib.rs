// Nook for Windows — app wiring and the commands the island calls.

mod about;
mod agents;
#[cfg_attr(not(windows), allow(dead_code))]
mod codex_hooks;
mod cursor_hooks;
mod dock;
mod fullscreen;
mod hooks;
mod island;
mod log;
mod media;
mod metrics;
mod openfile;
mod pipe;
mod platform;
mod projects;
mod reply;
mod replyformat;
mod settings;
mod shelf;
mod shortcut;
mod statusline;
mod target;
mod tray;
mod usage;
mod visibility;

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use hooks::{HookPreview, HookStatus};
use island::{PanelSize, PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;
use statusline::UsageStatus;
use target::{Kind, Plan, Sessions};

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    /// The full window's logical size: what the island is centred in, and the
    /// most the large panel can be on this display.
    panel: PanelSize,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, window: tauri::Window, shared: State<Shared>) -> BootInfo {
    // An island that boots while Nook already knows the usage limits — its
    // page was reloaded — is told them again. (`usage_last` asks for the same.)
    if window.label() == island::WINDOW_LABEL {
        usage::tell_island(&app);
    }
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    let panel = *shared.gate.panel.lock().unwrap();
    BootInfo {
        settings,
        screen,
        panel,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, theme_changed, agents_changed, settings) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        // The global shortcuts are not preferences a page writes: they change
        // through `set_shortcut` alone, which registers one before it saves it.
        // The rest is held to what Nook knows (settings.rs `validated`): the
        // compact metrics, three at most; the theme, the motion and the bot's
        // colours, one of their choices; the Shelf's widgets, known ones, once.
        let settings = Settings {
            expand_shortcut: current.expand_shortcut.clone(),
            expand_shortcut_enabled: current.expand_shortcut_enabled,
            goto_shortcut: current.goto_shortcut.clone(),
            goto_shortcut_enabled: current.goto_shortcut_enabled,
            panel_shortcut: current.panel_shortcut.clone(),
            panel_shortcut_enabled: current.panel_shortcut_enabled,
            hide_shortcut: current.hide_shortcut.clone(),
            hide_shortcut_enabled: current.hide_shortcut_enabled,
            agents_shortcut: current.agents_shortcut.clone(),
            agents_shortcut_enabled: current.agents_shortcut_enabled,
            // Where the list was left is Rust's to write, as it is dragged.
            agents_list_x: current.agents_list_x,
            agents_list_y: current.agents_list_y,
            agents_list_w: current.agents_list_w,
            agents_list_h: current.agents_list_h,
            ..settings
        }
        .validated();
        // The island is placed again when the display or the edge it hangs from changes.
        let screen_changed = screen_changed || current.dock != settings.dock;
        let theme_changed = current.theme != settings.theme;
        let agents_changed = current.show_agents_list != settings.show_agents_list;
        *current = settings.clone();
        (screen_changed, autostart_changed, theme_changed, agents_changed, settings)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[nook] could not save settings: {err}");
    }
    if theme_changed {
        wear_theme(&app, &settings.theme);
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[nook] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, settings.dock(), collapsed);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings.clone());
    // The agents list is turned on or off: its window and its shortcut follow at
    // once. After the emit: the island's page answers a show with the rows only
    // once it knows the setting is on.
    if agents_changed {
        agents::set_enabled(&app, settings.show_agents_list);
    }
}

/// The display the island lives on and the edge it hangs from, as saved.
fn placement(shared: &Shared) -> (String, dock::Dock) {
    let settings = shared.settings.lock().unwrap();
    (settings.screen.clone(), settings.dock())
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let (pref, dock) = placement(&shared);
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, dock, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

/// The island takes the keyboard — a typed answer, the large panel and its
/// Escape, the sidebar's arrows — or gives it back to whoever had it.
#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

/// Whether a full-screen app is in front on the island's display, now: what
/// the page asks before a hidden island wakes on hover or on a session's work
/// (Settings → Island, "Hide in full-screen apps"). A few system calls, made
/// when asked: nothing watches for it while the island is hidden. Always
/// false on Linux.
#[tauri::command]
fn fullscreen_now(app: AppHandle) -> bool {
    platform::fullscreen_in_front(island::window(&app).as_ref())
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let (pref, dock) = placement(&shared);
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, dock, collapsed);
}

/// The address the Claude desktop app answers to, through the scheme it registers.
const CLAUDE_APP_URL: &str = "claude://";

/// Brings the Claude desktop app forward. The address is fixed here: nothing
/// the interface sends is run.
fn open_claude_app() {
    platform::open_url(CLAUDE_APP_URL);
}

/// The island's ↗: goes to where a session runs — the editor's window for its
/// folder, the terminal's window, the Claude app. The page names the session
/// and nothing else: where that is was worked out from what the relay reported
/// (target.rs), and a session nothing is known about goes nowhere.
///
/// Off the main thread: it lists every window, and may wait on another program's.
#[tauri::command(async)]
fn focus_session(sessions: State<Sessions>, session_id: String) -> bool {
    let Some(plan) = sessions.plan(&session_id) else {
        log::line("focus session: nothing known of where it runs");
        return false;
    };
    let went = go_to(&plan);
    log::line(format!("focus session in {}: {}", plan.target.label, if went { "done" } else { "no window to go to" }));
    went
}

fn go_to(plan: &Plan) -> bool {
    // A pid is given out again once its process has gone: only the processes
    // that are still the program the relay named are gone to.
    let chain = target::still_there(&plan.chain, platform::image_name);
    let cwd = plan.cwd.as_deref();
    match plan.target.kind {
        Kind::Unknown => false,
        Kind::Claude => {
            open_claude_app();
            true
        }
        Kind::Terminal => target::terminal_window(&platform::top_windows(), &chain, cwd).is_some_and(platform::bring_forward),
        Kind::Vscode | Kind::Cursor => {
            let pids: Vec<u32> = chain.iter().map(|p| p.pid).collect();
            // The editor the relay named must still be there for one of its windows to be touched.
            let named = plan.target.pid.is_some_and(|pid| pids.contains(&pid));
            let window = target::editor_image(&plan.target)
                .filter(|_| named)
                .and_then(|image| target::editor_window(&platform::top_windows(), image, cwd, &pids));
            match window {
                Some(window) => platform::bring_forward(window),
                // No window of it at all: the folder is opened in it, as before.
                None => target::launcher_of(&plan.target).is_some_and(|launcher| open_folder_in(launcher, plan.cwd.clone())),
            }
        }
    }
}

/// Opens a folder in an editor through its launcher — `code`, `cursor` — when
/// it is on PATH, and falls back to the file manager otherwise. The launcher is
/// one of our own names (target.rs), never something a payload said.
fn open_folder_in(launcher: &str, path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path(launcher) {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

/// The session a reply's file is opened for, and its editor's launcher: one
/// the relay reported, running in an editor (VS Code, VS Code Insiders,
/// Cursor). What `open_session_file` opens for, `session_files_exist` answers
/// for, and no other.
fn editor_session(sessions: &Sessions, session_id: &str) -> Result<(Plan, &'static str), &'static str> {
    let plan = sessions.plan(session_id).ok_or("nothing known of where the session runs")?;
    let launcher = match plan.target.kind {
        Kind::Vscode | Kind::Cursor => target::launcher_of(&plan.target),
        _ => None,
    };
    launcher.map(|launcher| (plan, launcher)).ok_or("the session does not run in an editor")
}

/// Whether the names a reply writes are files that `open_session_file` would
/// open: the same session lookup, the same folder, the same rule
/// (openfile.rs `resolve`). The page asks it of a bare name — `markdown.ts`,
/// `node.js` — before drawing it as a link. One yes or no per path, in order,
/// and nothing else: a session that is not in an editor, or not known, gets
/// no for all of them, and so does everything past `openfile::MAX_CHECKS`.
/// Nothing is logged: a name that is no file is the usual answer.
///
/// Off the main thread: it looks at the file system.
#[tauri::command(async)]
fn session_files_exist(sessions: State<Sessions>, session_id: String, paths: Vec<String>) -> Vec<bool> {
    match editor_session(&sessions, &session_id) {
        Ok((plan, _)) => openfile::exist(plan.cwd.as_deref(), &paths),
        Err(_) => vec![false; paths.len()],
    }
}

/// A file a reply names, opened in the editor its session runs in — at a
/// line, when the reply gave one. The page names the session and hands over
/// the path as the model wrote it; nothing else is the page's to say:
///
/// - the session must be one the relay reported, running in an editor (VS Code,
///   VS Code Insiders, Cursor). Any other session — a terminal's, the Claude
///   app's, one nothing is known of — opens nothing: no editor is guessed;
/// - the editor's launcher is the one of target.rs `EDITORS` for that editor,
///   found on PATH, as `focus_session` finds it;
/// - the path goes through openfile.rs `resolve`: one existing regular file on
///   a local drive, relative paths taken from the session's recorded folder;
/// - the launcher is started as `<launcher> --goto <file>[:line[:col]]`, the
///   file as one argument, no shell, no console window.
///
/// The file is shown, never run; no URL is ever opened. False whenever any of
/// this does not hold.
///
/// Off the main thread: it looks at the file system and starts a process.
#[tauri::command(async)]
fn open_session_file(sessions: State<Sessions>, session_id: String, path: String, line: Option<u32>) -> bool {
    let (plan, launcher) = match editor_session(&sessions, &session_id) {
        Ok(found) => found,
        Err(why) => {
            log::line(format!("open file: {why}"));
            return false;
        }
    };
    // `path:line:col`, when the page left the position on the path.
    let (path, at_line, at_col) = openfile::split_position(&path);
    let line = line.or(at_line);
    let col = at_col.filter(|_| line == at_line);
    let Some(file) = openfile::resolve(plan.cwd.as_deref(), path) else {
        log::line(format!("open file in {}: no such file", plan.target.label));
        return false;
    };
    let Some(program) = platform::find_on_path(launcher) else {
        log::line(format!("open file in {}: `{launcher}` is not on PATH", plan.target.label));
        return false;
    };
    let mut cmd = Command::new(program);
    cmd.arg("--goto").arg(openfile::goto_argument(&file, line, col));
    let opened = platform::no_console(&mut cmd).spawn().is_ok();
    log::line(format!("open file in {}: {}", plan.target.label, if opened { "done" } else { "the launcher did not start" }));
    opened
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Cursor's hooks (~/.cursor/hooks.json; status only) ────────────────────────

#[tauri::command]
fn cursor_status() -> cursor_hooks::CursorStatus {
    cursor_hooks::status()
}

/// The diff to look at before anything is written. `install: false` previews removal.
#[tauri::command]
fn cursor_preview(install: bool) -> Result<HookPreview, String> {
    cursor_hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn cursor_apply(app: AppHandle, shared: State<Shared>, install: bool, fingerprint: String) -> Result<String, String> {
    let backup = cursor_hooks::apply(install, &fingerprint)?;
    // Installed hooks mean Cursor sessions are wanted; removed, there is nothing to show.
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        if install {
            current.show_cursor_sessions = true;
        }
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Codex's hooks (~/.codex/hooks.json) ───────────────────────────────────────

#[tauri::command]
fn codex_status() -> codex_hooks::CodexStatus {
    codex_hooks::status()
}

/// The diff to look at before anything is written. `install: false` previews removal.
#[tauri::command]
fn codex_preview(install: bool) -> Result<HookPreview, String> {
    codex_hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn codex_apply(app: AppHandle, shared: State<Shared>, install: bool, fingerprint: String) -> Result<String, String> {
    let backup = codex_hooks::apply(install, &fingerprint)?;
    // Installed hooks mean Codex sessions are wanted; removed, there is nothing to show.
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        if install {
            current.show_codex_sessions = true;
        }
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Claude's usage limits ─────────────────────────────────────────────────────

/// The latest usage Claude Code reported to its status line, or nothing yet.
#[tauri::command]
fn usage_last(app: AppHandle) -> Option<usage::Usage> {
    usage::last(&app)
}

/// Whether the relay is Claude Code's status line command, which is how the
/// usage limits reach Nook.
#[tauri::command]
fn usage_status() -> UsageStatus {
    statusline::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn usage_preview(install: bool) -> Result<HookPreview, String> {
    statusline::preview(install)
}

/// Only ever called from an explicit click in the settings window, with the
/// fingerprint of the preview that was looked at.
#[tauri::command]
fn usage_apply(install: bool, fingerprint: String) -> Result<String, String> {
    statusline::apply(install, &fingerprint)
}

// ── The reply format, in the user's CLAUDE.md ─────────────────────────────────

/// Where Nook's reply-format block stands in ~/.claude/CLAUDE.md.
#[tauri::command]
fn reply_format_status() -> replyformat::ReplyFormatStatus {
    replyformat::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn reply_format_preview(action: replyformat::Action) -> Result<HookPreview, String> {
    replyformat::preview(action)
}

/// Only ever called from an explicit click in the settings window, with the
/// fingerprint of the preview that was looked at.
#[tauri::command]
fn reply_format_apply(action: replyformat::Action, fingerprint: String) -> Result<String, String> {
    replyformat::apply(action, &fingerprint)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

/// The island answered a question Claude asked with its question tool.
#[tauri::command]
fn approval_answer(app: AppHandle, request_id: String, answers: serde_json::Map<String, serde_json::Value>) {
    pipe::answer_question(&app, &request_id, &answers);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── The Shelf's Media widget ──────────────────────────────────────────────────
// What the system says is playing, and its controls (media.rs). Each is a
// question the page asks, and only while the widget is on show; Rust asks the
// system, waits for its answer on a worker thread, and answers.

#[tauri::command(async)]
fn media_state() -> media::MediaState {
    media::state()
}

/// The current track's album art as a `data:` URL, read to memory: never written to disk.
#[tauri::command(async)]
fn media_cover() -> Option<String> {
    media::cover()
}

#[tauri::command(async)]
fn media_control(action: media::Action) -> bool {
    media::control(action)
}

#[tauri::command(async)]
fn media_volume() -> Option<u8> {
    media::volume()
}

#[tauri::command(async)]
fn media_set_volume(percent: u8) -> bool {
    media::set_volume(percent)
}
// ── The Shelf's Projects widget ───────────────────────────────────────────────
// The folders sessions have run in, and two launchers (projects.rs). The page
// names a folder; Rust launches it only if it is on its own list.

#[tauri::command(async)]
fn projects_list(store: State<shelf::Store>) -> Vec<projects::Project> {
    projects::list(&store)
}

/// A session was seen running in this folder (the working folder of a hook event).
#[tauri::command(async)]
fn projects_note(store: State<shelf::Store>, cwd: String) {
    projects::note(&store, &cwd);
}

#[tauri::command(async)]
fn projects_open_code(store: State<shelf::Store>, path: String) -> bool {
    let opened = projects::open_in_code(&store, &path);
    log::line(format!("projects: open in VS Code: {}", if opened { "done" } else { "refused or `code` not found" }));
    opened
}

#[tauri::command(async)]
fn projects_new_session(store: State<shelf::Store>, path: String) -> bool {
    let started = projects::new_session(&store, &path);
    log::line(format!("projects: new Claude session: {}", if started { "done" } else { "refused or Windows Terminal not found" }));
    started
}
// ── The global shortcuts ──────────────────────────────────────────────────────

#[tauri::command]
fn shortcut_status(app: AppHandle) -> shortcut::Statuses {
    shortcut::statuses(&app)
}

/// The settings window picks another combination for one of the five shortcuts,
/// or switches it on or off. It is saved only once it is registered: one that
/// is not a combination, that is reserved, that is another Nook shortcut's, or
/// that another program holds comes back as the reason why, and what was there
/// before stays.
#[tauri::command]
fn set_shortcut(app: AppHandle, shared: State<Shared>, which: shortcut::Which, accelerator: String, enabled: bool) -> Result<shortcut::Status, String> {
    let status = shortcut::change(&app, which, &accelerator, enabled)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        which.save(&mut current, &status);
        if let Err(err) = settings::save(&current) {
            eprintln!("[nook] could not save settings: {err}");
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(status)
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so another window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
pub(crate) fn page_url(app: &AppHandle, page: &str) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path(&format!("/{page}"));
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App(page.into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = page_url(app, "settings.html");
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — Nook")
        .inner_size(800.0, 760.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

/// The settings window's own frame — its title bar — in the theme picked in
/// it: "light", "dark", or the system's. The page colours itself; this is only
/// what the OS draws around it. The island has no frame, and stays dark.
fn wear_theme(app: &AppHandle, theme: &str) {
    let Some(win) = app.get_webview_window("settings") else { return };
    let theme = match theme {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    let _ = win.set_theme(theme);
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    // Before it shows: the frame is in the saved theme from the first look.
    let theme = app.state::<Shared>().settings.lock().unwrap().theme.clone();
    wear_theme(app, &theme);
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

// ── The settings window's About section, and its one way to start again ───────

/// Opens one of the About section's links in the system browser. The page
/// names it by id; the address is a constant in about.rs. An id that is not
/// one of the four never gets here.
#[tauri::command]
fn open_link(which: about::Link) {
    about::open_link(which);
}

/// Where Nook keeps its files, as the About section shows them.
#[tauri::command]
fn data_paths() -> about::DataPaths {
    about::data_paths()
}

/// Opens the folder the log is in. No argument: the folder is Nook's own.
#[tauri::command]
fn open_log_folder() {
    about::open_log_folder();
}

/// Closes Nook and starts it again: what puts a missing relay back in place
/// (hooks.rs `ensure_hook_exe` runs at launch). It goes through the ordinary
/// way out, so the global shortcuts and the single-instance lock are let go
/// before the new process asks for them.
#[tauri::command]
fn restart_app(app: AppHandle) {
    log::line("restart asked for in the settings window");
    app.request_restart();
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            visibility::open(app);
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(shortcut::plugin())
        .manage(shortcut::Hotkeys::default())
        .manage(visibility::Visibility::default())
        .manage(agents::Agents::default())
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Sessions::default())
        .manage(usage::Latest::default())
        .manage(shelf::Store::default())
        .manage(reply::Runs::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            fullscreen_now,
            focus_session,
            open_session_file,
            session_files_exist,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            cursor_status,
            cursor_preview,
            cursor_apply,
            codex_status,
            codex_preview,
            codex_apply,
            usage_last,
            usage_status,
            usage_preview,
            usage_apply,
            reply_format_status,
            reply_format_preview,
            reply_format_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            approval_answer,
            log_line,
            open_settings_window,
            shortcut_status,
            set_shortcut,
            open_link,
            data_paths,
            open_log_folder,
            restart_app,
            shelf::shelf_load,
            shelf::shelf_save,
            media_state,
            media_cover,
            media_control,
            media_volume,
            media_set_volume,
            projects_list,
            projects_note,
            projects_open_code,
            projects_new_session,
            reply::reply_tools,
            reply::session_reply,
            reply::session_reply_cancel,
            agents::agents_snapshot,
            agents::agents_last,
            agents::agents_shown,
            agents::agents_fit,
            agents::agents_hide,
            agents::agents_resize_begin,
            agents::agents_resize_move,
            agents::agents_resize_end,
            agents::agents_resize_reset,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            // And the agents list's, for the same reason (agents.rs create_window).
            agents::create_window(&handle);

            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, loaded.dock(), false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());
            metrics::spawn(handle.clone(), gate.clone());

            log::line(format!("--- Nook {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            shortcut::start(&handle, &loaded);
            agents::start(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Nook")
        .run(|app, event| {
            // Quitting: the OS gets the global shortcuts back.
            if let tauri::RunEvent::Exit = event {
                shortcut::stop(app);
            }
        });
}
