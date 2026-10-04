// Cursor's agent, as the island knows sessions.
//
// `nook-hook --agent cursor <event>` reads one of Cursor's hook payloads
// (~/.cursor/hooks.json) and rewrites it in the shape of the Claude Code event
// it corresponds to, so everything after — the cuts, the diff, the host
// lookup — is the one path every event takes. What leaves here says
// `nook_tool: "cursor"`, and its session id is `cursor:<conversation_id>`:
// the two tools' ids can never meet.
//
// Status only. Nook subscribes to events that cannot change what Cursor does
// (none of the before* gates but beforeSubmitPrompt, whose empty output means
// "continue"), and this relay prints nothing at all, whatever happens.

use serde_json::{json, Value};

use super::{clip, MAX_LAST_MESSAGE, MAX_MODEL_ID};

/// The tool name every event of this relay's carries to the app.
pub const TOOL: &str = "cursor";
/// Shown before the conversation's id, so ids of two tools never collide.
const ID_PREFIX: &str = "cursor:";
const MAX_ID: usize = 96;
const MAX_THOUGHT: usize = 240;
const MAX_NOTE: usize = 300;

/// Tools whose own after* event says more (the command and what it printed,
/// the edit, the MCP call): their postToolUse would be a second step.
const COVERED: &[&str] = &[
    "shell", "bash", "run_terminal_cmd", "terminal", "write", "edit", "strreplace", "str_replace",
    "search_replace", "edit_file", "multiedit", "applypatch", "apply_patch",
];

fn text<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// `/c:/Users/me/app` (a file URL's path) as `c:/Users/me/app`.
fn plain_path(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'/' && bytes[2] == b':' && bytes[1].is_ascii_alphabetic() {
        path[1..].to_string()
    } else {
        path.to_string()
    }
}

fn workspace(payload: &Value) -> Option<String> {
    let root = payload
        .get("workspace_roots")
        .and_then(Value::as_array)
        .and_then(|roots| roots.iter().find_map(|r| r.as_str().map(str::trim).filter(|s| !s.is_empty())))
        .map(str::to_string)
        .or_else(|| std::env::var("CURSOR_PROJECT_DIR").ok().filter(|s| !s.is_empty()))?;
    Some(plain_path(&root))
}

/// What Cursor calls a tool, as Claude Code does where there is a match.
fn tool_name(raw: &str) -> String {
    match raw.to_ascii_lowercase().as_str() {
        "read" | "read_file" | "readfile" => "Read".into(),
        "grep" | "codebase_search" | "semanticsearch" => "Grep".into(),
        "glob" | "list_dir" | "listdir" | "ls" | "file_search" => "Glob".into(),
        "websearch" | "web_search" => "WebSearch".into(),
        "webfetch" | "web_fetch" => "WebFetch".into(),
        _ => raw.to_string(),
    }
}

/// The edits Cursor reports as the hunks of a Claude Code Edit response. A
/// file Cursor has not shown a line number for starts at line 1.
fn edit_response(edits: &[Value]) -> Value {
    let mut hunks = Vec::new();
    for edit in edits.iter().take(12) {
        let old = edit.get("old_string").and_then(Value::as_str).unwrap_or_default().replace("\r\n", "\n");
        let new = edit.get("new_string").and_then(Value::as_str).unwrap_or_default().replace("\r\n", "\n");
        let (old_lines, new_lines): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
        let mut lines: Vec<String> = old_lines.iter().map(|l| format!("-{l}")).collect();
        lines.extend(new_lines.iter().map(|l| format!("+{l}")));
        hunks.push(json!({
            "oldStart": if old_lines.is_empty() { 0 } else { 1 }, "oldLines": old_lines.len(),
            "newStart": if new_lines.is_empty() { 0 } else { 1 }, "newLines": new_lines.len(),
            "lines": lines,
        }));
    }
    json!({ "structuredPatch": hunks })
}

