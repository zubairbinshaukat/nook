// Cursor hook installation: ~/.cursor/hooks.json.
//
// The same rule as for Claude Code (hooks.rs, whose one way of changing a file
// this uses): the diff first, a dated backup, an explicit click, and only
// Nook's own entries are ever added, replaced or removed.
//
// Status only. Nook subscribes to the events that cannot change what Cursor
// does — never to the before* gates (beforeShellExecution, beforeMCPExecution,
// beforeReadFile, preToolUse, subagentStart) that can allow, deny or hold a
// call — and its relay prints nothing at all for them (hook/src/cursor.rs).
// beforeSubmitPrompt is the one before* event that is followed: empty output
// means "continue" (Cursor's docs), so it can neither block nor edit a prompt.
//
// A Nook entry is `{ "command": "<relay> --agent cursor <event>", "timeout": 5 }`:
// Cursor's hooks.json has no exec form, so the command is one string, and it is
// refused unless it has nothing to quote (cmd, PowerShell and sh all read it alike).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::hooks::{self, FileChange, HookPreview};
use crate::{platform, settings};

/// Every event Nook follows, with the hook's timeout in seconds. All of them
/// are observational.
pub const EVENTS: &[(&str, u64)] = &[
    ("sessionStart", 5),
    ("sessionEnd", 5),
    ("beforeSubmitPrompt", 5),
    ("postToolUse", 5),
    ("postToolUseFailure", 5),
    ("afterShellExecution", 5),
    ("afterFileEdit", 5),
    ("afterMCPExecution", 5),
    ("afterAgentResponse", 5),
    ("afterAgentThought", 5),
    ("subagentStop", 5),
    ("preCompact", 5),
    ("stop", 5),
];

/// What `hooks.json` has when Nook creates it.
const VERSION: u64 = 1;
const MODE: &str = "--agent cursor";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorStatus {
    /// Every event has an entry of Nook's.
    pub installed: bool,
    /// ... and every one is what Nook would write now (the relay has not moved).
    pub current: bool,
    /// hooks.json is there.
    pub file_exists: bool,
    /// `~/.cursor` is there: Cursor has been run on this account.
    pub cursor_found: bool,
    pub hooks_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
    /// Why Nook will not write its command (a path with a space in it), if so.
    pub refused: Option<String>,
    /// hooks.json is there but cannot be read as plain JSON: said, never written over.
    pub unreadable: Option<String>,
}

pub fn hooks_path() -> PathBuf {
    platform::home_dir().join(".cursor").join("hooks.json")
}

fn relay_path() -> String {
    let path = settings::hook_exe_path().to_string_lossy().to_string();
    if cfg!(windows) { path.replace('\\', "/") } else { path }
}

/// The relay as the first word of a command that cmd, PowerShell and sh read alike:
/// nothing but letters, digits and `_ - . / :`.
fn relay_word(relay: &str) -> Result<String, String> {
    let plain = !relay.is_empty() && relay.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'));
    if plain {
        Ok(relay.to_string())
    } else {
        Err(format!(
            "The relay's path ({relay}) has a space or a special character in it. Cursor runs hook commands through a shell that may not read such a path, so Nook won't write one. Nothing was changed."
        ))
    }
}

fn command_for(relay: &str, event: &str) -> String {
    format!("{relay} {MODE} {event}")
}

/// An entry of Nook's: its command runs the relay in Cursor mode.
fn is_ours(entry: &Value) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(hooks::MARKER) && command.contains(MODE))
}

/// hooks.json as a JSON object: absent or blank is nothing, a BOM is let by,
/// and comments, trailing commas or anything not an object are refused.
fn parse(bytes: &[u8], path: &str) -> Result<Value, String> {
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} isn't a JSON object — Nook won't touch it.")),
        Err(err) => Err(format!(
            "{path} isn't plain JSON ({err}). Nook can't read comments or trailing commas, and won't overwrite the file: remove them (or move the file), then try again."
        )),
    }
}

