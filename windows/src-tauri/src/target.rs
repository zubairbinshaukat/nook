// Where a Claude Code session runs, and which window the island's ↗ goes to.
//
// nook-hook says what it knows on the events that start a session and a turn:
// `CLAUDE_CODE_ENTRYPOINT`, a few variables of the terminal, and — on Windows —
// the processes it was started under, each as a pid and an image name
// (`ancestors`, nearest first). From that, `decide` names one target, and the
// island shows the button that goes with it, or none.
//
// Nothing here trusts the page. The island asks for a session by its id; what
// is focused is worked out again from what the relay reported for that session,
// kept here, and every pid is checked to still be the program it was reported
// as before its window is touched — a pid is given out again once its process
// has gone. No command is ever built from a string of the payload: the only
// thing launched is a launcher of our own choosing, on a folder that exists.
//
// Everything in this file is pure: the windows, the processes and the clock
// are handed in. Win32 is in platform/windows.rs.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

/// A process the relay named: its id, and the name of its image.
#[derive(Clone, Debug, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Vscode,
    Cursor,
    Terminal,
    Claude,
    Unknown,
}

/// Where the ↗ of a session goes.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Target {
    pub kind: Kind,
    /// The process whose window it is, when one was named.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// What the app is called: "VS Code", "Windows Terminal", "PowerShell"…
    pub label: &'static str,
    /// A terminal with tabs: its window can be brought forward, the tab of
    /// the session cannot be picked from outside (see `terminal_window`).
    pub tabbed: bool,
}

impl Target {
    const fn new(kind: Kind, pid: Option<u32>, label: &'static str, tabbed: bool) -> Self {
        Self { kind, pid, label, tabbed }
    }

    pub const UNKNOWN: Target = Target::new(Kind::Unknown, None, "", false);
}

/// An editor Claude Code runs in: its image, what it is, what it is called, and
/// the launcher that opens a folder in it (found on PATH, never through a shell).
struct Editor {
    image: &'static str,
    kind: Kind,
    label: &'static str,
    launcher: &'static str,
}

/// Cursor is a fork of VS Code: it sets the same `TERM_PROGRAM=vscode`, and its
/// extension the same entry point. Only the image of the process tells them apart.
const EDITORS: &[Editor] = &[
    Editor { image: "code.exe", kind: Kind::Vscode, label: "VS Code", launcher: "code" },
    Editor { image: "code - insiders.exe", kind: Kind::Vscode, label: "VS Code Insiders", launcher: "code-insiders" },
    Editor { image: "cursor.exe", kind: Kind::Cursor, label: "Cursor", launcher: "cursor" },
];

pub const WINDOWS_TERMINAL: &str = "windowsterminal.exe";
const WINDOWS_TERMINAL_LABEL: &str = "Windows Terminal";

/// What a console window can belong to: a console's window answers for the
/// first program attached to it — the shell, or Claude itself when it was
/// started with no shell — and the name it is given here.
const CONSOLE_CLIENTS: &[(&str, &str)] = &[
    ("powershell.exe", "PowerShell"),
    ("pwsh.exe", "PowerShell"),
    ("cmd.exe", "Command Prompt"),
    ("claude.exe", "Terminal"),
];

/// Every name the relay may give an ancestor (hook/src/main.rs `HOST_NAMES` is
/// the same list). A chain with any other name in it is not the relay's.
const KNOWN_NAMES: &[&str] = &[
    "windowsterminal.exe", "code.exe", "code - insiders.exe", "cursor.exe",
    "powershell.exe", "pwsh.exe", "cmd.exe", "conhost.exe", "openconsole.exe",
    "claude.exe", "explorer.exe",
];

/// Ancestors read from one event at most.
const MAX_ANCESTORS: usize = 16;
/// Sessions remembered at once; past that, the one heard from longest ago goes.
const MAX_SESSIONS: usize = 32;
/// The id of a session whose hooks carry none (island/hooks.ts `ANONYMOUS`).
const ANONYMOUS: &str = "session";
/// How the Agent SDK names itself as an entry point: "sdk-ts", "sdk-py", "sdk-cli".
const SDK_ENTRYPOINT: &str = "sdk";
/// How many folders up from the session's own a window's title is looked for.
const FOLDER_DEPTH: usize = 4;

fn editor_of(name: &str) -> Option<&'static Editor> {
    let name = name.to_lowercase();
    EDITORS.iter().find(|e| e.image == name)
}

fn console_client(name: &str) -> Option<&'static str> {
    let name = name.to_lowercase();
    CONSOLE_CLIENTS.iter().find(|(image, _)| *image == name).map(|(_, label)| *label)
}

fn is_windows_terminal(name: &str) -> bool {
    name.eq_ignore_ascii_case(WINDOWS_TERMINAL)
}

/// What an event says of where its session runs.
#[derive(Clone, Copy, Debug, Default)]
pub struct Context<'a> {
    /// `CLAUDE_CODE_ENTRYPOINT`: "cli", "claude-vscode", "claude-desktop", "sdk-ts"…
    pub entrypoint: &'a str,
    /// `TERM_PROGRAM`: "vscode" in the integrated terminal of VS Code and of Cursor.
    pub term_program: &'a str,
    /// `WT_SESSION`: set by Windows Terminal in what it starts.
    pub wt_session: &'a str,
    /// The processes above the relay, nearest first. Empty on Linux, and until
    /// an event that carries them has come.
    pub ancestors: &'a [Proc],
    /// The environment alone may name the editor. True on Linux, where the
    /// relay reports no ancestors; false on Windows, where VS Code and Cursor
    /// say the same things and only the process tells which it is.
    pub editor_from_env: bool,
}

