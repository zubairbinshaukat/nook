//! `nook-hook statusline` — the relay as Claude Code's status line command.
//!
//! Claude Code hands its status line command a JSON on stdin that carries, on a
//! subscription plan, how much of the 5-hour and weekly limits is used. This
//! mode sends Nook those two windows and the name of the session's model, and
//! nothing else of that JSON — it also holds the cost, the folder and the
//! transcript's path, and none of them leaves this process.
//!
//! What Claude Code shows as the status line is this command's stdout, so:
//! * with no status line of the user's own, nothing is printed at all;
//! * with one (`--previous`, put there by Nook's installer), it is run with the
//!   same bytes on stdin, writes straight to our stdout, and its exit code is
//!   ours. Past PREVIOUS_BUDGET it is stopped and we exit 0.
//!
//! The same hard rule as every other mode: Claude Code is never blocked. Every
//! wait here has a deadline, and whatever goes wrong ends in a quiet exit 0.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The argument that selects this mode. Nook's installer writes it
/// (src-tauri/src/statusline.rs), and it is the first argument or it is not this mode.
pub const MODE: &str = "statusline";
/// Followed by the user's own status line setting — the JSON value Nook found
/// under `statusLine`, in base64url — to run after the numbers are sent.
const PREVIOUS_FLAG: &str = "--previous";
/// The name the app knows this event by. Never a hook: Claude Code has none of that name.
const EVENT: &str = "StatusLine";
/// The two windows forwarded, and the two fields of each.
const WINDOWS: &[&str] = &["five_hour", "seven_day"];
const WINDOW_FIELDS: &[&str] = &["used_percentage", "resets_at"];
/// How long stdin gets to hand over the status JSON: Claude Code writes it at once.
const STDIN_BUDGET: Duration = Duration::from_secs(1);
/// How long the user's own status line may take before it is stopped.
const PREVIOUS_BUDGET: Duration = Duration::from_secs(2);
/// A session id is a UUID; anything much longer is not one, and is not sent.
const MAX_SESSION_ID: usize = 128;
/// The two names of the session's model that go with the limits, and the
/// longest either may be: an id like `claude-opus-5-5`, a name like `Opus`.
const MODEL_FIELDS: &[&str] = &["id", "display_name"];
const MAX_MODEL_NAME: usize = 64;

/// The whole of the mode. Never returns.
pub fn run(args: &[String]) -> ! {
    let raw = read_stdin().unwrap_or_default();

    // Fire and forget, on its own thread: the user's status line does not wait
    // for Nook, and a closed Nook costs nothing.
    let (sent_tx, sent_rx) = mpsc::channel::<()>();
    if let Some(line) = usage_line(&raw) {
        std::thread::spawn(move || {
            let _ = crate::talk(&line, false);
            let _ = sent_tx.send(());
        });
    } else {
        drop(sent_tx);
    }
    let started = Instant::now();

    let code = previous_of(args).and_then(|previous| run_previous(&previous, &raw)).unwrap_or(0);

    // The send gets what is left of the budget every forgotten event has.
    let left = crate::FIRE_AND_FORGET_BUDGET.saturating_sub(started.elapsed());
    let _ = sent_rx.recv_timeout(left);
    std::process::exit(code);
}

/// Everything on stdin, or nothing when it does not come in time (run by hand
/// from a terminal, stdin is a keyboard nobody types on).
fn read_stdin() -> Option<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut raw = Vec::new();
        let read = std::io::stdin().read_to_end(&mut raw).is_ok();
        let _ = tx.send(read.then_some(raw));
    });
    rx.recv_timeout(STDIN_BUDGET).ok().flatten()
}

/// One window as it goes to Nook: its two numbers, when both are numbers.
fn window_of(limits: &Value, name: &str) -> Option<Value> {
    let window = limits.get(name)?.as_object()?;
    let mut out = serde_json::Map::new();
    for field in WINDOW_FIELDS {
        out.insert((*field).to_string(), window.get(*field).filter(|v| v.is_number())?.clone());
    }
    Some(Value::Object(out))
}

