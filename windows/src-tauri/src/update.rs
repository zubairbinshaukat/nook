// The opt-in update check: the one place Nook uses the network.
//
// It asks GitHub for the latest release of Nook, and only when the user clicks
// "Check now" or has switched on the daily check (Settings, off by default).
// The request carries nothing but a `User-Agent: Nook/<version>` header, which
// GitHub's API requires. It is made by the system's curl, so the app takes no
// HTTP client of its own. The page never says what to ask or where to go: the
// address of the API and the address that is opened are constants here.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, TryLockError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::{platform, settings};

const API_URL: &str = "https://api.github.com/repos/zubairbinshaukat/nook/releases/latest";
/// The only address this module ever opens.
const RELEASES_URL: &str = "https://github.com/zubairbinshaukat/nook/releases/latest";
const CURRENT: &str = env!("CARGO_PKG_VERSION");

const MINUTE_MS: u64 = 60_000;
const HOUR_MS: u64 = 60 * MINUTE_MS;
/// An automatic check is made when the last good one is older than this.
const INTERVAL_MS: u64 = 24 * HOUR_MS;
/// A failed automatic check is not tried again before this.
const RETRY_MS: u64 = HOUR_MS;
/// The app has been up this long before the first automatic check.
const STARTUP_GRACE_MS: u64 = MINUTE_MS;

/// What the pages are told after a check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub url: String,
    /// Unix milliseconds.
    pub checked_at: u64,
}

/// What is kept of a check. `available` is not: it is worked out against the
/// running version each time, since the app may have been updated since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    latest: String,
    /// False for a release GitHub marks as a draft or a pre-release.
    offered: bool,
    checked_at: u64,
}

impl Stored {
    fn info(&self, current: &str) -> UpdateInfo {
        UpdateInfo {
            current: current.to_string(),
            latest: self.latest.clone(),
            available: self.offered && is_newer(&self.latest, current),
            url: RELEASES_URL.to_string(),
            checked_at: self.checked_at,
        }
    }
}

// ── Versions ──────────────────────────────────────────────────────────────────

/// "v0.10.2-beta.1" is [0, 10, 2]: the leading `v`, and everything from the
/// first `-` or `+`, is left out. Anything that is not dotted numbers is none.
fn parse_version(text: &str) -> Option<Vec<u64>> {
    let text = text.trim();
    let text = text.strip_prefix(['v', 'V']).unwrap_or(text);
    let core = text.split(['-', '+']).next().unwrap_or("");
    if core.is_empty() {
        return None;
    }
    core.split('.').map(|part| if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) { None } else { part.parse().ok() }).collect()
}

/// True only when `latest` is strictly newer than `current`, number by number
/// (0.10.0 is newer than 0.9.9; 0.2 is the same as 0.2.0). Either one being
/// something else than a version is false.
fn is_newer(latest: &str, current: &str) -> bool {
    let (Some(mut latest), Some(mut current)) = (parse_version(latest), parse_version(current)) else { return false };
    let len = latest.len().max(current.len());
    latest.resize(len, 0);
    current.resize(len, 0);
    latest > current
}

// ── GitHub's answer ───────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
struct Release {
    /// The tag without a leading `v`.
    version: String,
    /// Neither a draft nor a pre-release.
    offered: bool,
}

fn parse_release(body: &[u8]) -> Result<Release, String> {
    let odd = || "GitHub's answer wasn't what Nook expected. Try again later.".to_string();
    let Ok(Value::Object(release)) = serde_json::from_slice::<Value>(body) else { return Err(odd()) };
    let tag = release.get("tag_name").and_then(Value::as_str).map(str::trim).unwrap_or("");
    let version = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    if version.is_empty() {
        return Err(odd());
    }
    let flag = |key: &str| release.get(key).and_then(Value::as_bool).unwrap_or(false);
    Ok(Release { version: version.to_string(), offered: !flag("draft") && !flag("prerelease") })
}

// ── Saved result ──────────────────────────────────────────────────────────────

fn path() -> PathBuf {
    settings::config_dir().join("update.json")
}

/// The file as it is, or nothing: a missing or damaged file is no result.
fn read_file(file: &Path) -> Option<Stored> {
    let stored: Stored = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    (!stored.latest.is_empty()).then_some(stored)
}

