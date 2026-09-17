# Harness Usage Visual Summary — Implementation Spec

> Status: Implemented
> Date: 2026-09-16
> Milestone: Post-M-current polish
> Builds on: 214 (LLM usage log) · 249 (prompt-cache hit rate)

## Problem

`#usage` currently emits a dense two-line system message. It contains the right
numbers, but the date, turn count, token flow, cache health, and model breakdown
all have the same visual weight, so the user must parse telemetry as prose.

## Solution

Render successful `#usage` results as a structured, read-only telemetry card in
the transcript. Make cache hit rate the visual anchor, show the token composition
as one proportional bar, place the four raw counters in scan-friendly cells, and
keep model rows as a compact breakdown. Preserve the existing plain-text summary
on the transcript item as a fallback for Live Assist and non-card consumers.

## Research

- The complete `UsageRollup` already reaches the frontend. No Rust, IPC, storage,
  or usage formula change is needed.
- `describeUsage()` flattens that structure before `appendTranscript()`, which is
  where hierarchy is lost. The renderer already supports structured metadata on
  otherwise-system transcript rows (`diff`, provider errors, artifacts).
- The cache counters are disjoint: uncached input, cache read, and cache write
  form one input-side composition. A proportional bar communicates the 98% hit
  shown in the screenshot without hiding the raw values.
- Claude Code recommends an at-a-glance status line and exposes per-turn cache
  read/write counts; its prompt-cache guide says sustained cache creation is the
  signal to investigate. Krypton should keep read and write visible beside the
  hit rate rather than replace them with a score alone.
- `ccusage` uses explicit Input, Output, Cache Create, and Cache Read columns and
  switches to a compact presentation on narrow terminals. Krypton can retain
  those named measures while using the transcript's wider DOM surface.
- This is historical telemetry, not liveness. It should not pulse or animate.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| Claude Code | Custom status line can show context and usage as a horizontal bar; prompt-cache telemetry exposes read and creation counts. | Supports one strong percentage/bar plus explicit counters. |
| ccusage | Daily terminal table separates Input, Output, Cache Create, and Cache Read; narrow terminals reduce columns. | Supports named raw metrics and responsive density. |
| Krypton lane stats | Shows the latest turn as `cache N%`, with raw counts in a tooltip. | The card should use the same formula and vocabulary. |
| Krypton `#daily` | Uses a table with a per-lane `Hit` column. | The card remains a day overview; it does not duplicate the full daily brief. |

**Krypton delta** — unlike a terminal table, the Harness can use proportional
geometry while staying keyboard-first. The card uses the Amber telemetry
language, full borders, hard geometry, and no mouse-only information. Hover
titles may repeat detail, but every value remains visible in text.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-view-types.ts` | Add optional structured `usage` metadata to a system transcript item. |
| `src/acp/acp-harness-view.ts` | Attach the `UsageRollup` to successful `#usage` rows while retaining fallback text. |
| `src/acp/harness-transcript-render.ts` | Detect usage metadata and render the visual summary. |
| `src/acp/usage-log.ts` | Export a small presentation model builder so values and percentages remain pure and testable. |
| `src/acp/usage-log.test.ts` | Cover card presentation data, incomplete counters, cost, and warnings. |
| `src/acp/harness-transcript-render.test.ts` | Cover semantic DOM, proportional segments, and fallback behavior. |
| `src/styles/acp-harness.css` | Add responsive telemetry-card styles using existing Harness/Amber tokens. |
| `docs/02-functional-requirements.md` | Extend FR-ACP-024 with the visual readout requirement. |
| `docs/04-architecture.md` | Record structured transcript rendering with text fallback. |
| `docs/72-acp-harness-view.md` | Document the card hierarchy and narrow layout. |
| `docs/214-llm-usage-statistics.md` | Update the `#usage` presentation contract. |
| `docs/README.md` | Index this spec. |

## Design

### Presentation Model

```ts
export interface UsageVisualSummary {
  date: string;
  turns: string;
  cachePercent: string | null;
  segments: {
    input: number;
    cachedRead: number;
    cachedWrite: number;
  };
  metrics: Array<{ label: string; value: string; tone: string }>;
  models: Array<{
    name: string;
    turns: string;
    input: string;
    output: string;
  }>;
  cost: string | null;
  notices: string[];
}

export function buildUsageVisualSummary(rollup: UsageRollup): UsageVisualSummary;
```

The builder reuses `cacheHitRate()` and `formatTokenCount()`. Segment values are
raw non-negative token counts; the DOM renderer converts them to percentages.
It does not add pricing, estimates, thresholds, or cache-health labels.

### Transcript Data

```ts
interface HarnessTranscriptItem {
  // existing fields unchanged
  usage?: UsageRollup;
}
```

The item remains `kind: 'system'` so downstream transcript classification does
not gain a new role. Its `text` remains `[usage] ${describeUsage(rollup)}` for
Live Assist, diagnostics, and any renderer that does not understand `usage`.

