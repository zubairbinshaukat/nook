// Notification-area icon: Open, Hide / Show island, Show / Hide agents list,
// Settings, Pause, Quit. IDs and actions are independent of the visible labels.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::island::WINDOW_LABEL;
use crate::visibility;

const OPEN_ID: &str = "open";
const HIDE_ID: &str = "hide";
const AGENTS_ID: &str = "agents";
const SETTINGS_ID: &str = "settings";
const PAUSE_ID: &str = "pause";
const QUIT_ID: &str = "quit";
#[cfg(test)]
const MENU_IDS: &[&str] = &[OPEN_ID, HIDE_ID, AGENTS_ID, SETTINGS_ID, PAUSE_ID, QUIT_ID];
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct InitialMenuEnabled {
    open: bool,
    hide: bool,
    agents: bool,
    settings: bool,
    pause: bool,
    quit: bool,
}

const MENU_ENABLED: InitialMenuEnabled = InitialMenuEnabled {
    open: true,
    hide: true,
    agents: false,
    settings: true,
    pause: true,
    quit: true,
};

#[derive(Debug, Eq, PartialEq)]
enum TrayAction {
    Quit,
    Settings,
    ToggleIsland,
    ToggleAgents,
    Forward { wake_island: bool },
}

fn action_for_id(id: &str) -> TrayAction {
    match id {
        QUIT_ID => TrayAction::Quit,
        SETTINGS_ID => TrayAction::Settings,
        HIDE_ID => TrayAction::ToggleIsland,
        AGENTS_ID => TrayAction::ToggleAgents,
        OPEN_ID => TrayAction::Forward { wake_island: true },
        _ => TrayAction::Forward { wake_island: false },
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Language {
    En,
    Uk,
    Pl,
    Ru,
}

impl Language {
    fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Uk => "uk",
            Self::Pl => "pl",
            Self::Ru => "ru",
        }
    }

    fn from_preference(preference: &str) -> Self {
        let system_language = if preference == "system" {
            resolve_system_language()
        } else {
            Self::En
        };
        Self::for_preference(preference, system_language)
    }

    fn for_preference(preference: &str, system_language: Self) -> Self {
        match preference {
            "uk" => Self::Uk,
            "pl" => Self::Pl,
            "ru" => Self::Ru,
            "system" => system_language,
            _ => Self::En,
        }
    }

    fn text(self, key: MenuText) -> &'static str {
        let words = match self {
            Self::En => [
                "Open Nook",
                "Hide island",
                "Show island",
                "Show agents list",
                "Hide agents list",
                "Settings…",
                "Pause",
                "Quit",
            ],
            Self::Uk => [
                "Відкрити Nook",
                "Сховати острівець",
                "Показати острівець",
                "Показати список агентів",
                "Сховати список агентів",
                "Налаштування…",
                "Призупинити",
                "Вийти",
            ],
            Self::Pl => [
                "Otwórz Nook",
                "Ukryj wyspę",
                "Pokaż wyspę",
                "Pokaż listę agentów",
                "Ukryj listę agentów",
                "Ustawienia…",
                "Wstrzymaj",
                "Zakończ",
            ],
            Self::Ru => [
                "Открыть Nook",
                "Скрыть островок",
                "Показать островок",
                "Показать список агентов",
                "Скрыть список агентов",
                "Настройки…",
                "Приостановить",
                "Выйти",
            ],
        };
        words[key as usize]
    }

    fn island_label(self, hidden: bool) -> &'static str {
        if self == Self::En {
            return visibility::label(hidden);
        }
        self.text(if hidden {
            MenuText::ShowIsland
        } else {
            MenuText::HideIsland
        })
    }

    fn agents_label(self, shown: bool) -> &'static str {
        if self == Self::En {
            return crate::agents::label(shown);
        }
        self.text(if shown {
            MenuText::HideAgents
        } else {
            MenuText::ShowAgents
        })
    }
}

#[repr(usize)]
#[derive(Clone, Copy)]
enum MenuText {
    Open,
    HideIsland,
    ShowIsland,
    ShowAgents,
    HideAgents,
    Settings,
    Pause,
    Quit,
}

fn language_for_locale(locale: &str) -> Option<Language> {
    match locale
        .trim()
        .split(['-', '_', '.', '@'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "uk" => Some(Language::Uk),
        "pl" => Some(Language::Pl),
        "ru" => Some(Language::Ru),
        "en" => Some(Language::En),
        _ => None,
    }
}

fn resolve_locales<'a>(locales: impl IntoIterator<Item = &'a str>) -> Language {
    for locale in locales {
        if let Some(language) = language_for_locale(locale) {
            return language;
        }
    }
    Language::En
}

