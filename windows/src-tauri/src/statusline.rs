// Claude Code's status line, as the way the usage limits reach Nook.
//
// Claude Code hands its status line command — the `statusLine` key of
// ~/.claude/settings.json — a JSON that carries the 5-hour and weekly limits.
// Installing "usage limits" makes the relay that command (`nook-hook
// statusline`, hook/src/statusline.rs). It follows the hooks' rules to the
// letter, through the hooks' own code (hooks.rs `preview_change` /
// `write_change`): read, refuse what cannot be parsed, show the diff, check
// the fingerprint, take a dated backup, write beside and rename, and only
// after an explicit click. No other key is touched.
//
// A status line the user already has is not lost: its whole setting is put,
// encoded, after `--previous` in the new command. The relay runs it on every
// call and prints what it prints, and uninstalling puts it back exactly as it
// was. With none, uninstalling removes the key.
//
// Why a command string and not the hooks' exec form: `statusLine` has no
// `args` in Claude Code's settings (as of 2.1: `type`, `command`, `padding`,
// `refreshInterval`, `hideVimModeIndicator`), so the command is read by a
// shell — Git Bash when it is installed, PowerShell otherwise, `sh` on Linux.
// On Windows the two do not quote alike, so the command is written with
// nothing to quote: the relay's path as it is, and the previous setting in
// base64url. A path that would need quoting is refused rather than guessed at.
//
// `refreshInterval` is not written. It is documented ("re-runs your command
// every N seconds in addition to the event-driven updates", minimum 1,
// https://code.claude.com/docs/en/statusline), but it would bring no fresher
// limits: Claude Code 2.1.288 takes `rate_limits` from the headers of its
// last API response and keeps them in memory, and the timer only runs the
// command again with those same numbers. A status line of the user's that
// sets one keeps it, as it keeps its padding.

use serde::Serialize;
use serde_json::{json, Value};

use crate::hooks::{self, HookPreview, MARKER};
use crate::settings;

/// The key of settings.json this file is about, and no other.
const KEY: &str = "statusLine";
/// The relay's mode, and the flag the previous setting follows
/// (hook/src/statusline.rs has the same two).
const MODE: &str = "statusline";
const PREVIOUS_FLAG: &str = "--previous";
/// What the relay cannot take over from the setting it wraps: they say how
/// *that* command is run, and ours is run as a plain string.
const NOT_CARRIED: &[&str] = &["args", "shell"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    /// The relay is Claude Code's status line command.
    pub installed: bool,
    /// And it runs the status line the user had before.
    pub chained: bool,
    /// A status line that is not ours is there.
    pub other_status_line: bool,
    pub settings_path: String,
}

/// The relay's path as the command names it.
fn relay_path() -> String {
    let path = settings::hook_exe_path().to_string_lossy().to_string();
    if cfg!(windows) { path.replace('\\', "/") } else { path }
}

/// The relay as a word both of Claude Code's Windows shells read the same:
/// Git Bash wants a path with a space in quotes, PowerShell reads a quoted
/// path as a string and not as a program. With nothing but letters, digits
/// and `_ - . / :` there is nothing to quote, and nothing to get wrong.
#[cfg(windows)]
fn relay_word(relay: &str) -> Result<String, String> {
    let plain = !relay.is_empty() && relay.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'));
    if plain {
        Ok(relay.to_string())
    } else {
        Err(format!(
            "The relay's path ({relay}) has a space or a special character in it. Claude Code runs a status line through Git Bash or PowerShell, which do not read such a path the same way, so Nook won't write one. Nothing was changed."
        ))
    }
}

/// On Linux the shell is `sh`: one single-quoted word, as for the hooks.
#[cfg(unix)]
fn relay_word(relay: &str) -> Result<String, String> {
    Ok(hooks::sh_quote(relay))
}

/// A status line of ours: its command runs the relay in status line mode.
fn is_ours(setting: &Value) -> bool {
    setting
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(MARKER) && command.split_whitespace().any(|word| word == MODE))
}

/// The setting a status line of ours wraps. `Ok(None)` when it wraps none;
/// an error when it says it does and what follows cannot be read back — it is
/// somebody's status line, and removing ours would lose it.
fn previous_of(ours: &Value) -> Result<Option<Value>, String> {
    let command = ours.get("command").and_then(Value::as_str).unwrap_or_default();
    let mut words = command.split_whitespace().skip_while(|word| *word != PREVIOUS_FLAG);
    if words.next().is_none() {
        return Ok(None);
    }
    words
        .next()
        .and_then(base64url_decode)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(Some)
        .ok_or_else(|| "The status line Nook kept inside its own can't be read back. Nook won't touch it — fix the statusLine entry by hand.".to_string())
}

