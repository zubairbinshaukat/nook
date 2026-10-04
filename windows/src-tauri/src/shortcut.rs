// The three global shortcuts, pressed from anywhere:
//   - expand: opens the session panel large, or shrinks it back (Ctrl+Alt+Space);
//   - goto:   goes to the window of the session that most needs the user, and
//             folds the island (Ctrl+Alt+Enter);
//   - panel:  opens the session panel at its normal size, with the keyboard
//             taken, so Space expands it (Ctrl+Shift+Space).
// Each can be changed, or switched off, in the settings window.
//
// The defaults keep clear of Ctrl+Alt+<letter>: on many keyboard layouts
// Ctrl+Alt is AltGr, and with a letter or a digit it types a character (é, €,
// @, {…) — a shortcut there would take that character away in every program.
// Space and Enter type nothing with AltGr.
//
// Registered here, in Rust, through Tauri's own plugin — a thin layer over the
// OS (RegisterHotKey on Windows). The pages are given no permission of the
// plugin's: they can neither register a shortcut nor listen to one. They ask
// for one of these three to be changed through `set_shortcut`, which checks it
// first, and the island is told which was pressed.
//
// Windows refuses a combination another program already holds. A change that
// is refused changes nothing: the shortcut that worked stays registered, and
// the settings window says why. One that cannot be registered never keeps the
// other from being.

use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::island::WINDOW_LABEL;
use crate::log;
use crate::settings::Settings;

/// What the island hears when a shortcut is pressed: this, with which one.
const EVENT: &str = "shortcut";
/// A key held down repeats: presses closer than this are one.
const REPEAT: Duration = Duration::from_millis(250);

const TAKEN: &str = "Already used by another app — pick another";
const TWICE: &str = "Already another Nook shortcut — pick another";

/// Which of the three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Which {
    Expand,
    Goto,
    Panel,
}

const ALL: [Which; 3] = [Which::Expand, Which::Goto, Which::Panel];

impl Which {
    fn name(self) -> &'static str {
        match self {
            Which::Expand => "expand",
            Which::Goto => "goto",
            Which::Panel => "panel",
        }
    }

    /// The shortcut as the settings have it, and whether it is on.
    fn saved(self, settings: &Settings) -> (&str, bool) {
        match self {
            Which::Expand => (&settings.expand_shortcut, settings.expand_shortcut_enabled),
            Which::Goto => (&settings.goto_shortcut, settings.goto_shortcut_enabled),
            Which::Panel => (&settings.panel_shortcut, settings.panel_shortcut_enabled),
        }
    }

    /// Writes one into the settings.
    pub fn save(self, settings: &mut Settings, status: &Status) {
        let (accelerator, enabled) = match self {
            Which::Expand => (&mut settings.expand_shortcut, &mut settings.expand_shortcut_enabled),
            Which::Goto => (&mut settings.goto_shortcut, &mut settings.goto_shortcut_enabled),
            Which::Panel => (&mut settings.panel_shortcut, &mut settings.panel_shortcut_enabled),
        };
        *accelerator = status.accelerator.clone();
        *enabled = status.enabled;
    }
}

/// Where a shortcut stands, for the settings window.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The shortcut as it is saved.
    pub accelerator: String,
    pub enabled: bool,
    /// The OS has it: pressing it works.
    pub registered: bool,
    /// Why it is not registered though it should be.
    pub error: Option<String>,
}

/// All three, by name.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Statuses {
    pub expand: Status,
    pub goto: Status,
    pub panel: Status,
}

#[derive(Default)]
struct Slot {
    registered: Option<Shortcut>,
    status: Status,
}

#[derive(Default)]
struct Held {
    expand: Slot,
    goto: Slot,
    panel: Slot,
    pressed: Option<Instant>,
}

impl Held {
    fn slot(&mut self, which: Which) -> &mut Slot {
        match which {
            Which::Expand => &mut self.expand,
            Which::Goto => &mut self.goto,
            Which::Panel => &mut self.panel,
        }
    }