/// hooks.json with Nook's entries added or replaced; everything else — other
/// tools' entries, unknown keys, the order of both — is as it was.
fn installed(existing: &Value, relay: &str) -> Result<Value, String> {
    let relay = relay_word(relay)?;
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = match root.get("hooks") {
        None => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err("The \"hooks\" key of hooks.json isn't an object — Nook won't touch it.".into()),
    };
    for (event, timeout) in EVENTS {
        let mut list = match hooks.get(*event) {
            None => Vec::new(),
            Some(Value::Array(list)) => list.clone(),
            Some(_) => return Err(format!("The \"{event}\" hooks of hooks.json aren't a list — Nook won't touch them.")),
        };
        list.retain(|entry| !is_ours(entry));
        list.push(json!({ "command": command_for(&relay, event), "timeout": timeout }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
    root.entry("version").or_insert(json!(VERSION));
    root.insert("hooks".into(), Value::Object(hooks));
    Ok(Value::Object(root))
}

/// hooks.json with every entry of Nook's removed and nothing else changed. A
/// file left with no hook of anyone's keeps its other keys (and its version).
fn uninstalled(existing: &Value) -> Result<Value, String> {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks") else { return Ok(Value::Object(root)) };
    let Value::Object(hooks) = hooks else {
        return Err("The \"hooks\" key of hooks.json isn't an object — Nook won't touch it.".into());
    };
    let mut kept = Map::new();
    for (event, value) in hooks {
        match value {
            Value::Array(list) => {
                let rest: Vec<Value> = list.iter().filter(|e| !is_ours(e)).cloned().collect();
                // A list that was empty before is left as it was; one that held only Nook's goes.
                if !rest.is_empty() || list.is_empty() {
                    kept.insert(event.clone(), Value::Array(rest));
                }
            }
            other => {
                kept.insert(event.clone(), other.clone());
            }
        }
    }
    root.insert("hooks".into(), Value::Object(kept));
    Ok(Value::Object(root))
}

fn status_of(existing: &Value, relay: &str) -> (bool, bool) {
    let Some(hooks) = existing.get("hooks").and_then(Value::as_object) else { return (false, false) };
    let ours = |event: &str| -> Vec<&Value> {
        hooks.get(event).and_then(Value::as_array).map(|l| l.iter().filter(|e| is_ours(e)).collect()).unwrap_or_default()
    };
    let installed = EVENTS.iter().all(|(event, _)| !ours(event).is_empty());
    let current = installed
        && EVENTS.iter().all(|(event, _)| {
            let want = command_for(relay, event);
            ours(event).iter().all(|e| e.get("command").and_then(Value::as_str) == Some(want.as_str()))
        });
    (installed, current)
}

pub fn status() -> CursorStatus {
    let path = hooks_path();
    let relay = relay_path();
    let (existing, unreadable) = match std::fs::read(&path) {
        Ok(bytes) => match parse(&bytes, &path.display().to_string()) {
            Ok(v) => (v, None),
            Err(why) => (json!({}), Some(why)),
        },
        Err(_) => (json!({}), None),
    };
    let (installed, current) = status_of(&existing, &relay);
    let hook = settings::hook_exe_path();
    CursorStatus {
        installed,
        current,
        file_exists: path.exists(),
        cursor_found: path.parent().is_some_and(Path::exists),
        hooks_path: path.to_string_lossy().to_string(),
        hook_ready: hook.exists(),
        hook_path: hook.to_string_lossy().to_string(),
        refused: relay_word(&relay).err(),
        unreadable,
    }
}

fn change(install: bool, relay: String) -> impl Fn(&Path, Option<&[u8]>) -> Result<FileChange, String> {
    move |path, bytes| {
        let current = match bytes {
            Some(bytes) => parse(bytes, &path.display().to_string())?,
            None => json!({}),
        };
        let next = if install { installed(&current, &relay)? } else { uninstalled(&current)? };
        let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
        let after = pretty(&next);
        let mut written = after.clone().into_bytes();
        written.push(b'\n');
        Ok(FileChange { before: if bytes.is_some() { pretty(&current) } else { String::new() }, after, bytes: written })
    }
}

pub fn preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview_file(&hooks_path(), change(install, relay_path()))
}

pub fn apply(install: bool, fingerprint: &str) -> Result<String, String> {
    hooks::write_file(&hooks_path(), fingerprint, change(install, relay_path()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY: &str = "C:/Users/me/AppData/Local/Nook/bin/nook-hook.exe";

    fn foreign() -> Value {
        json!({
            "version": 1,
            "futureKey": { "keep": [1, 2] },
            "hooks": {
                "stop": [{ "command": "./hooks/theirs.sh", "timeout": 30 }],
                "beforeShellExecution": [{ "command": "./hooks/guard.sh", "failClosed": true, "matcher": "rm" }],
            },
        })
    }

    fn commands(v: &Value, event: &str) -> Vec<String> {
        v["hooks"][event].as_array().unwrap().iter().map(|e| e["command"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn a_missing_file_is_created_with_a_version_and_every_event() {
        let out = installed(&json!({}), RELAY).unwrap();
        assert_eq!(out["version"], 1);
        for (event, _) in EVENTS {
            assert_eq!(commands(&out, event), vec![format!("{RELAY} --agent cursor {event}")]);
        }
        assert_eq!(status_of(&out, RELAY), (true, true));
    }

    #[test]
    fn no_gating_event_is_ever_followed() {
        for gate in ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "preToolUse", "subagentStart", "beforeTabFileRead"] {
            assert!(EVENTS.iter().all(|(event, _)| *event != gate), "{gate}");
        }
    }

    #[test]
    fn installing_twice_changes_nothing_the_second_time() {
        let once = installed(&foreign(), RELAY).unwrap();
        assert_eq!(installed(&once, RELAY).unwrap(), once);
    }

    #[test]
    fn foreign_entries_and_unknown_keys_survive_in_place() {
        let out = installed(&foreign(), RELAY).unwrap();
        assert_eq!(out["futureKey"], foreign()["futureKey"]);
        assert_eq!(out["hooks"]["beforeShellExecution"], foreign()["hooks"]["beforeShellExecution"]);
        assert_eq!(commands(&out, "stop")[0], "./hooks/theirs.sh");
        assert_eq!(out["hooks"]["stop"][0]["timeout"], 30);
        assert_eq!(commands(&out, "stop").len(), 2);
        // The keys keep their order.
        let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["version", "futureKey", "hooks"]);
    }

    #[test]
    fn a_moved_relay_is_replaced_not_added() {
        let old = installed(&foreign(), "C:/old/nook-hook.exe").unwrap();
        assert_eq!(status_of(&old, RELAY), (true, false));
        let out = installed(&old, RELAY).unwrap();
        assert_eq!(commands(&out, "stop").len(), 2);
        assert_eq!(status_of(&out, RELAY), (true, true));
    }

    #[test]
    fn removing_takes_only_nooks_entries_and_the_rest_comes_back_as_it_was() {
        let out = uninstalled(&installed(&foreign(), RELAY).unwrap()).unwrap();
        assert_eq!(out, foreign());
        // Nothing of ours in a file of nobody else's: what is left is the file without hooks.
        let alone = uninstalled(&installed(&json!({}), RELAY).unwrap()).unwrap();
        assert_eq!(alone, json!({ "version": 1, "hooks": {} }));
    }

    #[test]
    fn an_entry_that_only_mentions_nook_is_not_ours() {
        let theirs = json!({ "hooks": { "stop": [{ "command": "nook-hook.exe --agent other stop" }] } });
        assert_eq!(uninstalled(&theirs).unwrap(), theirs);
        assert_eq!(commands(&installed(&theirs, RELAY).unwrap(), "stop").len(), 2);
    }

    #[test]
    fn what_cannot_be_read_is_refused() {
        for bad in ["{ // comment\n \"version\": 1 }", "{ \"version\": 1, }", "[1]", "not json"] {
            assert!(parse(bad.as_bytes(), "hooks.json").is_err(), "{bad}");
        }
        assert!(installed(&json!({ "hooks": [] }), RELAY).is_err());
        assert!(installed(&json!({ "hooks": { "stop": {} } }), RELAY).is_err());
        assert!(uninstalled(&json!({ "hooks": 3 })).is_err());
    }

    #[test]
    fn a_bom_crlf_and_a_blank_file_are_fine() {
        let text = "\u{feff}{\r\n  \"version\": 1,\r\n  \"hooks\": {}\r\n}\r\n";
        assert_eq!(parse(text.as_bytes(), "h").unwrap()["version"], 1);
        assert_eq!(parse(b"  \r\n", "h").unwrap(), json!({}));
    }

    #[test]
    fn a_relay_path_that_needs_quoting_is_refused() {
        assert!(installed(&json!({}), "C:/Users/John Doe/bin/nook-hook.exe").is_err());
        assert!(installed(&json!({}), "C:/Users/me/a&b/nook-hook.exe").is_err());
    }

    #[test]
    fn the_diff_of_a_new_file_is_all_additions() {
        let path = Path::new("hooks.json");
        let made = change(true, RELAY.into())(path, None).unwrap();
        assert!(made.before.is_empty() && made.after.contains("\"version\": 1"));
        assert!(made.bytes.ends_with(b"\n"));
    }
}
