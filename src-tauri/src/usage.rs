// Krypton — Subscription credit usage (spec 151).
//
// Read-only providers:
//   - Claude: OAuth usage endpoint, authenticated with the token Claude Code
//     already maintains (~/.claude/.credentials.json, macOS Keychain fallback).
//     Responses are cached for 180 s per token to stay inside the endpoint's
//     safe polling cadence regardless of how many views poll, and the last
//     good payload is persisted to the OS cache dir (keyed by a token hash)
//     so restarts don't cost a request or blank the widget. A 429 arms a
//     Retry-After backoff: no network until the penalty lapses, and the
//     error sentinel carries the deadline ("rate-limited:<epochMs>").
//   - Codex: newest `token_count` event with a non-null `rate_limits` object
//     from the local rollout JSONL under ~/.codex/sessions (CODEX_HOME aware).
//
// Tokens are never logged and never leave this module except as the
// Authorization header to api.anthropic.com. Error strings are static
// sentinels — never raw HTTP bodies.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_CACHE_TTL_MS: i64 = 180_000;
const CODEX_MAX_FILES: usize = 10;
const GROK_USAGE_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing";
// Sent defensively so the request looks like the CLI's own; the endpoint
// accepts a bare Bearer without it (verified), so it is not required.
const GROK_CLIENT_VERSION: &str = "0.2.93";

// ─── Payload types (camelCase over IPC) ─────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: Option<f64>,
    pub used_credits: Option<f64>,
    pub utilization: Option<f64>,
}

/// Model-scoped weekly window from the `limits` array of the OAuth usage
/// payload (spec 187), e.g. the Fable weekly bucket. Unlike the legacy
/// top-level `seven_day_*` fields, these are keyed by the model display name
/// the server sends, so new scoped buckets surface without a code change.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScopedUsageWindow {
    pub name: String,
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
    pub seven_day_opus: Option<UsageWindow>,
    pub seven_day_sonnet: Option<UsageWindow>,
    /// `serde(default)` so disk caches written before spec 187 still load.
    #[serde(default)]
    pub weekly_scoped: Vec<ScopedUsageWindow>,
    pub extra_usage: Option<ExtraUsage>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub fetched_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexWindow {
    pub used_percent: f64,
    pub window_minutes: u64,
    pub resets_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub primary: Option<CodexWindow>,
    pub secondary: Option<CodexWindow>,
    pub plan_type: Option<String>,
    pub observed_at: String,
    pub session_file: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopilotQuota {
    pub used_percent: f64,
    pub remaining: f64,
    pub entitlement: f64,
    pub unlimited: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopilotUsage {
    pub premium: Option<CopilotQuota>,
    pub chat: Option<CopilotQuota>,
    pub completions: Option<CopilotQuota>,
    pub plan: Option<String>,
    /// Monthly reset day, e.g. "2026-07-01".
    pub reset_date: Option<String>,
    pub fetched_at: i64,
}

/// Cursor plan usage from the dashboard RPC
/// (`DashboardService/GetCurrentPeriodUsage`), which accepts the same CLI
/// JWT and returns spend vs included allowance for the current billing
/// cycle. Spend fields are in dollars (the RPC reports cents). The legacy
/// request counters remain as a fallback slot for old request-capped plans.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsage {
    pub total_percent_used: Option<f64>,
    pub total_spend: Option<f64>,
    pub included_spend: Option<f64>,
    pub bonus_spend: Option<f64>,
    pub limit_spend: Option<f64>,
    /// Billing-cycle bounds, epoch ms.
    pub cycle_start: Option<i64>,
    pub cycle_end: Option<i64>,
    pub requests_used: Option<f64>,
    pub requests_limit: Option<f64>,
    pub email: Option<String>,
    pub fetched_at: i64,
}

/// Grok subscription credit usage from `cli-chat-proxy.grok.com/v1/billing`
/// (spec 193). Grok's CLI does not persist rate-limit data locally, so this is
/// the only pollable surface: the monthly credit balance (`used`/`monthlyLimit`)
/// plus billing-cycle bounds. All fields are optional — an on-demand-only or
/// non-subscription account omits `monthlyLimit`, in which case there is no
/// gauge to draw.
///
/// `Deserialize` so the disk cache (below) can warm the payload on a fresh
/// process; every field is `Option`, so a cache written by an older shape
/// still loads.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrokUsage {
    pub used: Option<f64>,
    pub monthly_limit: Option<f64>,
    pub on_demand_cap: Option<f64>,
    pub on_demand_used: Option<f64>,
    /// Billing-cycle bounds, epoch ms.
    pub period_start: Option<i64>,
    pub period_end: Option<i64>,
    /// JWT `tier` claim rendered as "tier N".
    pub tier: Option<String>,
    pub email: Option<String>,
    pub fetched_at: i64,
}

// ─── Claude credentials ─────────────────────────────────────────────────────

struct ClaudeCreds {
    access_token: String,
    expires_at_ms: i64,
    scopes: Vec<String>,
    subscription_type: Option<String>,
    rate_limit_tier: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_claude_creds(raw: &str) -> Option<ClaudeCreds> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let oauth = v.get("claudeAiOauth")?;
    Some(ClaudeCreds {
        access_token: oauth.get("accessToken")?.as_str()?.to_string(),
        expires_at_ms: oauth.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
        scopes: oauth
            .get("scopes")
            .and_then(Value::as_array)
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default(),
        subscription_type: oauth
            .get("subscriptionType")
            .and_then(Value::as_str)
            .map(String::from),
        rate_limit_tier: oauth
            .get("rateLimitTier")
            .and_then(Value::as_str)
            .map(String::from),
    })
}

