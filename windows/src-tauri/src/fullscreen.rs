// Whether a full-screen app is in front on the island's display: a video, a
// game, a presentation. With "Hide in full-screen apps" on (Settings → Island)
// the island stays out of its way — except for a request, which the page
// always shows (src/island/island.ts).
//
// The decision is a plain function of what the system says of the window in
// front (platform/windows.rs gathers it): its rectangle, its display's, its
// class, and the shell's own "may I show a notification" state. It is asked
// for on the cursor poll's slow tick while the island is on show, and once
// when a hidden island is about to wake — never by a loop of its own: a
// hidden island costs nothing.
//
// Linux: not told (`platform::fullscreen_in_front` is always false there).

/// A rectangle of the desktop, in physical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    /// True when this one leaves nothing of `other` uncovered.
    fn covers(&self, other: &Rect) -> bool {
        other.right > other.left
            && other.bottom > other.top
            && self.left <= other.left
            && self.top <= other.top
            && self.right >= other.right
            && self.bottom >= other.bottom
    }
}

/// What the shell answers to "may a notification be shown now"
/// (`SHQueryUserNotificationState`), as far as it matters here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Notification {
    /// Not asked, or the call failed.
    Unknown,
    /// Nothing in the way.
    Normal,
    /// A full-screen app is running somewhere, or presentation settings apply (`QUNS_BUSY`).
    Busy,
    /// An exclusive Direct3D full-screen app (`QUNS_RUNNING_D3D_FULL_SCREEN`).
    D3dFullScreen,
    /// Presentation mode (`QUNS_PRESENTATION_MODE`).
    Presentation,
}

/// The window in front, as the system describes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Foreground {
    pub rect: Rect,
    /// The whole of the display it is on, taskbar included.
    pub monitor: Rect,
    pub class: String,
    /// The image its process runs (`msedge.exe`), empty when it will not say.
    pub process: String,
    /// One of Nook's own windows: the island with the keyboard, the settings window.
    pub own: bool,
    /// It is on the display the island is on.
    pub on_island_display: bool,
    /// A maximised window with a title bar: it fills a display whose taskbar
    /// hides itself, and is still an ordinary window.
    pub framed_maximised: bool,
}

/// The desktop and the taskbar: they fill the display, and are no app.
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

/// The programs of the Windows shell. What they bring in front — the Start
/// menu, Search, the notification centre and quick settings, the touch
/// keyboard, emoji and clipboard panels, Alt+Tab and Task View, the lock
/// screen — is drawn in a window as large as the display, with no title bar,
/// and is no full-screen app: a click on one of them must not hide the island.
const SHELL_PROCESSES: &[&str] = &[
    "explorer.exe",
    "StartMenuExperienceHost.exe",
    "SearchHost.exe",
    "SearchApp.exe",
    "SearchUI.exe",
    "ShellExperienceHost.exe",
    "ShellHost.exe",
    "TextInputHost.exe",
    "LockApp.exe",
];

/// True when the window belongs to the shell rather than to an app.
fn is_shell(front: &Foreground) -> bool {
    SHELL_CLASSES.contains(&front.class.as_str()) || SHELL_PROCESSES.iter().any(|p| p.eq_ignore_ascii_case(&front.process))
}

/// True when the island should stay out of the way.
///
/// - Nook's own window in front, or the shell's (the desktop, the taskbar, the
///   Start menu and the other flyouts, Alt+Tab): never.
/// - A window on another display than the island's: never — it hides nothing
///   the island is drawn over.
/// - A window that covers the whole of the island's display — and is not just
///   a maximised window with its title bar — is full-screen. So is whatever is
///   in front there while the shell reports an exclusive Direct3D app or
///   presentation mode.
/// - With no window in front to look at, only an exclusive Direct3D app or
///   presentation mode counts. Windows has no window in front for a moment
///   while the keyboard goes from one window to another — a click elsewhere —
///   and "busy" says only that a full-screen app runs somewhere, maybe on
///   another display: taken alone, it hid the island at a plain click.
pub fn is_fullscreen(front: Option<&Foreground>, notification: Notification) -> bool {
    let shell_says = matches!(notification, Notification::D3dFullScreen | Notification::Presentation);
    match front {
        None => shell_says,
        Some(front) if front.own || is_shell(front) => false,
        Some(front) if !front.on_island_display => false,
        Some(front) => shell_says || (front.rect.covers(&front.monitor) && !front.framed_maximised),
    }
}

