# Pane Drag and Drop — Implementation Spec

> Status: Draft
> Date: 2026-10-14
> Milestone: M3 — Compositor & Windows
> Depends on: [0296 Open to Side](./0296-open-to-side-split.md) (`applySplitFlex`, pane click-to-focus, `Tab.sidePaneIds`)

## Problem

A pane cannot be rearranged after it is created. Once `Leader \` or open-to-side places a pane, its position is fixed. There is no way to swap two panes, move a pane to another edge, or move a pane into another window. To get a different layout, the user has to close the pane and recreate it, which loses the shell, the Helix buffer, or the Harness lane.

## Solution

Panes become movable, using one **Pane Move** operation that has two front ends.

- **Mouse.** Drag a pane by the grip that appears at its top edge on hover. Drop it on another visible pane, in the same window or a different one. Where you release decides the result:
  - **Edge zone** (left, right, top or bottom): the dragged pane docks on that side of the target, as a new 50/50 split.
  - **Centre zone**: the two panes swap places.
- **Keyboard.** `Leader Alt+m` enters Pane Move mode.
  1. Every other visible pane shows a hint label; type a label to pick the target.
  2. Press `h`/`j`/`k`/`l` to dock on that edge, or `Enter` to swap.

Both front ends call the same `Compositor.movePane(sourceViewId, targetViewId, zone)`. That function is built on pure tree operations, so the shell PTY, the Helix process, and content-view state such as Harness lanes all survive the move.

## Research

- **No drag code exists.** There is no window, tab, or pane drag anywhere. Window chrome listens only to `mousedown` → `focusWindow` (`compositor.ts:2634`). Tabs have no listeners (`:1583-1615`). There are no `dragstart`/`drop` handlers in `src/` and no Tauri `onDragDropEvent`. Tauri v2's default native file-drop interception only swallows HTML5 file drops, so a pointer-event drag does not conflict with it.
- **Tree mutation is duplicated.** `splitPane` (`:6166`) and `closePaneInTab` (`:6271`) each carry their own recursive tree rewrite. Spec 0296 adds a third (`insertBesidePane`). Moving a pane is one detach plus one dock, so the three should share pure helpers.
- **Split DOM is built by hand, then re-mounted from the tree.** `splitPane` assembles `[first, divider, second]` itself (`:6170-6178`) and restore does it again (`:2947-2960`). After a split or close, `mountPaneTree` (`src/pane-tree-dom.ts`) recursively sets every split element's children to `[first, divider, second]`, reusing the existing divider. Detach and dock reuse that routine.
- **Reparenting xterm is already routine.** Every split and close moves `pane.element` (`:6176`, `:2036`, `:6297`). The terminal uses the DOM renderer, because WebGL was dropped for transparency (`docs/0004-architecture.md:152`), so there is no canvas context to lose. The shader instance is attached to `pane.element` (`:931`) and moves with it.
- **State tied to the window or tab must be rebound when a pane changes window.**
  - `sessionMap` entries (`SessionLocation {windowId, tabId, paneId}`, `:229`).
  - `contentView.onOutputPump`, which captures `win.id` (`:3088`, `:5929`).
  - The terminal title subscription. `wireTitleSync` (`:1031`) drops the xterm `IDisposable`, and its closures capture the source window label (`:2601-2614`) or the source tab (`:6218-6225`).
  - Window footer state: lane strip, usage, diff stat, and project badge. `syncWindowFooter(win)` (`:1656`) re-derives all of it from the focused pane, so it is enough to call it for both windows.
  - `viewId` and `programStatus` are keyed by viewId and stay valid (`docs/0105-view-protocol.md:221`).
- **`moveTabToWindow` (`:6093`) is the precedent for a cross-window move.** It moves the DOM wrapper, rewrites `sessionMap`, and closes an emptied source window. It does not rebind `onOutputPump` or the title sync. That is a pre-existing gap and stays out of scope here.
- **Native webviews draw above the DOM.** `setMode` (`input-router.ts:336`) already suspends all webviews whenever the mode leaves Normal. A pointer drag that enters a mode gets this for free, which makes webview panes valid drop targets during the drag. A grip drawn on a webview pane would be hidden under the webview, so webview panes move by keyboard only.
- **Keyboard precedents.** `Alt+h/j/k/l/x` are the pane family under Leader. `m` is window Move mode and `s` is window Swap mode (`input-router.ts:909`). Prefix-free labels come from `generateArtifactHintLabels` (`acp/harness-permission-scan.ts:361`). `normalizeLeaderKeyEvent` (`leader-keys.ts:24`) maps only `Alt+h/j/k/l/x` today.
- **Rejected alternatives.**
  - **HTML5 DnD (`draggable`).** Tauri intercepts it, it gives no live hit-testing over xterm, and its drag image cannot be styled.
  - **A modifier-drag anywhere on the pane** (iTerm2-style). It collides with xterm selection, Alt-click cursor moves, and Cmd-click links.
  - **Centre zone = merge as a tab** (Zed). Krypton panes have no tabs.
  - **Keyboard `Shift+H/J/K/L` "move one step".** The result is ambiguous in nested trees, and spec 0296 already uses those keys in Resize mode.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed | Drag a tab over a pane. If the cursor is within `drop_target_size` × min(w, h) of an edge (default 0.2), the nearest edge splits; otherwise the item drops into the pane (`crates/workspace/src/pane.rs` `handle_drag_move`). | Edge-zone geometry copied exactly. |
| VS Code | Drag an editor onto a group. The edge regions split and a highlighted overlay shows the resulting half; the centre adds the editor to the group. `workbench.editor.splitOnDragAndDrop` can disable splitting. | Half-rect preview overlay. |
| iTerm2 | Right-click → *Move Session to Split Pane*, then click a target session; panes can also be dragged between tabs and windows. | Pick-then-place works across windows. |
| tmux | `swap-pane -U/-D`, `move-pane`/`join-pane -t <target> -h/-v`, `display-panes` shows numbered labels for choosing a target. | Labels → target → direction is the keyboard model. |

**Krypton delta.** Krypton follows Zed's edge-zone math, VS Code's half-rect preview, and tmux's label-then-direction keyboard flow. It diverges in three places:
- The centre zone swaps instead of merging, because there are no pane tabs.
- The drag handle is a hover grip, not a tab, because panes have no headers.
- Every mouse outcome can also be reached from the keyboard.

## Affected Files

| File | Change |
|------|--------|
| `src/pane-tree-ops.ts` (new) | Pure `detachLeaf`, `dockLeaf`, `swapLeaves`, `dropZoneAt`, `dropPreviewRect`, `DropZone` |
| `src/pane-tree-ops.test.ts` (new) | Tree-shape, ratio, and zone-boundary tests |
| `src/types.ts` | `Mode.PaneMove`; `Pane.titleSync: IDisposable \| null` |
| `src/compositor.ts` | `movePane`, `rebindPane`, `visibleDropTargets`, `removeEmptiedTab`, grip and pointer drag, Pane Move overlay; `splitPane`, `closePaneInTab`, and 0296 `insertBesidePane` reuse the ops; `wireTitleSync` returns `IDisposable` |
| `src/pane-move-overlay.ts` (new) | DOM for the target labels, edge-zone preview, and source dimming (one fixed-position layer) |
| `src/input-router.ts` | `Leader Alt+m`; `handlePaneMoveKey`; `enterPaneMove('pointer')` |
| `src/leader-keys.ts` | `Alt+m` in `GLOBAL_LEADER_KEY_IDS` and `normalizeLeaderKeyEvent` (`KeyM`) |
| `src/main.ts` | `compositor.onPaneDragStart(() => inputRouter.enterPaneMove('pointer'))` |
| `src/which-key.ts`, `src/workspace-footer.ts`, `src/command-palette.ts` | `A-m Move Pane` entry, `PANE_MOVE_KEYS`, footer hint, `pane.move` command |
| `src/styles/window.css` | `.krypton-pane-grip`, `.krypton-pane-move__*`, `.krypton-pane--move-source` |
| `docs/0013-tabs-and-panes.md`, `0004-architecture.md`, `0005-data-flow.md`, `0006-configuration.md`, `0296-open-to-side-split.md`, `README.md` | Document the operation, keys, and data flow |

## Design

### Data Structures

```ts
// src/pane-tree-ops.ts — pure; no DOM access beyond the injected factory
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
export const DROP_EDGE_FRACTION = 0.2;
type SplitNode = Extract<PaneNode, { type: 'split' }>;

