// Claude's usage limits — the 5-hour and the weekly one — as Claude Code
// tells its status line command, and the model each session runs on, told the
// same way.
//
// Nothing here asks anybody anything. The relay, installed as Claude Code's
// status line command (statusline.rs), forwards the numbers Claude Code already
// has; the latest are kept in memory, shown on the island, and gone when Nook
// closes. Nothing is written to disk, and nothing leaves this machine.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::log;

/// The name the relay gives the event (hook/src/statusline.rs).
pub const EVENT: &str = "StatusLine";
/// How far from now a window may say it resets and still be believed: an hour
/// ago at the earliest — Claude Code drops a window once it has reset — and no
/// later than a weekly window could, with room to spare.
const RESET_PAST_MS: u64 = 60 * 60 * 1000;
const RESET_AHEAD_MS: u64 = 35 * 24 * 60 * 60 * 1000;
/// Two reset times this close are of the same window.
const SAME_WINDOW_MS: u64 = 60 * 1000;
/// The longest a session id, a model's id or its name may be.
const MAX_ID: usize = 128;
const MAX_MODEL_NAME: usize = 64;

/// One window: how much of it is used, in percent, and when it resets (Unix ms).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub used_percent: f64,
    pub resets_at: u64,
}

/// The `usage` event, and what `usage_last` returns.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
    /// When Nook was told (Unix ms).
    pub updated_at: u64,
}

/// The model a session runs on: its id, and the name Claude Code shows for it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub display_name: String,
}

/// The `session_model` event.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionModel {
    pub session_id: String,
    pub model: Model,
    /// The size of its context window in tokens, when the status line said it.
    pub context_window: Option<u64>,
}

/// The latest usage Claude Code reported, kept for as long as Nook runs.
#[derive(Default)]
pub struct Latest(Mutex<Option<Usage>>);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// One window as the relay sent it, checked: a percentage that is a number,
/// held to 0–100, and a reset time — Unix seconds — that is near enough to now
/// to be one. Anything else is no window.
fn window_of(limits: &Value, name: &str, now: u64) -> Option<Window> {
    let window = limits.get(name)?;
    let used = window.get("used_percentage")?.as_f64().filter(|p| p.is_finite())?;
    let resets = window.get("resets_at")?.as_f64().filter(|s| s.is_finite() && *s > 0.0)?;
    let resets_at = (resets * 1000.0) as u64;
    let plausible = resets_at >= now.saturating_sub(RESET_PAST_MS) && resets_at <= now.saturating_add(RESET_AHEAD_MS);
    plausible.then_some(Window { used_percent: used.clamp(0.0, 100.0), resets_at })
}

/// What a `StatusLine` event says of the limits. None when it has no window
/// worth believing: what is known stays as it was.
pub fn usage_of(payload: &Value, now: u64) -> Option<Usage> {
    let limits = payload.get("rate_limits")?;
    let (five_hour, seven_day) = (window_of(limits, "five_hour", now), window_of(limits, "seven_day", now));
    (five_hour.is_some() || seven_day.is_some()).then_some(Usage { five_hour, seven_day, updated_at: now })
}

/// What a session told of a window, when it is news. Every session tells the
/// limits as of its own last answer, so an idle one tells old numbers: a window
/// that resets before the known one is over and is not believed, and within
/// one window the usage only grows. A known window whose reset has passed
/// gives way to whatever is told. None when what was told changes nothing.
fn newer(known: Option<Window>, told: Option<Window>, now: u64) -> Option<Window> {
    let told = told?;
    let Some(known) = known.filter(|k| k.resets_at > now) else { return Some(told) };
    if told.resets_at > known.resets_at.saturating_add(SAME_WINDOW_MS) {
        return Some(told);
    }
    let same = told.resets_at.saturating_add(SAME_WINDOW_MS) >= known.resets_at;
    (same && told.used_percent >= known.used_percent).then_some(told)
}

/// What is known once a session has told its limits: window by window, so one
/// that a session leaves out, or tells late, does not take away what another
/// session said. It is as new as the last time something told was believed.
pub fn merged(known: Option<Usage>, told: Usage) -> Usage {
    let Some(known) = known else { return told };
    let now = told.updated_at;
    let (five_hour, seven_day) = (newer(known.five_hour, told.five_hour, now), newer(known.seven_day, told.seven_day, now));
    Usage {
        five_hour: five_hour.or(known.five_hour),
        seven_day: seven_day.or(known.seven_day),
        updated_at: if five_hour.is_some() || seven_day.is_some() { now } else { known.updated_at },
    }
}

/// A short single line, or nothing.
fn short(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)).then(|| text.to_string())
}

