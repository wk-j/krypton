// Krypton — per-turn LLM usage log and live sender (spec 214).
//
// Every completed prompt turn becomes one numeric row. The row is appended to
// `.krypton/usage/<YYYY-MM-DD>.jsonl` FIRST and only then posted to Xenon, so a
// crash, a dead link, or a closed laptop costs nothing: the log is the
// authority and the server is a replica that catches up.
//
// This is deliberately NOT a spec-212 resource. A resource is a sealed snapshot
// of content-addressed files; appending one 300-byte row to it would mean
// re-uploading and re-sealing the whole day. Usage streams to its own endpoint
// and its own table instead (ADR-0019).
//
// Rows carry counts and identifiers only — never prompt or response text —
// which is what earns them the right to leave the machine without a per-row
// human decision.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::config::{KryptonConfig, UsageLogConfig, XenonConfig};

const USAGE_DIR: &str = "usage";
const CURSOR_FILE: &str = ".cursor.json";
/// Matches the server's batch cap. A backlog drains in chunks of this size.
const MAX_BATCH: usize = 500;
/// Idle heartbeat. The sender is woken by every append, so this only exists to
/// retry a backlog nobody is adding to.
const IDLE_WAIT_SECS: u64 = 300;
const BACKOFF_MIN_SECS: u64 = 2;
const BACKOFF_MAX_SECS: u64 = 300;
const REQUEST_TIMEOUT_SECS: u64 = 30;

