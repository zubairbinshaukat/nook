// "Reply format for Claude Code": a short block in the user's global memory
// file, ~/.claude/CLAUDE.md, that asks Claude Code to shape its replies so the
// island can show what needs a decision, what is a risk and what is a tip
// (src/views/markdown.ts reads the alerts it asks for).
//
// The block sits between two marker lines, and those lines are the whole of
// what Nook owns in that file:
//
//   <!-- nook:reply-format:start -->
//   ## Reply format
//   …
//   <!-- nook:reply-format:end -->
//
// It is written the way the hooks are, through the hooks' own code (hooks.rs
// `preview_file` / `write_file`): the diff first, the fingerprint of the file
// that diff was made from, a dated backup (`CLAUDE.md.bak-YYYYMMDD-HHMMSS`,
// when there was a file), and only after an explicit click, beside the file
// and renamed over it.
//
// Nothing outside the markers is ever changed, to the byte: a BOM stays, the
// file's own line endings are the block's, its last line keeps or lacks its
// newline as it did. Installing appends — one blank line, then the block — to
// a file that has something in it, and the block alone to an empty or a
// missing one (the file is created, and nothing else). Updating replaces what
// is between the markers. Removing takes the markers, what is between them and
// that one blank line away: a file that had nothing else is left empty, not
// deleted.
//
// A file that already says the same in its own words — a `## Reply format`
// heading, or one of the block's distinctive lines — with no markers is not
// added to (it would say it twice) and not changed: the lines found are shown.
// Markers that do not make one pair are refused, and explained.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::hooks::{self, FileChange, HookPreview};
use crate::platform;

pub const START: &str = "<!-- nook:reply-format:start -->";
pub const END: &str = "<!-- nook:reply-format:end -->";

/// What stands between the markers, line by line.
pub const BODY: &[&str] = &[
    "## Reply format",
    "- Start with a one-line summary.",
    "- Put anything I must decide in a > [!IMPORTANT] block, one per decision, with the options and your recommendation.",
    "- Put risks and unverified things in > [!WARNING].",
    "- Put recommendations in > [!TIP].",
    "- Use short sections with ## headings and bullets with **bold lead-ins**.",
    "- End with the next step.",
];

/// The heading that says a file already has such a section, whatever its level or case.
const HEADING: &str = "reply format";
/// The lines of the block nobody writes by chance: found outside markers, the file says it already.
const DISTINCTIVE: &[&str] = &[
    "put anything i must decide in a > [!important] block",
    "put risks and unverified things in > [!warning]",
    "put recommendations in > [!tip]",
];
/// Lines of a section found without markers that are shown, at most.
const FOUND_LINES: usize = 12;

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// What the settings window can ask for.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Install,
    Update,
    Remove,
}