/// Cursor's payload as the Claude-shaped event Nook knows. None for an event
/// Nook does not follow, or one with no conversation to put it under.
pub fn translate(payload: &Value, arg_event: &str) -> Option<Value> {
    let event = text(payload, "hook_event_name").unwrap_or(arg_event);
    let conversation = text(payload, "conversation_id").or_else(|| text(payload, "session_id"))?;
    let mut out = json!({
        "session_id": format!("{ID_PREFIX}{}", clip(conversation, MAX_ID)),
        "nook_tool": TOOL,
    });
    if let Some(cwd) = workspace(payload) {
        out["cwd"] = json!(cwd);
    }
    if let Some(model) = text(payload, "model") {
        out["model"] = json!(clip(model, MAX_MODEL_ID));
    }
    let set = |out: &mut Value, name: &str| out["hook_event_name"] = json!(name);

    match event {
        "sessionStart" => set(&mut out, "SessionStart"),
        // A chat that finishes ends with `stop`; only the window going away is the end of the session.
        "sessionEnd" => match text(payload, "reason") {
            Some("window_close" | "user_close") => set(&mut out, "SessionEnd"),
            _ => return None,
        },
        "beforeSubmitPrompt" => {
            set(&mut out, "UserPromptSubmit");
            out["prompt"] = json!(clip(text(payload, "prompt")?, MAX_LAST_MESSAGE));
        }
        "postToolUse" | "postToolUseFailure" => {
            let raw = text(payload, "tool_name")?;
            let lower = raw.to_ascii_lowercase();
            let failed = event == "postToolUseFailure";
            if !failed && (COVERED.contains(&lower.as_str()) || lower.starts_with("mcp")) {
                return None;
            }
            set(&mut out, if failed { "PostToolUseFailure" } else { "PostToolUse" });
            out["tool_name"] = json!(tool_name(raw));
            if let Some(input) = payload.get("tool_input").filter(|v| v.is_object()) {
                out["tool_input"] = input.clone();
            }
            if failed {
                out["error"] = json!(clip(text(payload, "error_message").unwrap_or("The tool failed"), MAX_NOTE));
            }
        }
        "afterShellExecution" => {
            set(&mut out, "PostToolUse");
            out["tool_name"] = json!("Bash");
            out["tool_input"] = json!({ "command": text(payload, "command")? });
            out["tool_response"] = json!({ "stdout": payload.get("output").and_then(Value::as_str).unwrap_or_default() });
        }
        "afterFileEdit" => {
            let edits = payload.get("edits").and_then(Value::as_array).cloned().unwrap_or_default();
            let created = edits.len() == 1
                && edits[0].get("old_string").and_then(Value::as_str).is_none_or(str::is_empty)
                && edits[0].get("new_string").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
            set(&mut out, "PostToolUse");
            out["tool_name"] = json!(if created { "Write" } else { "Edit" });
            out["tool_input"] = json!({ "file_path": plain_path(text(payload, "file_path")?) });
            out["tool_response"] = if created {
                json!({ "type": "create", "content": edits[0]["new_string"] })
            } else {
                edit_response(&edits)
            };
        }
        "afterMCPExecution" => {
            set(&mut out, "PostToolUse");
            let server = text(payload, "mcp_server_name").unwrap_or("mcp");
            let tool = text(payload, "tool_name")?;
            out["tool_name"] = json!(format!("mcp__{server}__{tool}"));
            if let Some(input) = payload.get("tool_input").filter(|v| v.is_object()) {
                out["tool_input"] = input.clone();
            }
        }
        // What Cursor said, and what it thought: events of their own, which the
        // island turns into a "Cursor said" line and a thought.
        "afterAgentResponse" => {
            set(&mut out, "AgentMessage");
            out["last_message"] = json!(clip(text(payload, "text")?, MAX_LAST_MESSAGE));
        }
        "afterAgentThought" => {
            set(&mut out, "AgentThought");
            out["message"] = json!(clip(text(payload, "text")?, MAX_THOUGHT));
        }
        "subagentStop" => {
            set(&mut out, "AgentNote");
            let kind = text(payload, "subagent_type").unwrap_or("agent");
            let mut note = format!("Subagent {kind} {}", text(payload, "status").unwrap_or("finished"));
            if let Some(summary) = text(payload, "summary") {
                note.push_str(" — ");
                note.push_str(&clip(summary, MAX_NOTE));
            }
            out["message"] = json!(note);
        }
        "preCompact" => {
            set(&mut out, "AgentNote");
            out["message"] = json!("Compacting the conversation");
        }
        "stop" => match text(payload, "status") {
            Some("error") => set(&mut out, "StopFailure"),
            status => {
                set(&mut out, "Stop");
                if status == Some("aborted") {
                    out["message"] = json!("Stopped");
                }
            }
        },
        _ => return None,
    }
    Some(out)
}

/// Whether Cursor loaded a Claude Code hook: it hands its own environment to
/// the hooks it runs, Claude's included.
pub fn runs_in_cursor() -> bool {
    ["CURSOR_VERSION", "CURSOR_PROJECT_DIR"].iter().any(|var| std::env::var_os(var).is_some_and(|v| !v.is_empty()))
}

