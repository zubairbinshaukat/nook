// A reply typed in the island, delivered in the session's own window.
//
// `session_reply_here` is tried before `session_reply` (reply.rs, a background
// process): it puts the reply where the conversation was started. Whenever it
// returns Err nothing was typed or opened anywhere, and the page then sends the
// reply the other way. So once the first key is sent, or the URL is opened, the
// answer is Ok — never Err — or the message would be delivered twice.
//
// Ok("typed")       the text was typed into the session's terminal, and Enter pressed.
// Ok("interrupted") the user left the terminal while it was being typed: the text is
//                   partly there, and Enter was not pressed.
// Ok("prefilled")   the text is in the prompt box of the Claude Code panel of VS Code
//                   or Cursor, through the extension's own `open` link; Enter is the
//                   user's.
//
// Nothing here trusts the page. The session is named by its id and its window is
// found as the ↗ finds it (lib.rs `plan_window`). The page's `title` is used for
// one comparison — is the terminal showing this conversation? — and for nothing
// else. The clipboard is never touched.

use tauri::State;

use crate::target::Sessions;

/// The longest reply, in characters (reply.rs has the same limit).
const MAX_TEXT_CHARS: usize = 8000;
/// The longest reply that goes in a link; and the longest link.
const MAX_LINK_TEXT_CHARS: usize = 1500;
const MAX_LINK_BYTES: usize = 8000;
const MAX_ID_LEN: usize = 128;
/// The shortest title that proves a terminal is showing a conversation.
const MIN_TITLE_CHARS: usize = 4;
/// A window title this long may be a truncated one, and a prefix of the title.
const MIN_PREFIX_CHARS: usize = 8;

/// One key of a reply, as it is sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyAction {
    /// A character, sent as Unicode input (a pair of units when it needs two).
    Char(char),
    Enter,
}

// ── Pure parts ────────────────────────────────────────────────────────────────

/// The text to send: line ends as `\n`, trimmed, not empty, not too long, and
/// no control character but newline and tab.
fn clean_text(text: &str) -> Result<String, String> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    if text.is_empty() {
        return Err("Write a message first.".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("That message is too long (the limit is {MAX_TEXT_CHARS} characters)."));
    }
    if text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err("That message has a character that can't be typed.".into());
    }
    Ok(text.to_string())
}

/// The keys of a text. A new line is a backslash and Enter — Claude Code's own
/// way of adding a line — and a tab is four spaces.
fn key_actions(text: &str) -> Vec<KeyAction> {
    let mut keys = Vec::with_capacity(text.len() + 1);
    for c in text.chars() {
        match c {
            '\n' => keys.extend([KeyAction::Char('\\'), KeyAction::Enter]),
            '\t' => keys.extend([KeyAction::Char(' '); 4]),
            c => keys.push(KeyAction::Char(c)),
        }
    }
    keys
}

/// A title as it is compared: lower case, with the glyph Claude Code puts before
/// the conversation's title (`◐ `, `✳ `…) and the ellipsis a truncation leaves
/// both taken off.
fn title_core(title: &str) -> String {
    let mut core = title.trim().trim_start_matches(|c: char| !c.is_alphanumeric()).trim_end().to_lowercase();
    while let Some(rest) = core.strip_suffix('…').or_else(|| core.strip_suffix("...")) {
        core = rest.trim_end().to_string();
    }
    core
}

/// True when a terminal window's title says it is showing the conversation
/// called `title`. A terminal's title is that of its active tab, and Claude Code
/// writes a status glyph and the conversation's title. Either may be cut short.
///
/// The glyph is part of the proof: a shell's own tab ("Windows PowerShell",
/// a path) starts with a letter, and what is typed there would be run as a
/// command. And the title is where the window's begins, not anywhere in it.
fn shows_conversation(window_title: &str, title: &str) -> bool {
    let marked = window_title.trim_start().chars().next().is_some_and(|c| !c.is_ascii() && !c.is_alphanumeric());
    let (window, title) = (title_core(window_title), title_core(title));
    if !marked || title.chars().count() < MIN_TITLE_CHARS {
        return false;
    }
    window.starts_with(&title) || (window.chars().count() >= MIN_PREFIX_CHARS && title.starts_with(&window))
}

