# ACP Harness Right Rail — Implementation Spec

> Status: Implemented (v4 — overlay model)
> Date: 2026-05-20
> Milestone: Post-M-current polish (follow-up to specs 106, 107, 108, 109, 110)

## Problem

The active lane currently spawns multiple independent floating surfaces, each absolutely positioned to its own top-right offset:

- **Plan progress strip** — `position: absolute; top: 40px; right: 16px; z-index: 1` (`src/styles/acp-harness.css:2241`); persistent `this.planEl` created at `src/acp/acp-harness-view.ts:985–993`.
- **Lane peek** — `position: absolute; top: calc(28px + 36px); right: 12px; z-index: 3` (`src/styles/acp-harness.css:468`); rendered by `renderLanePeek()` (~2429).
- **Metrics breakdown overlay** — `position: absolute; right: 24px; top: 56px; z-index: 8` (`src/styles/acp-harness.css:236`); persistent `this.metricsOverlayEl`.

Each surface picks its own anchor coordinates. They overlap (screenshot motivating this spec shows peek clipping plan), and z-index decides who survives — not layout. The user has also confirmed this top-right area will host **future peripheral features**, so an ad-hoc cluster of free-floating overlays does not scale.

## Solution

Introduce a single **rail overlay container** that owns the top-right area of each active lane. The rail itself is absolutely positioned (does **not** reserve transcript width); inside the rail, slots stack vertically in flex column flow so they cannot overlap each other.

```
.acp-harness__lane--active                    (unchanged shell)
├─ .acp-harness__lane-head                    (unchanged)
├─ .acp-harness__lane-stats                   (unchanged)
├─ .acp-harness__lane-body                    (unchanged, full width)
├─ .acp-harness__lane-composer                (unchanged)
└─ .acp-harness__lane-rail                    (NEW — position: absolute, top-right, flex column)
    ├─ [data-slot="plan"]    → this.planEl reparented in
    ├─ [data-slot="peek"]    → peek element reparented in
    └─ [data-slot="..."]     → future feature slots
```