/// What a `StatusLine` event says of its session's model. One of the two names
/// stands for the other when it came alone; with neither, or with no session
/// to say it of, there is nothing to tell.
pub fn model_of(payload: &Value) -> Option<SessionModel> {
    let session_id = short(payload.get("session_id"), MAX_ID)?;
    let model = payload.get("model")?;
    let (id, name) = (short(model.get("id"), MAX_ID), short(model.get("display_name"), MAX_MODEL_NAME));
    let model = match (id, name) {
        (Some(id), Some(display_name)) => Model { id, display_name },
        (Some(id), None) => Model { display_name: id.clone(), id },
        (None, Some(display_name)) => Model { id: display_name.clone(), display_name },
        (None, None) => return None,
    };
    // Believed as the relay checks it: a number, in a range a window can be in.
    let context_window = payload.get("context_window_size").and_then(Value::as_u64).filter(|n| (10_000..=100_000_000).contains(n));
    Some(SessionModel { session_id, model, context_window })
}

/// A `StatusLine` event from the relay: the limits are kept and shown, the
/// model is told to the island. It is not a hook event, and never reaches the
/// island's sessions as one. The log says that it happened, not what it said.
pub fn receive(app: &AppHandle, payload: &Value) {
    if let Some(told) = usage_of(payload, now_ms()) {
        let usage = {
            let state = app.state::<Latest>();
            let mut latest = state.0.lock().unwrap();
            let usage = merged(*latest, told);
            *latest = Some(usage);
            usage
        };
        log::line("usage updated");
        let _ = app.emit_to(WINDOW_LABEL, "usage", usage);
    }
    if let Some(model) = model_of(payload) {
        log::line("model updated");
        let _ = app.emit_to(WINDOW_LABEL, "session_model", model);
    }
}

/// The latest usage, if Claude Code has reported any since Nook started.
pub fn last(app: &AppHandle) -> Option<Usage> {
    *app.state::<Latest>().0.lock().unwrap()
}

