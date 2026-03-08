# Tabs & Panes — Implementation Spec

> Status: Approved
> Date: 2026-03-08
> Milestone: M5 — Tabs & Panes

## Problem

Each Krypton window currently supports only a single PTY session. Users cannot run multiple shells within a window without creating additional tiled windows. This limits workflow density — a common need is to have several related shells (e.g., editor, server, logs) grouped in one window with quick switching, and to split a view to see two shells side-by-side within a single window.

## Solution

Add a **tab system** and a **pane split system** to each window. Each window gets a tab bar (rendered below the titlebar chrome). Each tab contains a **pane tree** — initially a single pane, but splittable horizontally or vertically into a binary tree of panes. Each leaf pane hosts its own xterm.js `Terminal` instance and PTY session. A reverse lookup map (`sessionId -> paneId`) enables efficient PTY output routing.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `Tab`, `Pane`, `PaneTree`, `PaneLayout` types; extend `KryptonWindow` |
| `src/compositor.ts` | Tab/pane lifecycle (create, close, switch, split, navigate); rewrite PTY routing; extract terminal factory |
| `src/input-router.ts` | Add Tab mode keybindings in Compositor; add pane navigation keys |
| `src/styles.css` | Tab bar CSS, pane container CSS, pane divider CSS |
| `src/theme.ts` | Apply `ChromeTabs` theme values as `--krypton-tab-*` CSS custom properties |
| `src/sound.ts` | Add new `SoundEvent` entries for tab/pane actions + patches |
| `src/config.ts` | Add `TabsConfig` interface |
| `src-tauri/src/config.rs` | Add `TabsConfig` struct with defaults |
| `docs/PROGRESS.md` | Update M5 checkboxes |

## Design

### Data Structures

```typescript
// New types in src/types.ts

export type TabId = string;   // e.g., "tab-0", "tab-1"
export type PaneId = string;  // e.g., "pane-0", "pane-1"

export type SplitDirection = 'horizontal' | 'vertical';

/** A leaf pane — hosts one xterm.js terminal + PTY session */
export interface Pane {
  id: PaneId;
  sessionId: SessionId | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLElement;          // the .krypton-pane div (xterm mounts here)
}

/** Binary tree node for pane splits */
export type PaneNode =
  | { type: 'leaf'; pane: Pane }
  | { type: 'split'; direction: SplitDirection; ratio: number; first: PaneNode; second: PaneNode; element: HTMLElement };

/** A tab within a window */
export interface Tab {
  id: TabId;
  title: string;                 // display title (from OSC or "Shell N")
  paneTree: PaneNode;            // root of the pane tree
  focusedPaneId: PaneId;         // which pane has focus within this tab
}

/** Updated KryptonWindow — replaces single sessionId/terminalContainer */
export interface KryptonWindow {
  id: WindowId;
  tabs: Tab[];
  activeTabIndex: number;
  gridSlot: GridSlot;
  bounds: WindowBounds;
  element: HTMLElement;
  tabBarElement: HTMLElement;     // the .krypton-window__tabbar div
  contentElement: HTMLElement;    // the .krypton-window__content div (hosts active tab's pane tree)
}
```

### Session Reverse Lookup

```typescript
// In compositor.ts — replaces linear scan of windows
private sessionMap: Map<SessionId, { windowId: WindowId; tabId: TabId; paneId: PaneId }> = new Map();
```

When a PTY emits `pty-output`, the compositor looks up `sessionMap.get(sessionId)` in O(1) to find the target pane's terminal and write to it.

### API / Commands

No new Tauri commands needed. The existing `spawn_pty`, `write_to_pty`, `resize_pty`, and `get_pty_cwd` commands are sufficient — each pane spawns its own PTY session using the existing backend.

### Terminal Factory

Extract a reusable function from `createWindow()`:

```typescript
function createTerminalInstance(
  container: HTMLElement,
  config: TerminalInstanceConfig,
  customKeyHandler: CustomKeyHandler | null,
  theme: Record<string, string>,
): { terminal: Terminal; fitAddon: FitAddon } { ... }
```

This factory is used by: window creation (first tab, first pane), new tab creation, pane split creation, and Quick Terminal initialization.

### Data Flow

#### Create New Tab (Leader + t)

```
1. User presses Leader, then t
2. InputRouter.handleCompositorKey('t') calls compositor.createTab(focusedWindowId)
3. Compositor:
   a. Gets CWD from the currently focused pane (via get_pty_cwd)
   b. Generates new TabId and PaneId
   c. Creates pane DOM element (.krypton-pane)
   d. Creates xterm.js Terminal + FitAddon via terminal factory
   e. Creates PaneNode { type: 'leaf', pane }
   f. Creates Tab { id, title: "Shell N", paneTree, focusedPaneId }
   g. Pushes tab to window.tabs, sets activeTabIndex to new tab
   h. Updates tab bar DOM (adds tab element, marks active)
   i. Swaps content: hides previous tab's pane tree DOM, shows new tab's pane DOM
   j. Spawns PTY via invoke('spawn_pty'), assigns sessionId to pane
   k. Registers in sessionMap
   l. Wires terminal.onData -> write_to_pty
   m. Fits terminal, focuses terminal
   n. Plays 'tab.create' sound
4. Returns to Normal mode
```

