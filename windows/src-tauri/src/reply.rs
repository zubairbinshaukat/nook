// Replying to a finished session from the island.
//
// The text the user wrote continues the session's own conversation in the
// background: `claude -p --resume <id>` (Claude Code) or `codex exec resume <id> -`
// (Codex), run in the session's folder. This is the port of Coucou's
// InstructionRunner.swift, minus the iPhone: here the text comes from a Tauri
// command, and the island is told when the run ends.
//
// How it stays safe:
//  - No shell, and the text is never on a command line. It goes to the child's
//    standard input, which is then closed. The only arguments are fixed flags
//    and a session id that is checked to be letters, digits, `-` and `_`.
//  - Output goes to a file, never to a pipe nobody reads (a full pipe would stall
//    the child).
//  - Nothing here waits on the child on a Tauri or async thread: one thread
//    watches it, and kills it after 30 minutes or when the user cancels.
//  - The hooks the child fires carry `NOOK_REPLY=1` (see the relay's ENV_CONTEXT),
//    so they can be told apart from a session the user typed in.
// The log says that a reply started and ended, with the session id and lengths,
// never what was said.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{log, platform, settings};

/// The longest text sent, in characters (as in Coucou).
const MAX_TEXT_CHARS: usize = 8000;
/// The longest session id accepted. Real ones are UUIDs.
const MAX_ID_LEN: usize = 128;
/// A run that lasts longer is killed and reported as failed.
const MAX_RUN: Duration = Duration::from_secs(30 * 60);
/// How often the watching thread looks at the child and at the cancel flag.
const POLL: Duration = Duration::from_millis(150);
/// How much of the end of the output goes into an error message.
const TAIL_CHARS: usize = 300;
/// How many bytes of the end of the log are read to find that tail.
const TAIL_BYTES: u64 = 4096;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tool {
    Claude,
    Codex,
}

impl Tool {
    fn parse(name: &str) -> Result<Tool, String> {
        match name {
            "claude" => Ok(Tool::Claude),
            "codex" => Ok(Tool::Codex),
            _ => Err("Replies can only be sent to Claude Code or Codex sessions.".into()),
        }
    }

    /// The wire name, also the executable's name without its extension.
    fn name(self) -> &'static str {
        match self {
            Tool::Claude => "claude",
            Tool::Codex => "codex",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Tool::Claude => "Claude Code",
            Tool::Codex => "Codex",
        }
    }
}

/// The runs going now, by `tool:session id`. Each holds its cancel flag.
#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, Arc<AtomicBool>>>);

/// Which of the two command-line tools this machine has.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplyTools {
    claude: bool,
    codex: bool,
}

/// `reply_ended`, to the island: how a run finished.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Ended {
    tool: String,
    session_id: String,
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Done,
    Failed(Option<i32>),
    Cancelled,
    TimedOut,
}

// ── Checks ────────────────────────────────────────────────────────────────────

/// The text to send: trimmed, not empty, not too long.
fn clean_text(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write a message first.".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("That message is too long (the limit is {MAX_TEXT_CHARS} characters)."));
    }
    Ok(text.to_string())
}

/// A session id goes on a command line, so it is only ever letters, digits, `-`
/// and `_`, and never starts with `-` (it would be read as an option).
fn check_session_id(id: &str) -> Result<(), String> {
    let bad = id.is_empty()
        || id.len() > MAX_ID_LEN
        || id.starts_with('-')
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if bad {
        Err("This session has no id a reply can be sent to.".into())
    } else {
        Ok(())
    }
}

fn check_cwd(cwd: &str) -> Result<PathBuf, String> {
    let path = Path::new(cwd);
    if cwd.trim().is_empty() || !path.is_dir() {
        return Err("The session's folder no longer exists.".into());
    }
    Ok(path.to_path_buf())
}

fn run_key(tool: Tool, id: &str) -> String {
    format!("{}:{id}", tool.name())
}

// ── The command line ──────────────────────────────────────────────────────────

