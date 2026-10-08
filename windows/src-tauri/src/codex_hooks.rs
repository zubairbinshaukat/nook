// Codex hook installation: ~/.codex/hooks.json.
//
// The same rule as for Claude Code (hooks.rs, whose one way of changing a file
// this uses): the diff first, a dated backup, an explicit click, and only
// Nook's own entries are ever added, replaced or removed.
//
// Codex's hooks.json is laid out as Claude Code's hooks are: under each event a
// list of groups, each with its own `hooks` list. Nook adds one group of its
// own per event, with no matcher. PermissionRequest waits for the island and
// is answered only after a click (hook/src/codex.rs); with none, the relay
// prints nothing and Codex asks as it always does. Codex runs new hooks only
// once the user has trusted them with /hooks.
//
// A Nook entry is `{ "type": "command", "command": "<relay> --agent codex",
// "timeout": N }`: the command is one string, run through a shell (cmd on
// Windows), and it is refused unless it has nothing to quote.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::hooks::{self, FileChange, HookPreview};
use crate::{platform, settings};

/// Every event Nook follows, with the hook's timeout in seconds: the ones
/// Codex knows as of 0.130. PermissionRequest waits for a human, so it gets
/// the relay's decision budget and 10 s more.
pub const EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PermissionRequest", 120),
    ("PostToolUse", 10),
    ("Stop", 10),
];

const MODE: &str = "--agent codex";
/// What Codex shows while a request waits for its answer.
const WAITING: &str = "Waiting for your answer in Nook";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    /// Every event has an entry of Nook's.
    pub installed: bool,
    /// ... and every one is what Nook would write now (the relay has not moved).
    pub current: bool,
    /// hooks.json is there.
    pub file_exists: bool,
    /// `~/.codex` is there: Codex has been run on this account.
    pub codex_found: bool,
    pub hooks_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
    /// Why Nook will not write its command (a path with a space in it), if so.
    pub refused: Option<String>,
    /// hooks.json is there but cannot be read as plain JSON: said, never written over.
    pub unreadable: Option<String>,
}

pub fn hooks_path() -> PathBuf {
    platform::home_dir().join(".codex").join("hooks.json")
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
            "The relay's path ({relay}) has a space or a special character in it. Codex runs hook commands through a shell that may not read such a path, so Nook won't write one. Nothing was changed."
        ))
    }
}

fn command_for(relay: &str) -> String {
    format!("{relay} {MODE}")
}

/// A hook of Nook's: its command runs the relay in Codex mode.
fn is_ours(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(hooks::MARKER) && command.contains(MODE))
}

/// The hooks of Nook's in one event's groups.
fn ours_in(groups: &[Value]) -> Vec<&Value> {
    groups
        .iter()
        .filter_map(|group| group.get("hooks").and_then(Value::as_array))
        .flat_map(|hooks| hooks.iter().filter(|hook| is_ours(hook)))
        .collect()
}

/// One event's groups without Nook's hooks: a group that held nothing else
/// goes, and everything that is somebody else's stays as it was.
fn without_ours(groups: &[Value]) -> Vec<Value> {
    groups
        .iter()
        .filter_map(|group| {
            let Some(list) = group.get("hooks").and_then(Value::as_array) else { return Some(group.clone()) };
            let rest: Vec<Value> = list.iter().filter(|hook| !is_ours(hook)).cloned().collect();
            if rest.len() == list.len() {
                return Some(group.clone());
            }
            if rest.is_empty() {
                return None;
            }
            let mut group = group.clone();
            group["hooks"] = Value::Array(rest);
            Some(group)
        })
        .collect()
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
    let command = command_for(&relay_word(relay)?);
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = match root.get("hooks") {
        None => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err("The \"hooks\" key of hooks.json isn't an object — Nook won't touch it.".into()),
    };
    for (event, timeout) in EVENTS {
        let mut groups = match hooks.get(*event) {
            None => Vec::new(),
            Some(Value::Array(list)) => without_ours(list),
            Some(_) => return Err(format!("The \"{event}\" hooks of hooks.json aren't a list — Nook won't touch them.")),
        };
        let mut hook = json!({ "type": "command", "command": command, "timeout": timeout });
        if *event == "PermissionRequest" {
            hook["statusMessage"] = json!(WAITING);
        }
        groups.push(json!({ "hooks": [hook] }));
        hooks.insert((*event).to_string(), Value::Array(groups));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    Ok(Value::Object(root))
}

/// hooks.json with every entry of Nook's removed and nothing else changed.
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
                let rest = without_ours(list);
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
    let ours = |event: &str| hooks.get(event).and_then(Value::as_array).map(|groups| ours_in(groups)).unwrap_or_default();
    let installed = EVENTS.iter().all(|(event, _)| !ours(event).is_empty());
    let want = command_for(relay);
    let current = installed
        && EVENTS.iter().all(|(event, _)| ours(event).iter().all(|hook| hook.get("command").and_then(Value::as_str) == Some(want.as_str())));
    (installed, current)
}

