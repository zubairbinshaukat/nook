// Linux: XDG directories for files, xdg-open for links and folders, and
// gtk-layer-shell for the island window.
//
// Wayland gives an app no global cursor position and no say over where its
// window goes, so the island works differently from Windows:
//   * it is a layer-shell surface anchored to the top edge, above everything,
//     on compositors that support it (COSMIC, KDE, wlroots — not GNOME);
//   * click-through is the window's input region, set to the island shape, so
//     the compositor itself sends every other click to whatever is underneath;
//   * the cursor comes from the page's own mouse events, which only fire over
//     the island — the bot's eyes follow the pointer there, not across the screen.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;
use tauri::WebviewWindow;

use super::{home_dir, LocalTime};

/// File name of the Claude Code relay.
pub const HOOK_EXE: &str = "nook-hook";

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "HOME";

// ── Files ─────────────────────────────────────────────────────────────────────

/// An XDG base directory (`$XDG_CONFIG_HOME` …), or its fallback under the home
/// directory when it is unset or not absolute.
fn xdg(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home_dir().join(fallback))
}

/// ~/.config/nook — preferences.
pub fn config_dir() -> PathBuf {
    xdg("XDG_CONFIG_HOME", ".config").join("nook")
}

/// ~/.local/share/nook — where nook-hook and the log live. The
/// relay has to sit at a stable path: an AppImage is mounted somewhere new on
/// every launch.
pub fn local_dir() -> PathBuf {
    xdg("XDG_DATA_HOME", ".local/share").join("nook")
}

/// Environment the webview must inherit, set before any thread or process
/// starts.
///
/// Inside an AppImage, WebKit uses the GStreamer bundled with it, and GStreamer
/// keeps its plugin registry in ~/.cache/gstreamer-1.0 by default — the same
/// file the system's GStreamer uses. The AppImage is mounted somewhere new on
/// every launch, so each launch would rewrite the system's registry with
/// plugin paths that vanish once Nook quits. Give ours its own file.
pub fn prepare_environment() {
    if std::env::var_os("APPIMAGE").is_none() || std::env::var_os("GST_REGISTRY").is_some() {
        return;
    }
    let cache = xdg("XDG_CACHE_HOME", ".cache").join("nook");
    if std::fs::create_dir_all(&cache).is_ok() {
        std::env::set_var("GST_REGISTRY", cache.join("gstreamer-registry.bin"));
    }
}

pub fn local_time() -> LocalTime {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        libc::localtime_r(&now, &mut tm);
    }
    LocalTime {
        year: (tm.tm_year + 1900) as u32,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

/// Creates `dir` and closes it to other users. The log and the relay
/// binary live under these directories; with the default
/// umask they would come out 0755 and readable by anyone on the machine.
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// True when `dir` is a real directory (not a symlink), owned by us, with no
/// access for group or others: what `$XDG_RUNTIME_DIR` promises, checked
/// rather than assumed, since the socket in it decides who can answer a
/// permission request.
fn is_private_dir(dir: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(dir)
        .map(|m| {
            m.file_type().is_dir() && m.uid() == unsafe { libc::getuid() } && m.mode() & 0o077 == 0
        })
        .unwrap_or(false)
}

/// Where nook-hook finds us: `$XDG_RUNTIME_DIR/nook.sock`, or
/// `/run/user/<uid>/nook.sock` when the variable is missing. A directory
/// that is not ours and private means no relay at all — never a fallback to a
/// shared place like /tmp. Must match `socket_path()` in hook/src/unix.rs
/// exactly.
pub fn relay_socket_path() -> Option<PathBuf> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })));
    is_private_dir(&dir).then(|| dir.join("nook.sock"))
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Nothing to hide: a spawned process only gets a terminal if it asks for one.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd
}

pub fn open_url(url: &str) {
    let _ = Command::new("xdg-open").arg(url).spawn();
}

pub fn reveal_folder(path: &str) {
    let _ = Command::new("xdg-open").arg(path).spawn();
}

/// A new Claude Code session in a terminal window is Windows Terminal's: there is no equivalent
/// that every Linux desktop has, so none is started.
pub fn launch_claude_session(_dir: &str) -> bool {
    false
}

