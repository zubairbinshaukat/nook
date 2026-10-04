// What the Shelf's Media widget asks of the system: what is playing, in any
// player that tells Windows (Spotify, a browser, the Media Player), and the
// controls and the volume the system offers. All local: nothing leaves the
// machine, and the album art is read to memory and handed to the page, never
// written to disk.
//
// Nothing here runs on its own. The page asks, a call at a time, and only while
// the Media widget is on show: there is no subscription, no thread, no timer.
//
// The Windows half is platform/media_windows.rs (the system media transport
// controls, and Core Audio for the volume). Elsewhere the widget is told that
// it is not available.

use serde::Serialize;

/// What is playing, as the page draws it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    /// "session": something is on; "none": nothing is playing; "unavailable": the system cannot be asked (`reason` says why).
    pub kind: &'static str,
    pub reason: Option<String>,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// The player, in plain words ("Spotify").
    pub app: String,
    pub playing: bool,
    /// Where the track is now, and how long it is (0 when the player does not say), in milliseconds.
    pub position_ms: u64,
    pub duration_ms: u64,
    pub can_previous: bool,
    pub can_next: bool,
    pub can_toggle: bool,
    /// Changes when the track does: what tells the page to ask for the cover again.
    pub track_key: String,
}

impl MediaState {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn none() -> Self {
        MediaState { kind: "none", ..Default::default() }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        MediaState { kind: "unavailable", reason: Some(reason.into()), ..Default::default() }
    }
}

/// What the buttons can ask of the player.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Previous,
    Toggle,
    Next,
}

#[cfg(windows)]
#[path = "platform/media_windows.rs"]
mod imp;

#[cfg(not(windows))]
mod imp {
    use super::{Action, MediaState};

    pub fn state() -> MediaState {
        MediaState::unavailable("Media controls are not available on this system.")
    }
    pub fn cover() -> Option<String> {
        None
    }
    pub fn control(_action: Action) -> bool {
        false
    }
    pub fn volume() -> Option<u8> {
        None
    }
    pub fn set_volume(_percent: u8) -> bool {
        false
    }
}

pub fn state() -> MediaState {
    imp::state()
}

/// The current track's album art as a `data:` URL, or nothing.
pub fn cover() -> Option<String> {
    imp::cover()
}

pub fn control(action: Action) -> bool {
    imp::control(action)
}

/// The system's master volume, 0–100, or nothing when it cannot be read.
pub fn volume() -> Option<u8> {
    imp::volume()
}

pub fn set_volume(percent: u8) -> bool {
    imp::set_volume(percent.min(100))
}

// ── What does not need the system ─────────────────────────────────────────────

/// A player's id as Windows names it, in plain words: "Spotify.exe" is Spotify,
/// "chrome.exe" Chrome, and an app package's "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" ZuneMusic.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn app_name(id: &str) -> String {
    let id = id.trim();
    // A packaged app: "<family>!<app>"; the app is what is after the last dot of what follows the bang.
    let named = match id.rsplit_once('!') {
        Some((_, app)) => app.rsplit('.').next().unwrap_or(app),
        None => id,
    };
    let named = named.strip_suffix(".exe").or_else(|| named.strip_suffix(".EXE")).unwrap_or(named);
    let mut chars = named.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Where a track is now, in milliseconds: its position as the player last said it, moved on by the time
/// since it said so while it plays, and held between the timeline's start and end (when it has one).
/// Times are the system's own: 100 ns steps.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn position_ms(position: i64, start: i64, end: i64, said_at: i64, now: i64, playing: bool) -> (u64, u64) {
    let duration = (end - start).max(0);
    let mut at = position - start;
    if playing && now > said_at {
        at += now - said_at;
    }
    let at = if duration > 0 { at.clamp(0, duration) } else { at.max(0) };
    ((at / 10_000) as u64, (duration / 10_000) as u64)
}

/// What kind of picture these bytes are, from their first bytes: one the page can draw, or nothing.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Standard base64, padded.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A picture as the page can put it in an `<img>`; nothing for bytes that are not one it can draw.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn data_url(bytes: &[u8]) -> Option<String> {
    let kind = image_type(bytes)?;
    Some(format!("data:{kind};base64,{}", base64(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn players_are_named_in_plain_words() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("chrome.exe"), "Chrome");
        assert_eq!(app_name("msedge.exe"), "Msedge");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "ZuneMusic");
        assert_eq!(app_name("  "), "");
        assert_eq!(app_name("vlc"), "Vlc");
    }

    #[test]
    fn the_position_moves_on_while_it_plays_and_stays_inside_the_track() {
        let s = 10_000_000; // one second in the system's 100 ns steps
        // Said 10 s in, 3 s ago, playing: 13 s of a 200 s track.
        assert_eq!(position_ms(10 * s, 0, 200 * s, 100 * s, 103 * s, true), (13_000, 200_000));
        // Paused: it does not move.
        assert_eq!(position_ms(10 * s, 0, 200 * s, 100 * s, 103 * s, false), (10_000, 200_000));
        // Past the end (the player was slow to say): held at the end.
        assert_eq!(position_ms(199 * s, 0, 200 * s, 0, 50 * s, true), (200_000, 200_000));
        // A timeline that starts later is measured from its start.
        assert_eq!(position_ms(30 * s, 20 * s, 120 * s, 0, 0, false), (10_000, 100_000));
        // No end: no length, the position is what was said.
        assert_eq!(position_ms(5 * s, 0, 0, 0, 0, false), (5_000, 0));
    }

    #[test]
    fn a_picture_is_known_by_its_first_bytes() {
        assert_eq!(image_type(&[0x89, b'P', b'N', b'G', 1, 2]), Some("image/png"));
        assert_eq!(image_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a"), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"<svg onload=alert(1)>"), None);
        assert_eq!(image_type(&[]), None);
        assert_eq!(data_url(b"not a picture"), None);
    }

    #[test]
    fn base64_is_the_standard_one() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(data_url(&[0xFF, 0xD8, 0xFF]).unwrap(), "data:image/jpeg;base64,/9j/");
    }

    #[test]
    fn nothing_playing_and_not_available_are_two_things() {
        assert_eq!(MediaState::none().kind, "none");
        let gone = MediaState::unavailable("no");
        assert_eq!((gone.kind, gone.reason.as_deref()), ("unavailable", Some("no")));
    }
}