/// Written to a temporary file next to the real one, then put in its place.
fn write_file(file: &Path, stored: &Stored) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        platform::ensure_private_dir(dir)?;
    }
    let json = serde_json::to_vec_pretty(stored).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, json)?;
    std::fs::rename(&temp, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

// ── State ─────────────────────────────────────────────────────────────────────

struct State {
    /// The file has been looked at.
    loaded: bool,
    last: Option<Stored>,
    /// When the last automatic check failed (cleared by a success).
    failed_at: Option<u64>,
}

static STATE: Mutex<State> = Mutex::new(State { loaded: false, last: None, failed_at: None });
/// Held for the length of a check: there is one at a time.
static CHECKING: Mutex<()> = Mutex::new(());

fn state() -> std::sync::MutexGuard<'static, State> {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if !state.loaded {
        state.loaded = true;
        state.last = read_file(&path());
    }
    state
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The last good result of this run, or the saved one. No network.
pub fn last() -> Option<UpdateInfo> {
    state().last.as_ref().map(|stored| stored.info(CURRENT))
}

// ── The request ───────────────────────────────────────────────────────────────

fn curl() -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let mut cmd = Command::new(PathBuf::from(root).join("System32").join("curl.exe"));
        cmd.creation_flags(platform::CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new("curl")
    }
}

/// The fixed arguments of the request. No shell is involved, and nothing in
/// them comes from the user or the machine but the version.
fn curl_args(version: &str) -> Vec<String> {
    let mut args: Vec<String> = ["-q", "--silent", "--fail", "--proto", "=https", "--max-redirs", "0", "--max-time", "10", "--max-filesize", "1048576"]
        .map(String::from)
        .to_vec();
    args.extend(["-H".into(), format!("User-Agent: Nook/{version}"), "-H".into(), "Accept: application/vnd.github+json".into(), API_URL.into()]);
    args
}

/// What the user is told when curl stops with this exit code.
fn explain_curl(code: Option<i32>) -> String {
    match code {
        Some(6 | 7 | 28 | 35 | 52 | 55 | 56) => "Couldn't reach GitHub. Check your connection and try again.".into(),
        Some(22) => "GitHub didn't give an answer just now. Try again in a little while.".into(),
        _ => "The update check failed. Try again later.".into(),
    }
}

fn fetch() -> Result<Vec<u8>, String> {
    let output = curl()
        .args(curl_args(CURRENT))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|err| {
            crate::log::line(format!("update: curl did not start: {err}"));
            "Nook needs curl to check for updates, and couldn't find it on this computer.".to_string()
        })?;
    if !output.status.success() {
        crate::log::line(format!("update: curl exited with {:?}", output.status.code()));
        return Err(explain_curl(output.status.code()));
    }
    Ok(output.stdout)
}

/// One check, from asking to telling the windows. There is one at a time: a
/// call that finds another running waits for it and returns its result (or its
/// failure, when there is none).
fn run_check(app: &AppHandle) -> Result<UpdateInfo, String> {
    let _checking = match CHECKING.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(e)) => e.into_inner(),
        Err(TryLockError::WouldBlock) => {
            drop(CHECKING.lock());
            return last().ok_or_else(|| "The update check failed. Try again later.".to_string());
        }
    };
    let release = parse_release(&fetch()?)?;
    let stored = Stored { latest: release.version, offered: release.offered, checked_at: now_ms() };
    if let Err(err) = write_file(&path(), &stored) {
        crate::log::line(format!("update: could not save the result: {err}"));
    }
    let info = stored.info(CURRENT);
    {
        let mut state = state();
        state.last = Some(stored);
        state.failed_at = None;
    }
    let _ = app.emit("update_checked", info.clone());
    Ok(info)
}

// ── The daily check ───────────────────────────────────────────────────────────

