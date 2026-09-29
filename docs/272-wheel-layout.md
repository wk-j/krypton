# Wheel Layout (arc navigation wheel) — Implementation Spec

> Status: Implemented
> Date: 2026-09-28
> Milestone: M3 — Compositor & Windows

## Problem

Every Krypton layout either tiles windows or shows them as live previews. None gives a compact, ordered overview of *all* windows that you can spin through quickly, with a sense of where you are in the list and which windows are busy.

## Solution

Add a sixth compositor mode, **`Wheel`**, based on the `<arc-wheel>` prototype (`/Users/wk/Source/artirfact/reusable wheel navigation.html`) and the look of the user's reference screenshot (a furred arc bowing across a wide rail, with a dense column of leaning thumbnails on a faint inner orbit). A rail on the left draws the curved arc. Each window is a small schematic card on the orbit, with its project label beside it. The active window fills the main frame to the right of the rail, and its own card is left out of the rail: its slot at the apex stays empty, so every card on the rail is another window. Moving to the next or previous window rotates the wheel. **Tufts** along the arc show real per-window output throughput on top of a static fur texture, so busy windows stand out.

Every window shares one base frame. Only the active window is visible; the others stay in the DOM with `visibility: hidden`. Switching windows therefore never resizes a PTY.

## Research