/// The arguments after the executable. The text is not among them: both tools
/// read it from standard input — `claude -p` with no prompt argument does, and
/// in Codex a prompt of `-` means "read stdin" (`codex exec resume --help`).
fn args_for(tool: Tool, id: &str) -> Vec<String> {
    match tool {
        Tool::Claude => vec!["-p".into(), "--resume".into(), id.into()],
        // The session ran in this folder already; a folder that is not a git
        // repository must not stop the reply.
        Tool::Codex => vec![
            "exec".into(),
            "resume".into(),
            "--skip-git-repo-check".into(),
            id.into(),
            "-".into(),
        ],
    }
}

// ── Finding the tool ──────────────────────────────────────────────────────────

/// Where each tool usually lives for one user. A GUI app is not given the
/// shell's PATH on every system, so these come first, then the PATH itself.
fn usual_dirs(home: &Path, appdata: Option<&Path>, windows: bool) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if windows {
        // The native installer puts claude.exe in ~\.local\bin.
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
        // npm's global folder: claude.cmd and codex.cmd shims.
        if let Some(appdata) = appdata {
            dirs.push(appdata.join("npm"));
        }
        dirs.push(home.join(".npm-global"));
        dirs.push(home.join(".bun").join("bin"));
    } else {
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".bun").join("bin"));
    }
    dirs
}

/// The files to try, best first. On Windows a real `.exe` anywhere beats a
/// `.cmd` shim anywhere; on Linux it is the bare name.
fn candidates(stem: &str, dirs: &[PathBuf], windows: bool) -> Vec<PathBuf> {
    if windows {
        let mut all: Vec<PathBuf> = dirs.iter().map(|d| d.join(format!("{stem}.exe"))).collect();
        all.extend(dirs.iter().map(|d| d.join(format!("{stem}.cmd"))));
        all
    } else {
        dirs.iter().map(|d| d.join(stem)).collect()
    }
}

/// A PATH entry worth looking in: absolute (never the current folder, where a
/// file could be planted) and, on Windows, not the Store's alias folder, whose
/// `codex.exe` is the desktop app's launcher, not the command-line tool.
fn usable_path_dir(dir: &Path, windows: bool) -> bool {
    if !dir.is_absolute() {
        return false;
    }
    !(windows
        && dir
            .components()
            .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("WindowsApps")))
}

#[cfg(unix)]
fn is_runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_runnable(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

/// Where this machine has the tool, if anywhere.
fn locate(tool: Tool) -> Option<PathBuf> {
    let windows = cfg!(windows);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let mut dirs = usual_dirs(&platform::home_dir(), appdata.as_deref(), windows);
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path).filter(|d| usable_path_dir(d, windows)));
    }
    candidates(tool.name(), &dirs, windows).into_iter().find(|p| is_runnable(p))
}

/// The PATH the child gets: the folders the tool and its helpers usually live
/// in, then the one we have. A tool installed through npm starts `node`, which
/// has to be found from there.
fn child_path(exe: &Path, extra: &[PathBuf], existing: Option<OsString>) -> Option<OsString> {
    let mut parts: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe.parent() {
        parts.push(dir.to_path_buf());
    }
    parts.extend(extra.iter().cloned());
    if let Some(existing) = existing {
        parts.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(parts).ok()
}

// ── Output ────────────────────────────────────────────────────────────────────

/// The end of the output as one line, for an error message.
fn tail_of(bytes: &[u8], max_chars: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = line.chars().count();
    let tail: String = line.chars().skip(count.saturating_sub(max_chars)).collect();
    // A cut through the middle of a character leaves a replacement mark at the start.
    tail.trim_start_matches('\u{FFFD}').trim_start().to_string()
}

fn read_tail(path: &Path) -> String {
    let Ok(mut file) = std::fs::File::open(path) else { return String::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = file.take(TAIL_BYTES).read_to_end(&mut buf);
    tail_of(&buf, TAIL_CHARS)
}

/// What the island is told when a run is over.
fn verdict(tool: Tool, outcome: &Outcome, tail: &str) -> (bool, Option<String>) {
    match outcome {
        Outcome::Done => (true, None),
        Outcome::Cancelled => (false, Some("The reply was cancelled.".into())),
        Outcome::TimedOut => (false, Some("The reply took more than 30 minutes and was stopped.".into())),
        Outcome::Failed(code) => {
            let mut message = match code {
                Some(code) => format!("{} stopped with an error (exit code {code}).", tool.label()),
                None => format!("{} stopped with an error.", tool.label()),
            };
            if !tail.is_empty() {
                message.push(' ');
                message.push_str(tail);
            }
            (false, Some(message))
        }
    }
}

// ── Running ───────────────────────────────────────────────────────────────────

/// Ends the child and everything it started: a `.cmd` shim runs cmd.exe, which
/// runs node, which runs the tool, and killing only the first would leave the
/// work going.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let _ = Command::new(root.join("System32").join("taskkill.exe"))
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(platform::CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(target_os = "linux")]
    {
        // The child leads its own process group (see `launch`).
        if let Ok(pid) = i32::try_from(child.id()) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Waits for the child, looking at the cancel flag and the clock as it goes.
fn watch(child: &mut Child, cancel: &AtomicBool, limit: Duration) -> Outcome {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() { Outcome::Done } else { Outcome::Failed(status.code()) };
            }
            Ok(None) => {}
            Err(_) => {
                kill_tree(child);
                return Outcome::Failed(None);
            }
        }
        if cancel.load(Ordering::SeqCst) {
            kill_tree(child);
            return Outcome::Cancelled;
        }
        if started.elapsed() >= limit {
            kill_tree(child);
            return Outcome::TimedOut;
        }
        std::thread::sleep(POLL);
    }
}