/// Whether an automatic check is made now. Pure: the clock, the setting and
/// what happened before are all passed in.
fn due(enabled: bool, now: u64, started: u64, last_ok: Option<u64>, last_failed: Option<u64>) -> bool {
    if !enabled || now.saturating_sub(started) < STARTUP_GRACE_MS {
        return false;
    }
    if last_failed.is_some_and(|failed| failed <= now && now - failed < RETRY_MS) {
        return false;
    }
    // A good check dated in the future (the clock was set back) is no check.
    last_ok.is_none_or(|ok| ok > now || now - ok > INTERVAL_MS)
}

/// Looks at the settings once a minute. With the check off it does nothing
/// at all: no request is made.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let started = now_ms();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        let enabled = app.state::<crate::Shared>().settings.lock().map(|s| s.check_updates).unwrap_or(false);
        let (last_ok, last_failed) = {
            let state = state();
            (state.last.as_ref().map(|s| s.checked_at), state.failed_at)
        };
        if !due(enabled, now_ms(), started, last_ok, last_failed) {
            continue;
        }
        if let Err(err) = run_check(&app) {
            crate::log::line(format!("update: automatic check failed: {err}"));
            state().failed_at = Some(now_ms());
        }
    });
}

// ── Commands (lib.rs registers them) ──────────────────────────────────────────

/// Checks now, setting or not: it is the button.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || run_check(&app))
        .await
        .map_err(|_| "The update check failed. Try again later.".to_string())?
}

/// The last good result, from this run or the saved file. No network.
#[tauri::command]
pub fn update_last(_app: AppHandle) -> Option<UpdateInfo> {
    last()
}