/// The one place that says where a session runs.
///
/// | # | What is known                                                        | Target                                   |
/// |---|----------------------------------------------------------------------|------------------------------------------|
/// | 1 | entry point is the Agent SDK (`sdk-…`): no person is in it           | unknown                                  |
/// | 2 | entry point is the desktop app (`claude-desktop`)                    | claude · "Claude"                        |
/// | 3 | nearest host above is `Code.exe` — the extension (claude ← Code) or  | vscode · "VS Code" · the outermost       |
/// |   | the integrated terminal (claude ← shell ← Code)                      | `Code.exe` of the run: it owns the windows |
/// | 4 | nearest host above is `Cursor.exe`, extension or terminal alike      | cursor · "Cursor" · likewise             |
/// | 5 | nearest host above is `WindowsTerminal.exe`, whatever shell it hosts | terminal · "Windows Terminal" · tabbed   |
/// | 6 | no host above, but a shell (or Claude alone): a console window of    | terminal · "PowerShell" / "Command       |
/// |   | its own…                                                             | Prompt" / "Terminal" · the outermost of them |
/// | 6b| …unless `WT_SESSION` is set: Windows Terminal hosts it from aside    | terminal · "Windows Terminal" · tabbed   |
/// | 7 | no ancestor named, the environment says VS Code (`claude-vscode`,    | vscode · "VS Code", no pid — where       |
/// |   | `TERM_PROGRAM=vscode`)                                               | `editor_from_env`; unknown otherwise     |
/// | 8 | anything else                                                        | unknown                                  |
///
/// "Host" is a program that owns the window: an editor, or Windows Terminal.
/// The nearest one wins — Windows Terminal started from VS Code's terminal is
/// Windows Terminal. Shells on the way are passed over.
pub fn decide(ctx: &Context) -> Target {
    let entry = ctx.entrypoint.to_lowercase();
    if entry.starts_with(SDK_ENTRYPOINT) {
        return Target::UNKNOWN;
    }
    if entry.contains("desktop") {
        return Target::new(Kind::Claude, None, "Claude", false);
    }

    let chain = ctx.ancestors;
    for (at, ancestor) in chain.iter().enumerate() {
        if let Some(editor) = editor_of(&ancestor.name) {
            // The window belongs to the editor's main process: the last of
            // the editor's own processes on the way up.
            let main = chain[at..].iter().take_while(|p| editor_of(&p.name).is_some_and(|e| e.image == editor.image)).last();
            return Target::new(editor.kind, main.map(|p| p.pid), editor.label, false);
        }
        if is_windows_terminal(&ancestor.name) {
            return Target::new(Kind::Terminal, Some(ancestor.pid), WINDOWS_TERMINAL_LABEL, true);
        }
    }

    // No host: a console window, which answers for the first program in it.
    let outermost = chain.iter().rev().find_map(|p| console_client(&p.name).map(|label| (p.pid, label)));
    if let Some((pid, label)) = outermost {
        return if ctx.wt_session.trim().is_empty() {
            Target::new(Kind::Terminal, Some(pid), label, false)
        } else {
            Target::new(Kind::Terminal, Some(pid), WINDOWS_TERMINAL_LABEL, true)
        };
    }

    let says_vscode = entry.contains("vscode") || ctx.term_program.to_lowercase().contains("vscode");
    if chain.is_empty() && ctx.editor_from_env && says_vscode {
        return Target::new(Kind::Vscode, None, "VS Code", false);
    }
    Target::UNKNOWN
}

/// The launcher that opens a folder in the editor a target names.
pub fn launcher_of(target: &Target) -> Option<&'static str> {
    EDITORS.iter().find(|e| e.kind == target.kind && e.label == target.label).map(|e| e.launcher)
}

/// The image of the editor a target names, in lower case.
pub fn editor_image(target: &Target) -> Option<&'static str> {
    EDITORS.iter().find(|e| e.kind == target.kind && e.label == target.label).map(|e| e.image)
}

/// The `ancestors` of an event, as the relay writes them: a short list of
/// `{ pid, name }`, every name one the relay knows. Anything else — a field
/// that is no list, a name with a path in it, a pid that is none — and the
/// whole chain is refused: half a chain could put the wrong host nearest.
pub fn parse_ancestors(value: &Value) -> Option<Vec<Proc>> {
    let list = value.as_array()?;
    if list.is_empty() || list.len() > MAX_ANCESTORS {
        return None;
    }
    let mut chain = Vec::with_capacity(list.len());
    for entry in list {
        let pid = u32::try_from(entry.get("pid")?.as_u64()?).ok().filter(|pid| *pid != 0)?;
        let name = entry.get("name")?.as_str()?;
        if !KNOWN_NAMES.contains(&name.to_lowercase().as_str()) || chain.iter().any(|p: &Proc| p.pid == pid) {
            return None;
        }
        chain.push(Proc { pid, name: name.to_string() });
    }
    Some(chain)
}

/// Of a chain, the processes that are still what they were reported as:
/// `image_of` gives the name of the image a pid runs today.
pub fn still_there(chain: &[Proc], image_of: impl Fn(u32) -> Option<String>) -> Vec<Proc> {
    chain
        .iter()
        .filter(|p| image_of(p.pid).is_some_and(|image| image.eq_ignore_ascii_case(&p.name)))
        .cloned()
        .collect()
}