/// The windows Claude Code reported, each with its two numbers and nothing
/// else. None when there is none: an API key, or a session that has not had
/// its first answer yet.
fn limits_of(status: &Value) -> Option<Value> {
    let limits = status.get("rate_limits")?;
    let windows: serde_json::Map<String, Value> =
        WINDOWS.iter().filter_map(|name| Some(((*name).to_string(), window_of(limits, name)?))).collect();
    (!windows.is_empty()).then_some(Value::Object(windows))
}

/// The session's model as it goes to Nook: its id and the name Claude Code
/// shows for it, each a short single line. None when neither is there.
fn model_of(status: &Value) -> Option<Value> {
    let model = status.get("model")?.as_object()?;
    let names: serde_json::Map<String, Value> = MODEL_FIELDS
        .iter()
        .filter_map(|field| {
            let name = model.get(*field)?.as_str()?.trim();
            let short = !name.is_empty() && name.chars().count() <= MAX_MODEL_NAME && !name.chars().any(char::is_control);
            short.then(|| ((*field).to_string(), Value::String(name.to_string())))
        })
        .collect();
    (!names.is_empty()).then_some(Value::Object(names))
}

/// The one line Nook gets from a status line call: the event's name, the
/// session it came from, the limits and the model. Built field by field —
/// nothing of the status JSON is copied that is not named here. None when
/// there is neither a limit nor a model to tell.
fn usage_line(raw: &[u8]) -> Option<String> {
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    let status = serde_json::from_slice::<Value>(raw).ok()?;
    let (limits, model) = (limits_of(&status), model_of(&status));
    if limits.is_none() && model.is_none() {
        return None;
    }
    let session = status
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|id| id.chars().count() <= MAX_SESSION_ID)
        .map_or(Value::Null, |id| Value::String(id.to_string()));
    let mut event = json!({ "hook_event_name": EVENT, "session_id": session });
    if let Some(limits) = limits {
        event["rate_limits"] = limits;
    }
    if let Some(model) = model {
        event["model"] = model;
    }
    let mut line = event.to_string();
    line.push('\n');
    Some(line)
}

// ── The user's own status line ────────────────────────────────────────────────

/// The status line the user had before Nook's, as its setting said it.
#[derive(Debug, PartialEq)]
struct Previous {
    command: String,
    /// Exec form: the command is a program, these are its arguments, no shell.
    args: Option<Vec<String>>,
    /// The shell the setting asked for, if it named one.
    shell: Option<String>,
}

/// What follows `--previous`, read back into the setting it was made from.
/// None when there is none, or when it is not a command anybody can run.
fn previous_of(args: &[String]) -> Option<Previous> {
    let at = args.iter().position(|arg| arg == PREVIOUS_FLAG)?;
    let setting = serde_json::from_slice::<Value>(&base64url_decode(args.get(at + 1)?)?).ok()?;
    previous_in(&setting)
}

fn previous_in(setting: &Value) -> Option<Previous> {
    let command = setting.get("command")?.as_str()?.trim();
    if command.is_empty() || setting.get("type").is_some_and(|t| t != "command") {
        return None;
    }
    let args = match setting.get("args") {
        None => None,
        Some(args) => Some(args.as_array()?.iter().map(|a| a.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?),
    };
    let shell = setting.get("shell").and_then(Value::as_str).map(str::to_string);
    Some(Previous { command: command.to_string(), args, shell })
}

/// base64url without padding (RFC 4648 §5): the one way a JSON value crosses a
/// command line untouched by Git Bash, PowerShell and sh alike.
fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut held) = (0u32, 0u32);
    for c in text.trim_end_matches('=').bytes() {
        let six = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(six);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    Some(out)
}

