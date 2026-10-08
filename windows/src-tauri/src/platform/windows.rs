// Windows: Win32 for the island window and the cursor, %APPDATA% for files.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::time::{Duration, Instant};

use tauri::WebviewWindow;

use std::collections::HashMap;

use ::windows::core::{w, BOOL, PCWSTR, PWSTR};
use ::windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HLOCAL, HWND, LocalFree, LPARAM, POINT, RECT};
use ::windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use ::windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use ::windows::Win32::Security::{GetTokenInformation, TokenElevation, TokenUser, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER};
use ::windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_CSTATUS_NEW_DATA,
    PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};
use ::windows::Win32::System::SystemInformation::{GetLocalTime, GlobalMemoryStatusEx, MEMORYSTATUSEX};
use ::windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, GetSystemTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
use ::windows::Win32::UI::Shell::{
    IVirtualDesktopManager, SHQueryUserNotificationState, VirtualDesktopManager, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, SetForegroundWindow, SetWindowLongPtrW,
    ShowWindow, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, SW_RESTORE, WS_CAPTION, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::LocalTime;
use crate::fullscreen::{self, Foreground, Notification};
use crate::metrics::CpuTimes;
use crate::target::Window;

/// File name of the Claude Code relay.
pub const HOOK_EXE: &str = "nook-hook.exe";

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "USERPROFILE";

/// Keeps spawned helpers from flashing a console window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Files ─────────────────────────────────────────────────────────────────────

/// %APPDATA%\Nook — preferences.
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Nook")
}

/// %LOCALAPPDATA%\Nook — where nook-hook.exe and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Nook")
}

/// %APPDATA% and %LOCALAPPDATA% are already private to the user.
pub fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// Nothing to set up before the webview starts.
pub fn prepare_environment() {}

pub fn local_time() -> LocalTime {
    let t = unsafe { GetLocalTime() };
    LocalTime {
        year: t.wYear.into(),
        month: t.wMonth.into(),
        day: t.wDay.into(),
        hour: t.wHour.into(),
        minute: t.wMinute.into(),
        second: t.wSecond.into(),
    }
}

// ── Processes ─────────────────────────────────────────────────────────────────

/// Spawned helpers must never flash a console window.
pub fn no_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn open_url(url: &str) {
    let _ = no_console(Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]))
        .spawn();
}

pub fn reveal_folder(path: &str) {
    let _ = Command::new("explorer").arg(path).spawn();
}

/// A new Claude Code session in `dir`, in a Windows Terminal window: `wt.exe -d <dir> claude`,
/// each argument given on its own, never one string. `dir` is an existing absolute folder that
/// projects.rs has already held to its rules (no quote, `%`, `;`...): Windows Terminal is the one
/// that reads `;` as the end of a command. False when `wt.exe` is not there or did not start.
pub fn launch_claude_session(dir: &str) -> bool {
    let mut cmd = Command::new("wt.exe");
    cmd.args(["-d", dir, "claude"]);
    no_console(&mut cmd).spawn().is_ok()
}

/// Our own `where`: walks %PATH% against %PATHEXT%, no shell involved.
/// Rust quotes arguments correctly for `.cmd`/`.bat` targets since 1.77, so
/// spawning `code.cmd` directly is safe.
pub fn find_on_path(stem: &str) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ── Who we are ────────────────────────────────────────────────────────────────
//
// Named pipes share one machine-wide namespace, so the SID in the name is what
// keeps two accounts on the same machine from ever meeting on `nook-*`.
// nook-hook computes the same string (hook/src/win.rs) and additionally checks
// that the process serving the pipe really is us.

/// The SID of the account this process runs as, as `S-1-5-21-…`.
pub fn current_user_sid() -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;

        // First call sizes the buffer, second fills it.
        let mut needed = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return None;
        }

        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
        let sid = text.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
        sid
    }
}

// ── The machine ───────────────────────────────────────────────────────────────

/// Memory in use and memory installed, in bytes. One call, no allocation.
pub fn memory() -> Option<(u64, u64)> {
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
    Some((status.ullTotalPhys.saturating_sub(status.ullAvailPhys), status.ullTotalPhys))
}