/// Where the block stands in a file.
#[derive(Clone, Debug, PartialEq)]
pub enum State {
    NotInstalled,
    Installed,
    /// The markers are there; what is between them is not Nook's current text.
    Outdated,
    /// No markers, but the file says the same already: these lines.
    Unmarked(Vec<String>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyFormatStatus {
    /// "notInstalled", "installed", "outdated", "unmarked", or "error".
    pub state: &'static str,
    /// For "unmarked": the lines found, as they are in the file.
    pub found: Vec<String>,
    /// For "error": why nothing can be done — an unreadable file, markers that do not pair.
    pub error: Option<String>,
    pub path: String,
    /// The file is there.
    pub exists: bool,
}

pub fn claude_md_path() -> PathBuf {
    platform::home_dir().join(".claude").join("CLAUDE.md")
}

// ── Reading: text, lines, markers ─────────────────────────────────────────────

/// A file's bytes as text, its BOM apart. A file that is not UTF-8 is not one
/// Nook can add a line to without guessing: refused.
fn text_of(bytes: &[u8]) -> Result<(bool, &str), String> {
    let (bom, rest) = match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    std::str::from_utf8(rest)
        .map(|text| (bom, text))
        .map_err(|_| "CLAUDE.md isn't UTF-8 text. Nook won't touch it.".to_string())
}

/// The file's own line ending: that of its first line. A file with none yet gets `\n`.
fn newline_of(text: &str) -> &'static str {
    match text.find('\n') {
        Some(at) if at > 0 && text.as_bytes()[at - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

/// One line of a text: where it starts, where its words end, and where the next one starts.
#[derive(Clone, Copy)]
struct Line<'a> {
    start: usize,
    /// Past its line ending; the text's length for a last line with none.
    next: usize,
    /// Without its line ending.
    words: &'a str,
}

fn lines_of(text: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let next = text[start..].find('\n').map_or(text.len(), |at| start + at + 1);
        let words = text[start..next].trim_end_matches('\n').trim_end_matches('\r');
        out.push(Line { start, next, words });
        start = next;
    }
    out
}

/// The pair of marker lines, when there is exactly one, in order.
struct Pair<'a> {
    start: Line<'a>,
    end: Line<'a>,
}

/// The markers of a text: none, one pair, or a refusal — a marker with no
/// partner, more than one pair, the end before the start, or a marker that is
/// not alone on its line. Nook then cannot tell what is its own.
fn markers(text: &str) -> Result<Option<Pair<'_>>, String> {
    let lines = lines_of(text);
    let starts: Vec<&Line> = lines.iter().filter(|line| line.words.trim() == START).collect();
    let ends: Vec<&Line> = lines.iter().filter(|line| line.words.trim() == END).collect();
    let said = text.matches(START).count() + text.matches(END).count();
    if said == 0 {
        return Ok(None);
    }
    let why = if said != starts.len() + ends.len() {
        "a marker is not alone on its line"
    } else if starts.len() > 1 || ends.len() > 1 {
        "there is more than one pair of markers"
    } else if starts.is_empty() {
        "the end marker has no start marker"
    } else if ends.is_empty() {
        "the start marker has no end marker"
    } else if ends[0].start < starts[0].start {
        "the end marker comes before the start marker"
    } else {
        return Ok(Some(Pair { start: *starts[0], end: *ends[0] }));
    };
    Err(format!(
        "Nook's reply-format markers in CLAUDE.md are broken: {why}. Nook won't change the file — fix or remove the marker lines by hand ({START} … {END})."
    ))
}

/// The lines of a file that already say what the block says, with no markers
/// around them: a "Reply format" heading with what follows it, and any of the
/// block's distinctive lines. Empty when there are none.
fn lookalike(text: &str) -> Vec<String> {
    let lines = lines_of(text);
    let heading = |words: &str| {
        let trimmed = words.trim();
        let title = trimmed.trim_start_matches('#');
        title.len() < trimmed.len() && trimmed.len() - title.len() <= 6 && title.trim().eq_ignore_ascii_case(HEADING)
    };
    let distinctive = |words: &str| {
        let lower = words.to_lowercase();
        DISTINCTIVE.iter().any(|line| lower.contains(line))
    };
    let mut found: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if heading(line.words) {
            found.push(i);
            // What stands under it, up to the next heading or an empty line.
            for (j, under) in lines.iter().enumerate().skip(i + 1) {
                if under.words.trim().is_empty() || under.words.trim_start().starts_with('#') {
                    break;
                }
                found.push(j);
            }
        } else if distinctive(line.words) {
            found.push(i);
        }
    }
    found.sort_unstable();
    found.dedup();
    found.into_iter().take(FOUND_LINES).map(|i| lines[i].words.to_string()).collect()
}

/// Where the block stands in a file's bytes (None: no file).
pub fn state_of(bytes: Option<&[u8]>) -> Result<State, String> {
    let (_, text) = text_of(bytes.unwrap_or_default())?;
    match markers(text)? {
        Some(pair) => {
            let between: Vec<&str> = lines_of(&text[pair.start.next..pair.end.start]).iter().map(|line| line.words).collect();
            Ok(if between == BODY { State::Installed } else { State::Outdated })
        }
        None => {
            let found = lookalike(text);
            Ok(if found.is_empty() { State::NotInstalled } else { State::Unmarked(found) })
        }
    }
}

// ── Changing: bytes in, bytes out ─────────────────────────────────────────────

/// The block's lines, in the file's line ending, each with one at its end.
fn body(newline: &str) -> String {
    BODY.iter().map(|line| format!("{line}{newline}")).collect()
}

/// A file with the block added at its end. `text` has no markers.
fn appended(text: &str) -> String {
    let newline = newline_of(text);
    let block = format!("{START}{newline}{}{END}", body(newline));
    if text.is_empty() {
        // An empty or a missing file: the block, and the newline a text file ends on.
        return format!("{block}{newline}");
    }
    if text.ends_with('\n') {
        // One blank line, the block, and the file ends on a newline as it did.
        format!("{text}{newline}{block}{newline}")
    } else {
        // Its last line had no newline: neither has the block's.
        format!("{text}{newline}{newline}{block}")
    }
}