/** Remove a leaf; its sibling takes the parent's slot. Returns the detached leaf and the
 *  remaining tree (null when the leaf was the whole tree). */
export function detachLeaf(tree: PaneNode, paneId: PaneId): { tree: PaneNode | null; leaf: PaneNode } | null;
/** Wrap target in a new split with `leaf` on the `edge` side, ratio 0.5. */
export function dockLeaf(tree: PaneNode, targetId: PaneId, edge: Exclude<DropZone, 'center'>,
  leaf: PaneNode, makeSplit: (dir: SplitDirection) => HTMLElement): PaneNode;
/** Exchange two leaves' positions; ratios and split elements are preserved. Works within one
 *  tree (a === b) or across two trees. */
export function swapLeaves(a: PaneNode, aId: PaneId, b: PaneNode, bId: PaneId): { a: PaneNode; b: PaneNode };
/** Zed geometry: the nearest edge when within FRACTION × min(w, h) of it, else 'center'. */
export function dropZoneAt(rect: DOMRectReadOnly, x: number, y: number): DropZone;
/** Rect the preview highlights: the half on that side for an edge zone, the whole rect for centre. */
export function dropPreviewRect(rect: DOMRectReadOnly, zone: DropZone): DOMRectReadOnly;
```

Edge → split mapping:

| Edge | Split direction | Leaf position |
|------|-----------------|---------------|
| `left` | `vertical` | first |
| `right` | `vertical` | second |
| `top` | `horizontal` | first |
| `bottom` | `horizontal` | second |

`closePaneInTab` uses `detachLeaf`. `splitPane` and 0296 `insertBesidePane` use `dockLeaf(…, 'right' | 'bottom')`. The existing hand-written rewrites are deleted.

### API

```ts
// Compositor (public)
movePane(sourceViewId: string, targetViewId: string, zone: DropZone): Promise<boolean>;
visibleDropTargets(): Array<{ viewId: string; winId: WindowId; rect: DOMRect }>; // active-tab panes of on-screen windows
onPaneDragStart(cb: () => void): void;

