// The Shelf's Projects widget: the folders Claude Code sessions have run in,
// most recent first, and the two things it does with one — open it in VS Code,
// start a new Claude Code session in it in Windows Terminal.
//
// The list is Nook's own: a folder is added when a session's hook event names it
// as its working folder (`note`), kept in shelf.json (the page cannot write it),
// at most MAX_PROJECTS, and a folder that no longer exists is left out of what is
// shown. The page names a folder to launch, and Rust launches it only if it is one
// of these — checked again here, whatever the page was shown — and only through
// `launchable`: an existing absolute folder whose name has nothing in it that a
// command line could read as more than a name.
//
// A launcher is started as a program with its arguments given one by one: never a
// shell, never one string made of a command and a path.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::shelf::Store;

pub const MAX_PROJECTS: usize = 30;
const KEY: &str = "projects";

/// What a folder's name may not hold. A command line reads `"` as quoting, `%` as
/// a variable (a `.cmd` launcher expands it), `^` as an escape, `&` `|` `<` `>` as
/// the shell's own, and Windows Terminal reads `;` as the end of one command and
/// the start of the next. Control characters (a newline, a bell) are never part of
/// a folder's name that is meant to be launched.
const FORBIDDEN: &[char] = &['"', '%', '^', '&', '|', '<', '>', ';'];

/// A folder, as it is kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub path: String,
    /// When a session was last seen in it (Unix ms).
    pub at: u64,
}

/// A folder, as the page draws it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Project {
    pub path: String,
    /// The folder's own name, the last part of its path.
    pub name: String,
    pub at: u64,
}

/// Whether a path is fit to be launched: nothing is checked on the disk here, only the name.
/// Absolute (a relative path would mean something else to each launcher, and one that begins
/// with `-` would be an option), and free of what `FORBIDDEN` lists and of control characters.
pub fn name_ok(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && Path::new(path).is_absolute()
        && !path.chars().any(|c| c.is_control() || FORBIDDEN.contains(&c))
}

/// Whether a path is an existing folder fit to be launched.
pub fn launchable(path: &str) -> bool {
    name_ok(path) && Path::new(path).is_dir()
}

/// Two paths are the same folder: Windows does not tell `D:\Work` from `d:\work`, other systems do.
fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim_end_matches(['\\', '/']), b.trim_end_matches(['\\', '/']));
    if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b }
}

/// A folder's own name: the last part of its path.
pub fn folder_name(path: &str) -> String {
    path.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().filter(|n| !n.is_empty()).unwrap_or(path).to_string()
}

/// The list with `path` at its front — once, at `at` — and no more than MAX_PROJECTS of them.
pub fn remember(entries: &[Entry], path: &str, at: u64) -> Vec<Entry> {
    let mut next = vec![Entry { path: path.to_string(), at }];
    next.extend(entries.iter().filter(|e| !same(&e.path, path)).cloned());
    next.truncate(MAX_PROJECTS);
    next
}

/// Whether the list has this folder: the only ones that are ever launched.
pub fn remembered(entries: &[Entry], path: &str) -> bool {
    entries.iter().any(|e| same(&e.path, path))
}