#[cfg(any(target_os = "linux", test))]
#[allow(dead_code)] // Also compiled for Windows unit tests of Linux locale rules.
fn resolve_linux_locale(
    language_list: &str,
    lc_all: &str,
    lc_messages: &str,
    lang: &str,
) -> Language {
    let active_locale = [lc_all, lc_messages, lang]
        .into_iter()
        .find(|locale| !locale.trim().is_empty())
        .unwrap_or("");
    let base = active_locale.split(['.', '@']).next().unwrap_or("").trim();
    if base.is_empty() || base.eq_ignore_ascii_case("C") || base.eq_ignore_ascii_case("POSIX") {
        return Language::En;
    }
    language_list
        .split(':')
        .filter(|locale| !locale.trim().is_empty())
        .find_map(language_for_locale)
        .or_else(|| language_for_locale(active_locale))
        .unwrap_or(Language::En)
}

/// The system locale, independent of the currently saved language preference.
pub fn system_language() -> &'static str {
    resolve_system_language().code()
}

#[cfg(windows)]
fn resolve_system_language() -> Language {
    use windows::core::PWSTR;
    use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};

    unsafe {
        let mut count = 0u32;
        let mut size = 0u32;
        if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut size).is_err()
            || size == 0
        {
            return Language::En;
        }
        let mut buffer = vec![0u16; size as usize];
        if GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut size,
        )
        .is_err()
        {
            return Language::En;
        }
        let preferred = String::from_utf16_lossy(&buffer);
        resolve_locales(preferred.split('\0').filter(|locale| !locale.is_empty()))
    }
}

#[cfg(target_os = "linux")]
fn resolve_system_language() -> Language {
    resolve_linux_locale(
        &std::env::var("LANGUAGE").unwrap_or_default(),
        &std::env::var("LC_ALL").unwrap_or_default(),
        &std::env::var("LC_MESSAGES").unwrap_or_default(),
        &std::env::var("LANG").unwrap_or_default(),
    )
}

#[cfg(not(any(windows, target_os = "linux")))]
fn resolve_system_language() -> Language {
    Language::En
}

/// The tray item and the latest dynamic state. Updating labels keeps the same
/// native menu items, IDs, enabled state and actions; no icon or menu rebuild.
struct TrayMenu {
    open: MenuItem<Wry>,
    hide: MenuItem<Wry>,
    agents: MenuItem<Wry>,
    settings: MenuItem<Wry>,
    pause: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    state: Mutex<TrayState>,
    updates: Sender<AppHandle>,
}

struct TrayState {
    language: Language,
    island_hidden: bool,
    agents_shown: bool,
    agents_enabled: bool,
}

impl TrayMenu {
    fn apply_language(&self, language: Language) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .language = language;
    }
}

#[derive(Clone, Copy)]
struct TrayPresentation {
    language: Language,
    island_hidden: bool,
    agents_shown: bool,
    agents_enabled: bool,
}

fn presentation(state: &TrayState) -> TrayPresentation {
    TrayPresentation {
        language: state.language,
        island_hidden: state.island_hidden,
        agents_shown: state.agents_shown,
        agents_enabled: state.agents_enabled,
    }
}

fn schedule_update(app: &AppHandle) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        // One worker serializes setters; each Tauri setter itself dispatches
        // to main and waits, so it must run off-main and with no state lock.
        // Producers report visibility, agents, or preference transitions, not
        // polling updates. Wake messages carry no state and the worker coalesces
        // backlog; bounding this channel would require a retry protocol to avoid
        // dropping the only notification for a state change.
        let _ = menu.updates.send(app.clone());
    }
}