### Data Flow

1. User submits `#usage` or `#usage <date>`.
2. `usage_today` returns the existing `UsageRollup`.
3. The Harness appends one system item with both fallback `text` and `usage`.
4. `renderTranscriptItem()` sees a recorded, non-empty rollup and builds the
   structured presentation model.
5. The renderer creates semantic DOM; CSS supplies the responsive layout.
6. Live Assist and other plain-text projections continue reading `item.text`.

No-turn and recording-disabled responses remain plain system messages. They do
not render a large empty card.

### UI

Wide layout:

```text
USAGE  2026-09-16                                      5 TURNS
       CACHE HIT  98%  [██████████████████████████░]
       INPUT 9.0k   OUTPUT 2.3k   CACHE READ 456.7k   CACHE WRITE 0
       MODEL                     TURNS       INPUT       OUTPUT
       gpt-5.6-sol [high]            5        9.0k         2.3k
```

- One full `1px` border encloses the card; no left rail or corner brackets. The
  card uses the configured Krypton container radius from spec 234.
- Header: date on the left, turn count on the right.
- Cache row: large `98%` plus a single composition bar. Segments represent
  cached read, cache write, and uncached input; text labels below make the bar
  understandable without color.
- Metrics: four equal cells for Input, Output, Cache read, Cache write.
- Models: compact aligned rows; long names ellipsize visually but keep `title`.
- Cost, unmeasured turns, and unsent rows appear as a final notice strip only
  when present.
- Colors use existing Harness/Amber custom properties. Cache read is bright
  amber, cache write is gold, and uncached input is muted foreground. No green
  “good” judgment is introduced.
- No animation. The existing row-entry animation may still run once.

Responsive behavior:

- At normal lane width, metrics use four columns and model rows use four aligned
  columns.
- Below `680px`, metrics become a `2 × 2` grid; the model name owns the first
  row and its three values share the next row.
- Below `420px`, the cache percentage and bar stack. The card never creates a
  horizontal scrollbar.

### Accessibility

- The composition bar is decorative (`aria-hidden="true"`); visible labels and
  values carry all meaning.
- Date, turn count, cache hit, and metric labels remain text, not pseudo-content.
- Missing cache input/read data shows the available raw counters and the label
  `hit unavailable`; it never invents a percentage or a bar ratio.
- The card respects the configured Harness font family and current zoom.

### Keybindings and Configuration

None. `#usage` remains the keyboard entry point and no preference is added.

## Edge Cases

- Recording off or zero turns: retain the current plain sentence.
- No cache counters: omit cache hit and composition bar; still show input/output.
- Cache counters without a valid denominator: show `hit unavailable` and raw
  cache metrics.
- Zero cache write: render the `Cache write 0` metric but no zero-width segment.
- One or many model groups: use the same row template; no arbitrary row cap.
- Cost in a non-USD currency: use the backend-provided currency unchanged.
- Unsent rows and turns without counters: show explicit notices, never badges
  that look like success states.

## Open Questions

None. The proposed card keeps all current information, uses no new interaction,
and degrades to the existing text where structured rendering is unavailable.

## Out of Scope

- Trend charts across several days
- Per-turn history inside `#usage`
- Cost estimates or “money saved” claims
- Cache miss-cause diagnosis or TTL display
- Changes to `#daily`, Xenon, storage, or provider adapters
- A new command, modal, dashboard, or configuration toggle

## Validation

- `npm test` — 222 files / 3,480 tests passed.
- `npm run build` — TypeScript and Vite production build passed; only existing
  third-party directive, dynamic-import, and chunk-size warnings remain.
- `git diff --check` — passed.
- Exact production markup and stylesheet rendered at wide and `360px` Harness
  widths through macOS Quick Look; the four-column and `2 × 2` metric layouts,
  model-row reflow, and stacked narrow cache bar rendered without overflow.
- Harness performance checklist for this one-shot transcript card: 14 PASS,
  19 N/A, 0 FAIL. The subtree is built detached and committed once, uses CSS
  containment, adds no timer/listener/layout read, and inherits the bounded
  300-row transcript retention.

## Resources

- [Claude Code: How prompt caching works](https://code.claude.com/docs/en/prompt-caching) — cache read/write interpretation and live observability guidance.
- [Claude Code: Customize your status line](https://code.claude.com/docs/en/statusline) — compact bars, multi-line telemetry, and width constraints.
- [ccusage daily reports](https://github.com/ccusage/ccusage/blob/main/docs/guide/daily-reports.md) — separate cache columns and responsive terminal reporting.
- `docs/214-llm-usage-statistics.md` — Krypton's usage data and privacy contract.
- `docs/249-harness-cache-hit-rate.md` — Krypton's cache-hit formula and coherent-counter rules.
- `DESIGN.amber.md` — Harness typography, color, geometry, and motion constraints.
