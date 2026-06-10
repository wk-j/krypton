# Cursor Real Usage in the Credit View — Implementation Spec

> Status: Implemented (2026-06-10)
> Date: 2026-06-10
> Milestone: ACP Harness — operational visibility (extends spec 151)

## Problem

The Cursor widget shipped in the usage view (spec 151) reads the legacy
`cursor.com/api/usage` request counters, which are null on current usage-based
plans. So in practice the widget shows "plan usage not exposed by Cursor" and no
gauge — useless for the user, who is on a usage-based Cursor plan and wants to
see how much of their monthly credit is spent, right next to Claude/Codex/Copilot.

## Solution

Switch the Cursor fetch to Cursor's **dashboard usage RPC**, which returns
authoritative spend/limit data for the current billing cycle and works with the
exact same CLI token we already load:

```
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
Authorization: Bearer <jwt>
Connect-Protocol-Version: 1
Content-Type: application/json
body: {}
```

The headline becomes a real **% of included usage** gauge with the billing-cycle
reset countdown, plus a spend breakdown line (`$50.52 used · $20.00 included +
$30.52 bonus`). The legacy request-counter path is **kept as a fallback** only
for old request-capped plans (when the RPC returns no `planUsage`). No new
credentials, no writes, same 180 s cache and stale-fallback ladder as the other
providers.

## Research

- **Live verification on this machine (2026-06-10):** the RPC returns HTTP 200
  with the same JWT cursor-agent stores in the macOS Keychain
  (`cursor-access-token`). Full response shape:
  ```json
  {
    "billingCycleStart": "1779376355000",   // epoch ms, as string
    "billingCycleEnd":   "1782054755000",
    "planUsage": {
      "totalSpend": 5052,        // cents → $50.52
      "includedSpend": 2000,     // $20.00 included in the plan
      "bonusSpend": 3052,        // $30.52 free provider bonus
      "limit": 2000,             // $20.00 spend limit
      "remainingBonus": false,
      "autoPercentUsed": 22.45,
      "apiPercentUsed": 0,
      "totalPercentUsed": 18.71  // headline % — matches Cursor's own message
    },
    "enabled": true,
    "autoModelSelectedDisplayMessage": "You've used 19% of your included total usage"
  }
  ```
  `totalPercentUsed` is the figure Cursor's own dashboard message echoes ("19% of
  your included total usage"), so it is the right gauge. Spend amounts are in
  **cents** ($20.00 included is the standard Cursor Pro allowance → confirms unit).
- **Prior art — clearmeasurelabs/cursor-usage-status** (the repo the user
  linked): a VS Code extension that calls this same RPC with a `Bearer` token. It
  reads the token from the **Cursor.app SQLite store** (`state.vscdb`, key
  `cursorAuth/accessToken`). That path **does not exist on this machine** — there
  is no Cursor.app GUI; cursor-agent keeps the token in the Keychain. We already
  solved token loading in spec 151 (`load_cursor_creds`), so we only swap the
  endpoint, not the credential path.
- **Other endpoints from that repo** ruled out: `GET /auth/usage` and
  `GET /api/usage/summary` — the latter returns 404 on `api2.cursor.sh` (verified);
  the RPC alone carries everything we render.
- **Existing code** (spec 151, `usage.rs`): `load_cursor_creds()` already returns
  `{ user_id, jwt, email }`; `CURSOR_CACHE`, `cached_cursor()`, and the
  stale-fallback ladder are reused verbatim. Only `CursorUsage`,
  `parse_cursor_usage`, and the request inside `usage_fetch_cursor` change.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Cursor dashboard (cursor.com) | Web UI shows "X% of included usage", spend vs included, billing cycle | Source of truth; same RPC behind it |
| cursor-usage-status (OSS, VS Code) | Status-bar item; same `GetCurrentPeriodUsage` RPC, `Bearer` token from `state.vscdb` SQLite | Validates endpoint + headers; differs only in token source |
| Krypton spec 151 (current) | Legacy `cursor.com/api/usage` request counters via session cookie | Null on usage-based plans → "not exposed" |

**Krypton delta** — same gauge vocabulary as the Claude/Codex/Copilot widgets
(flat bar, `tabular-nums` %, billing-cycle reset countdown), Krypton Dark flat
aesthetic. We read the token from the Keychain (cursor-agent world), not the
GUI's SQLite store. Spend shown in dollars; percent gauge from `totalPercentUsed`.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/usage.rs` | Rewrite `CursorUsage` (spend fields), `parse_cursor_usage`, and the request in `usage_fetch_cursor` to the RPC; keep legacy request fields as optional fallback; update tests |
| `src/usage-view.ts` | Update `CursorUsage` interface + `renderCursor()` to draw the % gauge + spend note; legacy gauge fallback retained |
| `src/styles/usage-view.css` | Reuse existing `__gauge`/`__note`/`__foot` — adjust only if a spend line needs new spacing |
| `docs/151-subscription-usage-view.md` | Amend the Cursor paragraph in `## Solution` to point at the RPC (the "quota not exposed" note is now the fallback case) |
| `docs/PROGRESS.md`, `docs/04-architecture.md` | Doc sync per `/feature-implementation` |

## Design

