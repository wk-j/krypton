# Window Status Bar Lane Strip — Implementation Spec

> Status: Implemented (rev 2 — explicit 16×16 logo viewport; static magnification)
> Date: 2026-08-14
> Amended (rev 2, 2026-09-02): the active logo no longer runs a scale/overshoot keyframe when its footer node is rebuilt. Composer typing and other chrome refreshes can therefore never replay motion against the content window. The outer `<svg>` now declares `viewBox="0 0 16 16"` plus `width`/`height` so backend symbols render from a stable square viewport instead of relying on SVG defaults.
> Milestone: M9 — harness observability

## Problem

Which harness lane is currently active is only legible *inside* the ACP Harness view — from
the expanded lane section, the zen-mode rail, or the window's lane accent tint. When the
harness is scrolled, zen-collapsed, or its window is not the focused one, the human has no
ambient answer to "which lane am I driving in this window, and what else is running here?".

The window already has a rail for exactly this class of fact: `.krypton-window__footer`, the
28px status bar at the bottom of every window's chrome, which spec 153 uses for the focused
view's AI credit quotas. Lane identity belongs there, next to the quotas that describe the
same lanes — **not** in the workspace footer, which is one shared rail for the whole
workspace. A window is what hosts a harness, so each window reports its own lanes.

## Solution

Add a **lane strip** to the window status bar: one backend logo per lane of the ACP Harness
in this window's active tab's focused pane, in lane order, with the active lane rendered in
its lane accent and carrying its display name; the others are dimmed icon-only marks.

The strip follows focus *within the window*, exactly like the spec-153 quota readout beside
it: the compositor reads the focused pane's `ContentView.getLaneMarks()` and subscribes to
`onLaneMarksChange()`. Two harness windows therefore each answer for themselves, with no
global "which harness wins the highlight" rule to invent. Display-only — the footer gains no
keybinding; lane switching stays where it is (`⌘P` lane picker, `⌃1..9`).

## Research

- **The window footer already has this exact publisher pattern.** Spec 153's AI credit status
  (`syncWindowUsageStatus` → `renderWindowUsageStatus`, `compositor.ts`) follows the active
  tab's focused pane, pulls `ContentView.getUsageProviders()`, subscribes through
  `ContentView.onUsageProvidersChange()`, renders into `.krypton-window__footer`, and tears
  the subscription down in `closeWindow()`. The lane strip is the same shape with a different
  payload, so both are now driven from one `syncWindowFooter(win)` called from the four
  existing sync points (tab visibility, window create ×2, pane focus change).
- **The lane roster is already computed.** `controlLaneList()` (`acp-harness-view.ts`) builds
  essentially this payload for the control API, and `render()` is the single RAF-coalesced
  render entry that already calls `renderTriageGaugeEl()`. A deduped
  `notifyLaneMarksChanged()` alongside it costs a string compare per frame.
- **The logos exist and are already lane-identity-correct.** `BACKEND_LOGO_SVG_DEFS` +
  `backendLogoId()` (spec 125) give a `<symbol>` per backend that recolours via
  `currentColor`; `laneAccent(index)` (spec 142/215) gives the per-lane hue the window chrome
  and rail already use, so the status bar agrees with the harness on lane colour.
- **Constraint discovered — the symbol defs were injected per harness view**
  (`acp-harness-view.ts` appended them into `this.element`). The window footer is chrome: a
  sibling of the perspective wrapper, outside the harness view's subtree. Two harness panes
  also injected duplicate `#krypton-logo-*` ids. Both are fixed by hoisting injection into one
  document-level idempotent helper (`ensureHarnessSymbolDefs()`) that the harness view and the
  compositor both call.
- **Rejected — the workspace footer** (`docs/121-workspace-status-bar.md`). It was the first
  implementation and it was wrong: one shared rail cannot say "this window's lanes", so with
  two harness windows it needs an invented tie-break (a "current harness", sticky across focus
  moves) to avoid showing two highlights, and the answer it gives is then about the workspace
  rather than about the window you are looking at. Per-window has no tie-break to invent: the
  window that hosts the harness shows that harness's lanes, and a window with no harness shows
  nothing.