/// The command that runs the user's status line.
///
/// Exec form is run as it is written: a program and its arguments. A plain
/// string was run by Claude Code through a shell, and is run here through the
/// one Claude Code picks: `sh` on Linux; on Windows Git Bash when it is
/// installed and PowerShell otherwise, or PowerShell when the setting says so.
/// Claude Code's choice is its own and may change: this follows it as of 2.1.
fn command_for(previous: &Previous) -> Option<Command> {
    if let Some(args) = &previous.args {
        let mut command = Command::new(&previous.command);
        command.args(args);
        return Some(command);
    }
    shell_command(previous)
}

#[cfg(unix)]
fn shell_command(previous: &Previous) -> Option<Command> {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(&previous.command);
    Some(command)
}

#[cfg(windows)]
fn shell_command(previous: &Previous) -> Option<Command> {
    let bash = if previous.shell.as_deref() == Some("powershell") { None } else { git_bash() };
    match bash {
        Some(bash) => {
            let mut command = Command::new(&bash);
            command.arg("-c").arg(for_bash(&previous.command));
            // As Claude Code does: the tools next to bash (jq is not one, cat
            // and sed are) are found whatever PATH we were given.
            if let (Some(dir), Some(path)) = (bash.parent(), std::env::var_os("PATH")) {
                let mut dirs = vec![dir.to_path_buf()];
                dirs.extend(std::env::split_paths(&path));
                if let Ok(joined) = std::env::join_paths(dirs) {
                    command.env("PATH", joined);
                }
            }
            Some(command)
        }
        None => {
            let mut command = Command::new(on_path("pwsh.exe").or_else(|| on_path("powershell.exe"))?);
            command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &previous.command]);
            Some(command)
        }
    }
}

/// Git Bash, looked for where Claude Code looks for it, in its order.
#[cfg(windows)]
fn git_bash() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    if let Some(named) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").map(PathBuf::from) {
        let name = named.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ["bash.exe", "sh.exe", "bash", "sh"].contains(&name.as_str()) && named.is_file() {
            return Some(named);
        }
    }
    let known = [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"];
    if let Some(found) = known.iter().map(PathBuf::from).find(|p| p.is_file()) {
        return Some(found);
    }
    // …\Git\cmd\git.exe → …\Git\bin\bash.exe
    let beside_git = on_path("git.exe")?.parent()?.parent()?.join("bin").join("bash.exe");
    beside_git.is_file().then_some(beside_git)
}

#[cfg(windows)]
fn on_path(name: &str) -> Option<std::path::PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// A command whose first word is a `.sh` script is handed to bash by name, as
/// Claude Code does on Windows, where a script has no executable bit to run by.
#[cfg(any(windows, test))]
fn for_bash(command: &str) -> String {
    // The first word as a shell reads it: quotes taken off, a backslash keeping what follows it.
    let mut first = String::new();
    let mut chars = command.trim().chars();
    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => first.extend(chars.by_ref().take_while(|next| *next != c)),
            '\\' => first.extend(chars.next()),
            c if c.is_whitespace() => break,
            c => first.push(c),
        }
    }
    if first.ends_with(".sh") { format!("bash {command}") } else { command.to_string() }
}

