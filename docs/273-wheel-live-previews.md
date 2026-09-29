# Wheel Live Previews — Implementation Spec

> Status: Implemented
> Date: 2026-09-29
> Milestone: M3 — Compositor & Windows
> Revises: [272 — Wheel Layout](./272-wheel-layout.md) ("Scaling live windows onto the arc was rejected")

## Problem

Wheel cards (spec 272) show a schematic: pane dividers, a content glyph, and a text silhouette of each terminal. The user wants what the reference shows: each card is a **live picture of the real window**, updating as it runs.

## Solution

Reuse Stage's proven technique (spec 245): each nearby card is the **real window element**, visually scaled, leaned, and translated onto its card pose. There is no thumbnail DOM and no bitmap capture. Only the six cards nearest the active one are live (±3 slots); cards further out keep the schematic. This bounds GPU memory to the same order as Stage's five-card shelf. `WheelRail` owns every preview transform in its existing rAF loop. When focus changes, the rail also runs the **dock morph**: the incoming window flies from its card into the main frame, and the outgoing one flies back to its card. The morph composes with the wheel's rotation instead of fighting it. The active slot keeps its schematic card, because the live window is the main frame beside it.

## Research

- **Renderer.** Krypton loads only `FitAddon`. xterm.js 6 therefore uses its default DOM renderer, not WebGL (docs 04 says WebGL, but the code does not match). There is no terminal canvas to copy with `drawImage`, so a bitmap pipeline would need DOM rasterisation (html2canvas-style). That is heavy, lossy, and would never be truly live. Rejected.
- **Stage precedent** (`applyStagePlacement`, `compositor.ts`). Every window keeps unscaled `baseBounds` (left/top/width/height from `applyBounds`). A shelf preview adds only `transform: translate(…) scale(k)`, so PTY cols/rows never change. `fitAll` skips hidden windows. This is proven in production with 5 live previews.
- **GPU cost.** WebKit's `RenderLayerCompositor` clamps a layer's rasterization scale to [1, 5]. It can raise resolution but never lower it, so a scaled-down window keeps a **full-resolution backing store**. A 1316 × 1077 main frame at 2× DPR is 2632 × 2154 × 4 B ≈ **23 MB per live preview**. Six previews ≈ 136 MB. Ten would be ≈ 230 MB, the figure spec 272 used to reject the idea. The ±3 cap is the fix.
- **Paint cost.** Hidden windows (`visibility: hidden`) do not paint today. A live preview repaints whenever its terminal writes, like a Stage shelf card. Idle CPU is unchanged: no output, no paint. The rail still stops its rAF loop when nothing moves.
- **Clipping.** Previews are workspace children, not rail children, so the rail's `overflow: hidden` does not clip them. A card that leans past the rail's right edge would overlap the main frame. Beyond ±3 slots cards do cross that edge (checked at 280, 363, and 400px rails). Within ±3 they stay inside. The edge rule below covers short rails.
- **Stacking.** `.krypton-wheel` is `z-index: 1`, which makes it a stacking context, so previews cannot slot between its canvas and its cards. Dropping the root's z-index lets the canvas, the preview windows, and the cards/labels interleave in the workspace stacking context.
- **Native webviews** (spec 102) are OS views above the DOM and cannot be transformed. Wheel already suspends them in inactive windows, so a preview shows the pane's suspended placeholder. Stage does not do this: `applyStagePlacement` never suspends shelf webviews, so a Stage shelf webview is not scaled with its window.
- **Swap animation.** `AnimationEngine.wheelSwap` animates only the main frame (fade/slide). A WAAPI transform on a preview window would override the rail's per-frame inline transform, and would end at a stale pose while the wheel is still easing. The rail-driven morph avoids both problems.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| macOS Stage Manager | Recent apps are live, scaled window thumbnails on a left shelf; clicking one flies it to centre while the current window flies to the shelf | The dock-morph model: live thumbnails plus a fly-in/fly-out swap |
| GNOME Shell overview | Live `Clutter.Clone` actors of real windows, scaled to ~0.25×; clones share the window texture, no copy | Live previews come from the real surface, not snapshots |
| KWin / Windows taskbar | DWM/compositor live thumbnails of the real surface; count is limited to what is on screen | Keep only visible previews live |
| tmux `choose-tree` | Live text preview of the highlighted pane in a split | Terminal-native "live preview"; one at a time |
| Krypton Stage (245) | Real window DOM, `translate + scale`, 5 previews max | Same technique, same memory budget |