- **Alternative considered — the window titlebar** instead of the footer. Rejected: the
  titlebar is already dense with title, tab affordances, and the header oscilloscope, and lane
  identity is status, not identity-of-window. The footer is the status rail, and it puts the
  lane marks adjacent to the AI quotas that describe the very same lanes.
- **Alternative considered — encode lane status (busy/perm/error) in the strip.** Out of
  scope: the request is identity. Status already has colour language inside the harness (rail,
  lane heads), and duplicating it on the window rail would compete with the notification
  control that shares this footer. Deferred, not designed away.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| tmux | Status line renders the full window list; `window-status-format` for inactive entries, `window-status-current-format` + `window-status-current-style` (e.g. `bg=red,fg=white,bold`) for the active one | The canonical "list them all, restyle the current one" status-bar idiom |
| Zellij | `tab-bar`/`status-bar` plugins render every tab; third-party bars (`zjstatus`, `zellij-compact-bar`) expose separate `tab_active` / `tab_normal` styling and `active_color` / `inactive_color` | Same idiom, expressed as two styles over one list |
| iTerm2 | Componentized status bar can be configured **per split pane** rather than per window, so each pane reports its own job/CWD | The direct precedent for scoping the status rail to the thing it describes instead of the whole app |
| VS Code | Status bar shows a *single* remote/context indicator, not a roster; the list lives in the sidebar | Rejected model — a single "current lane" chip loses the "what else is running" half of the ask |
| Krypton — live-assist (spec 208) | `.live-assist__lanes` strip: one button per lane, `aria-selected='true'` gets bright amber + tint + `inset 0 -2px 0` underline | Krypton's own answer to this problem in the auxiliary webview — same semantics, minus the underline: live-assist has a 35px click surface, this is a 28px read-only rail |
| Krypton — zen rail (spec 80/125) | `.acp-harness__rail-entry--active` over a per-lane accent | Internal precedent for "active lane = full accent, others dimmed" |
| Krypton — AI credit status (spec 153) | Focused view's quotas rendered into `.krypton-window__footer` | The window-scoped footer contract this spec reuses verbatim |

**Krypton delta** — matches the tmux/Zellij convention (render all, restyle the active one)
and Krypton's own live-assist strip, but diverges on three points: it is **icon-first**
(backend logo, name only for the active lane) because the rail is 28px and the human is
keyboard-only, so the strip is a glance target and never a click target; it is **static**
(no pulse, no spinner) per the footer's standing no-motion rule; and it is **flat** — accent
colour plus a background tint, with no border box, no underline, and no left-edge rail.

## Affected Files

| File | Change |
|------|--------|
| `src/window-footer-lanes.ts` | **New.** `HarnessLaneMark` + pure helpers: cap/overflow, repaint key, a11y label |
| `src/window-footer-lanes.test.ts` | **New.** Unit tests for the helpers |
| `src/types.ts` | `ContentView.getLaneMarks?()` + `onLaneMarksChange?()` |
| `src/acp/acp-harness-view.ts` | Implement both hooks; `notifyLaneMarksChanged()` (deduped) from `render()`; use the shared defs helper |
| `src/acp/harness-icons.ts` | New `ensureHarnessSymbolDefs()` — idempotent document-level `<defs>` injection |
| `src/compositor.ts` | `syncWindowFooter()` (usage + lanes), `syncWindowLaneStrip()`, `renderWindowLaneStrip()`, `buildWindowLaneMark()`, teardown in `closeWindow()` |
| `src/styles/window.css` | `__lane-strip`, `__lane`, `__lane--active`, `__lane-logo`, `__lane-name`, `__lane-more` |
| `docs/153-window-ai-credit-status.md` | Note the shared window-footer sync path |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | The window footer's second readout and its flow |
| `docs/02-functional-requirements.md` | New FR for the per-window lane roster |
| `docs/README.md` | Index entry 218 |

## Design

### Data Structures

