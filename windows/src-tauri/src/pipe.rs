// Relay server for nook-hook.
//
// Windows: the named pipe `\\.\pipe\nook-<sid>`, one instance per connection.
// Linux: the Unix socket `$XDG_RUNTIME_DIR/nook.sock`. Every hook event is
// forwarded to the island as a `hook` event — but for `StatusLine`, which is no
// hook and goes to usage.rs instead. `PermissionRequest` is the only one
// that keeps its connection open: it waits for the island's decision and writes
// it back on the same connection, which is how approving from the island works.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * nook-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// documented hookSpecificOutput JSON is nook-hook's job, so the wire format
// Claude Code expects lives in exactly one place.
//
// One line carries more than a word: `answer {…}`, the answers picked on the
// island to a question Claude asked with its question tool. They are never
// written to the log.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::target::{self, Sessions};
use crate::{log, platform, usage, visibility};

/// Slightly under nook-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;
/// How long a connection gets to send its line. The relay's whole budget for an
/// event nobody waits on is two seconds, so anything slower is not the relay.
const READ_TIMEOUT: Duration = Duration::from_secs(2);

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// `\\.\pipe\nook-<sid>` — must match nook-hook's `pipe_path()` exactly.
#[cfg(windows)]
pub fn pipe_name() -> String {
    let key = crate::platform::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\nook-{key}")
}

/// Why the relay pipe could not be opened, for Settings; None while it is up.
static PIPE_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn pipe_error() -> Option<String> {
    PIPE_ERROR.lock().ok().and_then(|e| e.clone())
}

fn fail(what: &str, err: impl std::fmt::Display) {
    let text = format!("{what}: {err}");
    log::line(&text);
    if let Ok(mut e) = PIPE_ERROR.lock() {
        *e = Some(text);
    }
}

/// Instances one pipe may have at once. Well above what real hook traffic needs
/// and well below tokio's 255, so a flood of connections cannot hold them all.
#[cfg(windows)]
const MAX_INSTANCES: usize = 64;

/// The pipe's security descriptor: full control for this user and for SYSTEM,
/// nothing for anyone else (the default would also let Everyone read). `OW`
/// (the owner) stands in for the SID only if it cannot be read.
#[cfg(any(windows, test))]
fn sddl_for(who: &str) -> String {
    format!("D:P(A;;GA;;;{who})(A;;GA;;;SY)")
}

/// The descriptor, built once and kept for the life of the process. The pointer
/// is held as a number so the struct can cross threads.
#[cfg(windows)]
struct PipeAcl(usize);

#[cfg(windows)]
impl PipeAcl {
    fn new() -> Result<PipeAcl, String> {
        use windows::core::HSTRING;
        use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
        use windows::Win32::Security::PSECURITY_DESCRIPTOR;
        let who = crate::platform::current_user_sid().unwrap_or_else(|| "OW".into());
        let sddl = HSTRING::from(sddl_for(&who));
        let mut sd = PSECURITY_DESCRIPTOR::default();
        unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(&sddl, 1, &mut sd, None) }
            .map_err(|e| e.to_string())?;
        Ok(PipeAcl(sd.0 as usize))
    }

    /// One pipe instance, with the descriptor on it and remote clients refused.
    fn create(&self, name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
        use windows::Win32::Security::SECURITY_ATTRIBUTES;
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0 as *mut _,
            bInheritHandle: false.into(),
        };
        let mut options = ServerOptions::new();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        options.first_pipe_instance(first).reject_remote_clients(true).max_instances(MAX_INSTANCES);
        unsafe { options.create_with_security_attributes_raw(name, (&mut attrs as *mut SECURITY_ATTRIBUTES).cast()) }
    }
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        let acl = match PipeAcl::new() {
            Ok(acl) => acl,
            Err(err) => {
                fail("cannot build the relay pipe's access rules", err);
                return;
            }
        };
        let mut server = match acl.create(&name, true) {
            Ok(s) => s,
            Err(err) => {
                fail("cannot open the relay pipe", err);
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match acl.create(&name, false) {
                Ok(s) => s,
                Err(err) => {
                    fail("cannot reopen the relay pipe", err);
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

#[cfg(target_os = "linux")]
pub fn start(app: AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    tauri::async_runtime::spawn(async move {
        let Some(path) = crate::platform::relay_socket_path() else {
            log::line("no private runtime directory ($XDG_RUNTIME_DIR) — Claude Code hooks are inactive");
            return;
        };
        // A socket file left behind by a crash answers nothing and can go. One
        // that answers belongs to a Nook that is still running: like
        // first_pipe_instance on Windows, we refuse to serve on top of it.
        if path.exists() {
            if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                log::line("another Nook already serves the relay socket");
                return;
            }
            let _ = std::fs::remove_file(&path);
        }
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(err) => {
                fail("cannot open the relay socket", err);
                return;
            }
        };
        // The runtime directory is already 0700; this is belt and braces.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let uid = unsafe { libc::getuid() };
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            // Only the relay run by our own user may drive the island.
            if !matches!(stream.peer_cred(), Ok(c) if c.uid() == uid) {
                log::line("refused a relay connection from another user");
                continue;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, stream).await });
        }
    });
}

