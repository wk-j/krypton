# Subscription Credit Usage View — Implementation Spec

> Status: Implemented
> Date: 2026-06-10
> Milestone: ACP Harness — operational visibility

## Problem

Krypton users drive Claude and Codex lanes against *subscription* quotas (Claude Max 5-hour + weekly windows, ChatGPT Plus/Pro 5-hour + weekly windows), but the only way to see remaining credit is to leave Krypton and run `claude /usage` or `codex /status`. There is no in-app view of how close each provider account is to its limit.

## Solution

A new keyboard-summoned **content-view window** (`PaneContentType` `'usage'`, same pattern as the Vault/Diff/Hurl views) that renders per-provider utilization gauges. Data sources are provider-native and read-only:

- **Claude** — the OAuth usage endpoint (`GET https://api.anthropic.com/api/oauth/usage`), authenticated with the token Claude Code already maintains on this machine. Authoritative server-side window state (same data as `/usage`).
- **Codex** — the most recent `token_count` event with a non-null `rate_limits` object from the local rollout JSONL under `~/.codex/sessions/`. Snapshot as-of last Codex activity (Codex exposes no public usage API).
- **Copilot** (added post-implementation, user request) — `GET https://api.github.com/copilot_internal/user` with the `oauth_token` from `~/.config/github-copilot/apps.json` (or `hosts.json`); `quota_snapshots` carries `premium_interactions` / `chat` / `completions` with `percent_remaining`, `entitlement`, `unlimited`, plus `copilot_plan` and monthly `quota_reset_date`. Verified live on this machine.
- **Cursor** (added post-implementation, user request; endpoint upgraded by spec 152) — `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` with `Authorization: Bearer <jwt>` (JWT from macOS Keychain service `cursor-access-token`; `~/.cursor/cli-config.json` `authInfo` validates the login). Returns authoritative billing-cycle spend (`planUsage`: spend in cents, `totalPercentUsed`, cycle bounds) — the same data Cursor's own dashboard renders. The original `cursor.com/api/usage` request counters (null on usage-based plans) were replaced; the request gauge remains only as a fallback rendering slot for legacy capped plans, and "quota not exposed" is the final fallback when the RPC returns no `planUsage`. See `docs/152-cursor-real-usage.md`.
- **Grok** (added post-implementation, user request; spec 193) — `GET https://cli-chat-proxy.grok.com/v1/billing` with `Authorization: Bearer <token>` (JWT read from `~/.grok/auth.json`, the freshest issuer-keyed entry; no Keychain — Grok stores creds in a plain file). Returns the monthly credit balance (`config.used` / `config.monthlyLimit`, each `{ "val": N }`, plus billing-cycle bounds); the view draws a single `credits` gauge. Grok persists no rate-limit data locally, so this billing endpoint is the only pollable surface (the gateway's per-turn `RateLimitsUpdated` WS event is push-only). 180 s cache + disk-persist, same stale-fallback ladder; 401/403 → `token-expired`. See `docs/193-grok-usage-meter.md`.

Fetching/parsing lives in Rust `usage.rs`. Since spec 153, the shared frontend
`UsageStore` polls the commands on behalf of both the detailed view and visible
window-credit status segments. No token refresh or credential writes occur.

## Research

- **Claude OAuth usage endpoint** (undocumented, used by Claude-Code-Usage-Monitor et al.): requires `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, and `User-Agent: claude-code/<version>` (without the UA you land in an aggressively rate-limited bucket → persistent 429). Safe cadence ≈ 180 s per token. Response shape:
  `{ five_hour: { utilization: 0-100, resets_at: ISO8601 }, seven_day: {...}, seven_day_opus: {...}|null, seven_day_sonnet: {...}|null, extra_usage: { is_enabled, monthly_limit, used_credits, utilization } }`
- **Claude credentials**: `~/.claude/.credentials.json` → `claudeAiOauth: { accessToken, refreshToken, expiresAt(ms), subscriptionType, rateLimitTier }`, plus macOS Keychain item `Claude Code-credentials` (read via `security find-generic-password -s "Claude Code-credentials" -w`). **The file alone is not authoritative**: on this machine Claude Code keeps the live token in the Keychain while a stale `.credentials.json` lingers from an older version — the loader must read both and keep whichever expires later (Keychain consulted only when the file token is missing/expired, so steady-state polling never spawns `security`). Access tokens expire ~hourly; Claude Code (and the `claude-code-acp` adapter our lanes spawn) refreshes them as a side effect of running.
- **Codex rollout JSONL** (verified against a real session file on this machine, `~/.codex/sessions/2026/06/10/rollout-*.jsonl`): `event_msg` payloads of `type: "token_count"` carry
  `rate_limits: { primary: { used_percent, window_minutes: 300, resets_at(epoch s) }, secondary: { used_percent, window_minutes: 10080, resets_at }, plan_type, credits, rate_limit_reached_type }`
  plus `info.total_token_usage` / `info.model_context_window`. Caveat from upstream issues: `codex exec` (non-interactive) writes `rate_limits: null`, so the scanner must skip null entries and keep looking backwards/in older files.
- **Prior art in this codebase**: `UsageInfo` (`src/acp/types.ts:197`) already streams *per-turn token usage* through ACP events but says nothing about account quota — different layer; this spec deliberately does not touch it. Closest UI precedents: review-quality overlay (spec 146) for store/refresh patterns, and `VaultContentView` → `createContentTab()` (`compositor.ts:2064`, `2098`) for window-level content views — the user asked for a *window*, so the content-view pattern wins over a Leader overlay.
- **Ruled out**: getting quota over ACP (no such capability in the protocol); refreshing the OAuth token ourselves (rotation races against Claude Code's own refresh and could log the user out); shelling out to `claude`/`codex` CLIs (slow, parses TUI output); `@tauri-apps/plugin-http` (not installed; a plain Rust HTTP client is simpler).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code | `/usage` command: full-screen panel, bars for 5h / weekly / weekly-Opus with `resets at` labels | Source of truth; same endpoint this spec calls |
| Codex CLI | `/status`: text block with 5h + weekly percentages, plan tier | Only works inside an active session; snapshot |
| ccusage (OSS) | Parses `~/.claude/projects/**.jsonl` + `~/.codex/sessions/**.jsonl` for token/cost analytics; daily/blocks reports | Cost analytics, not live window state; CLI tables |
| Claude-Code-Usage-Monitor (OSS) | TUI polling the OAuth usage endpoint every ~180 s with progress bars + reset countdowns | Validates endpoint, headers, cadence |

**Krypton delta** — same gauge-style presentation as Claude Code `/usage` (familiarity), but: both providers side-by-side in one window; keyboard-summoned (`Leader $`) like every other Krypton view; live reset countdowns; Krypton Dark flat aesthetic (no nested cards, no left rails). Unlike ccusage we show *authoritative window state*, not reconstructed cost.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/usage.rs` | **New** — credential loading, OAuth usage fetch (180 s cache), codex rollout scanner |
| `src-tauri/src/lib.rs` | Register `usage_fetch_claude`, `usage_fetch_codex`; `mod usage;` |
| `src-tauri/Cargo.toml` | Add `reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }` |
| `src/usage-view.ts` | **New** — `UsageContentView implements ContentView` |
| `src/styles/usage-view.css` | **New** — gauges/layout (imported from `styles/main.css` like other view sheets) |
| `src/types.ts` | Add `'usage'` to `PaneContentType` |
| `src/compositor.ts` | `openUsageView()` → `createContentTab('USAGE // credits', view)` |
| `src/input-router.ts` | Compositor mode `$` → `openUsageView()` |
| `docs/PROGRESS.md`, `docs/04-architecture.md` | Doc sync per `/feature-implementation` |

## Design

### Data Structures (Rust, serde camelCase → TS mirrors)

```rust
struct UsageWindow { utilization: f64, resets_at: Option<String> }   // ISO 8601

struct ClaudeUsage {
    five_hour: UsageWindow,
    seven_day: UsageWindow,
    seven_day_opus: Option<UsageWindow>,
    seven_day_sonnet: Option<UsageWindow>,
    weekly_scoped: Vec<ScopedUsageWindow>,  // { name, utilization, resets_at } — model-scoped
                                            // weekly buckets from the `limits` array (spec 187,
                                            // e.g. Fable); renders as `week · <name>` gauges
    extra_usage: Option<ExtraUsage>,        // { is_enabled, monthly_limit, used_credits, utilization }
    subscription_type: Option<String>,      // from credentials: "team", "max", ...
    rate_limit_tier: Option<String>,        // "default_claude_max_5x"
    fetched_at: i64,                        // epoch ms (for cache-age display)
}

struct CodexWindow { used_percent: f64, window_minutes: u64, resets_at: i64 } // epoch s

struct CodexUsage {
    primary: Option<CodexWindow>,           // 5h (window_minutes 300)
    secondary: Option<CodexWindow>,         // weekly (10080)
    plan_type: Option<String>,              // "plus", "pro"
    observed_at: String,                    // timestamp of the JSONL event ("as of")
    session_file: String,                   // basename, for debugging display
}
```

### API / Commands

- `usage_fetch_claude() -> Result<ClaudeUsage, String>`
  1. Load credentials: `~/.claude/.credentials.json`; if missing on macOS, try `security find-generic-password -s "Claude Code-credentials" -w` (spawned process, 2 s timeout).
  2. If `expiresAt <= now` → `Err("token-expired")` (sentinel string; UI maps it to a hint).
  3. Serve from in-memory cache if `< 180 s` old (per-token); on a memory miss, warm from the disk cache (`<OS cache dir>/krypton/claude-usage.json`, keyed by a token hash — the token itself is never written) so app restarts don't cost a request. Otherwise GET the endpoint with the three required headers (`User-Agent: claude-code/2.0`) and a 10 s timeout.
  4. On 429 → honor `Retry-After` (capped at 1 h; one poll cycle if absent): no network until the penalty lapses (the server counts down a fixed window — requests during it are wasted). Keep serving cache; surface `Err("rate-limited:<epochMs>")` only if no cache exists, and the UI renders a live countdown from the deadline ("rate limited — retry in 28m").
- `usage_fetch_codex() -> Result<CodexUsage, String>`
  Walk `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` newest-first (by path order, limit ~10 files / 7 days), scan each file *backwards* for the last `token_count` with `rate_limits != null`. Pure local read, no cache needed. Honors `CODEX_HOME` env override.
- `usage_fetch_copilot() -> Result<CopilotUsage, String>` — token from `apps.json`/`hosts.json`, GET `copilot_internal/user`, 180 s cache, same stale-fallback ladder; 401/403 → `token-expired`.
- `usage_fetch_cursor() -> Result<CursorUsage, String>` — Keychain JWT (macOS only; elsewhere `not-connected`; login validated against `cli-config.json`), POST `api2.cursor.sh/.../GetCurrentPeriodUsage` (Connect protocol, `Bearer` auth), 180 s cache, same ladder (spec 152).
- `usage_fetch_grok() -> Result<GrokUsage, String>` — Bearer JWT from `~/.grok/auth.json` (freshest entry; `tier` decoded from the JWT `tier` claim for the meta line), GET `cli-chat-proxy.grok.com/v1/billing`, 180 s cache + disk-persist, same ladder; 401/403 → `token-expired` (spec 193).
- Commands are invoked on demand by the shared frontend UsageStore; no Tauri
  events or always-on backend tasks are introduced.

### Data Flow

```
1. User presses Leader (Cmd+P) then $
2. input-router → compositor.openUsageView() → new UsageContentView → createContentTab('USAGE // credits', view)
3. View invokes usage_fetch_claude + usage_fetch_codex in parallel (Promise.allSettled)
4. Rust: claude → credentials file/Keychain → cached-or-live GET api.anthropic.com/api/oauth/usage
         codex  → newest rollout JSONL → last non-null rate_limits event
5. View renders provider sections; per-provider errors render inline (one failing never blanks the other)
6. While the view exists, it subscribes all providers to the shared UsageStore;
   reset countdowns tick every 1 s (single interval, cleared in dispose())
7. 'r' forces a re-render + re-invoke (Claude still served from Rust cache if < 180 s — endpoint cadence is never violated)
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `$` | Compositor mode | Open usage view (`Shift+4`; mnemonic: money) |
| `r` | Usage view focused | Refresh now |

Window close/management via the existing tab/window keys (`Leader w`, etc.). Also exposed via `getPaletteActions()` (“Refresh usage”).

### UI

> Revised post-implementation at the user's request ("organize under widgets"): provider sections became flat widgets on a responsive grid.

One provider per **widget** — a single flat surface (full 1px border + background tint, dashboard-panel vocabulary; no inner boxes, no accent rails) on a `repeat(auto-fit, minmax(330px, 1fr))` grid: side by side in wide windows, stacked in narrow ones. BEM: `.krypton-usage`, `__widget`, `__head`, `__logo`, `__dot`, `__gauge`, `__bar`, `__foot`. Each widget head leads with the provider mark (`__logo`, accent-colored inline SVG; geometry mirrors the harness lane-rail `BACKEND_LOGO_SVG_DEFS` from spec 125, duplicated rather than imported so the usage chunk stays free of the harness module) and ends with a square status dot (green ok / amber stale / dim off) that is **always restated in words** by the widget's foot line (`live · updated 12s ago`, `stale · 3m — rate limited`, `as of 2m ago` for Codex) — color is never the sole signal. First fetch shows skeleton shimmer rows (static under `prefers-reduced-motion`). Percentages are bold `tabular-nums` and inherit the warn/critical color of their bar.

```
┌ ▪ CLAUDE              team · max_5x ┐  ┌ ▪ CODEX                       plus ┐
│ session 5h  ██░░░░░  7%  resets 1h38m│  │ session 5h  █░░░░░░  3%  resets 1h41m│
│ week        █░░░░░░  6%  resets 6d03h│  │ week        ███░░░░ 34%  resets 6d18h│
│ week·sonnet ░░░░░░░  0%              │  │                                      │
│ live · updated 12s ago               │  │ as of 2m ago                         │
└──────────────────────────────────────┘  └──────────────────────────────────────┘
```

- Bars are single-element flat fills (no stacked pseudo-element layers); fill and percentage shift color at ≥ 80 % (warn, `--krypton-warning-rgb`) and ≥ 95 % (critical, `--krypton-danger-rgb`); chrome labels in chrome font, numbers bold `tabular-nums`.
- Widget states (dot + foot text, always paired): **loading** (skeleton rows, “connecting…” / “reading sessions…”), **ok** (`live · updated Xs ago`; Codex says `as of X ago` since its snapshot is only as fresh as the last Codex activity), **stale** (last good gauges + amber foot `stale · Xm — <hint>`), **off** (no data: `not connected` / `token expired — open a Claude lane or run claude to refresh` / `no recent data — run codex once`).

### Configuration

None. Poll cadences are fixed (180 s / 60 s); provider sections appear by auto-detection.

## Edge Cases

- **No credentials anywhere** → Claude section shows “not connected”, view still opens for Codex (and vice versa).
- **Stale `.credentials.json` + fresh Keychain token (macOS)** → the freshest credential wins; the lingering file never masks a live Keychain login.
- **Expired access token (everywhere)** → no network call; expired-state hint. We never refresh the token ourselves (rotation race with Claude Code could invalidate its session).
- **429 / network failure / offline** → keep showing last successful payload with “stale · Xm ago”. Network errors retry on the next cycle; a 429 arms a `Retry-After` backoff so polls short-circuit in Rust (no HTTP) until the penalty lapses, with a countdown in the foot line when there is no payload to show.
- **App restart during a rate-limit window** → the disk cache restores the last good payload immediately, so the widget never opens blank just because the process restarted (dev iteration restarts used to cost one request each and start empty).
- **`codex exec`-only recent activity** (`rate_limits: null`) → scanner keeps walking older events/files; if nothing in ~7 days → “no recent data — run codex once”.
- **`seven_day_opus`/`seven_day_sonnet` null** → row hidden, no empty gauge.
- **`weekly_scoped` entry duplicating a legacy top-level window** (same model
  name) → the scoped entry wins; the top-level one is dropped at parse time
  (spec 187).
- **Multiple usage views / window status segments** → allowed; all subscribers
  share one frontend poll timer per provider, backed by the Rust cache.
- **Secrets hygiene** → tokens never logged, never serialized into any Result; error strings are static sentinels, never raw HTTP bodies.
- **Inference-only Claude OAuth grant** → recent Claude Code credentials may list
  only `user:inference`; the usage endpoint requires `user:profile` and returns
  403. Krypton detects the missing scope before fetching and renders “Claude
  login lacks user:profile scope — usage unavailable”.

## Out of Scope

- Per-lane / per-session token+cost aggregation from ACP `UsageInfo` events (different layer; possible future tab in this same view).
- Workspace-footer utilization indicator and threshold notifications (per-window
  status landed in spec 153; the global workspace footer remains out of scope).
- OAuth token refresh, any write to credential stores, any persistence of usage *history* (the single last-payload disk cache added post-implementation is a freshness optimization, not history).
- ~~Other providers (Gemini, Cursor, Copilot…)~~ Copilot and Cursor were added post-implementation at the user's request (see Solution). Remaining: Gemini etc. — still no accessible quota source.

## Resources

- [Claude-Code-Usage-Monitor issue #202](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/issues/202) — endpoint URL, required headers (`anthropic-beta: oauth-2025-04-20`, `User-Agent`), full response shape, 180 s cadence, credential storage paths incl. macOS Keychain service name
- [openai/codex issue #14728](https://github.com/openai/codex/issues/14728) — `codex exec` emits `rate_limits: null` in JSONL (must skip)
- [openai/codex issue #14489](https://github.com/openai/codex/issues/14489) — `TokenCount { info, rate_limits }` event semantics; rate-limit-only re-emissions
- [ccusage codex guide](https://ccusage.com/guide/codex/) — `CODEX_HOME` discovery, cumulative `token_count` semantics
- [sessionwatcher: How to check Codex usage](https://www.sessionwatcher.com/guides/how-to-check-codex-usage) — 5 h rolling + weekly window semantics post-2026-04-09 (token-based)
- Local ground truth: live `token_count` event parsed from `~/.codex/sessions/2026/06/10/rollout-*.jsonl`; `~/.claude/.credentials.json` structure verified (tokens redacted)
