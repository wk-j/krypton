# Open to Side: Content Panes in Splits — Implementation Spec

> Status: Draft
> Date: 2026-10-14
> Milestone: M3 — Compositor & Windows

## Problem

`Compositor.splitPane()` always creates a terminal pane, so a file cannot be shown beside the view the user is working in. Reading a file the ACP Harness references means leaving the transcript: file references open Helix in a new tab, and the markdown viewer also opens as a new tab. Split ratios are fixed at 0.5 and cannot be changed by keyboard or mouse.

## Solution

Add an **open to side** primitive. It places a content view (markdown viewer) or a Helix terminal in a split beside the focused pane, in the same tab. The panes it creates form a **side column**: a markdown pane in that column is reused for the next markdown file, and other targets stack inside the column, so the origin pane (for example the Harness) shrinks only once. Entry points are `Shift+<label>` in the Harness `f` open-hint mode, `Alt+click` on a Harness file reference, and `Leader O` (markdown viewer to the side). Split ratios become adjustable with `Shift+H/J/K/L` and `=` in Resize mode, and by dragging the divider. Clicking a pane focuses it.

## Research

- **Panes already host content views.** `Pane.contentView` and `PaneContentType` (`src/types.ts:170,285`) exist, and `fitPaneTree` (`compositor.ts:1525`), `closePaneInTab` (:6257), `disposePaneTree`, `focusPaneDirection` (:6312), `focusPaneSurface` and `showActiveTab` already handle content leaves. Only creation is terminal-only: `splitPane` (:6156) always calls `createPane` + `spawnPaneSession`.
- **Content pane construction** is inlined in `createContentTab` (:5897–5965). Its pane-building half (pane element, glow overlays, `onOutputPump`, `Pane` literal) is reusable for a split leaf.
- **`ContentView.onResize` is called**, by `fitPaneTree` (:1529). `docs/0004-architecture.md` (:269, :1186) and `docs/0244-review-board-chapters.md` say it is never called; that is stale.
- **Close is tab-scoped.** Content views call `closeTab()` from `onClose` (for example `openMarkdownView`, :3748). Inside a split that would close the whole tab, including the Harness, and `closeTab()` targets the focused window's active tab rather than the view's own tab. A pane-scoped close already exists for the bus intent `pane:close` (:1275).
- **PTY exit is already pane-scoped.** `handlePtyExit` (:8184) closes only the exiting pane when the tab has more than one, so quitting Helix in a side pane collapses the split correctly.
- **No PTY kill on pane close.** No Tauri command kills a PTY; `closePaneInTab` only disposes the xterm instance. Replacing a Helix side pane would therefore orphan the editor process and can lose unsaved edits. This is why non-markdown targets stack instead of replacing (see Design).
- **Split ratio is inert.** The ratio is set to 0.5 at creation and never changed. `splitPane` does not apply it as `flex`; both children rely on `.krypton-pane { flex: 1 }`. Only restore (:2959) writes `flex` from the ratio. `.krypton-split__divider` (`window.css:933`) is 1px with `col-resize`/`row-resize` cursors and no handler. `resizeFocused` (:6861) changes window bounds only.
- **No pane click-to-focus.** The window `mousedown` (:2634) calls `focusWindow` only, so after a click inside a non-focused pane the keys still go to the previously focused pane.
- **Restore** turns every non-terminal leaf into a recovery notice (`restorePaneTree`, :2917). That already applies to whole-tab content views; side content panes get the same treatment, with no schema change.
- **Harness open hints** dispatch through `openMessageResource` (`acp-harness-view.ts:9637`) → `openFileReferenceCb` → `openHelixTab`. `Shift+<label>` is the established alternate action (spec 102, spec 283 SVG copy); for resources it is currently ignored.
- **Keys.** `O` is a reserved global leader key that currently repeats `o` because `shiftKey` is not checked. In Resize mode, `H/J/K/L` and `=` are unbound (`input-router.ts:1183`).
- **`docs/0038-diff-view-window.md:298`** says content-pane splits are disabled. The code never enforced this, and this spec supersedes it.
- **Rejected alternatives.**
  - **Driving Helix with `:open <path>` over `write_to_pty`**: the result depends on Helix's mode, so it is brittle.
  - **Replacing the side pane every time**: loses Helix state (see above).
  - **A new native window**: violates the one-native-window rule.
  - **A titlebar split button**: mouse-first; the command palette covers discovery.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | "Open to the Side" (`Ctrl+Enter` in Explorer/Quick Open, `Alt+click`) opens into the editor group to the right, creating it if needed; later opens reuse that group. `workbench.action.increaseViewSize` resizes by keyboard; sashes resize by drag. | Reuse-the-side-group is the model for the side column. |