/// One accepted relay connection, whatever carries it.
trait Relay: AsyncRead + AsyncWrite + Unpin {
    /// Ends the conversation once everything has been written.
    fn finish(&mut self) {}
}

#[cfg(windows)]
impl Relay for NamedPipeServer {
    fn finish(&mut self) {
        let _ = self.disconnect();
    }
}

/// Dropping the stream closes it; the relay reads up to our newline first.
#[cfg(target_os = "linux")]
impl Relay for tokio::net::UnixStream {}

/// The relay's one line, read under a deadline. None when it does not come in
/// time or the connection fails: the relay writes its line the moment it
/// connects, so a client that connects and then says nothing is not one, and
/// must not hold a pipe instance and a task for as long as it likes.
async fn read_line(pipe: &mut (impl AsyncRead + Unpin)) -> Option<Vec<u8>> {
    let read = async {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                        break;
                    }
                }
                Err(_) => return None,
            }
        }
        Some(buf)
    };
    tokio::time::timeout(READ_TIMEOUT, read).await.ok().flatten()
}

/// The tool that launches a subagent, by its name today and the one older versions gave it.
const AGENT_TOOLS: &[&str] = &["Agent", "Task"];
/// As much of an id or a type as a line of the log takes.
const NOTE_CHARS: usize = 48;

/// An id or a type for the log: what it is made of when it is one, cut short —
/// never free text. `-` when the event has none, `""` when it has an empty one.
fn noted(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        None => "-".into(),
        Some("") => "\"\"".into(),
        Some(text) => text
            .chars()
            .take(NOTE_CHARS)
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':') { c } else { '?' })
            .collect(),
    }
}

/// What the log says of an event that is about a subagent — a SubagentStart, a
/// SubagentStop, the `Agent` tool's start and end — after its name: which
/// agent, of what type, and the names of the fields the event came with. Names
/// only: no prompt, no tool input, no message, no path.
///
/// Claude Code fires SubagentStop for side agents of its own as well as for
/// the subagents a session launches, and the island shows only the latter:
/// every one is written here, shown or not, so the two can be told apart and
/// counted (`agent=… type=""` is not a subagent of the session's).
fn subagent_note(event: &str, payload: &Value) -> Option<String> {
    let tool = payload.get("tool_name").and_then(Value::as_str).unwrap_or_default();
    let lifecycle = matches!(event, "SubagentStart" | "SubagentStop");
    let launch = matches!(event, "PreToolUse" | "PostToolUse" | "PostToolUseFailure") && AGENT_TOOLS.contains(&tool);
    if !lifecycle && !launch {
        return None;
    }
    let mut keys: Vec<&str> = payload.as_object()?.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let mut note = format!(" agent={} type={}", noted(payload.get("agent_id")), noted(payload.get("agent_type")));
    if launch {
        let input = payload.get("tool_input");
        note.push_str(&format!(
            " tool={tool} subagent_type={} launched={}",
            noted(input.and_then(|input| input.get("subagent_type"))),
            noted(payload.get("launched_agent")),
        ));
    }
    note.push_str(&format!(" keys=[{}]", keys.join(",")));
    Some(note)
}

async fn handle(app: AppHandle, mut pipe: impl Relay) {
    let Some(buf) = read_line(&mut pipe).await else {
        pipe.finish();
        return;
    };
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // Claude Code's status line, not a hook: the usage limits and the session's
    // model (usage.rs). It names no session to the island's session handling,
    // and nothing is noted of where it ran.
    if event == usage::EVENT {
        usage::receive(&app, &payload);
        pipe.finish();
        return;
    }

    // Where the session runs: kept here for the island's ↗, and told to the page
    // as a target in the place of the processes the relay named.
    let named = payload.get("ancestors").is_some();
    let target = app.state::<Sessions>().note(&mut payload, platform::EDITOR_FROM_ENV, |chain| {
        target::hosting_terminal(&platform::top_windows(), chain)
    });
    if named {
        log::line(format!("hook {event} runs in {}", if target.label.is_empty() { "an unknown place" } else { target.label }));
    }

    if event != "PermissionRequest" {
        log::line(format!("hook {event}{}", subagent_note(&event, &payload).unwrap_or_default()));
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
        pipe.finish();
        return;
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(id.clone(), tx);
    }
    payload["request_id"] = json!(id);
    log::line(format!("hook PermissionRequest id={id}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    let mut card = Card { app: app.clone(), up: false };
    let decision = wait_for_decision(&id, &mut rx, || card.raise()).await;
    app.state::<Pending>().0.lock().unwrap().remove(&id);
    // Over, however it ended: an island that came up for it may go.
    drop(card);

    // No decision: say nothing at all. nook-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Nook were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    pipe.finish();
}

/// A request whose card is up on the island, for as long as the relay waits for it:
/// a hidden island shows itself for it, and goes again once none is left
/// (visibility.rs). Dropped, so it ends with the wait whatever ends that — a
/// click, the terminal, a timeout, the task itself.
struct Card {
    app: AppHandle,
    up: bool,
}

impl Card {
    fn raise(&mut self) {
        if !self.up {
            self.up = true;
            visibility::request_up(&self.app);
        }
    }
}

impl Drop for Card {
    fn drop(&mut self) {
        if self.up {
            visibility::request_done(&self.app);
        }
    }
}

/// Two waits: a short one for "the card is up", then the long one for a human.
/// on_ack is called when it is.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>, on_ack: impl FnOnce()) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => on_ack(),
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {}", word(&d)));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {}", word(&d)));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

