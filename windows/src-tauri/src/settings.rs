// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// There is no secret among them: the app keeps none.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A field a settings file does not have takes its default: a file written by
/// an older Nook still loads, with everything it did say.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    /// The edge of the display the island hangs from: one of dock.rs `DOCKS`.
    #[serde(default = "default_dock")]
    pub dock: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// The global shortcut that opens the session panel large, or shrinks it
    /// ("Ctrl+Alt+Space"), and whether it is on. See shortcut.rs.
    pub expand_shortcut: String,
    pub expand_shortcut_enabled: bool,
    /// The one that goes to the session that needs the user ("Ctrl+Alt+Enter").
    pub goto_shortcut: String,
    pub goto_shortcut_enabled: bool,
    /// The one that opens the session panel at its normal size ("Ctrl+Shift+Space").
    pub panel_shortcut: String,
    pub panel_shortcut_enabled: bool,
    /// The one that hides the island altogether, or shows it again ("Ctrl+Alt+N").
    pub hide_shortcut: String,
    pub hide_shortcut_enabled: bool,
    /// The one that shows the agents list, or hides it ("Ctrl+Shift+L"). Only
    /// registered while the list itself is on (`show_agents_list`).
    pub agents_shortcut: String,
    pub agents_shortcut_enabled: bool,
    /// Settings → General → Agents list: the small always-on-top window with
    /// one row per project (agents.rs). Off until the user asks for it.
    pub show_agents_list: bool,
    /// Where the list was left, in physical screen pixels: both or neither.
    /// Written by Rust as the window is dragged, never by a page.
    pub agents_list_x: Option<i32>,
    pub agents_list_y: Option<i32>,
    /// How wide the user made it, in logical pixels, between the least and most
    /// the list allows (agents.rs); none until they do, and then it is the default.
    /// Written by Rust as the edge is dragged, never by a page.
    #[serde(default)]
    pub agents_list_w: Option<u32>,
    /// The most it may be tall, in logical pixels: it is as tall as its rows, and
    /// no taller than this (none is the default most). Written by Rust as the
    /// bottom edge is dragged, never by a page.
    #[serde(default)]
    pub agents_list_h: Option<u32>,
    /// The list dims while the pointer is away and nothing waits for the user,
    /// to `agents_list_fade_opacity` percent (FADE_OPACITY holds the range).
    pub agents_list_fade: bool,
    pub agents_list_fade_opacity: u32,
    /// What the compact island shows next to the bot, in order: at most
    /// MAX_COMPACT_METRICS of COMPACT_METRICS. See `compact_metrics`.
    #[serde(default = "default_compact_metrics")]
    pub compact_metrics: Vec<String>,
    /// The settings window's colours: "light", "dark", or "system" (follow the
    /// OS). The island is dark whatever this says.
    #[serde(default = "default_follow_system")]
    pub theme: String,
    /// "system" (follow the OS), "on" (nothing travels or fades), "off".
    #[serde(default = "default_follow_system")]
    pub reduce_motion: String,
    /// The bot's colours: one of BOT_THEMES.
    #[serde(default = "default_bot_theme")]
    pub bot_theme: String,
    /// Gullu reacts to the mouse and to clicks. Off: the status faces only.
    #[serde(default = "default_true")]
    pub playful_reactions: bool,
    /// The Shelf's widgets, all of them, in the order they stand in.
    #[serde(default = "default_shelf_order")]
    pub shelf_order: Vec<String>,
    /// The ones that are switched off.
    #[serde(default)]
    pub shelf_hidden: Vec<String>,
    /// Settings → Island → Visibility. The folded island hides after this many
    /// seconds left alone: one of FOLDED_AUTO_HIDE, 0 being "never".
    #[serde(default = "default_folded_auto_hide")]
    pub folded_auto_hide: f64,
    /// It does not hide while a session is working, thinking or asking.
    #[serde(default)]
    pub hide_only_when_idle: bool,
    /// It stays hidden while a full-screen app is in front on its display —
    /// but for a request, which always shows (fullscreen.rs).
    #[serde(default = "default_true")]
    pub hide_in_fullscreen: bool,
    /// Settings → Cursor: Cursor's agent sessions are shown beside Claude Code's.
    #[serde(default = "default_true")]
    pub show_cursor_sessions: bool,
    /// Settings → Codex: Codex's sessions are shown beside Claude Code's.
    #[serde(default = "default_true")]
    pub show_codex_sessions: bool,
}

