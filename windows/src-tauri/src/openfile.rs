// A file a reply names, opened in the editor its session runs in.
//
// The path comes from what the model wrote, and nothing about it is trusted.
// What is done with it is narrow on purpose: it is resolved to one existing,
// regular file on a local drive, and that file's full path is handed — as one
// argument, to a launcher of our own choosing (target.rs `EDITORS`), with no
// shell — to the editor's `--goto`. Nothing is ever run, no URL is ever
// opened, and a folder, a device or a network share is refused.
//
// The rule, as `resolve` applies it:
//
// 1. The text is 1 to `MAX_CHARS` characters with no control character in it,
//    and does not start with two separators: no UNC share (`\\server\share`),
//    no device or verbatim namespace (`\\.\`, `\\?\`) is ever asked for.
// 2. On Windows a `:` is the drive's and nothing else's: `C:\…` is fine;
//    `C:file` (relative to a drive's own folder), `file.txt:stream` (an
//    alternate data stream) and a path from the root with no drive (`\x`,
//    `/x`) are refused.
// 3. An absolute path is taken as it is. A relative one is joined to the
//    session's recorded folder, which must itself be absolute and exist; with
//    no folder recorded, a relative path is refused.
// 4. The result is canonicalised — so it exists, `..` and links are followed
//    to where they really lead — and must be a regular file: not a folder,
//    not a device (`NUL`, `CON`, `COM1`… canonicalise to `\\.\…`).
// 5. On Windows what canonicalising gives back must be on a drive
//    (`\\?\C:\…`, handed on as `C:\…`): a file that turns out to be on a
//    network share (a mapped drive, a link to one) is refused.
//
// Where the file is does not matter beyond that. The owner asked for the
// paths of a reply to open, and replies name files outside the project all
// the time (a settings file, a log, another repository): so an absolute path
// to any existing file opens, and `..` may lead out of the session's folder.
// Opening a file in an editor shows it; it does not run it.
//
// Everything in this file is pure but for looking at the file system.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Longer than this, the text is no path.
const MAX_CHARS: usize = 1024;
/// A line or a column is at most this many digits.
const MAX_DIGITS: usize = 7;

/// One `:digits` taken off the end of a path, if it ends on one.
fn strip_number(text: &str) -> Option<(&str, u32)> {
    let (rest, digits) = text.rsplit_once(':')?;
    if rest.is_empty() || digits.is_empty() || digits.len() > MAX_DIGITS || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((rest, digits.parse().ok()?))
}

/// A path as a reply writes it, with where in the file it points: `path`,
/// `path:line` or `path:line:col`. A drive's own `:` is never read as one.
pub fn split_position(text: &str) -> (&str, Option<u32>, Option<u32>) {
    let Some((rest, last)) = strip_number(text) else { return (text, None, None) };
    match strip_number(rest) {
        Some((path, line)) => (path, Some(line), Some(last)),
        None => (rest, Some(last), None),
    }
}

/// True when the text itself may be looked up: rules 1 and 2.
fn well_formed(path: &str) -> bool {
    if path.is_empty() || path.chars().count() > MAX_CHARS || path.chars().any(char::is_control) {
        return false;
    }
    let mut start = path.chars();
    let two: Vec<char> = start.by_ref().take(2).collect();
    if two.len() == 2 && two.iter().all(|c| matches!(c, '\\' | '/')) {
        return false;
    }
    if cfg!(windows) {
        let drive = two.len() == 2 && two[0].is_ascii_alphabetic() && two[1] == ':';
        let after = if drive { &path[2..] } else { path };
        // `C:\…` or nothing with a colon; and never from the root of no drive in particular.
        if after.contains(':') || (drive && !after.starts_with(['\\', '/'])) || (!drive && path.starts_with(['\\', '/'])) {
            return false;
        }
    }
    true
}

