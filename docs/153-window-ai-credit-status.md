# Window AI Credit Status — Implementation Spec

> Status: Implemented
> Date: 2026-06-11
> Milestone: ACP Harness — operational visibility

## Problem

The subscription usage view (`Leader $`) shows authoritative AI account quotas, but
the user must open a separate view to notice that a provider is near a limit. The
existing per-window bottom status bar has no persistent AI-credit readout, even
when an AI or multi-lane ACP Harness view is visible.

## Solution

Render compact subscription-credit telemetry on the left side of each window's
existing `.krypton-window__footer`, leaving transient notifications on the right.
The visible content view declares which supported providers it contains; an ACP
Harness declares the deduplicated union of all its live lane backends. A shared
frontend usage store owns fetching and caching so the footer and `Leader $` view
never create duplicate polling loops.

The footer shows all primary quota windows when space permits. At constrained
widths, each provider collapses to its most-used quota window. Provider names stay
short (`CLAUDE`, `CODEX`, `COPILOT`, `CURSOR`, `GROK`); the redundant word `credit` is
never rendered.

## Research

- The Rust usage backend already exposes read-only commands for Claude, Codex,
  Copilot, Cursor, and Grok (spec 193) and caches network-backed providers for
  180 seconds.
- `UsageContentView` currently owns four independent polling loops and duplicates
  all usage payload types. Moving that responsibility into one shared store lets
  the detailed view and every window footer consume the same snapshots.
- Every regular, content, and Quick Terminal window already has a structural
  `.krypton-window__footer`. The notification controller moves one notification
  element into the focused window footer and right-aligns itself with
  `margin-left: auto`, leaving the footer's left side available.
- ACP Harness lane objects already carry `backendId`; lane add, restore, and close
  paths are centralized enough to publish one deduplicated provider-set update.
- Subscription quota is provider-account state, not per-lane token usage.
  Multiple Codex lanes therefore produce one Codex status segment.
- Hidden tabs must not add unrelated providers to the visible status. The
  compositor reads provider declarations from the focused pane of the active tab.
- Unsupported backends such as Gemini, OpenCode, Pi, Droid, Junie, OMP, and Grok
  have no existing authoritative subscription-usage source and remain absent.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code | `/usage` panel shows 5-hour and weekly quota windows | Full detail on demand; no persistent compact status |
| Codex CLI | `/status` shows 5-hour and weekly windows | Full text snapshot inside the active session |
| Cursor usage status extensions | Editor status-bar item shows current included-plan usage | Validates persistent ambient quota display |
| Krypton `Leader $` | Full provider widgets with gauges, reset countdowns, spend, and freshness | Remains the detailed source of truth |

**Krypton delta** — quota becomes ambient per-window chrome rather than a global
workspace indicator. Multi-lane harnesses show every supported provider they
contain, while normal shell and non-AI content windows stay quiet.

## Affected Files

| File | Change |
|------|--------|
| `src/usage-store.ts` | New shared usage types, polling store, provider summaries, freshness/error state |
| `src/usage-view.ts` | Consume the shared store instead of owning fetch state and timers |
| `src/types.ts` | Add optional content-view provider declaration and change subscription |
| `src/compositor.ts` | Create/render/dispose per-window credit status; refresh on active pane/tab changes |
| `src/acp/acp-harness-view.ts` | Publish deduplicated supported providers as lanes change |
| `src/acp/acp-view.ts` | Declare its single supported backend provider |
| `src/styles/window.css` | Window-credit segment layout, thresholds, truncation, responsive collapse |
| `src/usage-store.test.ts` | Summary selection, deduplication, stale/error, and polling tests |
| `docs/151-subscription-usage-view.md` | Amend ownership: shared store feeds detailed view and window status |
| `docs/02-functional-requirements.md` | Document ambient per-window AI quota visibility |
| `docs/04-architecture.md` | Document shared usage store and window-footer DOM |
| `docs/05-data-flow.md` | Document provider declaration → store → window status flow |
| `docs/PROGRESS.md` | Add completed landing after implementation |

## Design

### Data Structures

```ts
export type UsageProvider = 'claude' | 'codex' | 'copilot' | 'cursor';

export interface UsageQuotaSummary {
  label: string;              // "5h", "week", "premium", "month"
  usedPercent: number;
}

export interface ProviderUsageSummary {
  provider: UsageProvider;
  quotas: readonly UsageQuotaSummary[];
  mostConstrained: UsageQuotaSummary | null;
  freshness: 'loading' | 'live' | 'stale' | 'off';
}

export interface UsageStoreSnapshot {
  providers: ReadonlyMap<UsageProvider, ProviderUsageSummary>;
}
```

`ContentView` gains optional window-credit declarations:

```ts
getUsageProviders?(): readonly UsageProvider[];
onUsageProvidersChange?(cb: () => void): () => void;
```

`getUsageProviders()` is synchronous and deduplicated. The callback fires only
when membership changes, not for lane status/model changes.

