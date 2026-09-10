# Stage Layout (macOS Stage Manager-inspired) — Implementation Spec

> Status: Implemented
> Date: 2026-09-10
> Milestone: M3 — Compositor & Windows

## Problem

Krypton's current layouts either tile every window or layer them in a deck. None keeps one task visually dominant while preserving a persistent, glanceable shelf of other live windows for rapid context switching.

## Solution

Add a fifth compositor mode, **`Stage`**, inspired by macOS Stage Manager: one active Krypton window occupies a large frame, while recent windows appear as scaled live previews in a shelf on the left. `Stage` is additive and does not replace `Depth`; it reuses the existing DOM windows, focus routing, and PTY sessions, with Stage-specific placement and animation.

Version 1 treats each Krypton window as one stage. Multi-window groups are deliberately deferred so the first release has a predictable keyboard model and does not introduce a second grouping system beside tabs and panes.

## Research

- Apple Stage Manager keeps the working app centered, places recent apps on a left shelf, and brings an entire group forward when selected. The shelf may be hidden, but persistent visibility is the useful default for Krypton's glanceable terminal workflow.
- Apple distinguishes Stage Manager from Mission Control: Stage Manager is a persistent working layout, while Mission Control is a temporary overview. Krypton `Stage` must therefore remain a normal layout mode, not an overlay picker.
- Krypton windows are DOM elements inside one native Tauri workspace. The compositor already owns absolute bounds, z-order, focus, and WAAPI transitions, so this is frontend-only and cannot manage windows from other macOS apps.
- `Depth` already proves that full-size live DOM windows can be visually scaled and layered while their sessions continue running. Its card-deck semantics are different enough that replacing it would be a regression.
- Resizing every background window to thumbnail dimensions would call xterm fit and send tiny PTY sizes to TUIs. Stage previews must instead scale the full-size window visually; switching focus then produces no PTY resize.
- CSS `transform` is also used by the generic morph animation. Stage therefore needs one Stage-aware WAAPI transition rather than composing shelf transforms with `animateRelayout()`.
- No `backdrop-filter: blur()` is allowed: transparent WKWebView can freeze on macOS. Depth comes from scale, opacity, brightness, and the existing layered glow.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| **macOS Stage Manager** | Active app/group in the center; recent apps/groups on a left shelf; click to switch; windows can be grouped | Primary visual and behavioral reference |
| **macOS Mission Control** | Temporary single-layer overview entered with `Control-Up Arrow` | Useful for finding any window, but not a persistent work layout |
| **Zellij stacked panes** | One pane expands while the others collapse to title rows; navigate with arrows or `hjkl` | Space-efficient terminal focus, but not live visual thumbnails |
| **WezTerm** | Directional pane activation, pane zoom, pane rotation, and workspace switching through key assignments | Strong keyboard primitives; no Stage Manager-style persistent shelf |
| **Windows 11 Snap Layouts** | `Win+Z` chooses fixed zones; Snap Assist fills remaining zones | Multi-window arrangement rather than active-task switching |
| **Krypton Depth** | Focused card at the front; up to four ghost cards recede behind it | Reusable transform/visibility precedent; different spatial metaphor |

**Krypton delta** — keep the familiar active-window-and-recent-shelf composition, but use Krypton windows rather than OS apps, remain fully keyboard-operable, keep the shelf visible, and use cyan HUD chrome instead of copying macOS materials. Tabs and panes remain the way to group work inside one window; Stage groups are out of scope for v1.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `LayoutMode.Stage` and Stage state/placement types |
| `src/stage-layout.ts` | **New** pure placement/order helpers |
| `src/stage-layout.test.ts` | **New** geometry, ordering, resize, and visibility tests |
| `src/compositor.ts` | Own Stage state; enter/leave/relayout/focus/create/close/resize/move integration |
| `src/animation.ts` | Stage transition that preserves final shelf transforms |
| `src/input-router.ts` | Stage-specific `hjkl` navigation branches |
| `src/which-key.ts` | Stage-specific navigation labels |
| `src/command-palette.ts` | Direct `Layout: Stage` action and five-mode cycle label |
| `src/styles/window.css` | Stage role, visibility, pointer, and reduced-motion styles |
| `docs/02-functional-requirements.md` | Add Stage layout requirement and update pin scope |
| `docs/04-architecture.md` | Record the fifth layout and live-preview behavior |
| `docs/05-data-flow.md` | Record Stage switching and PTY-resize behavior |
| `docs/06-configuration.md` | Allow `default_layout = "stage"` |
| `docs/README.md` | Add this spec to the index |

No Rust command, IPC event, or native window is added. `default_layout` is already transported as a string; only the frontend parser gains the new value.

## Design

### Data Structures