/// How many looks in a row (one each half second, on the cursor poll's slow
/// tick) must say "full-screen" before the island is told. One look can land
/// on a moment between two windows; a full-screen app stays.
pub const CONFIRM_LOOKS: u8 = 2;

/// The poll's verdicts, steadied: "full-screen" only once `CONFIRM_LOOKS` looks
/// in a row said it, "not" at the first look that says so.
#[derive(Debug, Default)]
pub struct Steady {
    run: u8,
}

impl Steady {
    pub fn look(&mut self, full: bool) -> bool {
        self.run = if full { self.run.saturating_add(1) } else { 0 };
        self.run >= CONFIRM_LOOKS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISPLAY: Rect = Rect { left: 0, top: 0, right: 1920, bottom: 1080 };

    fn window(rect: Rect, class: &str) -> Foreground {
        Foreground { rect, monitor: DISPLAY, class: class.into(), process: "app.exe".into(), own: false, on_island_display: true, framed_maximised: false }
    }

    #[test]
    fn a_window_that_covers_the_islands_display_is_full_screen() {
        // A video in a browser, a borderless game: exactly the display.
        assert!(is_fullscreen(Some(&window(DISPLAY, "Chrome_WidgetWin_1")), Notification::Normal));
        assert!(is_fullscreen(Some(&window(DISPLAY, "UnityWndClass")), Notification::Busy));
        // A pixel past it on every side still covers it.
        assert!(is_fullscreen(Some(&window(Rect { left: -1, top: -1, right: 1921, bottom: 1081 }, "X")), Notification::Unknown));
        // An ordinary window, and a maximised one above the taskbar (its frame hangs 8 px over the other edges).
        assert!(!is_fullscreen(Some(&window(Rect { left: 200, top: 100, right: 1400, bottom: 900 }, "Notepad")), Notification::Normal));
        assert!(!is_fullscreen(Some(&window(Rect { left: -8, top: -8, right: 1928, bottom: 1040 }, "Notepad")), Notification::Normal));
        // One row short of the display is not full-screen.
        assert!(!is_fullscreen(Some(&window(Rect { bottom: 1079, ..DISPLAY }, "X")), Notification::Normal));
        // A display that says nothing of its size covers nothing.
        let nowhere = Foreground { monitor: Rect::default(), ..window(DISPLAY, "X") };
        assert!(!is_fullscreen(Some(&nowhere), Notification::Normal));
    }

    #[test]
    fn a_maximised_window_with_its_title_bar_is_an_ordinary_window() {
        // The taskbar hides itself: a maximised window then covers the display.
        let over = Rect { left: -8, top: -8, right: 1928, bottom: 1088 };
        let maximised = Foreground { framed_maximised: true, ..window(over, "Notepad") };
        assert!(!is_fullscreen(Some(&maximised), Notification::Normal));
        assert!(!is_fullscreen(Some(&maximised), Notification::Busy));
        // The same rectangle with no title bar is a borderless full-screen window.
        assert!(is_fullscreen(Some(&window(over, "Game")), Notification::Normal));
    }

    #[test]
    fn the_desktop_and_nooks_own_windows_never_count() {
        for class in ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"] {
            assert!(!is_fullscreen(Some(&window(DISPLAY, class)), Notification::Normal), "{class}");
            assert!(!is_fullscreen(Some(&window(DISPLAY, class)), Notification::Presentation), "{class}");
        }
        // The island took the keyboard to be typed in: it is in front, and hides nothing from itself.
        let own = Foreground { own: true, ..window(DISPLAY, "Tauri Window") };
        assert!(!is_fullscreen(Some(&own), Notification::Normal));
        assert!(!is_fullscreen(Some(&own), Notification::D3dFullScreen));
        // A class that only starts the same is another window.
        assert!(is_fullscreen(Some(&window(DISPLAY, "WorkerWindow")), Notification::Normal));
    }