```ts
// src/window-footer-lanes.ts
/** spec 218: one lane's presentation identity in a window's status-bar strip.
 *  Presentation-only — no status, no counts (those have their own indicators). */
export interface HarnessLaneMark {
  /** Stable lane id; the strip's DOM key. */
  id: string;
  /** e.g. "Claude-1" — rendered as text for the active lane only. */
  displayName: string;
  /** Backend id → `backendLogoId()` → `#krypton-logo-*` symbol. */
  backendId: string;
  /** Lane accent CSS value (`laneAccent(index)`), applied inline as
   *  `--krypton-lane-accent`. Lane 1's `var(--krypton-window-accent, #0cf)`
   *  resolves against this window's accent — the footer is inside the window's
   *  cascade, so lane 1 agrees with the window chrome. */
  accent: string;
  active: boolean;
}

export const LANE_STRIP_MAX = 8;

/** Cap to the icon budget, reporting the dropped count for the `+N` tail.
 *  Order is the harness's own lane order, so a mark's position matches the
 *  `⌃1..9` key that switches to it. */
export function capLaneMarks(
  lanes: readonly HarnessLaneMark[],
  max?: number,
): { marks: HarnessLaneMark[]; overflow: number };

/** Identity of the rendered strip — rebuild the DOM only when it changes. */
export function laneStripKey(marks: readonly HarnessLaneMark[], overflow: number): string;

/** Screen-reader label, e.g. "harness lanes: Claude-1 (active), Grok-1". */
export function laneStripLabel(marks: readonly HarnessLaneMark[], overflow: number): string;
```

```ts
// src/types.ts — ContentView additions
/** spec 218: lanes this view is driving, for its window's status-bar strip. */
getLaneMarks?(): readonly HarnessLaneMark[];
/** Subscribe to lane-roster changes. Returns an unsubscribe function. */
onLaneMarksChange?(cb: () => void): () => void;
```

### API / Commands

No Tauri commands, no IPC, no `ViewBus` signal. Two optional `ContentView` methods and one
exported helper (`ensureHarnessSymbolDefs()`); everything else is internal to the compositor.

The strip deliberately does **not** ride the `ViewBus`. The bus carries workspace-level
signals for the workspace footer; this is window chrome describing the pane the window is
focused on, which is what the `ContentView` interface is for (and what spec 153 already does
at the other end of the same rail).

### Data Flow

```
1. Harness lane roster changes (lane added/removed/renamed, ⌃1..9 or ⌘P moves the
   active lane)
2. The harness's RAF render() calls notifyLaneMarksChanged()
3. That serializes id/backend/name/accent/active into a key and returns early when
   unchanged — status is NOT in the key, so a busy→idle churn never repaints
4. On change it invokes the compositor's per-window listener
5. renderWindowLaneStrip() caps the roster at 8, compares laneStripKey against the
   window's rendered key, and rebuilds the ≤9 nodes only when it differs
6. Each mark is a <use href="#krypton-logo-*"> resolved from the document-level
   symbol defs (ensureHarnessSymbolDefs), coloured by an inline
   --krypton-lane-accent; only the active mark renders a name
7. Focus moving to another pane, a tab switch, or a window create calls
   syncWindowFooter(win) → syncWindowLaneStrip(win), which resubscribes to the
   newly focused view and re-renders (a terminal reports no lanes → strip removed)