    /// Whether a shortcut other than `which` holds or has saved this combination,
    /// on or off: switched on later, it must not be the same.
    fn taken_by_another(&mut self, which: Which, wanted: Shortcut) -> bool {
        ALL.into_iter().filter(|other| *other != which).any(|other| {
            let slot = self.slot(other);
            slot.registered == Some(wanted) || Shortcut::from_str(&slot.status.accelerator).ok() == Some(wanted)
        })
    }
}

#[derive(Default)]
pub struct Hotkeys(Mutex<Held>);

pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let which = {
                let hotkeys = app.state::<Hotkeys>();
                let mut held = hotkeys.0.lock().unwrap();
                let now = Instant::now();
                if held.pressed.is_some_and(|last| now.duration_since(last) < REPEAT) {
                    return;
                }
                held.pressed = Some(now);
                ALL.into_iter().find(|which| held.slot(*which).registered.as_ref() == Some(shortcut))
            };
            if let Some(which) = which {
                let _ = app.emit_to(WINDOW_LABEL, EVENT, which.name());
            }
        })
        .build()
}

/// A combination as the settings window writes it — "Ctrl+Alt+Space" — when it
/// is one, and one that can be taken: at least Ctrl, Alt or Win with a key,
/// and none of those Windows or every program already gives a meaning to.
pub fn check(accelerator: &str) -> Result<Shortcut, String> {
    let shortcut = Shortcut::from_str(accelerator.trim()).map_err(|_| "Press a key together with Ctrl, Alt or Win".to_string())?;
    match reserved(shortcut.mods, shortcut.key) {
        Some(why) => Err(why.to_string()),
        None => Ok(shortcut),
    }
}

fn reserved(mods: Modifiers, key: Code) -> Option<&'static str> {
    let ctrl = mods.contains(Modifiers::CONTROL);
    let alt = mods.contains(Modifiers::ALT);
    let win = mods.contains(Modifiers::SUPER);
    let shift = mods.contains(Modifiers::SHIFT);
    if !(ctrl || alt || win) {
        return Some("Press a key together with Ctrl, Alt or Win");
    }
    // Windows answers these itself, whatever asks for them.
    if win && !ctrl && !alt {
        return Some("Windows keeps the Win key's shortcuts for itself — pick another");
    }
    if alt && !ctrl && !win && matches!(key, Code::F4 | Code::Tab | Code::Escape | Code::Space) {
        return Some("Windows uses that one for its windows — pick another");
    }
    if ctrl && alt && !win && matches!(key, Code::Delete) {
        return Some("Windows keeps Ctrl+Alt+Del for itself — pick another");
    }
    if ctrl && !alt && !win && matches!(key, Code::Escape) {
        return Some("Windows uses that one for the Start menu and the Task Manager — pick another");
    }
    // Taken everywhere, these would stop copying, pasting, undoing, saving… in every program.
    let editing = matches!(
        key,
        Code::KeyA | Code::KeyC | Code::KeyF | Code::KeyN | Code::KeyO | Code::KeyP | Code::KeyR | Code::KeyS
            | Code::KeyT | Code::KeyV | Code::KeyW | Code::KeyX | Code::KeyY | Code::KeyZ
    );
    if ctrl && !alt && !win && !shift && editing {
        return Some("Every program uses that one (copy, paste, undo, save…) — pick another");
    }
    None
}

/// Takes a combination from the OS: the one way a shortcut is registered.
fn take(app: &AppHandle, which: Which, accelerator: &str, shortcut: Shortcut) -> Result<(), String> {
    match app.global_shortcut().register(shortcut) {
        Ok(()) => {
            log::line(format!("global shortcut {}: {accelerator} registered", which.name()));
            Ok(())
        }
        Err(err) => {
            log::line(format!("global shortcut {}: {accelerator} not registered: {err}", which.name()));
            Err(TAKEN.to_string())
        }
    }
}

