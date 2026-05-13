# 103. ACP Harness Transcript Visible Window

> Status: Implemented
> Date: 2026-05-13
> Milestone: ACP harness — performance hardening

## Problem

When a harness lane accumulates many transcript rows (long agent sessions with
heavy streaming, tool output, FS activity, thoughts, and permission prompts),
the active lane render path becomes a bottleneck even with the caching from
Spec 94. `renderActiveTranscript()` still walks every row in `lane.transcript`,
runs `querySelectorAll('.acp-harness__msg[data-msg-id]')` to build the diff
map, recomputes per-row signatures, and re-attaches event handlers and tool
chrome. The transcript array is already capped at 300 rows, but 300 rows of
mixed assistant/tool/thought content with pretext layout and markdown
parsing — even cached — is enough to drop frames during streaming and make
keystroke-to-render exceed the 16 ms budget on slower machines.

The user wants a way to **hide** older content so the hot render path operates
over a small tail. They are explicit that the goal is rendering performance,
not freeing agent context (the agent process keeps its own conversation
state; "forgetting" is out of scope here).

## Solution

Render only a **tail window** of `lane.transcript` instead of the entire
array. Each lane keeps a per-lane `transcriptWindow` setting (e.g. 60 rows by
default). `renderActiveTranscript()` slices the transcript and only diffs the
tail slice; rows outside the window are removed from the DOM. A single
**hidden-rows indicator row** is rendered at the top of the transcript when
hidden rows exist (e.g. `↑ 142 earlier rows hidden — h to reveal more`),
keeping discoverability without restoring the cost.

A keybinding (`Ctrl+H`) grows the window by a fixed step (60 rows) on each
press. When the window equals or exceeds the total row count it snaps to
"all"; the next press wraps back to 60. The setting is per-lane and resets
to the default on `#new`, `#restart`, and lane creation.

This is a pure frontend change — no protocol, no backend, no agent context
impact.

## Research

- Spec 94 (`docs/94-acp-harness-render-performance.md`) is the prior art.
  It established: signature-based diff, markdown cache, pretext line cache,
  streaming row reuse via `replaceChildren`. It explicitly listed "DOM
  virtualization for thousands of transcript rows" as a non-goal at the time.
- Spec 94 also documented a reverted experiment: `content-visibility: auto`
  with `contain-intrinsic-size: auto 48px`. The placeholder undersized
  unpainted rows, so `body.scrollHeight` was wrong and sticky auto-scroll
  settled above the true bottom. **Lesson carried forward:** any "hide" path
  must not produce DOM nodes whose measured height diverges from their real
  height when scrolled into view. The proposed approach avoids this because
  hidden rows are fully removed from the DOM, not collapsed with a fake
  intrinsic size.
- `renderActiveTranscript()` at `src/acp/acp-harness-view.ts:1882` is the
  single render path. The diff uses `data-msg-id` and a render signature on
  each row. The same diff logic can operate on a slice: rows outside the
  slice simply aren't in the `expected` set and get removed by the existing
  cleanup loop at line 1935.
- `lane.transcript` is appended to and capped at 300 rows
  (`acp-harness-view.ts:2515`). The slice approach composes cleanly with the
  300-row cap — together they bound both stored memory and rendered DOM.
- The streaming row identity check uses `lane.currentAssistantId` /
  `lane.currentThoughtId` (line 1908). Streaming rows are always at the
  tail, so they are always inside any reasonable window. No special-casing
  needed.
- Sticky-scroll anchor (`captureTranscriptScrollAnchor` / `restoreTranscript­
  ScrollAnchor`) keys off `data-msg-id`. The indicator row uses a stable
  reserved id (`__hidden_indicator__`) so it never collides with real rows
  and never accidentally becomes the anchor.

## Prior Art

| App | How transcripts handle large histories | Notes |
|-----|----------------------------------------|-------|
| Claude Code (terminal UI) | Renders the full transcript every redraw; relies on terminal text being cheap | No "hide older" affordance; users `clear` to reset visual state |
| Zed Assistant panel | Virtualized list; only on-screen rows mount | True virtualization with measured row heights; large engineering investment |
| Cursor / Continue VS Code chat | Renders all messages; relies on platform text rendering | Performance degrades with very long threads; no hide |
| ChatGPT web | "Hide older messages" / "Load earlier" pattern with a top indicator | Closest match to the proposed design |
| iTerm2 scrollback | Hard line cap; old lines drop silently | No reveal affordance — too lossy for a multi-row chat transcript |

