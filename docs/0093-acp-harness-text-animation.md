# ACP Harness Text Animation (per-line stagger reveal) — Implementation Spec

> Status: Implemented
> Date: 2026-05-08
> Milestone: ACP Harness polish

## Problem

When agent messages render in the ACP harness transcript, each multi-line block flashes onto the screen as a single block. With the existing `pretext`-driven layout we already split messages into discrete `.acp-harness__pretext-line` elements, but they appear simultaneously, which feels abrupt and makes it hard for the eye to track what content was just appended during streaming.

## Solution

Add a small, CSS-only per-line stagger reveal (opacity + 2px translateY) to `.acp-harness__pretext-line` nodes when they are first laid out. Reuse the existing `layoutPretextRows` pipeline — no new state, no JS animation loops, no canvas. Only newly-introduced lines animate; pre-existing lines (re-laid out due to resize / re-render / streaming chunk arrival) do not re-animate.

## Research

- `src/acp/acp-harness-view.ts:2324` `layoutPretextRows` already rebuilds `.acp-harness__pretext-line` children from `prepareWithSegments` + `layoutWithLines`. It runs in a RAF debounce (`schedulePretextLayout`) and is called on resize, lane switch, and after every transcript mutation.
- This re-layout fires repeatedly during streaming: each new chunk → `textContent` is replaced → all child line nodes are recreated. A naive CSS animation on every line would re-trigger on every chunk and look like a strobe.
- pretext gives stable line text only — there is no semantic line identity across re-layouts, so we cannot animate exact "diff" lines. We approximate: track the previous line count per row and only animate lines whose index ≥ prevLineCount.
- `prefers-reduced-motion: reduce` must disable the animation (accessibility + parity with the rest of `acp-harness.css`, which respects this for the typing dot indicator).
- Krypton platform note: WAAPI / CSS animations on transparent WKWebView are fine; only `backdrop-filter: blur()` is the documented gotcha. No risk here.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Warp | Per-block fade-in for AI replies | Whole block fades, no per-line stagger |
| Claude.app | Token-level streaming reveal | Token-granularity; needs streaming hooks Krypton does not have |
| Zed Assistant | Block-level fade | Single block opacity 0→1 |
| iTerm2 / WezTerm | None | Plain instantaneous render |

**Krypton delta:** per-line stagger (not per-block, not per-token) — fits Krypton's terminal-line-grid feel and is achievable with zero JS animation work because we already have `<div class="acp-harness__pretext-line">` per line. Honors `prefers-reduced-motion`.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | `layoutPretextRows` tags newly-added lines with `data-anim="in"` and `style="--i:<n>"`; skips lines that existed in the previous layout. Stores `prevLineCount` in `row.dataset.lineCount`. |
| `src/styles/acp-harness.css` | Add `@keyframes acp-harness-line-in` and rule `.acp-harness__pretext-line[data-anim="in"]`; gate behind `@media (prefers-reduced-motion: no-preference)`. |
| `docs/PROGRESS.md` | Recent Landings entry. |

No new types, no new IPC, no backend changes.

## Design

### Per-row delta tracking

In `layoutPretextRows`, before clearing `row.textContent`:

```ts
const prevCount = parseInt(row.dataset.lineCount ?? '0', 10) || 0;
```

After computing `lines`, when appending each `lineEl`:

```ts
if (i >= prevCount) {
  lineEl.dataset.anim = 'in';
  // stagger index relative to first newly-introduced line in this batch
  lineEl.style.setProperty('--i', String(i - prevCount));
}
```

Then update `row.dataset.lineCount = String(lines.length)` after the loop.

Result:
- First paint of a row (prevCount = 0): all lines animate, staggered 0..N.
- Streaming chunk grows from 5 → 8 lines: only lines 5,6,7 animate, with `--i` 0,1,2.
- Pure resize re-layout where line count is identical: no lines animate. (If wrapping changes the count, only the *new* tail lines animate, which is acceptable.)
- Lane switch / re-render: rows are torn down and rebuilt by transcript render, so `dataset.lineCount` resets naturally. Animation will replay on first layout — this is desirable, it provides visual continuity when switching lanes.

### CSS

```css
@keyframes acp-harness-line-in {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: no-preference) {
  .acp-harness__pretext-line[data-anim="in"] {
    animation: acp-harness-line-in 180ms ease-out both;
    animation-delay: calc(var(--i, 0) * 14ms);
  }
}
```

- 180ms duration, 14ms stagger → an 8-line block resolves in ~290ms total.
- `both` fill so the start state applies before delay fires (avoids flash).
- `ease-out` — matches the existing harness aesthetic (no overshoot).

### Cap on stagger

For very long blocks (e.g., a 200-line tool output dump), 14ms × 200 = 2.8s feels sluggish. Cap stagger at 24 lines: when `i - prevCount >= 24`, set `--i` to `24` (lines past the cap all animate together at the tail).

## Edge Cases

- **Reduced motion:** Animation disabled by media query; lines render instantly. `data-anim` attribute still set but harmless.
- **Empty line (` ` placeholder):** Animates the same as content lines — fine, visually a small bump.
- **Failed pretext layout (catch branch):** Row falls back to plain `textContent`, no `.acp-harness__pretext-line` children, no animation. `dataset.lineCount` not updated; on next attempt prevCount stays 0.
- **Markdown rows:** Not affected — they use `.acp-harness__msg-body--markdown`, not `.acp-harness__pretext-line`.
- **Plan panel, memory overlay:** Not affected — different DOM trees.
- **Resize while streaming:** New stream chunk + width change in same RAF — line count change drives which lines animate; previously-existing lines do not. Acceptable.

## Out of Scope

- Token-level streaming reveal (would require backend stream-event hooks).
- Plan panel height morph, memory overlay shrink-wrap reveal, FLIP transitions (separate specs if pursued).
- Animating markdown blocks.
- User-configurable stagger speed.

## Resources

- Local pretext source: `/Users/wk/Source/pretext` — confirmed `layoutWithLines` returns stable `lines[]` per call; no cross-call line identity.
- `src/acp/acp-harness-view.ts:2314-2348` (`schedulePretextLayout`, `layoutPretextRows`).
- `src/styles/acp-harness.css:616-619` (`.acp-harness__pretext-line`).
- MDN [`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) — accessibility convention used here.