/// At launch: each saved shortcut is registered, if it is on. One that cannot
/// be — another program got there first — is logged and said in the settings
/// window; Nook runs on without it, and the other is not held back by it.
pub fn start(app: &AppHandle, settings: &Settings) {
    let hotkeys = app.state::<Hotkeys>();
    let mut held = hotkeys.0.lock().unwrap();
    for which in ALL {
        let (accelerator, enabled) = which.saved(settings);
        let mut status = Status { accelerator: accelerator.to_string(), enabled, registered: false, error: None };
        let mut registered = None;
        if enabled {
            let outcome = check(accelerator).and_then(|shortcut| {
                if held.taken_by_another(which, shortcut) {
                    return Err(TWICE.to_string());
                }
                take(app, which, accelerator, shortcut).map(|_| shortcut)
            });
            match outcome {
                Ok(shortcut) => {
                    registered = Some(shortcut);
                    status.registered = true;
                }
                Err(why) => {
                    log::line(format!("global shortcut {}: {accelerator} is off: {why}", which.name()));
                    status.error = Some(why);
                }
            }
        }
        *held.slot(which) = Slot { registered, status };
    }
}

/// The settings window changes a shortcut, or switches it on or off. The new
/// one is taken before the old one is let go, so a combination Windows refuses
/// leaves the one that worked in place — and nothing is saved. The three are
/// never the same combination.
pub fn change(app: &AppHandle, which: Which, accelerator: &str, enabled: bool) -> Result<Status, String> {
    let accelerator = accelerator.trim();
    let wanted = check(accelerator)?;
    let hotkeys = app.state::<Hotkeys>();
    let mut held = hotkeys.0.lock().unwrap();
    if held.taken_by_another(which, wanted) {
        return Err(TWICE.to_string());
    }
    let had = held.slot(which).registered;
    let mut now = had;
    if enabled {
        if had != Some(wanted) {
            take(app, which, accelerator, wanted)?;
            if let Some(old) = had {
                let _ = app.global_shortcut().unregister(old);
            }
            now = Some(wanted);
        }
    } else if let Some(old) = had {
        let _ = app.global_shortcut().unregister(old);
        log::line(format!("global shortcut {}: off", which.name()));
        now = None;
    }
    let status = Status { accelerator: accelerator.to_string(), enabled, registered: now.is_some(), error: None };
    *held.slot(which) = Slot { registered: now, status: status.clone() };
    Ok(status)
}

pub fn statuses(app: &AppHandle) -> Statuses {
    let hotkeys = app.state::<Hotkeys>();
    let held = hotkeys.0.lock().unwrap();
    Statuses { expand: held.expand.status.clone(), goto: held.goto.status.clone(), panel: held.panel.status.clone() }
}