/// What every processor has spent since the machine started, idle and in all.
/// The system's kernel time counts the idle time in: kernel + user is everything.
pub fn cpu_times() -> Option<CpuTimes> {
    let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()? };
    Some(CpuTimes { idle: ticks(idle), total: ticks(kernel).wrapping_add(ticks(user)) })
}

/// The graphics processor's performance counters — the `GPU Engine` set Task
/// Manager reads: one instance per process and engine, each saying what share
/// of that engine the process used since the reading before. One query, opened
/// once and read on every tick; closed when dropped.
///
/// It stays on the thread that opened it (metrics.rs): a query handle is not
/// shared.
pub struct GpuCounters {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
    /// What the instances are read into: the items, then their names. Kept
    /// between ticks, in 8-byte words so that an item is aligned in it.
    buffer: Vec<u64>,
}

impl GpuCounters {
    /// Opens the query and adds every engine's counter. The counter is named
    /// in English whatever the system's language. An error is the reason, for
    /// the log: no such counters on this machine, or no right to read them.
    pub fn open() -> Result<Self, String> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            let status = PdhOpenQueryW(PCWSTR::null(), 0, &mut query);
            if status != 0 {
                return Err(format!("PdhOpenQuery failed (0x{status:08X})"));
            }
            let mut counter = PDH_HCOUNTER::default();
            let status = PdhAddEnglishCounterW(query, w!("\\GPU Engine(*)\\Utilization Percentage"), 0, &mut counter);
            if status != 0 {
                let _ = PdhCloseQuery(query);
                return Err(format!("no GPU Engine counters (0x{status:08X})"));
            }
            Ok(Self { query, counter, buffer: Vec::new() })
        }
    }

    /// Takes a reading of every instance: what the next `read` is worked out from.
    pub fn collect(&mut self) -> Result<(), String> {
        match unsafe { PdhCollectQueryData(self.query) } {
            0 => Ok(()),
            status => Err(format!("PdhCollectQueryData failed (0x{status:08X})")),
        }
    }

    /// The graphics processor's use between the last two readings, in percent.
    /// None when no engine has a value yet.
    pub fn read(&mut self) -> Result<Option<f64>, String> {
        const WORD: usize = std::mem::size_of::<u64>();
        // The instances come and go with the processes: the room they need is
        // asked for whenever what is kept has become too small.
        for _ in 0..3 {
            let mut size = (self.buffer.len() * WORD) as u32;
            let mut count = 0u32;
            let items = self.buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
            let status = unsafe {
                PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, (size > 0).then_some(items))
            };
            if status == PDH_MORE_DATA {
                // A little more than asked: a process starting does not mean a second call next tick.
                self.buffer = vec![0u64; (size as usize).div_ceil(WORD) + 512];
                continue;
            }
            if status != 0 {
                return Err(format!("PdhGetFormattedCounterArray failed (0x{status:08X})"));
            }
            let items = unsafe { std::slice::from_raw_parts(items.cast_const(), count as usize) };
            let mut names: Vec<String> = Vec::with_capacity(items.len());
            let mut values: Vec<f64> = Vec::with_capacity(items.len());
            for item in items {
                // An instance that appeared since the reading before has nothing to say yet.
                if item.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && item.FmtValue.CStatus != PDH_CSTATUS_NEW_DATA {
                    continue;
                }
                let Ok(name) = (unsafe { item.szName.to_string() }) else { continue };
                names.push(name);
                values.push(unsafe { item.FmtValue.Anonymous.doubleValue });
            }
            return Ok(crate::metrics::gpu_percent(names.iter().map(String::as_str).zip(values)));
        }
        Err("the GPU Engine instances would not hold still".into())
    }
}

impl Drop for GpuCounters {
    fn drop(&mut self) {
        let _ = unsafe { PdhCloseQuery(self.query) };
    }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// The 60 Hz poll reads the cursor and flips click-through from it.
pub const CURSOR_POLL: bool = true;

/// Cursor position in physical screen pixels.
pub fn cursor_physical() -> Option<(f64, f64)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    Some((p.x as f64, p.y as f64))
}

