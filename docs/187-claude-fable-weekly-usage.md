# Claude Fable Weekly Usage Meter — Implementation Spec

> Status: Implemented
> Date: 2026-07-05
> Milestone: M-usage — subscription usage surfaces

## Problem

Anthropic now enforces a Fable-specific weekly rate-limit bucket for Claude
subscribers, visible in Claude Code's `/usage` panel. Krypton's usage view
(spec 151) and window credit chips (spec 153) show only the 5-hour session and
generic 7-day windows, so a user can hit the Fable weekly cap with no warning —
the account this was researched on is at 79% Fable (severity `warning`) while
the generic week shows a calm 47%.

## Solution

Parse the `limits` array that `https://api.anthropic.com/api/oauth/usage` now
returns alongside the legacy top-level windows. Model-scoped weekly entries
(`kind: "weekly_scoped"` with `scope.model.display_name`) become a new
`weeklyScoped` list on the existing `ClaudeUsage` payload; the usage view
renders one extra gauge per entry (`week · fable`) and `summarizeUsage()` adds
matching chip quotas, so window chrome inherits the meter with no chrome
changes. Parsing is generic over the scoped-model name: when Anthropic adds the
next scoped bucket, it appears without a code change.

## Research

- Live payload (fetched 2026-07-05 with the user's own token, same endpoint the
  app polls): Fable is **not** a top-level field. It arrives only as
  `limits[] = { kind: "weekly_scoped", group: "weekly", percent, severity,
  resets_at, scope: { model: { id, display_name: "Fable" } }, is_active }`.
  The array also repeats the session (`kind: "session"`) and generic week
  (`kind: "weekly_all"`) windows that the top-level fields already cover.
- `seven_day_opus` / `seven_day_sonnet` were `null` in the live payload; the
  `limits` array looks like their successor. Krypton keeps parsing them but
  must not double-render if a scoped entry with the same model name coexists.