The rail floats above the transcript (same as today's overlays), so transcript width is preserved at all lane widths. The rail's flex column flow guarantees plan, peek, and future slots stack vertically with explicit gaps — no z-index choreography, no per-element top/right math.

Terminology: **rail** (a single contextual overlay column), not a sidebar, not a panel.

## Goals

1. Internal overlays inside the lane never overlap each other.
2. Transcript width is unaffected — no reserved space, no breakpoint problem.
3. Slot order is **vertical flex flow**, not z-index.
4. Future slots plug in by registering with the rail; no shell refactor required.
5. Existing keyboard commands (peek toggle, plan show/hide) work unchanged.
6. Minimum invasive: do not touch `.lane--active` flex shell, transcript body reuse, or composer.

## Non-Goals

- No reservation of transcript width. Transcript may still be visually occluded by the rail (same as today). Future polish (translucent background, dismiss key) is out of scope here.
- No change to plan/peek/metrics *content*. Only the parent and absolute-position anchoring change.
- No migration of metrics overlay in v1. It is wider (`clamp(420px, 38vw, 560px)`, all-lanes) than rail slot width and shows global content; it stays a standalone overlay.
- No modal overlay changes (memory drawer, help, lane picker, session picker).

## Affected Files

| File | Change |
|------|--------|
| `src/styles/acp-harness.css` | Add `.acp-harness__lane-rail` + `.acp-harness__lane-rail__slot` rules (~30 lines). Strip `position/top/right/z-index/width` from `.acp-harness__plan` (~2241) and `.acp-harness__lane-peek` (~468); they now inherit positioning from the rail. Remove the old `@media` rule hiding peek at narrow widths (~601–604). |
| `src/acp/acp-harness-view.ts` | Add a persistent `this.laneRailEl` per active lane (created lazily on first slot occupancy). On render, reparent `this.planEl` and the peek element into the rail. When neither slot has content, detach the rail (display none or remove). Update `renderLanePeek()` to append into the rail's peek slot rather than directly into `.lane--active`. |
| `src/acp/acp-harness-view.test.ts` | Add DOM-structure tests (empty rail absent; slot order; reparenting preserves element identity; refresh isolation). |
| `docs/109-acp-contextual-lane-peek.md` | Update positioning paragraph — peek lives inside `.acp-harness__lane-rail`, not directly under `.lane--active`. |
| `docs/PROGRESS.md` | Landing note. |

## Design

### Rail container

```css
.acp-harness__lane-rail {
  position: absolute;
  top: 36px;                 /* clears head (28px) + small gap */
  right: 12px;
  width: clamp(220px, 28%, 320px);
  max-height: calc(100% - 36px - 56px);   /* leaves room for composer below */
  z-index: 4;                /* above transcript, below modals (memory/help at 2–3 use `inset:0` and z-context resolves correctly) */
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;      /* slots opt back in; lets transcript catch clicks on empty areas */
  overflow: hidden;
}

.acp-harness__lane-rail__slot {
  pointer-events: auto;
  flex: 0 1 auto;
  min-height: 0;
  max-height: 50%;           /* default; opt-in modifiers below */
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.acp-harness__lane-rail__slot--primary { max-height: 70%; }
.acp-harness__lane-rail__slot--compact { max-height: 96px; }
```

### Slot occupancy & ordering

Render-time slot order is fixed in code (plan, peek, then future). The rail element is created lazily: if no slot has content, the rail is not attached to the DOM (or has `display: none`). Default v1 slots both render at the default `max-height: 50%`; future slots can opt into `--primary` or `--compact`.

### CSS overrides for reparented elements

When `this.planEl` lives inside the rail, its own absolute positioning would conflict. Override via scoped selector `.acp-harness__lane-rail .acp-harness__plan`:

| Existing rule (acp-harness.css:2241+) | Rail override |
|---|---|
| `position: absolute` | `position: relative` (keeps pseudo-element brackets anchored) |
| `top: 40px; right: 16px; z-index: 1` | unset |
| `width: clamp(240px, 28vw, 360px)` | `width: 100%; max-width: none` |
| `max-height: calc(100% - 56px)` | unset (slot's `max-height` governs) |
| `.acp-harness__plan-entries { flex:1 1 auto; overflow-y:auto }` (~2359) | unchanged (slot is height-bounded, so this resolves correctly) |
| `::before / ::after` corner brackets | removed — brackets dropped from both `.acp-harness__plan` and `.acp-harness__lane-peek` (no pseudo-element brackets remain on these elements) |

Same audit for the peek element — list its current absolute-positioning rules (acp-harness.css:468–605) and add a matching set of `.acp-harness__lane-rail .acp-harness__lane-peek { ... }` overrides at implementation time.

Both overrides are **scoped to inside the rail**, so the legacy rules continue to apply if the element were ever rendered outside the rail. (Not used in v1, but keeps the diff minimally invasive.)

### Render flow

Active-lane render currently happens around `src/acp/acp-harness-view.ts:2694–2710`:

1. After the lane body is appended, ensure `this.laneRailEl` exists. If not, create it once and store on the view.
2. Compute slot occupancy:
   - `planVisible` — existing condition for plan strip display.
   - `peekVisible` — `lanePeek.visible && currentLaneId != null`.
3. If any slot is visible:
   - Append `this.laneRailEl` to `laneEl` (idempotent — same element each time).
   - Reparent `this.planEl` into the rail's plan slot (or detach if `!planVisible`).
   - Reparent the peek element into the rail's peek slot (or detach).
4. If no slot is visible, detach the rail from the DOM.

The rail is a sibling of head/body/composer, **not** a wrapper. This keeps the existing flex shell intact and body-reuse logic untouched (`src/acp/acp-harness-view.ts:2640–2648, 2700–2708`).

`renderLanePeek()` (~2429) is updated to write into the peek slot inside the rail instead of into `.lane--active` directly. Refresh paths (`refreshMetricsRender` 2922–2942, plan updates 2952–2968) keep their existing behavior — they update the persistent elements, which happen to be parented inside the rail.

### Z-index map

| Surface | z-index |
|---|---|
| Transcript content / inline rows | (no z-index — default) |
| Plan overlay (legacy) | 1 (removed when migrated) |
| Lane peek (legacy) | 3 (removed when migrated) |
| **Lane rail (new)** | **4** |
| Metrics overlay | 8 (above rail — kept for v1) |
| Memory / help modal overlays | 2 / 3 with `inset: 0` (full-surface) |

Rail at 4 is above transcript and below the metrics overlay (v1 leaves metrics floating; if it ever migrates into rail, the z-index distinction goes away).

## Tests

`src/acp/acp-harness-view.test.ts` additions:

1. **No content → no rail in DOM** — render an active lane with neither plan content nor peek visible; assert `.acp-harness__lane-rail` is not attached.
2. **Peek-only rail** — set `lanePeek.visible = true`; assert rail attached, contains exactly one slot (peek), peek element is a descendant of rail.
3. **Multi-slot order** — set plan and peek visible; assert rail children in order plan, peek.
4. **Plan element identity preserved** — toggle plan off and back on; assert `this.planEl` is the same element instance both times (reparented, not recreated).
5. **Transcript body reuse** — switch active lane away and back; assert the SAME `.acp-harness__lane-body` instance is used (regression guard for 2640–2648, 2700–2708).
6. **Rail is sibling, not ancestor of body** — assert `.acp-harness__lane-body` is not inside `.acp-harness__lane-rail`.
7. **Refresh isolation** — call plan/peek refresh paths; assert `.acp-harness__lane-body` was not rebuilt.
8. **Source-level CSS regressions** — read `src/styles/acp-harness.css`; assert: the old `@media` peek-hide rule at 601–604 is gone; rail-scoped overrides for `.acp-harness__plan` exist (`width: 100%` inside rail); `.acp-harness__lane-rail` rule exists with `position: absolute`.

## Open Questions

1. **Pointer-events on empty rail areas:** Spec uses `pointer-events: none` on the rail container with `auto` on slots, so click-through reaches transcript content under the rail. Verify this doesn't break peek's own click affordances (lock/dismiss buttons in spec 109).
2. **Translucent background?** Today the overlays have their own opaque backgrounds. The rail container itself has no background, so it's invisible between slots. If future feature wants a unified glass background behind the whole rail, add later — not v1.
3. **Metrics migration:** Out of scope (see Non-Goals). Revisit when a compact rail-fit metrics variant is designed.
4. **Future slot priority:** v1 ships 2 default-sized slots. When a third slot lands, that feature's spec must decide which slot becomes `--primary` / `--compact`. No predetermination here.

## Rollout

1. Add CSS for `.acp-harness__lane-rail` + slot rules.
2. Create `this.laneRailEl`, reparenting logic in render flow.
3. Add rail-scoped CSS overrides for plan and peek.
4. Remove old `@media` peek-hide rule.
5. Update `renderLanePeek()` to write into rail.
6. Add tests.
7. Update spec 109 cross-ref + `docs/PROGRESS.md`.

Estimated diff: ~30 lines CSS, ~60 lines TS (mostly in `renderActiveLane`), ~80 lines tests.
