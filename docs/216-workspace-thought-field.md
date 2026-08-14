# Peek Thought Stream — Implementation Spec

> Status: Implemented (pivoted 2026-08-13 — own rail slot)
> Date: 2026-08-13
> Milestone: M8 — Polish
> Supersedes: thought-inside-peek (same-day first landing) and the earlier workspace Thought Field wallpaper drafts

## Problem

Live model thinking is easy to miss: it lives in a clamped transcript row, and collapsed lanes show only a “thinking…” chip. Stuffing that stream into the existing lane-peek card also **widens the peek** (and breaks alignment with the 320px goal/plan pins). Thought needs a home that does not change peek, goal, plan, or queue.

## Solution

Stream thought into a **new rail slot** (`thoughtSlotEl` / `[data-slot="thought"]` / `.acp-harness__lane-thought`). Peek, pins, plan, queue, and thought share the original 320px column. Thought is a sibling card, always independent of peek hide/show.

- The thought card is its own chrome (header + clamped GFM body). It is never mounted inside `.acp-harness__lane-peek`.
- Source: peeked lane’s thought when a 109 peek card is actually showing and that lane has thought; otherwise the active lane. Hide the slot when neither has content.
- Hide / `Esc` dismiss a ranked 109 peek only. They never hide the thought slot.
- Reuse `installThoughtVeil` / `renderPeekThoughtMarkdown`. Concise mode still hides transcript thought rows; the thought slot stays.

Wallpaper remains out of scope.

## Research

- Peek (spec 109/118) is a hideable 320px status card for one non-active lane. Goal/ticket pins (148/194) share that 320px column. Widening peek to 640px for thought made peek and goal different widths.
- Spec 111’s rail is already a flex column of independent slots. Queue (136) is the precedent for “new slot, do not stuff into peek.”
- Thought already streams as transcript `kind: 'thought'`. Empty live deltas use the veil. Last sealed thought has no expiry.

## Prior Art

| Surface | Behavior | Notes |
|---------|----------|-------|
| Spec 109 peek | Inspect one hidden lane without switching. | Unchanged card. Thought is no longer inside it. |
| Spec 136 queue | Own bottom rail slot, independent of peek. | Same “new slot, don’t widen peek” pattern. |
| Transcript thought row | Clamped live body, veil, drop if empty at seal. | Reused renderer. |

**Krypton delta** — thought is a rail card, not a wallpaper and not a peek payload.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/lane-peek.ts` | `renderLaneThought` / `patchLaneThoughtCard` / `resolveLaneThoughtSnapshot`. Peek render no longer embeds a thought body. |
| `src/acp/harness-markdown.ts` | Unchanged GFM helpers (`peekThoughtMarkdownHtml` / `renderPeekThoughtMarkdown`). |
| `src/acp/acp-harness-view.ts` | New `thoughtSlotEl`. `renderLaneThought()` independent of `renderLanePeek()`. Stream patches the thought card only. |
| `src/acp/acp-harness-view.test.ts` | Source + content resolution: peek has no thought node; rail stays 320px. |
| `src/styles/acp-harness.css` | `.acp-harness__lane-thought*` + thought slot height only. Rail stays 320px. |
| `docs/109-acp-contextual-lane-peek.md` | Thought is a sibling slot, not a peek body. |
| `docs/72-acp-harness-view.md` | One line under peek. |
| `docs/111-harness-right-rail.md` | Rail stays 320px; thought is another slot in that column. |

## Design

### Snapshot

```ts
// extra fields on LanePeekSnapshot
thought: {
  phase: 'delta' | 'veil' | 'seal';
  text: string;
} | null;
```

`thought` is the lane’s current streaming thought item, else the last sealed thought (no time window), else `null`.

### Slot occupancy

```
.acp-harness__lane-rail          320px
  [data-slot="pins"]             320px
  [data-slot="plan"]             320px
  [data-slot="peek"]             320px   — spec 109 card only
  [data-slot="thought"]          320px   — spec 216 card only
  [data-slot="queue"]            320px
```

### When the thought slot is shown

1. A 109 peek card is in the DOM **and** that lane has thought → thought card for the peeked lane.
2. Else the active lane has thought → thought card for the active lane.
3. Else hide the thought slot.

Peek hide / `Esc` / no 109 candidate never empty this slot by themselves. Ranking still picks the peek card independently.

### Render

- `.acp-harness__lane-thought` with a name header and `.acp-harness__lane-thought-body`.
- Body max-height ≈ 10 line-heights, `overflow: auto`, pin to latest line after layout.
- Live and sealed: GFM via `marked` (same parser as sealed assistant rows). Veil: `installThoughtVeil`. Empty seal: hide the slot (no content).
- Same-lane refresh patches the body — do not `replaceChildren` the card on every chunk.
- Ghost type. Lane accent only on the name. No caret, grid, or wallpaper motion.
- `prefers-reduced-motion`: veil is the static word `thinking`.

### Keybindings

None new. Existing peek palette actions still apply only to the 109 peek card.

### Configuration

None.

## Edge Cases

- Solo lane, idle → no peek, no thought card.
- Solo lane thinking → thought card only; peek stays hidden.
- Two lanes thinking, one peeked → thought card follows the peeked lane if it has thought; else active.
- Hide peek → thought falls back to the active lane (or hides if the active lane has none).
- Concise mode → transcript thought hidden; thought slot remains.
- Native webview / other window types → unchanged.

## Open Questions

None.

## Out of Scope

- Workspace `z-index: 0` canvas, ViewBus ingest, `Leader .`, footer segment, `[thought_field]` TOML.
- Painting under terminal glass.
- Pi-agent (no `thought_chunk`).
- Showing every busy lane’s thought at once.

## Resources

- [docs/109-acp-contextual-lane-peek.md](109-acp-contextual-lane-peek.md) — peek slot, ranking, keyboard
- [docs/111-harness-right-rail.md](111-harness-right-rail.md) — rail slots
- [docs/136-acp-harness-prompt-queue.md](136-acp-harness-prompt-queue.md) — precedent for an independent rail slot
- [src/acp/harness-markdown.ts](../src/acp/harness-markdown.ts) — GFM / veil
- [docs/157-harness-concise-mode.md](157-harness-concise-mode.md) — transcript hides `thought`