#### Close Tab (Leader + w)

```
1. User presses Leader, then w
2. InputRouter calls compositor.closeTab(focusedWindowId)
3. Compositor:
   a. Gets the active tab
   b. Recursively disposes all panes in the tab's pane tree:
      - Dispose xterm.js Terminal
      - Remove from sessionMap
      - (PTY cleans up when reader sees EOF from disposed terminal)
   c. Removes tab from window.tabs
   d. If tabs remain: switch to adjacent tab (prefer left, then right)
   e. If no tabs remain: close the window (existing closeWindow flow)
   f. Updates tab bar DOM
   g. Plays 'tab.close' sound
4. Returns to Normal mode
```

#### Switch Tab (Leader + [ / Leader + ])

```
1. User presses Leader, then [ or ]
2. InputRouter calls compositor.switchTab(focusedWindowId, direction)
3. Compositor:
   a. Decrements/increments activeTabIndex (wrapping)
   b. Hides current tab's pane tree DOM
   c. Shows new active tab's pane tree DOM
   d. Fits all visible panes
   e. Focuses the tab's focusedPaneId terminal
   f. Updates tab bar active indicator
   g. Plays 'tab.switch' sound
4. Returns to Normal mode
```

#### Split Pane (Leader + \ for vertical, Leader + - for horizontal)

```
1. User presses Leader, then \ or -
2. InputRouter calls compositor.splitPane(focusedWindowId, direction)
3. Compositor:
   a. Finds the focused pane in the active tab's pane tree
   b. Gets CWD from the focused pane
   c. Creates a new Pane (DOM, Terminal, FitAddon)
   d. Replaces the leaf node with a split node:
      { type: 'split', direction, ratio: 0.5, first: oldLeaf, second: newLeaf, element }
   e. Creates split container DOM with divider between the two pane elements
   f. Spawns PTY for new pane, registers in sessionMap
   g. Wires input, fits both panes
   h. Sets focusedPaneId to the new pane
   i. Plays 'pane.split' sound
4. Returns to Normal mode
```

#### Navigate Panes (Leader + Alt+h/j/k/l)

```
1. User presses Leader, then Alt+h/j/k/l
2. InputRouter calls compositor.focusPane(direction)
3. Compositor:
   a. Gets the focused pane's bounding rect
   b. Finds the nearest pane in the given direction (within the same tab)
   c. Updates tab.focusedPaneId
   d. Focuses the new pane's terminal
   e. Updates visual focus indicator on panes
   f. Plays 'pane.focus' sound
4. Returns to Normal mode
```

#### Close Pane (Leader + Alt+x)

```
1. User presses Leader, then Alt+x
2. InputRouter calls compositor.closePane(focusedWindowId)
3. Compositor:
   a. If only one pane in tab: close the tab instead
   b. Disposes the focused pane (terminal, sessionMap entry)
   c. Replaces the parent split node with the sibling node
   d. Updates DOM, fits remaining panes
   e. Sets focusedPaneId to the sibling pane
   f. Plays 'pane.close' sound
4. Returns to Normal mode
```

#### Move Tab to Another Window (Leader + T then window index)

```
1. User presses Leader, then T (shift+t)
2. InputRouter enters a transient "tab-move" state, waits for window index (1-9)
3. User presses 1-9
4. Compositor:
   a. Detaches the active tab from the source window (DOM, tab bar update)
   b. Attaches the tab to the target window (appends to window.tabs, updates tab bar)
   c. Updates sessionMap entries for all panes in the moved tab
   d. If source window has no tabs left: close the window
   e. Fits panes in the target window
   f. Plays 'tab.move' sound
5. Returns to Normal mode
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `t` | Compositor mode | Create new tab in focused window |
| `w` | Compositor mode | Close active tab (or window if last tab) |
| `[` | Compositor mode | Switch to previous tab |
| `]` | Compositor mode | Switch to next tab |
| `1-9` (after `T`) | Compositor mode | Move active tab to window N |
| `T` (Shift+t) | Compositor mode | Enter tab-move (wait for window index) |
| `\` | Compositor mode | Split focused pane vertically (left/right) |
| `-` | Compositor mode | Split focused pane horizontally (top/bottom) |
| `Alt+h/j/k/l` | Compositor mode | Navigate between panes in direction |
| `Alt+x` | Compositor mode | Close focused pane |

### Tab Bar UI

The tab bar is a horizontal strip inserted between `.krypton-window__chrome` and `.krypton-window__content`:

```html
<div class="krypton-window__tabbar">
  <div class="krypton-tab krypton-tab--active" data-tab-id="tab-0">
    <span class="krypton-tab__title">Shell 1</span>
  </div>
  <div class="krypton-tab" data-tab-id="tab-1">
    <span class="krypton-tab__title">Shell 2</span>
  </div>