// ── Island window ─────────────────────────────────────────────────────────────

fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
    let raw = win.hwnd().ok()?.0 as isize;
    if raw == 0 {
        return None;
    }
    Some(HWND(raw as *mut _))
}

/// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the
/// island out of Alt-Tab.
pub fn make_non_activating(win: &WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

/// The agents list takes no focus and stays out of Alt-Tab, as the island does.
pub fn prepare_list_window(win: &WebviewWindow) {
    make_non_activating(win);
}

/// The window that had the keyboard when the island took it, to hand it back to.
static KEYBOARD_FROM: AtomicIsize = AtomicIsize::new(0);

/// Temporarily allow activation so the island can take the keyboard: a text
/// field to type in, Escape in the large panel, the arrows in the sidebar.
/// Giving it up hands the keyboard back to the window it was taken from —
/// putting WS_EX_NOACTIVATE back does not, on its own, move the focus anywhere,
/// and the user would have to click their own window to type in it again.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let front = GetForegroundWindow();
        let want = if activating {
            // Asked twice in a row, the island already has it: what is kept is
            // still the window it was first taken from.
            if front != hwnd {
                KEYBOARD_FROM.store(front.0 as isize, Ordering::Relaxed);
            }
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        } else {
            ex | WS_EX_NOACTIVATE.0 as isize
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        if activating {
            return;
        }
        // Only when the island still has it: a user who clicked another window
        // in the meantime has already put the keyboard where they want it.
        let from = HWND(KEYBOARD_FROM.swap(0, Ordering::Relaxed) as *mut _);
        if front == hwnd && !from.is_invalid() && IsWindow(Some(from)).as_bool() {
            let _ = SetForegroundWindow(from);
        }
    }
}

/// Shows the island again after it was hidden, without taking the keyboard
/// from whoever has it. tao drops the "created unfocused" mark once the window
/// exists, so every later show is a plain SW_SHOW, which activates: with the
/// permission a hotkey or a tray click gives, the island would come to the
/// foreground and the webview take the focus. The window in front before is
/// put back in front. On the main thread only: from another one the show is
/// queued, and this would look before it happened.
pub fn show_inactive(win: &WebviewWindow) {
    let before = unsafe { GetForegroundWindow() };
    let _ = win.show();
    let Some(hwnd) = hwnd_of(win) else { return };
    unsafe {
        if before != hwnd && !before.is_invalid() && GetForegroundWindow() == hwnd && IsWindow(Some(before)).as_bool() {
            let _ = SetForegroundWindow(before);
        }
    }
}

/// There is no compositor to anchor to: the window is placed by position alone (dock.rs).
pub fn set_dock(_win: &WebviewWindow, _dock: crate::dock::Dock) {}

// ── On every virtual desktop ──────────────────────────────────────────────────
//
// tao's `set_visible_on_all_workspaces` does nothing on Windows, and Windows
// has no documented "pin this window" call for a program's own window: a window
// stays on the desktop it was made on. What is documented is IVirtualDesktopManager,
// which may move a window *of the calling process* to a desktop. So the agents
// list is moved to whichever desktop is in front, half a second after it changed.

/// The window the follower looks after, as a raw handle; 0 when none is to be.
static DESKTOP_WATCH: AtomicIsize = AtomicIsize::new(0);
/// A follower thread is running. There is never more than one: asked again, it
/// is pointed at the new window (or told to stop) and carries on.
static DESKTOP_RUNNING: AtomicBool = AtomicBool::new(false);
/// How often the list's desktop is looked at while it is on show.
const DESKTOP_LOOK: Duration = Duration::from_millis(500);