/// Keep whichever credential set expires later. Claude Code on macOS keeps
/// the live token in the Keychain while a stale ~/.claude/.credentials.json
/// can linger from an older version — the file alone is not authoritative.
fn pick_fresher(best: Option<ClaudeCreds>, candidate: ClaudeCreds) -> Option<ClaudeCreds> {
    match best {
        Some(b) if b.expires_at_ms >= candidate.expires_at_ms => Some(b),
        _ => Some(candidate),
    }
}

async fn load_claude_creds() -> Result<ClaudeCreds, String> {
    let mut best: Option<ClaudeCreds> = None;

    if let Some(home) = dirs::home_dir() {
        let path = home.join(".claude/.credentials.json");
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Some(creds) = parse_claude_creds(&raw) {
                best = pick_fresher(best, creds);
            }
        }
    }

    // macOS: consult the Keychain whenever the file token is missing or
    // already expired. Skipped while the file is fresh so the 180 s polling
    // path doesn't spawn `security` every cycle.
    #[cfg(target_os = "macos")]
    if best.as_ref().map_or(true, |c| c.expires_at_ms <= now_ms()) {
        let cmd = tokio::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output();
        if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(2), cmd).await {
            if out.status.success() {
                let raw = String::from_utf8_lossy(&out.stdout);
                if let Some(creds) = parse_claude_creds(raw.trim()) {
                    best = pick_fresher(best, creds);
                }
            }
        }
    }

    best.ok_or_else(|| "not-connected".to_string())
}

// ─── Claude usage fetch ──────────────────────────────────────────────────────

// Cache key is the access token itself; it never leaves process memory.
static CLAUDE_CACHE: Mutex<Option<(String, ClaudeUsage)>> = Mutex::new(None);
// 429 backoff from Retry-After: fetches are skipped until this epoch-ms.
static CLAUDE_THROTTLE: Mutex<Option<(String, i64)>> = Mutex::new(None);

/// Cap a Retry-After value so a bogus header can't brick fetching until
/// restart; absent header backs off one poll cycle.
const CLAUDE_RETRY_AFTER_MAX_S: i64 = 3_600;

// ─── Claude disk cache ───────────────────────────────────────────────────────
//
// The in-memory cache dies with the process, and dev iteration restarts the
// app constantly — every restart used to cost one real request and an empty
// widget until it landed. The last good payload is persisted to the OS cache
// dir, keyed by a hash of the token (the token itself is never written).

fn token_fingerprint(token: &str) -> String {
    let mut hasher = DefaultHasher::new();
    token.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn claude_disk_cache_path() -> Option<PathBuf> {
    Some(dirs::cache_dir()?.join("krypton/claude-usage.json"))
}

fn load_disk_claude_from(path: &PathBuf, token: &str) -> Option<ClaudeUsage> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    if v.get("tokenFingerprint")?.as_str()? != token_fingerprint(token) {
        return None;
    }
    serde_json::from_value(v.get("usage")?.clone()).ok()
}

fn store_disk_claude_to(path: &PathBuf, token: &str, usage: &ClaudeUsage) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let payload = serde_json::json!({
        "tokenFingerprint": token_fingerprint(token),
        "usage": usage,
    });
    let _ = std::fs::write(path, payload.to_string());
}

fn window_from(v: Option<&Value>) -> Option<UsageWindow> {
    let obj = v?.as_object()?;
    Some(UsageWindow {
        utilization: obj.get("utilization").and_then(Value::as_f64)?,
        resets_at: obj
            .get("resets_at")
            .and_then(Value::as_str)
            .map(String::from),
    })
}

/// Model-scoped weekly windows from the `limits` array. Session and
/// weekly-all entries are skipped (the top-level fields already carry them);
/// surface-scoped entries without a model are skipped too.
fn scoped_windows_from(limits: Option<&Value>) -> Vec<ScopedUsageWindow> {
    let Some(entries) = limits.and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            if entry.get("kind").and_then(Value::as_str) != Some("weekly_scoped") {
                return None;
            }
            let name = entry
                .get("scope")?
                .get("model")?
                .get("display_name")?
                .as_str()?
                .trim();
            if name.is_empty() {
                return None;
            }
            Some(ScopedUsageWindow {
                name: name.to_string(),
                utilization: entry.get("percent").and_then(Value::as_f64)?,
                resets_at: entry
                    .get("resets_at")
                    .and_then(Value::as_str)
                    .map(String::from),
            })
        })
        .collect()
}

fn cached_claude(token: &str, max_age_ms: Option<i64>) -> Option<ClaudeUsage> {
    let mut guard = CLAUDE_CACHE.lock().ok()?;
    let usage = match guard.as_ref() {
        Some((cached_token, usage)) if cached_token == token => usage.clone(),
        // Memory miss (fresh process) — warm from the disk cache.
        _ => {
            let usage = claude_disk_cache_path().and_then(|p| load_disk_claude_from(&p, token))?;
            *guard = Some((token.to_string(), usage.clone()));
            usage
        }
    };
    if let Some(max_age) = max_age_ms {
        if now_ms() - usage.fetched_at > max_age {
            return None;
        }
    }
    Some(usage)
}

/// Epoch-ms until which the token is under a 429 penalty, if any.
fn claude_throttled_until(token: &str) -> Option<i64> {
    let guard = CLAUDE_THROTTLE.lock().ok()?;
    match guard.as_ref() {
        Some((throttled_token, until)) if throttled_token == token && *until > now_ms() => {
            Some(*until)
        }
        _ => None,
    }
}