/// Nook quits: the OS is given the shortcuts back.
pub fn stop(app: &AppHandle) {
    let hotkeys = app.state::<Hotkeys>();
    let mut held = hotkeys.0.lock().unwrap();
    for which in ALL {
        let slot = held.slot(which);
        if let Some(old) = slot.registered.take() {
            let _ = app.global_shortcut().unregister(old);
        }
        slot.status.registered = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_shortcuts_can_be_taken_and_are_not_the_same() {
        let settings = Settings::default();
        assert_eq!(settings.expand_shortcut, "Ctrl+Alt+Space");
        assert_eq!(settings.goto_shortcut, "Ctrl+Alt+Enter");
        let expand = check(&settings.expand_shortcut).expect("the default shortcut is valid");
        let goto = check(&settings.goto_shortcut).expect("the default shortcut is valid");
        assert_eq!(expand.mods, Modifiers::CONTROL | Modifiers::ALT);
        assert_eq!(expand.key, Code::Space);
        assert_eq!(goto.key, Code::Enter);
        assert_eq!(settings.panel_shortcut, "Ctrl+Shift+Space");
        let panel = check(&settings.panel_shortcut).expect("the default shortcut is valid");
        assert_eq!(panel.mods, Modifiers::CONTROL | Modifiers::SHIFT);
        assert_eq!(panel.key, Code::Space);
        assert_ne!(expand, goto);
        assert_ne!(expand, panel);
        assert_ne!(goto, panel);
        // Neither is Ctrl+Alt with a letter or a digit: that is AltGr typing a character.
        for shortcut in [expand, goto, panel] {
            let key = format!("{:?}", shortcut.key);
            assert!(!key.starts_with("Key") && !key.starts_with("Digit"));
        }
    }

    #[test]
    fn the_same_combination_is_the_same_however_it_is_written() {
        assert_eq!(check("Ctrl+Alt+Space").unwrap(), check("alt+control+SPACE").unwrap());
        assert_eq!(check("Ctrl+Shift+K").unwrap(), check("Ctrl+Shift+KeyK").unwrap());
        assert_ne!(check("Ctrl+Alt+Space").unwrap(), check("Ctrl+Alt+Enter").unwrap());
    }

    #[test]
    fn a_shortcut_needs_ctrl_alt_or_win_and_a_key() {
        for bad in ["", "Space", "A", "Shift+A", "Ctrl", "Ctrl+Alt", "Ctrl+Alt+", "Ctrl+NotAKey"] {
            assert!(check(bad).is_err(), "{bad:?} must be refused");
        }
        for good in ["Ctrl+Alt+Space", "ctrl+alt+enter", "Ctrl+Shift+KeyK", "Alt+Shift+F9", "Ctrl+Alt+Super+J", "Ctrl+F12", "Ctrl+Shift+Z"] {
            assert!(check(good).is_ok(), "{good:?} must be accepted");
        }
    }

    #[test]
    fn what_windows_and_every_program_use_is_refused() {
        let reserved = [
            "Alt+F4", "Alt+Tab", "Alt+Escape", "Alt+Space", "Alt+Shift+Tab", "Ctrl+Alt+Delete", "Ctrl+Escape", "Ctrl+Shift+Escape",
            "Super+L", "Super+D", "Super+Shift+S", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+A", "Ctrl+S",
        ];
        for bad in reserved {
            assert!(check(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn each_shortcut_is_saved_in_its_own_place() {
        let mut settings = Settings::default();
        let status = Status { accelerator: "Ctrl+Shift+F9".into(), enabled: false, registered: false, error: None };
        Which::Goto.save(&mut settings, &status);
        assert_eq!(Which::Goto.saved(&settings), ("Ctrl+Shift+F9", false));
        assert_eq!(Which::Expand.saved(&settings), ("Ctrl+Alt+Space", true));
        assert_eq!(serde_json::to_string(&Which::Goto).unwrap(), "\"goto\"");
        assert_eq!(serde_json::from_str::<Which>("\"expand\"").unwrap(), Which::Expand);
    }

    #[test]
    fn the_third_shortcut_has_its_own_place_and_name() {
        let mut settings = Settings::default();
        let status = Status { accelerator: "Ctrl+Shift+F8".into(), enabled: false, registered: false, error: None };
        Which::Panel.save(&mut settings, &status);
        assert_eq!(Which::Panel.saved(&settings), ("Ctrl+Shift+F8", false));
        assert_eq!(Which::Goto.saved(&settings), ("Ctrl+Alt+Enter", true));
        assert_eq!(Which::Expand.saved(&settings), ("Ctrl+Alt+Space", true));
        assert_eq!(serde_json::to_string(&Which::Panel).unwrap(), "\"panel\"");
        let names: Vec<_> = ALL.iter().map(|which| which.name()).collect();
        assert_eq!(names, ["expand", "goto", "panel"]);
    }

    #[test]
    fn no_two_of_the_three_can_be_the_same_combination() {
        let mut held = Held::default();
        let wanted = check("Ctrl+Shift+Space").unwrap();
        // Another one's saved combination counts, registered or not.
        held.slot(Which::Expand).status.accelerator = "shift+ctrl+space".into();
        assert!(held.taken_by_another(Which::Panel, wanted));
        assert!(held.taken_by_another(Which::Goto, wanted));
        // Its own is not another's.
        assert!(!held.taken_by_another(Which::Expand, wanted));
        held.slot(Which::Expand).status.accelerator.clear();
        held.slot(Which::Goto).registered = Some(wanted);
        assert!(held.taken_by_another(Which::Panel, wanted));
        assert!(!held.taken_by_another(Which::Goto, wanted));
    }
}