/// Our status line: the relay, and after it the setting it stands in front
/// of. What that setting said of how it is drawn — its padding, its refresh
/// interval — is said of ours too, in the same place.
fn entry(relay: &str, previous: Option<&Value>) -> Result<Value, String> {
    let mut command = format!("{} {MODE}", relay_word(relay)?);
    let mut entry = previous.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(previous) = previous {
        command.push_str(&format!(" {PREVIOUS_FLAG} {}", base64url_encode(previous.to_string().as_bytes())));
    }
    for key in NOT_CARRIED {
        entry.shift_remove(*key);
    }
    entry.insert("type".into(), json!("command"));
    entry.insert("command".into(), Value::String(command));
    Ok(Value::Object(entry))
}

/// Settings with the relay as the status line; everything else is left
/// untouched. A status line of the user's own is wrapped; one of ours is
/// written again around what it already wraps, never around itself.
fn installed(existing: &Value, relay: &str) -> Result<Value, String> {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let previous = match root.get(KEY) {
        None => None,
        Some(ours) if is_ours(ours) => previous_of(ours)?,
        Some(other) => Some(other.clone()),
    };
    // In the place the key already has, when it has one: the diff shows a
    // line changing, not a key moving.
    root.insert(KEY.into(), entry(relay, previous.as_ref())?);
    Ok(Value::Object(root))
}

/// Settings with our status line gone: what it wrapped is back exactly as it
/// was, or the key is removed. A status line that is not ours is not touched.
fn uninstalled(existing: &Value) -> Result<Value, String> {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    if let Some(ours) = root.get(KEY).filter(|setting| is_ours(setting)) {
        match previous_of(ours)? {
            Some(previous) => {
                root.insert(KEY.into(), previous);
            }
            None => {
                root.shift_remove(KEY);
            }
        }
    }
    Ok(Value::Object(root))
}

fn status_of(settings: &Value) -> (bool, bool, bool) {
    match settings.get(KEY) {
        None => (false, false, false),
        Some(ours) if is_ours(ours) => (true, matches!(previous_of(ours), Ok(Some(_))), false),
        Some(_) => (false, false, true),
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn status() -> UsageStatus {
    let (installed, chained, other_status_line) = status_of(&hooks::read_settings_lossy());
    UsageStatus { installed, chained, other_status_line, settings_path: hooks::settings_path().to_string_lossy().to_string() }
}

fn change(install: bool) -> impl Fn(&Value) -> Result<Value, String> {
    move |current| if install { installed(current, &relay_path()) } else { uninstalled(current) }
}

/// The diff the user has to look at before anything is written.
pub fn preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview_change(change(install))
}

/// Writes it — after a dated backup, and only if settings.json is still the
/// file the preview was made from. Returns the backup's path.
pub fn apply(install: bool, fingerprint: &str) -> Result<String, String> {
    hooks::write_change(fingerprint, change(install))
}

// ── base64url ─────────────────────────────────────────────────────────────────
//
// RFC 4648 §5, without padding: letters, digits, `-` and `_`. The one way a
// JSON value sits in a command line that Git Bash, PowerShell and sh all read
// as a single plain word.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn base64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().fold(0u32, |group, byte| (group << 8) | u32::from(*byte)) << (8 * (3 - chunk.len()));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(group >> (18 - 6 * i)) as usize & 63] as char);
        }
    }
    out
}

fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut held) = (0u32, 0u32);
    for c in text.trim_end_matches('=').bytes() {
        let six = ALPHABET.iter().position(|a| *a == c)? as u32;
        bits = (bits << 6) | six;
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A relay path with nothing to quote, as it is on most machines.
    const RELAY: &str = "C:/Users/me/AppData/Local/Nook/bin/nook-hook.exe";

    fn command_of(settings: &Value) -> &str {
        settings[KEY]["command"].as_str().unwrap()
    }

    /// The user's own status lines: a plain string, as Claude Code documents
    /// it, and one in exec form with everything else a status line can say.
    fn shell_form() -> Value {
        json!({ "type": "command", "command": "bash ~/.claude/statusline.sh --theme \"dark side\" | sed 's/é/e/'", "padding": 2 })
    }
    fn exec_form() -> Value {
        json!({ "type": "command", "command": "node", "args": ["C:/Users/me/line one.mjs", "--plain"], "refreshInterval": 5, "shell": "powershell" })
    }
    fn others() -> Value {
        json!({ "model": "opus", "env": { "A": "1" }, "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "other-tool.exe" }] }] } })
    }
    fn with(status_line: Option<Value>) -> Value {
        let mut settings = others();
        if let Some(status_line) = status_line {
            // In the middle, to see that it stays where it is.
            let mut root = serde_json::Map::new();
            root.insert("model".into(), settings["model"].take());
            root.insert(KEY.into(), status_line);
            root.insert("env".into(), settings["env"].take());
            root.insert("hooks".into(), settings["hooks"].take());
            settings = Value::Object(root);
        }
        settings
    }
    fn keys(settings: &Value) -> Vec<&str> {
        settings.as_object().unwrap().keys().map(String::as_str).collect()
    }

    #[test]
    fn with_no_status_line_the_relay_becomes_it_and_uninstalling_removes_the_key() {
        let before = with(None);
        let after = installed(&before, RELAY).unwrap();
        assert_eq!(after[KEY]["type"], "command");
        assert!(command_of(&after).ends_with(" statusline"), "nothing to chain to: {}", command_of(&after));
        assert!(command_of(&after).contains(MARKER));
        assert_eq!(status_of(&after), (true, false, false));
        // Nothing else moved, and taking it out again leaves what there was.
        assert_eq!(after["hooks"], before["hooks"]);
        assert_eq!(uninstalled(&after).unwrap(), before);
        assert_eq!(pretty(&uninstalled(&after).unwrap()), pretty(&before));
        assert_eq!(status_of(&before), (false, false, false));
    }

    fn pretty(v: &Value) -> String {
        serde_json::to_string_pretty(v).unwrap()
    }

    #[test]
    fn a_status_line_of_the_users_own_is_wrapped_and_comes_back_exactly() {
        for own in [shell_form(), exec_form()] {
            let before = with(Some(own.clone()));
            assert_eq!(status_of(&before), (false, false, true));
            let after = installed(&before, RELAY).unwrap();
            assert_eq!(status_of(&after), (true, true, false));
            assert_eq!(keys(&after), keys(&before), "the key stays where it was");

            // The command is the relay, then the old setting as one plain word.
            let words: Vec<&str> = command_of(&after).split_whitespace().collect();
            assert_eq!(words.len(), 4, "{words:?}");
            assert_eq!(&words[1..3], [MODE, PREVIOUS_FLAG]);
            assert!(words[3].bytes().all(|b| ALPHABET.contains(&b)), "one word, nothing a shell reads: {}", words[3]);
            assert_eq!(serde_json::from_slice::<Value>(&base64url_decode(words[3]).unwrap()).unwrap(), own);
            // How it is drawn carries over; how the old command was run does not.
            for (key, value) in own.as_object().unwrap() {
                match key.as_str() {
                    "type" | "command" => {}
                    "args" | "shell" => assert!(after[KEY].get(key).is_none(), "{key} is the old command's"),
                    _ => assert_eq!(&after[KEY][key], value),
                }
            }

            // Back out: byte for byte what it was, key order and all.
            let back = uninstalled(&after).unwrap();
            assert_eq!(back, before);
            assert_eq!(pretty(&back), pretty(&before));
        }
    }

    #[test]
    fn installing_twice_does_not_wrap_itself() {
        for start in [with(None), with(Some(shell_form())), with(Some(exec_form()))] {
            let once = installed(&start, RELAY).unwrap();
            let twice = installed(&once, RELAY).unwrap();
            assert_eq!(pretty(&twice), pretty(&once));
            // The relay moved (another account folder): written again around the same thing.
            let moved = installed(&once, "D:/Nook/bin/nook-hook.exe").unwrap();
            assert!(command_of(&moved).contains("D:/Nook/bin/nook-hook.exe") && !command_of(&moved).contains("Users/me"));
            assert_eq!(uninstalled(&moved).unwrap(), start);
            assert_eq!(uninstalled(&twice).unwrap(), start);
        }
    }

    #[test]
    fn a_foreign_status_line_is_never_lost() {
        // Uninstalling when ours is not there touches nothing.
        for own in [shell_form(), exec_form(), json!("not even an object"), json!({ "type": "command" })] {
            let before = with(Some(own.clone()));
            assert_eq!(uninstalled(&before).unwrap(), before);
            // And whatever it is, installing keeps it to give it back.
            let back = uninstalled(&installed(&before, RELAY).unwrap()).unwrap();
            assert_eq!(pretty(&back), pretty(&before));
        }
        // Ours, with a previous one that cannot be read back: refused, not dropped.
        let broken = with(Some(json!({ "type": "command", "command": format!("{RELAY} statusline --previous !!!") })));
        assert!(uninstalled(&broken).is_err());
        assert!(installed(&broken, RELAY).is_err());
        let cut = with(Some(json!({ "type": "command", "command": format!("{RELAY} statusline --previous") })));
        assert!(uninstalled(&cut).is_err());
        // Somebody else's command that only mentions the relay's name is not ours.
        let mention = json!({ "type": "command", "command": "echo nook-hook" });
        assert!(!is_ours(&mention) && !is_ours(&json!("nook-hook statusline")));
    }

    #[cfg(windows)]
    #[test]
    fn a_relay_path_that_would_need_quoting_is_refused() {
        let err = installed(&with(Some(shell_form())), "C:/Users/John Doe/AppData/Local/Nook/bin/nook-hook.exe").unwrap_err();
        assert!(err.contains("Nothing was changed"), "got: {err}");
        for odd in ["C:/Users/a&b/nook-hook.exe", "C:/Users/$x/nook-hook.exe", "C:/Users/é/nook-hook.exe", "C:/Users/(x)/nook-hook.exe", ""] {
            assert!(relay_word(odd).is_err(), "{odd}");
        }
        assert_eq!(relay_word(RELAY).unwrap(), RELAY);
    }

    #[test]
    fn base64url_goes_there_and_back() {
        for (plain, coded) in [("", ""), ("f", "Zg"), ("fo", "Zm8"), ("foo", "Zm9v"), ("foob", "Zm9vYg"), ("fooba", "Zm9vYmE"), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64url_encode(plain.as_bytes()), coded);
            assert_eq!(base64url_decode(coded).unwrap(), plain.as_bytes());
        }
        assert_eq!(base64url_encode(&[0xFB, 0xFF]), "-_8");
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(base64url_decode(&base64url_encode(&all)).unwrap(), all);
        assert!(base64url_decode("Zm9v+g").is_none() && base64url_decode("a b").is_none());
        // What the relay's own test decodes (hook/src/statusline.rs): the two agree.
        assert_eq!(
            base64url_encode(br#"{"type":"command","command":"bash ~/.claude/statusline.sh","padding":0}"#),
            "eyJ0eXBlIjoiY29tbWFuZCIsImNvbW1hbmQiOiJiYXNoIH4vLmNsYXVkZS9zdGF0dXNsaW5lLnNoIiwicGFkZGluZyI6MH0"
        );
    }

    /// The part that writes, called from the one test that owns the home
    /// directory (hooks.rs): `path` is a settings.json in a temp directory.
    pub(crate) fn writing_wraps_and_restores_a_status_line(path: &std::path::Path) {
        assert_eq!(hooks::settings_path(), path);
        let original = "{\n  \"model\": \"opus\",\n  \"statusLine\": {\n    \"type\": \"command\",\n    \"command\": \"bash ~/.claude/statusline.sh\",\n    \"padding\": 0\n  },\n  \"theme\": \"dark\"\n}\n";
        std::fs::write(path, original).unwrap();
        assert!(status().other_status_line && !status().installed);

        let plan = match preview(true) {
            Ok(plan) => plan,
            // This machine's relay path needs quoting: the refusal is the result.
            Err(err) => {
                assert!(err.contains("Nothing was changed"), "got: {err}");
                assert_eq!(std::fs::read_to_string(path).unwrap(), original);
                return;
            }
        };
        assert!(plan.diff.contains("nook-hook") && plan.diff.contains(PREVIOUS_FLAG), "the diff shows the new command");
        let changed: Vec<&str> = plan.diff.lines().filter(|line| line.starts_with('+') || line.starts_with('-')).collect();
        assert!(changed.iter().all(|line| line.contains("\"command\"")), "one line changes, the command: {changed:?}");
        // A preview writes nothing.
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);

        let backup = apply(true, &plan.fingerprint).expect("install should succeed");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
        let now = status();
        assert!(now.installed && now.chained && !now.other_status_line);
        let written: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!((&written["model"], &written["theme"], &written[KEY]["padding"]), (&json!("opus"), &json!("dark"), &json!(0)));

        // A stale fingerprint is refused, as for the hooks.
        assert!(apply(false, &plan.fingerprint).unwrap_err().contains("changed since the preview"));

        // Uninstall: the file is what it was, to the byte.
        let plan = preview(false).unwrap();
        apply(false, &plan.fingerprint).expect("uninstall should succeed");
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
        assert!(status().other_status_line && !status().installed);
    }
}