#[tauri::command]
pub async fn usage_fetch_claude() -> Result<ClaudeUsage, String> {
    let creds = load_claude_creds().await?;

    if let Some(fresh) = cached_claude(&creds.access_token, Some(CLAUDE_CACHE_TTL_MS)) {
        return Ok(fresh);
    }
    // Under a 429 penalty the server counts down a fixed window; requests
    // during it are wasted, so skip the network entirely until it lapses.
    // The sentinel carries the deadline for the frontend's countdown.
    if let Some(until) = claude_throttled_until(&creds.access_token) {
        return cached_claude(&creds.access_token, None)
            .ok_or_else(|| format!("rate-limited:{until}"));
    }
    if creds.expires_at_ms <= now_ms() {
        return Err("token-expired".to_string());
    }
    // Recent Claude Code credentials may be inference-only. Anthropic's
    // undocumented usage endpoint rejects those grants with a 403 requiring
    // user:profile, so avoid a network request that cannot succeed.
    if !creds.scopes.is_empty() && !creds.scopes.iter().any(|scope| scope == "user:profile") {
        return Err("usage-scope-missing".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "network-error".to_string())?;
    let response = client
        .get(CLAUDE_USAGE_URL)
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.0")
        .header("Content-Type", "application/json")
        .send()
        .await;

    // Any failure falls back to the last good payload (frontend shows its
    // age); error sentinels surface only when there is nothing to show.
    let stale = || cached_claude(&creds.access_token, None);

    let response = match response {
        Ok(r) => r,
        Err(_) => return stale().ok_or_else(|| "network-error".to_string()),
    };
    let status = response.status();
    if status.as_u16() == 429 {
        let retry_secs = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(CLAUDE_CACHE_TTL_MS / 1_000)
            .clamp(1, CLAUDE_RETRY_AFTER_MAX_S);
        let until = now_ms() + retry_secs * 1_000;
        if let Ok(mut guard) = CLAUDE_THROTTLE.lock() {
            *guard = Some((creds.access_token.clone(), until));
        }
        return stale().ok_or_else(|| format!("rate-limited:{until}"));
    }
    if status.as_u16() == 401 {
        return Err("token-expired".to_string());
    }
    if !status.is_success() {
        return stale().ok_or_else(|| format!("http-{}", status.as_u16()));
    }

    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return stale().ok_or_else(|| "network-error".to_string()),
    };

    let five_hour = window_from(body.get("five_hour"));
    let seven_day = window_from(body.get("seven_day"));
    let (Some(five_hour), Some(seven_day)) = (five_hour, seven_day) else {
        return stale().ok_or_else(|| "unexpected-response".to_string());
    };

    let extra_usage = body
        .get("extra_usage")
        .and_then(Value::as_object)
        .map(|o| ExtraUsage {
            is_enabled: o
                .get("is_enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            monthly_limit: o.get("monthly_limit").and_then(Value::as_f64),
            used_credits: o.get("used_credits").and_then(Value::as_f64),
            utilization: o.get("utilization").and_then(Value::as_f64),
        });

    // A scoped entry supersedes the matching legacy top-level window — the
    // server may report both during the transition; don't render it twice.
    let weekly_scoped = scoped_windows_from(body.get("limits"));
    let scoped_has = |model: &str| {
        weekly_scoped
            .iter()
            .any(|w| w.name.eq_ignore_ascii_case(model))
    };

    let usage = ClaudeUsage {
        five_hour,
        seven_day,
        seven_day_opus: window_from(body.get("seven_day_opus")).filter(|_| !scoped_has("opus")),
        seven_day_sonnet: window_from(body.get("seven_day_sonnet"))
            .filter(|_| !scoped_has("sonnet")),
        weekly_scoped,
        extra_usage,
        subscription_type: creds.subscription_type,
        rate_limit_tier: creds.rate_limit_tier,
        fetched_at: now_ms(),
    };

    if let Some(path) = claude_disk_cache_path() {
        store_disk_claude_to(&path, &creds.access_token, &usage);
    }
    if let Ok(mut guard) = CLAUDE_CACHE.lock() {
        *guard = Some((creds.access_token, usage.clone()));
    }
    Ok(usage)
}

// ─── Codex rollout scanner ───────────────────────────────────────────────────

fn codex_sessions_dir() -> Option<PathBuf> {
    let home = std::env::var("CODEX_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))?;
    let sessions = home.join("sessions");
    sessions.is_dir().then_some(sessions)
}

/// Newest-first rollout files. Layout is sessions/YYYY/MM/DD/rollout-*.jsonl
/// with lexically sortable names, so path order is chronological order.
fn newest_rollout_files(sessions: &PathBuf, limit: usize) -> Vec<PathBuf> {
    fn sorted_dirs_desc(dir: &PathBuf) -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.is_dir())
                    .collect()
            })
            .unwrap_or_default();
        entries.sort();
        entries.reverse();
        entries
    }

    let mut files = Vec::new();
    'outer: for year in sorted_dirs_desc(sessions) {
        for month in sorted_dirs_desc(&year) {
            for day in sorted_dirs_desc(&month) {
                let mut day_files: Vec<PathBuf> = std::fs::read_dir(&day)
                    .map(|rd| {
                        rd.filter_map(|e| e.ok().map(|e| e.path()))
                            .filter(|p| {
                                p.extension().is_some_and(|x| x == "jsonl")
                                    && p.file_name()
                                        .and_then(|n| n.to_str())
                                        .is_some_and(|n| n.starts_with("rollout-"))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                day_files.sort();
                day_files.reverse();
                for f in day_files {
                    files.push(f);
                    if files.len() >= limit {
                        break 'outer;
                    }
                }
            }
        }
    }
    files
}

fn codex_window_from(v: Option<&Value>, event_epoch_s: i64) -> Option<CodexWindow> {
    let obj = v?.as_object()?;
    let used_percent = obj.get("used_percent").and_then(Value::as_f64)?;
    let window_minutes = obj.get("window_minutes").and_then(Value::as_u64)?;
    // Newer codex builds emit absolute `resets_at` (epoch s); older builds
    // emit `resets_in_seconds` relative to the event time.
    let resets_at = obj.get("resets_at").and_then(Value::as_i64).or_else(|| {
        obj.get("resets_in_seconds")
            .and_then(Value::as_i64)
            .map(|rel| event_epoch_s + rel)
    })?;
    Some(CodexWindow {
        used_percent,
        window_minutes,
        resets_at,
    })
}

fn scan_rollout_file(path: &PathBuf) -> Option<CodexUsage> {
    let raw = std::fs::read_to_string(path).ok()?;
    for line in raw.lines().rev() {
        // Cheap pre-filter before paying for JSON parsing.
        if !line.contains("\"token_count\"") || !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = event.get("payload")?;
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let rate_limits = payload.get("rate_limits");
        let Some(rl) = rate_limits.filter(|v| !v.is_null()) else {
            continue; // `codex exec` writes rate_limits: null — keep looking
        };
        let observed_at = event
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let event_epoch_s = chrono_free_epoch(&observed_at).unwrap_or_else(|| now_ms() / 1000);
        let primary = codex_window_from(rl.get("primary"), event_epoch_s);
        let secondary = codex_window_from(rl.get("secondary"), event_epoch_s);
        if primary.is_none() && secondary.is_none() {
            continue;
        }
        return Some(CodexUsage {
            primary,
            secondary,
            plan_type: rl
                .get("plan_type")
                .and_then(Value::as_str)
                .map(String::from),
            observed_at,
            session_file: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    None
}

/// Parse "2026-06-10T05:03:41.492Z" to epoch seconds without a chrono dep.
/// Days-from-civil algorithm (Howard Hinnant), valid for all dates of interest.
fn chrono_free_epoch(iso: &str) -> Option<i64> {
    let date = iso.get(0..10)?;
    let time = iso.get(11..19)?;
    let mut dp = date.split('-');
    let (y, m, d): (i64, i64, i64) = (
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
    );
    let mut tp = time.split(':');
    let (hh, mm, ss): (i64, i64, i64) = (
        tp.next()?.parse().ok()?,
        tp.next()?.parse().ok()?,
        tp.next()?.parse().ok()?,
    );
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3_600 + mm * 60 + ss)
}

#[tauri::command]
pub fn usage_fetch_codex() -> Result<CodexUsage, String> {
    let sessions = codex_sessions_dir().ok_or_else(|| "not-connected".to_string())?;
    for file in newest_rollout_files(&sessions, CODEX_MAX_FILES) {
        if let Some(usage) = scan_rollout_file(&file) {
            return Ok(usage);
        }
    }
    Err("no-recent-data".to_string())
}

// ─── Copilot quota fetch ─────────────────────────────────────────────────────

static COPILOT_CACHE: Mutex<Option<(String, CopilotUsage)>> = Mutex::new(None);

/// OAuth token from ~/.config/github-copilot/apps.json (current) or
/// hosts.json (older Copilot installs). Both map app/host keys to
/// `{ "oauth_token": ... }`.
fn load_copilot_token() -> Option<String> {
    let config = dirs::home_dir()?.join(".config/github-copilot");
    for name in ["apps.json", "hosts.json"] {
        let Ok(raw) = std::fs::read_to_string(config.join(name)) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(obj) = v.as_object() else { continue };
        for entry in obj.values() {
            if let Some(token) = entry.get("oauth_token").and_then(Value::as_str) {
                return Some(token.to_string());
            }
        }
    }
    None
}

fn copilot_quota_from(v: Option<&Value>) -> Option<CopilotQuota> {
    let obj = v?.as_object()?;
    let percent_remaining = obj.get("percent_remaining").and_then(Value::as_f64)?;
    Some(CopilotQuota {
        used_percent: (100.0 - percent_remaining).clamp(0.0, 100.0),
        remaining: obj
            .get("quota_remaining")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        entitlement: obj
            .get("entitlement")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        unlimited: obj
            .get("unlimited")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn parse_copilot_usage(body: &Value, fetched_at: i64) -> Option<CopilotUsage> {
    let snapshots = body.get("quota_snapshots")?;
    let premium = copilot_quota_from(snapshots.get("premium_interactions"));
    let chat = copilot_quota_from(snapshots.get("chat"));
    let completions = copilot_quota_from(snapshots.get("completions"));
    if premium.is_none() && chat.is_none() && completions.is_none() {
        return None;
    }
    Some(CopilotUsage {
        premium,
        chat,
        completions,
        plan: body
            .get("copilot_plan")
            .and_then(Value::as_str)
            .map(String::from),
        reset_date: body
            .get("quota_reset_date")
            .and_then(Value::as_str)
            .map(String::from),
        fetched_at,
    })
}

fn cached_copilot(token: &str, max_age_ms: Option<i64>) -> Option<CopilotUsage> {
    let guard = COPILOT_CACHE.lock().ok()?;
    let (cached_token, usage) = guard.as_ref()?;
    if cached_token != token {
        return None;
    }
    if let Some(max_age) = max_age_ms {
        if now_ms() - usage.fetched_at > max_age {
            return None;
        }
    }
    Some(usage.clone())
}

#[tauri::command]
pub async fn usage_fetch_copilot() -> Result<CopilotUsage, String> {
    let token = load_copilot_token().ok_or_else(|| "not-connected".to_string())?;

    if let Some(fresh) = cached_copilot(&token, Some(CLAUDE_CACHE_TTL_MS)) {
        return Ok(fresh);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "network-error".to_string())?;
    let response = client
        .get("https://api.github.com/copilot_internal/user")
        .header("Authorization", format!("token {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", "GitHubCopilotChat/0.26.7")
        .send()
        .await;

    let stale = || cached_copilot(&token, None);

    let response = match response {
        Ok(r) => r,
        Err(_) => return stale().ok_or_else(|| "network-error".to_string()),
    };
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("token-expired".to_string());
    }
    if !status.is_success() {
        return stale().ok_or_else(|| format!("http-{}", status.as_u16()));
    }
    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return stale().ok_or_else(|| "network-error".to_string()),
    };

    let Some(usage) = parse_copilot_usage(&body, now_ms()) else {
        return stale().ok_or_else(|| "unexpected-response".to_string());
    };
    if let Ok(mut guard) = COPILOT_CACHE.lock() {
        *guard = Some((token, usage.clone()));
    }
    Ok(usage)
}

// ─── Cursor usage fetch ──────────────────────────────────────────────────────

static CURSOR_CACHE: Mutex<Option<(String, CursorUsage)>> = Mutex::new(None);

struct CursorCreds {
    jwt: String,
    email: Option<String>,
}

/// cursor-agent keeps its auth info in ~/.cursor/cli-config.json and
/// the access-token JWT in the macOS Keychain (service "cursor-access-token").
async fn load_cursor_creds() -> Option<CursorCreds> {
    let raw = std::fs::read_to_string(dirs::home_dir()?.join(".cursor/cli-config.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let auth = v.get("authInfo")?;
    // Presence of a numeric userId distinguishes a real login from a stale
    // config; the id itself is only needed by the legacy cookie endpoint.
    auth.get("userId").and_then(Value::as_i64)?;
    let email = auth.get("email").and_then(Value::as_str).map(String::from);

    #[cfg(target_os = "macos")]
    {
        let cmd = tokio::process::Command::new("security")
            .args(["find-generic-password", "-s", "cursor-access-token", "-w"])
            .output();
        if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(2), cmd).await {
            if out.status.success() {
                let jwt = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !jwt.is_empty() {
                    return Some(CursorCreds { jwt, email });
                }
            }
        }
    }
    None
}

fn parse_cursor_usage(body: &Value, email: Option<String>, fetched_at: i64) -> CursorUsage {
    let plan = body.get("planUsage");
    // Spend values arrive in cents (verified against the standard $20.00
    // Pro included allowance).
    let dollars = |k: &str| {
        plan.and_then(|p| p.get(k))
            .and_then(Value::as_f64)
            .map(|cents| cents / 100.0)
    };
    // Billing-cycle bounds are epoch ms encoded as JSON strings.
    let epoch_ms = |k: &str| {
        body.get(k).and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
        })
    };
    CursorUsage {
        total_percent_used: plan
            .and_then(|p| p.get("totalPercentUsed"))
            .and_then(Value::as_f64),
        total_spend: dollars("totalSpend"),
        included_spend: dollars("includedSpend"),
        bonus_spend: dollars("bonusSpend"),
        limit_spend: dollars("limit"),
        cycle_start: epoch_ms("billingCycleStart"),
        cycle_end: epoch_ms("billingCycleEnd"),
        // The RPC carries no request counters; these stay as a fallback
        // slot for legacy request-capped plans.
        requests_used: None,
        requests_limit: None,
        email,
        fetched_at,
    }
}

fn cached_cursor(jwt: &str, max_age_ms: Option<i64>) -> Option<CursorUsage> {
    let guard = CURSOR_CACHE.lock().ok()?;
    let (cached_jwt, usage) = guard.as_ref()?;
    if cached_jwt != jwt {
        return None;
    }
    if let Some(max_age) = max_age_ms {
        if now_ms() - usage.fetched_at > max_age {
            return None;
        }
    }
    Some(usage.clone())
}

#[tauri::command]
pub async fn usage_fetch_cursor() -> Result<CursorUsage, String> {
    let creds = load_cursor_creds()
        .await
        .ok_or_else(|| "not-connected".to_string())?;

    if let Some(fresh) = cached_cursor(&creds.jwt, Some(CLAUDE_CACHE_TTL_MS)) {
        return Ok(fresh);
    }

    // Dashboard usage RPC (Connect protocol) — same data Cursor's own
    // dashboard renders, and it accepts the CLI's Keychain JWT directly.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "network-error".to_string())?;
    let response = client
        .post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage")
        .header("Authorization", format!("Bearer {}", creds.jwt))
        .header("Connect-Protocol-Version", "1")
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await;

    let stale = || cached_cursor(&creds.jwt, None);

    let response = match response {
        Ok(r) => r,
        Err(_) => return stale().ok_or_else(|| "network-error".to_string()),
    };
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("token-expired".to_string());
    }
    if !status.is_success() {
        return stale().ok_or_else(|| format!("http-{}", status.as_u16()));
    }
    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return stale().ok_or_else(|| "network-error".to_string()),
    };

    let usage = parse_cursor_usage(&body, creds.email, now_ms());
    if let Ok(mut guard) = CURSOR_CACHE.lock() {
        *guard = Some((creds.jwt, usage.clone()));
    }
    Ok(usage)
}

// ─── Grok usage fetch ────────────────────────────────────────────────────────

static GROK_CACHE: Mutex<Option<(String, GrokUsage)>> = Mutex::new(None);

struct GrokCreds {
    access_token: String,
    expires_at_ms: i64,
    email: Option<String>,
    tier: Option<String>,
}

/// Decode the JWT payload segment (base64url, no padding) and render the
/// `tier` claim as "tier N" for the widget meta line. Best-effort — any parse
/// failure yields None (the token is still used for the request).
fn jwt_tier(jwt: &str) -> Option<String> {
    use base64::Engine;
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    let tier = claims.get("tier").and_then(Value::as_i64)?;
    Some(format!("tier {tier}"))
}

/// The `grok` CLI stores OAuth creds in ~/.grok/auth.json — an object keyed by
/// "<issuer>::<client_id>", each value carrying `key` (JWT access token),
/// `expires_at` (ISO-8601), and `email`. File-only; no Keychain (unlike
/// Claude/Cursor). When several entries exist, keep the one expiring latest.
fn load_grok_creds() -> Result<GrokCreds, String> {
    let home = dirs::home_dir().ok_or_else(|| "not-connected".to_string())?;
    let raw = std::fs::read_to_string(home.join(".grok/auth.json"))
        .map_err(|_| "not-connected".to_string())?;
    let v: Value = serde_json::from_str(&raw).map_err(|_| "not-connected".to_string())?;
    let entries = v.as_object().ok_or_else(|| "not-connected".to_string())?;

    let mut best: Option<GrokCreds> = None;
    for entry in entries.values() {
        let Some(token) = entry
            .get("key")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        else {
            continue;
        };
        let expires_at_ms = entry
            .get("expires_at")
            .and_then(Value::as_str)
            .and_then(chrono_free_epoch)
            .map(|s| s * 1_000)
            .unwrap_or(0);
        let candidate = GrokCreds {
            access_token: token.to_string(),
            expires_at_ms,
            email: entry.get("email").and_then(Value::as_str).map(String::from),
            tier: jwt_tier(token),
        };
        best = match best {
            Some(b) if b.expires_at_ms >= candidate.expires_at_ms => Some(b),
            _ => Some(candidate),
        };
    }
    best.ok_or_else(|| "not-connected".to_string())
}

/// Parse the `config` object of the billing response. Each amount is wrapped
/// as `{ "val": N }`; period bounds are ISO-8601 strings.
fn parse_grok_usage(
    body: &Value,
    tier: Option<String>,
    email: Option<String>,
    fetched_at: i64,
) -> GrokUsage {
    let config = body.get("config");
    let val = |k: &str| {
        config
            .and_then(|c| c.get(k))
            .and_then(|v| v.get("val"))
            .and_then(Value::as_f64)
    };
    let epoch_ms = |k: &str| {
        config
            .and_then(|c| c.get(k))
            .and_then(Value::as_str)
            .and_then(chrono_free_epoch)
            .map(|s| s * 1_000)
    };
    GrokUsage {
        used: val("used"),
        monthly_limit: val("monthlyLimit"),
        on_demand_cap: val("onDemandCap"),
        on_demand_used: val("onDemandUsed"),
        period_start: epoch_ms("billingPeriodStart"),
        period_end: epoch_ms("billingPeriodEnd"),
        tier,
        email,
        fetched_at,
    }
}

fn grok_disk_cache_path() -> Option<PathBuf> {
    Some(dirs::cache_dir()?.join("krypton/grok-usage.json"))
}

fn load_disk_grok_from(path: &PathBuf, token: &str) -> Option<GrokUsage> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    if v.get("tokenFingerprint")?.as_str()? != token_fingerprint(token) {
        return None;
    }
    serde_json::from_value(v.get("usage")?.clone()).ok()
}

fn store_disk_grok_to(path: &PathBuf, token: &str, usage: &GrokUsage) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let payload = serde_json::json!({
        "tokenFingerprint": token_fingerprint(token),
        "usage": usage,
    });
    let _ = std::fs::write(path, payload.to_string());
}

fn cached_grok(token: &str, max_age_ms: Option<i64>) -> Option<GrokUsage> {
    let mut guard = GROK_CACHE.lock().ok()?;
    let usage = match guard.as_ref() {
        Some((cached_token, usage)) if cached_token == token => usage.clone(),
        // Memory miss (fresh process) — warm from the disk cache.
        _ => {
            let usage = grok_disk_cache_path().and_then(|p| load_disk_grok_from(&p, token))?;
            *guard = Some((token.to_string(), usage.clone()));
            usage
        }
    };
    if let Some(max_age) = max_age_ms {
        if now_ms() - usage.fetched_at > max_age {
            return None;
        }
    }
    Some(usage)
}

#[tauri::command]
pub async fn usage_fetch_grok() -> Result<GrokUsage, String> {
    let creds = load_grok_creds()?;

    if let Some(fresh) = cached_grok(&creds.access_token, Some(CLAUDE_CACHE_TTL_MS)) {
        return Ok(fresh);
    }
    // A locally-known-expired token can't succeed; the grok CLI owns refresh,
    // so surface the state instead of spending a request that 401s.
    if creds.expires_at_ms > 0 && creds.expires_at_ms <= now_ms() {
        return Err("token-expired".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "network-error".to_string())?;
    let response = client
        .get(GROK_USAGE_URL)
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("x-grok-client-version", GROK_CLIENT_VERSION)
        .send()
        .await;

    // Any failure falls back to the last good payload (frontend shows its age).
    let stale = || cached_grok(&creds.access_token, None);

    let response = match response {
        Ok(r) => r,
        Err(_) => return stale().ok_or_else(|| "network-error".to_string()),
    };
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("token-expired".to_string());
    }
    if !status.is_success() {
        return stale().ok_or_else(|| format!("http-{}", status.as_u16()));
    }
    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(_) => return stale().ok_or_else(|| "network-error".to_string()),
    };

    let usage = parse_grok_usage(&body, creds.tier, creds.email, now_ms());
    if let Some(path) = grok_disk_cache_path() {
        store_disk_grok_to(&path, &creds.access_token, &usage);
    }
    if let Ok(mut guard) = GROK_CACHE.lock() {
        *guard = Some((creds.access_token, usage.clone()));
    }
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_timestamp_to_epoch() {
        // 2026-06-10T05:03:41Z — cross-checked with date(1)
        assert_eq!(
            chrono_free_epoch("2026-06-10T05:03:41.492Z"),
            Some(1781067821)
        );
        // Unix epoch sanity
        assert_eq!(chrono_free_epoch("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(chrono_free_epoch("garbage"), None);
    }

    #[test]
    fn parses_grok_billing_config() {
        // Live shape from cli-chat-proxy.grok.com/v1/billing (2026-07-09).
        let body: Value = serde_json::from_str(
            r#"{"config":{"monthlyLimit":{"val":4000},"used":{"val":14},"onDemandCap":{"val":0},"billingPeriodStart":"2026-07-01T00:00:00+00:00","billingPeriodEnd":"2026-08-01T00:00:00+00:00"}}"#,
        )
        .expect("valid json");
        let u = parse_grok_usage(&body, Some("tier 3".into()), Some("a@b.co".into()), 1_000);
        assert_eq!(u.used, Some(14.0));
        assert_eq!(u.monthly_limit, Some(4000.0));
        assert_eq!(u.on_demand_cap, Some(0.0));
        assert_eq!(u.on_demand_used, None);
        // 2026-08-01T00:00:00Z → epoch ms
        assert_eq!(u.period_end, Some(1_785_542_400_000));
        assert_eq!(u.tier.as_deref(), Some("tier 3"));
        assert_eq!(u.fetched_at, 1_000);
    }

    #[test]
    fn grok_credits_shape_has_no_gauge_numbers() {
        // `?format=credits` shape carries a period window but no used/limit,
        // so the frontend draws no gauge.
        let body: Value = serde_json::from_str(
            r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY"},"onDemandCap":{"val":0},"isUnifiedBillingUser":true}}"#,
        )
        .expect("valid json");
        let u = parse_grok_usage(&body, None, None, 0);
        assert_eq!(u.used, None);
        assert_eq!(u.monthly_limit, None);
    }

    #[test]
    fn decodes_jwt_tier_claim() {
        // header.payload.signature — payload is base64url(no-pad) of {"tier":3}.
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"tier":3}"#);
        let jwt = format!("aGVhZGVy.{payload}.c2ln");
        assert_eq!(jwt_tier(&jwt).as_deref(), Some("tier 3"));
        assert_eq!(jwt_tier("not-a-jwt"), None);
    }

    #[test]
    fn parses_codex_token_count_event() {
        let line = r#"{"timestamp":"2026-06-10T05:03:41.492Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":524637}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":3.0,"window_minutes":300,"resets_at":1781076474},"secondary":{"used_percent":34.0,"window_minutes":10080,"resets_at":1781141354},"credits":null,"plan_type":"plus","rate_limit_reached_type":null}}}"#;
        let dir = std::env::temp_dir().join("krypton-usage-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("rollout-2026-06-10T05-03-41-test.jsonl");
        std::fs::write(&path, format!("{line}\n")).expect("write fixture");

        let usage = scan_rollout_file(&path).expect("should parse");
        let primary = usage.primary.expect("primary window");
        assert_eq!(primary.used_percent, 3.0);
        assert_eq!(primary.window_minutes, 300);
        assert_eq!(primary.resets_at, 1781076474);
        let secondary = usage.secondary.expect("secondary window");
        assert_eq!(secondary.window_minutes, 10080);
        assert_eq!(usage.plan_type.as_deref(), Some("plus"));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn skips_null_rate_limits() {
        let lines = concat!(
            r#"{"timestamp":"2026-06-10T05:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{},"rate_limits":{"primary":{"used_percent":7.0,"window_minutes":300,"resets_at":1781076000},"secondary":null,"plan_type":"plus"}}}"#,
            "\n",
            r#"{"timestamp":"2026-06-10T05:03:41.492Z","type":"event_msg","payload":{"type":"token_count","info":{},"rate_limits":null}}"#,
            "\n",
        );
        let dir = std::env::temp_dir().join("krypton-usage-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("rollout-2026-06-10T05-00-00-null.jsonl");
        std::fs::write(&path, lines).expect("write fixture");

        // Latest event has rate_limits: null — scanner must fall back to the
        // earlier event in the same file.
        let usage = scan_rollout_file(&path).expect("should parse earlier event");
        assert_eq!(usage.primary.expect("primary").used_percent, 7.0);
        assert!(usage.secondary.is_none());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn fresher_credentials_win() {
        let creds = |exp: i64| ClaudeCreds {
            access_token: format!("tok-{exp}"),
            expires_at_ms: exp,
            scopes: Vec::new(),
            subscription_type: None,
            rate_limit_tier: None,
        };
        // Stale file first, fresh keychain second → keychain wins.
        let best = pick_fresher(None, creds(100));
        let best = pick_fresher(best, creds(200));
        assert_eq!(best.expect("some").access_token, "tok-200");
        // Fresh file first, stale keychain second → file kept.
        let best = pick_fresher(None, creds(300));
        let best = pick_fresher(best, creds(250));
        assert_eq!(best.expect("some").access_token, "tok-300");
    }

    #[test]
    fn parses_copilot_quota_snapshots() {
        let body: Value = serde_json::from_str(
            r#"{"copilot_plan":"individual","quota_reset_date":"2026-07-01","quota_snapshots":{
                "chat":{"percent_remaining":82.7,"quota_remaining":165.5,"entitlement":200,"unlimited":false},
                "completions":{"percent_remaining":100.0,"quota_remaining":2000.0,"entitlement":2000,"unlimited":false},
                "premium_interactions":{"percent_remaining":0.0,"quota_remaining":0.0,"entitlement":300,"unlimited":false}}}"#,
        )
        .expect("fixture json");
        let usage = parse_copilot_usage(&body, 42).expect("should parse");
        assert_eq!(usage.plan.as_deref(), Some("individual"));
        assert_eq!(usage.reset_date.as_deref(), Some("2026-07-01"));
        let premium = usage.premium.expect("premium");
        assert_eq!(premium.used_percent, 100.0);
        assert_eq!(premium.entitlement, 300.0);
        let chat = usage.chat.expect("chat");
        assert!((chat.used_percent - 17.3).abs() < 0.001);
        assert_eq!(usage.completions.expect("completions").used_percent, 0.0);
    }

    #[test]
    fn cursor_plan_usage_parses_cents_and_cycle_strings() {
        // Live GetCurrentPeriodUsage shape captured 2026-06-10: spend in
        // cents, billing-cycle bounds as string epoch ms.
        let modern: Value = serde_json::from_str(
            r#"{"billingCycleStart":"1779376355000","billingCycleEnd":"1782054755000",
                "planUsage":{"totalSpend":5052,"includedSpend":2000,"bonusSpend":3052,
                "limit":2000,"remainingBonus":false,"autoPercentUsed":22.45,
                "apiPercentUsed":0,"totalPercentUsed":18.71},"enabled":true}"#,
        )
        .expect("fixture json");
        let usage = parse_cursor_usage(&modern, Some("a@b.c".into()), 42);
        assert_eq!(usage.total_percent_used, Some(18.71));
        assert_eq!(usage.total_spend, Some(50.52));
        assert_eq!(usage.included_spend, Some(20.0));
        assert_eq!(usage.bonus_spend, Some(30.52));
        assert_eq!(usage.limit_spend, Some(20.0));
        assert_eq!(usage.cycle_start, Some(1779376355000));
        assert_eq!(usage.cycle_end, Some(1782054755000));
        assert!(usage.requests_used.is_none());
        assert!(usage.requests_limit.is_none());
        assert_eq!(usage.email.as_deref(), Some("a@b.c"));

        // No planUsage (e.g. account without usage-based pricing) → all
        // spend fields None; the widget falls back to "not exposed".
        let empty: Value = serde_json::from_str(r#"{"enabled":false}"#).expect("fixture json");
        let usage = parse_cursor_usage(&empty, None, 42);
        assert!(usage.total_percent_used.is_none());
        assert!(usage.total_spend.is_none());
        assert!(usage.cycle_end.is_none());
    }

    #[test]
    fn disk_cache_roundtrips_and_rejects_other_tokens() {
        let usage = ClaudeUsage {
            five_hour: UsageWindow {
                utilization: 42.0,
                resets_at: Some("2026-06-10T18:00:00Z".into()),
            },
            seven_day: UsageWindow {
                utilization: 80.5,
                resets_at: None,
            },
            seven_day_opus: None,
            seven_day_sonnet: None,
            weekly_scoped: vec![ScopedUsageWindow {
                name: "Fable".into(),
                utilization: 79.0,
                resets_at: Some("2026-07-07T16:00:00Z".into()),
            }],
            extra_usage: None,
            subscription_type: Some("team".into()),
            rate_limit_tier: None,
            fetched_at: 1_781_100_000_000,
        };
        let dir = std::env::temp_dir().join("krypton-usage-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("claude-usage.json");

        store_disk_claude_to(&path, "tok-a", &usage);
        let loaded = load_disk_claude_from(&path, "tok-a").expect("should load");
        assert_eq!(loaded.five_hour.utilization, 42.0);
        assert_eq!(loaded.seven_day.utilization, 80.5);
        assert_eq!(loaded.fetched_at, 1_781_100_000_000);
        assert_eq!(loaded.subscription_type.as_deref(), Some("team"));
        assert_eq!(loaded.weekly_scoped.len(), 1);
        assert_eq!(loaded.weekly_scoped[0].name, "Fable");
        assert_eq!(loaded.weekly_scoped[0].utilization, 79.0);
        // A different token must not see the cached payload.
        assert!(load_disk_claude_from(&path, "tok-b").is_none());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn disk_cache_from_before_weekly_scoped_still_loads() {
        let dir = std::env::temp_dir().join("krypton-usage-test-legacy");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("claude-usage.json");
        // Payload shape written before spec 187 — no weeklyScoped key.
        let legacy = serde_json::json!({
            "tokenFingerprint": token_fingerprint("tok-a"),
            "usage": {
                "fiveHour": { "utilization": 10.0, "resetsAt": null },
                "sevenDay": { "utilization": 20.0, "resetsAt": null },
                "sevenDayOpus": null,
                "sevenDaySonnet": null,
                "extraUsage": null,
                "subscriptionType": null,
                "rateLimitTier": null,
                "fetchedAt": 1_781_100_000_000i64,
            },
        });
        std::fs::write(&path, legacy.to_string()).expect("write legacy cache");

        let loaded = load_disk_claude_from(&path, "tok-a").expect("should load");
        assert!(loaded.weekly_scoped.is_empty());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn parses_weekly_scoped_limits() {
        // Redacted live /api/oauth/usage shape (2026-07-05): session and
        // weekly_all repeat the top-level windows; the Fable bucket only
        // exists here. Surface-scoped and model-less entries are skipped.
        let body: Value = serde_json::json!({
            "limits": [
                { "kind": "session", "group": "session", "percent": 14,
                  "resets_at": "2026-07-05T12:50:00Z", "scope": null },
                { "kind": "weekly_all", "group": "weekly", "percent": 47,
                  "resets_at": "2026-07-07T16:00:00Z", "scope": null },
                { "kind": "weekly_scoped", "group": "weekly", "percent": 79,
                  "severity": "warning", "resets_at": "2026-07-07T16:00:00Z",
                  "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
                  "is_active": true },
                { "kind": "weekly_scoped", "group": "weekly", "percent": 12,
                  "resets_at": null,
                  "scope": { "model": null, "surface": "cowork" } },
                { "kind": "weekly_scoped", "group": "weekly", "percent": 5,
                  "scope": { "model": { "display_name": "  " } } }
            ]
        });
        let scoped = scoped_windows_from(body.get("limits"));
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].name, "Fable");
        assert_eq!(scoped[0].utilization, 79.0);
        assert_eq!(scoped[0].resets_at.as_deref(), Some("2026-07-07T16:00:00Z"));

        assert!(scoped_windows_from(None).is_empty());
        assert!(scoped_windows_from(Some(&Value::Null)).is_empty());
    }

    #[test]
    fn parses_credentials_shape() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":1780940991388,"scopes":["user:inference"],"subscriptionType":"team","rateLimitTier":"default_claude_max_5x"}}"#;
        let creds = parse_claude_creds(raw).expect("should parse");
        assert_eq!(creds.access_token, "tok");
        assert_eq!(creds.expires_at_ms, 1780940991388);
        assert_eq!(creds.scopes, vec!["user:inference"]);
        assert_eq!(creds.subscription_type.as_deref(), Some("team"));
        assert_eq!(
            creds.rate_limit_tier.as_deref(),
            Some("default_claude_max_5x")
        );
    }
}