/// What canonicalising gave, as an editor is handed it — or none for a file
/// that is not on a drive of this machine.
#[cfg(windows)]
fn on_a_drive(canonical: &Path) -> Option<PathBuf> {
    use std::path::{Component, Prefix};
    match canonical.components().next()? {
        Component::Prefix(prefix) if matches!(prefix.kind(), Prefix::VerbatimDisk(_)) => {
            // `\\?\C:\…` is the same file as `C:\…`, which is how everything else writes it.
            canonical.to_str()?.strip_prefix(r"\\?\").map(PathBuf::from)
        }
        Component::Prefix(prefix) if matches!(prefix.kind(), Prefix::Disk(_)) => Some(canonical.to_path_buf()),
        _ => None,
    }
}

#[cfg(not(windows))]
fn on_a_drive(canonical: &Path) -> Option<PathBuf> {
    Some(canonical.to_path_buf())
}

/// The file a reply's path names, by its full path — or none (the rule is at
/// the top of this file). `cwd` is the session's folder, as the relay
/// reported it: what a relative path is relative to.
pub fn resolve(cwd: Option<&str>, path: &str) -> Option<PathBuf> {
    let path = path.trim();
    if !well_formed(path) {
        return None;
    }
    let named = Path::new(path);
    let candidate = if named.is_absolute() {
        named.to_path_buf()
    } else {
        let folder = Path::new(cwd.filter(|cwd| !cwd.is_empty())?);
        if !(folder.is_absolute() && folder.is_dir()) {
            return None;
        }
        folder.join(named)
    };
    let canonical = std::fs::canonicalize(candidate).ok()?;
    if !std::fs::metadata(&canonical).ok()?.is_file() {
        return None;
    }
    on_a_drive(&canonical)
}

/// Paths looked at in one question of `exist`: a reply names a handful of
/// files, and a page that asks for more is told no for the rest.
pub const MAX_CHECKS: usize = 20;

/// Whether each of these paths names a file `resolve` would open — the same
/// rule, to the letter, and nothing but yes or no comes back: not where the
/// file is, not why there is none. A position (`:line`) is read off the end
/// first, as when opening. Past `MAX_CHECKS`, the answer is no.
pub fn exist(cwd: Option<&str>, paths: &[String]) -> Vec<bool> {
    paths
        .iter()
        .enumerate()
        .map(|(i, path)| i < MAX_CHECKS && resolve(cwd, split_position(path).0).is_some())
        .collect()
}

/// What `--goto` is given: `file`, `file:line` or `file:line:col`. One
/// argument, whatever the file is called; a column goes only with a line.
pub fn goto_argument(file: &Path, line: Option<u32>, col: Option<u32>) -> OsString {
    let mut argument = file.as_os_str().to_os_string();
    if let Some(line) = line {
        argument.push(format!(":{line}"));
        if let Some(col) = col {
            argument.push(format!(":{col}"));
        }
    }
    argument
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A folder of its own for one test, with a project in it:
    /// `project/src/main.rs`, `project/README.md`, `project/docs/` (empty), and
    /// beside the project `outside.txt`. Gone when the test is.
    struct Sandbox {
        root: PathBuf,
    }

    static COUNT: AtomicU32 = AtomicU32::new(0);

    impl Sandbox {
        fn new() -> Self {
            let name = format!("nook-openfile-{}-{}", std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed));
            let root = std::env::temp_dir().join(name);
            fs::create_dir_all(root.join("project").join("src")).unwrap();
            fs::create_dir_all(root.join("project").join("docs")).unwrap();
            fs::write(root.join("project").join("src").join("main.rs"), "fn main() {}\n").unwrap();
            fs::write(root.join("project").join("README.md"), "# Project\n").unwrap();
            fs::write(root.join("outside.txt"), "outside\n").unwrap();
            // As `resolve` gives paths back: whole, with no `\\?\` before the drive.
            let root = on_a_drive(&fs::canonicalize(&root).unwrap()).unwrap();
            Sandbox { root }
        }

        fn cwd(&self) -> String {
            self.root.join("project").to_string_lossy().into_owned()
        }

        fn open(&self, path: &str) -> Option<PathBuf> {
            resolve(Some(&self.cwd()), path)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_position_is_read_off_the_end_of_a_path() {
        assert_eq!(split_position("src/main.rs"), ("src/main.rs", None, None));
        assert_eq!(split_position("src/main.rs:12"), ("src/main.rs", Some(12), None));
        assert_eq!(split_position("src/main.rs:12:5"), ("src/main.rs", Some(12), Some(5)));
        // A drive's colon is not a position, with or without one after it.
        assert_eq!(split_position(r"C:\work\a.rs"), (r"C:\work\a.rs", None, None));
        assert_eq!(split_position(r"C:\work\a.rs:7"), (r"C:\work\a.rs", Some(7), None));
        assert_eq!(split_position(r"C:\work\a.rs:7:3"), (r"C:\work\a.rs", Some(7), Some(3)));
        // Not numbers, too long to be one, or nothing before them: left as they are.
        assert_eq!(split_position("a.rs:"), ("a.rs:", None, None));
        assert_eq!(split_position("a.rs:x"), ("a.rs:x", None, None));
        assert_eq!(split_position("a.rs:-3"), ("a.rs:-3", None, None));
        assert_eq!(split_position("a.rs:12345678"), ("a.rs:12345678", None, None));
        assert_eq!(split_position(":12"), (":12", None, None));
        assert_eq!(split_position(""), ("", None, None));
        // Only the last two: a third number stays in the path, which then names no file.
        assert_eq!(split_position("a.rs:1:2:3"), ("a.rs:1", Some(2), Some(3)));
    }

    #[test]
    fn a_relative_path_is_a_file_of_the_sessions_folder() {
        let sandbox = Sandbox::new();
        let main = sandbox.root.join("project").join("src").join("main.rs");
        assert_eq!(sandbox.open("src/main.rs"), Some(main.clone()));
        assert_eq!(sandbox.open("./src/main.rs"), Some(main.clone()));
        assert_eq!(sandbox.open("  src/main.rs  "), Some(main.clone()));
        assert_eq!(sandbox.open("README.md"), Some(sandbox.root.join("project").join("README.md")));
        if cfg!(windows) {
            assert_eq!(sandbox.open(r"src\main.rs"), Some(main.clone()));
        }
        // What is handed on is the whole path, on its drive: never something an editor could read as an option.
        assert!(main.is_absolute() && !main.to_string_lossy().starts_with(r"\\"));
        // Relative to nothing, it names nothing: no folder recorded, an empty one, one that is not there, one that is not absolute.
        assert_eq!(resolve(None, "src/main.rs"), None);
        assert_eq!(resolve(Some(""), "src/main.rs"), None);
        assert_eq!(resolve(Some(&sandbox.root.join("gone").to_string_lossy()), "src/main.rs"), None);
        assert_eq!(resolve(Some("project"), "src/main.rs"), None);
    }

    #[test]
    fn an_absolute_path_to_a_file_that_exists_opens_wherever_it_is() {
        let sandbox = Sandbox::new();
        let outside = sandbox.root.join("outside.txt");
        // Outside the session's folder, and with no folder known at all.
        assert_eq!(sandbox.open(&outside.to_string_lossy()), Some(outside.clone()));
        assert_eq!(resolve(None, &outside.to_string_lossy()), Some(outside.clone()));
        if cfg!(windows) {
            // Forward slashes are the same path.
            assert_eq!(resolve(None, &outside.to_string_lossy().replace('\\', "/")), Some(outside.clone()));
        }
        // `..` may lead out of the session's folder: the rule is that the file exists, not where it is.
        assert_eq!(sandbox.open("../outside.txt"), Some(outside.clone()));
        assert_eq!(sandbox.open("src/../../outside.txt"), Some(outside));
        // …and back in: the path handed on is the real one, with no `..` left in it.
        assert_eq!(sandbox.open("docs/../src/main.rs"), Some(sandbox.root.join("project").join("src").join("main.rs")));
    }

    #[test]
    fn what_is_not_an_existing_file_is_refused() {
        let sandbox = Sandbox::new();
        // A folder, by any of its names.
        for folder in ["src", "src/", "docs", ".", "..", "src/.."] {
            assert_eq!(sandbox.open(folder), None, "{folder} is a folder");
        }
        assert_eq!(resolve(None, &sandbox.cwd()), None);
        // Nothing by that name.
        for missing in ["src/gone.rs", "gone/main.rs", "main.rs", "../project/gone.txt", "README.md.bak"] {
            assert_eq!(sandbox.open(missing), None, "{missing} does not exist");
        }
        assert_eq!(resolve(None, &sandbox.root.join("gone.txt").to_string_lossy()), None);
        // A position still on the path names no file: it is taken off before, by `split_position`.
        assert_eq!(sandbox.open("src/main.rs:12"), None);
    }

    #[test]
    fn weird_inputs_are_refused() {
        let sandbox = Sandbox::new();
        let long = "a/".repeat(MAX_CHARS);
        for weird in [
            "", "   ", "\n", "src/main.rs\n--wait", "src/\u{0}main.rs", long.as_str(),
            // Shares, devices and verbatim paths are never asked for.
            r"\\server\share\file.txt", "//server/share/file.txt", r"\\?\C:\Windows\win.ini", r"\\.\NUL", r"\\.\PhysicalDrive0",
            // Not paths at all.
            "https://example.com/a.rs", "file:///C:/Windows/win.ini", "--goto", "-n", "*.rs", "src/*.rs", "$(calc)", "%COMSPEC%", "a & calc", "| calc",
        ] {
            assert_eq!(sandbox.open(weird), None, "{weird:?} must be refused");
        }
        if cfg!(windows) {
            let outside = sandbox.root.join("outside.txt").to_string_lossy().into_owned();
            for weird in [
                // A device, wherever it is said to be.
                "NUL", "CON", "COM1", "src/NUL", "nul.txt",
                // A drive's own folder, a stream of a file, the root of no drive in particular.
                "C:outside.txt", "README.md:stream", "README.md::$DATA", r"\Windows\win.ini", "/Windows/win.ini",
            ] {
                assert_eq!(sandbox.open(weird), None, "{weird:?} must be refused");
            }
            // The same file through its verbatim name is refused too, though it exists.
            assert_eq!(resolve(None, &format!(r"\\?\{outside}")), None);
            assert!(resolve(None, &outside).is_some());
        }
    }

    #[test]
    fn asking_whether_files_exist_is_the_opening_rule_and_says_only_yes_or_no() {
        let sandbox = Sandbox::new();
        let ask = |paths: &[&str]| exist(Some(&sandbox.cwd()), &paths.iter().map(|p| p.to_string()).collect::<Vec<_>>());
        // A bare name is a file of the session's folder, or it is not: `node.js` is a name, not a file.
        assert_eq!(ask(&["README.md", "node.js", "main.rs", "src/main.rs", "README.md:12"]), [true, false, false, true, true]);
        // What opening refuses is "no" here too: a folder, a share, a stream, a device, nothing.
        assert_eq!(ask(&["docs", "src", "", "//server/share/a.txt", "README.md:stream", "NUL", "..", "missing.ts"]), [false; 8]);
        // And what opening allows is "yes": out of the folder, by `..` or by a full path.
        let outside = sandbox.root.join("outside.txt").to_string_lossy().into_owned();
        assert_eq!(ask(&["../outside.txt", &outside]), [true, true]);
        // No folder recorded for the session: a relative name cannot be looked up.
        assert_eq!(exist(None, &["README.md".to_string(), outside.clone()]), [false, true]);
        // One question looks at twenty paths: the rest are told no, file or not.
        let many: Vec<String> = (0..MAX_CHECKS + 5).map(|_| "README.md".to_string()).collect();
        let said = exist(Some(&sandbox.cwd()), &many);
        assert_eq!(said.len(), many.len());
        assert!(said[..MAX_CHECKS].iter().all(|yes| *yes) && said[MAX_CHECKS..].iter().all(|yes| !*yes));
        assert_eq!(exist(Some(&sandbox.cwd()), &[]), Vec::<bool>::new());
    }

    #[test]
    fn goto_is_one_argument() {
        let file = Path::new("work").join("a b & c.rs");
        let plain = file.to_string_lossy().into_owned();
        assert_eq!(goto_argument(&file, None, None), OsString::from(&plain));
        assert_eq!(goto_argument(&file, Some(12), None), OsString::from(format!("{plain}:12")));
        assert_eq!(goto_argument(&file, Some(12), Some(5)), OsString::from(format!("{plain}:12:5")));
        // A column with no line means nothing.
        assert_eq!(goto_argument(&file, None, Some(5)), OsString::from(&plain));
    }
}