fn entries(store: &Store) -> Vec<Entry> {
    store
        .get(KEY)
        .get("recent")
        .and_then(Value::as_array)
        .map(|all| all.iter().filter_map(|v| serde_json::from_value::<Entry>(v.clone()).ok()).collect())
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A session was seen running in `cwd`: it goes to the front of the list. A folder that cannot be launched is not kept.
pub fn note(store: &Store, cwd: &str) {
    if !launchable(cwd) {
        return;
    }
    let before = entries(store);
    // Already the most recent: nothing to write.
    if before.first().is_some_and(|e| same(&e.path, cwd)) {
        return;
    }
    let next = remember(&before, cwd, now_ms());
    let _ = store.put(KEY, json!({ "recent": next }));
}

/// The folders to show: the remembered ones that are still there, most recent first.
pub fn list(store: &Store) -> Vec<Project> {
    entries(store)
        .into_iter()
        .filter(|e| launchable(&e.path))
        .map(|e| Project { name: folder_name(&e.path), path: e.path, at: e.at })
        .collect()
}

/// The folder the page named, if it is one that may be launched: remembered, and still a folder.
fn chosen(store: &Store, path: &str) -> Option<String> {
    (launchable(path) && remembered(&entries(store), path)).then(|| path.to_string())
}

/// Opens the folder in VS Code: `code` found on PATH as the app finds it for a session's ↗, given the
/// folder as its one argument. False when there is no `code`, or it did not start.
pub fn open_in_code(store: &Store, path: &str) -> bool {
    let Some(folder) = chosen(store, path) else { return false };
    let Some(code) = crate::platform::find_on_path("code") else { return false };
    let mut cmd = Command::new(code);
    cmd.arg(&folder);
    crate::platform::no_console(&mut cmd).spawn().is_ok()
}

/// Starts a new Claude Code session in the folder, in a Windows Terminal window.
pub fn new_session(store: &Store, path: &str) -> bool {
    match chosen(store, path) {
        Some(folder) => crate::platform::launch_claude_session(&folder),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, at: u64) -> Entry {
        Entry { path: path.into(), at }
    }

    fn here() -> String {
        // A folder that exists, as an absolute path.
        std::env::temp_dir().to_string_lossy().trim_end_matches(['\\', '/']).to_string()
    }

    #[test]
    fn a_name_with_anything_a_command_line_could_read_is_refused() {
        let base = here();
        assert!(name_ok(&base));
        for bad in ["\"", "%", "^", "&", "|", "<", ">", ";", "\n", "\r", "\t", "\u{7}", "\0"] {
            assert!(!name_ok(&format!("{base}{bad}x")), "{bad:?} must be refused");
            assert!(!name_ok(&format!("{base}x{bad}")), "{bad:?} must be refused");
        }
        // Spaces, brackets and accents are plain names.
        assert!(name_ok(&format!("{base}{}my project (2) é", std::path::MAIN_SEPARATOR)));
    }

    #[test]
    fn a_path_that_is_not_absolute_is_refused() {
        for relative in ["", ".", "..", "src", "-rf", "--help", "code", "..\\x", "../x", "x/y"] {
            assert!(!name_ok(relative), "{relative:?} must be refused");
        }
        assert!(!name_ok(&"a".repeat(2000)));
    }

    #[test]
    fn only_an_existing_folder_is_launchable() {
        let base = here();
        assert!(launchable(&base));
        assert!(!launchable(&format!("{base}{}nook-no-such-folder-{}", std::path::MAIN_SEPARATOR, std::process::id())));
        // A file is not a folder.
        let file = std::env::temp_dir().join(format!("nook-projects-{}.txt", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(!launchable(&file.to_string_lossy()));
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn a_folder_goes_to_the_front_once_and_the_list_is_capped() {
        let a = entry("/work/a", 1);
        let b = entry("/work/b", 2);
        let list = remember(&[a.clone(), b.clone()], "/work/b", 9);
        assert_eq!(list, vec![entry("/work/b", 9), a.clone()]);
        let list = remember(&list, "/work/c", 10);
        assert_eq!(list.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["/work/c", "/work/b", "/work/a"]);
        // Past the cap the oldest go.
        let mut long: Vec<Entry> = (0..MAX_PROJECTS as u64).map(|i| entry(&format!("/w/{i}"), i)).collect();
        long = remember(&long, "/w/new", 99);
        assert_eq!(long.len(), MAX_PROJECTS);
        assert_eq!(long[0].path, "/w/new");
        assert!(!remembered(&long, &format!("/w/{}", MAX_PROJECTS - 1)));
    }

    #[test]
    fn only_a_remembered_folder_may_be_launched() {
        let list = vec![entry("/work/a", 1)];
        assert!(remembered(&list, "/work/a"));
        assert!(remembered(&list, "/work/a/"));
        assert!(!remembered(&list, "/work/b"));
        assert!(!remembered(&list, "/work"));
        assert!(!remembered(&[], "/work/a"));
    }

    #[test]
    fn a_folder_is_named_by_its_last_part() {
        assert_eq!(folder_name("D:\\work\\personal\\nook"), "nook");
        assert_eq!(folder_name("/home/me/nook/"), "nook");
        assert_eq!(folder_name("D:\\"), "D:");
        assert_eq!(folder_name("/"), "/");
    }
}