/// A file with what is between its markers replaced by the current text. The marker lines stay as they are.
fn updated(text: &str, pair: &Pair) -> String {
    format!("{}{}{}", &text[..pair.start.next], body(newline_of(text)), &text[pair.end.start..])
}

/// A file with the markers and what is between them gone — and the one blank
/// line before them that installing added, when it is there.
fn removed(text: &str, pair: &Pair) -> String {
    let mut before = &text[..pair.start.start];
    let after = &text[pair.end.next..];
    // The blank line Nook put before the start marker: an empty line, and nothing else.
    for blank in ["\r\n", "\n"] {
        if before.ends_with(&format!("\n{blank}")) || before == blank {
            before = &before[..before.len() - blank.len()];
            break;
        }
    }
    // The block ran to the end of a file whose last line had no newline: as
    // installing found it, the text before had none either.
    if after.is_empty() && !text.ends_with('\n') {
        before = before.strip_suffix('\n').map(|rest| rest.strip_suffix('\r').unwrap_or(rest)).unwrap_or(before);
    }
    format!("{before}{after}")
}

/// What `action` makes of a file's bytes (None: no file), or why it cannot be
/// done. Everything outside the markers comes back byte for byte.
pub fn changed(bytes: Option<&[u8]>, action: Action) -> Result<Vec<u8>, String> {
    let (bom, text) = text_of(bytes.unwrap_or_default())?;
    let pair = markers(text)?;
    let next = match (action, &pair) {
        (Action::Install, None) => {
            if !lookalike(text).is_empty() {
                return Err("CLAUDE.md already has a reply format of its own, without Nook's markers. Nook won't add a second one, and won't change yours.".into());
            }
            appended(text)
        }
        // Installing over what is there writes the current text between the markers: nothing twice.
        (Action::Install | Action::Update, Some(pair)) => updated(text, pair),
        (Action::Remove, Some(pair)) => removed(text, pair),
        (Action::Update | Action::Remove, None) => {
            return Err("Nook's reply format isn't in CLAUDE.md: there is nothing to change.".into());
        }
    };
    let mut out = if bom { BOM.to_vec() } else { Vec::new() };
    out.extend_from_slice(next.as_bytes());
    Ok(out)
}