/// Our own `which`: the first executable file named `stem` on $PATH.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let dirs = std::env::var_os("PATH")?;
    std::env::split_paths(&dirs)
        .map(|dir| dir.join(stem))
        .find(|p| {
            std::fs::metadata(p)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

// ── Going to a session's window ───────────────────────────────────────────────
//
// Nothing here raises another program's window: there is no way to that works
// on X11 and on every Wayland compositor alike. The relay reports no processes
// on Linux either, so where a session runs is read from its environment alone
// (target.rs), and the ↗ opens the session's folder in VS Code — or is not shown.

/// The environment alone names the editor a session runs in.
pub const EDITOR_FROM_ENV: bool = true;

/// No process is ever named here, so none is looked up.
pub fn image_name(_pid: u32) -> Option<String> {
    None
}

/// No window is listed: there is none we could bring forward.
pub fn top_windows() -> Vec<crate::target::Window> {
    Vec::new()
}

pub fn bring_forward(_window: isize) -> bool {
    false
}

// ── The machine ───────────────────────────────────────────────────────────────

/// Memory in use and memory installed, in bytes: MemTotal − MemAvailable of
/// /proc/meminfo, which is what `free` calls used. One small read.
pub fn memory() -> Option<(u64, u64)> {
    crate::metrics::parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

/// What every processor has spent since the machine started, idle and in all:
/// the first line of /proc/stat.
pub fn cpu_times() -> Option<crate::metrics::CpuTimes> {
    crate::metrics::parse_proc_stat(&std::fs::read_to_string("/proc/stat").ok()?)
}

/// The graphics processor's use is not measured on Linux: there is no one
/// counter for it across vendors. Opening says so, once, and `gpu` stays `null`.
pub struct GpuCounters;

impl GpuCounters {
    pub fn open() -> Result<Self, String> {
        Err("not measured on Linux".into())
    }

    pub fn collect(&mut self) -> Result<(), String> {
        Ok(())
    }

    pub fn read(&mut self) -> Result<Option<f64>, String> {
        Ok(None)
    }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// Nothing polls the cursor here: the page reports it over the island, and the
/// input region decides click-through (see the top of this file).
pub const CURSOR_POLL: bool = false;

/// Full-screen apps are not detected on Linux: neither X11 nor a Wayland
/// compositor is asked. The island behaves as if none were ever in front.
pub fn fullscreen_in_front(_island: Option<&WebviewWindow>) -> bool {
    false
}

pub fn cursor_physical() -> Option<(f64, f64)> {
    None
}

// ── Island window ─────────────────────────────────────────────────────────────

/// The few gtk-layer-shell calls we need, straight from the C library.
mod layer {
    use gtk::ffi::GtkWindow;
    use std::os::raw::{c_char, c_int};

    pub const LAYER_OVERLAY: c_int = 3;
    pub const EDGE_TOP: c_int = 2;
    pub const KEYBOARD_NONE: c_int = 0;
    pub const KEYBOARD_ON_DEMAND: c_int = 2;

    #[link(name = "gtk-layer-shell")]
    extern "C" {
        pub fn gtk_layer_is_supported() -> c_int;
        pub fn gtk_layer_init_for_window(window: *mut GtkWindow);
        pub fn gtk_layer_set_namespace(window: *mut GtkWindow, name_space: *const c_char);
        pub fn gtk_layer_set_layer(window: *mut GtkWindow, layer: c_int);
        pub fn gtk_layer_set_anchor(window: *mut GtkWindow, edge: c_int, anchor: c_int);
        pub fn gtk_layer_set_exclusive_zone(window: *mut GtkWindow, zone: c_int);
        pub fn gtk_layer_set_keyboard_mode(window: *mut GtkWindow, mode: c_int);
    }
}

/// True once the island window is a layer-shell surface.
static LAYER_SURFACE: AtomicBool = AtomicBool::new(false);

/// The input region last asked for, re-applied whenever the window is mapped:
/// GTK resets it to the whole window on map. Until the page reports the island
/// shape it is empty, so nothing takes the mouse.
type Region = Option<(f64, f64, f64, f64)>;
static INPUT_REGION: Mutex<Region> = Mutex::new(Some((0.0, 0.0, 0.0, 0.0)));

fn gtk_window_ptr(win: &gtk::ApplicationWindow) -> *mut gtk::ffi::GtkWindow {
    let w: &gtk::Window = win.upcast_ref();
    w.to_glib_none().0
}

/// Turns the island into an overlay surface on the top edge that never takes
/// the keyboard. Must run before the window is first shown: a layer surface
/// cannot be made out of a window the compositor already knows.
///
/// Without layer-shell (GNOME, X11, or NOOK_LAYER_SHELL=0) the window stays
/// an ordinary always-on-top window that refuses focus; where it lands is then
/// up to the window manager.
pub fn make_non_activating(win: &WebviewWindow) {
    let Ok(gw) = win.gtk_window() else { return };
    // NOOK_LAYER_SHELL=0 is the way out on a compositor where it misbehaves.
    let wanted = std::env::var("NOOK_LAYER_SHELL").map(|v| v != "0").unwrap_or(true);
    let supported = unsafe { layer::gtk_layer_is_supported() } != 0;
    if !wanted || !supported || gw.is_realized() {
        let why = if !wanted {
            "NOOK_LAYER_SHELL=0"
        } else if supported {
            "window already shown"
        } else {
            "compositor has no layer-shell"
        };
        crate::log::line(format!("island is a regular window ({why})"));
        gw.set_accept_focus(false);
        return;
    }
    // tao gives undecorated Wayland windows an empty titlebar to force
    // client-side decorations. A layer surface has none, and a client-decorated
    // GtkWindow recomputes its own input region (shadow margins included) on
    // every map, over ours.
    gw.set_titlebar(None::<&gtk::Widget>);
    let ptr = gtk_window_ptr(&gw);
    unsafe {
        layer::gtk_layer_init_for_window(ptr);
        layer::gtk_layer_set_namespace(ptr, c"nook".as_ptr());
        layer::gtk_layer_set_layer(ptr, layer::LAYER_OVERLAY);
        // Top edge only: the compositor centres the surface horizontally.
        layer::gtk_layer_set_anchor(ptr, layer::EDGE_TOP, 1);
        // -1: sit right against the screen edge, over any top panel, the way
        // the Mac island sits in the notch.
        layer::gtk_layer_set_exclusive_zone(ptr, -1);
        layer::gtk_layer_set_keyboard_mode(ptr, layer::KEYBOARD_NONE);
    }
    // WebKitGTK in a freshly mapped layer surface never paints its first frame
    // (seen on COSMIC, and reproduced with a bare GTK window + WebKitGTK, no
    // Tauri involved): the surface stays empty. Unmapping and mapping it once,
    // right after the first map, gets it drawing for good.
    let remapped = std::cell::Cell::new(false);
    gw.connect_map_event(move |w, _| {
        apply_input_region(w, *INPUT_REGION.lock().unwrap());
        if !remapped.replace(true) {
            let w = w.clone();
            gtk::glib::idle_add_local_once(move || {
                w.hide();
                w.show_all();
                apply_input_region(&w, *INPUT_REGION.lock().unwrap());
            });
        }
        gtk::glib::Propagation::Proceed
    });
    LAYER_SURFACE.store(true, Ordering::Relaxed);
    crate::log::line("island is a layer-shell overlay");
}

/// Temporarily allow keyboard focus so the island can take the keyboard: a text
/// field to type in, Escape in the large panel, the arrows in the sidebar.
/// Giving it up needs nothing more here: a surface that no longer takes the
/// keyboard loses it, and the compositor hands it back to the window under it.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Ok(gw) = win.gtk_window() else { return };
    // The island is created `focusable: false` (tauri.linux.conf.json), so GTK
    // refuses focus until we say otherwise — on a layer surface too.
    gw.set_accept_focus(activating);
    if LAYER_SURFACE.load(Ordering::Relaxed) {
        let mode = if activating { layer::KEYBOARD_ON_DEMAND } else { layer::KEYBOARD_NONE };
        unsafe { layer::gtk_layer_set_keyboard_mode(gtk_window_ptr(&gw), mode) };
    }
}

/// Only this rectangle (window-logical pixels) takes the mouse; `None` means
/// the whole window does. Everything outside goes to the window underneath.
pub fn set_input_region(win: &WebviewWindow, rect: Region) {
    *INPUT_REGION.lock().unwrap() = rect;
    let Ok(gw) = win.gtk_window() else { return };
    apply_input_region(&gw, rect);
}

fn apply_input_region(gw: &impl IsA<gtk::Widget>, rect: Region) {
    match rect {
        None => gw.input_shape_combine_region(None),
        Some((x, y, w, h)) => {
            let Some(gdk_window) = gw.window() else { return };
            let region = gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(
                x.floor() as i32,
                y.floor() as i32,
                w.ceil().max(0.0) as i32,
                h.ceil().max(0.0) as i32,
            ));
            gdk_window.input_shape_combine_region(&region, 0, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_private_directory_of_ours_can_hold_the_relay_socket() {
        let base = std::env::temp_dir().join(format!("nook-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("runtime");
        std::fs::create_dir_all(&dir).unwrap();
        let set = |mode| std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();

        set(0o700);
        assert!(is_private_dir(&dir));

        // Readable or reachable by group or others: no.
        for open in [0o750, 0o705, 0o755, 0o777, 0o1777] {
            set(open);
            assert!(!is_private_dir(&dir), "{open:o} must be refused");
        }

        // A symlink to a private directory: no, the link itself is what we got.
        set(0o700);
        let link = base.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(!is_private_dir(&link));

        // Missing: no.
        assert!(!is_private_dir(&base.join("missing")));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn private_dirs_are_closed_to_everyone_else() {
        use std::os::unix::fs::MetadataExt;
        let dir = std::env::temp_dir().join(format!("nook-priv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