/// Starts the child with its input piped and its output in the log file.
fn launch(tool: Tool, exe: &Path, id: &str, cwd: &Path, log_file: std::fs::File) -> std::io::Result<Child> {
    let extra: Vec<PathBuf> = if cfg!(windows) {
        Vec::new()
    } else {
        usual_dirs(&platform::home_dir(), None, false)
    };
    let mut cmd = Command::new(exe);
    cmd.args(args_for(tool, id))
        .current_dir(cwd)
        .env("NOOK_REPLY", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file));
    if let Some(path) = child_path(exe, &extra, std::env::var_os("PATH")) {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(platform::CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn()
}

/// Where this run's output goes: `reply-last.log` beside `nook.log`, unless
/// another run is going and is writing there, which gets a file of its own.
fn log_path(tool: Tool, id: &str, others_running: bool) -> PathBuf {
    let dir = settings::local_dir();
    if others_running {
        dir.join(format!("reply-last-{}-{id}.log", tool.name()))
    } else {
        dir.join("reply-last.log")
    }
}

/// Checks, starts the run and returns; the rest happens on its own thread.
fn begin(app: &AppHandle, tool: &str, session_id: &str, cwd: &str, text: &str) -> Result<(), String> {
    let tool = Tool::parse(tool)?;
    let text = clean_text(text)?;
    check_session_id(session_id)?;
    let cwd = check_cwd(cwd)?;
    let Some(exe) = locate(tool) else {
        return Err(format!("{} was not found on this computer.", tool.label()));
    };

    // One run per session: the place is taken before anything starts.
    let key = run_key(tool, session_id);
    let cancel = Arc::new(AtomicBool::new(false));
    let others_running = {
        let runs = app.state::<Runs>();
        let mut map = runs.0.lock().unwrap();
        if map.contains_key(&key) {
            return Err("A reply is already being sent to this session.".into());
        }
        let others = !map.is_empty();
        map.insert(key.clone(), cancel.clone());
        others
    };
    let release = |app: &AppHandle| {
        app.state::<Runs>().0.lock().unwrap().remove(&key);
    };

    let path = log_path(tool, session_id, others_running);
    if platform::ensure_private_dir(&settings::local_dir()).is_err() {
        release(app);
        return Err("Nook could not prepare its log folder.".into());
    }
    let file = match std::fs::File::create(&path) {
        Ok(file) => file,
        Err(e) => {
            log::line(format!("reply: cannot open {}: {e}", path.display()));
            release(app);
            return Err("Nook could not open its log file.".into());
        }
    };
    let mut child = match launch(tool, &exe, session_id, &cwd, file) {
        Ok(child) => child,
        Err(e) => {
            log::line(format!("reply: cannot start {}: {e}", tool.name()));
            release(app);
            return Err(format!("{} could not be started.", tool.label()));
        }
    };

    log::line(format!(
        "reply started: {} session={session_id} chars={}",
        tool.name(),
        text.chars().count()
    ));

    // The text goes in on its own thread: a pipe holds a few KB, and a child
    // that is slow to read must not hold the watcher up. Killing the child
    // breaks the pipe and ends this thread.
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
            // Dropped here: the child sees the end of its input.
        });
    }

    let app = app.clone();
    let id = session_id.to_string();
    std::thread::spawn(move || {
        let outcome = watch(&mut child, &cancel, MAX_RUN);
        let tail = if matches!(outcome, Outcome::Failed(_)) { read_tail(&path) } else { String::new() };
        let (ok, error) = verdict(tool, &outcome, &tail);
        // Free the session before the island hears of it, so it can reply again at once.
        app.state::<Runs>().0.lock().unwrap().remove(&key);
        log::line(format!("reply ended: {} session={id} ok={ok}", tool.name()));
        let _ = app.emit_to(
            crate::island::WINDOW_LABEL,
            "reply_ended",
            Ended { tool: tool.name().into(), session_id: id, ok, error },
        );
    });
    Ok(())
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Which tools can be replied to on this machine.
#[tauri::command]
pub fn reply_tools() -> ReplyTools {
    ReplyTools { claude: locate(Tool::Claude).is_some(), codex: locate(Tool::Codex).is_some() }
}