/// A session id the extension's link takes.
fn link_session_id(id: &str) -> bool {
    (1..=MAX_ID_LEN).contains(&id.len())
        && id != crate::target::ANONYMOUS
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The scheme an editor's link opens under, from the image of its process.
fn link_scheme(image: &str) -> Option<&'static str> {
    match image.to_lowercase().as_str() {
        "code.exe" => Some("vscode"),
        "code - insiders.exe" => Some("vscode-insiders"),
        "cursor.exe" => Some("cursor"),
        _ => None,
    }
}

/// Everything but A-Z a-z 0-9 - . _ ~ as the percent-encoding of its UTF-8 bytes.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The link that opens a session in the Claude Code panel of an editor, its
/// prompt filled with `text` and not sent.
fn prompt_link(scheme: &str, session_id: &str, text: &str) -> Result<String, String> {
    if !link_session_id(session_id) {
        return Err("This session has no id the Claude Code panel can be opened with.".into());
    }
    if text.chars().count() > MAX_LINK_TEXT_CHARS {
        return Err(format!("That message is too long for the panel ({MAX_LINK_TEXT_CHARS} characters at most)."));
    }
    let link = format!("{scheme}://anthropic.claude-code/open?session={session_id}&prompt={}", percent_encode(text));
    if link.len() > MAX_LINK_BYTES {
        return Err("That message is too long for the panel.".into());
    }
    Ok(link)
}

// ── The command ───────────────────────────────────────────────────────────────

/// Delivers a reply in the session's own window. See the top of this file.
///
/// Off the main thread: it lists windows, waits for another program's, and types.
#[tauri::command]
pub async fn session_reply_here(
    sessions: State<'_, Sessions>,
    session_id: String,
    title: Option<String>,
    text: String,
) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("not available on Linux".into());
    }
    let Some(plan) = sessions.plan(&session_id) else {
        crate::log::line("reply here: nothing known of where the session runs");
        return Err("Nook doesn't know where this session runs.".into());
    };
    tauri::async_runtime::spawn_blocking(move || imp::reply(&plan, &session_id, title.as_deref(), &text))
        .await
        .map_err(|_| "The reply could not be delivered.".to_string())?
}

/// Whether a reply could be delivered in the session's own window at all: its
/// terminal's window is there, or its editor's with the Claude Code panel. It
/// touches nothing — no window is brought forward — and says nothing of which
/// tab a terminal shows: that is checked when a reply is sent.
#[tauri::command]
pub async fn session_reply_reachable(sessions: State<'_, Sessions>, session_id: String) -> Result<bool, String> {
    if !cfg!(windows) {
        return Ok(false);
    }
    let Some(plan) = sessions.plan(&session_id) else { return Ok(false) };
    Ok(tauri::async_runtime::spawn_blocking(move || imp::reachable(&plan)).await.unwrap_or(false))
}

#[cfg(not(windows))]
mod imp {
    use crate::target::Plan;

    pub fn reachable(_plan: &Plan) -> bool {
        false
    }

    pub fn reply(_plan: &Plan, _session_id: &str, _title: Option<&str>, _text: &str) -> Result<String, String> {
        Err("not available on Linux".into())
    }
}

#[cfg(windows)]
mod imp {
    use std::time::Duration;

    use super::{clean_text, key_actions, link_scheme, prompt_link, shows_conversation, KeyAction, MIN_TITLE_CHARS};
    use crate::target::{self, Kind, Plan};
    use crate::{log, platform};

