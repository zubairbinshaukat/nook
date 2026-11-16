//! Opt-in Codex App Server quota reader. A short-lived local server is started
//! only for a coalesced lifecycle-triggered read. Only normalized percentages
//! and timestamps survive a read; protocol payloads and account identifiers
//! are deliberately discarded.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, Lines};
use tokio::process::Command;
use tokio::time::timeout;

use crate::platform;

const MIN_REFRESH: Duration = Duration::from_secs(10 * 60);
const EVENT_COOLDOWN: Duration = Duration::from_secs(3 * 60);
/// A turn with no hook activity is presumed lost after this lease.
const INACTIVITY_LEASE: Duration = Duration::from_secs(10 * 60);
/// Keep recently expired turns long enough to associate late terminal/tool hooks.
const EXPIRED_TURN_TTL: Duration = Duration::from_secs(20 * 60);
/// Test helper: after a window resets the server may need a moment to roll it over.
#[cfg(test)]
const RESET_GRACE: Duration = Duration::from_secs(5);
/// The least delay in reset-scheduler unit tests.
#[cfg(test)]
const MIN_WAKE: Duration = Duration::from_secs(1);

const SNAPSHOT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PROTOCOL_LINE: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub used_percent: f64,
    pub window_duration_mins: u64,
    pub resets_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quotas {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Opt-in epoch: front ends discard events from an earlier enable period.
    pub generation: u64,
    pub quotas: Option<Quotas>,
    pub updated_at: Option<u64>,
    pub stale: bool,
    pub available: bool,
    pub failure_reason: Option<FailureReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureReason {
    Disabled,
    CliUnavailable,
    SpawnFailed,
    ProcessIsolationUnavailable,
    Timeout,
    Unauthorized,
    ServerExited,
    ProtocolError,
    QuotaUnavailable,
}

impl Snapshot {
    fn unavailable(reason: Option<FailureReason>) -> Self {
        Self {
            generation: 0,
            quotas: None,
            updated_at: None,
            stale: false,
            available: false,
            failure_reason: reason,
        }
    }
}

#[derive(Default)]
struct Cache {
    snapshot: Option<Snapshot>,
    fetched_at: Option<Instant>,
    failures: u32,
    /// Test-only simulation of the former retry policy.
    #[cfg(test)]
    quick_retry: bool,
    /// Test-only simulation of a follow-up read after a reset.
    #[cfg(test)]
    chase: bool,
    /// What the last read was logged as, so that only a change is written.
    last_note: String,
}

/// 1, 2, 4 … minutes after consecutive failures, never more than half an hour.
fn backoff(failures: u32) -> Duration {
    Duration::from_secs((60u64.saturating_mul(1u64 << failures.min(5))).min(30 * 60))
}

/// Some window in the snapshot has already reset: what it says is of a window that is over.
#[cfg(test)]
fn has_expired_window(snapshot: &Snapshot, now: u64) -> bool {
    snapshot.quotas.as_ref().is_some_and(|quotas| {
        [quotas.five_hour, quotas.seven_day]
            .into_iter()
            .flatten()
            .any(|window| window.resets_at <= now)
    })
}

/// Test-only reset-aware wait model. The production scheduler launches reads
/// only for lifecycle events and never schedules a read from reset times.
#[cfg(test)]
fn reset_wait(
    snapshot: Option<&Snapshot>,
    now: u64,
    since_read: Option<Duration>,
    spacing: Duration,
) -> Duration {
    let Some(quotas) = snapshot.and_then(|snapshot| snapshot.quotas.as_ref()) else {
        return MIN_REFRESH;
    };
    // When the spacing between two reads next allows one.
    let spacing_left = since_read.map_or(Duration::ZERO, |since| spacing.saturating_sub(since));
    let resets: Vec<u64> = [quotas.five_hour, quotas.seven_day]
        .into_iter()
        .flatten()
        .map(|window| window.resets_at)
        .collect();
    if resets.iter().any(|at| *at <= now) {
        return spacing_left.max(MIN_WAKE);
    }
    match resets.into_iter().min() {
        Some(at) => Duration::from_millis(at - now)
            .saturating_add(RESET_GRACE)
            .max(spacing_left)
            .max(MIN_WAKE)
            .min(MIN_REFRESH),
        None => MIN_REFRESH,
    }
}

#[derive(Default)]
pub struct Provider {
    cache: Mutex<Cache>,
    gate: tokio::sync::Mutex<()>,
    enabled: std::sync::atomic::AtomicBool,
    enabled_generation: std::sync::atomic::AtomicU64,
    wake: tokio::sync::Notify,
    activity: Mutex<Activity>,
    read_abort: Mutex<Option<tokio::task::AbortHandle>>,
}

#[derive(Default)]
struct Activity {
    sessions: HashMap<String, SessionActivity>,
    expired_turns: VecDeque<ExpiredTurn>,
    last_read: Option<Instant>,
    pending: bool,
    final_pending: bool,
    failed_turns: HashSet<TurnKey>,
    closed_turns: VecDeque<TurnKey>,
}

type TurnKey = (String, String);

struct ExpiredTurn {
    session: String,
    activity: SessionActivity,
    expired_at: Instant,
}

impl Activity {
    fn close_turn(&mut self, session: &str, turn: &str) -> bool {
        self.remember_closed(session, turn);
        !self
            .failed_turns
            .remove(&(session.to_owned(), turn.to_owned()))
    }

    fn prune_expired(&mut self, now: Instant) {
        let removed: Vec<_> = self
            .expired_turns
            .iter()
            .filter(|expired| now.saturating_duration_since(expired.expired_at) >= EXPIRED_TURN_TTL)
            .map(|expired| (expired.session.clone(), expired.activity.turn.clone()))
            .collect();
        self.expired_turns
            .retain(|expired| now.saturating_duration_since(expired.expired_at) < EXPIRED_TURN_TTL);
        for key in removed {
            self.failed_turns.remove(&key);
        }
    }

    fn remember_closed(&mut self, session: &str, turn: &str) {
        if turn == "?" {
            return;
        }
        let key = (session.to_owned(), turn.to_owned());
        if !self.closed_turns.contains(&key) {
            self.closed_turns.push_back(key);
            if self.closed_turns.len() > 128 {
                self.closed_turns.pop_front();
            }
        }
    }

    fn expired_index(&self, session: &str, turn: &str) -> Option<usize> {
        self.expired_turns.iter().rposition(|expired| {
            expired.session == session && (turn == "?" || expired.activity.turn == turn)
        })
    }

    fn end_session(&mut self, session: &str) {
        let mut should_refresh = false;
        if let Some(active) = self.sessions.remove(session) {
            should_refresh |= self.close_turn(session, &active.turn);
        }
        let expired_turns: Vec<_> = self
            .expired_turns
            .iter()
            .filter(|expired| expired.session == session)
            .map(|expired| expired.activity.turn.clone())
            .collect();
        if !expired_turns.is_empty() {
            self.expired_turns
                .retain(|expired| expired.session != session);
            for turn in expired_turns {
                should_refresh |= self.close_turn(session, &turn);
            }
        }
        self.final_pending |= should_refresh;
    }

    fn restore_late_event(
        &mut self,
        event: &str,
        session: &str,
        turn: &str,
        agent: Option<&str>,
        now: Instant,
    ) -> bool {
        if event == "SubagentStop" && turn == "?" {
            return false;
        }
        if turn == "?"
            && matches!(event, "Stop" | "Interrupt")
            && self
                .sessions
                .get(session)
                .is_some_and(|active| active.turn != "?")
        {
            self.final_pending = true;
            return true;
        }
        let Some(index) = self.expired_index(session, turn) else {
            return false;
        };
        let mut expired = self.expired_turns.remove(index).unwrap();
        if event == "SubagentStop" {
            if let Some(agent) = agent {
                expired.activity.background.remove(agent);
            }
            if expired.activity.stopping && expired.activity.background.is_empty() {
                self.final_pending |= self.close_turn(session, &expired.activity.turn);
                return true;
            }
        }
        if event == "Stop" && !expired.activity.background.is_empty() {
            expired.activity.stopping = true;
        }
        if event == "Interrupt" || (event == "Stop" && expired.activity.background.is_empty()) {
            self.final_pending |= self.close_turn(session, &expired.activity.turn);
            return true;
        }
        if self
            .sessions
            .get(session)
            .is_some_and(|active| active.turn != expired.activity.turn)
        {
            // The event belongs to an old turn; never replace a newer active turn.
            self.expired_turns.push_back(expired);
            return true;
        }
        let mut activity = expired.activity;
        activity.last_event = now;
        self.sessions.insert(session.to_owned(), activity);
        true
    }
}

struct SessionActivity {
    turn: String,
    last_event: Instant,
    background: HashSet<String>,
    stopping: bool,
}

impl Default for SessionActivity {
    fn default() -> Self {
        Self {
            turn: String::new(),
            last_event: Instant::now(),
            background: HashSet::new(),
            stopping: false,
        }
    }
}

impl Activity {
    fn event(
        &mut self,
        event: &str,
        session: Option<&str>,
        turn: Option<&str>,
        agent: Option<&str>,
        now: Instant,
    ) {
        self.prune_expired(now);
        let session = session
            .filter(|id| !id.is_empty())
            .unwrap_or("@unknown-session");
        let turn = turn.filter(|id| !id.is_empty()).unwrap_or("?").to_owned();
        if event == "SessionEnd" {
            self.end_session(session);
            return;
        }
        if !matches!(event, "UserPromptSubmit")
            && self.restore_late_event(event, session, &turn, agent, now)
            && (matches!(event, "Stop" | "Interrupt" | "SessionEnd")
                || self
                    .sessions
                    .get(session)
                    .is_some_and(|active| active.turn != turn && turn != "?"))
        {
            return;
        }
        match event {
            "UserPromptSubmit" => {
                if turn != "?"
                    && self
                        .closed_turns
                        .contains(&(session.to_owned(), turn.clone()))
                {
                    return;
                }
                if let Some((existing_turn, last_event)) = self
                    .sessions
                    .get(session)
                    .map(|entry| (entry.turn.clone(), entry.last_event))
                {
                    if existing_turn == turn
                        && now.saturating_duration_since(last_event) < INACTIVITY_LEASE
                    {
                        return;
                    }
                    if existing_turn != turn {
                        self.remember_closed(session, &existing_turn);
                        self.failed_turns
                            .remove(&(session.to_owned(), existing_turn));
                    }
                }
                let entry = self.sessions.entry(session.to_owned()).or_default();
                *entry = SessionActivity {
                    turn: turn.clone(),
                    last_event: now,
                    ..Default::default()
                };
                self.failed_turns.remove(&(session.to_owned(), turn));
                self.pending = true;
            }
            "SubagentStart" => {
                if let Some(entry) = self.sessions.get_mut(session) {
                    if entry.turn == turn {
                        entry.last_event = now;
                        entry.background.insert(agent.unwrap_or("?").to_owned());
                    }
                }
            }
            "SubagentStop" => {
                let close_turn = if let Some(entry) = self.sessions.get_mut(session) {
                    if entry.turn == turn {
                        entry.last_event = now;
                        if let Some(agent) = agent {
                            entry.background.remove(agent);
                        }
                        if entry.stopping && entry.background.is_empty() {
                            Some(entry.turn.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                if let Some(turn) = close_turn {
                    self.sessions.remove(session);
                    self.final_pending |= self.close_turn(session, &turn);
                }
            }
            "Stop" => {
                let close_turn = if let Some(entry) = self.sessions.get_mut(session) {
                    if entry.turn == turn || turn == "?" {
                        entry.last_event = now;
                        if entry.background.is_empty() {
                            Some(entry.turn.clone())
                        } else {
                            entry.stopping = true;
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                if let Some(turn) = close_turn {
                    self.sessions.remove(session);
                    self.final_pending |= self.close_turn(session, &turn);
                }
            }
            "Interrupt" | "SessionEnd" => {
                let matches = self.sessions.get(session).is_some_and(|entry| {
                    event == "SessionEnd" || entry.turn == turn || turn == "?"
                });
                if matches {
                    if let Some(turn) = self.sessions.get(session).map(|entry| entry.turn.clone()) {
                        self.final_pending |= self.close_turn(session, &turn);
                    }
                    self.sessions.remove(session);
                }
            }
            _ => {
                if let Some(entry) = self.sessions.get_mut(session) {
                    entry.last_event = now;
                }
            }
        }
    }

    fn requesting_turns(&self) -> HashSet<TurnKey> {
        self.sessions
            .iter()
            .map(|(session, turn)| (session.clone(), turn.turn.clone()))
            .collect()
    }

    fn expire(&mut self, now: Instant) {
        self.prune_expired(now);
        let needs_final = self.sessions.iter().any(|(session, item)| {
            now.saturating_duration_since(item.last_event) >= INACTIVITY_LEASE
                && !self
                    .failed_turns
                    .contains(&(session.clone(), item.turn.clone()))
        });
        let before = self.sessions.len();
        let expired: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, item)| now.saturating_duration_since(item.last_event) >= INACTIVITY_LEASE)
            .map(|(session, _)| session.clone())
            .collect();
        for session in expired {
            if let Some(activity) = self.sessions.remove(&session) {
                if self.expired_turns.len() == 128 {
                    if let Some(oldest) = self.expired_turns.pop_front() {
                        self.failed_turns
                            .remove(&(oldest.session, oldest.activity.turn));
                    }
                }
                self.expired_turns.push_back(ExpiredTurn {
                    session,
                    activity,
                    expired_at: now,
                });
            }
        }
        self.failed_turns.retain(|(session, turn)| {
            self.sessions
                .get(session)
                .is_some_and(|item| item.turn == *turn)
                || self
                    .expired_turns
                    .iter()
                    .any(|expired| expired.session == *session && expired.activity.turn == *turn)
        });
        if self.sessions.len() != before && needs_final {
            self.final_pending = true;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ScheduleAction {
    Idle,
    Wait(Duration),
    Refresh,
}

fn schedule_action(activity: &mut Activity, now: Instant) -> ScheduleAction {
    activity.expire(now);
    let has_work = activity.pending || activity.final_pending;
    if !has_work {
        return ScheduleAction::Idle;
    }
    let spacing_left = activity.last_read.map_or(Duration::ZERO, |at| {
        EVENT_COOLDOWN.saturating_sub(now.saturating_duration_since(at))
    });
    if spacing_left.is_zero() {
        return ScheduleAction::Refresh;
    }
    if spacing_left > Duration::ZERO {
        return ScheduleAction::Wait(spacing_left);
    }
    let until_lease = activity
        .sessions
        .values()
        .map(|turn| INACTIVITY_LEASE.saturating_sub(now.saturating_duration_since(turn.last_event)))
        .min()
        .unwrap_or(INACTIVITY_LEASE);
    ScheduleAction::Wait(until_lease.max(Duration::from_millis(1)))
}

fn record_read_result(
    activity: &mut Activity,
    snapshot: &Snapshot,
    requesting_turns: &HashSet<TurnKey>,
) {
    if snapshot.failure_reason.is_none() {
        return;
    }
    let still_active: Vec<_> = requesting_turns
        .iter()
        .filter(|(session, turn)| {
            activity
                .sessions
                .get(session)
                .is_some_and(|active| active.turn == *turn)
        })
        .cloned()
        .collect();
    activity.failed_turns.extend(still_active);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn visible_snapshot(snapshot: &Snapshot, now: u64) -> Snapshot {
    if snapshot.quotas.is_none() {
        return snapshot.clone();
    }
    let age = snapshot.updated_at.map(|at| now.saturating_sub(at));
    if age.is_none_or(|age| age > SNAPSHOT_TTL.as_millis() as u64) {
        return Snapshot {
            generation: snapshot.generation,
            updated_at: snapshot.updated_at,
            stale: true,
            ..Snapshot::unavailable(Some(FailureReason::QuotaUnavailable))
        };
    }
    let mut visible = snapshot.clone();
    visible.stale |= age.is_some_and(|age| age > MIN_REFRESH.as_millis() as u64);
    if let Some(quotas) = &mut visible.quotas {
        quotas.five_hour = quotas.five_hour.filter(|window| window.resets_at > now);
        quotas.seven_day = quotas.seven_day.filter(|window| window.resets_at > now);
        if quotas.five_hour.is_none() && quotas.seven_day.is_none() {
            visible.quotas = None;
            visible.available = false;
            visible.stale = true;
            visible.failure_reason = Some(FailureReason::QuotaUnavailable);
        }
    }
    visible
}

/// A window as the server sent it, or why it is not one. The reason is a fixed phrase — never a
/// value — so that it can be logged.
fn window_problem(value: &Value, now: u64) -> Result<Window, &'static str> {
    let used = value
        .get("usedPercent")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && (0.0..=100.0).contains(v))
        .ok_or("usedPercent missing, null or out of range")?;
    let duration = value
        .get("windowDurationMins")
        .and_then(Value::as_u64)
        .ok_or("windowDurationMins missing or null")?;
    let resets_at = value
        .get("resetsAt")
        .and_then(Value::as_u64)
        .and_then(|at| at.checked_mul(1000))
        .ok_or("resetsAt missing or null")?;
    if resets_at <= now {
        return Err("resetsAt not in the future");
    }
    if resets_at > now.saturating_add(35 * 24 * 60 * 60 * 1000) {
        return Err("resetsAt more than 35 days ahead");
    }
    Ok(Window {
        used_percent: used,
        window_duration_mins: duration,
        resets_at,
    })
}

fn read_window(value: &Value, now: u64) -> Option<Window> {
    window_problem(value, now).ok()
}

/// What the answer's two windows were, in words, when one of them was not taken. Logged when it
/// changes, so the next time the dash is up the log says why: no values, only the reasons.
fn dropped_windows(root: &Value, now: u64) -> String {
    let mut parts = Vec::new();
    for name in ["primary", "secondary"] {
        match root.get("rateLimits").and_then(|limits| limits.get(name)) {
            None | Some(Value::Null) => parts.push(format!("{name}: absent")),
            Some(window) => {
                if let Err(reason) = window_problem(window, now) {
                    parts.push(format!("{name}: {reason}"));
                }
            }
        }
    }
    parts.join("; ")
}

fn note_dropped(root: &Value, now: u64) {
    static LAST: Mutex<String> = Mutex::new(String::new());
    let text = dropped_windows(root, now);
    let mut last = LAST.lock().unwrap();
    if *last != text {
        if !text.is_empty() {
            crate::log::line(format!("codex quota: window not taken ({text})"));
        }
        *last = text;
    }
}

/// Select windows by their protocol duration rather than their object key/order.
pub fn parse_rate_limits(root: &Value, now: u64) -> Option<Quotas> {
    let limits = root.get("rateLimits")?;
    let mut five_hour = None;
    let mut seven_day = None;
    let mut candidates = Vec::new();
    if let Some(primary) = limits.get("primary") {
        candidates.push(primary);
    }
    if let Some(secondary) = limits.get("secondary") {
        candidates.push(secondary);
    }
    if let Some(by_id) = root.get("rateLimitsByLimitId").and_then(Value::as_object) {
        if let Some(codex) = by_id.get("codex").and_then(Value::as_object) {
            for name in ["primary", "secondary"] {
                if let Some(window) = codex.get(name) {
                    candidates.push(window);
                }
            }
        }
    }
    for candidate in candidates {
        let Some(window) = read_window(candidate, now) else {
            continue;
        };
        match window.window_duration_mins {
            300 if five_hour.is_none() => five_hour = Some(window),
            10_080 if seven_day.is_none() => seven_day = Some(window),
            _ => {}
        }
    }
    (five_hour.is_some() || seven_day.is_some()).then_some(Quotas {
        five_hour,
        seven_day,
    })
}

fn version_tuple(text: &str) -> Option<(u64, u64, u64)> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let version = text[start..].split_whitespace().next()?;
    let mut numbers = version.split(['.', '-', '+']);
    Some((
        numbers.next()?.parse().ok()?,
        numbers.next()?.parse().ok()?,
        numbers.next()?.parse().ok()?,
    ))
}

fn is_hash_dir(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    (8..=128).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn trusted_candidates(local_app_data: &Path, path_value: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let root = local_app_data.join("OpenAI").join("Codex").join("bin");
    let canonical_root = root.canonicalize().ok();
    let mut paths = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        let mut versions: Vec<_> = entries
            .flatten()
            .filter(|entry| {
                entry.file_type().is_ok_and(|kind| kind.is_dir()) && is_hash_dir(&entry.file_name())
            })
            .collect();
        versions.sort_by_key(|entry| {
            std::cmp::Reverse(entry.metadata().and_then(|m| m.modified()).ok())
        });
        for entry in versions {
            paths.push(entry.path().join("codex.exe"));
        }
    }
    // Preserve PATH order, but only accept canonical executables within the
    // signed-in user's known Codex Desktop installation root.
    if let Some(path_value) = path_value {
        for dir in std::env::split_paths(path_value) {
            let candidate = dir.join("codex.exe");
            if let Ok(canonical) = candidate.canonicalize() {
                if canonical
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
                    && canonical_root
                        .as_ref()
                        .is_some_and(|root| canonical.starts_with(root))
                {
                    paths.push(canonical);
                }
            }
        }
    }
    paths = paths
        .into_iter()
        .filter_map(|path| {
            if !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            {
                return None;
            }
            let canonical = path.canonicalize().ok()?;
            canonical_root
                .as_ref()
                .is_some_and(|root| canonical.starts_with(root))
                .then_some(canonical)
        })
        .collect();
    paths.dedup();
    paths
}

fn candidates() -> Vec<PathBuf> {
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return Vec::new();
    };
    trusted_candidates(&local, std::env::var_os("PATH").as_deref())
}

fn resolve_codex_home(configured: Option<PathBuf>, user_profile: PathBuf) -> PathBuf {
    configured.unwrap_or_else(|| user_profile.join(".codex"))
}

async fn suitable_cli() -> Option<PathBuf> {
    suitable_cli_from(candidates()).await
}

async fn suitable_cli_from(paths: Vec<PathBuf>) -> Option<PathBuf> {
    for path in paths {
        let mut command = Command::new(&path);
        command
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            command.creation_flags(crate::platform::CREATE_NO_WINDOW);
        }
        let Ok(Ok(output)) = timeout(Duration::from_secs(3), command.output()).await else {
            continue;
        };
        let version = String::from_utf8_lossy(&output.stdout);
        if output.status.success() && version_tuple(&version).is_some_and(|v| v >= (0, 165, 0)) {
            return Some(path);
        }
    }
    None
}

async fn read_from_cli(path: &Path, home: &Path) -> Result<Quotas, FailureReason> {
    read_from_cli_with(path, home, &["app-server"], None, REQUEST_TIMEOUT).await
}

async fn read_from_cli_with(
    path: &Path,
    home: &Path,
    args: &[&str],
    extra_env: Option<(&str, &str)>,
    request_timeout: Duration,
) -> Result<Quotas, FailureReason> {
    let user_home = crate::platform::home_dir();
    let mut command = Command::new(path);
    command
        .args(args)
        .current_dir(home)
        .env("CODEX_HOME", home)
        // The bundled Windows CLI searches HOME for its user profile even
        // when CODEX_HOME and the working directory are already set.
        .env("HOME", &user_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.env("USERPROFILE", &user_home);
    if let Some((key, value)) = extra_env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        command.creation_flags(crate::platform::CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| FailureReason::SpawnFailed)?;
    #[cfg(windows)]
    let job = match ChildJob::attach(&child) {
        Ok(job) => job,
        Err(()) => {
            terminate_and_reap(&mut child).await;
            return Err(FailureReason::ProcessIsolationUnavailable);
        }
    };
    let result = timeout(request_timeout, async {
        let mut stdin = child.stdin.take().ok_or(FailureReason::ProtocolError)?;
        let stdout = child.stdout.take().ok_or(FailureReason::ProtocolError)?;
        let mut reader = BufReader::new(stdout).lines();
        request_quotas(&mut reader, &mut stdin, now_ms()).await
    })
    .await;
    // Kill and reap on success, protocol errors, and timeout alike.
    terminate_and_reap(&mut child).await;
    #[cfg(windows)]
    drop(job);
    result.map_err(|_| FailureReason::Timeout)?
}

/// JSONL app-server exchange separated from process discovery so tests can
/// exercise it against an in-memory server without starting the real CLI.
async fn request_quotas<R, W>(
    reader: &mut Lines<BufReader<R>>,
    writer: &mut W,
    now: u64,
) -> Result<Quotas, FailureReason>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let initialize = format!("{{\"id\":1,\"method\":\"initialize\",\"params\":{{\"clientInfo\":{{\"name\":\"nook\",\"version\":\"{}\"}},\"capabilities\":{{}}}}}}\n", env!("CARGO_PKG_VERSION"));
    writer
        .write_all(initialize.as_bytes())
        .await
        .map_err(|_| FailureReason::ProtocolError)?;
    for _ in 0..32 {
        let line = reader
            .next_line()
            .await
            .map_err(|_| FailureReason::ProtocolError)?
            .ok_or(FailureReason::ServerExited)?;
        if line.len() > MAX_PROTOCOL_LINE {
            return Err(FailureReason::ProtocolError);
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if is_server_request(&message) {
            answer_server_request(writer, &message).await?;
            continue;
        }
        if message.get("id").and_then(Value::as_i64) != Some(1)
            || (message.get("result").is_none() && message.get("error").is_none())
        {
            continue;
        }
        if message.get("error").is_some() {
            return Err(failure_from_response(&message));
        }
        writer
            .write_all(b"{\"method\":\"initialized\",\"params\":{}}\n")
            .await
            .map_err(|_| FailureReason::ProtocolError)?;
        writer
            .write_all(b"{\"id\":2,\"method\":\"account/rateLimits/read\",\"params\":{}}\n")
            .await
            .map_err(|_| FailureReason::ProtocolError)?;
        for _ in 0..32 {
            let line = reader
                .next_line()
                .await
                .map_err(|_| FailureReason::ProtocolError)?
                .ok_or(FailureReason::ServerExited)?;
            if line.len() > MAX_PROTOCOL_LINE {
                return Err(FailureReason::ProtocolError);
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if is_server_request(&message) {
                answer_server_request(writer, &message).await?;
                continue;
            }
            if message.get("id").and_then(Value::as_i64) != Some(2)
                || (message.get("result").is_none() && message.get("error").is_none())
            {
                continue;
            }
            if message.get("error").is_some() {
                return Err(failure_from_response(&message));
            }
            let result = message.get("result").unwrap_or(&Value::Null);
            note_dropped(result, now);
            return parse_rate_limits(result, now).ok_or(FailureReason::QuotaUnavailable);
        }
        return Err(FailureReason::ProtocolError);
    }
    Err(FailureReason::ProtocolError)
}

fn is_server_request(message: &Value) -> bool {
    message.get("id").is_some_and(|id| !id.is_null())
        && message.get("method").and_then(Value::as_str).is_some()
        && message.get("result").is_none()
        && message.get("error").is_none()
}

async fn answer_server_request<W: AsyncWrite + Unpin>(
    writer: &mut W,
    message: &Value,
) -> Result<(), FailureReason> {
    let Some(id) = message.get("id").filter(|id| !id.is_null()) else {
        return Ok(());
    };
    let response =
        serde_json::json!({"id":id,"error":{"code":-32601,"message":"Unsupported request"}});
    writer
        .write_all(response.to_string().as_bytes())
        .await
        .map_err(|_| FailureReason::ProtocolError)?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|_| FailureReason::ProtocolError)
}

fn failure_from_response(message: &Value) -> FailureReason {
    match message
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_i64)
    {
        Some(-32001) => FailureReason::Unauthorized,
        _ => FailureReason::ProtocolError,
    }
}

async fn terminate_and_reap(child: &mut tokio::process::Child) {
    let _ = child.kill().await;
    let _ = timeout(Duration::from_secs(1), child.wait()).await;
}

#[cfg(windows)]
struct ChildJob(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ChildJob {
    fn attach(child: &tokio::process::Child) -> Result<Self, ()> {
        use std::mem::size_of;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        unsafe {
            let pid = child.id().ok_or(())?;
            let job = CreateJobObjectW(None, PCWSTR::null()).map_err(|_| ())?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let process = match OpenProcess(
                PROCESS_ACCESS_RIGHTS(
                    PROCESS_SET_QUOTA.0 | PROCESS_TERMINATE.0 | PROCESS_QUERY_LIMITED_INFORMATION.0,
                ),
                false,
                pid,
            ) {
                Ok(process) => process,
                Err(_) => {
                    let _ = CloseHandle(job);
                    return Err(());
                }
            };
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<std::ffi::c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .is_err()
                || AssignProcessToJobObject(job, process).is_err()
            {
                let _ = CloseHandle(process);
                let _ = CloseHandle(job);
                return Err(());
            }
            let _ = CloseHandle(process);
            Ok(Self(job))
        }
    }
}

#[cfg(windows)]
unsafe impl Send for ChildJob {}

#[cfg(windows)]
impl Drop for ChildJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

async fn fetch() -> Result<Quotas, FailureReason> {
    let cli = suitable_cli().await.ok_or(FailureReason::CliUnavailable)?;
    let user_profile = std::env::var_os(crate::platform::HOME_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(platform::home_dir);
    let configured_home = std::env::var_os("CODEX_HOME").map(PathBuf::from);
    let home = resolve_codex_home(configured_home, user_profile);
    read_from_cli(&cli, &home).await
}

impl Provider {
    pub fn set_enabled(&self, enabled: bool) {
        use std::sync::atomic::Ordering;
        if self.enabled.swap(enabled, Ordering::SeqCst) != enabled {
            let generation = self.enabled_generation.fetch_add(1, Ordering::SeqCst) + 1;
            if !enabled {
                *self.cache.lock().unwrap() = Cache::default();
                *self.activity.lock().unwrap() = Activity::default();
                if let Some(read) = self.read_abort.lock().unwrap().as_ref() {
                    read.abort();
                }
            } else {
                let mut cache = self.cache.lock().unwrap();
                cache.snapshot = Some(Snapshot {
                    generation,
                    quotas: None,
                    updated_at: None,
                    stale: false,
                    available: false,
                    failure_reason: None,
                });
                cache.fetched_at = None;
            }
            self.wake.notify_one();
        }
    }

    fn stamp(&self, mut snapshot: Snapshot) -> Snapshot {
        snapshot.generation = self
            .enabled_generation
            .load(std::sync::atomic::Ordering::SeqCst);
        snapshot
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Record a verified Codex relay event. This method never performs I/O.
    pub fn note_event(
        &self,
        event: &str,
        session: Option<&str>,
        turn: Option<&str>,
        agent: Option<&str>,
    ) {
        if !self.is_enabled() {
            return;
        }
        let mut activity = self.activity.lock().unwrap();
        let at = Instant::now();
        let duplicate_prompt = event == "UserPromptSubmit"
            && session.zip(turn).is_some_and(|(session, turn)| {
                activity.sessions.get(session).is_some_and(|active| {
                    active.turn == turn
                        && at.saturating_duration_since(active.last_event) < INACTIVITY_LEASE
                })
            });
        activity.event(event, session, turn, agent, Instant::now());
        if !duplicate_prompt
            && matches!(
                event,
                "UserPromptSubmit"
                    | "PreToolUse"
                    | "PostToolUse"
                    | "PostToolUseFailure"
                    | "SubagentStart"
                    | "SubagentStop"
                    | "Stop"
                    | "Interrupt"
                    | "SessionEnd"
            )
        {
            activity.pending = true;
        }
        self.wake.notify_one();
    }

    #[cfg(test)]
    pub async fn read(&self) -> Snapshot {
        self.read_with_at(Instant::now(), fetch()).await
    }

    async fn read_for_event(&self) -> Snapshot {
        self.read_with_at_policy(Instant::now(), fetch(), true)
            .await
    }

    /// Return the current in-memory snapshot without triggering a CLI or app-server read.
    pub fn last_snapshot(&self) -> Snapshot {
        let cache = self.cache.lock().unwrap();
        cache
            .snapshot
            .as_ref()
            .map(|snapshot| self.stamp(visible_snapshot(snapshot, now_ms())))
            .unwrap_or_else(|| {
                let mut snapshot = Snapshot::unavailable(if self.is_enabled() {
                    None
                } else {
                    Some(FailureReason::Disabled)
                });
                if self.is_enabled() {
                    snapshot.failure_reason = None;
                }
                self.stamp(snapshot)
            })
    }

    /// Test-only reset-aware wait model; production does not poll.
    #[cfg(test)]
    pub fn next_wait(&self) -> Duration {
        let cache = self.cache.lock().unwrap();
        if cache.quick_retry || cache.chase {
            return backoff(cache.failures);
        }
        let since_read = cache
            .fetched_at
            .map(|at| Instant::now().saturating_duration_since(at));
        reset_wait(
            cache.snapshot.as_ref(),
            now_ms(),
            since_read,
            backoff(cache.failures),
        )
    }

    #[cfg(test)]
    async fn read_with_at<F>(&self, now: Instant, fetch_result: F) -> Snapshot
    where
        F: Future<Output = Result<Quotas, FailureReason>>,
    {
        self.read_with_at_policy(now, fetch_result, false).await
    }

    async fn read_with_at_policy<F>(
        &self,
        now: Instant,
        fetch_result: F,
        event_refresh: bool,
    ) -> Snapshot
    where
        F: Future<Output = Result<Quotas, FailureReason>>,
    {
        let _guard = self.gate.lock().await;
        if !self.is_enabled() {
            return self.stamp(Snapshot::unavailable(Some(FailureReason::Disabled)));
        }
        let generation = self
            .enabled_generation
            .load(std::sync::atomic::Ordering::SeqCst);
        if !self.is_enabled() {
            return self.stamp(Snapshot::unavailable(Some(FailureReason::Disabled)));
        }
        {
            let cache = self.cache.lock().unwrap();
            let backoff = backoff(cache.failures);
            #[cfg(test)]
            let sooner = cache.quick_retry
                || cache.chase
                || cache
                    .snapshot
                    .as_ref()
                    .is_some_and(|snapshot| has_expired_window(snapshot, now_ms()));
            #[cfg(not(test))]
            let sooner = false;
            let hold = if event_refresh {
                // The lifecycle scheduler enforces the event cooldown. After a failure,
                // the local backoff only gates a later distinct event; it never schedules one.
                if cache.failures > 0 {
                    backoff
                } else {
                    Duration::ZERO
                }
            } else if sooner {
                backoff
            } else {
                MIN_REFRESH.max(backoff)
            };
            if cache
                .fetched_at
                .is_some_and(|at| now.saturating_duration_since(at) < hold)
            {
                return cache
                    .snapshot
                    .as_ref()
                    .map(|snapshot| self.stamp(visible_snapshot(snapshot, now_ms())))
                    .unwrap_or_else(|| self.stamp(Snapshot::unavailable(None)));
            }
        }
        let result = fetch_result.await;
        let mut cache = self.cache.lock().unwrap();
        if !self.is_enabled()
            || self
                .enabled_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != generation
        {
            return self.stamp(Snapshot::unavailable(Some(FailureReason::Disabled)));
        }
        match result {
            Ok(quotas) => {
                // A window that was there and is not now: asked again once, soon.
                #[cfg(test)]
                let lost = cache
                    .snapshot
                    .as_ref()
                    .and_then(|old| old.quotas.as_ref())
                    .is_some_and(|old| {
                        (old.five_hour.is_some() && quotas.five_hour.is_none())
                            || (old.seven_day.is_some() && quotas.seven_day.is_none())
                    });
                #[cfg(test)]
                {
                    cache.chase = lost && !cache.chase;
                    cache.quick_retry = false;
                }
                let yes_no = |window: &Option<Window>| if window.is_some() { "yes" } else { "no" };
                let note = format!(
                    "read ok, 5h={} 7d={}",
                    yes_no(&quotas.five_hour),
                    yes_no(&quotas.seven_day)
                );
                if cache.last_note != note {
                    crate::log::line(format!("codex quota: {note}"));
                    cache.last_note = note;
                }
                let snapshot = Snapshot {
                    generation,
                    quotas: Some(quotas),
                    updated_at: Some(now_ms()),
                    stale: false,
                    available: true,
                    failure_reason: None,
                };
                cache.snapshot = Some(snapshot.clone());
                cache.fetched_at = Some(now);
                cache.failures = 0;
                self.stamp(snapshot)
            }
            Err(reason) => {
                cache.failures = cache.failures.saturating_add(1);
                #[cfg(test)]
                {
                    cache.quick_retry = false;
                    cache.chase = false;
                }
                let note = format!("read failed, {reason:?}");
                if cache.last_note != note {
                    crate::log::line(format!("codex quota: {note}"));
                    cache.last_note = note;
                }
                cache.fetched_at = Some(now);
                // A failed read invalidates the visible quota. Never present an older
                // snapshot as current (or as a numeric zero).
                let snapshot = Snapshot::unavailable(Some(reason));
                cache.snapshot = Some(snapshot.clone());
                self.stamp(snapshot)
            }
        }
    }
}

/// Run the lifecycle scheduler and publish only normalized quota snapshots.
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let provider = app.state::<Provider>();
            if !provider.is_enabled() {
                let _ = provider.wake.notified().await;
                continue;
            }
            let (decision, requesting_turns) = {
                let mut activity = provider.activity.lock().unwrap();
                let decision = schedule_action(&mut activity, Instant::now());
                let requesting_turns = if matches!(decision, ScheduleAction::Refresh) {
                    activity.requesting_turns()
                } else {
                    HashSet::new()
                };
                if matches!(decision, ScheduleAction::Refresh) {
                    activity.pending = false;
                    activity.final_pending = false;
                    activity.last_read = Some(Instant::now());
                }
                (decision, requesting_turns)
            };
            match decision {
                ScheduleAction::Idle => {
                    let _ = provider.wake.notified().await;
                }
                ScheduleAction::Wait(duration) => {
                    let _ = timeout(duration, provider.wake.notified()).await;
                }
                ScheduleAction::Refresh => {
                    let read_app = app.clone();
                    let read =
                        tokio::spawn(
                            async move { read_app.state::<Provider>().read_for_event().await },
                        );
                    let abort = read.abort_handle();
                    *provider.read_abort.lock().unwrap() = Some(abort.clone());
                    if !provider.is_enabled() {
                        abort.abort();
                    }
                    let Ok(snapshot) = read.await else {
                        *provider.read_abort.lock().unwrap() = None;
                        continue;
                    };
                    *provider.read_abort.lock().unwrap() = None;
                    record_read_result(
                        &mut provider.activity.lock().unwrap(),
                        &snapshot,
                        &requesting_turns,
                    );
                    let _ = app.emit("codex-quota", snapshot);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{duplex, split};

    const NOW: u64 = 1_800_000_000_000;
    const RATE_LIMITS_FIXTURE: &str =
        include_str!("../tests/fixtures/codex_app_server_rate_limits.json");

    fn quota_event(
        state: &mut Activity,
        event: &str,
        session: &str,
        turn: &str,
        agent: Option<&str>,
        at: Instant,
    ) {
        state.event(event, Some(session), Some(turn), agent, at);
    }

    #[test]
    fn event_coordinator_starts_once_coalesces_duplicates_and_respects_three_minute_cadence() {
        let t = Instant::now();
        let mut state = Activity::default();
        quota_event(&mut state, "UserPromptSubmit", "s", "t", None, t);
        assert!(state.pending);
        state.pending = false;
        state.last_read = Some(t);
        quota_event(
            &mut state,
            "UserPromptSubmit",
            "s",
            "t",
            None,
            t + Duration::from_secs(5),
        );
        assert!(
            !state.pending,
            "duplicate hook delivery must not schedule another read"
        );
        assert_eq!(
            schedule_action(&mut state, t + Duration::from_secs(179)),
            ScheduleAction::Idle
        );
        state.pending = true; // A distinct lifecycle event requests a coalesced read.
        assert_eq!(
            schedule_action(&mut state, t + Duration::from_secs(179)),
            ScheduleAction::Wait(Duration::from_secs(1))
        );
        assert_eq!(
            schedule_action(&mut state, t + EVENT_COOLDOWN),
            ScheduleAction::Refresh
        );
    }

    #[test]
    fn final_refresh_coalesces_stops_after_cooldown_and_waits_for_background_agents() {
        let t = Instant::now();
        let mut state = Activity::default();
        quota_event(&mut state, "UserPromptSubmit", "s", "t", None, t);
        state.pending = false;
        state.last_read = Some(t);
        quota_event(
            &mut state,
            "SubagentStart",
            "s",
            "t",
            Some("a"),
            t + Duration::from_secs(5),
        );
        quota_event(
            &mut state,
            "Stop",
            "s",
            "t",
            None,
            t + Duration::from_secs(10),
        );
        assert!(!state.final_pending);
        assert!(state.sessions.contains_key("s"));
        quota_event(
            &mut state,
            "SubagentStop",
            "s",
            "t",
            Some("a"),
            t + Duration::from_secs(20),
        );
        assert!(state.final_pending);
        assert_eq!(
            schedule_action(&mut state, t + Duration::from_secs(179)),
            ScheduleAction::Wait(Duration::from_secs(1))
        );
        assert_eq!(
            schedule_action(&mut state, t + EVENT_COOLDOWN),
            ScheduleAction::Refresh
        );
        state.final_pending = false;
        assert_eq!(
            schedule_action(&mut state, t + EVENT_COOLDOWN),
            ScheduleAction::Idle,
            "one coalesced final read, no launch storm"
        );
    }

    #[test]
    fn interrupt_session_end_multiple_sessions_lost_stop_and_inactivity_lease_are_bounded() {
        let t = Instant::now();
        let mut state = Activity::default();
        quota_event(&mut state, "UserPromptSubmit", "a", "ta", None, t);
        quota_event(&mut state, "UserPromptSubmit", "b", "tb", None, t);
        state.pending = false;
        quota_event(
            &mut state,
            "Interrupt",
            "a",
            "ta",
            None,
            t + Duration::from_secs(1),
        );
        assert!(!state.sessions.contains_key("a"));
        assert!(state.sessions.contains_key("b"));
        state.final_pending = false;
        quota_event(
            &mut state,
            "SessionEnd",
            "b",
            "?",
            None,
            t + Duration::from_secs(2),
        );
        assert!(state.sessions.is_empty());
        assert!(state.final_pending);

        quota_event(&mut state, "UserPromptSubmit", "lost-stop", "tl", None, t);
        state.pending = false;
        state.final_pending = false;
        assert_eq!(
            schedule_action(&mut state, t + INACTIVITY_LEASE),
            ScheduleAction::Refresh
        );
        assert!(state.sessions.is_empty());
        assert!(state.final_pending);
        state.final_pending = false;
        assert_eq!(
            schedule_action(&mut state, t + INACTIVITY_LEASE + Duration::from_secs(1)),
            ScheduleAction::Idle
        );
    }

    #[test]
    fn stale_or_unknown_turn_endings_do_not_close_a_newer_turn_and_idle_never_polls() {
        let t = Instant::now();
        let mut state = Activity::default();
        quota_event(&mut state, "UserPromptSubmit", "s", "old", None, t);
        quota_event(
            &mut state,
            "UserPromptSubmit",
            "s",
            "new",
            None,
            t + Duration::from_secs(1),
        );
        state.pending = false;
        quota_event(
            &mut state,
            "Stop",
            "s",
            "old",
            None,
            t + Duration::from_secs(2),
        );
        assert!(state.sessions.contains_key("s"));
        quota_event(
            &mut state,
            "Stop",
            "s",
            "new",
            None,
            t + Duration::from_secs(3),
        );
        assert!(state.sessions.is_empty());
        quota_event(
            &mut state,
            "UserPromptSubmit",
            "s",
            "old",
            None,
            t + Duration::from_secs(4),
        );
        assert!(
            state.sessions.is_empty(),
            "a delayed prompt for a closed turn is ignored"
        );
        state.final_pending = false;
        state.last_read = Some(t);
        assert_eq!(
            schedule_action(&mut state, t + Duration::from_secs(3600)),
            ScheduleAction::Idle
        );
    }

    #[test]
    fn delayed_subagent_stop_from_old_turn_does_not_touch_new_turn_state() {
        let t = Instant::now();
        let mut state = Activity::default();
        quota_event(&mut state, "UserPromptSubmit", "s", "t1", None, t);
        quota_event(
            &mut state,
            "SubagentStart",
            "s",
            "t1",
            Some("agent-old"),
            t + Duration::from_secs(1),
        );
        quota_event(
            &mut state,
            "UserPromptSubmit",
            "s",
            "t2",
            None,
            t + Duration::from_secs(2),
        );
        quota_event(
            &mut state,
            "SubagentStart",
            "s",
            "t2",
            Some("agent-new"),
            t + Duration::from_secs(3),
        );
        let last_event = state.sessions["s"].last_event;
        quota_event(
            &mut state,
            "SubagentStop",
            "s",
            "t1",
            Some("agent-new"),
            t + Duration::from_secs(4),
        );
        let current = &state.sessions["s"];
        assert_eq!(current.turn, "t2");
        assert_eq!(current.last_event, last_event);
        assert!(current.background.contains("agent-new"));
    }

    #[test]
    fn stop_or_interrupt_without_turn_id_does_not_close_a_known_newer_turn() {
        let t = Instant::now();
        for event in ["Stop", "Interrupt"] {
            let mut state = Activity::default();
            quota_event(&mut state, "UserPromptSubmit", "s", "t1", None, t);
            quota_event(
                &mut state,
                "UserPromptSubmit",
                "s",
                "t2",
                None,
                t + Duration::from_secs(1),
            );
            state.final_pending = false;
            state.event(event, Some("s"), None, None, t + Duration::from_secs(2));
            assert_eq!(
                state.sessions["s"].turn, "t2",
                "{event} leaves the known current turn active"
            );
            assert!(
                state.final_pending,
                "ambiguous terminal event requests a coalesced final read"
            );
        }
    }

    #[test]
    fn failed_turn_is_not_retried_until_a_new_turn_and_anonymous_ids_are_bounded() {
        let t = Instant::now();
        let mut state = Activity::default();
        quota_event(&mut state, "UserPromptSubmit", "s", "t", None, t);
        state.pending = false;
        state.last_read = Some(t);
        state.failed_turns.insert(("s".into(), "t".into()));
        assert_eq!(
            schedule_action(&mut state, t + Duration::from_secs(3600)),
            ScheduleAction::Idle
        );
        quota_event(
            &mut state,
            "UserPromptSubmit",
            "s",
            "next",
            None,
            t + Duration::from_secs(3601),
        );
        assert!(state.pending);
        state.event(
            "UserPromptSubmit",
            None,
            None,
            None,
            t + Duration::from_secs(3602),
        );
        assert!(state.sessions.contains_key("@unknown-session"));
    }

    #[test]
    fn expired_turn_tombstone_restores_late_work_and_its_stop_requests_final_read() {
        let t = Instant::now();
        let mut state = Activity::default();
        quota_event(&mut state, "UserPromptSubmit", "s", "t1", None, t);
        state.pending = false;
        state.last_read = Some(t);
        quota_event(
            &mut state,
            "PermissionRequest",
            "s",
            "t1",
            None,
            t + Duration::from_secs(1),
        );

        let expired_at = t + Duration::from_secs(1) + INACTIVITY_LEASE;
        assert_eq!(
            schedule_action(&mut state, expired_at),
            ScheduleAction::Refresh
        );
        state.final_pending = false; // the lease-triggered final read completed
        state.last_read = Some(expired_at);
        assert_eq!(state.expired_turns.len(), 1);

        quota_event(
            &mut state,
            "PostToolUse",
            "s",
            "t1",
            None,
            expired_at + Duration::from_secs(10),
        );
        assert_eq!(
            state.sessions.get("s").map(|turn| turn.turn.as_str()),
            Some("t1")
        );
        quota_event(
            &mut state,
            "Stop",
            "s",
            "t1",
            None,
            expired_at + Duration::from_secs(11),
        );
        assert!(!state.sessions.contains_key("s"));
        assert!(state.final_pending, "late Stop schedules a final refresh");
        assert_eq!(
            schedule_action(&mut state, expired_at + Duration::from_secs(11)),
            ScheduleAction::Wait(EVENT_COOLDOWN - Duration::from_secs(11))
        );
    }

    #[test]
    fn late_old_turn_stop_does_not_close_newer_turn_but_keeps_final_refresh() {
        let t = Instant::now();
        let mut state = Activity::default();
        quota_event(&mut state, "UserPromptSubmit", "s", "t1", None, t);
        state.pending = false;
        state.last_read = Some(t);
        let expired_at = t + INACTIVITY_LEASE;
        assert_eq!(
            schedule_action(&mut state, expired_at),
            ScheduleAction::Refresh
        );
        state.final_pending = false;
        state.last_read = Some(expired_at);
        quota_event(
            &mut state,
            "UserPromptSubmit",
            "s",
            "t2",
            None,
            expired_at + Duration::from_secs(1),
        );
        state.pending = false;
        quota_event(
            &mut state,
            "Stop",
            "s",
            "t1",
            None,
            expired_at + Duration::from_secs(2),
        );
        assert_eq!(
            state.sessions.get("s").map(|turn| turn.turn.as_str()),
            Some("t2")
        );
        assert!(state.final_pending);
    }

    #[test]
    fn cached_success_then_unauthorized_suppresses_same_turn_until_new_prompt() {
        runtime().block_on(async {
            let t = Instant::now();
            let provider = Provider::default();
            provider.set_enabled(true);
            let mut activity = Activity::default();
            quota_event(&mut activity, "UserPromptSubmit", "s", "t1", None, t);
            activity.pending = false;
            activity.last_read = Some(t);

            let success = provider
                .read_with_at(t, async { Ok(fresh_quotas(18.0)) })
                .await;
            assert!(success.available);
            let requesting_turns = activity.requesting_turns();
            let failed = provider
                .read_with_at_policy(
                    t + EVENT_COOLDOWN,
                    async { Err(FailureReason::Unauthorized) },
                    true,
                )
                .await;
            assert!(!failed.available, "a failed read hides the old quota");
            assert!(!failed.stale);
            assert!(failed.quotas.is_none());
            assert_eq!(failed.failure_reason, Some(FailureReason::Unauthorized));
            activity.last_read = Some(t + EVENT_COOLDOWN);
            record_read_result(&mut activity, &failed, &requesting_turns);
            assert!(activity.failed_turns.contains(&("s".into(), "t1".into())));
            assert_eq!(
                schedule_action(&mut activity, t + EVENT_COOLDOWN + Duration::from_secs(1)),
                ScheduleAction::Idle,
                "an unsuccessful read does not schedule a retry"
            );

            quota_event(
                &mut activity,
                "Stop",
                "s",
                "t1",
                None,
                t + EVENT_COOLDOWN + Duration::from_secs(2),
            );
            assert!(
                !activity.final_pending,
                "failed turn does not trigger an automatic final retry"
            );
            assert_eq!(
                schedule_action(&mut activity, t + EVENT_COOLDOWN + Duration::from_secs(2)),
                ScheduleAction::Idle
            );
            quota_event(
                &mut activity,
                "UserPromptSubmit",
                "s",
                "t2",
                None,
                t + EVENT_COOLDOWN + Duration::from_secs(3),
            );
            assert!(
                activity.pending,
                "a new turn clears suppression for its own check"
            );
            assert_eq!(
                schedule_action(&mut activity, t + 2 * EVENT_COOLDOWN),
                ScheduleAction::Refresh
            );
        });
    }

    #[test]
    fn scheduler_decision_handles_pending_events_during_fetch_and_failed_turn_lease_without_short_wakes(
    ) {
        let t = Instant::now();
        let mut activity = Activity::default();
        assert_eq!(schedule_action(&mut activity, t), ScheduleAction::Idle);
        quota_event(&mut activity, "UserPromptSubmit", "a", "ta", None, t);
        assert_eq!(schedule_action(&mut activity, t), ScheduleAction::Refresh);
        activity.pending = false; // scheduler has started the single in-flight read
        activity.last_read = Some(t);
        quota_event(
            &mut activity,
            "UserPromptSubmit",
            "b",
            "tb",
            None,
            t + Duration::from_secs(1),
        );
        assert_eq!(
            schedule_action(&mut activity, t + Duration::from_secs(2)),
            ScheduleAction::Wait(EVENT_COOLDOWN - Duration::from_secs(2))
        );
        // Completion of the first fetch leaves the second turn pending; it coalesces at cooldown.
        assert_eq!(
            schedule_action(&mut activity, t + EVENT_COOLDOWN),
            ScheduleAction::Refresh
        );
        activity.pending = false;
        activity.last_read = Some(t + EVENT_COOLDOWN);
        let requesting_turns = activity.requesting_turns();
        quota_event(
            &mut activity,
            "Stop",
            "a",
            "ta",
            None,
            t + EVENT_COOLDOWN + Duration::from_secs(1),
        );
        assert!(activity.final_pending);
        record_read_result(
            &mut activity,
            &Snapshot::unavailable(Some(FailureReason::Timeout)),
            &requesting_turns,
        );
        assert!(
            activity.final_pending,
            "a failure must not erase another session's pending final refresh"
        );
        assert_eq!(
            schedule_action(&mut activity, t + 2 * EVENT_COOLDOWN),
            ScheduleAction::Refresh
        );
        let provider = Provider::default();
        provider.set_enabled(true);
        provider.note_event("UserPromptSubmit", Some("s"), Some("turn"), None);
        provider.set_enabled(false);
        assert_eq!(
            schedule_action(&mut provider.activity.lock().unwrap(), t),
            ScheduleAction::Idle
        );
    }

    #[test]
    fn failure_does_not_suppress_a_parallel_session_that_started_during_fetch() {
        let t = Instant::now();
        let mut activity = Activity::default();
        quota_event(&mut activity, "UserPromptSubmit", "a", "ta", None, t);
        activity.pending = false;
        activity.last_read = Some(t);
        let requesting_turns = activity.requesting_turns(); // captured when the read starts

        quota_event(
            &mut activity,
            "UserPromptSubmit",
            "b",
            "tb",
            None,
            t + Duration::from_secs(1),
        );
        let failed = Snapshot::unavailable(Some(FailureReason::Unauthorized));
        record_read_result(&mut activity, &failed, &requesting_turns);

        assert!(activity.failed_turns.contains(&("a".into(), "ta".into())));
        assert!(!activity.failed_turns.contains(&("b".into(), "tb".into())));
        assert!(
            activity.pending,
            "the newer session retains its pending check"
        );
        assert_eq!(
            schedule_action(&mut activity, t + EVENT_COOLDOWN),
            ScheduleAction::Refresh
        );
    }

    #[test]
    fn scheduler_waits_for_failed_turn_lease_deadline_instead_of_waking_every_quarter_second() {
        let t = Instant::now();
        let mut activity = Activity::default();
        quota_event(&mut activity, "UserPromptSubmit", "s", "t", None, t);
        activity.pending = false;
        activity.last_read = Some(t);
        activity.failed_turns.insert(("s".into(), "t".into()));
        assert_eq!(
            schedule_action(&mut activity, t + EVENT_COOLDOWN),
            ScheduleAction::Idle,
        );
    }

    #[test]
    fn opt_out_aborts_the_in_flight_fetch_and_removes_scheduler_activity() {
        runtime().block_on(async {
            let provider = Provider::default();
            provider.set_enabled(true);
            provider.note_event("UserPromptSubmit", Some("s"), Some("t"), None);
            let task = tokio::spawn(std::future::pending::<()>());
            *provider.read_abort.lock().unwrap() = Some(task.abort_handle());
            provider.set_enabled(false);
            assert!(
                task.await.is_err(),
                "disable aborts the outstanding fetch task"
            );
            assert_eq!(
                schedule_action(&mut provider.activity.lock().unwrap(), Instant::now()),
                ScheduleAction::Idle
            );
        });
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    fn quota_result() -> Value {
        serde_json::from_str::<Value>(RATE_LIMITS_FIXTURE).unwrap()["result"].clone()
    }

    async fn mock_exchange(
        before: Vec<Value>,
        after: Vec<Value>,
        now: u64,
    ) -> Result<Quotas, FailureReason> {
        let (client, server) = duplex(32 * 1024);
        let (client_read, mut client_write) = split(client);
        let (server_read, mut server_write) = split(server);
        let mut client_lines = BufReader::new(client_read).lines();
        let expects_server_request = before.iter().any(is_server_request);
        let server_task = tokio::spawn(async move {
            let mut server_lines = BufReader::new(server_read).lines();
            let initialize: Value =
                serde_json::from_str(&server_lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(initialize["id"], 1);
            assert_eq!(initialize["method"], "initialize");
            assert!(initialize.get("jsonrpc").is_none());
            for message in before {
                server_write
                    .write_all(message.to_string().as_bytes())
                    .await
                    .unwrap();
                server_write.write_all(b"\n").await.unwrap();
            }
            let mut saw_init = false;
            let mut saw_server_request_response = false;
            let quota_request = loop {
                let line = server_lines.next_line().await.unwrap().unwrap();
                let message: Value = serde_json::from_str(&line).unwrap();
                assert!(message.get("jsonrpc").is_none());
                if message.get("method").and_then(Value::as_str) == Some("initialized") {
                    saw_init = true;
                }
                if message.get("id").and_then(Value::as_str) == Some("push1") {
                    assert_eq!(message["error"]["code"], -32601);
                    assert_eq!(message["error"]["message"], "Unsupported request");
                    saw_server_request_response = true;
                }
                if message.get("method").and_then(Value::as_str) == Some("account/rateLimits/read")
                {
                    break message;
                }
            };
            assert!(saw_init && saw_server_request_response == expects_server_request);
            assert_eq!(quota_request["id"], 2);
            assert_eq!(quota_request["params"], json!({}));
            for message in after {
                server_write
                    .write_all(message.to_string().as_bytes())
                    .await
                    .unwrap();
                server_write.write_all(b"\n").await.unwrap();
            }
        });
        let result = request_quotas(&mut client_lines, &mut client_write, now).await;
        server_task.await.unwrap();
        result
    }

    fn response(id: u64, result: Value) -> Value {
        json!({"id":id,"result":result})
    }

    #[test]
    fn parses_windows_by_duration_including_limit_map() {
        let quotas = parse_rate_limits(&quota_result(), NOW).unwrap();
        assert_eq!(quotas.five_hour.unwrap().used_percent, 23.0);
        assert_eq!(quotas.seven_day.unwrap().used_percent, 71.0);
        let expiry = parse_rate_limits(&quota_result(), 1_800_018_000_000).unwrap();
        assert_eq!(expiry.five_hour, None);
        assert_eq!(expiry.seven_day.unwrap().resets_at, 1_800_600_000_000);
        assert_eq!(parse_rate_limits(&quota_result(), 1_800_600_000_000), None);
    }

    #[test]
    fn zero_usage_is_a_valid_five_hour_value_and_missing_window_stays_missing() {
        let response = json!({"rateLimits":{"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":1800018000},"secondary":{"usedPercent":8,"windowDurationMins":10080,"resetsAt":1800600000}}});
        let quotas = parse_rate_limits(&response, NOW).unwrap();
        assert_eq!(quotas.five_hour.unwrap().used_percent, 0.0);
        assert_eq!(quotas.seven_day.unwrap().used_percent, 8.0);

        let missing = json!({"rateLimits":{"primary":{"usedPercent":null,"windowDurationMins":300,"resetsAt":1800018000},"secondary":{"usedPercent":8,"windowDurationMins":10080,"resetsAt":1800600000}}});
        let quotas = parse_rate_limits(&missing, NOW).unwrap();
        assert_eq!(quotas.five_hour, None);
        assert_eq!(quotas.seven_day.unwrap().used_percent, 8.0);
    }

    #[test]
    fn rejects_malformed_out_of_range_and_implausible_windows() {
        let payload = json!({"rateLimits":{"primary":{"usedPercent":101,"windowDurationMins":300,"resetsAt":1800018000}}});
        assert_eq!(parse_rate_limits(&payload, NOW), None);
        assert_eq!(parse_rate_limits(&json!({"rateLimits":null}), NOW), None);
        assert_eq!(
            parse_rate_limits(
                &json!({"rateLimits":{"primary":null,"secondary":{},"rateLimitsByLimitId":null}}),
                NOW
            ),
            None
        );
        assert_eq!(
            parse_rate_limits(
                &json!({"rateLimits":{"primary":{"usedPercent":"23","windowDurationMins":300,"resetsAt":1800018000}}}),
                NOW
            ),
            None
        );
        assert_eq!(
            parse_rate_limits(
                &json!({"rateLimits":{"primary":{"usedPercent":23,"windowDurationMins":null,"resetsAt":1800018000}}}),
                NOW
            ),
            None
        );
        assert_eq!(
            parse_rate_limits(
                &json!({"rateLimits":{"primary":{"usedPercent":23,"windowDurationMins":300,"resetsAt":null}}}),
                NOW
            ),
            None
        );
        assert_eq!(
            parse_rate_limits(&json!({"error":{"code":-1,"message":"unsupported"}}), NOW),
            None
        );
        let payload = json!({"rateLimits":{"primary":{"usedPercent":20,"windowDurationMins":300,"resetsAt":0}}});
        assert_eq!(parse_rate_limits(&payload, NOW), None);
    }

    #[test]
    fn desktop_discovery_trusts_only_hash_version_exes_and_keeps_priorities() {
        let base =
            std::env::temp_dir().join(format!("nook-codex-discovery-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("OpenAI").join("Codex").join("bin");
        let old = root.join("a1b2c3d4");
        let newest = root.join("b1c2d3e4");
        let odd = root.join("current");
        let path_candidate = root.join("path-priority");
        let outside = base.join("untrusted");
        for dir in [&old, &newest, &odd, &path_candidate, &outside] {
            fs::create_dir_all(dir).unwrap();
        }
        for dir in [&old, &newest, &odd, &path_candidate, &outside] {
            fs::write(dir.join("codex.exe"), b"mock only").unwrap();
        }
        fs::write(newest.join("codex.cmd"), b"must never launch").unwrap();
        let path = std::env::join_paths([&path_candidate, &outside]).unwrap();
        let found = trusted_candidates(&base, Some(&path));
        assert_eq!(found.len(), 3);
        assert_eq!(
            found.last().unwrap(),
            &path_candidate.join("codex.exe").canonicalize().unwrap()
        );
        let trusted_root = root.canonicalize().unwrap();
        assert!(found
            .iter()
            .all(|candidate| candidate.starts_with(&trusted_root)));
        assert!(!found
            .iter()
            .any(|candidate| candidate.starts_with(&outside)));
        assert!(found.iter().all(|candidate| candidate
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))));
        assert!(version_tuple("codex 0.165.0-alpha.1.2").unwrap() >= (0, 165, 0));
        assert!(version_tuple("codex 0.164.9").unwrap() < (0, 165, 0));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn quota_provider_is_disabled_by_default_and_expired_snapshots_are_unavailable() {
        runtime().block_on(async {
            let provider = Provider::default();
            assert!(!provider.is_enabled());
            assert_eq!(
                provider.read().await,
                Snapshot::unavailable(Some(FailureReason::Disabled))
            );
            let calls = std::sync::Arc::new(AtomicUsize::new(0));
            let attempts = calls.clone();
            let disabled = provider
                .read_with_at(Instant::now(), async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Err(FailureReason::ProtocolError)
                })
                .await;
            assert_eq!(disabled.failure_reason, Some(FailureReason::Disabled));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        });
        let mut snapshot = Snapshot {
            generation: 0,
            quotas: Some(parse_rate_limits(&quota_result(), NOW).unwrap()),
            updated_at: Some(NOW - SNAPSHOT_TTL.as_millis() as u64 - 1),
            stale: true,
            available: true,
            failure_reason: Some(FailureReason::Timeout),
        };
        let expired = visible_snapshot(&snapshot, NOW);
        assert_eq!(expired.quotas, None);
        assert!(!expired.available);
        assert!(expired.stale);
        snapshot.updated_at = Some(NOW);
        let after_reset = visible_snapshot(&snapshot, 1_800_600_000_000);
        assert_eq!(after_reset.quotas, None);
        assert!(!after_reset.available);
    }

    #[test]
    fn a_cached_snapshot_older_than_the_refresh_interval_is_marked_stale() {
        let snapshot = Snapshot {
            generation: 0,
            quotas: Some(parse_rate_limits(&quota_result(), NOW).unwrap()),
            updated_at: Some(NOW - MIN_REFRESH.as_millis() as u64 - 1),
            stale: false,
            available: true,
            failure_reason: None,
        };
        let visible = visible_snapshot(&snapshot, NOW);
        assert!(visible.available);
        assert!(visible.stale);
        assert!(visible.quotas.is_some());
    }

    #[test]
    fn opt_in_epochs_advance_and_are_stamped_on_empty_and_quota_snapshots() {
        let provider = Provider::default();
        assert_eq!(provider.last_snapshot().generation, 0);
        provider.set_enabled(true);
        let enabled = provider.last_snapshot();
        assert_eq!(enabled.generation, 1);
        assert_eq!(enabled.failure_reason, None);
        provider.set_enabled(false);
        assert_eq!(provider.last_snapshot().generation, 2);
        provider.set_enabled(true);
        assert_eq!(provider.last_snapshot().generation, 3);
    }

    #[test]
    fn last_snapshot_is_cache_only_and_never_fetches() {
        runtime().block_on(async {
            let provider = Provider::default();
            assert_eq!(
                provider.last_snapshot().failure_reason,
                Some(FailureReason::Disabled)
            );
            provider.set_enabled(true);
            let waiting = provider.last_snapshot();
            assert!(!waiting.available);
            assert_eq!(waiting.failure_reason, None);

            let quotas = parse_rate_limits(&quota_result(), NOW).unwrap();
            provider
                .read_with_at(Instant::now(), async { Ok(quotas) })
                .await;
            let cached = provider.last_snapshot();
            assert!(cached.available);
            assert_eq!(cached.quotas.unwrap().five_hour.unwrap().used_percent, 23.0);
        });
    }

    // ── Lifecycle: resets, failures, and what is missing versus what is zero ──────────────────────

    /// A snapshot as the provider holds it, with windows set relative to the real clock
    /// (`read_with_at` judges expiry by it).
    fn held(five_in_ms: Option<i64>, seven_in_ms: Option<i64>, five_used: f64) -> Snapshot {
        let at = |delta: i64| (now_ms() as i64 + delta) as u64;
        Snapshot {
            generation: 0,
            quotas: Some(Quotas {
                five_hour: five_in_ms.map(|d| Window {
                    used_percent: five_used,
                    window_duration_mins: 300,
                    resets_at: at(d),
                }),
                seven_day: seven_in_ms.map(|d| Window {
                    used_percent: 13.0,
                    window_duration_mins: 10_080,
                    resets_at: at(d),
                }),
            }),
            updated_at: Some(now_ms()),
            stale: false,
            available: true,
            failure_reason: None,
        }
    }

    fn provider_holding(snapshot: Snapshot, fetched_ago: Duration) -> Provider {
        let provider = Provider::default();
        provider.set_enabled(true);
        {
            let mut cache = provider.cache.lock().unwrap();
            cache.snapshot = Some(snapshot);
            cache.fetched_at = Instant::now().checked_sub(fetched_ago);
        }
        provider
    }

    fn fresh_quotas(five_used: f64) -> Quotas {
        let at = |delta: i64| (now_ms() as i64 + delta) as u64;
        Quotas {
            five_hour: Some(Window {
                used_percent: five_used,
                window_duration_mins: 300,
                resets_at: at(5 * 3_600_000),
            }),
            seven_day: Some(Window {
                used_percent: 13.0,
                window_duration_mins: 10_080,
                resets_at: at(4 * 86_400_000),
            }),
        }
    }

    #[test]
    fn the_refresh_loop_wakes_just_after_a_reset_instead_of_sleeping_the_full_interval() {
        let now = now_ms();
        let spacing = backoff(0);
        let long_ago = Some(Duration::from_secs(3_600));
        let near = |snap: &Snapshot| reset_wait(Some(snap), now, long_ago, spacing);
        // A five-hour reset three minutes away: read three minutes and a grace after, not ten minutes from now.
        let soon = held(Some(3 * 60_000), Some(4 * 86_400_000), 0.0);
        assert_eq!(near(&soon), Duration::from_secs(3 * 60) + RESET_GRACE);
        // Either window counts, the nearer one wins.
        let seven_first = held(Some(3 * 3_600_000), Some(90_000), 0.0);
        assert_eq!(near(&seven_first), Duration::from_secs(90) + RESET_GRACE);
        // Resets far away: the usual interval — no polling is added.
        assert_eq!(
            near(&held(Some(3 * 3_600_000), Some(4 * 86_400_000), 0.0)),
            MIN_REFRESH
        );
        // Nothing to wait for: no windows, or no snapshot.
        assert_eq!(near(&held(None, None, 0.0)), MIN_REFRESH);
        assert_eq!(reset_wait(None, now, None, spacing), MIN_REFRESH);
    }

    /// The reset-aware wait, from the moment a read has just been made (`since_read` = 0) and a window
    /// resets `reset_in` later: when may the next read be made?
    fn wait_for_reset_in(reset_in: Duration, since_read: Duration) -> Duration {
        let now = now_ms();
        let snapshot = held(Some(reset_in.as_millis() as i64), Some(4 * 86_400_000), 0.0);
        reset_wait(Some(&snapshot), now, Some(since_read), backoff(0))
    }

    #[test]
    fn a_reset_soon_after_a_read_waits_for_the_spacing_not_for_ten_minutes() {
        let spacing = Duration::from_secs(60);
        // Reset 10 s after the read: reset + 5 s is only 15 s, but the spacing allows a read at 60 s — not before, not 10 min later.
        assert_eq!(
            wait_for_reset_in(Duration::from_secs(10), Duration::ZERO),
            spacing
        );
        // Reset 55 s after the read: reset + grace is exactly the spacing.
        assert_eq!(
            wait_for_reset_in(Duration::from_secs(55), Duration::ZERO),
            spacing
        );
        // Reset 56 s after: the reset is the later of the two.
        assert_eq!(
            wait_for_reset_in(Duration::from_secs(56), Duration::ZERO),
            Duration::from_secs(61)
        );
        // More than a minute after the read: spacing is long over, only the reset counts.
        assert_eq!(
            wait_for_reset_in(Duration::from_secs(120), Duration::ZERO),
            Duration::from_secs(125)
        );
        // The sleep counts from now, and the read was made 20 s ago: 40 s of the spacing are left.
        assert_eq!(
            wait_for_reset_in(Duration::from_secs(10), Duration::from_secs(20)),
            Duration::from_secs(40)
        );
        // Never the usual interval for a reset this close.
        for secs in [1, 10, 30, 55, 56, 90, 300] {
            assert!(
                wait_for_reset_in(Duration::from_secs(secs), Duration::ZERO) < MIN_REFRESH,
                "{secs}s"
            );
        }
    }

    #[test]
    fn a_reset_that_has_passed_while_the_spacing_still_holds_is_read_the_moment_it_ends() {
        let now = now_ms();
        let spacing = backoff(0);
        let over = held(Some(-2_000), Some(4 * 86_400_000), 40.0);
        let wait =
            |since: u64| reset_wait(Some(&over), now, Some(Duration::from_secs(since)), spacing);
        // The read that found the reset gated was 20 s ago: 40 s more, not ten minutes.
        assert_eq!(wait(20), Duration::from_secs(40));
        assert_eq!(wait(59), Duration::from_secs(1));
        // The read was this very instant: the full spacing.
        assert_eq!(wait(0), spacing);
        // Spacing already over: as soon as it can be — a second, never zero (no busy loop).
        assert_eq!(wait(60), MIN_WAKE);
        assert_eq!(wait(61), MIN_WAKE);
        // With failures the spacing is the backoff, and it is the one respected.
        assert_eq!(
            reset_wait(Some(&over), now, Some(Duration::from_secs(60)), backoff(2)),
            Duration::from_secs(180)
        );
        // No snapshot to speak of: the usual interval.
        assert_eq!(
            reset_wait(
                Some(&held(None, None, 0.0)),
                now,
                Some(Duration::ZERO),
                spacing
            ),
            MIN_REFRESH
        );
    }

    #[test]
    fn a_wake_after_sleep_or_a_late_timer_reads_at_once() {
        let now = now_ms();
        // The machine slept through the reset: hours past it, hours since the last read.
        let slept = held(Some(-3 * 3_600_000), Some(-60_000), 40.0);
        let wait = reset_wait(
            Some(&slept),
            now,
            Some(Duration::from_secs(3 * 3_600)),
            backoff(0),
        );
        assert_eq!(
            wait, MIN_WAKE,
            "read as soon as the loop runs, with a one-second floor"
        );
        // Never a zero wait, whatever the inputs: the loop cannot spin.
        for since in [None, Some(Duration::ZERO), Some(Duration::from_secs(3_600))] {
            assert!(reset_wait(Some(&slept), now, since, backoff(0)) >= MIN_WAKE);
        }
    }

    #[test]
    fn the_spacing_gated_reset_read_is_retried_at_the_earliest_time_and_brings_the_zero() {
        runtime().block_on(async {
            // The five-hour window reset, but the last read was only 20 s ago.
            let provider = provider_holding(
                held(Some(-2_000), Some(4 * 86_400_000), 40.0),
                Duration::from_secs(20),
            );
            let calls = std::sync::Arc::new(AtomicUsize::new(0));
            let counted = |calls: &std::sync::Arc<AtomicUsize>| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(fresh_quotas(0.0))
                }
            };
            // The read at reset + 5 s is refused by the spacing gate: the cached snapshot comes back, no request.
            let gated = provider.read_with_at(Instant::now(), counted(&calls)).await;
            assert_eq!(calls.load(Ordering::SeqCst), 0, "spacing-gated");
            assert!(
                gated.quotas.unwrap().five_hour.is_none(),
                "the over window is not shown"
            );
            // The scheduler does not fall back to ten minutes: about 40 s of the spacing are left.
            let wait = provider.next_wait();
            assert!(
                wait > Duration::from_secs(38) && wait <= Duration::from_secs(40),
                "{wait:?}"
            );
            // At that time the read is made — and it is the new window: a real 0%.
            let after = provider
                .read_with_at(Instant::now() + wait, counted(&calls))
                .await;
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let five = after.quotas.unwrap().five_hour.unwrap();
            assert_eq!(five.used_percent, 0.0);
            assert!(after.available && !after.stale);
            // And it is over: the loop is back on the usual interval, not hammering.
            assert_eq!(provider.next_wait(), MIN_REFRESH);
        });
    }

    #[test]
    fn a_failed_read_is_unavailable_and_requires_another_lifecycle_event() {
        runtime().block_on(async {
            let t = Instant::now();
            let provider = Provider::default();
            provider.set_enabled(true);
            provider.note_event("UserPromptSubmit", Some("s"), Some("t"), None);
            {
                let mut activity = provider.activity.lock().unwrap();
                activity.pending = false;
                activity.last_read = Some(t);
            }
            let requesting = provider.activity.lock().unwrap().requesting_turns();
            let failed = provider
                .read_with_at_policy(t, async { Err(FailureReason::Timeout) }, true)
                .await;
            record_read_result(&mut provider.activity.lock().unwrap(), &failed, &requesting);
            assert!(!failed.available && !failed.stale && failed.quotas.is_none());
            assert_eq!(
                schedule_action(
                    &mut provider.activity.lock().unwrap(),
                    t + EVENT_COOLDOWN + Duration::from_secs(1)
                ),
                ScheduleAction::Idle
            );

            provider.note_event("PostToolUse", Some("s"), Some("t"), None);
            assert_eq!(
                schedule_action(
                    &mut provider.activity.lock().unwrap(),
                    t + EVENT_COOLDOWN + Duration::from_secs(1)
                ),
                ScheduleAction::Refresh,
                "a distinct lifecycle event may request a new read after cooldown"
            );
        });
    }
    #[test]
    fn a_window_that_has_reset_is_read_again_before_the_usual_interval() {
        runtime().block_on(async {
            let calls = std::sync::Arc::new(AtomicUsize::new(0));
            // The five-hour window reset a minute ago; the last read was two minutes ago.
            let provider = provider_holding(
                held(Some(-60_000), Some(4 * 86_400_000), 40.0),
                Duration::from_secs(120),
            );
            let seen = calls.clone();
            let snapshot = provider
                .read_with_at(Instant::now(), async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    Ok(fresh_quotas(0.0))
                })
                .await;
            assert_eq!(
                calls.load(Ordering::SeqCst),
                1,
                "read, though the ten minutes are not up"
            );
            let five = snapshot.quotas.unwrap().five_hour.unwrap();
            assert_eq!(five.used_percent, 0.0, "a real zero, from the server");
            assert!(snapshot.available && !snapshot.stale);
        });
    }

    #[test]
    fn without_a_reset_the_usual_interval_still_holds_and_the_backoff_floor_holds_after_one() {
        runtime().block_on(async {
            let calls = std::sync::Arc::new(AtomicUsize::new(0));
            let counted = |calls: &std::sync::Arc<AtomicUsize>| {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(fresh_quotas(0.0))
                }
            };
            // Nothing has reset, last read two minutes ago: cached, no request.
            let live = provider_holding(
                held(Some(3_600_000), Some(4 * 86_400_000), 40.0),
                Duration::from_secs(120),
            );
            let cached = live.read_with_at(Instant::now(), counted(&calls)).await;
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(cached.quotas.unwrap().five_hour.unwrap().used_percent, 40.0);
            // A reset, but the last read was ten seconds ago: the minute's floor still keeps requests apart.
            let just_read = provider_holding(
                held(Some(-1_000), Some(4 * 86_400_000), 40.0),
                Duration::from_secs(10),
            );
            just_read
                .read_with_at(Instant::now(), counted(&calls))
                .await;
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn failed_reads_do_not_set_an_automatic_retry_timer() {
        runtime().block_on(async {
            let provider = Provider::default();
            provider.set_enabled(true);
            let failed = provider
                .read_with_at(Instant::now(), async { Err(FailureReason::Timeout) })
                .await;
            assert_eq!(failed.failure_reason, Some(FailureReason::Timeout));
            assert!(!failed.available && !failed.stale && failed.quotas.is_none());
            assert!(!provider.cache.lock().unwrap().quick_retry);
        });
    }

    #[test]
    fn a_failure_that_needs_the_user_keeps_the_usual_interval() {
        runtime().block_on(async {
            for reason in [FailureReason::CliUnavailable, FailureReason::Unauthorized] {
                let provider = Provider::default();
                provider.set_enabled(true);
                provider
                    .read_with_at(Instant::now(), async move { Err(reason) })
                    .await;
                assert_eq!(
                    provider.next_wait(),
                    MIN_REFRESH,
                    "{reason:?}: the usual interval, not the backoff"
                );
                let calls = std::sync::Arc::new(AtomicUsize::new(0));
                let seen = calls.clone();
                provider
                    .read_with_at(Instant::now() + Duration::from_secs(121), async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        Ok(fresh_quotas(0.0))
                    })
                    .await;
                assert_eq!(calls.load(Ordering::SeqCst), 0, "{reason:?}: not hammered");
            }
        });
    }

    #[test]
    fn a_transient_failure_keeps_the_last_values_and_does_not_clear_a_valid_zero() {
        runtime().block_on(async {
            let provider = provider_holding(
                held(Some(3_600_000), Some(4 * 86_400_000), 0.0),
                Duration::from_secs(11 * 60),
            );
            let failed = provider
                .read_with_at(Instant::now(), async { Err(FailureReason::ServerExited) })
                .await;
            assert!(!failed.available && !failed.stale);
            assert_eq!(failed.failure_reason, Some(FailureReason::ServerExited));
            assert!(
                failed.quotas.is_none(),
                "a failed read clears previously known values"
            );
        });
    }

    #[test]
    fn a_window_missing_after_its_reset_is_asked_for_once_more_soon_and_no_more() {
        runtime().block_on(async {
            // The five-hour window reset; the answer, a few seconds later, still has only the weekly one.
            let provider = provider_holding(
                held(Some(-5_000), Some(4 * 86_400_000), 40.0),
                Duration::from_secs(120),
            );
            let only_weekly = || async {
                let mut quotas = fresh_quotas(0.0);
                quotas.five_hour = None;
                Ok(quotas)
            };
            let first = provider.read_with_at(Instant::now(), only_weekly()).await;
            assert!(first.quotas.as_ref().unwrap().five_hour.is_none());
            assert!(
                first.quotas.as_ref().unwrap().seven_day.is_some(),
                "the weekly window is independent of it"
            );
            assert_eq!(
                provider.next_wait(),
                Duration::from_secs(60),
                "one follow-up soon"
            );
            // The follow-up gets the rolled-over window.
            let second = provider
                .read_with_at(Instant::now() + Duration::from_secs(61), async {
                    Ok(fresh_quotas(0.0))
                })
                .await;
            assert_eq!(second.quotas.unwrap().five_hour.unwrap().used_percent, 0.0);
            assert_eq!(provider.next_wait(), MIN_REFRESH);
            // If it is still missing, the follow-up is the last: no loop.
            let stuck = provider_holding(held(Some(-5_000), None, 40.0), Duration::from_secs(120));
            stuck.read_with_at(Instant::now(), only_weekly()).await;
            assert_eq!(stuck.next_wait(), Duration::from_secs(60));
            stuck
                .read_with_at(Instant::now() + Duration::from_secs(61), only_weekly())
                .await;
            assert_eq!(
                stuck.next_wait(),
                MIN_REFRESH,
                "after the one follow-up it settles"
            );
        });
    }

    #[test]
    fn windows_reset_independently_and_a_valid_zero_is_not_a_missing_window() {
        let now = now_ms();
        // The five-hour window is over; the weekly one is not.
        let snapshot = held(Some(-1), Some(4 * 86_400_000), 0.0);
        let visible = visible_snapshot(&snapshot, now + 10);
        let quotas = visible.quotas.unwrap();
        assert_eq!(quotas.five_hour, None);
        assert_eq!(quotas.seven_day.unwrap().used_percent, 13.0);
        assert!(visible.available);
        // A zero that has NOT reset stays a window with a zero in it.
        let zero = visible_snapshot(&held(Some(3_600_000), None, 0.0), now);
        assert_eq!(zero.quotas.unwrap().five_hour.unwrap().used_percent, 0.0);
    }

    #[test]
    fn a_window_without_a_usable_reset_is_dropped_with_a_reason_and_never_turned_into_zero() {
        let now = NOW;
        let ok = json!({"usedPercent":0,"windowDurationMins":300,"resetsAt":1800018000});
        assert_eq!(window_problem(&ok, now).unwrap().used_percent, 0.0);
        let cases = [
            (
                json!({"usedPercent":0,"windowDurationMins":300,"resetsAt":null}),
                "resetsAt missing or null",
            ),
            (
                json!({"usedPercent":0,"windowDurationMins":300}),
                "resetsAt missing or null",
            ),
            (
                json!({"usedPercent":0,"windowDurationMins":300,"resetsAt":1700000000}),
                "resetsAt not in the future",
            ),
            (
                json!({"usedPercent":0,"windowDurationMins":null,"resetsAt":1800018000}),
                "windowDurationMins missing or null",
            ),
            (
                json!({"usedPercent":null,"windowDurationMins":300,"resetsAt":1800018000}),
                "usedPercent missing, null or out of range",
            ),
        ];
        for (window, reason) in cases {
            assert_eq!(
                window_problem(&window, now).unwrap_err(),
                reason,
                "{window}"
            );
            assert_eq!(read_window(&window, now), None);
        }
        // An idle account: the five-hour window is not usable, the weekly one is — the weekly one is kept.
        let idle = json!({"rateLimits":{
            "primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":null},
            "secondary":{"usedPercent":13,"windowDurationMins":10080,"resetsAt":1800600000}}});
        let quotas = parse_rate_limits(&idle, now).unwrap();
        assert_eq!(quotas.five_hour, None);
        assert_eq!(quotas.seven_day.unwrap().used_percent, 13.0);
        // What is logged says which and why — no values, no identifiers.
        let text = dropped_windows(&idle, now);
        assert_eq!(text, "primary: resetsAt missing or null");
        assert!(!text.contains("13") && !text.contains("1800"));
        assert_eq!(
            dropped_windows(&json!({"rateLimits":{"primary":null}}), now),
            "primary: absent; secondary: absent"
        );
        assert_eq!(dropped_windows(&quota_result(), NOW), "");
    }

    #[test]
    fn the_loading_state_is_not_unavailable() {
        let provider = Provider::default();
        provider.set_enabled(true);
        let loading = provider.last_snapshot();
        assert!(
            !loading.available
                && loading.failure_reason.is_none()
                && loading.quotas.is_none()
                && loading.updated_at.is_none()
        );
        assert_eq!(provider.next_wait(), MIN_REFRESH);
    }
    #[test]
    fn disabling_clears_snapshot_and_discards_an_in_flight_read() {
        runtime().block_on(async {
            let provider = std::sync::Arc::new(Provider::default());
            provider.set_enabled(true);
            let quotas = parse_rate_limits(&quota_result(), NOW).unwrap();
            provider
                .read_with_at(Instant::now(), async { Ok(quotas.clone()) })
                .await;
            assert!(provider.last_snapshot().available);

            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (result_tx, result_rx) = tokio::sync::oneshot::channel();
            let in_flight = {
                let provider = provider.clone();
                tokio::spawn(async move {
                    provider
                        .read_with_at(Instant::now() + MIN_REFRESH, async move {
                            let _ = started_tx.send(());
                            result_rx.await.unwrap()
                        })
                        .await
                })
            };
            started_rx.await.unwrap();
            provider.set_enabled(false);

            let disabled = provider.last_snapshot();
            assert_eq!(disabled.failure_reason, Some(FailureReason::Disabled));
            assert_eq!(disabled.quotas, None);
            assert!(!disabled.available);

            result_tx.send(Ok(quotas)).unwrap();
            assert_eq!(
                in_flight.await.unwrap().failure_reason,
                Some(FailureReason::Disabled)
            );
            assert_eq!(provider.last_snapshot(), disabled);
        });
    }

    #[test]
    fn version_parser_rejects_older_cli() {
        assert!(version_tuple("codex 0.165.0-alpha.1.2").unwrap() >= (0, 165, 0));
        assert!(version_tuple("codex 0.164.9").unwrap() < (0, 165, 0));
    }

    #[test]
    fn quota_reader_uses_the_active_codex_home_or_the_default_user_home() {
        let user = PathBuf::from(r"C:\Users\TestUser");
        assert_eq!(resolve_codex_home(None, user.clone()), user.join(".codex"));
        let isolated = PathBuf::from(r"C:\Users\TestUser\AppData\Local\Codex-Test");
        assert_eq!(resolve_codex_home(Some(isolated.clone()), user), isolated);
    }

    #[test]
    fn missing_codex_cli_candidates_leave_quota_unavailable() {
        runtime().block_on(async {
            assert_eq!(suitable_cli_from(Vec::new()).await, None);
            assert_eq!(
                Snapshot::unavailable(Some(FailureReason::CliUnavailable)).failure_reason,
                Some(FailureReason::CliUnavailable)
            );
        });
    }

    #[test]
    fn mock_app_server_handshake_notifications_and_request_id_correlation() {
        runtime().block_on(async {
            let before = vec![
                json!({"method":"server/notice","params":{"accountId":"private-account"}}),
                json!({"id":"push1","method":"server/needsInput","params":{"accountId":"private-account"}}),
                response(1, json!({"userAgent":"mock"})),
            ];
            let after = vec![
                json!({"method":"account/updated","params":{"token":"private-token"}}),
                response(99, json!({"rateLimits":{"primary":{"usedPercent":99}}})),
                response(2, quota_result()),
            ];
            let quotas = mock_exchange(before, after, NOW).await.unwrap();
            let five = quotas.five_hour.unwrap();
            let seven = quotas.seven_day.unwrap();
            assert_eq!((five.used_percent, five.window_duration_mins, five.resets_at), (23.0, 300, 1_800_018_000_000));
            assert_eq!((seven.used_percent, seven.window_duration_mins, seven.resets_at), (71.0, 10_080, 1_800_600_000_000));
            let normalized = serde_json::to_string(&quotas).unwrap();
            assert!(!normalized.contains("private-account"));
            assert!(!normalized.contains("private-token"));
            assert!(!normalized.contains("account/updated"));
        });
    }

    #[test]
    fn app_server_authorization_error_is_sanitized() {
        runtime().block_on(async {
            let result = mock_exchange(
                vec![response(1, json!({}))],
                vec![json!({"id":2,"error":{"code":-32001,"message":"denied account private-account token private-token"}})],
                NOW,
            ).await;
            assert_eq!(result, Err(FailureReason::Unauthorized));
            assert!(!format!("{result:?}").contains("private-token"));
            assert!(!format!("{result:?}").contains("private-account"));
        });
    }

    #[test]
    fn app_server_exit_before_response_returns_a_safe_error() {
        runtime().block_on(async {
            let result = mock_exchange(vec![response(1, json!({}))], vec![], NOW).await;
            assert_eq!(result, Err(FailureReason::ServerExited));
        });
    }

    #[cfg(windows)]
    #[test]
    fn app_server_cli_receives_the_windows_user_home_environment() {
        runtime().block_on(async {
            let exe = std::env::current_exe().unwrap();
            let fixture_args = [
                "--exact",
                "codex_quota::tests::mock_child_fixture",
                "--nocapture",
            ];
            let expected_home = crate::platform::home_dir().to_string_lossy().to_string();
            let mode = format!("verify-home:{expected_home}");
            let result = read_from_cli_with(
                &exe,
                &std::env::temp_dir(),
                &fixture_args,
                Some(("NOOK_QUOTA_FIXTURE", &mode)),
                Duration::from_secs(2),
            )
            .await;
            assert_eq!(result.unwrap().five_hour.unwrap().used_percent, 23.0);
        });
    }

    #[cfg(windows)]
    #[test]
    fn app_server_timeout_is_bounded_and_does_not_kill_an_unrelated_child() {
        runtime().block_on(async {
            let exe = std::env::current_exe().unwrap();
            let fixture_args = [
                "--exact",
                "codex_quota::tests::mock_child_fixture",
                "--nocapture",
            ];
            let marker =
                std::env::temp_dir().join(format!("nook-codex-heartbeat-{}", std::process::id()));
            let _ = fs::remove_file(&marker);
            let fixture_mode = format!("stall:{}", marker.display());
            let mut unrelated = Command::new(&exe)
                .args(fixture_args)
                .env("NOOK_QUOTA_FIXTURE", "idle")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let result = read_from_cli_with(
                &exe,
                &std::env::temp_dir(),
                &fixture_args,
                Some(("NOOK_QUOTA_FIXTURE", &fixture_mode)),
                Duration::from_millis(500),
            )
            .await;
            let marker_seen = marker.is_file();
            let heartbeat = fs::metadata(&marker)
                .and_then(|metadata| metadata.modified())
                .ok();
            tokio::time::sleep(Duration::from_millis(180)).await;
            let stopped = heartbeat.is_some()
                && fs::metadata(&marker)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    == heartbeat;
            let unrelated_survived = unrelated.try_wait().unwrap().is_none();
            terminate_and_reap(&mut unrelated).await;
            let _ = fs::remove_file(marker);
            assert!(unrelated.try_wait().unwrap().is_some());
            assert_eq!(result, Err(FailureReason::Timeout));
            assert!(marker_seen, "mock descendant must have started");
            assert!(stopped, "job cleanup must stop the descendant");
            assert!(unrelated_survived, "the unrelated child must remain alive");
        });
    }

    #[test]
    fn mock_child_fixture() {
        match std::env::var("NOOK_QUOTA_FIXTURE") {
            Ok(mode) if mode.starts_with("verify-home:") => {
                use std::io::{BufRead, Write};
                assert_eq!(
                    std::env::var("HOME").ok().as_deref(),
                    Some(mode.trim_start_matches("verify-home:"))
                );
                let stdin = std::io::stdin();
                let mut lines = stdin.lock().lines();
                let _ = lines.next();
                println!("{}", response(1, json!({})));
                let _ = std::io::stdout().flush();
                let _ = lines.next();
                let _ = lines.next();
                let mut quotas = quota_result();
                let now_seconds = now_ms() / 1000;
                quotas["rateLimits"]["primary"]["resetsAt"] = json!(now_seconds + 3600);
                quotas["rateLimits"]["secondary"]["resetsAt"] = json!(now_seconds + 7 * 24 * 3600);
                quotas["rateLimitsByLimitId"]["codex"]["primary"]["resetsAt"] =
                    json!(now_seconds + 3600);
                quotas["rateLimitsByLimitId"]["codex"]["secondary"]["resetsAt"] =
                    json!(now_seconds + 7 * 24 * 3600);
                println!("{}", response(2, quotas));
                let _ = std::io::stdout().flush();
            }
            Ok(mode) if mode == "idle" => loop {
                std::thread::sleep(Duration::from_secs(60));
            },
            Ok(mode) if mode.starts_with("stall:") => {
                use std::io::{BufRead, Write};
                let stdin = std::io::stdin();
                let mut lines = stdin.lock().lines();
                let _ = lines.next();
                println!("{}", response(1, json!({"accepted":true})));
                let _ = std::io::stdout().flush();
                let _ = lines.next();
                let _ = lines.next();
                let marker = mode.trim_start_matches("stall:");
                let fixture_args = [
                    "--exact",
                    "codex_quota::tests::mock_child_fixture",
                    "--nocapture",
                ];
                let heartbeat_mode = format!("heartbeat:{marker}");
                let _ = Command::new(std::env::current_exe().unwrap())
                    .args(fixture_args)
                    .env("NOOK_QUOTA_FIXTURE", heartbeat_mode)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn local mock descendant");
                loop {
                    std::thread::sleep(Duration::from_secs(60));
                }
            }
            Ok(mode) if mode.starts_with("heartbeat:") => {
                let marker = mode.trim_start_matches("heartbeat:");
                loop {
                    let _ = fs::write(marker, b"mock child alive");
                    std::thread::sleep(Duration::from_millis(30));
                }
            }
            _ => {}
        }
    }

    #[test]
    fn cache_serializes_parallel_reads_and_obeys_refresh_and_backoff() {
        runtime().block_on(async {
            let provider = std::sync::Arc::new(Provider::default());
            provider.set_enabled(true);
            let calls = std::sync::Arc::new(AtomicUsize::new(0));
            let base = Instant::now();
            let quotas = parse_rate_limits(&quota_result(), NOW).unwrap();
            let first_provider = provider.clone();
            let first_calls = calls.clone();
            let first_quotas = quotas.clone();
            let first = tokio::spawn(async move {
                first_provider
                    .read_with_at(base, async move {
                        first_calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok(first_quotas)
                    })
                    .await
            });
            let second_provider = provider.clone();
            let second_calls = calls.clone();
            let second_quotas = quotas.clone();
            let second = tokio::spawn(async move {
                second_provider
                    .read_with_at(base, async move {
                        second_calls.fetch_add(1, Ordering::SeqCst);
                        Ok(second_quotas)
                    })
                    .await
            });
            let second_snapshot = second.await.unwrap();
            let fresh = first.await.unwrap();
            assert_eq!(fresh, second_snapshot);
            assert!(fresh.available && !fresh.stale);
            assert_eq!(calls.load(Ordering::SeqCst), 1);

            let skipped_calls = calls.clone();
            let skipped = provider
                .read_with_at(base + Duration::from_secs(599), async move {
                    skipped_calls.fetch_add(1, Ordering::SeqCst);
                    Err(FailureReason::ProtocolError)
                })
                .await;
            assert_eq!(skipped, fresh);
            assert_eq!(calls.load(Ordering::SeqCst), 1);

            let fail_calls = calls.clone();
            let stale = provider
                .read_with_at(base + MIN_REFRESH, async move {
                    fail_calls.fetch_add(1, Ordering::SeqCst);
                    Err(FailureReason::Unauthorized)
                })
                .await;
            assert!(!stale.available && !stale.stale);
            assert_eq!(stale.quotas, None);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn final_event_refresh_at_scheduler_boundary_fetches_instead_of_reusing_cache() {
        runtime().block_on(async {
            let provider = Provider::default();
            provider.set_enabled(true);
            let base = Instant::now();
            let calls = AtomicUsize::new(0);
            let quotas = parse_rate_limits(&quota_result(), NOW).unwrap();

            let initial = provider
                .read_with_at_policy(base, async { Ok(quotas.clone()) }, true)
                .await;
            assert!(initial.available && !initial.stale);
            assert_eq!(calls.load(Ordering::SeqCst), 0);

            // Scheduler clears final_pending and admits the final read exactly at its
            // three-minute boundary. Cache's fetched_at is intentionally one tick newer
            // than scheduler's last_read to reproduce their former boundary race.
            let mut activity = Activity::default();
            quota_event(&mut activity, "UserPromptSubmit", "s", "t", None, base);
            activity.pending = false;
            activity.final_pending = true;
            activity.last_read = Some(base);
            assert_eq!(
                schedule_action(&mut activity, base + EVENT_COOLDOWN),
                ScheduleAction::Refresh
            );
            activity.final_pending = false;
            activity.last_read = Some(base + EVENT_COOLDOWN);

            let fetched = provider
                .read_with_at_policy(
                    base + EVENT_COOLDOWN - Duration::from_nanos(1),
                    async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(quotas)
                    },
                    true,
                )
                .await;
            assert!(fetched.available && !fetched.stale);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                1,
                "event read performed a real fetch"
            );
            assert!(!activity.final_pending);
            assert!(!activity.pending);
        });
    }

    #[test]
    fn failure_backoff_caps_retry_frequency_and_unavailable_has_no_payload() {
        runtime().block_on(async {
            let provider = Provider::default();
            provider.set_enabled(true);
            let base = Instant::now();
            for n in 0..6 {
                let snapshot = provider
                    .read_with_at(base + Duration::from_secs(n * 600), async {
                        Err(FailureReason::Timeout)
                    })
                    .await;
                assert_eq!(
                    snapshot,
                    Snapshot {
                        generation: 1,
                        ..Snapshot::unavailable(Some(FailureReason::Timeout))
                    }
                );
            }
            let too_soon = provider
                .read_with_at(base + Duration::from_secs(6 * 600), async {
                    panic!("backoff should suppress this read")
                })
                .await;
            assert_eq!(
                too_soon,
                Snapshot {
                    generation: 1,
                    ..Snapshot::unavailable(Some(FailureReason::Timeout))
                }
            );
            let due = provider
                .read_with_at(base + Duration::from_secs(6 * 600 + 1800), async {
                    Err(FailureReason::Timeout)
                })
                .await;
            assert_eq!(
                due,
                Snapshot {
                    generation: 1,
                    ..Snapshot::unavailable(Some(FailureReason::Timeout))
                }
            );
        });
    }

    #[test]
    fn timeout_and_child_cleanup_are_bounded() {
        runtime().block_on(async {
            let timed_out = timeout(Duration::from_millis(10), std::future::pending::<()>()).await;
            assert!(timed_out.is_err());

            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "codex_quota::tests::mock_child_fixture",
                    "--nocapture",
                ])
                .env("NOOK_QUOTA_FIXTURE", "idle")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            terminate_and_reap(&mut child).await;
            assert!(child.try_wait().unwrap().is_some());
        });
    }
}