/// Keeps a window on the desktop in front, while `on`; stops when not. One
/// look every half second, on one thread that ends by itself once the list is
/// hidden. Called again for the window it already follows, it starts nothing.
/// The island is not one of its users.
pub fn follow_desktops(win: &WebviewWindow, on: bool) {
    let hwnd = hwnd_of(win).filter(|_| on).map_or(0, |hwnd| hwnd.0 as isize);
    DESKTOP_WATCH.store(hwnd, Ordering::SeqCst);
    if hwnd == 0 || DESKTOP_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| loop {
        watch_desktops();
        DESKTOP_RUNNING.store(false, Ordering::SeqCst);
        // Asked again between the last look and the flag going down: this thread carries on.
        if DESKTOP_WATCH.load(Ordering::SeqCst) == 0 || DESKTOP_RUNNING.swap(true, Ordering::SeqCst) {
            break;
        }
    });
}

/// The follower's thread: looks until there is no window to follow.
fn watch_desktops() {
    // The manager is made on this thread and used only here. A thread that
    // was already in another apartment is fine too: the call is just not undone.
    let initialised = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let manager = unsafe { CoCreateInstance::<_, IVirtualDesktopManager>(&VirtualDesktopManager, None, CLSCTX_ALL) }.ok();
    if let Some(manager) = manager {
        loop {
            let raw = DESKTOP_WATCH.load(Ordering::SeqCst);
            if raw == 0 {
                break;
            }
            move_to_current_desktop(&manager, HWND(raw as *mut _));
            std::thread::sleep(DESKTOP_LOOK);
        }
    }
    if initialised {
        unsafe { CoUninitialize() };
    }
}

/// The top-level window under the cursor, if there is one.
fn window_under_cursor() -> Option<HWND> {
    unsafe {
        let mut at = POINT::default();
        GetCursorPos(&mut at).ok()?;
        let under = WindowFromPoint(at);
        if under.is_invalid() {
            return None;
        }
        Some(GetAncestor(under, GA_ROOT)).filter(|root| !root.is_invalid())
    }
}

/// One look: when the window is not on the desktop in front, it is moved to the
/// desktop of a window that is: the one with the keyboard or, when that is not
/// on this desktop or will not say (an empty desktop has only the shell, the
/// taskbar), the one under the cursor. Neither, and it waits for the next look.
/// Any call that fails leaves things as they are. Nothing here takes the focus.
fn move_to_current_desktop(manager: &IVirtualDesktopManager, hwnd: HWND) {
    // What the manager says of a window; `default` when it cannot say.
    let here = |window: HWND, default: bool| unsafe { manager.IsWindowOnCurrentVirtualDesktop(window) }.map_or(default, |on| on.as_bool());
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() || here(hwnd, true) {
            return;
        }
        for reference in [Some(GetForegroundWindow()), window_under_cursor()].into_iter().flatten() {
            if reference.is_invalid() || reference == hwnd || !here(reference, false) {
                continue;
            }
            if let Ok(desktop) = manager.GetWindowDesktopId(reference) {
                if manager.MoveWindowToDesktop(hwnd, &desktop).is_ok() {
                    return;
                }
            }
        }
    }
}
// ── Full-screen apps ──────────────────────────────────────────────────────────