| Zed | `pane::SplitRight` (`cmd-k right`), project panel `OpenSplitVertical` (vim `v`); vim `ctrl-w < > + -` resize the pane and `ctrl-w =` resets sizes. | Same `=` equalize convention. |
| WezTerm | `SplitPane`; `AdjustPaneSize {'Left', 5}` bound to `LEADER H/J/K/L` in its docs; the divider can be dragged. | Shift+hjkl for pane resize matches. |
| tmux | `prefix %`/`"` split; `prefix M-arrow`/`resize-pane -L 5`; `select-layout even-horizontal`. | Splits are terminal-only. |

**Krypton delta.** Krypton matches VS Code's side-group reuse, VS Code's Alt+click, the WezTerm/Zed Shift+hjkl resize, and the Zed `=` reset. It diverges in three places:
- Resize lives in the existing Resize mode instead of new leader keys.
- Non-markdown targets stack in the side column rather than replace, because Krypton cannot kill a PTY safely.
- There is no titlebar button.

## Affected Files

| File | Change |
|------|--------|
| `src/pane-split.ts` (new) | Pure helpers: `clampSplitRatio`, `findResizableSplit`, `nearestSplit`, `ratioFromPointer` |
| `src/pane-split.test.ts` (new) | Boundary/selection tests for the helpers |
| `src/types.ts` | `Tab.sidePaneIds: PaneId[]` |
| `src/compositor.ts` | `openToSide`, `insertBesidePane`, `mountContentPane` (extracted from `createContentTab`), `spawnEditorSession` (extracted from `openEditorTab`), `closeContentViewHost`, `resizeFocusedSplit`, `equalizeFocusedSplit`, `applySplitFlex`, divider drag, pane click-to-focus, `markdownViewToSide` |
| `src/markdown-view.ts` | Public `showFile(path: string): Promise<void>` that wraps `loadFile` and accepts an absolute path |
| `src/acp/acp-harness-view.ts` | `openFileToSideCb`; `Shift+<label>` and `Alt+click` on a file resource → to side |
| `src/input-router.ts` | `Leader O`; Resize mode `H/J/K/L`, `=` |
| `src/command-palette.ts` | `pane.markdown-to-side`, `pane.split-grow-*`, `pane.split-equalize` |
| `src/which-key.ts` | `O` entry; `RESIZE_KEYS` additions |
| `src/styles/window.css` | Divider hit area; `.krypton-split--dragging` |
| `docs/0013-tabs-and-panes.md`, `0006-configuration.md`, `0072-acp-harness-view.md`, `0038-diff-view-window.md`, `0004-architecture.md`, `0005-data-flow.md`, `0244-review-board-chapters.md`, `README.md` | Document the behavior; drop "content splits disabled" and "onResize never called" |

## Design

### Data Structures

```ts
// src/types.ts — Tab
/** Panes created by openToSide, oldest first. The last live entry is the side
 *  column's insertion point. Not persisted (restored content leaves are notices). */
sidePaneIds: PaneId[];

// src/pane-split.ts
export type SplitAxis = 'horizontal' | 'vertical'; // = SplitDirection
export const SPLIT_RATIO_MIN = 0.1;
export const SPLIT_RATIO_MAX = 0.9;
export function clampSplitRatio(r: number): number;
/** Nearest ancestor split of `paneId` whose direction is `axis`; null if none. */
export function findResizableSplit(tree: PaneNode, paneId: PaneId, axis: SplitDirection): Extract<PaneNode, { type: 'split' }> | null;
/** Nearest ancestor split of `paneId` on either axis. */
export function nearestSplit(tree: PaneNode, paneId: PaneId): Extract<PaneNode, { type: 'split' }> | null;
/** Ratio for a pointer position inside the split element's rect, before clamping. */
export function ratioFromPointer(rect: DOMRect, direction: SplitDirection, clientX: number, clientY: number): number;
```