### Shared Usage Store

`UsageStore` is a frontend module singleton consumed by the compositor and
`UsageContentView`.

- It invokes the existing `usage_fetch_*` Tauri commands.
- Poll cadence remains Claude/Copilot/Cursor 180 seconds and Codex 60 seconds.
- It starts a provider poll when the first subscriber requests that provider and
  stops its timer when the final subscriber releases it.
- It keeps the last good value on failure and marks the provider stale.
- It exposes raw payloads for the detailed view and normalized summaries for
  window chrome.
- No Rust command, backend cache, credential, or network behavior changes.

### Quota Summary Rules

| Provider | Normal-width quota labels | Notes |
|----------|---------------------------|-------|
| Claude | `5h`, `week`, optional `opus`, optional `sonnet`, one label per model-scoped weekly window (lowercased name, e.g. `fable` — spec 187) | Extra-credit dollars remain detail-view only |
| Codex | `5h`, `week` | Local snapshot may be stale |
| Copilot | `premium`, `chat`, `complete` | Unlimited quotas omitted |
| Cursor | `month`; legacy fallback `requests` | Spend dollars remain detail-view only |

`mostConstrained` is the quota with the highest `usedPercent`. Ties retain the
table order above. Values clamp to `0..100` for display.

### Data Flow

1. A visible content view declares its supported usage providers.
2. For ACP Harness, lane add/restore/close recomputes the deduplicated provider
   union and notifies the compositor.
3. The compositor subscribes the visible pane's provider set to `UsageStore`.
4. `UsageStore` serves cached values immediately and starts only needed polls.
5. Store snapshots trigger a render into that window's footer.
6. Tab/pane focus changes replace the window's provider subscription.
7. `UsageContentView` subscribes to all four providers and renders full details.

### UI Changes

The existing footer becomes:

```html
<div class="krypton-window__footer">
  <div class="krypton-window__usage-status">
    <span class="krypton-window__usage-provider">
      <span class="krypton-window__usage-name">CODEX</span>
      <span>5h 41%</span><span>/</span><span>week 34%</span>
    </span>
    <span class="krypton-window__usage-provider">CURSOR month 19%</span>
  </div>
  <div class="krypton-notif">...</div>
</div>
```

- Status occupies the left side; notification retains `margin-left: auto`.
- Normal width shows every primary quota for every declared provider.
- When the footer cannot fit, CSS hides secondary quotas and leaves one
  `mostConstrained` quota per provider.
- If provider segments still cannot fit, the whole usage status clips with an
  ellipsis; notifications are never displaced.
- `>= 80%` uses warning color; `>= 95%` uses danger color.
- `loading` renders a dim provider name plus `--`; `stale` dims the segment and
  exposes the reason/freshness through `title` and `aria-label`; `off` is hidden.
- The footer has no animation and no per-second countdown to preserve idle CPU.
- Detailed reset times, spend, and freshness text remain in `Leader $`.

### Provider Declaration

- `AcpHarnessView`: all live lanes whose `backendId` maps to a supported provider.
- `AcpView`: its single backend when supported.
- `UsageContentView`: all four providers.
- Terminal, Agent, Quick Terminal, and other content views: no declaration in v1.

### Configuration

None. The status is automatically present only when the visible content view
declares at least one supported provider.

## Edge Cases

- Three Codex lanes plus one Cursor lane render one Codex and one Cursor segment.
- Closing the final lane for a provider removes its segment and releases its store
  subscription.
- Switching to a shell tab clears the AI-credit status from that window.
- Provider fetch failure keeps the last good percentages but marks them stale.
- Provider not connected and with no cached data is omitted rather than consuming
  footer space with an error message.
- Multiple windows requesting the same provider share one polling timer.
- A notification appears on the right without replacing or moving the usage
  status.
- Unsupported ACP providers are silently omitted.

## Out of Scope

- Per-lane token counts, context usage, API cost, or attribution.
- Detecting AI CLIs running inside arbitrary PTY terminal panes.
- Adding quota sources for unsupported providers.
- Notifications when thresholds are crossed.
- User configuration for provider visibility, ordering, or thresholds.
- Reset countdowns or monetary spend in the window footer.

## Open Questions

None.

## Resources

- [`docs/151-subscription-usage-view.md`](151-subscription-usage-view.md) — existing provider sources, payloads, caching, polling, and detailed-view behavior
- [`docs/152-cursor-real-usage.md`](152-cursor-real-usage.md) — Cursor monthly included-usage semantics
- [`docs/40-notification-overlay.md`](40-notification-overlay.md) — existing per-window footer and right-aligned notification ownership
- [`docs/72-acp-harness-view.md`](72-acp-harness-view.md) — ACP Harness lane lifecycle and backend identities
- Existing HTML mockup: `.krypton/artifacts/hm-2/Codex-1/art-1-34f0b818.html`