fn rect_of(r: RECT) -> fullscreen::Rect {
    fullscreen::Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/// The window in front, as fullscreen.rs wants it described. None when there
/// is none, or when the system will not say where it is.
fn foreground(island: Option<HWND>) -> Option<Foreground> {
    unsafe {
        let front = GetForegroundWindow();
        if front.is_invalid() {
            return None;
        }
        let mut rect = RECT::default();
        GetWindowRect(front, &mut rect).ok()?;
        let monitor = MonitorFromWindow(front, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let mut class = [0u16; 128];
        let len = GetClassNameW(front, &mut class).max(0) as usize;
        let mut pid = 0u32;
        GetWindowThreadProcessId(front, Some(&mut pid));
        let captioned = GetWindowLongPtrW(front, GWL_STYLE) as u32 & WS_CAPTION.0 == WS_CAPTION.0;
        Some(Foreground {
            rect: rect_of(rect),
            monitor: rect_of(info.rcMonitor),
            class: String::from_utf16_lossy(&class[..len.min(class.len())]),
            process: image_name(pid).unwrap_or_default(),
            own: pid == GetCurrentProcessId(),
            // With no island window to compare with, its display is taken to be this one.
            on_island_display: island.is_none_or(|island| MonitorFromWindow(island, MONITOR_DEFAULTTONEAREST) == monitor),
            framed_maximised: IsZoomed(front).as_bool() && captioned,
        })
    }
}

/// True when a full-screen app is in front on the island's display: a few
/// calls into the system, no window is enumerated. The rule is fullscreen.rs's.
pub fn fullscreen_in_front(island: Option<&WebviewWindow>) -> bool {
    fullscreen_verdict(island).0
}

/// The same, with what it was decided on, for the log: the window in front
/// (its class and its program's name, nothing else) and the shell's word.
pub fn fullscreen_verdict(island: Option<&WebviewWindow>) -> (bool, String) {
    let notification = match unsafe { SHQueryUserNotificationState() } {
        Ok(state) if state == QUNS_BUSY => Notification::Busy,
        Ok(state) if state == QUNS_RUNNING_D3D_FULL_SCREEN => Notification::D3dFullScreen,
        Ok(state) if state == QUNS_PRESENTATION_MODE => Notification::Presentation,
        Ok(_) => Notification::Normal,
        Err(_) => Notification::Unknown,
    };
    let front = foreground(island.and_then(hwnd_of));
    let full = fullscreen::is_fullscreen(front.as_ref(), notification);
    let said = match &front {
        Some(f) => format!(
            "front class={} process={} rect={},{},{},{} display={},{},{},{} framed_maximised={} shell={notification:?}",
            f.class, f.process, f.rect.left, f.rect.top, f.rect.right, f.rect.bottom,
            f.monitor.left, f.monitor.top, f.monitor.right, f.monitor.bottom, f.framed_maximised
        ),
        None => format!("no window in front, shell={notification:?}"),
    };
    (full, said)
}

/// Click-through here is the poll's WS_EX_TRANSPARENT toggle, not a region.
pub fn set_input_region(_win: &WebviewWindow, _rect: Option<(f64, f64, f64, f64)>) {}

// ── Going to a session's window ───────────────────────────────────────────────
//
// What to bring forward is decided in target.rs, from this: the windows there
// are, and the program a pid runs today.

/// VS Code and Cursor say the same things in a session's environment: which
/// of the two it is comes from the processes the relay names, or not at all.
pub const EDITOR_FROM_ENV: bool = false;

/// The name of the image a process runs — `Code.exe`, never its path. None
/// when the process is gone or will not say.
pub fn image_name(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let read = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !read {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().filter(|name| !name.is_empty()).map(str::to_string)
    }
}

/// Every top-level window, the one last used first — the order the system
/// lists them in — each with the program it answers for.
pub fn top_windows() -> Vec<Window> {
    unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> BOOL {
        let out = unsafe { &mut *(out.0 as *mut Vec<Window>) };
        let mut pid = 0u32;
        let mut class = [0u16; 128];
        let mut title = [0u16; 512];
        let (class_len, title_len) = unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            (GetClassNameW(hwnd, &mut class).max(0) as usize, GetWindowTextW(hwnd, &mut title).max(0) as usize)
        };
        out.push(Window {
            hwnd: hwnd.0 as isize,
            pid,
            image: String::new(),
            class: String::from_utf16_lossy(&class[..class_len]),
            title: String::from_utf16_lossy(&title[..title_len]),
            visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
            owner: unsafe { GetWindow(hwnd, GW_OWNER) }.map(|owner| owner.0 as isize).unwrap_or(0),
        });
        true.into()
    }

    let mut windows: Vec<Window> = Vec::new();
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut windows as *mut _ as isize)) };
    // One look per process, not per window: an editor has many windows.
    let mut images: HashMap<u32, String> = HashMap::new();
    for window in &mut windows {
        let image = images.entry(window.pid).or_insert_with(|| image_name(window.pid).unwrap_or_default().to_lowercase());
        window.image = image.clone();
    }
    windows
}