Every tab literal (`createContentTab`, `openEditorTab`, `createWindow`, `createTab`, restore) initialises `sidePaneIds: []`.

### API / Commands

No new Tauri commands. New public `Compositor` methods:

```ts
openToSide(target: { kind: 'file'; path: string; line?: number | null; col?: number | null } | { kind: 'markdown' }): Promise<boolean>;
resizeFocusedSplit(direction: 'left' | 'right' | 'up' | 'down'): void;
equalizeFocusedSplit(): void;
```

Private:
- `insertBesidePane(tab, anchorId, direction, leaf)`: the `replaceInTree` logic from `splitPane`, shared by both functions.
- `mountContentPane(container, view, winId): Pane`.
- `spawnEditorSession(pane, win, tabId, cwd, editor, args): Promise<boolean>`: also used by `openEditorTab`.
- `closeContentViewHost(view)`: finds the view's pane; closes the pane when its tab has more than one pane, otherwise closes that tab by index. All content `onClose` callbacks that today call `closeTab()` switch to it.
- `applySplitFlex(node)`: sets `flex: <ratio> 1 0` on both children; called by `splitPane`, `insertBesidePane`, restore, keyboard resize and drag.

The Harness view gains `openFileToSideCb: ((path, line, col) => Promise<boolean>) | null`, wired at `compositor.ts:~4861` to `openToSide({ kind: 'file', … })`.

### Data Flow

Opening a file to the side:

```
1. Harness transcript focused → f → Shift+<label> on a file resource (or Alt+click it)
2. openMessageResource(resource, { side: true }); url/image targets ignore `side`
3. openFileToSideCb(path, line, col) → Compositor.openToSide
4. blockLocalViewForRemote guard (same as openMarkdownView), then pick the tab = focused window's active tab
5. side = last id in tab.sidePaneIds still present in the tree
   a. target is .md and side is a markdown pane → side.showFile(path); focus side; done
   b. side exists → anchor = side, direction = 'horizontal' (stack in the column)
   c. no side → anchor = focused pane, direction = 'vertical' (new column right)
6. Build the leaf: .md → MarkdownContentView(files, cwd, el, path) via mountContentPane;
   other → createPane + spawnEditorSession('hx', [`${path}:${line}:${col}`], bufferBeforeSession:false)
7. insertBesidePane(anchor, direction, leaf), ratio 0.5 → applySplitFlex → push leaf id onto sidePaneIds
8. tab.focusedPaneId = leaf; nextFrame; fitPaneTree (terminals fit, views get onResize); focusPaneSurface
```

`Leader O` runs the same flow with `{ kind: 'markdown' }`. Step 5a then just focuses an existing markdown side pane. Otherwise it creates the viewer without an initial file, under the same git-repo gate as `openMarkdownView`.

Resize (keyboard):

```
1. Leader r → Resize mode; Shift+H/L → resizeFocusedSplit('left'|'right'); Shift+K/J → ('up'|'down')
2. split = findResizableSplit(tab.paneTree, focusedPaneId, H/L ? 'vertical' : 'horizontal'); none → no-op
3. delta = stepSize / split.element.clientWidth|clientHeight; left/up subtract, right/down add
4. ratio = clampSplitRatio(ratio ± delta) → applySplitFlex(split) → fitPaneTree(split)
5. `=` → nearestSplit(...).ratio = 0.5 → same apply/fit
```

The divider moves in the pressed direction regardless of which side the focused pane is on. `stepSize` is the existing `[workspaces] resize_step`.

Resize (mouse):

```
1. pointerdown on .krypton-split__divider → setPointerCapture; add .krypton-split--dragging
2. pointermove → ratioFromPointer → clamp → node.ratio; applySplitFlex inside one rAF per frame
3. pointerup/cancel → release capture, remove class, fitPaneTree(node) once
```

Terminals refit only on release, so a drag never sends `resize_pty` once per frame. The split node is found by its `element` with a tree walk from the tab's `paneTree`.