### Data Structures (Rust, serde camelCase → TS mirror)

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CursorUsage {
    // Modern usage-based plan (from GetCurrentPeriodUsage.planUsage):
    pub total_percent_used: Option<f64>,   // headline gauge
    pub total_spend: Option<f64>,          // dollars (cents / 100)
    pub included_spend: Option<f64>,       // dollars
    pub bonus_spend: Option<f64>,          // dollars
    pub limit_spend: Option<f64>,          // dollars (planUsage.limit)
    pub cycle_end: Option<i64>,            // epoch ms (reset countdown)
    pub cycle_start: Option<i64>,          // epoch ms
    // Legacy request-capped fallback (only if no planUsage):
    pub requests_used: Option<f64>,
    pub requests_limit: Option<f64>,
    pub email: Option<String>,
    pub fetched_at: i64,
}
```

TS interface in `usage-view.ts` mirrors these field names (camelCase).

### API / Commands

`usage_fetch_cursor()` — signature unchanged (`-> Result<CursorUsage, String>`):
1. `load_cursor_creds()` (unchanged) → `{ jwt, email, .. }`; missing → `not-connected`.
2. Serve from `CURSOR_CACHE` if `< 180 s` old (unchanged ladder).
3. `POST api2.cursor.sh/.../GetCurrentPeriodUsage` with `Authorization: Bearer <jwt>`,
   `Connect-Protocol-Version: 1`, `Content-Type: application/json`, body `{}`,
   10 s timeout.
4. 401/403 → `token-expired`; other non-2xx → stale-or-`http-<code>`; network/parse
   failure → stale-or-`network-error` (identical ladder to today).
5. `parse_cursor_usage(body, email, now)` maps `planUsage` (cents → dollars,
   cycle timestamps parsed from the string epoch-ms). If `planUsage` is absent,
   leave the spend fields `None` (legacy request fields stay `None` too — the RPC
   doesn't carry them; the legacy fallback path is a future-proofing slot, see
   Edge Cases).
6. Cache + return.

The legacy cookie request is removed from the hot path. `user_id` is still loaded
(harmless; reserved for the legacy fallback) but no longer used in the request.

### Data Flow

```
1. View polls usage_fetch_cursor (every 180 s, like today)
2. Rust: Keychain JWT → cached-or-live POST GetCurrentPeriodUsage
3. parse planUsage → CursorUsage { totalPercentUsed, spend $, cycleEnd, .. }
4. renderCursor draws gauge("usage", totalPercentUsed, cycleEnd) + spend note
5. stale/expired/off states identical to the other widgets
```

### UI

Cursor widget head unchanged (mark + email meta + status dot). Body:
- **Modern plan:** one gauge row `usage  ██░░░░ 19%  resets 23d` (label "usage",
  pct = `totalPercentUsed`, reset = `cycleEnd`), then a note line:
  `$50.52 used · $20.00 included + $30.52 bonus` (bonus segment omitted when
  `bonusSpend` is 0). Foot: `live · updated Xs ago`.
- **Legacy capped plan (fallback):** unchanged — request gauge + `N / M fast
  requests this cycle`.
- **Neither:** `plan usage not exposed by Cursor — see cursor.com/dashboard`
  (kept as the final fallback note).

No new CSS classes expected; reuses `__gauge`, `__note`, `__foot`.

### Configuration

None — same fixed 180 s cadence, auto-detected.

## Edge Cases

- **`planUsage` present, `bonusSpend` 0** → note shows `$X used · $Y included` only.
- **`totalPercentUsed` > 100** → gauge clamps at 100% (existing `gauge()` clamp);
  critical color ≥ 95%.
- **`enabled: false` / spend disabled account** → if `planUsage` parses, still
  render it; the gauge reflects whatever Cursor reports.
- **Token expired (JWT rotated)** → 401/403 → `token-expired` hint; cursor-agent
  refreshes the Keychain token on next use (we never refresh it ourselves).
- **RPC returns neither `planUsage` nor legacy fields** → "not exposed" note,
  widget still `ok` (connected).
- **Unit assumption** — spend treated as cents (verified against the live $20.00
  included Pro allowance). If a future response is already in dollars, amounts
  would read 100× low; flagged as the one assumption to re-verify.
- **Secrets hygiene** — JWT never logged or serialized into any Result; error
  strings remain static sentinels.

## Out of Scope

- Per-model spend breakdown (`autoPercentUsed` / `apiPercentUsed`), team/org seat
  rollups, the `autoBucketModels` list.
- Historical spend trends / persistence.
- Linux/Windows Cursor token sources (still macOS-Keychain only, per spec 151).

## Resources

- [clearmeasurelabs/cursor-usage-status](https://github.com/clearmeasurelabs/cursor-usage-status) — the RPC path, `Bearer` auth, `Connect-Protocol-Version: 1` header, body `{}`; differs from us only in reading the token from `state.vscdb` SQLite
- Local ground truth: live HTTP 200 from `POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` with the Keychain JWT, full `planUsage` response shape captured 2026-06-10 (token redacted)
- [docs/151-subscription-usage-view.md](151-subscription-usage-view.md) — the view this extends; reused credential loader, cache, and widget vocabulary