/// Brings a window to the front, out of the taskbar if it was minimised
/// there. True when it ends up in front.
///
/// Windows only lets a program take the foreground when it has a claim to it,
/// and the plain call is tried first: it is enough whenever the island holds
/// the keyboard (the large panel, a typed answer). Most of the time it does
/// not — its window never activates, and the click that brought us here was
/// delivered to the webview's own process — so the call is refused and the
/// window merely flashes in the taskbar. Then, and only then, this thread
/// joins the input queue of the window that *is* in front for the length of
/// one call (`AttachThreadInput`, the documented way to share a foreground
/// claim), asks again, and leaves. No key press is made up: a synthetic Alt
/// would reach the very window the user is typing in, and open its menu.
pub fn bring_forward(hwnd: isize) -> bool {
    take_foreground(HWND(hwnd as *mut _)).is_some()
}

/// How long a window gets to be in front once it was asked to: the switch
/// between two programs is not done the moment the call returns.
const FOREGROUND_SETTLE: Duration = Duration::from_millis(120);

/// `bring_forward`, saying which of its two ways worked.
fn take_foreground(hwnd: HWND) -> Option<&'static str> {
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return None;
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd).as_bool() && in_front(hwnd) {
            return Some("asked");
        }
        let front = GetForegroundWindow();
        let theirs = GetWindowThreadProcessId(front, None);
        let ours = GetCurrentThreadId();
        if theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool() {
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(ours, theirs, false);
        }
        in_front(hwnd).then_some("joined the window in front")
    }
}

/// True once a window is the one in front, given a moment to get there.
fn in_front(hwnd: HWND) -> bool {
    let until = Instant::now() + FOREGROUND_SETTLE;
    loop {
        if unsafe { GetForegroundWindow() } == hwnd {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

// ── Typing into a session's window ────────────────────────────────────────────
//
// What reply_here.rs does with them is its own business; these are the system
// calls, each one small.

/// The title of a window as it is now; empty when it is gone.
pub fn window_title(hwnd: isize) -> String {
    let mut title = [0u16; 512];
    let len = unsafe { GetWindowTextW(HWND(hwnd as *mut _), &mut title) }.max(0) as usize;
    String::from_utf16_lossy(&title[..len])
}

/// True when `hwnd` is the window in front.
pub fn is_foreground(hwnd: isize) -> bool {
    unsafe { GetForegroundWindow() }.0 as isize == hwnd
}

/// True once `hwnd` is the window in front, waiting up to `ms` for it.
pub fn wait_foreground(hwnd: isize, ms: u64) -> bool {
    let until = Instant::now() + Duration::from_millis(ms);
    loop {
        if is_foreground(hwnd) {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Whether a process's token is elevated; None when it cannot be read.
fn token_elevated(process: HANDLE) -> Option<bool> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned = 0u32;
        let read = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);
        read.then_some(elevation.TokenIsElevated != 0)
    }
}

/// True when the program that owns `hwnd` runs elevated and we do not: Windows
/// would drop what is typed to it, silently. A token that cannot be read is
/// taken to be elevated.
pub fn elevated_out_of_reach(hwnd: isize) -> bool {
    if token_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false) {
        return false;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid)) };
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { return true };
    let elevated = token_elevated(process).unwrap_or(true);
    let _ = unsafe { CloseHandle(process) };
    elevated
}