Click to focus: one `mousedown` listener on each window's content element resolves `closest('.krypton-pane')`. If that is a different pane in the active tab, it sets `focusedPaneId` and calls `updatePaneFocusIndicator` + `focusPaneSurface`. The listener runs alongside the existing `focusWindow` and does not `preventDefault`, so clicks inside views behave as before.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Shift+<label>` | Harness open-hint mode, file resource | Open the file to the side |
| `Alt+click` | Harness file reference | Open the file to the side |
| `Leader O` | Compositor mode | Markdown viewer to the side |
| `Shift+H` / `Shift+L` | Resize mode | Move the nearest vertical divider left / right |
| `Shift+K` / `Shift+J` | Resize mode | Move the nearest horizontal divider up / down |
| `=` | Resize mode | Reset the nearest split to 50/50 |
| `q` / `Esc` | Markdown view in a split | Close that pane only (`closeContentViewHost`) |

Unchanged: plain `<label>` and click still open Helix in a new tab; `Leader \`/`-` still split a terminal; `Leader Alt+h/j/k/l` move focus; `Leader Alt+x` closes the pane.

### UI Changes

- `.krypton-split__divider` keeps its 1px look and gains a `::before` hit area: 7px wide, centred, transparent, `position: absolute`, so the divider gets `position: relative`. Hover and `.krypton-split--dragging` raise the divider's accent alpha from `0.15` to `0.5`.
- While dragging, `.krypton-split--dragging` sets `user-select: none` on the split. A `.krypton-split--dragging .krypton-pane { pointer-events: none; }` rule keeps the webview, xterm and iframes from swallowing `pointermove`.
- No per-pane header. The tab title stays the origin view's title; the focused-pane box-shadow shows which pane receives keys.

### Configuration

None. The keyboard step reuses `[workspaces] resize_step`.

## Edge Cases

- **Focused pane is already in the side column** (user moved focus there): step 5 still uses the last side pane as anchor, so stacking stays in the column.
- **Side pane closed** (`Alt+x`, `q`, Helix exit): `closePaneInTab` removes its id from `sidePaneIds`; the next live entry becomes the anchor; with none left, the next open creates a new column.
- **The tab has only the side pane left** (origin pane closed): `sidePaneIds` is cleared, because it is no longer beside anything.
- **Remote (SSH) window**: `openToSide` refuses markdown through `blockLocalViewForRemote`, like `openMarkdownView`. Helix uses the remote-aware `getFocusedCwd` path that `openHelixTab` already uses.
- **Non-git cwd with `.md` target**: same as `openMarkdownView(initialFile)`, which shows the file with an empty sidebar list.
- **Helix spawn fails**: the new leaf is removed with `closePaneInTab` and no id is recorded; the Harness shows `file unavailable` as today.
- **Too-small split**: the ratio is clamped to [0.1, 0.9]; restore keeps its own lenient [0.05, 0.95] clamp for old snapshots.
- **Hidden tab during drag/fit**: drag is only possible on the visible tab; `fitPaneTree` is called on the split node, not the whole window.
- **WebContent reload**: side markdown panes return as recovery notices, as whole-tab views do today. Helix PTYs reattach. `sidePaneIds` starts empty after restore.
- **Wheel layout** reads `ratio` (`toWheelPaneNode`), so resized splits render proportionally there with no change.

## Open Questions

None.

## Out of Scope

- A titlebar split button or a per-pane title header.
- Opening to the side from global hint mode, Quick File Search, file manager or diff view (each can call `openToSide` later).
- Diff, vault and other content types as side targets.
- A markdown source/preview toggle or an editor inside the viewer.
- Persisting side content panes across WebContent reloads.
- Killing PTYs on pane close.
- Moving or swapping panes between splits (spec [0297](./0297-pane-drag-and-drop.md)).

## Resources

- [VS Code — User interface: side-by-side editing](https://code.visualstudio.com/docs/editing/userinterface): Open to the Side, `Ctrl+Enter`, Alt+click, side editor group reuse.
- [VS Code issue #23243 — increase/decrease view size commands](https://github.com/Microsoft/vscode/issues/23243): keyboard-only view resizing.
- Zed keymaps `assets/keymaps/default-macos.json` and `vim.json` (local `/Users/wk/Source/zed`): `pane::SplitRight`, `project_panel::OpenSplitVertical`, `vim::ResizePane*`, `vim::ResetPaneSizes` (`ctrl-w =`).
- [WezTerm — AdjustPaneSize](https://github.com/wezterm/wezterm/blob/main/docs/config/lua/keyassignment/AdjustPaneSize.md): `LEADER H/J/K/L` resize convention and directional semantics.
- [WezTerm — split-pane](https://wezterm.org/cli/cli/split-pane.html): split direction model.
