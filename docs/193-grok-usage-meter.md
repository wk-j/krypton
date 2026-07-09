# Grok Subscription Usage Meter — Implementation Spec

> Status: Implemented
> Date: 2026-07-09
> Milestone: M-usage — subscription usage surfaces

## Problem

The usage view (spec 151) and window credit chips (spec 153) surface Claude,
Codex, Copilot, and Cursor quotas, but not Grok — even though Krypton already
runs a `grok` ACP lane (backendId `grok`). A user driving a Grok lane has no
in-app signal of how much of their xAI credit allowance is left, while every
other backend they run shows one.

## Solution

Add `grok` as a fifth usage provider following the **Claude model** (network +
OAuth token read from disk), not the Codex model (local session scan) — Grok's
CLI does **not** persist rate-limit/usage data to its session files, so there is
nothing to scan. A new `usage_fetch_grok` command reads the OAuth access token
from `~/.grok/auth.json`, calls `GET https://cli-chat-proxy.grok.com/v1/billing`,
and parses the credit allowance (`used` / `monthlyLimit`) plus billing-cycle
bounds into a `GrokUsage` payload. The usage view renders one `credits` gauge;
`summarizeUsage()` adds a matching chip quota so window chrome inherits the
meter with no chrome changes. Caching, disk-persistence, and 401/stale handling
mirror the existing Claude path.

## Research

- **No local usage data.** A recursive key scan of `~/.grok/sessions/**` and
  `~/.grok/logs/unified.jsonl` found no `rate_limit` / `usage` / `quota` /
  `remaining` fields. The gateway does push a `RateLimitsUpdated` WebSocket
  event (`ServerEvent::RateLimitsUpdated`, `ChatGlobalRateLimitDetails`), but
  those are transient and not persisted, so the Codex-style rollout scan is
  impossible. Rules out a local-file source.