**Krypton delta** — The ChatGPT-style "earlier rows hidden — reveal more"
indicator with a keybinding to expand is the closest fit. Krypton adapts it
to keyboard-first (cycle key, no click), keeps the existing 300-row hard cap
as a backstop, and deliberately *does not* attempt full virtualization
(Spec 94 already listed it as a non-goal; we're picking the cheaper 80% win).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add `transcriptWindow` to `HarnessLane`; slice the transcript in `renderActiveTranscript()`; render the hidden-rows indicator; add the cycle keybinding handler; reset window on `#new`/`#restart`/lane create |
| `src/styles/acp-harness.css` | Style the `.acp-harness__msg--hidden-indicator` row (one-line muted text, no glow stack — per "no layered UI" preference) |
| `docs/PROGRESS.md` | Add a line under the ACP harness section noting this change |
| `docs/72-acp-harness-view.md` | Document the new keybinding and indicator row |
| `docs/94-acp-harness-render-performance.md` | Add a forward reference noting this spec supersedes the "DOM virtualization" non-goal with a lighter-weight tail-window approach |

## Design

### Data Structures

Extend `HarnessLane` (line 139):

```ts
interface HarnessLane {
  // ...existing fields
  transcriptWindow: number;  // number of latest rows to render; Infinity = all
}
```

Add module-level constants:

```ts
const TRANSCRIPT_WINDOW_STEP = 60;
const TRANSCRIPT_WINDOW_DEFAULT = TRANSCRIPT_WINDOW_STEP;
```

Reserved indicator id:

```ts
const HIDDEN_INDICATOR_ID = '__hidden_indicator__';
```

### Render Path

In `renderActiveTranscript()` (line 1882), replace the full iteration with:

```
1. const total = lane.transcript.length
2. const windowSize = lane.transcriptWindow
3. const start = windowSize === Infinity ? 0 : Math.max(0, total - windowSize)
4. const hidden = start
5. If hidden > 0: synthesize an indicator item { id: HIDDEN_INDICATOR_ID,
   kind: 'system', text: `↑ ${hidden} earlier rows hidden — Ctrl+H show 60 more` }
   and prepend to the iteration.
6. Iterate lane.transcript.slice(start) as before — existing diff/cache
   logic is unchanged.
7. The existing cleanup loop ("for (const [id, el] of existing) if
   (!expected.has(id)) el.remove()") removes rows that scrolled out of the
   window automatically — no new code path.
```

The signature/markdown/pretext caches on `HarnessTranscriptItem` survive
because they live on the data objects, not the DOM. Toggling the window
larger and back re-renders cached rows cheaply.

### Streaming Rows

Streaming rows always live at the tail (`lane.currentAssistantId` etc. are
the most recently appended items). They're always inside the window — no
special-casing. If a turn is so long that streaming output alone exceeds
the window size, the streaming row still renders because `start` only
truncates *older* rows.

### Sticky Scroll

The hidden-rows indicator is a real DOM row with real measured height (a
single muted line). It enters the `scrollHeight` calculation correctly.
This avoids the Spec-94 `content-visibility` failure mode entirely: every
rendered row has accurate height.

When `stickToBottom` is true (the streaming case), the existing
`body.scrollTop = body.scrollHeight` path keeps working unchanged.

When the user expands the window (e.g. 60 → 200), new rows are prepended
above the current viewport. The existing `captureTranscriptScrollAnchor` /
`restoreTranscriptScrollAnchor` path runs because `stickToBottom` is false
during manual scroll; the anchor pins to the first visible existing row by
`data-msg-id` and `offsetTop`, so the viewport stays put while taller
content appears above. No new anchor logic is required.

### Keybindings

The harness has its own modal input layer inside `acp-harness-view.ts`.
The new binding lives there; it is not a global compositor binding.

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+H` | Any composer/transcript context in the harness | Expand `transcriptWindow` by `TRANSCRIPT_WINDOW_STEP` (60). When the new size reaches `lane.transcript.length` it snaps to `Infinity`; the next press wraps back to `60`. |

Notes:
- Avoid `Alt` per the existing preference.
- Uses `Ctrl+H` (not plain `h`) so it works even when the composer has focus
  — typing `h` in the composer must stay as a literal character.
- The key grows forward only and wraps. A dedicated shrink/reset binding is
  intentionally omitted to keep the surface minimal: pressing `Ctrl+H` while
  the window is already `Infinity` resets to `60`.

### UI Changes

New DOM row, prepended only when `hidden > 0`:

```html
<div class="acp-harness__msg acp-harness__msg--hidden-indicator"
     data-msg-id="__hidden_indicator__">
  <span class="acp-harness__hidden-count">↑ 142 earlier rows hidden</span>
  <span class="acp-harness__hidden-hint">Ctrl+H reveal more</span>
</div>
```

CSS: single-line muted row, no pseudo-element layers, ~24px tall. Matches
existing `.acp-harness__msg` baseline so vertical rhythm is consistent.

### Lifecycle / Reset

`lane.transcriptWindow` is initialized to `TRANSCRIPT_WINDOW_DEFAULT` when:
- A lane is created (`addLane` / lane bootstrap path).
- `#new` / `#new!` / `#restart` clears the transcript.
- A session resume populates a fresh lane.

It is **preserved** across:
- Tab/lane switches.
- Render cycles.
- Session refreshes that don't reset the transcript.

It is **not persisted** across Krypton restarts (matches existing
non-persistent state like `planCollapsed`).

### Configuration

No new TOML keys for now. The cycle list and default are module constants.
If users ask for tunability later, a `[acp.harness]` block can add
`transcript_window_default = 60`. Out of scope for this spec.

## Edge Cases

- **Transcript shorter than window** — `start = 0`, `hidden = 0`, no
  indicator rendered. Identical to current behavior.
- **Transcript at the 300-row cap** — with default window 60, exactly 240
  rows are hidden. The cap and the window compose; no special interaction.
- **User expands to `Infinity` on a 300-row lane** — the full render
  reappears with all caches warm; cost is the same as today's worst case.
  Acceptable because it's opt-in and reversible.
- **Streaming completes while a row is exactly at the window boundary** —
  the streaming row was inside the window, so it renders. After streaming
  ends, the row stays inside until enough new rows push it out.
- **Sticky-scroll while hidden rows exist** — works unchanged; the
  indicator row's height is real.
- **Scroll-anchor restore when the anchor row falls outside the window** —
  the anchor is captured from a *visible* row by `data-msg-id`. A visible
  row that falls outside the window on a subsequent render is removed
  from the DOM; in that case the existing anchor-restore code path
  already falls back gracefully (it no-ops if the anchor row is missing).
- **Indicator row interacting with the `seenTranscriptIds` reveal
  animation** — the indicator uses a fixed reserved id; on first render
  it's "new" and would animate in. Either suppress its entrance animation
  (`isNew = false` forced) or accept the one-time fade. Recommendation:
  force `isNew = false` to keep the row visually static.
- **Picker / overlay rebuilds calling `renderActiveTranscript`** — they
  pass through unchanged because the slice happens inside the function.

## Open Questions

1. **Expand key**: `Ctrl+H` (always-on, works with composer focused) vs. a
   bare `h` (only when composer is unfocused/empty)? Shipped: `Ctrl+H`.
2. **Default / step size**: `60` rows is a guess. Should it be `40` or
   `100`? Recommendation: ship `60`, tune after measurement.
3. **Indicator wording**: `↑ N earlier rows hidden — Ctrl+H show 60 more`
   vs. shorter `↑ N hidden`. Shipped: full text for discoverability.

## Out of Scope

- Agent-context "forgetting" / compaction. (Pure render-only hide.)
- DOM virtualization with variable row heights.
- Persisting `transcriptWindow` across Krypton restarts.
- Per-lane configurable defaults via TOML.
- Hide-by-turn (user→assistant boundary) granularity. The simpler
  hide-by-row count is sufficient for the stated performance goal.
- Backwards search through hidden rows (e.g. `/` to grep across hidden
  content). Hidden rows are still in `lane.transcript` so a future search
  feature can match them, but no UI is added here.

## Resources

N/A — purely internal change. The relevant prior art is in-repo:
`docs/94-acp-harness-render-performance.md` and `docs/95-acp-harness-scroll-stability.md`.