    /// How long a window gets to be in front once asked.
    const FRONT_WAIT_MS: u64 = 600;
    /// How long the user's own Enter and modifiers get to be let go of.
    const KEYS_UP_WAIT_MS: u64 = 700;
    /// Characters sent in one go, and the pause after each go: a slow terminal keeps up.
    const CHUNK: usize = 32;
    const CHUNK_PAUSE: Duration = Duration::from_millis(12);

    pub fn reachable(plan: &Plan) -> bool {
        match plan.target.kind {
            Kind::Terminal => crate::plan_window(plan).is_some(),
            Kind::Vscode | Kind::Cursor => target::is_extension(&plan.entrypoint) && crate::plan_window(plan).is_some(),
            Kind::Claude | Kind::Unknown => false,
        }
    }

    pub fn reply(plan: &Plan, session_id: &str, title: Option<&str>, text: &str) -> Result<String, String> {
        let mut text = clean_text(text)?;
        // A backslash and Enter is Claude Code's new line. In Codex it would send what is there: one line, then.
        if session_id.starts_with("codex:") {
            text = text.replace('\n', " ");
        }
        let done = match plan.target.kind {
            Kind::Terminal => type_in_terminal(plan, title, &text),
            Kind::Vscode | Kind::Cursor => prefill_panel(plan, session_id, &text),
            Kind::Claude | Kind::Unknown => Err("This session's window can't be typed into.".to_string()),
        };
        match &done {
            Ok(how) => log::line(format!("reply here in {}: {how}", plan.target.label)),
            Err(why) => log::line(format!("reply here in {}: not done ({why})", plan.target.label)),
        }
        done
    }

    /// A: typed into the terminal's window.
    fn type_in_terminal(plan: &Plan, title: Option<&str>, text: &str) -> Result<String, String> {
        // 1. The window, as the ↗ finds it.
        let hwnd = crate::plan_window(plan).ok_or("This session's window couldn't be found.")?;
        // 2. Proof that it shows this session: a tab is not told from outside but by its title.
        let title = title.map(str::trim).filter(|t| t.chars().count() >= MIN_TITLE_CHARS).ok_or("This conversation has no title to find its tab by.")?;
        let proven = |hwnd: isize| shows_conversation(&platform::window_title(hwnd), title);
        if !proven(hwnd) {
            return Err("Its terminal is showing another tab.".into());
        }
        // 3. Windows drops input meant for a window that runs with more rights.
        if platform::elevated_out_of_reach(hwnd) {
            return Err("Its terminal runs as administrator.".into());
        }
        // 4. In front, still on the same tab, and the user's own keys let go of.
        if !platform::bring_forward(hwnd) || !platform::wait_foreground(hwnd, FRONT_WAIT_MS) {
            return Err("Its terminal couldn't be brought forward.".into());
        }
        if !proven(hwnd) {
            return Err("Its terminal is showing another tab.".into());
        }
        if !platform::wait_keys_released(KEYS_UP_WAIT_MS) {
            return Err("A key is still held down.".into());
        }

        // 5. Typed. From the first key sent, the answer is Ok.
        let keys = key_actions(text);
        let mut started = false;
        for chunk in keys.chunks(CHUNK) {
            if !platform::is_foreground(hwnd) {
                return if started { Ok("interrupted".into()) } else { Err("Its terminal lost the keyboard.".into()) };
            }
            let (sent, wanted) = platform::send_keys(chunk);
            if sent == 0 && !started {
                return Err("Windows would not take the keystrokes.".into());
            }
            started = true;
            if sent < wanted {
                return Ok("interrupted".into());
            }
            std::thread::sleep(CHUNK_PAUSE);
        }
        // The text is all there: only Enter is left, and only in the same window.
        if !platform::is_foreground(hwnd) {
            return Ok("interrupted".into());
        }
        let (sent, wanted) = platform::send_keys(&[KeyAction::Enter]);
        if sent < wanted {
            return Ok("interrupted".into());
        }
        Ok("typed".into())
    }

