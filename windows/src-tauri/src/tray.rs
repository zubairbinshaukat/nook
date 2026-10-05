// Notification-area icon: Open, Hide / Show island, Show / Hide agents list,
// Settings, Pause, Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::island::WINDOW_LABEL;
use crate::visibility;

/// The item that hides the island and shows it: its words follow the island.
pub struct HideItem(MenuItem<Wry>);

/// The item that shows the agents list and hides it: its words follow the list,
/// and it is greyed out while the list is off in Settings.
pub struct AgentsItem(MenuItem<Wry>);

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Nook", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", visibility::label(false), true, None::<&str>)?;
    let agents = MenuItem::with_id(app, "agents", crate::agents::label(false), false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &hide, &agents, &sep1, &settings, &pause, &sep2, &quit])?;
    app.manage(HideItem(hide));
    app.manage(AgentsItem(agents));

    let mut builder = TrayIconBuilder::with_id("nook")
        .tooltip("Nook")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "hide" => visibility::toggle(app),
            "agents" => crate::agents::toggle(app),
            id => {
                // Open Nook brings back an island that was hidden, then the page opens it.
                if id == "open" {
                    visibility::open(app);
                }
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// The island is hidden, or shown: the item says what pressing it does next.
pub fn say_hidden(app: &AppHandle, hidden: bool) {
    if let Some(item) = app.try_state::<HideItem>() {
        let _ = item.0.set_text(visibility::label(hidden));
    }
}

/// The agents list is on or off in Settings, and shown or hidden: the item says
/// what pressing it does next, and can be pressed only while the list is on.
pub fn say_agents(app: &AppHandle, enabled: bool, shown: bool) {
    if let Some(item) = app.try_state::<AgentsItem>() {
        let _ = item.0.set_text(crate::agents::label(shown));
        let _ = item.0.set_enabled(enabled);
    }
}