- The endpoint is undocumented and aggressively rate-limited without a
  `User-Agent: claude-code/<version>` header
  ([claude-code#31637](https://github.com/anthropics/claude-code/issues/31637));
  `usage.rs` already sends that header and honors `Retry-After` on 429, so no
  transport changes are needed.
- Official statusline docs
  ([code.claude.com](https://code.claude.com/docs/en/statusline#available-data))
  still document only `five_hour` / `seven_day` — no Fable field, confirming
  the `limits` array is the only machine-readable source.
- Alternative ruled out: orca's approach (below) of guessing OAuth field names
  (`fable_weekly`, `seven_day_fable` — none exist in the live payload) with a
  hidden-PTY scrape of the interactive `/usage` panel as fallback. Krypton
  already has the ground-truth JSON; scraping CLI output would add a PTY
  lifecycle for strictly worse data.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| orca (`~/Source/orca`) | Status-bar meter per provider; Fable weekly modeled as `ProviderRateLimits.fableWeekly`, filled from guessed OAuth fields, else a hidden `claude` PTY runs `/usage` and regex-parses the panel text | Spec at `docs/claude-fable-weekly-usage-meter.md`; parser accepts `Weekly limits` / `7-day` / `Fable` wording |
| Claude Code `/usage` | Interactive panel lists Session, Current week (all models), and a standalone `Fable` section with % consumed + reset | Source of the wording orca scrapes |
| cc-usage-monitor, claude-code-usage-bar | StatusLine integrations reading documented `rate_limits.five_hour` / `seven_day` only | No Fable bucket — schema doesn't expose it |

**Krypton delta** — same three-meter outcome as orca (session / week / Fable),
but sourced from the JSON `limits` array instead of a fixed `fableWeekly` field
plus CLI scraping: generic over model names, no extra process, no copy-drift
regexes. Rendering follows Krypton's existing gauge rows (spec 151) rather than
a status-bar chip, and the window chrome chip comes free via `summarizeUsage`.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/usage.rs` | `ScopedUsageWindow` struct; parse `limits[]` into `weekly_scoped`; suppress duplicate top-level opus/sonnet; `#[serde(default)]` for cache back-compat; parse test |
| `src/usage-store.ts` | `ScopedUsageWindow` interface; `weeklyScoped` on `ClaudeUsage`; scoped quotas in `summarizeUsage` |
| `src/usage-store.test.ts` | Summary test covering a scoped Fable window |
| `src/usage-view.ts` | Render `week · <name>` gauge per scoped window |
| `docs/151-subscription-usage-view.md`, `docs/153-window-ai-credit-status.md`, `docs/PROGRESS.md` | Document the new gauge/quota (at implementation time) |

## Design

### Data Structures

```rust
// usage.rs
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScopedUsageWindow {
    /// scope.model.display_name, e.g. "Fable".
    pub name: String,
    pub utilization: f64,          // limits[].percent
    pub resets_at: Option<String>, // ISO-8601, same shape as UsageWindow
}

pub struct ClaudeUsage {
    // …existing fields…
    /// Model-scoped weekly windows from the `limits` array. `serde(default)`
    /// so pre-existing disk caches (spec 153) still deserialize.
    #[serde(default)]
    pub weekly_scoped: Vec<ScopedUsageWindow>,
}
```

```ts
// usage-store.ts
export interface ScopedUsageWindow {
  name: string;
  utilization: number;
  resetsAt: string | null;
}
// ClaudeUsage gains: weeklyScoped: ScopedUsageWindow[];
```

### API / Commands

No new commands. `usage_fetch_claude` payload gains the `weeklyScoped` array.

### Data Flow

```
1. usage_fetch_claude GETs /api/oauth/usage (existing cadence, cache, 429 path)
2. Parser reads body.limits[]; keeps entries with kind == "weekly_scoped" and a
   non-empty scope.model.display_name; maps percent → utilization,
   resets_at → resets_at
3. If a scoped name equals "opus"/"sonnet" (case-insensitive), the matching
   top-level seven_day_* window is dropped in favor of the scoped entry
4. Frontend UsageStore receives weeklyScoped via the existing poll
5. usage-view renders gauge "week · fable" after the generic week gauge;
   summarizeUsage adds quota { label: "fable", usedPercent } so the window
   chrome chip (spec 153) highlights it when it is the most constrained
```

### Keybindings

None — surfaces inside the existing usage view and chrome chips.

### UI Changes

One additional `.krypton-usage` gauge row per scoped window, labeled
`week · <name-lowercased>`, using the existing gauge renderer (percent color
thresholds unchanged). No new CSS.

### Configuration

None.

## Edge Cases

- `limits` absent (older API surface) → `weekly_scoped` stays empty; behavior
  identical to today.
- Old disk cache without the field → `#[serde(default)]` yields empty vec.
- Entries with `scope.surface` set but `scope.model` null → skipped.
- `session` / `weekly_all` entries in `limits` → ignored (top-level fields
  already cover them; avoids double gauges).
- Scoped entry duplicating top-level opus/sonnet → scoped wins (step 3 above).
- Multiple scoped models → all render, in payload order.
- `percent` arriving as integer or float → `as_f64` handles both.

## Open Questions

None — the two forks found during research are resolved in this spec:
`limits`-array parsing over orca-style field guessing + PTY scraping (live
payload evidence), and generic scoped list over a single `fableWeekly` field
(zero churn for future scoped models).

## Out of Scope

- Rendering `severity` / `is_active` from the API (gauge colors stay
  percent-threshold based).
- The `spend` block, `extra_usage.daily/weekly`, and other new payload fields.
- Any hidden-PTY `/usage` panel fallback (orca's supplement path).
- Polling cadence, credential loading, or 429 handling changes.

## Resources

- Live `GET https://api.anthropic.com/api/oauth/usage` payload (2026-07-05) —
  ground truth for the `limits[]` / `weekly_scoped` shape.
- `~/Source/orca/docs/claude-fable-weekly-usage-meter.md` and
  `src/main/rate-limits/claude-fetcher.ts` — prior art; showed which field
  names do NOT exist and the scraping fallback this spec avoids.
- [Claude Code statusline docs](https://code.claude.com/docs/en/statusline#available-data)
  — documented schema lacks Fable, ruling out the statusline path.
- [anthropics/claude-code#31637](https://github.com/anthropics/claude-code/issues/31637)
  — endpoint 429 behavior and required `User-Agent` header (already handled).