/// The choices of "Auto-hide the folded island after", in seconds; 0 is never.
pub const FOLDED_AUTO_HIDE: &[f64] = &[5.0, 10.0, 30.0, 60.0, 0.0];

/// The least and most the idle opacity of the agents list can be, in percent
/// (src/core/state.ts holds the same), and what it is out of the box.
pub const FADE_OPACITY: std::ops::RangeInclusive<u32> = 20..=90;
const DEFAULT_FADE_OPACITY: u32 = 50;

/// A minute: what the delay was before it could be chosen.
fn default_folded_auto_hide() -> f64 {
    60.0
}

/// What the hide shortcut is out of the box.
fn default_hide_shortcut() -> String {
    "Ctrl+Alt+N".into()
}

/// The hide shortcut as it is kept: a combination that can be taken, or the default for
/// anything else (the file was edited by hand). The settings window only ever
/// writes one that was registered.
fn hide_shortcut(said: &str) -> String {
    if crate::shortcut::check(said).is_ok() { said.trim().to_string() } else { default_hide_shortcut() }
}

/// What the agents shortcut is out of the box: no Ctrl+Alt with a letter (AltGr).
fn default_agents_shortcut() -> String {
    "Ctrl+Shift+L".into()
}

/// The agents shortcut as it is kept, as `hide_shortcut` keeps its own.
fn agents_shortcut(said: &str) -> String {
    if crate::shortcut::check(said).is_ok() { said.trim().to_string() } else { default_agents_shortcut() }
}

fn default_true() -> bool {
    true
}

/// The delay as it is kept: one of the choices, or the default for anything else.
pub fn folded_auto_hide(said: f64) -> f64 {
    if FOLDED_AUTO_HIDE.contains(&said) { said } else { default_folded_auto_hide() }
}

/// Everything the compact island can show a number for.
pub const COMPACT_METRICS: &[&str] = &["cpu", "gpu", "ram", "usage5h", "usage7d", "waiting"];
/// As many of them as it has room for.
pub const MAX_COMPACT_METRICS: usize = 3;

fn default_compact_metrics() -> Vec<String> {
    ["cpu", "ram", "usage5h"].map(String::from).to_vec()
}

/// A choice of compact metrics as it is kept: the ones Nook knows, each once,
/// in the order they were picked, and no more than there is room for. A page
/// — or a file edited by hand — says what it likes; this is what is saved.
pub fn compact_metrics(picked: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for metric in picked {
        if kept.len() < MAX_COMPACT_METRICS && COMPACT_METRICS.contains(&metric.as_str()) && !kept.contains(metric) {
            kept.push(metric.clone());
        }
    }
    kept
}

/// What `theme` can say, and `reduce_motion`: the first of each is the default.
pub const THEMES: &[&str] = &["system", "light", "dark"];
pub const REDUCE_MOTION: &[&str] = &["system", "on", "off"];
/// The bot's colours (src/bot/engine.ts `BOT_THEMES`): the first is the default.
pub const BOT_THEMES: &[&str] = &["cream", "peach", "mint", "lilac", "sky", "cocoa"];
/// The Shelf's widgets, in the order they come in.
pub const SHELF_WIDGETS: &[&str] = &["media", "todo", "timer", "reminders", "mirror", "projects"];

fn default_follow_system() -> String {
    "system".into()
}

fn default_dock() -> String {
    crate::dock::DOCKS[0].into()
}

fn default_bot_theme() -> String {
    BOT_THEMES[0].into()
}

fn default_shelf_order() -> Vec<String> {
    SHELF_WIDGETS.iter().map(|id| id.to_string()).collect()
}

/// One of `known`, or the first of them: a word Nook does not know is not kept.
pub fn one_of(known: &[&str], said: &str) -> String {
    known.iter().find(|word| **word == said).unwrap_or(&known[0]).to_string()
}

/// The widgets Nook knows among `said`, each once, in the order said.
fn known_widgets(said: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for id in said {
        if SHELF_WIDGETS.contains(&id.as_str()) && !kept.contains(id) {
            kept.push(id.clone());
        }
    }
    kept
}

