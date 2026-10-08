// Codex, as the island knows sessions.
//
// `nook-hook --agent codex` reads one of Codex's hook payloads
// (~/.codex/hooks.json). Codex's hooks are made after Claude Code's — the same
// event names, the same fields — so the payload goes on as it came, through the
// one path every event takes. What leaves here says `nook_tool: "codex"`, and
// its session id is `codex:<session_id>`: the two tools' ids can never meet.
//
// A permission request is answered as Claude Code's is (`hookSpecificOutput`,
// which Codex documents), and only after a click: with none, nothing is
// printed and Codex asks as it always does.

use serde_json::{json, Value};

use super::clip;

/// The tool name every event of this relay's carries to the app.
pub const TOOL: &str = "codex";
/// Shown before the session's id, so ids of two tools never collide.
const ID_PREFIX: &str = "codex:";
const MAX_ID: usize = 96;
/// The events Nook follows (src-tauri/src/codex_hooks.rs installs these and no other).
const EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];

fn text<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// Codex's payload as the event Nook knows. None for an event Nook does not
/// follow, or one with no session to put it under.
pub fn translate(payload: &Value, arg_event: &str) -> Option<Value> {
    let event = text(payload, "hook_event_name").unwrap_or(arg_event);
    if !EVENTS.contains(&event) {
        return None;
    }
    let session = text(payload, "session_id")?;
    let mut out = payload.as_object()?.clone();
    out.insert("hook_event_name".into(), json!(event));
    out.insert("session_id".into(), json!(format!("{ID_PREFIX}{}", clip(session, MAX_ID))));
    out.insert("nook_tool".into(), json!(TOOL));
    // Codex's transcript is written its own way: nothing of Claude Code's is to be read in it.
    out.remove("transcript_path");
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(event: &str) -> Value {
        json!({
            "hook_event_name": event, "session_id": "s-1", "turn_id": "t-1", "cwd": "C:\\work\\app",
            "model": "gpt-5", "permission_mode": "default", "transcript_path": "C:\\Users\\me\\.codex\\sessions\\r.jsonl",
        })
    }
    fn with(event: &str, extra: Value) -> Value {
        let mut payload = base(event);
        for (k, v) in extra.as_object().unwrap() {
            payload[k] = v.clone();
        }
        payload
    }

    #[test]
    fn every_event_carries_the_session_and_the_tool_and_no_transcript() {
        let out = translate(&base("SessionStart"), "").unwrap();
        assert_eq!(out["hook_event_name"], "SessionStart");
        assert_eq!(out["session_id"], "codex:s-1");
        assert_eq!(out["nook_tool"], "codex");
        assert_eq!(out["cwd"], "C:\\work\\app");
        assert_eq!(out["model"], "gpt-5");
        assert!(out.get("transcript_path").is_none());
        // No session to put it under, or the event named on the command line only.
        assert!(translate(&json!({ "hook_event_name": "Stop" }), "").is_none());
        assert_eq!(translate(&json!({ "session_id": "s" }), "Stop").unwrap()["hook_event_name"], "Stop");
    }

    #[test]
    fn an_event_nook_does_not_follow_goes_nowhere() {
        for event in ["PreCompact", "PostCompact", "somethingNew", ""] {
            assert!(translate(&base(event), "").is_none(), "{event}");
        }
    }

    #[test]
    fn a_permission_request_goes_through_the_common_path_with_what_it_asks() {
        let asked = with("PermissionRequest", json!({ "tool_name": "Bash", "tool_input": { "command": "npm test", "description": "Run the tests" } }));
        let event = crate::event_of(translate(&asked, "").unwrap(), String::new(), String::new()).unwrap();
        assert_eq!(event.name, "PermissionRequest");
        let sent: Value = serde_json::from_str(&event.line).unwrap();
        assert_eq!(sent["session_id"], "codex:s-1");
        assert_eq!(sent["nook_tool"], "codex");
        assert_eq!(sent["tool_input"]["command"], "npm test");
        // Claude Code's session path, not an agent pill's.
        assert!(sent.get("nook_agent").is_none());
        // And the answer is the one Claude Code reads, which Codex documents.
        assert!(crate::reply_json("allow", None).unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn a_turn_ends_on_what_codex_said() {
        let stop = with("Stop", json!({ "stop_hook_active": false, "last_assistant_message": " Done. " }));
        let event = crate::event_of(translate(&stop, "").unwrap(), String::new(), String::new()).unwrap();
        let sent: Value = serde_json::from_str(&event.line).unwrap();
        assert_eq!(sent["last_message"], "Done.");
        assert!(sent.get("session_title").is_none() && sent.get("context_tokens").is_none());
    }
}