/// The change as hooks.rs writes one: the two sides of the diff, and the bytes.
fn change(action: Action) -> impl Fn(&Path, Option<&[u8]>) -> Result<FileChange, String> {
    move |_, bytes| {
        let next = changed(bytes, action)?;
        let shown = |bytes: &[u8]| text_of(bytes).map(|(_, text)| text.to_string());
        Ok(FileChange { before: shown(bytes.unwrap_or_default())?, after: shown(&next)?, bytes: next })
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

fn status_at(path: &Path) -> ReplyFormatStatus {
    let read = hooks::read_file(path);
    let exists = matches!(read, Ok(Some(_)));
    let state = read.and_then(|bytes| state_of(bytes.as_deref()));
    let (state, found, error) = match state {
        Ok(State::NotInstalled) => ("notInstalled", Vec::new(), None),
        Ok(State::Installed) => ("installed", Vec::new(), None),
        Ok(State::Outdated) => ("outdated", Vec::new(), None),
        Ok(State::Unmarked(found)) => ("unmarked", found, None),
        Err(why) => ("error", Vec::new(), Some(why)),
    };
    ReplyFormatStatus { state, found, error, path: path.to_string_lossy().to_string(), exists }
}

pub fn status() -> ReplyFormatStatus {
    status_at(&claude_md_path())
}

/// The diff the user has to look at before anything is written.
pub fn preview(action: Action) -> Result<HookPreview, String> {
    hooks::preview_file(&claude_md_path(), change(action))
}

/// Writes it — after a dated backup of the file that was there, and only if
/// CLAUDE.md is still the file the preview was made from. Returns the backup's
/// path (where it would be, for a file that was created).
pub fn apply(action: Action, fingerprint: &str) -> Result<String, String> {
    hooks::write_file(&claude_md_path(), fingerprint, change(action))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    const LF_BLOCK: &str = "<!-- nook:reply-format:start -->\n## Reply format\n- Start with a one-line summary.\n- Put anything I must decide in a > [!IMPORTANT] block, one per decision, with the options and your recommendation.\n- Put risks and unverified things in > [!WARNING].\n- Put recommendations in > [!TIP].\n- Use short sections with ## headings and bullets with **bold lead-ins**.\n- End with the next step.\n<!-- nook:reply-format:end -->";

    fn install(text: &str) -> String {
        String::from_utf8(changed(Some(text.as_bytes()), Action::Install).unwrap()).unwrap()
    }
    fn act(text: &str, action: Action) -> String {
        String::from_utf8(changed(Some(text.as_bytes()), action).unwrap()).unwrap()
    }
    fn state(text: &str) -> State {
        state_of(Some(text.as_bytes())).unwrap()
    }

    #[test]
    fn the_block_is_the_text_agreed_between_its_two_markers() {
        // A missing file and an empty one: the block, and one newline.
        let created = String::from_utf8(changed(None, Action::Install).unwrap()).unwrap();
        assert_eq!(created, format!("{LF_BLOCK}\n"));
        assert_eq!(install(""), created);
        assert_eq!(state(&created), State::Installed);
        assert_eq!(state_of(None).unwrap(), State::NotInstalled);
        assert_eq!(state(""), State::NotInstalled);
        // The markers are alone on their lines.
        let lines: Vec<&str> = created.lines().collect();
        assert_eq!((lines[0], lines[lines.len() - 1]), (START, END));
        assert_eq!(&lines[1..lines.len() - 1], BODY);
    }

    #[test]
    fn installing_appends_after_one_blank_line_and_keeps_the_files_own_endings() {
        // LF, with a newline at the end: one blank line, the block, a newline at the end.
        assert_eq!(install("# Mine\n\nBe brief.\n"), format!("# Mine\n\nBe brief.\n\n{LF_BLOCK}\n"));
        // LF, with none: the file still ends without one.
        assert_eq!(install("# Mine\n\nBe brief."), format!("# Mine\n\nBe brief.\n\n{LF_BLOCK}"));
        // CRLF: every line of the block ends as the file's lines do.
        let crlf_block = LF_BLOCK.replace('\n', "\r\n");
        assert_eq!(install("# Mine\r\n\r\nBe brief.\r\n"), format!("# Mine\r\n\r\nBe brief.\r\n\r\n{crlf_block}\r\n"));
        assert_eq!(install("# Mine\r\nBe brief."), format!("# Mine\r\nBe brief.\r\n\r\n{crlf_block}"));
        assert!(!install("# Mine\r\nBe brief.\r\n").replace("\r\n", "").contains('\n'), "no bare LF in a CRLF file");
        // A single line with no newline at all: LF, as a new file gets.
        assert_eq!(install("Be brief."), format!("Be brief.\n\n{LF_BLOCK}"));
        // Trailing spaces, tabs and blank lines of the user's stay exactly where they were.
        assert_eq!(install("Be brief.  \n\t\n\n"), format!("Be brief.  \n\t\n\n\n{LF_BLOCK}\n"));
    }

    #[test]
    fn a_bom_stays_and_a_file_that_is_not_text_is_refused() {
        let mut with_bom = BOM.to_vec();
        with_bom.extend_from_slice(b"# Mine\r\n");
        let installed = changed(Some(&with_bom), Action::Install).unwrap();
        assert!(installed.starts_with(BOM) && !installed[3..].starts_with(BOM));
        assert!(installed.starts_with(&with_bom));
        assert_eq!(state_of(Some(&installed)).unwrap(), State::Installed);
        assert_eq!(changed(Some(&installed), Action::Remove).unwrap(), with_bom);
        // A file that is only a BOM is an empty one that keeps it.
        let only = changed(Some(BOM), Action::Install).unwrap();
        assert_eq!(only, [BOM, format!("{LF_BLOCK}\n").as_bytes()].concat());
        assert_eq!(changed(Some(&only), Action::Remove).unwrap(), BOM);
        // UTF-16, or anything that is not UTF-8: nothing is guessed.
        let utf16: Vec<u8> = vec![0xFF, 0xFE, b'#', 0, b' ', 0, 0xD8, 0xD8];
        for action in [Action::Install, Action::Update, Action::Remove] {
            assert!(changed(Some(&utf16), action).unwrap_err().contains("won't touch"));
        }
        assert!(state_of(Some(&utf16)).is_err());
    }

    #[test]
    fn removing_gives_back_the_file_as_it_was_to_the_byte() {
        let originals = [
            "",
            "\n",
            "# Mine\n",
            "# Mine",
            "# Mine\n\nBe brief.\n",
            "# Mine\n\nBe brief.",
            "# Mine\n\nBe brief.\n\n\n",
            "Be brief.  \n\t\n",
            "# Mine\r\n\r\nBe brief.\r\n",
            "# Mine\r\n\r\nBe brief.",
            "\r\n",
            "é — ünïcödé ✓\n",
            "mixed\r\nendings\nhere\r\n",
            "mixed\r\nendings\n",
            "mixed\nendings\r\n",
        ];
        for original in originals {
            let installed = install(original);
            assert_eq!(state(&installed), State::Installed, "{original:?}");
            assert_eq!(act(&installed, Action::Remove), original, "{original:?}");
            // With a BOM too.
            let with_bom = [BOM, original.as_bytes()].concat();
            let there = changed(Some(&with_bom), Action::Install).unwrap();
            assert_eq!(changed(Some(&there), Action::Remove).unwrap(), with_bom, "BOM + {original:?}");
        }
        // A file Nook created is left empty, not deleted: there is nothing of anybody's in it.
        assert_eq!(act(&install(""), Action::Remove), "");
        // What the user wrote after the block since stays, and so does what was before.
        let grown = format!("{}More of mine.\n", install("# Mine\n"));
        assert_eq!(act(&grown, Action::Remove), "# Mine\nMore of mine.\n");
        // A block the user moved to the top, with no blank line of Nook's before it.
        let moved = format!("{LF_BLOCK}\n\n# Mine\n");
        assert_eq!(act(&moved, Action::Remove), "\n# Mine\n");
        // Only an empty line is taken as Nook's: one with spaces in it is the user's.
        let spaced = format!("# Mine\n  \n{LF_BLOCK}\n");
        assert_eq!(act(&spaced, Action::Remove), "# Mine\n  \n");
    }

    #[test]
    fn installing_twice_changes_nothing_and_never_adds_a_second_block() {
        for original in ["", "# Mine\n", "# Mine\r\nBe brief.", "# Mine\n\n"] {
            let once = install(original);
            assert_eq!(install(&once), once, "{original:?}");
            assert_eq!(act(&once, Action::Update), once, "{original:?}");
            assert_eq!(once.matches(START).count(), 1);
        }
    }

    #[test]
    fn updating_replaces_only_what_is_between_the_markers() {
        let before = "# Mine\r\n\r\nBe brief.  \r\n\r\n";
        let after = "\r\n## After\r\nKept too.";
        // An older text of Nook's, and marker lines with spaces after them: both pairs stay as they are.
        let old = format!("{before}{START}  \r\n## Reply format\r\n- An older line.\r\n{END}\t{after}");
        assert_eq!(state(&old), State::Outdated);
        let new = act(&old, Action::Update);
        assert_eq!(state(&new), State::Installed);
        assert!(new.starts_with(&format!("{before}{START}  \r\n")) && new.ends_with(&format!("{END}\t{after}")));
        let between = &new[before.len() + START.len() + 4..new.len() - after.len() - END.len() - 1];
        assert_eq!(between, BODY.iter().map(|line| format!("{line}\r\n")).collect::<String>());
        // Install on an outdated block is the same update: never a second block.
        assert_eq!(act(&old, Action::Install), new);
        // Nothing between the markers at all is outdated too.
        let hollow = format!("x\n{START}\n{END}\n");
        assert_eq!(state(&hollow), State::Outdated);
        assert_eq!(act(&hollow, Action::Update), format!("x\n{LF_BLOCK}\n"));
        // And removing an outdated block removes it, whatever it holds.
        assert_eq!(act(&old, Action::Remove), "# Mine\r\n\r\nBe brief.  \r\n## After\r\nKept too.");
        // Nothing to update or remove where there is no block.
        for action in [Action::Update, Action::Remove] {
            assert!(changed(Some(b"# Mine\n"), action).unwrap_err().contains("nothing to change"));
            assert!(changed(None, action).is_err());
        }
    }

    #[test]
    fn a_reply_format_without_markers_is_found_shown_and_not_duplicated() {
        // A section of the user's own, under any level of heading, in any case.
        let own = "# Mine\n\n### reply FORMAT\n- Lead with the answer.\n- Then the detail.\n\n## Other\nKept.\n";
        assert_eq!(state(own), State::Unmarked(vec!["### reply FORMAT".into(), "- Lead with the answer.".into(), "- Then the detail.".into()]));
        assert!(changed(Some(own.as_bytes()), Action::Install).unwrap_err().contains("won't add a second one"));
        // Nook's own lines pasted by hand, with no heading and no markers.
        let pasted = "Notes.\n* Put risks and unverified things in > [!WARNING].\nMore.\n";
        assert_eq!(state(pasted), State::Unmarked(vec!["* Put risks and unverified things in > [!WARNING].".into()]));
        assert!(changed(Some(pasted.as_bytes()), Action::Install).is_err());
        // Nothing destructive is on offer for it.
        for action in [Action::Update, Action::Remove] {
            assert!(changed(Some(own.as_bytes()), action).is_err());
        }
        // Words that only mention it are not it.
        for plain in ["# Formatting replies\nBe brief.\n", "Use the reply format you like.\n", "## Reply formatting\n", "####### Reply format\n", "Reply format\n"] {
            assert_eq!(state(plain), State::NotInstalled, "{plain:?}");
        }
        // A long section is shown in part.
        let long = format!("## Reply format\n{}", "- line\n".repeat(40));
        assert!(matches!(state(&long), State::Unmarked(found) if found.len() == FOUND_LINES));
        // Inside Nook's markers the same words are simply the block.
        assert_eq!(state(&install("# Mine\n")), State::Installed);
    }

    #[test]
    fn markers_that_do_not_make_one_pair_are_refused() {
        let broken = [
            format!("{START}\n## Reply format\n"),
            format!("## Reply format\n{END}\n"),
            format!("{END}\nx\n{START}\n"),
            format!("{LF_BLOCK}\n\n{LF_BLOCK}\n"),
            format!("{START}\n{START}\nx\n{END}\n"),
            format!("{START}\nx\n{END}\n{END}\n"),
            format!("See {START} here\nx\n{END}\n"),
            format!("{START} {END}\n"),
        ];
        for text in &broken {
            let why = state_of(Some(text.as_bytes())).unwrap_err();
            assert!(why.contains("markers") && why.contains("won't change"), "{text:?}: {why}");
            for action in [Action::Install, Action::Update, Action::Remove] {
                assert_eq!(changed(Some(text.as_bytes()), action).unwrap_err(), why, "{text:?}");
            }
        }
        // Indented, or with spaces after it, a marker is still alone on its line.
        assert_eq!(state(&format!("  {START}\n{}\n{END}  \n", BODY.join("\n"))), State::Installed);
    }

    /// A folder of its own for one test, gone when the test is.
    struct Sandbox(PathBuf);
    static COUNT: AtomicU32 = AtomicU32::new(0);
    impl Sandbox {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("nook-replyformat-{}-{}", std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed)));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Sandbox(dir)
        }
        fn file(&self) -> PathBuf {
            self.0.join(".claude").join("CLAUDE.md")
        }
        fn others(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(self.0.join(".claude"))
                .map(|dir| dir.filter_map(|e| Some(e.ok()?.file_name().to_string_lossy().into_owned())).collect())
                .unwrap_or_default();
            names.retain(|name| name != "CLAUDE.md");
            names
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_missing_file_is_created_and_nothing_else_is() {
        let sandbox = Sandbox::new();
        let path = sandbox.file();
        assert_eq!(status_at(&path).state, "notInstalled");
        assert!(!status_at(&path).exists);

        let plan = hooks::preview_file(&path, change(Action::Install)).unwrap();
        assert!(plan.diff.lines().all(|line| line.starts_with('+')), "every line is new: {}", plan.diff);
        assert!(plan.diff.contains(START) && plan.diff.contains("[!IMPORTANT]"));
        assert!(!path.exists(), "a preview writes nothing");

        hooks::write_file(&path, &plan.fingerprint, change(Action::Install)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), format!("{LF_BLOCK}\n"));
        // No backup of a file that was not there, and no temporary file left behind.
        assert_eq!(sandbox.others(), Vec::<String>::new());
        let now = status_at(&path);
        assert_eq!((now.state, now.exists), ("installed", true));

        // Removing leaves it empty, and backs up what was there.
        let plan = hooks::preview_file(&path, change(Action::Remove)).unwrap();
        let backup = hooks::write_file(&path, &plan.fingerprint, change(Action::Remove)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"");
        assert_eq!(fs::read_to_string(&backup).unwrap(), format!("{LF_BLOCK}\n"));
        assert_eq!(status_at(&path).state, "notInstalled");
    }

    #[test]
    fn writing_backs_up_keeps_every_other_byte_and_refuses_a_changed_file() {
        let sandbox = Sandbox::new();
        let path = sandbox.file();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // The user's own file: a BOM, CRLF, trailing spaces, no newline at the end.
        let original = [BOM, "# Mine\r\n\r\nBe brief.  \r\nNo newline at the end".as_bytes()].concat();
        fs::write(&path, &original).unwrap();

        let plan = hooks::preview_file(&path, change(Action::Install)).unwrap();
        assert!(plan.diff.contains("+ <!-- nook:reply-format:start -->") && !plan.diff.lines().any(|line| line.starts_with('-')), "only additions: {}", plan.diff);
        assert!(plan.backup.contains("CLAUDE.md.bak-"), "{}", plan.backup);
        assert_eq!(fs::read(&path).unwrap(), original);

        // The file moved since the preview: refused, untouched, no backup.
        fs::write(&path, b"# Edited meanwhile\n").unwrap();
        let err = hooks::write_file(&path, &plan.fingerprint, change(Action::Install)).unwrap_err();
        assert!(err.contains("changed since the preview"), "got: {err}");
        assert_eq!(fs::read(&path).unwrap(), b"# Edited meanwhile\n");
        assert_eq!(sandbox.others(), Vec::<String>::new());
        fs::write(&path, &original).unwrap();

        // Install: the backup is the original, and the file starts with it, to the byte.
        let backup = hooks::write_file(&path, &plan.fingerprint, change(Action::Install)).unwrap();
        let name = Path::new(&backup).file_name().unwrap().to_string_lossy().into_owned();
        let stamp = name.strip_prefix("CLAUDE.md.bak-").expect("named after the file and the time");
        assert!(stamp.len() == 15 && stamp.as_bytes()[8] == b'-' && stamp.bytes().filter(u8::is_ascii_digit).count() == 14, "{name}");
        assert_eq!(fs::read(&backup).unwrap(), original);
        let installed = fs::read(&path).unwrap();
        assert!(installed.starts_with(&original) && !installed.ends_with(b"\n"));
        assert_eq!(status_at(&path).state, "installed");

        // A stale fingerprint is refused for a removal too.
        assert!(hooks::write_file(&path, &plan.fingerprint, change(Action::Remove)).is_err());
        assert_eq!(fs::read(&path).unwrap(), installed);

        // An outdated block is updated in place; removing then gives the original back, exactly.
        let outdated = String::from_utf8_lossy(&installed).replace("- End with the next step.", "- An older last line.").into_bytes();
        fs::write(&path, &outdated).unwrap();
        assert_eq!(status_at(&path).state, "outdated");
        let plan = hooks::preview_file(&path, change(Action::Update)).unwrap();
        let changed_lines: Vec<&str> = plan.diff.lines().filter(|line| line.starts_with('+') || line.starts_with('-')).collect();
        assert_eq!(changed_lines, ["- - An older last line.", "+ - End with the next step."]);
        hooks::write_file(&path, &plan.fingerprint, change(Action::Update)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), installed);

        let plan = hooks::preview_file(&path, change(Action::Remove)).unwrap();
        hooks::write_file(&path, &plan.fingerprint, change(Action::Remove)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);

        // What cannot be changed leaves no trace: a look-alike, broken markers.
        let before = sandbox.others().len();
        for bad in ["## Reply format\n- mine\n".to_string(), format!("{START}\nno end\n")] {
            fs::write(&path, &bad).unwrap();
            assert!(hooks::preview_file(&path, change(Action::Install)).is_err());
            let print = hooks::preview_file(&path, |_, bytes| Ok(FileChange { before: String::new(), after: String::new(), bytes: bytes.unwrap_or_default().to_vec() })).unwrap().fingerprint;
            assert!(hooks::write_file(&path, &print, change(Action::Install)).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), bad);
        }
        assert_eq!(sandbox.others().len(), before, "a refused change takes no backup");
        fs::write(&path, format!("{START}\nno end\n")).unwrap();
        let broken = status_at(&path);
        assert_eq!(broken.state, "error");
        assert!(broken.error.unwrap().contains("no end marker"));
    }
}