**Krypton delta.** Like Stage Manager and GNOME, previews are the real window surface, never snapshots. Unlike them, the previews ride a rotating arc and lean with it, only the ±3 nearest cards are live (a memory budget, not a UX limit), and everything is keyboard-driven (`Cmd+Shift+</>`, `Leader h/j/k/l`), with mouse secondary.

## Affected Files

| File | Change |
|------|--------|
| `src/wheel-layout.ts` | `wheelGeometry` takes `cardHeight`; add `wheelCardHeight(main)`, `wheelPreviewTransform(...)`, `wheelEdgeFade(...)`, `wheelIsLiveSlot(...)`, `WHEEL_LIVE_SLOTS`, `WHEEL_EDGE_FADE` |
| `src/wheel-rail.ts` | Callbacks gain `previewElement(id)`; `setBounds(rail, main)`; per-frame preview transforms, edge fade, and dock morph; live/schematic card states |
| `src/compositor.ts` | Pass preview elements; `syncWheelRoles` gives roles `active`/`preview`/`hidden`; `syncWheelFocus` replaces `animateWheelSwap`; entering Wheel morphs only the focused window; leaving Wheel clears preview styles |
| `src/animation.ts` | Remove `wheelSwap`; add a `motionEnabled` getter the rail reads |
| `src/styles/wheel.css` | Root without z-index; canvas / card / label z-order; `--live` card has a transparent background and a hidden schematic |
| `src/wheel-layout.test.ts` | Card height, preview transform, live slot range, dock interpolation |
| `docs/272-wheel-layout.md` | Revise the rejected alternative; point to this spec |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/02-functional-requirements.md` | Live previews, dock morph, GPU budget |

## Design

### Data Structures

```typescript
// wheel-layout.ts
export const WHEEL_LIVE_SLOTS = 3;                 // live previews at |i − active| ≤ 3
export const WHEEL_EDGE_FADE = 24;                 // px over which a preview fades before the rail edge
export function wheelCardHeight(main: WindowBounds): number;
//   clamp(round(112 × main.height / main.width), 56, 100): cards match the window's aspect
export function wheelGeometry(railWidth: number, railHeight: number, cardHeight: number): WheelGeometry;
export function wheelPreviewTransform(
  pose: WheelPose, rail: WindowBounds, main: WindowBounds, dock: number,
): string;
export function wheelEdgeFade(pose: WheelPose, geo: WheelGeometry): number;   // 1 clear of the edges → 0 at an edge
export function wheelIsLiveSlot(index: number, active: number): boolean;      // 0 < |i − active| ≤ 3
//   dock 1 = on the card: translate(card centre − main centre) rotate(pose.rotate) scale(112·pose.scale / main.width)
//   dock 0 = identity (the main frame); in between, translate/rotate/scale are interpolated with ease-out
```

`WheelRailCallbacks` gains `previewElement(id: WindowId): HTMLElement | null` and `motionEnabled(): boolean`, and `setBounds(rail, main)` receives the main frame. Each rail entry gains `dock: number` (0..1, eased at 0.22 per frame), `element` (the window while the rail styles it), and `live` (the card's `--krypton-wheel-live`).

### Data Flow

```
1. Focus changes (Cmd+Shift+>, Leader j, click, settled scroll)
2. compositor.focusWindowQuiet(next) → syncWheelRoles():
     next → role active    (visible, pointer-events on, webviews resumed)
     |i − active| ≤ 3 → role preview (visible, pointer-events none, webviews suspended)
     else            → role hidden  (visibility hidden, as today)
3. wheel.setActive(i): rotation target changes; each entry's dock target is
   0 for the active window and 1 for previews
4. Each rAF frame: pos eases toward target (existing). For every live entry,
   dock eases toward its target over ~200 ms (reduced motion: instant). The
   window gets wheelPreviewTransform(pose(i, pos), rail, main, dock); its opacity
   = pose.opacity × edgeFade × (dock > 0 ? 1 : '').
5. When the active window's dock reaches 0, the rail clears its inline transform
   and opacity; it is the plain main-frame window again and receives input.