- **Prototype mechanics (source of truth for the look).** Items sit on a circle of radius `R = max(railH × 0.9, 360)` at angle `t = (i − pos) × step` with `step = 0.21 rad`. Each item is rotated by `t`. The active item is scaled ×1.18; the others are scaled by `1 − |t| × 0.12` and faded by `1 − |t| / 1.25`, and they are hidden beyond `|t| > 1.2`. `pos` eases toward the target at 0.14 per frame. The arc is a canvas stroke that gets thicker toward its upper middle. Tufts are seeded random strands whose count and length come from an activity value. A label sits beside each item, a caret points at the active item, and a hint caption sits in the bottom corner.
- **Reference look (supersedes the prototype's proportions).** Measured from the reference: the arc apex sits about 40% into the rail, and the arc bows to the rail's top and bottom right corners. The tufts are dense clusters along the whole arc, with strands reaching a third of the rail width. Card centres ride a faint orbit concentric with the arc. Idle cards are about a quarter of the rail width, stacked about 10px apart, and lean by about half their arc angle rather than turning fully radial. The active card is about 1.5× an idle card and the caret is to its right. Every label sits upright, inline with its card on the right (the active one past the caret; the reference put it under the active card's bottom-left corner, revised at the user's request).
- **Prototype gaps for Krypton.** Its rAF loop runs forever and only skips frames once it settles, which breaks the <1% idle-CPU budget, so the Krypton version must stop the loop. It calls `getComputedStyle` on every frame; Krypton will cache colours and refresh them on `theme-changed`. Its tufts are fake random data; Krypton will drive them from real throughput. It is a custom element with shadow DOM; Krypton uses plain classes and BEM CSS.
- **Stage (spec 245)** already shows that one shared base frame plus visual-only changes keeps xterm and PTY sizes stable across switches. Wheel reuses that idea but does not scale live windows: cards are 112 px wide (168 px active), where live terminal previews would be unreadable. Eleven full-size composited layers would also cost roughly 200 MB of GPU memory.
- **Real activity signal exists.** PTY output already calls `win.headerScope.pump(bytes)` (`compositor.ts` PTY route), and content views pump through `onOutputPump`. `headerScope` is `null` when the header-accent style is `ticks`, so the wheel needs its own pump at the same call sites.
- **Native webviews** (spec 102) render above the DOM. `visibility: hidden` does not hide them, so a webview in a hidden Wheel window would cover the active one. Wheel must suspend webviews in inactive windows, and `resumeAllWebviews()` must skip those windows.
- **Order model.** Stage uses MRU order, which reshuffles the shelf on every switch. A wheel depends on spatial memory: an item stays where it is and the wheel turns. Wheel order is therefore the compositor's stable `windows` map order (creation order, reorderable with Swap).
- **Alternatives rejected.** Scaling live windows onto the arc was first rejected here: previews would be unreadable and GPU cost is high. **Revised by [spec 273](./273-wheel-live-previews.md):** the user asked for live previews, so the ±3 cards nearest the active one now carry their real window (a GPU budget close to Stage's), and the rest keep the schematic below. Drawing everything on one canvas was rejected: DOM cards keep theming in CSS vars and keep hit-testing and labels simple. An MRU wheel was rejected because it breaks the rotation metaphor.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Compiz Ring Switcher | Windows arranged on a 3D ring that rotates; hold `Super`, tap `Tab` / `Shift+Tab`, release to pick | Closest window-switcher analogue; transient, not a persistent layout |
| KWin Cover / Flip Switch | Cover Flow–style queue of window thumbnails; arrows page through; rewritten in QML on `PathView` | Path-based thumbnail layout, as used here; also transient |
| macOS Time Machine | Persistent tick timeline on the right edge; the selected tick is highlighted; up/down arrows step between backups | Edge rail plus stepwise keyboard navigation over an ordered history |
| iOS `UIPickerView` (wheel style) | Rotating drum; the selected row sits at the centre line; the rest fade and foreshorten with distance | Source of the "active at apex, others fade by angle" convention |
| Krypton Stage (spec 245) | Active window plus scaled live-preview shelf, MRU order | Shared-frame / no-PTY-resize precedent |

**Krypton delta.** Wheel is a **persistent layout**, not a transient switcher like Compiz or KWin. It uses **schematic cards** rather than live thumbnails, because terminal content is illegible at card size. It keeps a **stable order**, where Stage uses MRU. It is fully keyboard-driven through the existing leader keys and `Cmd+Shift+</>`. Mouse wheel and click are secondary. Its tufts carry **live throughput data** instead of decoration.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `LayoutMode.Wheel = 'Wheel'` |
| `src/wheel-layout.ts` | **New.** Pure geometry: rail width, main frame, arc point, item pose, wrap index, activity decay |
| `src/wheel-layout.test.ts` | **New.** Geometry, pose, wrap, narrow-viewport, and decay tests |
| `src/wheel-rail.ts` | **New.** `WheelRail` class: rail DOM, canvas arc and tufts, cards, labels, caret, self-stopping rAF |
| `src/styles/wheel.css` | **New.** `.krypton-wheel` BEM styles; imported from `src/styles/index.css` |
| `src/compositor.ts` | Enter/leave/relayout, focus/create/close/swap, activity pump, webview suspension, theme refresh, card sync |
| `src/animation.ts` | `motionEnabled` getter (the `wheelSwap()` transition was replaced by the rail's dock morph, spec 273) |
| `src/input-router.ts` | Wheel branches for `h/j/k/l` |
| `src/which-key.ts` | `WHEEL_COMPOSITOR_KEYS`, title `Compositor · Wheel` |
| `src/command-palette.ts` | `Layout: Wheel` action; cycle label adds Wheel |
| `docs/02-functional-requirements.md`, `04-architecture.md`, `05-data-flow.md`, `06-configuration.md`, `README.md` | Record the sixth layout, flow, `default_layout = "wheel"`, index |

No Rust, IPC, or config-schema change is needed. `default_layout` is already a string, and `workspace-recovery.ts` builds its accepted modes from `Object.values(LayoutMode)`.

## Design

### Data Structures

```typescript
// types.ts
export enum LayoutMode { /* … */ Stage = 'Stage', Wheel = 'Wheel' }

// wheel-layout.ts
export interface WheelFrame { rail: WindowBounds | null; main: WindowBounds } // rail null = hidden (narrow)
export interface WheelPose { x: number; y: number; rotate: number; scale: number; opacity: number; hidden: boolean }
export interface WheelItem {
  id: WindowId;
  label: string;                 // project dir name + '/' for terminals, tab title for content views; never uppercased
  schematic: WheelPaneRect[];    // active tab's pane tree, normalized 0..1
  tabCount: number;
  key: string;                   // label|schematic|tabCount hash — card DOM rebuilt only when it changes
}
export type WheelLine = [number, number];   // text bar [start, end] as fractions of pane width; [0, 0] = blank row
export interface WheelPaneRect { x: number; y: number; w: number; h: number; focused: boolean; glyph: string; lines?: WheelLine[] }

export function computeWheelFrame(vw: number, vh: number, gap: number, footerH: number): WheelFrame;
export interface WheelGeometry {
  railWidth: number; railHeight: number;
  arcX: number;        // arc apex x
  radius: number;      // arc radius
  cardRadius: number;  // concentric card orbit radius
  step: number;        // angle active ↔ neighbour
  idleStep: number;    // base angle idle ↔ idle
  arcExtent: number;   // half-angle where the arc leaves the rail
}
export function wheelGeometry(railWidth: number, railHeight: number): WheelGeometry;
export function wheelItemAngle(offset: number, geo: WheelGeometry): number; // slot offset → arc angle
export function wheelItemPose(index: number, pos: number, geo: WheelGeometry): WheelPose;
export function wheelArcPoint(t: number, r: number, geo: WheelGeometry): [number, number];
export function wheelFurLevel(k: number): number;                   // static fur height of fur tuft k
export function wheelTextSilhouette(rows: readonly string[], cols: number): WheelLine[];
export function wheelSchematic(node: WheelPaneNode, focusedId: string): WheelPaneRect[];
export function wheelItemKey(label: string, schematic: WheelPaneRect[], tabCount: number): string;
export function wheelLabel(projectName: string | null, fallback: string): string;
export function wheelLabelHead(label: string): string;         // first WHEEL_LABEL_CHARS (2) code points, case kept
export function wrapWheelIndex(i: number, n: number): number;
export function decayActivity(a: number, dtMs: number): number;   // half-life 1.5 s
export function bumpActivity(a: number, bytes: number): number;   // min(1, a + max(bytes / 8192, 0.04))
```

### Geometry

- **Rail:** `x = 0`, `y = 0`, width `clamp(round(vw × 0.24), 280, 400)`, height `vh − 28` (the footer). The reference rail is about 0.43 × its height wide. At 1728px that is 400px (the 320px cap left no room for the fur or the labels).
- **Main frame:** `x = railW + gap`, `y = gap`, `w = vw − railW − 2·gap`, `h = vh − 28 − 2·gap`. If `w < 480`, the rail is hidden and the frame spans the full width inside the gap.
- **Cards:** idle 112 wide, with height from the main frame's aspect (`wheelCardHeight`, 56–100px, 92px on a 1728 × 1117 screen) so a live preview fills its card; active ×1.5. Cards lean by `0.5 × t` (`WHEEL_TILT`), not fully radial. Scale eases as `1 + 0.5 × max(0, 1 − |i − pos|)`, so the grow follows the rotation. Opacity is `1 − |t| / 1.25`. A card is hidden beyond 1.2 rad or once it has left the rail.
- **Arc apex** (`wheelGeometry(railW, railH)`): `arcX = max(34, railW − 248)`, where 248 = orbit gap 94 + idle half-width 56 + label gap 8 + label 90. At the apex an idle card and its label end at the rail edge, and everything left of the arc is tuft room (152px at 400px).
- **Arc radius:** the circle through the apex and both rail corners inset 16px from the right edge: `bow = railW − 16 − arcX`, `R = (bow² + (railH/2)²) / (2·bow)`. The arc therefore spans the full rail height, like the reference. `arcExtent = asin(railH/2 / R)`.
- **Card orbit:** concentric, `cardRadius = R − 94`, where 94 = active half-width 84 + a 10px gap to the arc.
- **Spacing** (`wheelItemAngle`): the first slot out uses `step`, sized so the active card and its neighbour keep 4px, the same above and below (labels sit inline, so no label room opens under the active card). Later slots use `idleStep`, sized for an 8px idle gap. Both steps add the corner dip of a leaning neighbour, `halfW × sin(0.5·step)`, settled with a few fixed-point passes. Further out a card's lean trails the orbit tangent by `k·t` (`k = 1 − 0.5`), so idle spacing widens as `dt/dn = idleStep / cos(k·t)`, solved in closed form: `t = asin(sin(k·t₁) + k·idleStep·(d − 1)) / k`. The function is piecewise and continuous, so cards glide while the wheel turns.
- **Labels:** each label shows only the first two characters of the item label (`wheelLabelHead`: `krypton/` → `kr`), set big with line-height 1 so windows are told apart at a glance; the full label stays on the card's `aria-label`. Idle labels sit upright, pinned `halfW + 8` right of the card's centre on its leaning axis, 20px, and ellipsize at the rail edge (max-width is set from the remaining room, capped at 90px). The focused window's card and label are not drawn. While a mouse-wheel scroll turns another card into the apex, before focus commits, that card gets the 32px foreground label, inline too: the caret is `halfW + 5` right of the card, vertically centred, and the label follows it at `halfW + 5 + 7 + 6`, vertically centred. Once its window is focused, card, label, and caret leave the rail. Labels stack above cards. Mockup: `.krypton/artifacts/hm-2/Claude-3/art-97-34e3a858.html`.
- **Base bounds:** every window gets `baseBounds = main`. The active window has role `active`; all others have role `hidden` (`visibility: hidden; pointer-events: none`).

### Card, Label, Tufts

- **Card:** borderless, on a translucent background, using the `--krypton-border-radius` token. The focused window has no card: the rail lists the other windows only, and the empty apex slot marks where the focused window sits in the order. No corner brackets and no blur.
- **Card body:** cards within ±3 slots of the active one show the live window (spec 273). Every other card, and any live card that has faded near a rail edge, shows an inline SVG (112 × card-height viewBox) of the window's active tab. The card has no frame: splits are 1px divider lines (`vector-effect: non-scaling-stroke`), and the focused pane of a split gets a faint accent fill. A terminal pane shows a **text silhouette**, one bar per bucket of its visible rows, from the first non-space column to the trimmed line end (`wheelTextSilhouette`, at most 18 bars). The compositor reads it from the xterm buffer (`translateToString(true)` per viewport row) when it builds the item, and again at most once a second per window after PTY output (`WHEEL_REFRESH_MS`, trailing). Bars are quantized into the card key, so the card only repaints when its silhouette changes. Panes with no text and content views show their glyph instead: `>_` terminal, `±` diff, `¶` markdown, `◈` harness/acp/agent, `▦` other. If the window has more than one tab, tab dots appear bottom-right.
- **Label:** the first two characters of the item label, in the chrome mono font, case kept (never uppercased): dim 20px text for inactive items and 32px foreground for the active one. The item label comes from `projectBadge(focusedProjectDir)`. If there is no directory, the tab title is used. The card's `aria-label` keeps the full item label.
- **Fur:** four static tufts per window slot along the whole visible arc (`wheelFurLevel(k)`, seeded by `k`, so fur turns with the wheel without flickering). Levels are mostly `0.05–0.4`, and every sixth tuft grows into a `0.45–1` cluster, like the reference's clumps. Fur is drawn at 0.8 alpha, fading toward the arc ends.
- **Live tufts:** one bright tuft per window at that window's arc angle, so tufts rotate with the cards. They are drawn over the fur at full alpha, with a root dot of `1.2 + activity × 2.2` px at every window slot. Strands = `3 + round(v × 32)` and length = `3 + (4 + r·80) × v`, seeded so each tuft keeps a stable shape. Long strands shed a speck past their tip. Tufts point outward, toward the screen edge.
- **Arc:** a variable-width stroke (0.8 → 4.8px, thickest toward the upper middle of the visible span) in the accent colour. A 0.75px orbit line at 0.3 alpha runs through the card centres, behind the cards.
- **Hint caption:** bottom-left, showing `03 / 09` (active position / count).
- **Colours:** read once from `--krypton-*` vars and refreshed on `theme-changed`. Colours are never read per frame.

### Render Loop

`WheelRail` runs a rAF loop only while it has work: the wheel is rotating (`|target − pos| > 0.0005`), a window is docking, or some activity is above 0.02. The loop stops otherwise, so an idle wheel uses 0 CPU. Frames driven only by activity are capped at 30 fps. Each frame writes `transform` and `opacity` for cards and labels still on the rail and redraws the canvas. The fur is static, so it adds no frames of its own. Under `prefers-reduced-motion`, rotation jumps straight to the target and tufts redraw at most every 500 ms.

### Order, Focus, Navigation

- **Order:** the `windows` map order. Entering Wheel keeps that order (leaving Scroll or Stage already flattens into it). The active index is the index of the focused window.
- **Next / previous:** these wrap. Going from the last window to the first visibly spins the wheel back, which is the cue that it wrapped. Each step calls `focusWindow(id)` → `syncWheelFocus()` → `wheel.setActive(i)` (rotation + dock morph) → the sound `window.focus`.
- **New window:** appended at the end and made active. It is fitted at `main` size.
- **Closing the active window:** focus goes to the window now at the same index, or the previous one if the closed window was last.
- **Swap mode:** `h/k` move the active window one slot earlier in the order and `j/l` one slot later, by rebuilding the map. Focus stays on the moved window.
- **Mouse (secondary):** clicking a card focuses that window. Scrolling over the rail moves `target` by `deltaY × 0.004`, snaps after 140 ms, and then commits focus. Drag is out of scope.

### Main-Frame Swap Animation

Superseded by [spec 273](./273-wheel-live-previews.md). `WheelRail` flies the incoming window from its card into the main frame and the outgoing one back onto its card (the dock morph). This runs in the rail's rAF loop, so it composes with the rotation. `AnimationEngine.wheelSwap` was removed. Reduced motion and animation style `none` (`AnimationEngine.motionEnabled`) dock instantly.

### PTY Fitting

`fitAll()` fits **every** window, including hidden ones, on entering Wheel, on viewport resize, and when the rail is shown or hidden. `visibility: hidden` keeps layout, so FitAddon measures correctly. All windows share `main`, so ordinary switching calls no fit, `resize_pty`, or `SIGWINCH`.

### Native Webviews

- In Wheel, activating a window resumes its webview views and suspends those of the outgoing window.
- `resumeAllWebviews()` skips windows whose `data-wheel-role` is `hidden`.
- Leaving Wheel resumes all webviews.

### Data Flow

```
1. User presses Leader f (cycle) / picks "Layout: Wheel" / default_layout = "wheel"
2. applyLayoutMode(Wheel) → relayout(); the first relayoutWheel() lazily creates the WheelRail (so default_layout and workspace restore work too)
3. relayoutWheel(): computeWheelFrame → every window gets baseBounds = main; set active and hidden roles
4. nextFrame → fitAll() (all windows) → WheelRail.setActive(index) → rAF rotates to target, then stops
5. Leader j / Cmd+Shift+< → compositor.wheelNext() → focusWindow(next)
6. focusWindow → syncWheelFocus → set roles (active / preview ±3 / hidden) → suspend/resume webviews → wheel.setActive(i) → rail rotates and docks
7. PTY output → headerScope.pump(n) + wheelRail.pump(id, n); content views → pumpWindowActivity(id, n) → same pair → tuft grows, loop runs until decayed
8. Leaving Wheel: wheel.dispose(); clear the --wheel class, role, visibility, pointer, opacity, transform; resume webviews
```

The PTY route calls `wheelRail.pump` next to `headerScope.pump`; both `onOutputPump` assignments now always go through `pumpWindowActivity`, even when the header style is `ticks`. `syncWheelItem(win)` is called wherever `syncStageProjectInitials` is called today (inside `syncWindowFooter`, title change, cwd change). That covers tab, pane, split, title, and cwd changes.

### Keybindings

The cycle becomes Grid → Focus → Depth → Scroll → Stage → **Wheel** → Grid.

| Key | Context | Action |
|-----|---------|--------|
| `f` | Compositor | Cycle layouts (now six) |
| `h` / `k` | Compositor + Wheel | Previous window (rotate up, wraps) |
| `j` / `l` | Compositor + Wheel | Next window (rotate down, wraps) |
| `1-9` | Compositor + Wheel | Jump to the Nth window in wheel order (absolute) |
| `Cmd+Shift+>` / `<` | Global + Wheel | Previous / next window, reversed from the other layouts: `>` picks the card above, `<` the card below. Palette **Focus Next / Previous** keep their meaning |
| `s` then arrows / `hjkl` | Swap + Wheel | Move the active window earlier / later in the wheel |
| `z` | Compositor + Wheel | Maximize: hide rail, active fills the workspace; restore brings it back |

The Wheel which-key omits `r`, `m`, `=`, `,`, `.`, and `p`. In Wheel these are no-ops: resize/move arrows do nothing, and pin has no effect, matching Grid, Depth, Scroll, and Stage.

### UI (DOM)

```html
<div class="krypton-wheel" data-side="left">            <!-- child of the workspace, z below windows' overlays -->
  <canvas class="krypton-wheel__arc"></canvas>
  <button class="krypton-wheel__card" data-window-id="…" tabindex="-1">  <!-- the focused window's card: visibility hidden -->
    <svg class="krypton-wheel__schematic">…pane rects, glyphs, tab-dot circles…</svg>
  </button>
  <span class="krypton-wheel__label">kr</span>  <!-- first 2 chars of "krypton/" -->
  <div class="krypton-wheel__caret"></div>      <!-- shown only beside a card a scroll is about to pick -->
  <div class="krypton-wheel__hint">03 / 09</div>
</div>
```

Windows get `.krypton-window--wheel` and `data-wheel-role="active|hidden"`. Cards are `<button>` elements for click and accessibility, but they never take keyboard focus (`tabindex=-1`), so terminal focus is never stolen.

### Configuration

```toml
[workspaces]
default_layout = "wheel"  # grid | focus | depth | scroll | stage | wheel
```

v1 has no `[workspaces.wheel]` table. The rail side and card size are fixed. The arc, orbit, and steps are derived from the rail size (see Geometry), not configured.

### Implementation Notes

- `WheelRail` API: `setBounds(bounds | null)`, `setItems(items)`, `updateItem(item)`, `setActive(index)`, `pump(id, bytes)`, `refreshColors()`, `dispose()`. Compositor adds `wheelStep(±1)`, `wheelNext()`, `wheelPrevious()`.
- `focusWindowQuiet` focuses the pane while the window is still `visibility: hidden`, which cannot take DOM focus. After flipping roles the compositor refocuses the now-visible pane, unless the Quick Terminal is open.
- Activity-only frames are scheduled with `setTimeout` at the capped rate (33 ms, or 500 ms under reduced motion), so the rail never spins rAF at 60 Hz just to decay tufts.
- Tab dots are drawn as SVG circles inside the schematic, not as a separate span. A truncated project name (ending in `…`) gets no trailing `/`.
- The focused window's card and label were first drawn at the apex as a scaled-up schematic. Since the window itself fills the main frame, that card read as a second, empty window, so it is now left out (revised 2026-09-29 at the user's request). The geometry is unchanged: the apex slot keeps its room and the neighbours stay one `step` away. A window flying back to its card keeps the card live (transparent) for the whole morph, so no schematic flashes in at the apex first.
- Verified in a browser against the real `WheelRail` and `wheel.css`: rotation, click and scroll activation, and zero rAF calls while idle. Compositor wiring is covered by type-check and unit tests. It has not yet been exercised in the installed app bundle.

## Edge Cases

| Case | Handling |
|------|----------|
| One window | Rail shows only the arc and the `01 / 01` caption (the single window is the main frame), so the frame stays stable and adding a second window causes no PTY resize |
| Many windows (>11) | Cards beyond ±1.2 rad are hidden but still reachable by keys, index, and scroll |
| Narrow viewport (`main.w < 480`) | Rail hidden; frame goes full width; keys still navigate; caption not shown |
| Viewport resize | Recompute frame, resize canvas at DPR, `fitAll()`, redraw once |
| Theme change | `wheel.refreshColors()` → one redraw |
| Close / create during a swap | Cancel animations, sync items against live IDs, render the newest state |
| Native webview in a hidden window | Suspended; overlays' `resumeAllWebviews()` skips it |
| Maximize | Rail hidden while maximized; restore reapplies the Wheel frame |
| Quick Terminal | Stays an overlay above rail and frame |
| Workspace restore in Wheel | Works as-is: order is window order, active is the focused window, nothing extra to persist |
| High-output hidden window | Session keeps running; not painted; its tuft grows so the activity is visible |

## Open Questions

None. Approving this spec accepts: schematic cards (not live previews), stable window order (not MRU), wrap-around keyboard stepping, a left-only rail, and no drag in v1.

## Out of Scope

- Live window thumbnails on the arc, bitmap capture
- Right-side rail, configurable step/card size, `[workspaces.wheel]` config
- Pointer drag to rotate; momentum/fling
- Arc end labels (prototype `start-label` / `end-label`)
- Multi-window groups per wheel item
- Replacing Stage or any existing layout; changing the shipped default layout

## Resources

- `/Users/wk/Source/artirfact/reusable wheel navigation.html`: `<arc-wheel>` prototype; geometry, easing, tuft drawing, and input model
- [Compiz Ring Switcher plugin](https://launchpad.net/compiz-ring-plugin) and [Linux.com: Compiz window switcher](https://www.linux.com/training-tutorials/linuxables-compiz-window-switcher/): ring-shaped rotating window switcher and its key model
- [Martin Gräßlin: Evolving 3D desktop effects in Plasma](https://blog.martin-graesslin.com/blog/2021/11/evolving-3d-desktop-effects-in-plasma/) and [KDE MR !91: QML Cover/Flip Switch on PathView](https://invent.kde.org/plasma/kdeplasma-addons/-/merge_requests/91): path-laid-out window thumbnails
- [Apple: Restore items backed up with Time Machine](https://support.apple.com/guide/mac-help/restore-files-mh11422/mac): edge timeline rail, highlighted selection, arrow stepping
- [Apple: UIPickerView](https://developer.apple.com/documentation/uikit/uipickerview): rotating-drum selection convention
- Krypton `docs/245-stage-layout.md`, `docs/188-oscilloscope-header-band.md`, `docs/102-webview-windows.md`, `src/compositor.ts`, `src/header-scope.ts`, `src/webview-view.ts`