// private
rebindPane(pane: Pane, win: KryptonWindow, tab: Tab): void;
removeEmptiedTab(win: KryptonWindow, tab: Tab): Promise<void>; // drop tab chrome and wrapper without
                                          // disposing panes; await closeWindow when no tab is left
```

### `movePane` semantics

1. Resolve the source and target with `findPaneInfoByViewId`. If they are the same pane, return `false`.
2. Branch on the zone:
   - **`center`**: `swapLeaves`, on the source tree only (same tab) or on both trees.
   - **Edge**: `detachLeaf` the source from its tree, then `dockLeaf` it at the target. If the source and target share a tab, the target is searched in the post-detach tree.
3. Short-circuit: if the result would recreate the current layout (for example, docking A on the `left` of its own right-hand sibling B in a two-pane split), return `false`. Nothing is rebuilt.
4. Write the new `paneTree` on every affected tab. For each, run `clearPaneTree` + `mountPaneTree`, then 0296 `applySplitFlex`.
5. Any pane whose window or tab changed gets `rebindPane`:
   - `sessionMap.set(sessionId, {windowId, tabId, paneId})`.
   - `contentView.onOutputPump = (n) => pumpWindowActivity(win.id, n)`.
   - Dispose `pane.titleSync`, then re-wire it with a resolver that finds the pane's current tab by `viewId` at fire time. That resolver uses the same Claude title format and the same "focused pane only" gate as the split-pane wiring.
   - Remove the pane from the source tab's `sidePaneIds` (spec 0296).
6. If the source tab is now empty, call `removeEmptiedTab`. A window left without tabs closes even when `close_window_on_last_tab = false`, because an empty window is not a valid state.
7. Focus the moved pane: `focusWindow`, `tab.focusedPaneId`, `updatePaneFocusIndicator`, `focusPaneSurface`.
8. Finish:
   - Run `nextFrame`, then `fitPaneTree` on each affected tab and `syncWindowFooter` on each affected window.
   - Call `scheduleWorkspaceStateSave()`.
   - Play a sound: `pane.split` (edge) or `swap.complete` (centre).

### Data Flow — mouse

```
1. pointerover a .krypton-pane in Normal mode → position the single shared .krypton-pane-grip (fixed,
   top-centre of that pane's rect); hidden when visibleDropTargets().length < 2 or mode ≠ Normal
2. pointerdown on grip → setPointerCapture; wait for 4px movement (shorter = click, no-op)
3. threshold crossed → onPaneDragStart → InputRouter.enterPaneMove('pointer') → setMode(PaneMove)
   → webviews suspended; snapshot visibleDropTargets() rects once
4. pointermove (rAF-throttled) → target = first cached rect containing the point (excluding source),
   zone = dropZoneAt → overlay shows dropPreviewRect, label "SWAP" for centre
5. pointerup over a target → movePane(source, target, zone) → toNormal
   pointerup elsewhere / Esc / pointercancel → overlay removed → toNormal
```

### Data Flow — keyboard

```
1. Leader Alt+m → enterPaneMove('keyboard'); fewer than 2 visible panes → notification "no other pane", stay Normal
2. Stage PICK: overlay labels each target (generateArtifactHintLabels), source pane dimmed
   typing a label prefix narrows; exact match → stage PLACE; non-matching key → cancel
3. Stage PLACE: target shows five zones with key captions
   h/← left · l/→ right · k/↑ top · j/↓ bottom · Enter/Space swap · Backspace back to PICK
4. Key → movePane(...) → toNormal.  Esc in any stage → toNormal, no change
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader Alt+m` | Compositor mode | Enter Pane Move mode |
| `<label>` | Pane Move: pick | Choose the target pane |
| `h` `j` `k` `l` / arrows | Pane Move: place | Dock on the left / bottom / top / right edge of the target |
| `Enter` / `Space` | Pane Move: place | Swap with the target |
| `Backspace` | Pane Move: place | Back to picking |
| `Esc` | Pane Move (any stage, or during a mouse drag) | Cancel |
| Drag the grip | Normal mode, mouse | Move the pane; edge = dock, centre = swap |

### UI Changes

- **Grip.** `.krypton-pane-grip` is one element appended to `document.body`.
  - It is 28×6px with 1px accent borders, `cursor: grab`, at opacity 0.6, rising to 1 on hover.
  - It is never shown on webview panes, because they receive no pointer events.
- **Overlay layer.** `pane-move-overlay.ts` uses one fixed full-viewport layer with `pointer-events: none`.
  - `.krypton-pane-move__label`: a centred hint badge in the same visual language as hint mode.
  - `.krypton-pane-move__preview`: the zone rect, filled with the accent at 0.18 alpha and a 1px accent border (no corner brackets). The centre zone shows a `SWAP` caption.
  - `.krypton-pane--move-source`: `opacity: 0.45` on the source pane.
- **During a pointer drag** the body gets `.krypton-pane-dragging`, which sets `cursor: grabbing` and `user-select: none`, and `pointer-events: none` on `.krypton-pane`. Hit-testing uses the cached rects, so xterm and iframes cannot capture the drag.
- **Animation.** None. The move is an instant rebuild, the same as split and close today.

### Configuration

None. `DROP_EDGE_FRACTION` is a constant.

## Edge Cases

- **Only one visible pane in the workspace.** The grip is hidden; `Leader Alt+m` shows a notification and stays in Normal mode.
- **The source is the only pane in its window.** The move empties the tab, so `removeEmptiedTab` runs, and the window closes if that was its last tab. When the source is in the same tab as the target, the source can never be its only pane.
- **Swapping across windows.** Both panes are rebound. Both windows refit and re-sync their footers.
- **Hidden windows** (stage shelf, Wheel `hidden`, other workspaces, inactive tabs) are not targets. `visibleDropTargets` keeps only the active tab's panes of windows with a non-zero rect on the current workspace.
- **Overlapping windows** (Depth/Stage) can make cached rects overlap. Targets are ordered with the focused window first and then by DOM order, so the topmost-looking window wins. In Grid and Focus layouts windows never overlap.
- **Webview panes.** They can be targets in both front ends, because webviews are suspended while the mode is active. They can be a source only from the keyboard.
- **A PTY exits during a drag.** `handlePtyExit` removes the pane. On release, `movePane` re-resolves both viewIds and returns `false` if either is gone, and the overlay closes.
- **Recovery-notice panes** move like any content pane.
- **Spec 0296 side column.** A moved pane leaves its source tab's `sidePaneIds`. The target tab's side column is unchanged.
- **Spec 0296 divider drag.** Dividers are reused by `mountPaneTree`, so their handlers survive rebuilds. A new split from `dockLeaf` gets a divider created and wired there.
- **Persistence.** The snapshot already stores the tree shape and ratios, so a moved layout survives a WebContent reload. Terminal leaves reattach, and content leaves become notices as they do today.

## Open Questions

None.

## Out of Scope

- Dragging a pane onto empty workspace to tear it off into a new window, or onto a tab bar to make it a tab.
- Dragging tabs or windows.
- Drop animations or a cursor-following ghost.
- Fixing `moveTabToWindow`'s missing `onOutputPump`/title rebinding. `rebindPane` makes that fix a one-line follow-up, but it is not part of this spec.
- Dropping files from Finder onto panes.

## Resources

- Zed `crates/workspace/src/pane.rs` `handle_drag_move` / `handle_tab_drop`, and `assets/settings/default.json` `drop_target_size: 0.2` (local `/Users/wk/Source/zed`): the edge-zone geometry and the nearest-edge rule.
- [VS Code 1.52 release notes — `workbench.editor.splitOnDragAndDrop`](https://code.visualstudio.com/updates/v1_52): drag to split editor groups, with a preview overlay.
- [VS Code issue #198603 — confusing drag areas in editor](https://github.com/microsoft/vscode/issues/198603): why the preview must show the resulting half, not just a highlight.
- [iTerm2 documentation](https://iterm2.com/documentation-one-page.html): *Move Session to Split Pane*, and dragging panes across tabs and windows (layout lock disables it).
- [iTerm2 cheatsheet gist](https://gist.github.com/squarism/ae3613daf5c01a98ba3a): the pick-then-place flow across tabs and windows.
- tmux(1) `swap-pane`, `join-pane`/`move-pane`, `display-panes`: label-based target selection, then a direction flag.