6. The loop stops when rotation, dock, and tufts are all settled (idle 0 CPU).
```

Keystrokes are never buffered for the morph. The incoming window has DOM focus at step 2, and the morph is purely visual.

### UI Changes

- **Card, live:** `krypton-wheel__card--live`. Transparent background; the schematic SVG is hidden; the 1px card border and active glow sit on top of the scaled window. The window's own chrome is scaled with it (its titlebar reads as a thin strip, like Stage).
- **Card, schematic:** unchanged. Used for the active slot (its window is the main frame), cards beyond ±3, and whenever a preview has faded out.
- **Edge fade:** when a live card's rotated bounds come within `WHEEL_EDGE_FADE` px of the rail's right, top, or bottom edge, `edgeFade` drops to 0 and the schematic fades in. Previews never overlap the main frame or footer.
- **Z-order** in the workspace: arc canvas 1 · preview windows 2 · active window 2 (no overlap) · cards 3 · labels and caret 4.
- **Card height** follows the main frame's aspect: 112 × 92 on a 1728 × 1117 screen with a 400px rail. Geometry spacing already derives from card height, so the arc stays consistent.

### Configuration

None. `WHEEL_LIVE_SLOTS` is a constant. The GPU budget is not something users should have to tune.

## Edge Cases

| Case | Behavior |
|------|----------|
| More than 7 windows | Live ±3 around the active card; the rest are schematic cards (role `hidden`) |
| Rotating by several slots | Windows entering ±3 become `preview` and fade in; leaving ones fade to the schematic, then turn `hidden` |
| Webview pane in a preview | Suspended placeholder (native views cannot scale). Wheel suspends them; Stage currently does not |
| Maximize (`Leader z`) | Rail hidden → every non-active window turns `hidden`, transforms cleared |
| Leaving Wheel | Clear inline transform, opacity, and transform-origin on every window; drop the roles |
| Reduced motion | Dock jumps (no morph); rotation already jumps |
| Resize / frame change | New card height → new geometry; previews recomputed on the next frame |
| Rapid switches | The dock target flips mid-morph; it eases from its current value, with no restart and no stale end pose |
| Window closed mid-morph | Entry removed; its element is gone, so no transform is written |

## Open Questions

None. Decisions taken: live range ±3 (GPU budget ≈ Stage); the active slot stays schematic; cards take the window aspect; the rail owns the morph, replacing `wheelSwap` for Wheel.

## Out of Scope

- Bitmap snapshots of cards beyond ±3 (they keep the schematic)
- Transforming native webviews
- Readable text inside previews (scale ≈ 0.085; the preview shows shape, colour, and motion)
- Per-user `live_slots` config

## Resources

- [WebKit PR #74566 — rasterization scale from ancestors](https://github.com/WebKit/WebKit/pull/74566): `RenderLayerCompositor` clamps the scale to [1, 5], so scaled-down layers keep full-resolution backing; sets the ±3 budget
- [WebKit: Accelerated rendering and compositing](https://trac.webkit.org/wiki/Accelerated%20rendering%20and%20compositing): transformed elements get their own backing layer
- [GNOME window-nativizer PR #25](https://github.com/everyx/gnome-shell-extension-window-nativizer/pull/25): overview previews are live clones downscaled to ~0.25×
- [herdr discussion #482](https://github.com/ogulcancelik/herdr/discussions/482): tmux `choose-tree`'s live preview of the highlighted pane
- [WTMB Window Thumbnails](https://extensions.gnome.org/extension/6816/wtmb-window-thumbnails/): live window thumbnails from the real surface
- Krypton spec 245 (Stage): scaled live windows, 5-preview shelf, `baseBounds` + transform

## Implementation Notes

Deviations from the approved draft:

- `wheelPreviewTransform` returns only the transform string; the rail computes opacity as `1 + (pose.opacity × edgeFade − 1) × dock`.
- No `window.css` rule. The inline `pointer-events: none` from `syncWheelRoles` and the rail's inline `transform-origin: 50% 50%` are enough.
- Entering Wheel from another layout runs `animateRelayout` for the focused window only. A WAAPI transform on a preview would override its rail-owned inline transform.
- Browser check (a stand-in page with eleven fake terminal windows at 1728 × 1089): live cards show each window's colours and text shape; the ±3 cards that lean near the rail's right edge fade to their schematic; the morph brings the incoming window up from its card while the outgoing one shrinks back.