// ── What is remembered of each session ────────────────────────────────────────

/// What the relay reported for one session.
#[derive(Clone, Debug)]
struct Host {
    chain: Vec<Proc>,
    target: Target,
    cwd: Option<String>,
    heard: u64,
}

/// What it takes to go to a session: its target, the chain it was decided
/// from, and its folder.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub target: Target,
    pub chain: Vec<Proc>,
    pub cwd: Option<String>,
}

/// The sessions heard from, by id.
#[derive(Default)]
pub struct Sessions {
    known: Mutex<(HashMap<String, Host>, u64)>,
}

impl Sessions {
    /// One event goes by. What it says of where its session runs is kept, and
    /// the event leaves with the session's `target` in the place of the raw
    /// `ancestors` — the page has no use for pids.
    ///
    /// `host_of` is asked, when a new chain has no host in it, whether a
    /// terminal hosts one of its console programs from aside (Windows Terminal
    /// taking over a console it did not start): that terminal, if any.
    pub fn note(&self, payload: &mut Value, editor_from_env: bool, host_of: impl Fn(&[Proc]) -> Option<Proc>) -> Target {
        let Some(map) = payload.as_object_mut() else { return Target::UNKNOWN };
        let text = |map: &serde_json::Map<String, Value>, key: &str| map.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let id = Some(text(map, "session_id")).filter(|id| !id.is_empty()).unwrap_or_else(|| ANONYMOUS.to_string());
        let reported = map.remove("ancestors").as_ref().and_then(parse_ancestors);
        // Whatever came under that name is not ours.
        map.remove("target");

        let mut guard = self.known.lock().unwrap();
        let (known, clock) = &mut *guard;
        if text(map, "hook_event_name") == "SessionEnd" {
            known.remove(&id);
            return Target::UNKNOWN;
        }

        let chain = match reported {
            Some(mut chain) => {
                let hosted = chain.iter().any(|p| editor_of(&p.name).is_some() || is_windows_terminal(&p.name));
                if !hosted {
                    let host = host_of(&chain);
                    chain.extend(host);
                }
                chain
            }
            None => known.get(&id).map(|host| host.chain.clone()).unwrap_or_default(),
        };
        let target = decide(&Context {
            entrypoint: &text(map, "entrypoint"),
            term_program: &text(map, "term_program"),
            wt_session: &text(map, "wt_session"),
            ancestors: &chain,
            editor_from_env,
        });
        let cwd = Some(text(map, "cwd")).filter(|cwd| !cwd.is_empty()).or_else(|| known.get(&id).and_then(|host| host.cwd.clone()));

        *clock += 1;
        known.insert(id, Host { chain, target: target.clone(), cwd, heard: *clock });
        while known.len() > MAX_SESSIONS {
            let Some(oldest) = known.iter().min_by_key(|(_, host)| host.heard).map(|(id, _)| id.clone()) else { break };
            known.remove(&oldest);
        }

        map.insert("target".into(), json!(target));
        target
    }

    /// The way to a session the island asks for by its id — or none: a session
    /// never heard from, or one nothing is known about, goes nowhere.
    pub fn plan(&self, session_id: &str) -> Option<Plan> {
        let guard = self.known.lock().unwrap();
        let host = guard.0.get(session_id)?;
        (host.target.kind != Kind::Unknown).then(|| Plan { target: host.target.clone(), chain: host.chain.clone(), cwd: host.cwd.clone() })
    }
}

// ── Picking the window ────────────────────────────────────────────────────────

/// A top-level window, as the system lists it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Window {
    pub hwnd: isize,
    pub pid: u32,
    /// The image of the process it answers for, in lower case; empty when unknown.
    pub image: String,
    pub class: String,
    pub title: String,
    pub visible: bool,
    /// The window that owns it; 0 for none.
    pub owner: isize,
}

/// The window Windows Terminal — and any terminal built on the same console
/// host — gives each console it hosts: hidden in effect, owned by the
/// terminal's own window, and answering for the console's first program.
const PSEUDO_CONSOLE_CLASS: &str = "PseudoConsoleWindow";
/// The window of a console that has one of its own.
const CONSOLE_CLASS: &str = "ConsoleWindowClass";

/// What a user would call a window: on screen, nobody else's, with a title.
fn is_main(window: &Window) -> bool {
    window.visible && window.owner == 0 && !window.title.trim().is_empty()
}

/// True when a title names a folder as one of its parts: VS Code and Cursor
/// write "file - folder - Visual Studio Code", the folder sometimes followed
/// by what it is ("nook (Workspace)", "nook [WSL: Ubuntu]").
fn title_names(title: &str, folder: &str) -> bool {
    let folder = folder.to_lowercase();
    title.to_lowercase().split(" - ").flat_map(|part| part.split(" — ")).any(|part| {
        let part = part.trim();
        part == folder || part.strip_prefix(folder.as_str()).is_some_and(|rest| rest.starts_with(" (") || rest.starts_with(" ["))
    })
}

/// The names of a folder and of those above it, the folder's own first.
fn folder_names(cwd: &str) -> Vec<String> {
    cwd.split(['\\', '/'])
        .filter(|part| !part.is_empty() && !part.ends_with(':'))
        .rev()
        .take(FOLDER_DEPTH)
        .map(str::to_string)
        .collect()
}