/// True once the Enter, Shift, Ctrl, Alt and Windows keys are all up, waiting up
/// to `ms` for it: the user has just pressed Enter in the island.
pub fn wait_keys_released(ms: u64) -> bool {
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RETURN, VK_RWIN, VK_SHIFT};
    let down = || [VK_RETURN, VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN].iter().any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } < 0);
    let until = Instant::now() + Duration::from_millis(ms);
    loop {
        if !down() {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Sends keys to the window in front: a character as Unicode input, a key down
/// and up for each unit of UTF-16; Enter as the key. Returns how many input
/// events the system took, and how many there were.
pub fn send_keys(keys: &[crate::reply_here::KeyAction]) -> (usize, usize) {
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
        VIRTUAL_KEY, VK_RETURN,
    };
    use crate::reply_here::KeyAction;

    let stroke = |vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let mut events: Vec<INPUT> = Vec::with_capacity(keys.len() * 2);
    for key in keys {
        match key {
            KeyAction::Char(c) => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    events.push(stroke(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE));
                    events.push(stroke(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
            }
            KeyAction::Enter => {
                let scan = unsafe { MapVirtualKeyW(VK_RETURN.0 as u32, MAPVK_VK_TO_VSC) } as u16;
                events.push(stroke(VK_RETURN, scan, KEYBD_EVENT_FLAGS(0)));
                events.push(stroke(VK_RETURN, scan, KEYEVENTF_KEYUP));
            }
        }
    }
    let sent = unsafe { SendInput(&events, std::mem::size_of::<INPUT>() as i32) } as usize;
    (sent, events.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_is_named_by_its_image_and_never_by_a_path() {
        let name = image_name(std::process::id()).expect("our own process has an image");
        assert!(name.to_lowercase().ends_with(".exe") && !name.contains(['\\', '/']), "{name}");
        // No process has this pid: nothing is named.
        assert_eq!(image_name(u32::MAX - 3), None);
    }

    #[test]
    fn the_windows_are_listed_with_the_program_each_answers_for() {
        for window in top_windows() {
            assert_ne!(window.hwnd, 0);
            assert_eq!(window.image, window.image.to_lowercase());
            assert!(!window.image.contains('\\'));
        }
        // A handle that is no window is not brought anywhere.
        assert!(!bring_forward(0));
    }

    /// The real counters of this machine, read a few times a moment apart:
    /// what the island would show, and what a tick costs. A machine without
    /// them says why and passes. `cargo test -p nook -- the_graphics --nocapture` prints it.
    #[test]
    fn the_graphics_counters_are_read_or_say_why_not() {
        let opened = Instant::now();
        let mut counters = match GpuCounters::open() {
            Ok(counters) => counters,
            Err(why) => return eprintln!("gpu: not measured here — {why}"),
        };
        let first = counters.collect();
        eprintln!("gpu: opened and first reading in {:?}", opened.elapsed());
        if let Err(why) = first {
            return eprintln!("gpu: not measured here — {why}");
        }
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(500));
            let tick = Instant::now();
            let collected = counters.collect();
            let collect = tick.elapsed();
            let value = collected.and_then(|()| counters.read());
            eprintln!("gpu: {value:?} — tick {:?} (collect {collect:?}), {} bytes of instances", tick.elapsed(), counters.buffer.len() * 8);
            if let Ok(Some(percent)) = value {
                assert!((0.0..=100.0).contains(&percent), "{percent}");
            }
        }
    }

    /// Takes the foreground away from whatever has it and gives it back, from a
    /// process with no claim to it at all — a harder case than the island's.
    /// Run by hand: `cargo test -p nook -- --ignored comes_forward --nocapture`.
    #[test]
    #[ignore = "moves the keyboard focus on the desktop it runs on"]
    fn a_window_comes_forward_and_the_one_before_it_comes_back() {
        let front = unsafe { GetForegroundWindow() }.0 as isize;
        let other = top_windows().into_iter().find(|w| {
            w.hwnd != front && w.visible && w.owner == 0 && !w.title.is_empty() && ["code.exe", "windowsterminal.exe"].contains(&w.image.as_str())
        });
        let Some(other) = other else { return eprintln!("no editor or terminal window to try with") };
        let describe = |hwnd: isize| top_windows().into_iter().find(|w| w.hwnd == hwnd).map(|w| format!("{} [{}]", w.image, w.class));
        eprintln!("in front: {:?}; going to {}", describe(front), other.image);
        let went = take_foreground(HWND(other.hwnd as *mut _));
        eprintln!("went: {went:?}");
        std::thread::sleep(Duration::from_millis(150));
        let back = (front != 0).then(|| take_foreground(HWND(front as *mut _)));
        eprintln!("came back: {back:?}");
        assert!(went.is_some(), "the window did not come forward");
        assert!(back.is_none_or(|how| how.is_some()), "the window that was in front did not come back");
    }
}