fn update_worker(updates: Receiver<AppHandle>) {
    while let Ok(mut app) = updates.recv() {
        // Coalesce changes that arrived before this pass. The state remains the
        // authority; queued messages are only wakeups and carry no stale data.
        while let Ok(latest_app) = updates.try_recv() {
            app = latest_app;
        }
        let Some(menu) = app.try_state::<TrayMenu>() else {
            continue;
        };
        let state = menu.state.lock().unwrap_or_else(|error| error.into_inner());
        let view = presentation(&state);
        drop(state);
        let language = view.language;
        let _ = menu.open.set_text(language.text(MenuText::Open));
        let _ = menu
            .hide
            .set_text(language.island_label(view.island_hidden));
        let _ = menu
            .agents
            .set_text(language.agents_label(view.agents_shown));
        let _ = menu.agents.set_enabled(view.agents_enabled);
        let _ = menu.settings.set_text(language.text(MenuText::Settings));
        let _ = menu.pause.set_text(language.text(MenuText::Pause));
        let _ = menu.quit.set_text(language.text(MenuText::Quit));
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let preference = app
        .state::<crate::Shared>()
        .settings
        .lock()
        .unwrap()
        .language
        .clone();
    let language = Language::from_preference(&preference);
    let open = MenuItem::with_id(
        app,
        OPEN_ID,
        language.text(MenuText::Open),
        MENU_ENABLED.open,
        None::<&str>,
    )?;
    let hide = MenuItem::with_id(
        app,
        HIDE_ID,
        language.island_label(false),
        MENU_ENABLED.hide,
        None::<&str>,
    )?;
    let agents = MenuItem::with_id(
        app,
        AGENTS_ID,
        language.agents_label(false),
        MENU_ENABLED.agents,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        SETTINGS_ID,
        language.text(MenuText::Settings),
        MENU_ENABLED.settings,
        None::<&str>,
    )?;
    let pause = MenuItem::with_id(
        app,
        PAUSE_ID,
        language.text(MenuText::Pause),
        MENU_ENABLED.pause,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        QUIT_ID,
        language.text(MenuText::Quit),
        MENU_ENABLED.quit,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &open, &hide, &agents, &sep1, &settings, &pause, &sep2, &quit,
        ],
    )?;
    let (updates, update_receiver) = mpsc::channel();
    app.manage(TrayMenu {
        open,
        hide,
        agents,
        settings,
        pause,
        quit,
        state: Mutex::new(TrayState {
            language,
            island_hidden: false,
            agents_shown: false,
            agents_enabled: MENU_ENABLED.agents,
        }),
        updates,
    });
    std::thread::Builder::new()
        .name("nook-tray-menu".into())
        .spawn(move || update_worker(update_receiver))?;

    let mut builder = TrayIconBuilder::with_id("nook")
        .tooltip("Nook")
        .menu(&menu)
        .on_menu_event(
            |app: &AppHandle, event| match action_for_id(event.id.as_ref()) {
                TrayAction::Quit => app.exit(0),
                TrayAction::Settings => crate::show_settings_window(app),
                TrayAction::ToggleIsland => visibility::toggle(app),
                TrayAction::ToggleAgents => crate::agents::toggle(app),
                TrayAction::Forward { wake_island } => {
                    // Open Nook brings back a hidden island, then the page opens it.
                    if wake_island {
                        visibility::open(app);
                    }
                    let _ = app.emit_to(WINDOW_LABEL, "tray", event.id.as_ref().to_string());
                }
            },
        );

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

pub fn set_language(app: &AppHandle, preference: &str) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        menu.apply_language(Language::from_preference(preference));
        schedule_update(app);
    }
}

/// The island is hidden, or shown: the item says what pressing it does next.
pub fn say_hidden(app: &AppHandle, hidden: bool) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        menu.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .island_hidden = hidden;
        schedule_update(app);
    }
}