```typescript
export enum LayoutMode {
  Grid = 'Grid',
  Focus = 'Focus',
  Depth = 'Depth',
  Scroll = 'Scroll',
  Stage = 'Stage',
}

export interface NormalizedStageFrame {
  x: number;      // fraction of viewport width
  y: number;      // fraction of usable viewport height
  width: number;  // fraction of viewport width
  height: number; // fraction of usable viewport height
}

export interface StageState {
  order: WindowId[]; // index 0 active; remaining entries are shelf/ring order
  frame: NormalizedStageFrame;
}

export interface StagePlacement {
  id: WindowId;
  role: 'active' | 'shelf' | 'hidden';
  baseBounds: WindowBounds;
  translateX: number;
  translateY: number;
  scale: number;
  opacity: number;
  zIndex: number;
  shelfIndex: number | null;
}
```

`src/stage-layout.ts` exports pure helpers:

```typescript
export function syncStageOrder(order: WindowId[], ids: WindowId[], focusedId: WindowId | null): WindowId[];
export function rotateStageOrder(order: WindowId[], direction: 1 | -1): WindowId[];
export function focusStage(order: WindowId[], id: WindowId): WindowId[];
export function computeStageLayout(input: StageLayoutInput): StageLayoutResult;
```

### Layout Geometry

- Reserve the existing 28px workspace footer and `[workspaces].gap` around usable content.
- Shelf width: `clamp(round(vw * 0.16), 160, 232)` pixels.
- Active frame default: 78% of viewport width and 90% of usable height, clamped so its left edge remains at least one gap beyond the shelf and its right/bottom edges remain on screen.
- The active frame is vertically centered and horizontally centered in the area to the right of the shelf.
- Every window receives the same unscaled `baseBounds`. Only the visual transform changes by role. This keeps xterm rows/columns stable when stages switch.
- Shelf cards preserve the active-frame aspect ratio. Scale is the smaller of the available shelf width and per-card height ratios.
- Up to five recent windows are visible, vertically centered with `gap` between cards. Additional windows use role `hidden` and `visibility: hidden`, not removal; their PTY sessions remain alive.
- Shelf numbering follows `StageState.order`: active = `1`, first shelf card = `2`, and so on, matching existing `Leader 1-9` focus semantics.

For a shelf card, the final transform is:

```typescript
translate(targetX - baseBounds.x, targetY - baseBounds.y) scale(scale)
```

with `transform-origin: top left`. The active window uses identity transform.

### Stage Order and Focus

- Entering Stage sorts current windows by their visible `(bounds.x, bounds.y)` order, then moves the focused ID to index 0.
- Clicking or directly focusing a shelf window moves it to index 0 and moves the previous active window to index 1 (MRU behavior).
- `stageNext()` rotates index 0 to the end; `stagePrevious()` rotates the final entry to index 0. Repeated keyboard navigation therefore reaches every window instead of toggling only the two most recent.
- Creating a window makes it active and puts the previous active window first on the shelf.
- Closing the active window promotes index 1. Closing any stale ID removes it during `syncStageOrder()`.
- Leaving Stage flattens `StageState.order` back into compositor map order, then clears all Stage-only classes, attributes, transforms, opacity, visibility, pointer, and z-index styles.

### API / Commands

New compositor methods:

```typescript
async stageNext(): Promise<void>;
async stagePrevious(): Promise<void>;
```

`applyLayoutMode(LayoutMode.Stage)` remains the direct public entry point. No new Tauri API or event is needed.

### Data Flow

1. User selects `Layout: Stage`, cycles with `Leader f`, or starts with `default_layout = "stage"`.
2. `Compositor.enterStageLayout()` derives `StageState.order` from current visual order and focus.
3. `computeStageLayout()` returns one placement per window from viewport size, footer height, gap, frame, and order.
4. Compositor applies the common `baseBounds`, Stage role attributes, final transform, visibility, pointer behavior, and z-index.
5. `fitAll()` fits only the active and visible shelf windows after entering Stage or changing the shared frame. Ordinary stage switching does **not** fit or resize PTYs.
6. When focus changes, compositor computes old/new placements and `AnimationEngine.stageTransition()` animates transforms and opacity to the final Stage styles.
7. Keyboard input is replayed only after the transition, using the existing animation input buffer.

### Keybindings

`Leader f` cycle becomes:

```text
Grid → Focus → Depth → Scroll → Stage → Grid
```

| Key | Context | Action |
|-----|---------|--------|
| `f` | Compositor | Cycle through all five layouts |
| `h` / `k` | Compositor + Stage | Previous stage in the ring |
| `j` / `l` | Compositor + Stage | Next stage in the ring |
| `1-9` | Compositor + Stage | Activate the numbered active/shelf/ring window |
| `Cmd+Shift+<` / `Cmd+Shift+>` | Global + Stage | Previous/next stage, wrapping |
| Resize arrows | Resize + Stage | Adjust the shared active frame; shelf previews recompute |
| Move arrows | Move + Stage | Move the shared active frame within the area right of the shelf |
| `=` | Compositor + Stage | Reset the shared frame and stage order |
| `z` | Compositor + Stage | Maximize active window and hide shelf; restore returns to Stage |