/// Runs the user's status line on the bytes we were given, its output going
/// straight to ours, and returns its exit code. None when it cannot be
/// started, or is still running when its time is up — it is then stopped.
fn run_previous(previous: &Previous, raw: &[u8]) -> Option<i32> {
    let mut child = command_for(previous)?
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .ok()?;
    // On a thread: a status line that never reads its stdin must not hold us on a full pipe.
    if let Some(mut stdin) = child.stdin.take() {
        let raw = raw.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&raw);
        });
    }
    let deadline = Instant::now() + PREVIOUS_BUDGET;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.code().unwrap_or(0)),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Claude Code hands a status line, cut to what matters here.
    fn status(limits: Value) -> Vec<u8> {
        json!({
            "session_id": "0b9d0f4e-3c1a-4f0e-9d53-6a1d2f3e4b5c",
            "cwd": "C:\\Users\\me\\secret project",
            "transcript_path": "C:\\Users\\me\\.claude\\projects\\x\\t.jsonl",
            "model": { "id": "claude-opus-5", "display_name": "Opus", "provider": "left behind too" },
            "cost": { "total_cost_usd": 12.5 },
            "rate_limits": limits,
        })
        .to_string()
        .into_bytes()
    }

    fn sent(raw: &[u8]) -> Value {
        serde_json::from_str(usage_line(raw).expect("a line goes out").trim_end()).unwrap()
    }

    #[test]
    fn both_windows_go_out_and_nothing_else_of_the_status_does() {
        let raw = status(json!({
            "five_hour": { "used_percentage": 23.5, "resets_at": 1_738_425_600u64 },
            "seven_day": { "used_percentage": 41, "resets_at": 1_738_857_600u64, "extra": "left behind" },
            "spend_limit": { "used_percentage": 62.8, "used_usd": 314.12 },
        }));
        let line = usage_line(&raw).unwrap();
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1, "one line, as the pipe reads it");
        assert_eq!(
            sent(&raw),
            json!({
                "hook_event_name": "StatusLine",
                "session_id": "0b9d0f4e-3c1a-4f0e-9d53-6a1d2f3e4b5c",
                "rate_limits": {
                    "five_hour": { "used_percentage": 23.5, "resets_at": 1_738_425_600u64 },
                    "seven_day": { "used_percentage": 41, "resets_at": 1_738_857_600u64 },
                },
                "model": { "id": "claude-opus-5", "display_name": "Opus" },
            })
        );
        for kept_here in ["secret", "transcript", "provider", "cost", "12.5", "spend", "314", "left behind"] {
            assert!(!line.contains(kept_here), "{kept_here} must not leave the relay");
        }
    }

    #[test]
    fn a_window_that_is_missing_or_wrong_is_left_out_and_the_other_still_goes() {
        let only = |limits: Value| sent(&status(limits))["rate_limits"].clone();
        let five = json!({ "used_percentage": 9, "resets_at": 1_738_425_600u64 });
        // One window alone.
        assert_eq!(only(json!({ "five_hour": five })), json!({ "five_hour": five }));
        // The other is there but is not what it should be: a string, half of it, null.
        for wrong in [
            json!({ "used_percentage": "41", "resets_at": 1 }),
            json!({ "used_percentage": 41 }),
            json!({ "resets_at": 1 }),
            json!({ "used_percentage": 41, "resets_at": null }),
            json!("41%"),
            json!(null),
        ] {
            assert_eq!(only(json!({ "five_hour": five, "seven_day": wrong })), json!({ "five_hour": five }));
        }
    }

    #[test]
    fn with_no_limits_the_model_goes_alone_and_with_neither_nothing_is_sent() {
        // An API key, or a session before its first answer: no rate_limits.
        assert_eq!(
            sent(br#"{"session_id":"s","cwd":"/secret","model":{"id":"claude-sonnet-5","display_name":"Sonnet"}}"#),
            json!({ "hook_event_name": "StatusLine", "session_id": "s", "model": { "id": "claude-sonnet-5", "display_name": "Sonnet" } })
        );
        for limits in [json!(null), json!({}), json!([]), json!("none"), json!({ "five_hour": {}, "seven_day": 3 })] {
            assert!(sent(&status(limits)).get("rate_limits").is_none());
        }
        assert!(usage_line(br#"{"session_id":"s","cwd":"/secret"}"#).is_none());
        // A model that is no name: one of the two, or none of it.
        let model = |model: Value| model_of(&json!({ "model": model }));
        assert_eq!(model(json!({ "id": " claude-opus-5 ", "display_name": 4 })), Some(json!({ "id": "claude-opus-5" })));
        assert_eq!(model(json!({ "id": "x".repeat(MAX_MODEL_NAME + 1), "display_name": "Opus" })), Some(json!({ "display_name": "Opus" })));
        for none in [json!("claude-opus-5"), json!({}), json!({ "id": "", "display_name": "a\nb" }), json!(null)] {
            assert_eq!(model(none), None);
        }
        // Not JSON, or nothing: nothing.
        assert!(usage_line(b"").is_none());
        assert!(usage_line(b"{ not json").is_none());
        assert!(usage_line(b"[1,2]").is_none());
    }

    #[test]
    fn the_session_is_an_id_or_it_is_not_sent() {
        let limits = json!({ "five_hour": { "used_percentage": 1, "resets_at": 2 } });
        let with = |session: Value| sent(json!({ "session_id": session, "rate_limits": limits }).to_string().as_bytes())["session_id"].clone();
        assert_eq!(with(json!("abc")), json!("abc"));
        assert_eq!(with(json!(42)), Value::Null);
        assert_eq!(with(json!("x".repeat(MAX_SESSION_ID + 1))), Value::Null);
        // A BOM in front of the JSON, as some shells write one.
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(&status(limits.clone()));
        assert_eq!(sent(&bom)["rate_limits"], limits);
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_previous_status_line_comes_back_out_of_the_command_line() {
        assert_eq!(base64url_decode("").unwrap(), b"");
        assert_eq!(base64url_decode("Zg").unwrap(), b"f");
        assert_eq!(base64url_decode("Zm8").unwrap(), b"fo");
        assert_eq!(base64url_decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(base64url_decode("Zm9vYg==").unwrap(), b"foob");
        // The two characters that make it the URL alphabet.
        assert_eq!(base64url_decode("-_8").unwrap(), [0xFB, 0xFF]);
        assert!(base64url_decode("Zm9v+g").is_none() && base64url_decode("a b").is_none());

        // {"type":"command","command":"bash ~/.claude/statusline.sh","padding":0}
        let shell_form = "eyJ0eXBlIjoiY29tbWFuZCIsImNvbW1hbmQiOiJiYXNoIH4vLmNsYXVkZS9zdGF0dXNsaW5lLnNoIiwicGFkZGluZyI6MH0";
        assert_eq!(
            previous_of(&args(&["--previous", shell_form])),
            Some(Previous { command: "bash ~/.claude/statusline.sh".into(), args: None, shell: None })
        );
        // None, or one that is not there to read: no status line of the user's own.
        assert_eq!(previous_of(&[]), None);
        assert_eq!(previous_of(&args(&["--previous"])), None);
        assert_eq!(previous_of(&args(&["--previous", "not base64 !"])), None);
        assert_eq!(previous_of(&args(&["--previous", "Zm9v"])), None);
    }

    #[test]
    fn exec_form_is_a_program_and_its_arguments_and_shell_form_a_string() {
        let exec = previous_in(&json!({ "type": "command", "command": "node", "args": ["C:/x y/line.mjs", "--plain"] })).unwrap();
        assert_eq!(exec.args.as_deref(), Some(&["C:/x y/line.mjs".to_string(), "--plain".to_string()][..]));
        let command = command_for(&exec).unwrap();
        assert_eq!(command.get_program(), "node");
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["C:/x y/line.mjs", "--plain"]);

        let shell = previous_in(&json!({ "type": "command", "command": " jq -r '.model.display_name' ", "shell": "powershell" })).unwrap();
        assert_eq!(shell, Previous { command: "jq -r '.model.display_name'".into(), args: None, shell: Some("powershell".into()) });

        // Not a command anybody can run: nothing is run.
        for not_one in [
            json!({ "type": "command" }),
            json!({ "type": "command", "command": "  " }),
            json!({ "type": "command", "command": 3 }),
            json!({ "type": "other", "command": "x" }),
            json!({ "type": "command", "command": "x", "args": "--flag" }),
            json!({ "type": "command", "command": "x", "args": ["a", 1] }),
            json!("x"),
        ] {
            assert_eq!(previous_in(&not_one), None, "{not_one}");
        }
    }

    #[test]
    fn a_script_is_handed_to_bash_by_name() {
        assert_eq!(for_bash("~/.claude/statusline.sh"), "bash ~/.claude/statusline.sh");
        assert_eq!(for_bash("\"C:/a b/line.sh\" --x"), "bash \"C:/a b/line.sh\" --x");
        assert_eq!(for_bash("jq -r .model"), "jq -r .model");
        assert_eq!(for_bash(""), "");
    }
}