/// Opens the releases page. No argument: the address is Nook's own.
#[tauri::command]
pub fn update_open() {
    platform::open_url(RELEASES_URL);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_compared_number_by_number() {
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(is_newer("0.2.1", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2.1"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(!is_newer("0.9.9", "0.10.0"));
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn versions_of_different_lengths_are_padded_with_zeros() {
        assert!(!is_newer("0.2", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2"));
        assert!(is_newer("0.2.1", "0.2"));
        assert!(!is_newer("0.2", "0.2.1"));
        assert!(is_newer("1", "0.9.9"));
    }

    #[test]
    fn a_leading_v_and_a_suffix_are_ignored() {
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert!(is_newer("0.3.0", "v0.2.0"));
        assert!(is_newer("0.3.0-beta.1", "0.2.0"));
        assert!(!is_newer("0.2.0-fix", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2.0-beta.1"));
        assert!(is_newer("0.2.1+build5", "0.2.0-rc.2"));
        assert_eq!(parse_version("v0.10.2-beta.1"), Some(vec![0, 10, 2]));
    }

    #[test]
    fn something_that_is_not_a_version_is_never_newer() {
        for bad in ["", "v", "latest", "1.x", "1..2", "-1", "1.2.3.", " ", "0.2.0a"] {
            assert!(!is_newer(bad, "0.1.0"), "{bad:?} as latest");
            assert!(!is_newer("9.9.9", bad), "{bad:?} as current");
        }
        assert!(!is_newer("99999999999999999999999.0", "0.1.0"));
    }

    #[test]
    fn a_release_answer_is_read() {
        let ok = br#"{"tag_name":"v0.3.0","name":"Nook 0.3.0","draft":false,"prerelease":false,"assets":[]}"#;
        assert_eq!(parse_release(ok), Ok(Release { version: "0.3.0".into(), offered: true }));
        let bare = br#"{"tag_name":"0.3.0"}"#;
        assert_eq!(parse_release(bare), Ok(Release { version: "0.3.0".into(), offered: true }));
    }

    #[test]
    fn a_draft_or_a_pre_release_is_never_offered() {
        let draft = br#"{"tag_name":"v0.9.0","draft":true,"prerelease":false}"#;
        let pre = br#"{"tag_name":"v0.9.0","draft":false,"prerelease":true}"#;
        assert!(!parse_release(draft).unwrap().offered);
        assert!(!parse_release(pre).unwrap().offered);
        let stored = Stored { latest: "0.9.0".into(), offered: false, checked_at: 1 };
        assert!(!stored.info("0.1.0").available);
    }

    #[test]
    fn an_answer_without_a_tag_or_not_json_is_an_error() {
        for body in [&br#"{"draft":false}"#[..], br#"{"tag_name":""}"#, br#"{"tag_name":7}"#, br#"{"tag_name":"v"}"#, b"<html>rate limited</html>", b"", br#"["v1.0.0"]"#, b"null"] {
            let err = parse_release(body).unwrap_err();
            assert!(!err.is_empty() && !err.contains('{') && !err.contains('<'), "{err}");
        }
    }

    #[test]
    fn the_info_is_worked_out_against_the_running_version() {
        let stored = Stored { latest: "0.3.0".into(), offered: true, checked_at: 1_700_000_000_000 };
        let behind = stored.info("0.2.0");
        assert!(behind.available);
        assert_eq!((behind.current.as_str(), behind.latest.as_str()), ("0.2.0", "0.3.0"));
        assert_eq!(behind.url, "https://github.com/zubairbinshaukat/nook/releases/latest");
        // The app was updated since: nothing to offer any more.
        assert!(!stored.info("0.3.0").available);
        assert!(!stored.info("0.4.0").available);
        let json = serde_json::to_value(&behind).unwrap();
        assert_eq!(json["checkedAt"], 1_700_000_000_000u64);
        assert_eq!(json["available"], true);
    }

    #[test]
    fn the_request_is_fixed_and_carries_only_the_version() {
        let args = curl_args("0.2.0");
        assert!(args.contains(&"User-Agent: Nook/0.2.0".to_string()));
        assert_eq!(args.last().unwrap(), "https://api.github.com/repos/zubairbinshaukat/nook/releases/latest");
        assert_eq!(args.iter().filter(|a| a.as_str() == "-H").count(), 2);
    }

    const T: u64 = 1_800_000_000_000;

    #[test]
    fn the_daily_check_is_due_after_a_day() {
        let up = T - 10 * MINUTE_MS;
        assert!(due(true, T, up, None, None), "never checked");
        assert!(!due(true, T, up, Some(T - 23 * HOUR_MS), None), "23 hours ago");
        assert!(due(true, T, up, Some(T - 25 * HOUR_MS), None), "25 hours ago");
        assert!(due(true, T, up, Some(T + HOUR_MS), None), "dated in the future");
    }

    #[test]
    fn the_daily_check_waits_a_minute_after_the_start() {
        assert!(!due(true, T, T - 30_000, None, None));
        assert!(due(true, T, T - 60_000, None, None));
    }

    #[test]
    fn a_failed_check_is_not_retried_for_an_hour() {
        let up = T - 5 * HOUR_MS;
        assert!(!due(true, T, up, None, Some(T - 30 * MINUTE_MS)), "30 minutes ago");
        assert!(due(true, T, up, None, Some(T - 61 * MINUTE_MS)), "61 minutes ago");
        // A failure does not bring forward a check that is not due anyway.
        assert!(!due(true, T, up, Some(T - HOUR_MS), Some(T - 2 * HOUR_MS)));
    }

    #[test]
    fn with_the_setting_off_nothing_is_ever_due() {
        assert!(!due(false, T, T - 10 * HOUR_MS, None, None));
        assert!(!due(false, T, T - 10 * HOUR_MS, Some(T - 100 * HOUR_MS), None));
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nook-update-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("update.json")
    }

    #[test]
    fn the_saved_result_round_trips() {
        let file = temp_file("round");
        assert_eq!(read_file(&file), None, "missing file");
        let stored = Stored { latest: "0.3.0".into(), offered: true, checked_at: 1_700_000_000_000 };
        write_file(&file, &stored).unwrap();
        assert_eq!(read_file(&file), Some(stored.clone()));
        assert!(!file.with_extension("json.tmp").exists());
        // Written again over the first.
        let newer = Stored { latest: "0.4.0".into(), ..stored };
        write_file(&file, &newer).unwrap();
        assert_eq!(read_file(&file), Some(newer));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn a_damaged_saved_file_is_no_result() {
        let file = temp_file("damaged");
        for junk in [&b"not json"[..], b"", b"{}", br#"{"latest":"","offered":true,"checkedAt":1}"#, br#"{"latest":3,"offered":true,"checkedAt":1}"#, &[0xff, 0xfe, 0x00]] {
            std::fs::write(&file, junk).unwrap();
            assert_eq!(read_file(&file), None, "{junk:?}");
        }
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }
}