Both directional pairs are intentional aliases: `h/l` match left/right switching, while `k/j` match the vertical shelf. Stage remains a single-action compositor mode; it does not add a second selection cursor.

### Pointer Behavior

- The active window keeps normal pointer behavior.
- A capture-phase workspace `mousedown` handler intercepts the first press on an inactive Stage card, prevents terminal/content interaction, focuses that window, and starts the Stage transition.
- After promotion, the window receives normal input. This prevents a click intended to switch stages from also moving a terminal cursor or activating a control in the scaled preview.

### Animation and Styling

- Add `.krypton-window--stage` plus `data-stage-role` and `data-stage-index`.
- Use full existing window chrome in previews; no duplicate thumbnail DOM and no bitmap capture pipeline.
- Stage transitions animate `transform`, `opacity`, and `filter` for 200ms with the existing ease-out curve.
- Shelf cards use reduced brightness and opacity; the active card keeps its normal focus border and layered glow.
- `pointer-events` remains enabled on visible shelf cards only so they can be promoted by click; the capture handler blocks inner content interaction.
- Hidden entries use `visibility: hidden` and `pointer-events: none`; compositor skips them during fit.
- Under `prefers-reduced-motion`, switch immediately or cap the transition at 120ms with no overshoot.
- No blur, L-shaped corner brackets, copied macOS materials, or new color tokens.

### Resize, Move, and Reset

Stage keeps one normalized shared frame rather than separate geometry per window. Resizing or moving it changes the place where every window appears when active, so switching stages does not cause different terminal dimensions.

- Clamp the active frame to a Stage-specific 320px minimum width and 120px minimum height.
- Clamp left movement to `shelfRight + gap`; clamp all other edges to the usable viewport.
- Store the result as normalized ratios so viewport resize preserves the composition.
- Entering Stage for the first time uses the default frame. Leaving and returning during the same app session preserves it.
- Reset Layout restores the default Stage frame and synced MRU order.

### Configuration

```toml
[workspaces]
default_layout = "stage" # grid | focus | depth | scroll | stage
```

No `[workspaces.stage]` table in v1. The shelf side, maximum visible recents, and default frame are fixed so the interaction can be validated before adding configuration surface.

## Edge Cases

| Case | Handling |
|------|----------|
| One window | Center it in the usable viewport; no empty shelf reservation |
| Two windows | One active, one vertically centered shelf preview |
| More than six windows | Active plus five shelf previews; remaining stages are hidden but reachable by keys |
| Very narrow viewport | Clamp shelf to 160px, then clamp the active frame to 320px; if both cannot fit, hide the shelf and center active |
| Very short viewport | Reduce visible shelf count until cards meet a 72px minimum height |
| New/closed window during animation | Cancel current WAAPI animations, sync order against live IDs, and render the newest state |
| Content window instead of terminal | Uses the same live DOM scaling and first-click promotion |
| High-output hidden PTY | Session continues; hidden element is not fit or painted |
| Maximize | Existing maximize owns visibility until restore, then Stage reapplies placements |
| Pin | No effect in Stage, matching Grid, Depth, and Scroll |
| Quick Terminal | Remains a centered overlay above the active stage and shelf |
| Workspace switch | Each workspace rebuilds Stage order from its own windows; no cross-workspace shelf |

## Open Questions

None for v1. Approval accepts a single-window stage model; multi-window Stage groups remain a later feature.

## Out of Scope

- Controlling native windows belonging to other macOS apps
- Multi-window Stage groups, drag-to-group, and group persistence
- Hiding/revealing the shelf by edge hover
- Trackpad gestures or macOS private APIs
- Per-window active-frame geometry or free overlap inside the stage
- Bitmap screenshots, canvas capture, or duplicated thumbnail DOM
- Changing the shipped default layout from `focus`

## Resources

- [Apple: Organize your Mac desktop with Stage Manager](https://support.apple.com/guide/mac-help/use-stage-manager-mchl534ba392/mac) — active center, recent shelf, grouping, and shelf visibility behavior
- [Apple Human Interface Guidelines: Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/) — keyboard access, resizable/movable windows, and large-display adaptability
- [Apple: View open windows and spaces in Mission Control](https://support.apple.com/en-za/guide/mac-help/mh35798/mac) — distinguishes a temporary window overview from a persistent layout
- [Zellij: Stacked panes and swap layouts](https://zellij.dev/news/stacked-panes-swap-layouts/) — terminal-focused expanded-pane navigation via arrows and `hjkl`
- [WezTerm key assignments](https://wezterm.org/config/lua/keyassignment/index.html) — directional pane focus, pane rotation, zoom, and workspace switching primitives
- [Microsoft: Windows 11 Snap Layouts](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-snap-layout-menu) — fixed-zone window arrangement and adaptive screen-size behavior
- Krypton `src/compositor.ts`, `src/animation.ts`, `src/styles/window.css`, `docs/58-depth-zstack-layout.md`, and `docs/241-scroll-tiling-layout.md`