    /// B: the prompt box of the Claude Code panel, through the extension's link.
    fn prefill_panel(plan: &Plan, session_id: &str, text: &str) -> Result<String, String> {
        if !target::is_extension(&plan.entrypoint) {
            return Err("This session runs in the editor's terminal, which can't be picked from outside.".into());
        }
        let scheme = target::editor_image(&plan.target).and_then(link_scheme).ok_or("Nook doesn't know this editor's link.")?;
        let link = prompt_link(scheme, session_id, text)?;
        // The link opens in whichever window is in front: the session's first.
        let hwnd = crate::plan_window(plan).ok_or("This session's window couldn't be found.")?;
        if !platform::bring_forward(hwnd) {
            return Err("Its editor couldn't be brought forward.".into());
        }
        platform::open_url(&link);
        Ok("prefilled".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_terminal_shows_a_conversation_by_its_title() {
        let mine = "Nook folders in personal repos";
        // The glyph Claude Code puts first, whatever it is, and case.
        assert!(shows_conversation("◐ Nook folders in personal repos", mine));
        assert!(shows_conversation("✳ nook FOLDERS in personal repos", mine));
        // No glyph before it: not a tab Claude Code named, and nothing is typed there.
        assert!(!shows_conversation("Nook folders in personal repos", mine));
        assert!(!shows_conversation("[x] Nook folders in personal repos", mine));
        // The title is where the window's begins.
        assert!(!shows_conversation("◐ About Nook folders in personal repos", mine));
        assert!(shows_conversation("⠂ Nook folders in personal repos - Windows Terminal", mine));
        // The window's title cut short, with or without an ellipsis.
        assert!(shows_conversation("◐ Nook folders in pers…", mine));
        assert!(shows_conversation("◐ Nook folders in pers...", mine));
        assert!(shows_conversation("◐ Nook folders", mine));
        // The island's title cut short.
        assert!(shows_conversation("◐ Nook folders in personal repos", "Nook folders in pers…"));
        assert!(shows_conversation("◐ Nook folders in personal repos", "Nook folders in"));
        // Another tab.
        assert!(!shows_conversation("◐ Fix the updater", mine));
        assert!(!shows_conversation("Windows PowerShell", mine));
        assert!(!shows_conversation("✳ Claude Code", mine));
        // A window title too short to be a cut one proves nothing.
        assert!(!shows_conversation("◐ Nook", mine));
        assert!(!shows_conversation("pwsh", "pwsh is a shell"));
        // A title too short to prove anything, and nothing at all.
        assert!(!shows_conversation("◐ ab cd", "ab"));
        assert!(!shows_conversation("◐ Fix the updater", "Fix"));
        assert!(!shows_conversation("◐ Nook folders in personal repos", ""));
        assert!(!shows_conversation("◐ Nook folders in personal repos", "  ◐  "));
        assert!(!shows_conversation("", mine));
        assert!(!shows_conversation("", ""));
    }

    #[test]
    fn the_text_is_trimmed_not_empty_short_and_has_no_control_characters() {
        assert_eq!(clean_text("  hello  ").unwrap(), "hello");
        assert_eq!(clean_text("a\r\nb\rc\nd").unwrap(), "a\nb\nc\nd");
        assert_eq!(clean_text("a\tb").unwrap(), "a\tb");
        assert!(clean_text("").is_err() && clean_text(" \r\n\t ").is_err());
        assert!(clean_text(&"a".repeat(MAX_TEXT_CHARS)).is_ok());
        assert!(clean_text(&"a".repeat(MAX_TEXT_CHARS + 1)).is_err());
        assert!(clean_text(&"é".repeat(MAX_TEXT_CHARS)).is_ok());
        for bad in ["a\0b", "a\u{1b}[31m", "a\u{7}b", "a\u{85}b", "a\u{7f}b"] {
            assert!(clean_text(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_text_becomes_keys() {
        use KeyAction::{Char, Enter};
        assert_eq!(key_actions("hi"), [Char('h'), Char('i')]);
        // A new line is a backslash and Enter; a blank line is two of them.
        assert_eq!(key_actions("a\nb"), [Char('a'), Char('\\'), Enter, Char('b')]);
        assert_eq!(key_actions("a\n\nb"), [Char('a'), Char('\\'), Enter, Char('\\'), Enter, Char('b')]);
        // A tab is four spaces.
        assert_eq!(key_actions("a\tb"), [Char('a'), Char(' '), Char(' '), Char(' '), Char(' '), Char('b')]);
        // Characters stay whole: the pair of units is made when they are sent.
        assert_eq!(key_actions("é😀"), [Char('é'), Char('😀')]);
        assert_eq!('😀'.len_utf16(), 2);
        assert!(key_actions("").is_empty());
    }

    #[test]
    fn a_link_is_percent_encoded() {
        assert_eq!(percent_encode("AZaz09-._~"), "AZaz09-._~");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("a&b=c#d%e?f/g"), "a%26b%3Dc%23d%25e%3Ff%2Fg");
        assert_eq!(percent_encode("l1\nl2\tx"), "l1%0Al2%09x");
        assert_eq!(percent_encode("é"), "%C3%A9");
        assert_eq!(percent_encode("😀"), "%F0%9F%98%80");
        assert_eq!(percent_encode("日本"), "%E6%97%A5%E6%9C%AC");
        assert_eq!(percent_encode("'\"<>+;"), "%27%22%3C%3E%2B%3B");
    }

    #[test]
    fn the_link_opens_a_session_with_its_prompt() {
        assert_eq!(
            prompt_link("vscode", "019e2b4c-7f10", "fix it & test #1: 100%\nthanks é").unwrap(),
            "vscode://anthropic.claude-code/open?session=019e2b4c-7f10&prompt=fix%20it%20%26%20test%20%231%3A%20100%25%0Athanks%20%C3%A9"
        );
        assert!(prompt_link("cursor", "abc_DEF-1", "x").unwrap().starts_with("cursor://anthropic.claude-code/open?session=abc_DEF-1&prompt="));
        assert!(prompt_link("vscode", "a", &"a".repeat(MAX_LINK_TEXT_CHARS)).is_ok());
        assert!(prompt_link("vscode", "a", &"a".repeat(MAX_LINK_TEXT_CHARS + 1)).is_err());
        // Short in characters, too long once encoded.
        assert!(prompt_link("vscode", "a", &"😀".repeat(MAX_LINK_TEXT_CHARS)).is_err());
    }

    #[test]
    fn the_scheme_is_the_editors_own() {
        assert_eq!(link_scheme("code.exe"), Some("vscode"));
        assert_eq!(link_scheme("Code.exe"), Some("vscode"));
        assert_eq!(link_scheme("code - insiders.exe"), Some("vscode-insiders"));
        assert_eq!(link_scheme("cursor.exe"), Some("cursor"));
        assert_eq!(link_scheme("chrome.exe"), None);
        assert_eq!(link_scheme(""), None);
    }

    #[test]
    fn a_session_id_is_what_the_link_takes() {
        for good in ["a", "019e2b4c-7f10-7d3a-b2c1-0a9f8e7d6c5b", "abc_DEF-123", &"x".repeat(MAX_ID_LEN)] {
            assert!(link_session_id(good), "{good} should do");
        }
        let long = "x".repeat(MAX_ID_LEN + 1);
        for bad in ["", "a b", "a&b", "a/b", "a=b", "a%20", "é", "a\n", "session", long.as_str()] {
            assert!(!link_session_id(bad), "{bad:?} must be refused");
        }
        assert!(prompt_link("vscode", "a&session=b", "x").is_err());
    }
}