/// The island has just booted: what is already known is told again, for a
/// page that was reloaded while Nook kept running.
pub fn tell_island(app: &AppHandle) {
    if let Some(usage) = last(app) {
        let _ = app.emit_to(WINDOW_LABEL, "usage", usage);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 2026-10-03T00:00:00Z, in ms and in s.
    const NOW: u64 = 1_790_985_600_000;
    const NOW_S: u64 = NOW / 1000;

    fn event(limits: Value) -> Value {
        json!({ "hook_event_name": "StatusLine", "session_id": "s", "rate_limits": limits })
    }

    #[test]
    fn the_two_windows_are_read_in_percent_and_milliseconds() {
        let usage = usage_of(
            &event(json!({
                "five_hour": { "used_percentage": 23.5, "resets_at": NOW_S + 3 * 3600 },
                "seven_day": { "used_percentage": 41, "resets_at": NOW_S + 4 * 86_400 },
            })),
            NOW,
        )
        .unwrap();
        assert_eq!(usage.five_hour, Some(Window { used_percent: 23.5, resets_at: NOW + 3 * 3_600_000 }));
        assert_eq!(usage.seven_day, Some(Window { used_percent: 41.0, resets_at: NOW + 4 * 86_400_000 }));
        assert_eq!(usage.updated_at, NOW);
        // As the island reads it.
        assert_eq!(
            serde_json::to_value(usage).unwrap(),
            json!({
                "fiveHour": { "usedPercent": 23.5, "resetsAt": NOW + 3 * 3_600_000 },
                "sevenDay": { "usedPercent": 41.0, "resetsAt": NOW + 4 * 86_400_000 },
                "updatedAt": NOW,
            })
        );
    }

    #[test]
    fn a_percentage_is_held_to_its_range_and_a_window_alone_is_enough() {
        let five = |used: Value| usage_of(&event(json!({ "five_hour": { "used_percentage": used, "resets_at": NOW_S + 60 } })), NOW);
        assert_eq!(five(json!(137.2)).unwrap().five_hour.unwrap().used_percent, 100.0);
        assert_eq!(five(json!(-4)).unwrap().five_hour.unwrap().used_percent, 0.0);
        let alone = five(json!(12)).unwrap();
        assert_eq!(alone.seven_day, None);
        assert_eq!(serde_json::to_value(alone).unwrap()["sevenDay"], Value::Null);
        // Not a number: no window, and with no window nothing changes.
        assert_eq!(five(json!("12")), None);
        assert_eq!(five(json!(null)), None);
    }

    #[test]
    fn a_reset_time_that_cannot_be_one_drops_its_window() {
        let at = |resets: Value| usage_of(&event(json!({ "five_hour": { "used_percentage": 10, "resets_at": resets } })), NOW);
        assert!(at(json!(NOW_S + 5 * 3600)).is_some());
        // Just passed: Claude Code may not have dropped it yet.
        assert!(at(json!(NOW_S - 60)).is_some());
        // Long gone, far too far ahead, milliseconds taken for seconds, zero, text.
        assert_eq!(at(json!(NOW_S - 2 * 3600)), None);
        assert_eq!(at(json!(NOW_S + 60 * 86_400)), None);
        assert_eq!(at(json!(NOW)), None);
        assert_eq!(at(json!(0)), None);
        assert_eq!(at(json!("soon")), None);
        // One window wrong, the other right: the right one is kept.
        let mixed = usage_of(
            &event(json!({
                "five_hour": { "used_percentage": 10, "resets_at": 0 },
                "seven_day": { "used_percentage": 20, "resets_at": NOW_S + 86_400 },
            })),
            NOW,
        )
        .unwrap();
        assert_eq!((mixed.five_hour, mixed.seven_day.map(|w| w.used_percent)), (None, Some(20.0)));
        // No limits at all.
        assert_eq!(usage_of(&json!({ "hook_event_name": "StatusLine" }), NOW), None);
        assert_eq!(usage_of(&event(json!("none")), NOW), None);
    }

    #[test]
    fn an_idle_sessions_old_numbers_do_not_replace_newer_ones() {
        let win = |used: f64, resets_in_h: u64| Some(Window { used_percent: used, resets_at: NOW + resets_in_h * 3_600_000 });
        let known = Usage { five_hour: win(40.0, 3), seven_day: win(20.0, 96), updated_at: NOW - 1000 };
        let told = |five_hour, seven_day| merged(Some(known), Usage { five_hour, seven_day, updated_at: NOW });
        // Nothing known yet: what is told is it.
        assert_eq!(merged(None, known), known);
        // The same windows, further on: believed, and as new as now.
        assert_eq!(told(win(45.0, 3), win(21.0, 96)), Usage { five_hour: win(45.0, 3), seven_day: win(21.0, 96), updated_at: NOW });
        // A window left out stays as it was known.
        assert_eq!(told(None, win(21.0, 96)).five_hour, win(40.0, 3));
        assert_eq!(told(win(45.0, 3), None).seven_day, win(20.0, 96));
        // An idle session: less used in the same window, or a window that is already over. Nothing changes.
        assert_eq!(told(win(12.0, 3), win(20.0, 96)).five_hour, win(40.0, 3));
        assert_eq!(told(Some(Window { used_percent: 90.0, resets_at: NOW - 60_000 }), None), known);
        // The next window has started: it is the one, whatever it has used.
        assert_eq!(told(win(2.0, 5), None).five_hour, win(2.0, 5));
        // A known window whose reset has passed gives way to anything.
        let over = Usage { five_hour: Some(Window { used_percent: 80.0, resets_at: NOW - 1 }), seven_day: None, updated_at: NOW - 1000 };
        assert_eq!(merged(Some(over), Usage { five_hour: win(1.0, 5), seven_day: None, updated_at: NOW }).five_hour, win(1.0, 5));
    }

    #[test]
    fn a_sessions_model_is_two_short_names_or_nothing() {
        let said = |session: Value, model: Value| model_of(&json!({ "hook_event_name": "StatusLine", "session_id": session, "model": model }));
        let both = said(json!("s1"), json!({ "id": "claude-opus-5-5", "display_name": "Opus" })).unwrap();
        assert_eq!(
            serde_json::to_value(&both).unwrap(),
            json!({ "sessionId": "s1", "model": { "id": "claude-opus-5-5", "displayName": "Opus" }, "contextWindow": null })
        );
        let sized = model_of(&json!({ "session_id": "s1", "model": { "id": "m" }, "context_window_size": 1_000_000 })).unwrap();
        assert_eq!(sized.context_window, Some(1_000_000));
        assert_eq!(model_of(&json!({ "session_id": "s1", "model": { "id": "m" }, "context_window_size": 7 })).unwrap().context_window, None);
        // One name stands for the other.
        assert_eq!(said(json!("s1"), json!({ "id": "claude-opus-5-5" })).unwrap().model.display_name, "claude-opus-5-5");
        assert_eq!(said(json!("s1"), json!({ "display_name": "Opus" })).unwrap().model.id, "Opus");
        // No session, no model, or names that are not names.
        assert_eq!(said(json!(null), json!({ "id": "claude-opus-5-5" })), None);
        assert_eq!(said(json!("s1"), json!({})), None);
        assert_eq!(said(json!("s1"), json!("claude-opus-5-5")), None);
        assert_eq!(said(json!("s1"), json!({ "id": "x".repeat(MAX_ID + 1), "display_name": "two\nlines" })), None);
        assert_eq!(model_of(&event(json!({}))), None);
    }
}