/// The agents list is on or off in Settings, and shown or hidden: the item says
/// what pressing it does next, and can be pressed only while the list is on.
pub fn say_agents(app: &AppHandle, enabled: bool, shown: bool) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let mut state = menu.state.lock().unwrap_or_else(|error| error.into_inner());
        state.agents_shown = shown;
        state.agents_enabled = enabled;
        drop(state);
        schedule_update(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_and_unsupported_system_locales_resolve() {
        assert_eq!(resolve_locales(["fr_FR", "uk_UA.UTF-8"]), Language::Uk);
        assert_eq!(resolve_locales(["pl-PL"]), Language::Pl);
        assert_eq!(resolve_locales(["ru_RU"]), Language::Ru);
        assert_eq!(resolve_locales(["fr_FR", "de_DE"]), Language::En);
        assert_eq!(Language::from_preference("unknown"), Language::En);
        assert_eq!(Language::for_preference("en", Language::Uk), Language::En);
        assert_eq!(Language::for_preference("uk", Language::Pl), Language::Uk);
        assert_eq!(Language::for_preference("pl", Language::Ru), Language::Pl);
        assert_eq!(Language::for_preference("ru", Language::En), Language::Ru);
        assert_eq!(
            Language::for_preference("system", Language::Uk),
            Language::Uk
        );
        assert_eq!(
            Language::for_preference("system", Language::Pl),
            Language::Pl
        );
        assert_eq!(
            Language::for_preference("system", Language::En),
            Language::En
        );
        assert_eq!(
            Language::for_preference("unknown", Language::Uk),
            Language::En
        );
        assert!(matches!(system_language(), "en" | "uk" | "pl" | "ru"));
        assert_eq!(
            Language::from_preference("system").code(),
            system_language()
        );
    }

    #[test]
    fn linux_locale_follows_gettext_precedence_without_environment_mutation() {
        assert_eq!(
            resolve_linux_locale("uk:pl", "fr_FR.UTF-8", "ru_RU", "en_US"),
            Language::Uk
        );
        assert_eq!(
            resolve_linux_locale("xx:pl_PL.UTF-8", "fr_FR", "ru_RU", "en_US"),
            Language::Pl
        );
        assert_eq!(
            resolve_linux_locale("uk:pl", "C.UTF-8", "ru_RU", "en_US"),
            Language::En
        );
        assert_eq!(
            resolve_linux_locale("uk:pl", "", "POSIX", "uk_UA"),
            Language::En
        );
        assert_eq!(
            resolve_linux_locale("", "", "ru_RU.UTF-8", "pl_PL"),
            Language::Ru
        );
        assert_eq!(
            resolve_linux_locale("", "", "", "pl_PL.UTF-8"),
            Language::Pl
        );
        assert_eq!(
            resolve_linux_locale("", "fr_FR", "ru_RU", "uk_UA"),
            Language::En
        );
        assert_eq!(resolve_linux_locale("uk", "", "", ""), Language::En);
        assert_eq!(resolve_linux_locale("", "", "", "fr_FR"), Language::En);
    }

    #[test]
    fn tray_wakeups_render_the_latest_authoritative_state() {
        let mut state = TrayState {
            language: Language::En,
            island_hidden: false,
            agents_shown: false,
            agents_enabled: MENU_ENABLED.agents,
        };
        state.island_hidden = true;
        state.language = Language::Uk;
        state.agents_enabled = true;
        state.agents_shown = true;
        let view = presentation(&state);
        assert_eq!(view.language, Language::Uk);
        assert!(view.island_hidden && view.agents_enabled && view.agents_shown);
        assert_eq!(
            view.language.island_label(view.island_hidden),
            "Показати острівець"
        );
        assert_eq!(
            view.language.agents_label(view.agents_shown),
            "Сховати список агентів"
        );
    }

    #[test]
    fn tray_ids_enabled_defaults_and_actions_remain_stable() {
        assert_eq!(
            MENU_IDS,
            &["open", "hide", "agents", "settings", "pause", "quit"]
        );
        assert_eq!(
            MENU_ENABLED,
            InitialMenuEnabled {
                open: true,
                hide: true,
                agents: false,
                settings: true,
                pause: true,
                quit: true
            }
        );
        assert_eq!(
            action_for_id(OPEN_ID),
            TrayAction::Forward { wake_island: true }
        );
        assert_eq!(action_for_id(HIDE_ID), TrayAction::ToggleIsland);
        assert_eq!(action_for_id(AGENTS_ID), TrayAction::ToggleAgents);
        assert_eq!(action_for_id(SETTINGS_ID), TrayAction::Settings);
        assert_eq!(
            action_for_id(PAUSE_ID),
            TrayAction::Forward { wake_island: false }
        );
        assert_eq!(action_for_id(QUIT_ID), TrayAction::Quit);
    }

    #[test]
    fn every_language_has_static_and_dynamic_menu_labels() {
        for language in [Language::En, Language::Uk, Language::Pl, Language::Ru] {
            assert!(!language.text(MenuText::Open).is_empty());
            assert!(!language.text(MenuText::Settings).is_empty());
            assert!(!language.text(MenuText::Pause).is_empty());
            assert!(!language.text(MenuText::Quit).is_empty());
            assert_ne!(language.island_label(false), language.island_label(true));
            assert_ne!(language.agents_label(false), language.agents_label(true));
        }
        assert_eq!(Language::En.island_label(false), "Hide island");
        assert_eq!(Language::En.agents_label(true), "Hide agents list");
    }
}