</div>
```

The tab bar is **hidden when there is only one tab** (no visual clutter for single-tab windows). It appears automatically when a second tab is created.

### Pane Container DOM

Each tab's pane tree maps to nested flex containers:

```html
<!-- Single pane (leaf) -->
<div class="krypton-pane" data-pane-id="pane-0">
  <!-- xterm.js mounts here -->
</div>

<!-- Vertical split -->
<div class="krypton-split krypton-split--vertical">
  <div class="krypton-pane" data-pane-id="pane-0"><!-- xterm --></div>
  <div class="krypton-split__divider"></div>
  <div class="krypton-pane" data-pane-id="pane-1"><!-- xterm --></div>
</div>

<!-- Nested splits -->
<div class="krypton-split krypton-split--horizontal">
  <div class="krypton-pane" data-pane-id="pane-0"><!-- xterm --></div>
  <div class="krypton-split__divider"></div>
  <div class="krypton-split krypton-split--vertical">
    <div class="krypton-pane" data-pane-id="pane-1"><!-- xterm --></div>
    <div class="krypton-split__divider"></div>
    <div class="krypton-pane" data-pane-id="pane-2"><!-- xterm --></div>
  </div>
</div>
```

### Pane Focus Indicator

The focused pane within a window gets a subtle inner border glow (thinner than the window focus indicator), using `--krypton-pane-focus-color` (defaults to a dimmed version of the window focus color).

### CSS Classes

| Class | Purpose |
|-------|---------|
| `.krypton-window__tabbar` | Tab bar container (flex row, hidden when 1 tab) |
| `.krypton-tab` | Individual tab element |
| `.krypton-tab--active` | Active tab styling |
| `.krypton-tab__title` | Tab title text |
| `.krypton-pane` | Leaf pane (flex: 1, hosts xterm.js) |
| `.krypton-pane--focused` | Focused pane indicator |
| `.krypton-split` | Split container (flex row or column) |
| `.krypton-split--vertical` | Vertical split (flex-direction: row) |
| `.krypton-split--horizontal` | Horizontal split (flex-direction: column) |
| `.krypton-split__divider` | Draggable divider between panes |

### Configuration

```toml
[tabs]
# Show tab bar even with a single tab (default: false — auto-hide)
always_show_tabbar = false
# Default split direction for new panes
default_split = "vertical"   # "vertical" | "horizontal"
# Close window when last tab is closed (default: true)
close_window_on_last_tab = true
```

### Theme Integration

The existing `ChromeTabs` theme structure is already parsed. Apply it as CSS custom properties:

```typescript
// In FrontendThemeEngine.applyTheme():
style.setProperty('--krypton-tab-height', `${theme.chrome.tabs.height}px`);
style.setProperty('--krypton-tab-background', theme.chrome.tabs.background);
style.setProperty('--krypton-tab-active-color', theme.chrome.tabs.active_color);
style.setProperty('--krypton-tab-inactive-color', theme.chrome.tabs.inactive_color);
style.setProperty('--krypton-tab-font-size', `${theme.chrome.tabs.font_size}px`);
```

### Sound Events

New events added to `SoundEvent` type:

| Event | Patch Character |
|-------|----------------|
| `tab.create` | Light click (similar to `window.focus` but slightly fuller) |
| `tab.close` | Soft thock (similar to `mode.exit`) |
| `tab.switch` | Quick tap (similar to `window.focus`) |
| `tab.move` | Firm click (similar to `swap.complete`) |
| `pane.split` | Short mechanical split sound |
| `pane.close` | Soft release |
| `pane.focus` | Ultra-light tap |

## Edge Cases

1. **Close last pane in tab**: Closes the tab, falling through to close-tab logic.
2. **Close last tab in window**: Closes the window (existing `closeWindow` flow).
3. **Close last window**: Quits the app (existing behavior preserved).
4. **PTY exit in a pane**: Closes that pane (not the whole tab). If it's the last pane, closes the tab.
5. **Move tab to same window**: No-op.
6. **Move tab to non-existent window index**: No-op (beep/flash).
7. **Split when window is very small**: Enforce minimum pane size (e.g., 20 cols x 5 rows). Reject split if it would create panes below minimum.
8. **Tab title from OSC**: Update the active pane's tab title when OSC title-change is received. If multiple panes exist, use the focused pane's title.
9. **Resize window with panes**: `fitAll()` recursively fits all visible panes in the active tab, respecting split ratios.
10. **Maximize with panes**: Works at the window level (all panes grow proportionally).

## Out of Scope

- **Pane resize via keyboard** — Could be added later as a "Pane Resize" mode (similar to window Resize mode). Not in this spec.
- **Pane drag-and-drop reordering** — Mouse interaction, secondary priority. Not in this spec.
- **Tab drag-and-drop reordering** — Mouse interaction, secondary priority. Not in this spec.
- **Persistent tab/pane layout in config** — Workspace presets don't yet define per-window tab/pane layouts. Future enhancement.
- **Tab-specific keybinding overrides** — All tabs share the same keybindings.