/// The first word of a reply — `allow`, `deny`, `answer` — and never what follows.
fn word(reply: &str) -> &str {
    reply.split(' ').next().unwrap_or_default()
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word: turning
/// it into Claude Code's JSON is nook-hook's job.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = match decision {
        "allow" => "allow",
        "skip" => "skip",
        "deny" => "deny",
        // Anything else is no answer: the terminal takes over.
        _ => return,
    };
    log::line(format!("decision id={request_id} {word}"));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

/// Called when the island answers a question Claude asked: what was picked,
/// keyed by the question's own words. nook-hook puts it back in the tool's
/// input, which is how Claude Code takes an answer.
pub fn answer_question(app: &AppHandle, request_id: &str, answers: &serde_json::Map<String, Value>) {
    log::line(format!("decision id={request_id} answer"));
    let line = format!("answer {}", Value::Object(answers.clone()));
    send(app, request_id, Reply::Decision(line), false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pipe_grants_only_the_user_and_system() {
        let sddl = sddl_for("S-1-5-21-1-2-3-1001");
        assert_eq!(sddl, "D:P(A;;GA;;;S-1-5-21-1-2-3-1001)(A;;GA;;;SY)");
        assert!(!sddl.contains("WD") && !sddl.contains("BU"));
    }

    #[test]
    fn the_log_says_which_agent_an_event_is_about_and_only_the_names_of_its_fields() {
        // A side agent of Claude Code's own stops: an id nothing launched, an empty type.
        let stop = json!({
            "hook_event_name": "SubagentStop", "session_id": "s", "cwd": "C:\\Users\\me\\secret project",
            "agent_id": "a9f3c1d2e4b5a6978", "agent_type": "", "last_message": "what it said", "background_tasks": [],
        });
        let note = subagent_note("SubagentStop", &stop).unwrap();
        assert_eq!(note, " agent=a9f3c1d2e4b5a6978 type=\"\" keys=[agent_id,agent_type,background_tasks,cwd,hook_event_name,last_message,session_id]");
        assert!(!note.contains("secret") && !note.contains("what it said"));

        // A real one starts; an event with no type at all says so.
        let start = json!({ "hook_event_name": "SubagentStart", "agent_id": "af3d8c03f03bd405d", "agent_type": "general-purpose" });
        assert!(subagent_note("SubagentStart", &start).unwrap().starts_with(" agent=af3d8c03f03bd405d type=general-purpose keys=["));
        assert!(subagent_note("SubagentStop", &json!({ "hook_event_name": "SubagentStop" })).unwrap().starts_with(" agent=- type=- "));

        // The call that launches one: its kind and the id it came back with, never what it was asked.
        let call = json!({
            "hook_event_name": "PostToolUse", "tool_name": "Agent", "launched_agent": "af3d8c03f03bd405d", "launched_async": true,
            "tool_input": { "description": "Count files", "prompt": "List the files in C:\\Users\\me", "subagent_type": "general-purpose" },
        });
        let note = subagent_note("PostToolUse", &call).unwrap();
        assert!(note.starts_with(" agent=- type=- tool=Agent subagent_type=general-purpose launched=af3d8c03f03bd405d keys=["));
        assert!(!note.contains("Count files") && !note.contains("List the files"));

        // Any other event has nothing more to say than its name.
        assert!(subagent_note("PreToolUse", &json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash" })).is_none());
        assert!(subagent_note("Stop", &json!({ "hook_event_name": "Stop" })).is_none());
        // Something that is no id is not written as it came.
        assert_eq!(noted(Some(&json!("an id\nwith a line break"))), "an?id?with?a?line?break");
        assert_eq!(noted(Some(&json!("x".repeat(200)))).len(), NOTE_CHARS);
    }
}