pub fn status() -> CodexStatus {
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
    CodexStatus {
        installed,
        current,
        file_exists: path.exists(),
        codex_found: path.parent().is_some_and(Path::exists),
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
            "futureKey": { "keep": [1, 2] },
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "./hooks/theirs.sh", "timeout": 30 }] }],
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./hooks/guard.sh" }] }],
                "PreCompact": [{ "hooks": [{ "type": "command", "command": "./hooks/compact.sh" }] }],
            },
        })
    }

    fn commands(v: &Value, event: &str) -> Vec<String> {
        v["hooks"][event]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|group| group["hooks"].as_array().unwrap().iter().map(|hook| hook["command"].as_str().unwrap().to_string()))
            .collect()
    }

    #[test]
    fn a_missing_file_is_created_with_every_event_and_one_that_waits() {
        let out = installed(&json!({}), RELAY).unwrap();
        for (event, timeout) in EVENTS {
            assert_eq!(commands(&out, event), vec![format!("{RELAY} --agent codex")]);
            let hook = &out["hooks"][*event][0]["hooks"][0];
            assert_eq!((&hook["type"], &hook["timeout"]), (&json!("command"), &json!(timeout)));
            assert_eq!(hook.get("statusMessage").is_some(), *event == "PermissionRequest", "{event}");
            assert!(out["hooks"][*event][0].get("matcher").is_none());
        }
        assert_eq!(out["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 120);
        assert_eq!(status_of(&out, RELAY), (true, true));
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
        assert_eq!(out["hooks"]["PreCompact"], foreign()["hooks"]["PreCompact"]);
        assert_eq!(out["hooks"]["PreToolUse"][0], foreign()["hooks"]["PreToolUse"][0]);
        assert_eq!(commands(&out, "Stop"), ["./hooks/theirs.sh".to_string(), format!("{RELAY} --agent codex")]);
        let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["futureKey", "hooks"]);
    }

    #[test]
    fn a_moved_relay_is_replaced_not_added() {
        let old = installed(&foreign(), "C:/old/nook-hook.exe").unwrap();
        assert_eq!(status_of(&old, RELAY), (true, false));
        let out = installed(&old, RELAY).unwrap();
        assert_eq!(commands(&out, "Stop").len(), 2);
        assert_eq!(status_of(&out, RELAY), (true, true));
    }

    #[test]
    fn removing_takes_only_nooks_entries_and_the_rest_comes_back_as_it_was() {
        assert_eq!(uninstalled(&installed(&foreign(), RELAY).unwrap()).unwrap(), foreign());
        assert_eq!(uninstalled(&installed(&json!({}), RELAY).unwrap()).unwrap(), json!({ "hooks": {} }));
        // A hook of Nook's put by hand in a group of somebody's: only it goes.
        let shared = json!({ "hooks": { "Stop": [{ "matcher": "x", "hooks": [{ "command": "theirs" }, { "command": format!("{RELAY} --agent codex") }] }] } });
        assert_eq!(uninstalled(&shared).unwrap(), json!({ "hooks": { "Stop": [{ "matcher": "x", "hooks": [{ "command": "theirs" }] }] } }));
    }

    #[test]
    fn an_entry_that_only_mentions_nook_is_not_ours() {
        let theirs = json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "nook-hook.exe --agent other" }] }] } });
        assert_eq!(uninstalled(&theirs).unwrap(), theirs);
        assert_eq!(commands(&installed(&theirs, RELAY).unwrap(), "Stop").len(), 2);
        assert_eq!(status_of(&theirs, RELAY), (false, false));
    }

    #[test]
    fn what_cannot_be_read_is_refused() {
        for bad in ["{ // comment\n \"hooks\": {} }", "{ \"hooks\": {}, }", "[1]", "not json"] {
            assert!(parse(bad.as_bytes(), "hooks.json").is_err(), "{bad}");
        }
        assert!(installed(&json!({ "hooks": [] }), RELAY).is_err());
        assert!(installed(&json!({ "hooks": { "Stop": {} } }), RELAY).is_err());
        assert!(uninstalled(&json!({ "hooks": 3 })).is_err());
        assert_eq!(parse(b"  \r\n", "h").unwrap(), json!({}));
    }

    #[test]
    fn a_relay_path_that_needs_quoting_is_refused() {
        assert!(installed(&json!({}), "C:/Users/John Doe/bin/nook-hook.exe").is_err());
        assert!(installed(&json!({}), "C:/Users/me/a&b/nook-hook.exe").is_err());
    }

    #[test]
    fn the_diff_of_a_new_file_is_all_additions() {
        let made = change(true, RELAY.into())(Path::new("hooks.json"), None).unwrap();
        assert!(made.before.is_empty() && made.after.contains("--agent codex"));
        assert!(made.bytes.ends_with(b"\n"));
    }
}