/// The Shelf's order as it is kept: every widget once — the known ones in the
/// order said, then any that were left out, in the order they come in.
pub fn shelf_order(said: &[String]) -> Vec<String> {
    let mut kept = known_widgets(said);
    for id in SHELF_WIDGETS {
        if !kept.iter().any(|k| k == id) {
            kept.push(id.to_string());
        }
    }
    kept
}

/// The hidden widgets as they are kept: known ones only, each once.
pub fn shelf_hidden(said: &[String]) -> Vec<String> {
    known_widgets(said)
}

impl Settings {
    /// The edge the island hangs from.
    pub fn dock(&self) -> crate::dock::Dock {
        crate::dock::Dock::parse(&self.dock)
    }

    /// Holds what a page, or a file edited by hand, said to what Nook knows.
    /// Nothing that fails here is an error: the nearest valid choice is kept.
    pub fn validated(mut self) -> Self {
        self.compact_metrics = compact_metrics(&self.compact_metrics);
        self.dock = one_of(crate::dock::DOCKS, &self.dock);
        self.theme = one_of(THEMES, &self.theme);
        self.reduce_motion = one_of(REDUCE_MOTION, &self.reduce_motion);
        self.bot_theme = one_of(BOT_THEMES, &self.bot_theme);
        self.shelf_order = shelf_order(&self.shelf_order);
        self.shelf_hidden = shelf_hidden(&self.shelf_hidden);
        self.folded_auto_hide = folded_auto_hide(self.folded_auto_hide);
        self.hide_shortcut = hide_shortcut(&self.hide_shortcut);
        self.agents_shortcut = agents_shortcut(&self.agents_shortcut);
        // A position is two numbers or none: one alone says nothing.
        if self.agents_list_x.is_none() || self.agents_list_y.is_none() {
            self.agents_list_x = None;
            self.agents_list_y = None;
        }
        self.agents_list_w = self.agents_list_w.filter(|w| (crate::agents::MIN_WIDTH as u32..=crate::agents::MAX_WIDTH as u32).contains(w));
        self.agents_list_h = self.agents_list_h.filter(|h| (crate::agents::MIN_HEIGHT as u32..=crate::agents::MAX_CAP as u32).contains(h));
        self.agents_list_fade_opacity = self.agents_list_fade_opacity.clamp(*FADE_OPACITY.start(), *FADE_OPACITY.end());
        self
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            screen: "primary".into(),
            dock: default_dock(),
            autostart: false,
            hooks_installed: false,
            expand_shortcut: "Ctrl+Alt+Space".into(),
            expand_shortcut_enabled: true,
            goto_shortcut: "Ctrl+Alt+Enter".into(),
            goto_shortcut_enabled: true,
            panel_shortcut: "Ctrl+Shift+Space".into(),
            panel_shortcut_enabled: true,
            hide_shortcut: default_hide_shortcut(),
            hide_shortcut_enabled: true,
            agents_shortcut: default_agents_shortcut(),
            agents_shortcut_enabled: true,
            show_agents_list: false,
            agents_list_x: None,
            agents_list_y: None,
            agents_list_w: None,
            agents_list_h: None,
            agents_list_fade: true,
            agents_list_fade_opacity: DEFAULT_FADE_OPACITY,
            compact_metrics: default_compact_metrics(),
            theme: default_follow_system(),
            reduce_motion: default_follow_system(),
            bot_theme: default_bot_theme(),
            playful_reactions: true,
            shelf_order: default_shelf_order(),
            shelf_hidden: Vec::new(),
            folded_auto_hide: default_folded_auto_hide(),
            hide_only_when_idle: false,
            hide_in_fullscreen: true,
            show_cursor_sessions: true,
            show_codex_sessions: true,
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    let settings: Settings = match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    settings.validated()
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settings_file_from_before_the_shortcut_still_loads() {
        let old = r#"{"soundEnabled":false,"soundVolume":0.05,"autoCloseInterval":30.0,"absenceInterval":180.0,"screen":"cursor","autostart":true,"hooksInstalled":true}"#;
        let settings: Settings = serde_json::from_str(old).expect("an older file loads");
        assert!(!settings.sound_enabled);
        assert_eq!(settings.screen, "cursor");
        assert!(settings.autostart);
        assert_eq!(settings.expand_shortcut, "Ctrl+Alt+Space");
        assert!(settings.expand_shortcut_enabled);
        assert_eq!(settings.goto_shortcut, "Ctrl+Alt+Enter");
        assert!(settings.goto_shortcut_enabled);
        assert_eq!(settings.panel_shortcut, "Ctrl+Shift+Space");
        assert!(settings.panel_shortcut_enabled);
        assert_eq!(settings.hide_shortcut, "Ctrl+Alt+N");
        assert!(settings.hide_shortcut_enabled);
        // One written when there was a single shortcut loads too, with what it said.
        let one = r#"{"soundEnabled":true,"expandShortcut":"Ctrl+Shift+F9","expandShortcutEnabled":false}"#;
        let settings: Settings = serde_json::from_str(one).expect("a file with one shortcut loads");
        assert_eq!(settings.expand_shortcut, "Ctrl+Shift+F9");
        assert!(!settings.expand_shortcut_enabled);
        assert_eq!(settings.goto_shortcut, "Ctrl+Alt+Enter");
        assert_eq!(settings.panel_shortcut, "Ctrl+Shift+Space");
    }

    #[test]
    fn the_hide_shortcut_is_kept_when_it_can_be_taken_and_is_the_default_when_it_cannot() {
        let said = r#"{"hideShortcut":" Ctrl+Shift+F9 ","hideShortcutEnabled":false}"#;
        let settings = serde_json::from_str::<Settings>(said).unwrap().validated();
        assert_eq!(settings.hide_shortcut, "Ctrl+Shift+F9");
        assert!(!settings.hide_shortcut_enabled);
        for bad in ["", "N", "Ctrl+Alt+Delete", "Ctrl+C", "nonsense"] {
            let settings = Settings { hide_shortcut: bad.into(), ..Settings::default() }.validated();
            assert_eq!(settings.hide_shortcut, "Ctrl+Alt+N", "{bad:?}");
        }
    }

    #[test]
    fn the_agents_list_is_off_by_default_and_an_older_file_loads_without_it() {
        let old: Settings = serde_json::from_str(r#"{"soundEnabled":false,"hideShortcut":"Ctrl+Shift+F9"}"#).unwrap();
        assert!(!old.show_agents_list);
        assert_eq!((old.agents_list_x, old.agents_list_y), (None, None));
        assert_eq!(old.agents_list_w, None);
        assert_eq!(old.agents_shortcut, "Ctrl+Shift+L");
        assert!(old.agents_shortcut_enabled);
        assert!(!Settings::default().show_agents_list);
        // Written in camelCase, and read back as written.
        let on = Settings { show_agents_list: true, agents_list_x: Some(-1200), agents_list_y: Some(40), ..Settings::default() }.validated();
        let json = serde_json::to_string(&on).unwrap();
        for key in [r#""showAgentsList":true"#, r#""agentsListX":-1200"#, r#""agentsListY":40"#, r#""agentsShortcut":"Ctrl+Shift+L""#] {
            assert!(json.contains(key), "{key} in {json}");
        }
        let back = serde_json::from_str::<Settings>(&json).unwrap().validated();
        assert_eq!((back.show_agents_list, back.agents_list_x, back.agents_list_y), (true, Some(-1200), Some(40)));
    }

    #[test]
    fn the_agents_shortcut_and_position_are_held_to_what_can_be_kept() {
        let said = r#"{"agentsShortcut":" Ctrl+Shift+F9 ","agentsShortcutEnabled":false}"#;
        let settings = serde_json::from_str::<Settings>(said).unwrap().validated();
        assert_eq!(settings.agents_shortcut, "Ctrl+Shift+F9");
        assert!(!settings.agents_shortcut_enabled);
        for bad in ["", "L", "Ctrl+Alt+Delete", "Ctrl+C", "nonsense"] {
            let settings = Settings { agents_shortcut: bad.into(), ..Settings::default() }.validated();
            assert_eq!(settings.agents_shortcut, "Ctrl+Shift+L", "{bad:?}");
        }
        // Half a position is no position.
        let half = Settings { agents_list_x: Some(10), agents_list_y: None, ..Settings::default() }.validated();
        assert_eq!((half.agents_list_x, half.agents_list_y), (None, None));
    }

    #[test]
    fn the_agents_list_width_is_kept_between_its_limits_or_dropped() {
        let width = |w: Option<u32>| Settings { agents_list_w: w, ..Settings::default() }.validated().agents_list_w;
        assert_eq!(width(Some(280)), Some(280));
        assert_eq!(width(Some(400)), Some(400));
        assert_eq!(width(Some(640)), Some(640));
        for bad in [0, 279, 641, 100_000] {
            assert_eq!(width(Some(bad)), None, "{bad}");
        }
        assert_eq!(width(None), None);
        // Written in camelCase, and read back as written.
        let json = serde_json::to_string(&Settings { agents_list_w: Some(412), ..Settings::default() }.validated()).unwrap();
        assert!(json.contains(r#""agentsListW":412"#), "{json}");
        assert_eq!(serde_json::from_str::<Settings>(&json).unwrap().agents_list_w, Some(412));
    }

    #[test]
    fn the_agents_list_height_cap_is_kept_between_its_limits_or_dropped() {
        let cap = |h: Option<u32>| Settings { agents_list_h: h, ..Settings::default() }.validated().agents_list_h;
        for good in [72, 300, 520, 2000] {
            assert_eq!(cap(Some(good)), Some(good));
        }
        for bad in [0, 71, 2001, u32::MAX] {
            assert_eq!(cap(Some(bad)), None, "{bad}");
        }
        assert_eq!(cap(None), None);
        // A file from before it loads with the default; written in camelCase, read back as written.
        assert_eq!(serde_json::from_str::<Settings>(r#"{"agentsListW":400}"#).unwrap().agents_list_h, None);
        let json = serde_json::to_string(&Settings { agents_list_h: Some(333), ..Settings::default() }.validated()).unwrap();
        assert!(json.contains(r#""agentsListH":333"#), "{json}");
        assert_eq!(serde_json::from_str::<Settings>(&json).unwrap().agents_list_h, Some(333));
    }

    #[test]
    fn the_agents_list_fades_by_default_and_its_opacity_is_held_to_its_range() {
        let old: Settings = serde_json::from_str(r#"{"soundEnabled":false,"agentsListW":400}"#).unwrap();
        assert!(old.agents_list_fade);
        assert_eq!(old.agents_list_fade_opacity, 50);
        let defaults = Settings::default().validated();
        assert_eq!((defaults.agents_list_fade, defaults.agents_list_fade_opacity), (true, 50));
        let opacity = |said: u32| Settings { agents_list_fade_opacity: said, ..Settings::default() }.validated().agents_list_fade_opacity;
        assert_eq!((opacity(0), opacity(19), opacity(20), opacity(55), opacity(90), opacity(91), opacity(5000)), (20, 20, 20, 55, 90, 90, 90));
        let off = Settings { agents_list_fade: false, agents_list_fade_opacity: 35, ..Settings::default() }.validated();
        let json = serde_json::to_string(&off).unwrap();
        for key in [r#""agentsListFade":false"#, r#""agentsListFadeOpacity":35"#] {
            assert!(json.contains(key), "{key} in {json}");
        }
        let back = serde_json::from_str::<Settings>(&json).unwrap().validated();
        assert_eq!((back.agents_list_fade, back.agents_list_fade_opacity), (false, 35));
    }

    #[test]
    fn the_compact_metrics_default_when_a_file_has_none_and_are_kept_to_what_is_known() {
        let words = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // A file from before them: the default three.
        let old: Settings = serde_json::from_str(r#"{"soundEnabled":false}"#).unwrap();
        assert_eq!(old.compact_metrics, words(&["cpu", "ram", "usage5h"]));
        assert_eq!(Settings::default().compact_metrics, old.compact_metrics);
        // Saved in camelCase, read back in the order picked.
        let picked = Settings { compact_metrics: words(&["waiting", "usage7d"]), ..Settings::default() };
        let json = serde_json::to_string(&picked).unwrap();
        assert!(json.contains(r#""compactMetrics":["waiting","usage7d"]"#));
        assert_eq!(serde_json::from_str::<Settings>(&json).unwrap().compact_metrics, picked.compact_metrics);
        // None at all is a choice.
        assert_eq!(serde_json::from_str::<Settings>(r#"{"compactMetrics":[]}"#).unwrap().compact_metrics, words(&[]));

        // Unknown ones go, a repeat counts once, and the fourth is one too many.
        assert_eq!(compact_metrics(&words(&["disk", "ram", "ram", "cpu", "", "RAM"])), words(&["ram", "cpu"]));
        assert_eq!(compact_metrics(&words(&["cpu", "ram", "usage5h", "usage7d", "waiting"])), words(&["cpu", "ram", "usage5h"]));
        assert_eq!(compact_metrics(&words(&["waiting", "bogus", "usage7d", "cpu", "ram"])), words(&["waiting", "usage7d", "cpu"]));
        assert_eq!(compact_metrics(&[]), words(&[]));
        // The graphics processor is one of them.
        assert_eq!(compact_metrics(&words(&["gpu", "cpu", "GPU", "gpu"])), words(&["gpu", "cpu"]));
    }

    #[test]
    fn a_file_from_before_the_new_window_loads_with_its_defaults() {
        let words = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let old: Settings = serde_json::from_str(r#"{"soundEnabled":false,"compactMetrics":["ram"]}"#).unwrap();
        assert!(!old.sound_enabled);
        assert_eq!(old.compact_metrics, words(&["ram"]));
        assert_eq!(old.theme, "system");
        assert_eq!(old.reduce_motion, "system");
        assert_eq!(old.bot_theme, "cream");
        assert_eq!(old.shelf_order, words(SHELF_WIDGETS));
        assert_eq!(old.shelf_hidden, words(&[]));
        // The defaults are valid as they are, and are written in camelCase.
        let json = serde_json::to_string(&Settings::default().validated()).unwrap();
        for key in [r#""theme":"system""#, r#""reduceMotion":"system""#, r#""botTheme":"cream""#, r#""shelfHidden":[]"#] {
            assert!(json.contains(key), "{key} in {json}");
        }
        assert!(json.contains(r#""shelfOrder":["media","todo","timer","reminders","mirror","projects"]"#));
    }

    #[test]
    fn what_a_page_says_is_held_to_what_nook_knows() {
        let words = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // A word that is one of the choices is kept; any other falls back to the default.
        for theme in ["light", "dark", "system"] {
            assert_eq!(one_of(THEMES, theme), theme);
        }
        for said in ["", "Dark", "sepia", "on"] {
            assert_eq!(one_of(THEMES, said), "system");
        }
        for motion in ["system", "on", "off"] {
            assert_eq!(one_of(REDUCE_MOTION, motion), motion);
        }
        assert_eq!(one_of(REDUCE_MOTION, "reduce"), "system");
        for bot in BOT_THEMES {
            assert_eq!(one_of(BOT_THEMES, bot), *bot);
        }
        assert_eq!(one_of(BOT_THEMES, "#ff0000"), "cream");

        // The order always holds every widget once: unknown ids go, a repeat
        // counts once, and what was left out follows in the usual order.
        assert_eq!(shelf_order(&words(&["projects", "media"])), words(&["projects", "media", "todo", "timer", "reminders", "mirror"]));
        assert_eq!(shelf_order(&words(&["timer", "bogus", "timer", "", "Media"])), words(&["timer", "media", "todo", "reminders", "mirror", "projects"]));
        assert_eq!(shelf_order(&[]), words(SHELF_WIDGETS));
        assert_eq!(shelf_hidden(&words(&["mirror", "mirror", "camera", "todo"])), words(&["mirror", "todo"]));
        assert_eq!(shelf_hidden(&[]), words(&[]));

        // All of it at once, as `save_settings` and `load` do.
        let said = Settings {
            theme: "neon".into(),
            reduce_motion: "on".into(),
            bot_theme: "lilac".into(),
            shelf_order: words(&["mirror", "nope"]),
            shelf_hidden: words(&["nope", "media"]),
            compact_metrics: words(&["disk", "cpu", "gpu"]),
            ..Settings::default()
        }
        .validated();
        assert_eq!(said.theme, "system");
        assert_eq!(said.reduce_motion, "on");
        assert_eq!(said.bot_theme, "lilac");
        assert_eq!(said.shelf_order[0], "mirror");
        assert_eq!(said.shelf_order.len(), SHELF_WIDGETS.len());
        assert_eq!(said.shelf_hidden, words(&["media"]));
        assert_eq!(said.compact_metrics, words(&["cpu", "gpu"]));
    }

    #[test]
    fn the_visibility_settings_default_and_are_held_to_their_choices() {
        // A file from before them: a minute, hide whatever the sessions do, stay out of full-screen apps.
        let old: Settings = serde_json::from_str(r#"{"soundEnabled":false,"compactMetrics":["ram"]}"#).unwrap();
        assert_eq!(old.folded_auto_hide, 60.0);
        assert!(!old.hide_only_when_idle);
        assert!(old.hide_in_fullscreen);
        let defaults = Settings::default();
        assert_eq!((defaults.folded_auto_hide, defaults.hide_only_when_idle, defaults.hide_in_fullscreen), (60.0, false, true));

        // Each choice is kept, "never" among them; anything else is a minute.
        for choice in FOLDED_AUTO_HIDE {
            assert_eq!(folded_auto_hide(*choice), *choice);
        }
        for said in [-1.0, 1.0, 7.5, 61.0, 3600.0, f64::NAN, f64::INFINITY] {
            assert_eq!(folded_auto_hide(said), 60.0, "{said}");
        }
        let said = Settings { folded_auto_hide: 12.0, hide_only_when_idle: true, hide_in_fullscreen: false, ..Settings::default() }.validated();
        assert_eq!((said.folded_auto_hide, said.hide_only_when_idle, said.hide_in_fullscreen), (60.0, true, false));

        // Written in camelCase, and read back as written.
        let never = Settings { folded_auto_hide: 0.0, hide_only_when_idle: true, hide_in_fullscreen: false, ..Settings::default() };
        let json = serde_json::to_string(&never).unwrap();
        for key in [r#""foldedAutoHide":0.0"#, r#""hideOnlyWhenIdle":true"#, r#""hideInFullscreen":false"#] {
            assert!(json.contains(key), "{key} in {json}");
        }
        let back = serde_json::from_str::<Settings>(&json).unwrap().validated();
        assert_eq!((back.folded_auto_hide, back.hide_only_when_idle, back.hide_in_fullscreen), (0.0, true, false));
        // A page that sends whole numbers is read too.
        assert_eq!(serde_json::from_str::<Settings>(r#"{"foldedAutoHide":10}"#).unwrap().folded_auto_hide, 10.0);
    }

    #[test]
    fn playful_reactions_are_on_unless_a_file_says_otherwise() {
        // A file from before the setting: on.
        let old: Settings = serde_json::from_str(r#"{"soundEnabled":false,"botTheme":"mint"}"#).unwrap();
        assert!(old.playful_reactions);
        assert!(Settings::default().playful_reactions);
        // Written in camelCase, kept through `validated`, and read back as written.
        let off = Settings { playful_reactions: false, ..Settings::default() }.validated();
        let json = serde_json::to_string(&off).unwrap();
        assert!(json.contains(r#""playfulReactions":false"#), "{json}");
        assert!(!serde_json::from_str::<Settings>(&json).unwrap().validated().playful_reactions);
    }

    #[test]
    fn the_dock_is_the_top_by_default_and_held_to_its_choices() {
        // A file from before docks: the top, as the island always was.
        let old: Settings = serde_json::from_str(r#"{"soundEnabled":false,"screen":"cursor"}"#).unwrap();
        assert_eq!(old.dock, "top");
        assert_eq!(old.dock(), crate::dock::Dock::Top);
        assert_eq!(Settings::default().dock, "top");
        for dock in crate::dock::DOCKS {
            let kept = Settings { dock: (*dock).into(), ..Settings::default() }.validated();
            assert_eq!(kept.dock, *dock);
        }
        for bad in ["", "Bottom", "middle", "bottom "] {
            assert_eq!(Settings { dock: bad.into(), ..Settings::default() }.validated().dock, "top", "{bad:?}");
        }
        // Written in camelCase, and read back as written.
        let json = serde_json::to_string(&Settings { dock: "bottom".into(), ..Settings::default() }.validated()).unwrap();
        assert!(json.contains(r#""dock":"bottom""#), "{json}");
        let back = serde_json::from_str::<Settings>(&json).unwrap().validated();
        assert_eq!(back.dock(), crate::dock::Dock::Bottom);
    }

    #[test]
    fn the_shortcut_is_saved_and_read_back() {
        let settings = Settings { expand_shortcut: "Ctrl+Shift+KeyK".into(), expand_shortcut_enabled: false, ..Settings::default() };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains(r#""expandShortcut":"Ctrl+Shift+KeyK""#));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.expand_shortcut, "Ctrl+Shift+KeyK");
        assert!(!back.expand_shortcut_enabled);
    }
}