8. closeWindow() drops the subscription and the cached strip key
```

### Keybindings

None. The strip is a readout; lane switching keeps its existing bindings (`⌘P` picker,
`⌃1..9`).

### UI Changes

Pinned to the window footer's **right edge**, past the notification control and far right of
the spec-153 quotas. (Since spec 219 the strip's immediate left neighbour is the project badge,
whose drop cap is magnified the same way — the two magnified marks sit together on purpose, so
"which project" and "which lane" are read in one glance. They cannot collide: the badge scales
`font-size`, so its box is its painted width, and the logo's transform overgrowth is reserved by
its own `margin-inline`. The badge also takes over the right-pinning `margin-left: auto`, leaving
the strip a plain 10px gap whenever a badge is present. Since spec 220 the diff stat sits between
the two at `order: 2`, magnified by the same factor — so the rail's right end is one oversized
phrase, *project · volume · lane*. It never claims the free space: it cannot appear without the
badge, so the pushing arrangement below is unchanged.)

```html
<div class="krypton-window__footer">
  <div class="krypton-window__usage-status">…</div>
  <!-- appended last; `order: 3` also keeps it right of the notification
       control (which re-appends itself into the focused window's footer), of
       the spec-219 project badge at `order: 1` and the spec-220 diff stat at 2 -->
  <div class="krypton-notif">…</div>
  <div class="krypton-window__lane-strip"
       aria-label="harness lanes: Claude-1 (active), Grok-1">
    <span class="krypton-window__lane krypton-window__lane--active"
          style="--krypton-lane-accent: #8effb0" title="Claude-1 · claude · active lane">
      <svg class="krypton-window__lane-logo" viewBox="0 0 16 16" width="16" height="16"><use href="#krypton-logo-claude"/></svg>
      <span class="krypton-window__lane-name">Claude-1</span>
    </span>
    <span class="krypton-window__lane" style="--krypton-lane-accent: #5ce6a8"
          title="Grok-1 · grok">
      <svg class="krypton-window__lane-logo" viewBox="0 0 16 16" width="16" height="16"><use href="#krypton-logo-grok"/></svg>
    </span>
  </div>
</div>
```

Right-alignment is held by three rules rather than one, because exactly one item in the rail may
claim the free space with `margin-left: auto` — two competing auto margins split it and strand the
leftmost one mid-rail. Whichever of `notif → project badge → strip` is leftmost does the pushing
and the rest trail it with a fixed gap, so the strip stays against the edge in every combination:

| Rail contents | Who pushes | Strip's margin-left |
|---------------|-----------|---------------------|
| strip alone (unfocused window, decayed notification, terminal pane) | the strip | `auto` |
| badge + strip | the badge | `10px` — `:has(.krypton-window__project)` |
| notification + (badge) + strip | the notification | `10px` — `:has(.krypton-notif:not(.krypton-notif--empty))` |

The `:not()` matters because a decayed notification is `display: none` (spec 40): it is still in
the DOM, so a bare `:has(.krypton-notif)` would hand the strip a `10px` margin with nothing left
in the rail to push it right.

**Three cues mark the one active lane** — so identification never rests on colour alone (every
lane already *has* a colour, and lane hues repeat past 13 lanes):

| Cue | Active lane | Every other lane |
|-----|-------------|------------------|
| **Size** | logo magnified `2.9×` out of the rail, macOS-Dock style | `1em`, on the rail's baseline |
| **Name text** | display name rendered (`Claude-1`) | icon only — no text at all |
| **Weight** | full-strength lane accent + 12% tint of the same colour | `opacity: .45`, no tint |

The name is the load-bearing cue: **exactly one mark in the strip ever has text**, which reads
in grayscale, at a glance, and without knowing the palette. No underline, no border box, no
left rail — the chip is flat, one surface: colour, tint, size, and text do all the work.

#### Dock-style zoom on the active mark

The active logo magnifies out of the 28px rail the way a Dock icon rises off the dock, so the
driven lane is readable across the screen without reading the name. Two deliberate departures
from the Dock:

- **Anchored on the active lane, not a pointer.** The compositor is keyboard-driven, so the
  bump moves with `⌃1..9` / `⌘P`, not with the mouse.
- **No neighbour falloff curve.** The Dock has no hierarchy, so its magnification is a pure
  cursor affordance; this strip *does* have one, and growing a deliberately dimmed lane
  (spec 215) would contradict the de-emphasis that dimming is carrying.

Mechanics, all in `src/styles/window.css`:

| Concern | Rule | Why |
|---------|------|-----|
| Growth | `transform: scale(var(--krypton-lane-zoom, 2.9))` | A transform never reflows the rail, so quotas and notification do not shift when the active lane changes. |
| Direction | `align-self: flex-end` + `transform-origin: bottom center` | Puts the glyph on the chip's floor and sends every pixel of growth *upward*, over the pane — never down through the window's bottom edge. |
| Room | `margin-inline: 10px` | A transform is invisible to layout; this is what reserves the ≈10px of horizontal overgrowth per side so the glyph cannot land on its neighbour. |
| Motion | None | Magnification is a standing identity cue. A rebuilt footer node paints directly at its final scale, so typing or chrome refreshes cannot replay motion or shake the window. |
| SVG viewport | `viewBox="0 0 16 16" width="16" height="16"` | Keeps every backend symbol in a stable square coordinate system before CSS applies the `1em` box and static scale. |

At the default 28px footer and 11px chrome font this renders a glyph about as tall as the rail
itself, whose ink clears the rail's top edge by ~6px (measured). `--krypton-lane-zoom` is
declared on `.krypton-window__lane-strip` so the factor is tunable in one place — the right
value depends on the rail height, which is themeable via `--krypton-footer-height`.

- Logo `1em` square, `currentColor`, `3px` gap; strip is `flex: none`, so it never shrinks —
  the quotas at the other end of the rail (`min-width: 0; overflow: hidden`) compress first.
  That ordering is deliberate: which lane this window is driving outranks how much credit is
  left.
- Overflow past 8 lanes renders `+N` in the muted footer grey.
- The whole strip is removed from the DOM when the focused pane has no lanes, so a
  terminal-only window's rail is unchanged.

### Configuration

None.

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Window has no harness (terminal only) | `getLaneMarks` absent → empty roster → the strip element is removed; the footer looks exactly as it did before this spec |
| Two harness panes in one window | The strip follows the **focused** pane, like the quotas beside it — one roster, one highlight, and it changes as pane focus moves |
| Two harness windows | Each renders its own roster and its own highlight; neither is suppressed. This is the whole reason the strip is per-window |
| Harness pane closed | `closePaneInTab` → `updatePaneFocusIndicator` → `syncWindowFooter` re-renders from the newly focused pane |
| Window closed | `closeWindow()` fires the lane unsubscribe and drops the cached key |
| Focus moves to a background tab's harness | Only the *active* tab's focused pane is read, so a hidden tab's lanes never show |
| More than 13 lanes | Lane accents repeat (`laneAccent` wraps the palette) — which is exactly why the name cue exists and colour is not load-bearing |
| More than 8 lanes | First 8 marks plus `+N`; the active lane can therefore be inside the `+N` tail — acceptable, since the harness view itself is the full roster and 8 lanes in one harness is already far past normal |
| Unknown/new backend id | `backendLogoId()` already falls back to `krypton-logo-omp` |
| Rapid status churn (busy → idle → busy) | The dedupe key excludes status, so nothing notifies and the strip never churns |
| Two harness panes both injecting defs | `ensureHarnessSymbolDefs()` is idempotent on a document-level id, removing today's duplicate-id situation |

## Out of Scope

- Lane **status** encoding in the strip (busy/permission/error colouring or spinners).
- Making the strip interactive (click-to-switch) — the footer is not a click surface.
- Any change to the harness's own rail, lane heads, or the live-assist lane strip.
- Any lane readout in the **workspace** footer — rejected above, deliberately not built.
- Per-lane counts (tools, context, inbox) — those already have their own surfaces.
- Showing lanes from a *remote* harness (Xenon / control API).

## Resources

- [tmux status bar — `window-status-format` / `window-status-current-format` / `window-status-current-style`](https://tao-of-tmux.readthedocs.io/en/latest/manuscript/09-status-bar.html) — the "render every window, restyle the current one" idiom the strip follows.
- [Zellij `status-bar` alias](https://zellij.dev/documentation/status-bar-alias.html) — the bottom status plugin's role and expected contents.
- [zjstatus](https://github.com/dj95/zjstatus) — separate `tab_active` / `tab_normal` formatting, confirming the two-style approach.
- [iTerm2 status bar](https://iterm2.com/documentation-status-bar.html) — per-pane status bar configuration, the precedent for scoping the rail to what it describes.
- Internal: `docs/153-window-ai-credit-status.md` (the window-footer contract this reuses), `docs/40-notification-overlay.md` (the footer's other occupant), `docs/125-lane-rail-disambiguation.md` (logo symbols), `docs/208-harness-live-assist-mode.md` (lane strip precedent), `docs/215-stacked-lane-hierarchy.md` (dim-but-keep-the-hue rule).
