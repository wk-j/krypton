// Krypton — Subscription credit usage (spec 151).
//
// Read-only providers:
//   - Claude: OAuth usage endpoint, authenticated with the token Claude Code
//     already maintains (~/.claude/.credentials.json, macOS Keychain fallback).
//     Responses are cached for 180 s per token to stay inside the endpoint's
//     safe polling cadence regardless of how many views poll.
//   - Codex: newest `token_count` event with a non-null `rate_limits` object
//     from the local rollout JSONL under ~/.codex/sessions (CODEX_HOME aware).
//
// Tokens are never logged and never leave this module except as the
// Authorization header to api.anthropic.com. Error strings are static
// sentinels — never raw HTTP bodies.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_CACHE_TTL_MS: i64 = 180_000;
const CODEX_MAX_FILES: usize = 10;

// ─── Payload types (camelCase over IPC) ─────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: Option<f64>,
    pub used_credits: Option<f64>,
    pub utilization: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
    pub seven_day_opus: Option<UsageWindow>,
    pub seven_day_sonnet: Option<UsageWindow>,
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

/// Cursor's CLI token only unlocks the legacy per-request counters, which are
/// null/zero on current plans — the dashboard quota APIs reject non-browser
/// sessions. The widget therefore mostly reports "connected, quota not
/// exposed"; the request gauge appears only for legacy request-based plans.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsage {
    pub requests_used: Option<f64>,
    pub requests_limit: Option<f64>,
    pub start_of_month: Option<String>,
    pub email: Option<String>,
    pub fetched_at: i64,
}

// ─── Claude credentials ─────────────────────────────────────────────────────

struct ClaudeCreds {
    access_token: String,
    expires_at_ms: i64,
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

fn cached_claude(token: &str, max_age_ms: Option<i64>) -> Option<ClaudeUsage> {
    let guard = CLAUDE_CACHE.lock().ok()?;
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
pub async fn usage_fetch_claude() -> Result<ClaudeUsage, String> {
    let creds = load_claude_creds().await?;

    if let Some(fresh) = cached_claude(&creds.access_token, Some(CLAUDE_CACHE_TTL_MS)) {
        return Ok(fresh);
    }
    if creds.expires_at_ms <= now_ms() {
        return Err("token-expired".to_string());
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
        return stale().ok_or_else(|| "rate-limited".to_string());
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

    let usage = ClaudeUsage {
        five_hour,
        seven_day,
        seven_day_opus: window_from(body.get("seven_day_opus")),
        seven_day_sonnet: window_from(body.get("seven_day_sonnet")),
        extra_usage,
        subscription_type: creds.subscription_type,
        rate_limit_tier: creds.rate_limit_tier,
        fetched_at: now_ms(),
    };

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
    user_id: i64,
    jwt: String,
    email: Option<String>,
}

/// cursor-agent keeps the numeric user id in ~/.cursor/cli-config.json and
/// the access-token JWT in the macOS Keychain (service "cursor-access-token").
async fn load_cursor_creds() -> Option<CursorCreds> {
    let raw = std::fs::read_to_string(dirs::home_dir()?.join(".cursor/cli-config.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let auth = v.get("authInfo")?;
    let user_id = auth.get("userId").and_then(Value::as_i64)?;
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
                    return Some(CursorCreds {
                        user_id,
                        jwt,
                        email,
                    });
                }
            }
        }
    }
    None
}

fn parse_cursor_usage(body: &Value, email: Option<String>, fetched_at: i64) -> CursorUsage {
    let gpt4 = body.get("gpt-4");
    let num = |k: &str| gpt4.and_then(|g| g.get(k)).and_then(Value::as_f64);
    // maxRequestUsage is null on current (usage-based) plans; the request
    // gauge only means something when the plan still has a request cap.
    let requests_limit = num("maxRequestUsage");
    CursorUsage {
        requests_used: requests_limit
            .is_some()
            .then(|| num("numRequests").unwrap_or(0.0)),
        requests_limit,
        start_of_month: body
            .get("startOfMonth")
            .and_then(Value::as_str)
            .map(String::from),
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

    // WorkosCursorSessionToken cookie format: "<userId>%3A%3A<jwt>".
    let cookie = format!(
        "WorkosCursorSessionToken={}%3A%3A{}",
        creds.user_id, creds.jwt
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "network-error".to_string())?;
    let response = client
        .get(format!(
            "https://cursor.com/api/usage?user={}",
            creds.user_id
        ))
        .header("Cookie", cookie)
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
    fn cursor_request_gauge_only_for_capped_plans() {
        // Current usage-based plan: maxRequestUsage null → no gauge data.
        let modern: Value = serde_json::from_str(
            r#"{"gpt-4":{"numRequests":0,"maxRequestUsage":null},"startOfMonth":"2026-05-21T15:12:35.000Z"}"#,
        )
        .expect("fixture json");
        let usage = parse_cursor_usage(&modern, Some("a@b.c".into()), 42);
        assert!(usage.requests_limit.is_none());
        assert!(usage.requests_used.is_none());
        assert_eq!(
            usage.start_of_month.as_deref(),
            Some("2026-05-21T15:12:35.000Z")
        );
        assert_eq!(usage.email.as_deref(), Some("a@b.c"));

        // Legacy request-capped plan: both sides present.
        let legacy: Value = serde_json::from_str(
            r#"{"gpt-4":{"numRequests":123,"maxRequestUsage":500},"startOfMonth":"2026-05-21T15:12:35.000Z"}"#,
        )
        .expect("fixture json");
        let usage = parse_cursor_usage(&legacy, None, 42);
        assert_eq!(usage.requests_used, Some(123.0));
        assert_eq!(usage.requests_limit, Some(500.0));
    }

    #[test]
    fn parses_credentials_shape() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":1780940991388,"subscriptionType":"team","rateLimitTier":"default_claude_max_5x"}}"#;
        let creds = parse_claude_creds(raw).expect("should parse");
        assert_eq!(creds.access_token, "tok");
        assert_eq!(creds.expires_at_ms, 1780940991388);
        assert_eq!(creds.subscription_type.as_deref(), Some("team"));
        assert_eq!(
            creds.rate_limit_tier.as_deref(),
            Some("default_claude_max_5x")
        );
    }
}