- **Live billing endpoint (verified 2026-07-09 with the user's own token).**
  `grok-0.2.93`'s `crates/codegen/xai-grok-shell/src/extensions/billing.rs`
  fetches `<base>/billing?format=credits` with `Authorization: Bearer <token>`
  and header `x-grok-client-version`. The base is
  `https://cli-chat-proxy.grok.com/v1` (same host the CLI chat proxy uses).
  **Bearer token alone is sufficient** — verified that `GET /v1/billing` with
  only `Authorization: Bearer` (no `x-grok-client-version`, no `Content-Type`)
  still returns HTTP 200; no auth at all returns HTTP 401 with body
  `{"error":"Invalid or expired credentials …"}`. We still send a
  `x-grok-client-version` header defensively (the Claude endpoint rate-limits
  without its `User-Agent`; cheap insurance), but it is not required.
  Two shapes observed, both HTTP 200:
  - `GET /v1/billing` → `{"config":{ "monthlyLimit":{"val":4000},
    "used":{"val":14}, "onDemandCap":{"val":0}, "billingPeriodStart":
    "2026-07-01T00:00:00+00:00", "billingPeriodEnd":"2026-08-01T00:00:00+00:00",
    "history":[{"billingCycle":{"year":2026,"month":6},"includedUsed":{"val":0},
    "onDemandUsed":{"val":0},"totalUsed":{"val":0}}, …]}}` — the monthly credit
    balance. **This is the gauge source:** `used / monthlyLimit` → 0.35%, resets
    `billingPeriodEnd`.
  - `GET /v1/billing?format=credits` → `{"config":{"currentPeriod":{"type":
    "USAGE_PERIOD_TYPE_WEEKLY","start":..,"end":..}, "onDemandCap":{"val":0},
    "onDemandUsed":{"val":0}, "isUnifiedBillingUser":true,
    "prepaidBalance":{"val":0}, "billingPeriodStart":.., "billingPeriodEnd":..}}`
    — no `used`/`monthlyLimit` for this subscription user. **Not used** (no
    utilization number).
  - Probed `/usage`, `/rate-limits`, `/auth/check_subscription`,
    `/subscriptions` → all 404. `/billing` is the only pollable usage surface.
- **Credentials.** `~/.grok/auth.json` is an object keyed by
  `"<issuer>::<client_id>"`; each value has `key` (JWT access token),
  `expires_at` (ISO-8601), `refresh_token`, `email`, and a JWT-embedded
  `tier` claim — **verified** by decoding the token: `{ "tier": 3, "scope":
  "… grok-cli:access api:access", "exp": 1783628269, "iss": "https://auth.x.ai" }`.
  File-only — no macOS Keychain entry (unlike Claude),
  so no Keychain fallback branch is needed. Krypton only reads; the `grok` CLI
  owns refresh.
- Alternative ruled out: subscribing to the gateway `RateLimitsUpdated`
  WebSocket. It would need a live WS connection Krypton doesn't otherwise hold,
  gives push-only (not pollable) data, and carries per-turn rate limits rather
  than the subscription allowance the other four providers show.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Grok CLI (`grok-0.2.93`) | `/billing?format=credits` GET with the OAuth bearer + `x-grok-client-version` header; polls subscription state on `subscription_watch_interval_secs` | Ground-truth transport this spec mirrors; also exposes `RateLimitsUpdated` over its gateway WS |
| Krypton Claude provider (spec 151/187) | OAuth token from disk → REST GET → cache 180 s + disk-persist by token fingerprint → 429/stale handling | The template this provider copies structurally |
| Krypton Cursor provider (spec 152) | CLI JWT + dashboard RPC → spend-vs-included for the billing cycle, all-`Option` payload | Closest analog for a credit/spend meter with many optional fields |

**Krypton delta** — same "OAuth-from-disk → REST → gauge" shape as the Claude
provider, but no Keychain fallback (Grok stores creds in a plain file) and a
single credit gauge instead of multiple rate-limit windows (Grok's only
pollable surface is the monthly credit balance). Rendering follows the existing
gauge rows (spec 151); the window chrome chip comes free via `summarizeUsage`.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/usage.rs` | `GrokUsage` struct; `GrokCreds` + `load_grok_creds`; `usage_fetch_grok` command; 180 s in-mem cache + disk cache (`grok-usage.json`); JWT-`tier` decode helper; parse test |
| `src-tauri/src/lib.rs` | Register `usage::usage_fetch_grok` in `invoke_handler` |
| `src/usage-store.ts` | `'grok'` in `UsageProvider`, `PROVIDERS`, `POLL_MS`, `UsagePayloads`, `providerForBackend`; `GrokUsage` interface; `summarizeUsage` branch |
| `src/usage-view.ts` | `'grok'` in `providers`; `PROVIDER_LOGOS.grok` (reuse harness bolt geometry); `renderGrok()` |
| `src/usage-store.test.ts` | Summary test covering a Grok credit payload |
| `docs/151-…`, `docs/153-…`, `docs/PROGRESS.md` | Document the new provider (at implementation time) |

## Design

### Data Structures

```rust
// usage.rs
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrokUsage {
    pub used: Option<f64>,          // config.used.val
    pub monthly_limit: Option<f64>, // config.monthlyLimit.val
    pub on_demand_cap: Option<f64>, // config.onDemandCap.val
    pub on_demand_used: Option<f64>,// config.onDemandUsed.val
    pub period_start: Option<i64>,  // config.billingPeriodStart, epoch ms
    pub period_end: Option<i64>,    // config.billingPeriodEnd, epoch ms
    pub tier: Option<String>,       // JWT `tier` claim → "tier 3"
    pub email: Option<String>,      // auth.json email (meta line)
    pub fetched_at: i64,
}
```

```ts
// usage-store.ts
export interface GrokUsage {
  used: number | null;
  monthlyLimit: number | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  periodStart: number | null;
  periodEnd: number | null;
  tier: string | null;
  email: string | null;
  fetchedAt: number;
}
```

### API / Commands

`#[tauri::command] pub async fn usage_fetch_grok() -> Result<GrokUsage, String>`.
Registered in `lib.rs`. Frontend reaches it via the existing generic
`invoke(\`usage_fetch_${provider}\`)` — no store wiring beyond the union/array.

Constants: `GROK_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing"`,
`GROK_CLIENT_VERSION` (sent as `x-grok-client-version`).

### Data Flow

```
1. usage_fetch_grok reads ~/.grok/auth.json, picks the entry with the latest
   expires_at → GrokCreds { access_token, expires_at_ms, email, tier }
2. Serve from 180 s in-mem cache (keyed by token) if fresh; else check expiry
   (expires_at_ms <= now → "token-expired")
3. GET GROK_USAGE_URL with Authorization: Bearer + x-grok-client-version,
   10 s timeout
4. 401 → "token-expired"; non-200 or network err → last-good disk payload
   (frontend shows age) else error sentinel
5. Parse config.{used,monthlyLimit,onDemandCap,onDemandUsed} (each {"val":N}),
   billingPeriodStart/End (ISO → epoch ms); attach tier+email from creds
6. Persist to <cache_dir>/krypton/grok-usage.json (keyed by token fingerprint),
   store in-mem cache, return
7. UsageStore polls every 180 s; usage-view renders a `credits` gauge
   (used/monthlyLimit %) resetting at periodEnd; summarizeUsage adds
   quota { label: "credits", usedPercent } for the chrome chip
```

### UI Changes

One `.krypton-usage__widget` for `grok`: head (bolt logo + `email · tier 3`
meta + dot), a `credits` gauge (`used / monthlyLimit` %, reset countdown to
`periodEnd`), a note line `14 / 4000 credits this cycle`, and the standard
`live · updated …` foot. Logo reuses the `krypton-logo-grok` bolt geometry
(`M9.2 1.5 L3.8 8.8 H6.9 L5.8 14.5 L12.2 6.6 H8.8 Z`, `fill="currentColor"`)
from `acp-harness-view.ts` (spec 125), copied inline like the other
`PROVIDER_LOGOS` entries so the lazy chunk stays free of the harness module. No
new CSS.

### Configuration

None.

## Edge Cases

- `~/.grok/auth.json` missing / empty / unparseable → `"not-connected"`.
- Multiple auth entries (multiple issuers/clients) → pick the latest
  `expires_at`; mirror Claude's `pick_fresher`.
- `expires_at` in the past → `"token-expired"` (view hint: run `grok` to
  refresh); no refresh attempted (grok CLI owns the refresh token).
- `monthlyLimit` absent or ≤ 0 (e.g. the `format=credits` weekly shape, or a
  pure on-demand account) → skip the credits gauge, render a note
  (`usage not exposed by Grok — see grok.com`); `summarizeUsage` emits no quota.
- `{"val":N}` wrapper missing or non-numeric → field stays `None`.
- Old disk cache shape → `GrokUsage` is `Serialize`-only for IPC; the disk cache
  stores/loads via `serde_json::Value` like the Claude cache, tolerant of
  missing fields.
- JWT `tier` claim undecodable → `tier` stays `None` (meta shows email only).

## Open Questions

None. The two forks found in research are resolved: **network billing endpoint**
over local scan (Grok persists no usage locally — verified) and **plain
`/billing`** over `?format=credits` (only the plain form returns
`used`/`monthlyLimit`, the utilization numbers a gauge needs — verified live).

## Out of Scope

- The gateway `RateLimitsUpdated` per-turn rate limits (push-only, not pollable).
- `history[]`, `prepaidBalance`, `isUnifiedBillingUser`, auto-top-up rule.
- Refreshing the Grok OAuth token (the `grok` CLI owns that).
- Any change to polling cadence or chrome-chip rendering for other providers.

## Resources

- Live `GET https://cli-chat-proxy.grok.com/v1/billing` (and `?format=credits`)
  payloads, fetched 2026-07-09 with the user's own token — ground truth for the
  `config.{used,monthlyLimit,…}` shape and the endpoint host/headers.
- `~/.grok/downloads/grok-0.2.93-macos-aarch64` strings — the
  `xai-grok-shell/src/extensions/billing.rs` path, `x-grok-client-version`
  header, field names, and `subscription_watch_interval_secs` cadence.
- `~/.grok/auth.json` — credential shape (issuer-keyed map, `key`,
  `expires_at`, `email`, JWT `tier` claim).
- `docs/187-claude-fable-weekly-usage.md`, `src-tauri/src/usage.rs` (Claude
  path), `docs/152-cursor-real-usage.md` — structural templates.