/// Whether `~/.cursor/hooks.json` has Nook's own entries, which then tell the
/// app everything the Claude hooks would say a second time.
fn native_hooks_installed() -> bool {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let Some(home) = home else { return false };
    let path = std::path::Path::new(&home).join(".cursor").join("hooks.json");
    std::fs::read_to_string(path).is_ok_and(|text| text.contains("nook-hook") && text.contains("--agent cursor"))
}

/// An event of Claude Code's own hooks that Cursor ran (it loads them from
/// ~/.claude/settings.json). With Nook's Cursor hooks installed it is dropped,
/// so a conversation is never shown twice; without them it is tagged as
/// Cursor's, under the id the native hooks would have used. A permission
/// request is never taken: Cursor sessions have no approval cards.
pub fn from_claude_hooks(payload: &mut Value) -> bool {
    let event = payload.get("hook_event_name").and_then(Value::as_str).unwrap_or_default();
    if event == "PermissionRequest" || native_hooks_installed() {
        return false;
    }
    let Some(map) = payload.as_object_mut() else { return false };
    if let Some(id) = map.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| format!("{ID_PREFIX}{}", clip(s, MAX_ID))) {
        map.insert("session_id".into(), json!(id));
    }
    map.insert("nook_tool".into(), json!(TOOL));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(event: &str) -> Value {
        json!({
            "hook_event_name": event, "conversation_id": "c-1", "generation_id": "g-1",
            "workspace_roots": ["/c:/work/app"], "model": "gpt-5", "user_email": "me@example.com",
        })
    }
    fn with(event: &str, extra: Value) -> Value {
        let mut payload = base(event);
        for (k, v) in extra.as_object().unwrap() {
            payload[k] = v.clone();
        }
        payload
    }
    fn go(event: &str, extra: Value) -> Option<Value> {
        translate(&with(event, extra), "")
    }

    #[test]
    fn every_event_carries_the_conversation_the_folder_and_the_tool() {
        let out = go("sessionStart", json!({ "is_background_agent": false })).unwrap();
        assert_eq!(out["hook_event_name"], "SessionStart");
        assert_eq!(out["session_id"], "cursor:c-1");
        assert_eq!(out["cwd"], "c:/work/app");
        assert_eq!(out["nook_tool"], "cursor");
        assert_eq!(out["model"], "gpt-5");
        // Nothing else of Cursor's payload goes on.
        assert!(out.get("user_email").is_none() && out.get("generation_id").is_none());
        assert!(translate(&json!({ "hook_event_name": "sessionStart" }), "").is_none());
    }

    #[test]
    fn a_prompt_starts_a_turn() {
        let out = go("beforeSubmitPrompt", json!({ "prompt": "fix the build", "attachments": [] })).unwrap();
        assert_eq!(out["hook_event_name"], "UserPromptSubmit");
        assert_eq!(out["prompt"], "fix the build");
        assert!(go("beforeSubmitPrompt", json!({ "prompt": " " })).is_none());
    }

    #[test]
    fn a_shell_command_is_a_bash_step_with_what_it_printed() {
        let out = go("afterShellExecution", json!({ "command": "npm test", "output": "ok\n", "duration": 1200 })).unwrap();
        assert_eq!(out["hook_event_name"], "PostToolUse");
        assert_eq!(out["tool_name"], "Bash");
        assert_eq!(out["tool_input"]["command"], "npm test");
        let shown = crate::result_of("Bash", &out["tool_response"]).unwrap();
        assert_eq!(shown["text"], "ok");
    }

    #[test]
    fn a_file_edit_becomes_a_diff() {
        let out = go("afterFileEdit", json!({ "file_path": "/c:/work/app/a.ts", "edits": [{ "old_string": "a\nb", "new_string": "a\nc\nd" }] })).unwrap();
        assert_eq!(out["tool_name"], "Edit");
        assert_eq!(out["tool_input"]["file_path"], "c:/work/app/a.ts");
        let change = crate::change_of(&out["tool_response"]).unwrap();
        assert_eq!((change["additions"].as_u64(), change["deletions"].as_u64()), (Some(3), Some(2)));
        // A file written new has nothing before it.
        let new = go("afterFileEdit", json!({ "file_path": "n.ts", "edits": [{ "old_string": "", "new_string": "x\ny" }] })).unwrap();
        assert_eq!(new["tool_name"], "Write");
        let change = crate::change_of(&new["tool_response"]).unwrap();
        assert_eq!(change["created"], true);
        assert_eq!(change["additions"], 2);
    }

    #[test]
    fn an_mcp_call_is_named_like_claudes() {
        let out = go("afterMCPExecution", json!({ "tool_name": "search", "mcp_server_name": "docs", "tool_input": { "q": "x" }, "result_json": "{}", "duration": 3 })).unwrap();
        assert_eq!(out["tool_name"], "mcp__docs__search");
        assert_eq!(out["tool_input"]["q"], "x");
    }

    #[test]
    fn other_tools_come_through_but_the_ones_with_their_own_event_do_not() {
        let read = go("postToolUse", json!({ "tool_name": "Read", "tool_input": { "file_path": "a.ts" }, "tool_output": "..." })).unwrap();
        assert_eq!((read["hook_event_name"].as_str(), read["tool_name"].as_str()), (Some("PostToolUse"), Some("Read")));
        assert!(read.get("tool_output").is_none());
        for covered in ["Shell", "Write", "StrReplace", "MCP:docs"] {
            assert!(go("postToolUse", json!({ "tool_name": covered })).is_none(), "{covered}");
        }
        let failed = go("postToolUseFailure", json!({ "tool_name": "Shell", "error_message": "timed out", "failure_type": "timeout" })).unwrap();
        assert_eq!(failed["hook_event_name"], "PostToolUseFailure");
        assert_eq!(failed["error"], "timed out");
    }

    #[test]
    fn what_cursor_said_and_thought_are_events_of_their_own() {
        let said = go("afterAgentResponse", json!({ "text": "Done." })).unwrap();
        assert_eq!((said["hook_event_name"].as_str(), said["last_message"].as_str()), (Some("AgentMessage"), Some("Done.")));
        let thought = go("afterAgentThought", json!({ "text": "Let me look", "duration_ms": 10 })).unwrap();
        assert_eq!(thought["hook_event_name"], "AgentThought");
        assert_eq!(thought["message"], "Let me look");
    }

    #[test]
    fn a_subagent_and_a_compaction_are_notes() {
        let sub = go("subagentStop", json!({ "subagent_type": "explore", "status": "completed", "summary": "Found 3 files" })).unwrap();
        assert_eq!(sub["hook_event_name"], "AgentNote");
        assert_eq!(sub["message"], "Subagent explore completed — Found 3 files");
        assert_eq!(go("preCompact", json!({ "trigger": "auto" })).unwrap()["hook_event_name"], "AgentNote");
    }

    #[test]
    fn stop_maps_its_status() {
        assert_eq!(go("stop", json!({ "status": "completed", "loop_count": 0 })).unwrap()["hook_event_name"], "Stop");
        let aborted = go("stop", json!({ "status": "aborted" })).unwrap();
        assert_eq!((aborted["hook_event_name"].as_str(), aborted["message"].as_str()), (Some("Stop"), Some("Stopped")));
        assert_eq!(go("stop", json!({ "status": "error" })).unwrap()["hook_event_name"], "StopFailure");
    }

    #[test]
    fn only_the_window_going_away_ends_the_session() {
        assert_eq!(go("sessionEnd", json!({ "session_id": "c-1", "reason": "window_close" })).unwrap()["hook_event_name"], "SessionEnd");
        assert!(go("sessionEnd", json!({ "reason": "completed" })).is_none());
    }

    #[test]
    fn gating_events_are_never_followed() {
        for event in ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "preToolUse", "subagentStart"] {
            assert!(go(event, json!({ "command": "rm", "tool_name": "x" })).is_none(), "{event}");
        }
    }

    #[test]
    fn a_translated_event_goes_through_the_common_path() {
        let out = go("afterFileEdit", json!({ "file_path": "a.ts", "edits": [{ "old_string": "a", "new_string": "b" }] })).unwrap();
        let event = crate::event_of(out, String::new(), String::new()).unwrap();
        let sent: Value = serde_json::from_str(&event.line).unwrap();
        assert_eq!(sent["session_id"], "cursor:c-1");
        assert_eq!(sent["nook_tool"], "cursor");
        assert_eq!(sent["change"]["additions"], 1);
        assert!(sent.get("nook_agent").is_none());
    }

    #[test]
    fn a_claude_hook_run_by_cursor_is_tagged_and_never_asks() {
        let mut ask = json!({ "hook_event_name": "PermissionRequest", "session_id": "s" });
        assert!(!from_claude_hooks(&mut ask));
        let mut tool = json!({ "hook_event_name": "PostToolUse", "session_id": "s" });
        // With no hooks.json of Nook's in this home, the event is Cursor's, under the same id the native hooks use.
        if !native_hooks_installed() {
            assert!(from_claude_hooks(&mut tool));
            assert_eq!(tool["session_id"], "cursor:s");
            assert_eq!(tool["nook_tool"], "cursor");
        }
    }
}