/// The window of an editor to bring forward for a session. `windows` is every
/// top-level window, the one last used first; `image` the editor's.
///
/// 1. the window whose title names the session's folder;
/// 2. the one whose title has that name anywhere in it;
/// 3. the one whose title names a folder above the session's — a session
///    started in a subfolder of the workspace;
/// 4. a window of the very process the relay named.
///
/// Among several that match, the one last used. None when the editor has no
/// window at all: the caller then opens the folder with the editor's launcher.
pub fn editor_window(windows: &[Window], image: &str, cwd: Option<&str>, pids: &[u32]) -> Option<isize> {
    let family: Vec<&Window> = windows.iter().filter(|w| is_main(w) && w.image.eq_ignore_ascii_case(image)).collect();
    let names = cwd.map(folder_names).unwrap_or_default();
    let named = |name: &String| family.iter().find(|w| title_names(&w.title, name));
    let leaf = names.first();
    leaf.and_then(named)
        .or_else(|| leaf.and_then(|name| family.iter().find(|w| w.title.to_lowercase().contains(&name.to_lowercase()))))
        .or_else(|| names.iter().skip(1).find_map(named))
        .or_else(|| family.iter().find(|w| pids.contains(&w.pid)))
        .map(|w| w.hwnd)
}

/// The Windows Terminal that hosts one of `clients` — the pids of a session's
/// console programs — through the pseudo-console window it owns for it.
fn hosting_window<'a>(windows: &'a [Window], clients: &[u32]) -> Option<&'a Window> {
    windows
        .iter()
        .filter(|w| w.class == PSEUDO_CONSOLE_CLASS && w.owner != 0 && clients.contains(&w.pid))
        .find_map(|pseudo| windows.iter().find(|w| w.hwnd == pseudo.owner && w.visible && is_windows_terminal(&w.image)))
}

/// The terminal that hosts a session without having started it, if one does:
/// what `Sessions::note` adds to a chain with no host in it.
pub fn hosting_terminal(windows: &[Window], chain: &[Proc]) -> Option<Proc> {
    let clients: Vec<u32> = chain.iter().filter(|p| console_client(&p.name).is_some()).map(|p| p.pid).collect();
    hosting_window(windows, &clients).map(|w| Proc { pid: w.pid, name: "WindowsTerminal.exe".to_string() })
}