// -------------------------------------------------------------------- types

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTokens {
    pub input: i64,
    pub output: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_read: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_write: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnContext {
    #[serde(default)]
    pub used: Option<i64>,
    #[serde(default)]
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCost {
    pub amount: f64,
    #[serde(default = "default_currency")]
    pub currency: String,
}

fn default_currency() -> String {
    "USD".to_string()
}

/// One completed prompt turn. Mirrors `TurnUsageRecord` in
/// `src/acp/usage-log.ts`; `hostname` is the one field the frontend does not
/// supply, because which machine this is is not the view's business.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
    pub v: u32,
    pub id: String,
    pub at: i64,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub hostname: String,
    pub harness_id: String,
    pub lane: String,
    pub backend: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_confirmed: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub turn: i64,
    pub stop_reason: String,
    pub origin: String,
    #[serde(default)]
    pub tokens: Option<TurnTokens>,
    #[serde(default)]
    pub context: Option<TurnContext>,
    #[serde(default)]
    pub cost: Option<TurnCost>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageGroup {
    pub key: String,
    pub turns: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_read_tokens: i64,
    pub cached_write_tokens: i64,
    pub reported_cost: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageRollup {
    pub date: String,
    pub turns: i64,
    pub turns_without_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_read_tokens: i64,
    pub cached_write_tokens: i64,
    pub reported_cost: f64,
    pub reported_cost_turns: i64,
    pub currency: String,
    pub by_model: Vec<UsageGroup>,
    pub by_lane: Vec<UsageGroup>,
    pub unsent: usize,
    pub recording: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
struct Cursor {
    /// File name (`YYYY-MM-DD.jsonl`) the cursor sits in. Empty = nothing sent.
    #[serde(default)]
    file: String,
    /// How many lines of that file the server has acknowledged.
    #[serde(default)]
    line: usize,
}

#[derive(Debug, Deserialize)]
struct IngestAck {
    #[serde(default)]
    accepted: usize,
    #[serde(default)]
    duplicates: usize,
    #[serde(default)]
    rejected: Vec<serde_json::Value>,
}

/// Why a drain stopped. `Unauthorized` is separated from `Transport` because
/// only one of them is fixed by waiting.
#[derive(Debug)]
enum DrainOutcome {
    /// Nothing pending, or everything pending was accepted.
    Idle,
    /// Rows were sent; there may be more behind them.
    Progress,
    Transport(String),
    Unauthorized(String),
    /// Not configured to send at all. Recording continues regardless.
    NotPublishing,
}

// ------------------------------------------------------------------ on disk

fn usage_dir(cwd: &Path) -> PathBuf {
    cwd.join(".krypton").join(USAGE_DIR)
}

/// UTC date of an epoch-ms instant as `YYYY-MM-DD` — the day file's name, and
/// the same convention every other dated path in the app uses.
pub fn day_stamp(at_ms: i64) -> String {
    let secs = at_ms.div_euclid(1000);
    let (year, month, day) = crate::hook_server::civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Append one row. Opens with `O_APPEND` and writes the line in a single call,
/// so two harnesses sharing a project cannot interleave halves of a row.
pub fn append(cwd: &Path, record: &TurnRecord) -> Result<(), String> {
    let dir = usage_dir(cwd);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .krypton/usage: {e}"))?;
    let path = dir.join(format!("{}.jsonl", day_stamp(record.at)));

    let mut line = serde_json::to_string(record).map_err(|e| format!("serialize turn: {e}"))?;
    line.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))
}

/// Day files present, oldest first. Names are `YYYY-MM-DD.jsonl`, so lexical
/// order is chronological order.
fn day_files(cwd: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(usage_dir(cwd)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".jsonl") && !n.starts_with('.'))
        .collect();
    names.sort();
    names
}

/// Parse a day file, skipping rows that will never parse. A single corrupt line
/// (a half-written row from a hard kill) must not hide the rest of the day.
fn read_day_file(cwd: &Path, name: &str) -> Vec<TurnRecord> {
    let path = usage_dir(cwd).join(name);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| match serde_json::from_str::<TurnRecord>(l) {
            Ok(record) => Some(record),
            Err(e) => {
                log::warn!("usage: skipping unparseable row in {name}: {e}");
                None
            }
        })
        .collect()
}

pub fn read_day(cwd: &Path, date: &str) -> Vec<TurnRecord> {
    read_day_file(cwd, &format!("{date}.jsonl"))
}

/// Delete day files older than `retain_days`. Rows still unsent are pruned too:
/// a two-month-old undelivered row is not worth an unbounded queue, and its
/// absence is a visible gap rather than a wrong total.
pub fn prune(cwd: &Path, retain_days: u64) -> usize {
    if retain_days == 0 {
        return 0;
    }
    let cutoff = day_stamp(now_ms() - (retain_days as i64) * 86_400_000);
    let mut removed = 0;
    for name in day_files(cwd) {
        let stem = name.trim_end_matches(".jsonl");
        if stem < cutoff.as_str() && std::fs::remove_file(usage_dir(cwd).join(&name)).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ------------------------------------------------------------------- cursor

fn cursor_path(cwd: &Path) -> PathBuf {
    usage_dir(cwd).join(CURSOR_FILE)
}

fn read_cursor(cwd: &Path) -> Cursor {
    std::fs::read_to_string(cursor_path(cwd))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_cursor(cwd: &Path, cursor: &Cursor) -> Result<(), String> {
    let dir = usage_dir(cwd);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .krypton/usage: {e}"))?;
    let text = serde_json::to_string(cursor).map_err(|e| format!("serialize cursor: {e}"))?;
    std::fs::write(cursor_path(cwd), text).map_err(|e| format!("write usage cursor: {e}"))
}

/// Rows after the cursor, oldest first, capped at `MAX_BATCH`.
///
/// Returns the rows plus the cursor that acknowledging them would produce, so
/// the caller never has to recompute the position it just consumed.
fn pending(cwd: &Path, cursor: &Cursor) -> (Vec<TurnRecord>, Cursor) {
    let mut rows = Vec::new();
    let mut next = cursor.clone();

    for name in day_files(cwd) {
        // The cursor names the file it sits IN; earlier files are fully sent.
        // A cursor pointing at a pruned file therefore skips forward to the
        // oldest surviving file and never re-sends an older one.
        if !cursor.file.is_empty() && name.as_str() < cursor.file.as_str() {
            continue;
        }
        let skip = if name == cursor.file { cursor.line } else { 0 };
        let day = read_day_file(cwd, &name);
        if day.len() <= skip {
            // Fully sent; remember it so the cursor advances past empty days.
            if name.as_str() >= next.file.as_str() {
                next = Cursor {
                    file: name,
                    line: day.len(),
                };
            }
            continue;
        }
        for (index, record) in day.into_iter().enumerate().skip(skip) {
            rows.push(record);
            next = Cursor {
                file: name.clone(),
                line: index + 1,
            };
            if rows.len() >= MAX_BATCH {
                return (rows, next);
            }
        }
    }
    (rows, next)
}

/// How many recorded rows Xenon has not acknowledged. Drives the `#usage`
/// footer line; deliberately counts rows, not requests.
pub fn unsent_count(cwd: &Path) -> usize {
    let cursor = read_cursor(cwd);
    let mut count = 0usize;
    for name in day_files(cwd) {
        if !cursor.file.is_empty() && name.as_str() < cursor.file.as_str() {
            continue;
        }
        let skip = if name == cursor.file { cursor.line } else { 0 };
        count += read_day_file(cwd, &name).len().saturating_sub(skip);
    }
    count
}

// ------------------------------------------------------------------ rollup

pub fn rollup(cwd: &Path, date: &str, recording: bool) -> UsageRollup {
    let rows = read_day(cwd, date);
    let mut out = UsageRollup {
        date: date.to_string(),
        currency: "USD".to_string(),
        recording,
        unsent: unsent_count(cwd),
        ..Default::default()
    };

    let mut by_model: Vec<UsageGroup> = Vec::new();
    let mut by_lane: Vec<UsageGroup> = Vec::new();

    for row in &rows {
        out.turns += 1;
        let model = row.model.as_deref().unwrap_or("(unreported)");
        // Indices rather than references: the two groups live in different
        // vectors, so borrowing both at once is only legal once the lookups
        // have finished.
        let model_index = index_for(&mut by_model, model);
        let lane_index = index_for(&mut by_lane, &row.lane);
        by_model[model_index].turns += 1;
        by_lane[lane_index].turns += 1;

        match &row.tokens {
            None => out.turns_without_tokens += 1,
            Some(tokens) => {
                let cached_read = tokens.cached_read.unwrap_or(0);
                let cached_write = tokens.cached_write.unwrap_or(0);
                out.input_tokens += tokens.input;
                out.output_tokens += tokens.output;
                out.cached_read_tokens += cached_read;
                out.cached_write_tokens += cached_write;
                for group in [&mut by_model[model_index], &mut by_lane[lane_index]] {
                    group.input_tokens += tokens.input;
                    group.output_tokens += tokens.output;
                    group.cached_read_tokens += cached_read;
                    group.cached_write_tokens += cached_write;
                }
            }
        }

        if let Some(cost) = &row.cost {
            out.reported_cost += cost.amount;
            out.reported_cost_turns += 1;
            out.currency = cost.currency.clone();
            by_model[model_index].reported_cost += cost.amount;
            by_lane[lane_index].reported_cost += cost.amount;
        }
    }

    by_model.sort_by(|a, b| b.turns.cmp(&a.turns).then_with(|| a.key.cmp(&b.key)));
    by_lane.sort_by(|a, b| b.turns.cmp(&a.turns).then_with(|| a.key.cmp(&b.key)));
    out.by_model = by_model;
    out.by_lane = by_lane;
    out
}

fn index_for(groups: &mut Vec<UsageGroup>, key: &str) -> usize {
    if let Some(index) = groups.iter().position(|g| g.key == key) {
        return index;
    }
    groups.push(UsageGroup {
        key: key.to_string(),
        ..Default::default()
    });
    groups.len() - 1
}

// ------------------------------------------------------------------- sender

/// Shared handle between the Tauri commands and the background sender task.
pub struct UsageOutbox {
    /// The project the harness is recording for. Set by the first append; the
    /// app has one primary workspace, so one project at a time is the truth.
    cwd: std::sync::Mutex<Option<PathBuf>>,
    wake: Notify,
    client: reqwest::Client,
    /// Pruning is a once-per-run housekeeping pass, not a per-turn cost. It
    /// cannot run at startup because the project directory is not known until
    /// the harness reports one.
    pruned: std::sync::atomic::AtomicBool,
}

impl UsageOutbox {
    pub fn new() -> Self {
        Self {
            cwd: std::sync::Mutex::new(None),
            wake: Notify::new(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .unwrap_or_default(),
            pruned: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Run the retention pass once per app run, the first time a project is
    /// known. Returns how many day files were removed.
    pub fn prune_once(&self, cwd: &Path, retain_days: u64) -> usize {
        if self.pruned.swap(true, std::sync::atomic::Ordering::Relaxed) {
            return 0;
        }
        let removed = prune(cwd, retain_days);
        if removed > 0 {
            log::info!("usage: pruned {removed} day file(s) past {retain_days} days");
        }
        removed
    }

    pub fn note_project(&self, cwd: &Path) {
        if let Ok(mut slot) = self.cwd.lock() {
            if slot.as_deref() != Some(cwd) {
                *slot = Some(cwd.to_path_buf());
            }
        }
    }

    pub fn project_dir(&self) -> Option<PathBuf> {
        self.cwd.lock().ok().and_then(|slot| slot.clone())
    }

    /// Ask the sender to drain now instead of waiting out its backoff.
    pub fn wake(&self) {
        self.wake.notify_one();
    }
}

impl Default for UsageOutbox {
    fn default() -> Self {
        Self::new()
    }
}

/// The background sender. Wakes on every append, so a turn is normally on the
/// server within a second; the timer exists only to retry a backlog.
pub async fn run_sender(outbox: Arc<UsageOutbox>, config: Arc<std::sync::RwLock<KryptonConfig>>) {
    let mut backoff = BACKOFF_MIN_SECS;
    loop {
        // At the floor there is nothing to retry, so the timer is only a
        // heartbeat; above it, the timer IS the retry.
        let wait = std::time::Duration::from_secs(if backoff == BACKOFF_MIN_SECS {
            IDLE_WAIT_SECS
        } else {
            backoff
        });
        tokio::select! {
            _ = outbox.wake.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }

        let Some(cwd) = outbox.project_dir() else {
            continue;
        };
        let (usage_config, xenon_config) = match config.read() {
            Ok(cfg) => (cfg.usage_log.clone(), cfg.xenon.clone()),
            Err(_) => continue,
        };
        outbox.prune_once(&cwd, usage_config.retain_days);

        match drain(&outbox.client, &cwd, &usage_config, &xenon_config).await {
            DrainOutcome::Progress => {
                backoff = BACKOFF_MIN_SECS;
                // More may be queued behind the batch we just sent.
                outbox.wake();
            }
            DrainOutcome::Idle | DrainOutcome::NotPublishing => backoff = BACKOFF_MIN_SECS,
            DrainOutcome::Transport(reason) => {
                log::warn!("usage: send failed, retrying in {backoff}s: {reason}");
                backoff = (backoff * 2).min(BACKOFF_MAX_SECS);
            }
            DrainOutcome::Unauthorized(reason) => {
                // A rejected credential is not fixed by waiting, so back off to
                // the maximum rather than stopping outright: the backlog then
                // drains by itself once `#xenon token` stores a good one, with
                // no re-arming step for the human to remember.
                log::warn!("usage: server rejected the token ({reason}); backing off");
                backoff = BACKOFF_MAX_SECS;
            }
        }
    }
}

/// Send everything after the cursor, one batch per call.
async fn drain(
    client: &reqwest::Client,
    cwd: &Path,
    usage: &UsageLogConfig,
    xenon: &XenonConfig,
) -> DrainOutcome {
    if !usage.enabled || !usage.publish || !xenon.enabled {
        return DrainOutcome::NotPublishing;
    }
    let base_url = crate::xenon::normalize_base_url(&xenon.base_url);
    if base_url.is_empty() {
        return DrainOutcome::NotPublishing;
    }
    let token = match crate::xenon::load_token(&base_url) {
        Ok(Some(token)) => token,
        Ok(None) => return DrainOutcome::NotPublishing,
        Err(e) => return DrainOutcome::Transport(e),
    };

    let cursor = read_cursor(cwd);
    let (rows, next) = pending(cwd, &cursor);
    if rows.is_empty() {
        if next != cursor {
            let _ = write_cursor(cwd, &next);
        }
        return DrainOutcome::Idle;
    }

    let project = crate::xenon::derive_project(cwd, &xenon.project);
    let sent = rows.len();
    let url = format!("{base_url}/v1/projects/{project}/usage/turns");
    let response = client
        .post(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "turns": rows }))
        .send()
        .await;

    match response {
        Err(e) => DrainOutcome::Transport(format!("{e}")),
        Ok(response) if response.status().is_success() => {
            let ack: IngestAck = response.json().await.unwrap_or(IngestAck {
                accepted: sent,
                duplicates: 0,
                rejected: Vec::new(),
            });
            // A row the server will never accept is acked anyway: leaving it at
            // the head of the queue would wedge every row behind it forever.
            if !ack.rejected.is_empty() {
                log::warn!("usage: server rejected {} row(s)", ack.rejected.len());
            }
            if let Err(e) = write_cursor(cwd, &next) {
                // The rows landed; failing to record that would re-send them.
                // They deduplicate on id, so this is loud but not harmful.
                return DrainOutcome::Transport(format!("cursor not saved: {e}"));
            }
            log::debug!(
                "usage: {} accepted, {} duplicate",
                ack.accepted,
                ack.duplicates
            );
            DrainOutcome::Progress
        }
        Ok(response) => {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            let detail = detail.chars().take(200).collect::<String>();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                DrainOutcome::Unauthorized(detail)
            } else {
                DrainOutcome::Transport(format!("{status}: {detail}"))
            }
        }
    }
}

/// Record one turn: stamp the machine, append, and wake the sender.
pub fn record(outbox: &UsageOutbox, cwd: &Path, mut turn: TurnRecord) -> Result<(), String> {
    if turn.hostname.is_empty() {
        turn.hostname = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "unknown".to_string());
    }
    append(cwd, &turn)?;
    outbox.note_project(cwd);
    outbox.wake();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A private scratch project directory. No `tempfile` dependency — the rest
    /// of the crate's tests use `std::env::temp_dir()` the same way.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("krypton-usage-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn turn(id: &str, at: i64, model: &str, lane: &str, input: i64, output: i64) -> TurnRecord {
        TurnRecord {
            v: 1,
            id: id.to_string(),
            at,
            duration_ms: Some(1000),
            hostname: "test-host".to_string(),
            harness_id: "hm-1".to_string(),
            lane: lane.to_string(),
            backend: "claude".to_string(),
            model: Some(model.to_string()),
            model_confirmed: true,
            session_id: Some("s-1".to_string()),
            turn: 1,
            stop_reason: "end_turn".to_string(),
            origin: "user".to_string(),
            tokens: Some(TurnTokens {
                input,
                output,
                cached_read: Some(100),
                cached_write: None,
                thought: None,
                total: None,
            }),
            context: None,
            cost: None,
        }
    }

    #[test]
    fn day_stamp_buckets_by_utc_date() {
        assert_eq!(day_stamp(0), "1970-01-01");
        assert_eq!(day_stamp(1_786_233_600_000), "2026-08-09");
        // One millisecond before midnight belongs to the day that is ending.
        assert_eq!(day_stamp(1_786_233_599_999), "2026-08-08");
    }

    #[test]
    fn appended_rows_round_trip_and_roll_up() {
        let scratch = Scratch::new();
        let cwd = scratch.path();
        let at = 1_786_233_600_000;
        append(cwd, &turn("a", at, "opus", "Claude-1", 100, 10)).unwrap();
        append(cwd, &turn("b", at, "opus", "Claude-1", 200, 20)).unwrap();
        append(cwd, &turn("c", at, "codex", "Codex-1", 300, 30)).unwrap();

        let sums = rollup(cwd, "2026-08-09", true);
        assert_eq!(sums.turns, 3);
        assert_eq!(sums.input_tokens, 600);
        assert_eq!(sums.output_tokens, 60);
        assert_eq!(sums.cached_read_tokens, 300);
        assert_eq!(sums.by_model.len(), 2);
        // Sorted by turn count: the two-turn model leads.
        assert_eq!(sums.by_model[0].key, "opus");
        assert_eq!(sums.by_model[0].turns, 2);
        assert_eq!(sums.by_model[0].input_tokens, 300);
    }

    /// A turn whose adapter reported nothing must be counted as a turn and
    /// named as unreported — never folded in as a zero, which would understate
    /// the project without anyone being able to tell.
    #[test]
    fn a_turn_without_counters_is_counted_but_not_summed() {
        let scratch = Scratch::new();
        let cwd = scratch.path();
        let at = 1_786_233_600_000;
        let mut blind = turn("a", at, "gemini", "Gemini-1", 0, 0);
        blind.tokens = None;
        append(cwd, &blind).unwrap();
        append(cwd, &turn("b", at, "opus", "Claude-1", 50, 5)).unwrap();

        let sums = rollup(cwd, "2026-08-09", true);
        assert_eq!(sums.turns, 2);
        assert_eq!(sums.turns_without_tokens, 1);
        assert_eq!(
            sums.input_tokens, 50,
            "the blind turn must contribute no tokens"
        );
    }

    /// A half-written line from a hard kill must cost exactly one row, not the
    /// rest of the day behind it.
    #[test]
    fn a_corrupt_line_does_not_hide_the_rows_after_it() {
        let scratch = Scratch::new();
        let cwd = scratch.path();
        let at = 1_786_233_600_000;
        append(cwd, &turn("a", at, "opus", "Claude-1", 100, 10)).unwrap();
        let path = usage_dir(cwd).join("2026-08-09.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"{\"v\":1,\"id\":\"trunc\"\n").unwrap();
        drop(file);
        append(cwd, &turn("c", at, "opus", "Claude-1", 100, 10)).unwrap();

        let sums = rollup(cwd, "2026-08-09", true);
        assert_eq!(sums.turns, 2);
        assert_eq!(sums.input_tokens, 200);
    }

    #[test]
    fn the_cursor_walks_forward_across_days_and_never_repeats_a_row() {
        let scratch = Scratch::new();
        let cwd = scratch.path();
        let day1 = 1_786_233_600_000; // 2026-08-09
        let day2 = day1 + 86_400_000; // 2026-08-10
        append(cwd, &turn("a", day1, "opus", "Claude-1", 1, 1)).unwrap();
        append(cwd, &turn("b", day1, "opus", "Claude-1", 1, 1)).unwrap();
        append(cwd, &turn("c", day2, "opus", "Claude-1", 1, 1)).unwrap();

        let (rows, next) = pending(cwd, &Cursor::default());
        assert_eq!(rows.len(), 3);
        assert_eq!(next.file, "2026-08-10.jsonl");
        assert_eq!(next.line, 1);
        write_cursor(cwd, &next).unwrap();

        let (rows, _) = pending(cwd, &read_cursor(cwd));
        assert!(rows.is_empty(), "an acked backlog must not be re-sent");
        assert_eq!(unsent_count(cwd), 0);

        append(cwd, &turn("d", day2, "opus", "Claude-1", 1, 1)).unwrap();
        let (rows, _) = pending(cwd, &read_cursor(cwd));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "d");
        assert_eq!(unsent_count(cwd), 1);
    }

    /// The cursor's file having been pruned must move it forward to the oldest
    /// surviving file, never backward into rows the server already has.
    #[test]
    fn a_pruned_cursor_file_does_not_resend_older_days() {
        let scratch = Scratch::new();
        let cwd = scratch.path();
        let day2 = 1_786_233_600_000 + 86_400_000;
        append(cwd, &turn("c", day2, "opus", "Claude-1", 1, 1)).unwrap();
        write_cursor(
            cwd,
            &Cursor {
                file: "2026-08-09.jsonl".to_string(), // pruned
                line: 5,
            },
        )
        .unwrap();

        let (rows, next) = pending(cwd, &read_cursor(cwd));
        assert_eq!(rows.len(), 1, "only the surviving day is pending");
        assert_eq!(rows[0].id, "c");
        assert_eq!(next.file, "2026-08-10.jsonl");
    }

    #[test]
    fn prune_drops_old_days_and_keeps_recent_ones() {
        let scratch = Scratch::new();
        let cwd = scratch.path();
        let now = now_ms();
        append(cwd, &turn("old", now - 100 * 86_400_000, "opus", "L", 1, 1)).unwrap();
        append(cwd, &turn("new", now, "opus", "L", 1, 1)).unwrap();

        assert_eq!(prune(cwd, 90), 1);
        assert_eq!(day_files(cwd).len(), 1);
        assert_eq!(prune(cwd, 0), 0, "retain_days = 0 must disable pruning");
    }
}

#[cfg(test)]
mod wire_shape {
    use super::*;

    /// The row crosses a repo boundary: this struct serializes it and Xenon's
    /// `usage::TurnRow` (in `~/Source/xenon`) deserializes it, with no shared
    /// type between them. A renamed field would compile on both sides and fail
    /// only in production, as a silently empty column — so the exact wire keys
    /// are pinned here. Verified against a live server on 2026-08-09.
    ///
    /// Changing this test means changing `docs/01-protocol.md` in the Xenon
    /// repo and both structs, deliberately.
    #[test]
    fn the_wire_keys_match_what_the_server_deserializes() {
        let record = TurnRecord {
            v: 1,
            id: "usg-1786233600000-0f765408".into(),
            at: 1_786_233_600_000,
            duration_ms: Some(41_230),
            hostname: "mbp".into(),
            harness_id: "hm-1".into(),
            lane: "Claude-3".into(),
            backend: "claude".into(),
            model: Some("claude-opus-5".into()),
            model_confirmed: true,
            session_id: Some("sess-1".into()),
            turn: 7,
            stop_reason: "end_turn".into(),
            origin: "user".into(),
            tokens: Some(TurnTokens {
                input: 12043,
                output: 812,
                cached_read: Some(98211),
                cached_write: None,
                thought: None,
                total: None,
            }),
            context: Some(TurnContext {
                used: Some(132_000),
                size: Some(1_000_000),
            }),
            cost: Some(TurnCost {
                amount: 0.42,
                currency: "USD".into(),
            }),
        };

        let json = serde_json::to_string(&record).unwrap();
        assert_eq!(
            json,
            concat!(
                r#"{"v":1,"id":"usg-1786233600000-0f765408","at":1786233600000,"#,
                r#""durationMs":41230,"hostname":"mbp","harnessId":"hm-1","#,
                r#""lane":"Claude-3","backend":"claude","model":"claude-opus-5","#,
                r#""modelConfirmed":true,"sessionId":"sess-1","turn":7,"#,
                r#""stopReason":"end_turn","origin":"user","#,
                r#""tokens":{"input":12043,"output":812,"cachedRead":98211},"#,
                r#""context":{"used":132000,"size":1000000},"#,
                r#""cost":{"amount":0.42,"currency":"USD"}}"#
            )
        );
    }

    /// An absent counter must serialize as ABSENT, not as 0. The server stores
    /// `has_tokens = 0` for it and counts it separately; a zero would be
    /// indistinguishable from a genuinely free turn.
    #[test]
    fn an_unreported_turn_omits_tokens_rather_than_zeroing_them() {
        let mut record = TurnRecord {
            v: 1,
            id: "usg-1".into(),
            at: 1,
            duration_ms: None,
            hostname: String::new(),
            harness_id: "hm-1".into(),
            lane: "L".into(),
            backend: "gemini".into(),
            model: None,
            model_confirmed: false,
            session_id: None,
            turn: 1,
            stop_reason: "end_turn".into(),
            origin: "user".into(),
            tokens: None,
            context: None,
            cost: None,
        };
        assert!(serde_json::to_string(&record)
            .unwrap()
            .contains(r#""tokens":null"#));

        record.tokens = Some(TurnTokens {
            input: 5,
            output: 5,
            cached_read: None,
            cached_write: None,
            thought: None,
            total: None,
        });
        let json = serde_json::to_string(&record).unwrap();
        assert!(
            !json.contains("cachedRead"),
            "an absent cache tier must not become 0: {json}"
        );
    }
}