    #[test]
    fn another_display_is_none_of_the_islands_business() {
        let elsewhere = Foreground { on_island_display: false, monitor: Rect { left: 1920, top: 0, right: 3840, bottom: 1080 }, ..window(Rect { left: 1920, top: 0, right: 3840, bottom: 1080 }, "Game") };
        for said in [Notification::Normal, Notification::Busy, Notification::D3dFullScreen, Notification::Presentation] {
            assert!(!is_fullscreen(Some(&elsewhere), said), "{said:?}");
        }
    }

    #[test]
    fn the_shell_is_believed_for_what_a_rectangle_cannot_say() {
        // Presentation mode, or an exclusive Direct3D app, with a window in front on the island's display.
        let small = window(Rect { left: 200, top: 100, right: 1400, bottom: 900 }, "POWERPNT");
        assert!(is_fullscreen(Some(&small), Notification::Presentation));
        assert!(is_fullscreen(Some(&small), Notification::D3dFullScreen));
        // "Busy" alone says a full-screen app runs somewhere: the rectangle decides.
        assert!(!is_fullscreen(Some(&small), Notification::Busy));
        // No window in front to look at (an exclusive mode can hide it): the shell's word.
        assert!(is_fullscreen(None, Notification::D3dFullScreen));
        assert!(is_fullscreen(None, Notification::Presentation));
        assert!(!is_fullscreen(None, Notification::Normal));
        assert!(!is_fullscreen(None, Notification::Unknown));
        // No window in front is also the moment between two windows, at a
        // click elsewhere; "busy" alone may be a video on another display.
        assert!(!is_fullscreen(None, Notification::Busy));
    }

    #[test]
    fn the_shells_flyouts_are_no_full_screen_apps() {
        // The touch keyboard and emoji panel, the Start menu, Search, the
        // notification centre, Alt+Tab: as large as the display, no title bar.
        for (class, process) in [
            ("Windows.UI.Core.CoreWindow", "TextInputHost.exe"),
            ("Windows.UI.Core.CoreWindow", "StartMenuExperienceHost.exe"),
            ("Windows.UI.Core.CoreWindow", "SearchHost.exe"),
            ("Windows.UI.Core.CoreWindow", "ShellExperienceHost.exe"),
            ("Windows.UI.Core.CoreWindow", "ShellHost.exe"),
            ("Windows.UI.Core.CoreWindow", "LockApp.exe"),
            ("XamlExplorerHostIslandWindow", "explorer.exe"),
            ("XamlExplorerHostIslandWindow_WASDK", "EXPLORER.EXE"),
        ] {
            let flyout = Foreground { process: process.into(), ..window(DISPLAY, class) };
            assert!(!is_fullscreen(Some(&flyout), Notification::Normal), "{class} {process}");
            assert!(!is_fullscreen(Some(&flyout), Notification::Busy), "{class} {process}");
        }
        // The same window from an app is full-screen; a name that only starts the same is an app.
        assert!(is_fullscreen(Some(&window(DISPLAY, "Windows.UI.Core.CoreWindow")), Notification::Normal));
        let lookalike = Foreground { process: "explorer.exe.game.exe".into(), ..window(DISPLAY, "Game") };
        assert!(is_fullscreen(Some(&lookalike), Notification::Normal));
    }

    #[test]
    fn one_look_is_not_enough_to_hide_the_island() {
        let mut steady = Steady::default();
        // A moment between two windows: one look says full-screen, the next does not.
        assert!(!steady.look(true));
        assert!(!steady.look(false));
        assert!(!steady.look(true));
        // A full-screen app stays: the second look in a row tells the island.
        assert!(steady.look(true));
        assert!(steady.look(true));
        // Gone at the first look that says so.
        assert!(!steady.look(false));
        assert!(!steady.look(true));
    }
}