/// The window of a terminal to bring forward for a session. `chain` is what
/// is left of the session's ancestors once each was checked to still be there.
///
/// 1. The Windows Terminal window that owns the pseudo-console of one of the
///    session's console programs: the very window the session is in, even
///    with several Windows Terminal windows open, or one that did not start
///    the shell.
/// 2. A console window of its own, which answers for one of those programs.
/// 3. A window of the Windows Terminal process the relay named: the one whose
///    title has the session's folder in it, else the one last used.
///
/// The *tab* is out of reach. Windows Terminal has `wt -w <window> focus-tab
/// -t <index>`, but nothing gives, from outside, the window's id or the index
/// of the tab a `WT_SESSION` is in; its accessibility tree lists the tabs by
/// their titles only, which a program changes at will and two tabs can share.
/// So the window comes forward on whatever tab it was on, and the island says
/// which tab to look for.
pub fn terminal_window(windows: &[Window], chain: &[Proc], cwd: Option<&str>) -> Option<isize> {
    let clients: Vec<u32> = chain.iter().filter(|p| console_client(&p.name).is_some()).map(|p| p.pid).collect();
    if let Some(window) = hosting_window(windows, &clients) {
        return Some(window.hwnd);
    }
    if let Some(console) = windows.iter().find(|w| w.class == CONSOLE_CLASS && w.visible && clients.contains(&w.pid)) {
        return Some(console.hwnd);
    }
    let terminal = chain.iter().find(|p| is_windows_terminal(&p.name))?;
    let theirs: Vec<&Window> = windows.iter().filter(|w| is_main(w) && w.pid == terminal.pid).collect();
    let folder = cwd.map(folder_names).unwrap_or_default().into_iter().next().map(|name| name.to_lowercase());
    folder
        .and_then(|name| theirs.iter().find(|w| w.title.to_lowercase().contains(&name)))
        .or(theirs.first())
        .map(|w| w.hwnd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, name: &str) -> Proc {
        Proc { pid, name: name.to_string() }
    }

    /// The target of a session on Windows: the chain is what tells.
    fn windows(entrypoint: &str, term_program: &str, wt_session: &str, ancestors: &[Proc]) -> Target {
        decide(&Context { entrypoint, term_program, wt_session, ancestors, editor_from_env: false })
    }

    fn target(kind: Kind, pid: Option<u32>, label: &'static str, tabbed: bool) -> Target {
        Target { kind, pid, label, tabbed }
    }

    #[test]
    fn row_1_a_session_run_by_a_program_goes_nowhere() {
        let chain = [p(10, "claude.exe"), p(11, "Code.exe")];
        for entry in ["sdk-ts", "sdk-py", "SDK-cli"] {
            assert_eq!(windows(entry, "vscode", "", &chain), Target::UNKNOWN);
        }
    }

    #[test]
    fn row_2_the_desktop_app_is_claude_whatever_is_above() {
        let chain = [p(10, "claude.exe"), p(11, "claude.exe"), p(12, "explorer.exe")];
        assert_eq!(windows("claude-desktop", "", "", &chain), target(Kind::Claude, None, "Claude", false));
        assert_eq!(windows("claude-desktop", "", "", &[]), target(Kind::Claude, None, "Claude", false));
    }

    #[test]
    fn row_3_vs_code_by_its_extension_and_by_its_terminal() {
        // The extension: Claude is started by the extension host, itself a Code.exe.
        let extension = [p(10, "claude.exe"), p(20, "Code.exe"), p(21, "Code.exe"), p(1, "explorer.exe")];
        assert_eq!(windows("claude-vscode", "", "", &extension), target(Kind::Vscode, Some(21), "VS Code", false));
        // The integrated terminal: a shell between the two, and the same answer.
        let terminal = [p(10, "claude.exe"), p(15, "pwsh.exe"), p(20, "Code.exe"), p(21, "Code.exe"), p(1, "explorer.exe")];
        assert_eq!(windows("cli", "vscode", "", &terminal), target(Kind::Vscode, Some(21), "VS Code", false));
        assert_eq!(windows("cli", "vscode", "", &[p(15, "cmd.exe"), p(20, "code.exe")]), target(Kind::Vscode, Some(20), "VS Code", false));
        // Insiders is VS Code under its own name.
        let insiders = windows("claude-vscode", "", "", &[p(10, "claude.exe"), p(30, "Code - Insiders.exe")]);
        assert_eq!(insiders, target(Kind::Vscode, Some(30), "VS Code Insiders", false));
        assert_eq!(launcher_of(&insiders), Some("code-insiders"));
    }

    #[test]
    fn row_4_cursor_is_told_from_vs_code_by_its_process_alone() {
        // Everything else says "vscode", as it does in Cursor.
        let extension = [p(10, "claude.exe"), p(40, "Cursor.exe"), p(41, "Cursor.exe"), p(1, "explorer.exe")];
        let found = windows("claude-vscode", "vscode", "", &extension);
        assert_eq!(found, target(Kind::Cursor, Some(41), "Cursor", false));
        assert_eq!((launcher_of(&found), editor_image(&found)), (Some("cursor"), Some("cursor.exe")));
        let terminal = [p(10, "claude.exe"), p(15, "powershell.exe"), p(40, "Cursor.exe"), p(41, "Cursor.exe")];
        assert_eq!(windows("cli", "vscode", "", &terminal), target(Kind::Cursor, Some(41), "Cursor", false));
    }

    #[test]
    fn row_5_windows_terminal_whatever_shell_it_hosts() {
        for shell in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
            let chain = [p(10, "claude.exe"), p(15, shell), p(50, "WindowsTerminal.exe"), p(1, "explorer.exe")];
            assert_eq!(windows("cli", "", "guid", &chain), target(Kind::Terminal, Some(50), "Windows Terminal", true));
        }
        // The nearest host wins: Windows Terminal started from VS Code's terminal is Windows Terminal…
        let nested = [p(10, "claude.exe"), p(15, "pwsh.exe"), p(50, "WindowsTerminal.exe"), p(16, "pwsh.exe"), p(20, "Code.exe")];
        assert_eq!(windows("cli", "vscode", "guid", &nested).label, "Windows Terminal");
        // …and VS Code started from Windows Terminal (`code .`) is VS Code.
        let other = [p(10, "claude.exe"), p(20, "Code.exe"), p(15, "pwsh.exe"), p(50, "WindowsTerminal.exe")];
        assert_eq!(windows("claude-vscode", "", "guid", &other), target(Kind::Vscode, Some(20), "VS Code", false));
    }

    #[test]
    fn row_6_a_console_window_of_its_own_is_named_by_its_first_program() {
        let powershell = [p(10, "claude.exe"), p(15, "powershell.exe"), p(1, "explorer.exe")];
        assert_eq!(windows("cli", "", "", &powershell), target(Kind::Terminal, Some(15), "PowerShell", false));
        let pwsh = [p(10, "claude.exe"), p(15, "pwsh.exe"), p(1, "explorer.exe")];
        assert_eq!(windows("cli", "", "", &pwsh), target(Kind::Terminal, Some(15), "PowerShell", false));
        // PowerShell started from cmd: the window is cmd's.
        let cmd = [p(10, "claude.exe"), p(15, "pwsh.exe"), p(16, "cmd.exe"), p(1, "explorer.exe")];
        assert_eq!(windows("cli", "", "", &cmd), target(Kind::Terminal, Some(16), "Command Prompt", false));
        // Claude with no shell at all.
        assert_eq!(windows("cli", "", "", &[p(10, "claude.exe"), p(1, "explorer.exe")]), target(Kind::Terminal, Some(10), "Terminal", false));
        // 6b: no Windows Terminal above, yet it is what set the session up.
        assert_eq!(windows("cli", "", "guid", &powershell), target(Kind::Terminal, Some(15), "Windows Terminal", true));
    }

    #[test]
    fn row_7_the_environment_names_an_editor_only_where_nothing_else_can() {
        let linux = |entrypoint: &str, term_program: &str| {
            decide(&Context { entrypoint, term_program, wt_session: "", ancestors: &[], editor_from_env: true })
        };
        assert_eq!(linux("claude-vscode", ""), target(Kind::Vscode, None, "VS Code", false));
        assert_eq!(linux("cli", "vscode"), target(Kind::Vscode, None, "VS Code", false));
        // A terminal nobody named is no target, and the desktop app is itself everywhere.
        assert_eq!(linux("cli", "xterm"), Target::UNKNOWN);
        assert_eq!(linux("claude-desktop", "").kind, Kind::Claude);
        // On Windows the same words could be Cursor's: nothing is said until the chain comes.
        assert_eq!(windows("claude-vscode", "vscode", "", &[]), Target::UNKNOWN);
        assert_eq!(windows("cli", "vscode", "", &[]), Target::UNKNOWN);
    }

    #[test]
    fn row_8_anything_else_is_unknown() {
        assert_eq!(windows("cli", "", "", &[]), Target::UNKNOWN);
        assert_eq!(windows("", "", "", &[]), Target::UNKNOWN);
        // Only the desktop above, or programs that own no window of the session.
        assert_eq!(windows("cli", "", "", &[p(1, "explorer.exe")]), Target::UNKNOWN);
        assert_eq!(windows("cli", "", "", &[p(2, "conhost.exe"), p(1, "explorer.exe")]), Target::UNKNOWN);
        // An entry point that says VS Code with a chain that does not: the chain is what is there.
        assert_eq!(windows("claude-vscode", "", "", &[p(1, "explorer.exe")]), Target::UNKNOWN);
        assert_eq!(launcher_of(&Target::UNKNOWN), None);
    }

    #[test]
    fn a_chain_is_read_whole_or_not_at_all() {
        let good = json!([{ "pid": 10, "name": "claude.exe" }, { "pid": 15, "name": "pwsh.exe" }, { "pid": 50, "name": "WindowsTerminal.exe" }]);
        assert_eq!(parse_ancestors(&good).unwrap(), vec![p(10, "claude.exe"), p(15, "pwsh.exe"), p(50, "WindowsTerminal.exe")]);
        for bad in [
            json!("WindowsTerminal.exe"),
            json!([]),
            json!([{ "pid": 10 }]),
            json!([{ "name": "cmd.exe" }]),
            json!([{ "pid": 0, "name": "cmd.exe" }]),
            json!([{ "pid": -4, "name": "cmd.exe" }]),
            json!([{ "pid": 4_294_967_296u64, "name": "cmd.exe" }]),
            json!([{ "pid": "10", "name": "cmd.exe" }]),
            json!([{ "pid": 10, "name": 7 }]),
            // A name that is not one of the relay's: a path, another program, a command.
            json!([{ "pid": 10, "name": "C:\\Windows\\System32\\cmd.exe" }]),
            json!([{ "pid": 10, "name": "notepad.exe" }]),
            json!([{ "pid": 10, "name": "cmd.exe /c calc" }]),
            // One bad link refuses the chain, and so does a pid named twice.
            json!([{ "pid": 10, "name": "claude.exe" }, { "pid": 11, "name": "evil.exe" }, { "pid": 12, "name": "Code.exe" }]),
            json!([{ "pid": 10, "name": "cmd.exe" }, { "pid": 10, "name": "Code.exe" }]),
        ] {
            assert!(parse_ancestors(&bad).is_none(), "{bad} must be refused");
        }
        let long: Vec<Value> = (1..=MAX_ANCESTORS as u32 + 1).map(|pid| json!({ "pid": pid, "name": "cmd.exe" })).collect();
        assert!(parse_ancestors(&Value::Array(long)).is_none());
    }

    #[test]
    fn a_pid_that_changed_hands_is_dropped() {
        let chain = [p(10, "claude.exe"), p(15, "pwsh.exe"), p(50, "WindowsTerminal.exe")];
        let today = |pid: u32| match pid {
            10 => Some("CLAUDE.EXE".to_string()),
            // The shell has gone, and its pid went to somebody else.
            15 => Some("chrome.exe".to_string()),
            _ => None,
        };
        assert_eq!(still_there(&chain, today), vec![p(10, "claude.exe")]);
        assert!(still_there(&chain, |_| None).is_empty());
    }

    fn event(session: &str, name: &str, extra: Value) -> Value {
        let mut payload = json!({ "session_id": session, "hook_event_name": name, "cwd": "D:\\work\\nook", "entrypoint": "cli", "term_program": "", "wt_session": "" });
        payload.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        payload
    }

    fn nobody(_: &[Proc]) -> Option<Proc> {
        None
    }

    #[test]
    fn a_session_is_gone_to_by_what_the_relay_said_of_it_and_nothing_else() {
        let sessions = Sessions::default();
        // Never heard from: nowhere to go, whatever id the page sends.
        assert!(sessions.plan("a").is_none());
        assert!(sessions.plan("").is_none());

        // An event with no chain yet: heard from, and still nowhere to go.
        let mut first = event("a", "PreToolUse", json!({}));
        assert_eq!(sessions.note(&mut first, false, nobody), Target::UNKNOWN);
        assert_eq!(first["target"], json!({ "kind": "unknown", "label": "", "tabbed": false }));
        assert!(sessions.plan("a").is_none());

        // The chain comes: the event leaves with its target and without the pids' list.
        let chain = json!([{ "pid": 10, "name": "claude.exe" }, { "pid": 15, "name": "pwsh.exe" }, { "pid": 50, "name": "WindowsTerminal.exe" }]);
        let mut prompt = event("a", "UserPromptSubmit", json!({ "ancestors": chain, "wt_session": "guid" }));
        sessions.note(&mut prompt, false, nobody);
        assert_eq!(prompt["target"], json!({ "kind": "terminal", "pid": 50, "label": "Windows Terminal", "tabbed": true }));
        assert!(prompt.get("ancestors").is_none());
        let plan = sessions.plan("a").unwrap();
        assert_eq!(plan.target.pid, Some(50));
        assert_eq!(plan.chain.len(), 3);
        assert_eq!(plan.cwd.as_deref(), Some("D:\\work\\nook"));

        // The events that follow carry no chain: the session keeps the one it has.
        let mut tool = event("a", "PreToolUse", json!({ "wt_session": "guid", "cwd": "D:\\work\\nook\\windows" }));
        assert_eq!(sessions.note(&mut tool, false, nobody).label, "Windows Terminal");
        assert_eq!(sessions.plan("a").unwrap().cwd.as_deref(), Some("D:\\work\\nook\\windows"));
        // Another session is another target, and knows nothing of the first one's.
        assert!(sessions.plan("b").is_none());

        // A target the page made up changes nothing: what goes out is ours.
        let mut forged = event("b", "PreToolUse", json!({ "target": { "kind": "vscode", "pid": 4, "label": "VS Code" } }));
        sessions.note(&mut forged, false, nobody);
        assert_eq!(forged["target"]["kind"], "unknown");
        // So does a chain that is not the relay's.
        let mut bad = event("b", "SessionStart", json!({ "ancestors": [{ "pid": 4, "name": "calc.exe" }] }));
        sessions.note(&mut bad, false, nobody);
        assert!(sessions.plan("b").is_none() && bad.get("ancestors").is_none());

        // The session ends: it is forgotten.
        let mut end = event("a", "SessionEnd", json!({ "target": { "kind": "claude", "label": "Claude" } }));
        sessions.note(&mut end, false, nobody);
        assert!(sessions.plan("a").is_none() && end.get("target").is_none());
    }

    #[test]
    fn a_session_with_no_id_and_too_many_sessions() {
        let sessions = Sessions::default();
        let chain = json!([{ "pid": 10, "name": "claude.exe" }, { "pid": 20, "name": "Code.exe" }]);
        let mut anonymous = json!({ "hook_event_name": "SessionStart", "entrypoint": "claude-vscode", "ancestors": chain });
        sessions.note(&mut anonymous, false, nobody);
        assert_eq!(sessions.plan(ANONYMOUS).unwrap().target.kind, Kind::Vscode);
        // No folder was said: there is none to open.
        assert_eq!(sessions.plan(ANONYMOUS).unwrap().cwd, None);

        for n in 0..MAX_SESSIONS {
            sessions.note(&mut event(&format!("s{n}"), "SessionStart", json!({ "entrypoint": "claude-desktop" })), false, nobody);
        }
        // The one heard from longest ago gave its place.
        assert!(sessions.plan(ANONYMOUS).is_none());
        assert!(sessions.plan("s0").is_some() && sessions.plan(&format!("s{}", MAX_SESSIONS - 1)).is_some());
        // Not an object: nothing to read, nothing kept.
        assert_eq!(sessions.note(&mut json!("hello"), false, nobody), Target::UNKNOWN);
    }

    #[test]
    fn a_terminal_that_hosts_the_shell_from_aside_is_found_when_the_chain_comes() {
        let sessions = Sessions::default();
        let chain = json!([{ "pid": 10, "name": "claude.exe" }, { "pid": 15, "name": "powershell.exe" }, { "pid": 1, "name": "explorer.exe" }]);
        let host = |chain: &[Proc]| chain.iter().any(|p| p.pid == 15).then(|| p(50, "WindowsTerminal.exe"));
        let mut start = event("a", "SessionStart", json!({ "ancestors": chain.clone() }));
        assert_eq!(sessions.note(&mut start, false, host), target(Kind::Terminal, Some(50), "Windows Terminal", true));
        // With none, the console is the shell's own.
        let mut bare = event("b", "SessionStart", json!({ "ancestors": chain }));
        assert_eq!(sessions.note(&mut bare, false, nobody), target(Kind::Terminal, Some(15), "PowerShell", false));
        // A chain that has its host is not asked about.
        let hosted = json!([{ "pid": 10, "name": "claude.exe" }, { "pid": 20, "name": "Cursor.exe" }]);
        let mut cursor = event("c", "SessionStart", json!({ "ancestors": hosted }));
        assert_eq!(sessions.note(&mut cursor, false, |_| panic!("not asked")).kind, Kind::Cursor);
    }

    fn window(hwnd: isize, pid: u32, image: &str, title: &str) -> Window {
        Window { hwnd, pid, image: image.to_string(), class: "Chrome_WidgetWin_1".to_string(), title: title.to_string(), visible: true, owner: 0 }
    }

    #[test]
    fn an_editor_comes_forward_on_the_window_of_the_sessions_folder() {
        let windows = [
            window(1, 21, "code.exe", "main.rs - atlas - Visual Studio Code"),
            window(2, 21, "code.exe", "hooks.ts - nook - Visual Studio Code"),
            window(3, 21, "code.exe", "notes.md - nook-site (Workspace) - Visual Studio Code"),
            window(4, 41, "cursor.exe", "island.ts - nook - Cursor"),
            window(5, 90, "chrome.exe", "nook - Google Chrome"),
        ];
        let pick = |image: &str, cwd: &str| editor_window(&windows, image, Some(cwd), &[21]);
        assert_eq!(pick("code.exe", "D:\\work\\nook"), Some(2));
        assert_eq!(pick("code.exe", "D:\\work\\atlas"), Some(1));
        assert_eq!(pick("code.exe", "D:/work/nook-site"), Some(3));
        // Cursor's window, not VS Code's on the same folder — and never another program's.
        assert_eq!(editor_window(&windows, "cursor.exe", Some("D:\\work\\nook"), &[41]), Some(4));
        // A session in a subfolder of the workspace: the folder above is in the title.
        assert_eq!(pick("code.exe", "D:\\work\\nook\\windows"), Some(2));
        // No title says anything of it: the window of the process named, the one last used.
        assert_eq!(pick("code.exe", "C:\\elsewhere\\project"), Some(1));
        assert_eq!(editor_window(&windows, "code.exe", None, &[21]), Some(1));
        // Not that process's, not a window of its folder: none, and the launcher takes over.
        assert_eq!(editor_window(&windows, "code.exe", Some("C:\\elsewhere\\project"), &[77]), None);
        assert_eq!(editor_window(&[], "code.exe", Some("D:\\work\\nook"), &[21]), None);
    }

    #[test]
    fn only_a_real_window_of_the_editor_counts() {
        let mut hidden = window(1, 21, "code.exe", "nook - Visual Studio Code");
        hidden.visible = false;
        let mut owned = window(2, 21, "code.exe", "nook - Visual Studio Code");
        owned.owner = 9;
        let untitled = window(3, 21, "code.exe", " ");
        assert_eq!(editor_window(&[hidden, owned, untitled], "code.exe", Some("D:\\nook"), &[21]), None);
        // A title is read by its parts: "nook" is not "nook-hook", though it is in it.
        let near = [window(1, 21, "code.exe", "a.rs - nook-hook - Visual Studio Code"), window(2, 21, "code.exe", "b.rs - nook - Visual Studio Code")];
        assert_eq!(editor_window(&near, "code.exe", Some("D:\\nook"), &[21]), Some(2));
        // With no window of that very folder, the name anywhere in a title will do.
        assert_eq!(editor_window(&near[..1], "code.exe", Some("D:\\nook"), &[]), Some(1));
        assert!(title_names("x — nook [WSL: Ubuntu] — Visual Studio Code", "Nook"));
        assert!(!title_names("x - nookery - Visual Studio Code", "nook"));
        assert_eq!(folder_names("C:\\Users\\me\\code\\nook\\windows\\src"), ["src", "windows", "nook", "code"]);
    }

    fn pseudo(hwnd: isize, pid: u32, owner: isize) -> Window {
        Window { hwnd, pid, image: "pwsh.exe".to_string(), class: PSEUDO_CONSOLE_CLASS.to_string(), title: String::new(), visible: true, owner }
    }

    #[test]
    fn a_terminal_comes_forward_on_the_window_that_hosts_the_session() {
        let terminal = |hwnd: isize, title: &str| Window { class: "CASCADIA_HOSTING_WINDOW_CLASS".to_string(), ..window(hwnd, 50, "windowsterminal.exe", title) };
        // Two Windows Terminal windows of one process: the session's shell is in the second.
        let windows = [terminal(1, "atlas"), terminal(2, "Nook setup"), pseudo(11, 14, 1), pseudo(12, 15, 2)];
        let chain = [p(10, "claude.exe"), p(15, "pwsh.exe"), p(50, "WindowsTerminal.exe")];
        assert_eq!(terminal_window(&windows, &chain, Some("D:\\work\\atlas")), Some(2));
        // Windows Terminal hosts a shell it did not start: found all the same, and named.
        let aside = [p(10, "claude.exe"), p(15, "powershell.exe"), p(1, "explorer.exe")];
        assert_eq!(terminal_window(&windows, &aside, None), Some(2));
        assert_eq!(hosting_terminal(&windows, &aside), Some(p(50, "WindowsTerminal.exe")));
        // A pseudo-console owned by something that is not Windows Terminal leads nowhere.
        let stranger = [window(3, 60, "evil.exe", "Terminal"), pseudo(13, 15, 3)];
        assert_eq!(terminal_window(&stranger, &aside, None), None);
        assert_eq!(hosting_terminal(&stranger, &aside), None);
        // No pseudo-console to go by: the named terminal's window with the folder in its title, else the one last used.
        let plain = [terminal(1, "atlas"), terminal(2, "PS D:\\work\\nook")];
        assert_eq!(terminal_window(&plain, &chain, Some("D:\\work\\nook")), Some(2));
        assert_eq!(terminal_window(&plain, &chain, Some("D:\\work\\other")), Some(1));
        // The terminal has gone from the chain (its pid changed hands): nothing of it is touched.
        assert_eq!(terminal_window(&plain, &chain[..2], Some("D:\\work\\nook")), None);
    }

    #[test]
    fn a_console_window_of_its_own_comes_forward() {
        let console = |hwnd: isize, pid: u32, visible: bool| Window {
            hwnd, pid, image: "powershell.exe".to_string(), class: CONSOLE_CLASS.to_string(), title: "Windows PowerShell".to_string(), visible, owner: 0,
        };
        let windows = [console(1, 99, true), console(2, 15, true), console(3, 16, false)];
        let chain = [p(10, "claude.exe"), p(15, "powershell.exe"), p(1, "explorer.exe")];
        assert_eq!(terminal_window(&windows, &chain, None), Some(2));
        // Another console's window is not ours, and a hidden one is no window.
        assert_eq!(terminal_window(&windows, &[p(10, "claude.exe"), p(16, "cmd.exe")], None), None);
        assert_eq!(terminal_window(&windows, &[p(10, "claude.exe")], None), None);
        // The desktop is above everything, and is never a window to go to.
        assert_eq!(terminal_window(&[window(7, 1, "explorer.exe", "Documents")], &[p(1, "explorer.exe")], None), None);
    }
}