/// Sends `text` to the session and returns once the tool has started.
#[tauri::command]
pub async fn session_reply(
    app: AppHandle,
    tool: String,
    session_id: String,
    cwd: String,
    text: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || begin(&app, &tool, &session_id, &cwd, &text))
        .await
        .map_err(|_| "The reply could not be started.".to_string())?
}

/// Stops the run for that session, if there is one.
#[tauri::command]
pub fn session_reply_cancel(app: AppHandle, tool: String, session_id: String) {
    let Ok(tool) = Tool::parse(&tool) else { return };
    if let Some(cancel) = app.state::<Runs>().0.lock().unwrap().get(&run_key(tool, &session_id)) {
        cancel.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn the_tool_is_claude_or_codex_and_nothing_else() {
        assert_eq!(Tool::parse("claude"), Ok(Tool::Claude));
        assert_eq!(Tool::parse("codex"), Ok(Tool::Codex));
        for bad in ["", "Claude", "cursor", "claude ", "claude.exe", "cmd"] {
            assert!(Tool::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_text_is_trimmed_not_empty_and_at_most_8000_characters() {
        assert_eq!(clean_text("  hello \n").unwrap(), "hello");
        assert!(clean_text("").is_err());
        assert!(clean_text(" \n\t ").is_err());
        assert!(clean_text(&"a".repeat(MAX_TEXT_CHARS)).is_ok());
        assert!(clean_text(&"a".repeat(MAX_TEXT_CHARS + 1)).is_err());
        // Characters, not bytes.
        assert!(clean_text(&"é".repeat(MAX_TEXT_CHARS)).is_ok());
        assert!(clean_text(&"é".repeat(MAX_TEXT_CHARS + 1)).is_err());
        // The limit is on what is left after trimming.
        assert!(clean_text(&format!("  {}  ", "a".repeat(MAX_TEXT_CHARS))).is_ok());
        // What a shell would act on is just text here.
        assert_eq!(clean_text("a && del *.* | \"%PATH%\" $(x)").unwrap(), "a && del *.* | \"%PATH%\" $(x)");
    }

    #[test]
    fn a_session_id_is_letters_digits_dash_and_underscore() {
        for good in ["a", "019e2b4c-7f10-7d3a-b2c1-0a9f8e7d6c5b", "abc_DEF-123", &"x".repeat(MAX_ID_LEN)] {
            assert!(check_session_id(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "-rf",
            "--resume",
            "a b",
            "a/b",
            "a\\b",
            "a.b",
            "a&b",
            "a|b",
            "a\"b",
            "a%b",
            "a$b",
            "a;b",
            "a\nb",
            "idé",
            "codex:abc",
            &"x".repeat(MAX_ID_LEN + 1),
        ] {
            assert!(check_session_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_folder_has_to_exist_and_be_a_folder() {
        let here = std::env::current_dir().unwrap();
        assert!(check_cwd(here.to_str().unwrap()).is_ok());
        assert!(check_cwd("").is_err());
        assert!(check_cwd("   ").is_err());
        assert!(check_cwd(here.join("no-such-folder-here").to_str().unwrap()).is_err());
        // A file is not a folder.
        assert!(check_cwd(here.join("Cargo.toml").to_str().unwrap()).is_err());
    }

    #[test]
    fn one_run_per_tool_and_session() {
        assert_eq!(run_key(Tool::Claude, "abc"), "claude:abc");
        assert_ne!(run_key(Tool::Claude, "abc"), run_key(Tool::Codex, "abc"));
        assert_ne!(run_key(Tool::Claude, "abc"), run_key(Tool::Claude, "abd"));
    }

    #[test]
    fn the_command_lines_hold_flags_and_the_id_but_never_the_text() {
        assert_eq!(args_for(Tool::Claude, "s-1"), ["-p", "--resume", "s-1"]);
        assert_eq!(
            args_for(Tool::Codex, "s-1"),
            ["exec", "resume", "--skip-git-repo-check", "s-1", "-"]
        );
    }

    #[test]
    fn the_usual_places_come_in_order() {
        let home = p("/home/me");
        assert_eq!(
            usual_dirs(&home, None, false),
            [
                p("/home/me/.claude/local"),
                p("/home/me/.local/bin"),
                p("/usr/local/bin"),
                p("/home/me/.npm-global/bin"),
                p("/home/me/.bun/bin"),
            ]
        );
        let dirs = usual_dirs(&home, Some(&p("/home/me/AppData/Roaming")), true);
        assert_eq!(dirs[0], home.join(".local").join("bin"));
        assert!(dirs.contains(&p("/home/me/AppData/Roaming").join("npm")));
        // Without an APPDATA the npm folder is simply not listed.
        assert!(usual_dirs(&home, None, true).iter().all(|d| !d.ends_with("npm")));
    }

    #[test]
    fn on_windows_a_real_exe_anywhere_beats_a_cmd_shim() {
        let dirs = [p("a"), p("b")];
        assert_eq!(
            candidates("codex", &dirs, true),
            [p("a/codex.exe"), p("b/codex.exe"), p("a/codex.cmd"), p("b/codex.cmd")]
        );
        assert_eq!(candidates("codex", &dirs, false), [p("a/codex"), p("b/codex")]);
        // Only the exe and the cmd: never the extensionless script or a .ps1.
        assert!(candidates("claude", &dirs, true).iter().all(|c| {
            let e = c.extension().unwrap();
            e == "exe" || e == "cmd"
        }));
    }

    #[test]
    fn the_first_candidate_that_exists_wins() {
        let list = candidates("claude", &[p("a"), p("b"), p("c")], true);
        let exists = |c: &PathBuf| c == &p("b/claude.exe") || c == &p("a/claude.cmd");
        assert_eq!(list.into_iter().find(exists), Some(p("b/claude.exe")));
        let list = candidates("claude", &[p("a")], true);
        assert_eq!(list.into_iter().find(|c| c == &p("a/claude.cmd")), Some(p("a/claude.cmd")));
    }

    #[test]
    fn path_entries_that_are_not_trusted_are_skipped() {
        let abs = if cfg!(windows) { r"C:\tools" } else { "/opt/tools" };
        assert!(usable_path_dir(Path::new(abs), cfg!(windows)));
        assert!(!usable_path_dir(Path::new("."), cfg!(windows)));
        assert!(!usable_path_dir(Path::new("bin"), cfg!(windows)));
        assert!(!usable_path_dir(Path::new(""), cfg!(windows)));
        if cfg!(windows) {
            assert!(!usable_path_dir(Path::new(r"C:\Users\me\AppData\Local\Microsoft\WindowsApps"), true));
            assert!(!usable_path_dir(Path::new(r"C:\Users\me\AppData\Local\Microsoft\windowsapps"), true));
        }
    }

    #[test]
    fn the_child_path_starts_with_the_tools_own_folder() {
        let exe = if cfg!(windows) { p(r"C:\Users\me\.local\bin\claude.exe") } else { p("/home/me/.local/bin/claude") };
        let dir = exe.parent().unwrap().to_path_buf();
        let extra = [if cfg!(windows) { p(r"C:\extra") } else { p("/extra") }];
        let existing = std::env::join_paths([if cfg!(windows) { p(r"C:\old") } else { p("/old") }]).unwrap();
        let joined = child_path(&exe, &extra, Some(existing)).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(parts[0], dir);
        assert_eq!(parts[1], extra[0]);
        assert_eq!(parts.len(), 3);
        // No PATH to extend is not a failure.
        assert!(child_path(&exe, &[], None).is_some());
    }

    #[test]
    fn the_tail_is_one_line_and_at_most_the_last_300_characters() {
        assert_eq!(tail_of(b"line one\r\nline two\n\n  end  ", 300), "line one line two end");
        assert_eq!(tail_of(b"", 300), "");
        let long = format!("{}END", "x".repeat(1000));
        let tail = tail_of(long.as_bytes(), 300);
        assert_eq!(tail.chars().count(), 300);
        assert!(tail.ends_with("END"));
        // Characters, not bytes, and a cut multi-byte character does not leave a mark.
        let accents = "é".repeat(500);
        assert_eq!(tail_of(accents.as_bytes(), 300).chars().count(), 300);
        let cut = &accents.as_bytes()[1..];
        assert!(!tail_of(cut, 600).starts_with('\u{FFFD}'));
    }

    #[test]
    fn the_island_is_told_how_it_ended() {
        assert_eq!(verdict(Tool::Claude, &Outcome::Done, "ignored"), (true, None));
        let (ok, error) = verdict(Tool::Claude, &Outcome::Failed(Some(1)), "No conversation found");
        assert!(!ok);
        assert_eq!(error.unwrap(), "Claude Code stopped with an error (exit code 1). No conversation found");
        let (_, error) = verdict(Tool::Codex, &Outcome::Failed(None), "");
        assert_eq!(error.unwrap(), "Codex stopped with an error.");
        assert!(!verdict(Tool::Codex, &Outcome::Cancelled, "").0);
        assert!(verdict(Tool::Codex, &Outcome::Cancelled, "").1.unwrap().contains("cancelled"));
        assert!(verdict(Tool::Claude, &Outcome::TimedOut, "").1.unwrap().contains("30 minutes"));
    }

    #[test]
    fn what_the_front_end_receives_is_camel_case() {
        let tools = serde_json::to_value(ReplyTools { claude: true, codex: false }).unwrap();
        assert_eq!(tools, serde_json::json!({ "claude": true, "codex": false }));
        let ended = Ended { tool: "codex".into(), session_id: "s1".into(), ok: false, error: Some("boom".into()) };
        assert_eq!(
            serde_json::to_value(&ended).unwrap(),
            serde_json::json!({ "tool": "codex", "sessionId": "s1", "ok": false, "error": "boom" })
        );
        let ok = Ended { tool: "claude".into(), session_id: "s2".into(), ok: true, error: None };
        assert_eq!(serde_json::to_value(&ok).unwrap()["error"], serde_json::Value::Null);
    }

    #[test]
    fn the_log_goes_beside_nook_log_and_a_second_run_gets_its_own_file() {
        let first = log_path(Tool::Claude, "a", false);
        assert_eq!(first.file_name().unwrap(), "reply-last.log");
        assert_eq!(first.parent().unwrap(), settings::local_dir());
        let second = log_path(Tool::Codex, "b", true);
        assert_eq!(second.file_name().unwrap(), "reply-last-codex-b.log");
    }

    // The waiting, on real processes that do nothing but wait or exit.

    fn quick(code: i32) -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", &format!("exit {code}")]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", &format!("exit {code}")]);
            c
        };
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
    }

    fn slow() -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("ping");
            c.args(["-n", "60", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("60");
            c
        };
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
    }

    #[test]
    fn a_child_that_exits_is_done_or_failed_with_its_code() {
        let cancel = AtomicBool::new(false);
        assert_eq!(watch(&mut quick(0), &cancel, Duration::from_secs(30)), Outcome::Done);
        assert_eq!(watch(&mut quick(3), &cancel, Duration::from_secs(30)), Outcome::Failed(Some(3)));
    }

    #[test]
    fn a_cancelled_run_is_killed() {
        let cancel = AtomicBool::new(true);
        let started = Instant::now();
        assert_eq!(watch(&mut slow(), &cancel, Duration::from_secs(30)), Outcome::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_run_past_its_time_is_killed() {
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        assert_eq!(watch(&mut slow(), &cancel, Duration::from_millis(400)), Outcome::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(20));
    }
}
