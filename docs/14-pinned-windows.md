# Pinned Windows — Implementation Spec

> Status: Implemented
> Date: 2026-03-09
> Milestone: M3/M4 — Compositor & Keyboard System

## Problem

In Focus layout, all windows participate in the focus cycle (Cmd+Shift+</>). Users often want a reference terminal (logs, docs, monitoring) permanently visible on the right side of the screen while cycling through other windows in the main (left) position. Currently there is no way to exclude a window from the focus cycle or anchor it to a fixed position.

## Solution

Add a **pin** toggle to any terminal window. A pinned window:
1. Sticks to the **right column** in Focus layout (never moves to the main/left position)
2. Is **skipped** during focus cycling (Cmd+Shift+</>)
3. Can still receive focus via direct click or directional focus (h/j/k/l)
4. Shows a visual pin indicator in its title bar
5. In Grid layout, pinned windows participate normally (pin only affects Focus layout behavior)

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `pinned: boolean` to `KryptonWindow` |
| `src/compositor.ts` | Pin/unpin toggle, skip pinned in `focusCycle()`, adjust `relayoutFocus()` to keep pinned windows in right stack |
| `src/input-router.ts` | Add `p` key in Compositor mode to toggle pin |
| `src/layout.ts` | Update `focusTile()` to accept pinned indices |
| `src/which-key.ts` | Add pin entry to Compositor mode key list |

## Design

### Data Structures

Add `pinned` field to `KryptonWindow` in `src/types.ts`:

```typescript
export interface KryptonWindow {
  id: WindowId;
  tabs: Tab[];
  activeTabIndex: number;
  gridSlot: GridSlot;
  bounds: WindowBounds;
  element: HTMLElement;
  tabBarElement: HTMLElement;
  contentElement: HTMLElement;
  pinned: boolean;  // NEW
}
```

### API / Commands

No new Tauri IPC commands — pin state is purely frontend.

New public method on `Compositor`:

```typescript
/** Toggle pin state of the focused window */
togglePin(windowId?: WindowId): void
```

### Data Flow

**Toggling pin:**
1. User presses `p` in Compositor mode
2. `InputRouter.handleCompositorKey()` calls `compositor.togglePin()`
3. `togglePin()` flips `win.pinned`, updates CSS class, plays sound, triggers `relayout()`
4. Returns to Normal mode

**Focus cycling with pinned windows:**
1. User presses Cmd+Shift+< or Cmd+Shift+>
2. `focusCycle()` filters pinned windows out of the cycle order
3. Only unpinned windows are cycled through
4. If ALL windows are pinned, cycling does nothing

**Focus layout with pinned windows:**
1. `relayoutFocus()` separates windows into unpinned and pinned lists
2. The focused unpinned window takes the left/main column (65% width)
3. Right column is split: unpinned stack on top, pinned windows below (separated by a slightly larger gap)
4. If the focused window is pinned (via click/directional focus), it stays in the right column — the most recently focused *unpinned* window takes the left column
5. If there are no unpinned windows, the first pinned window takes the left column

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `p` | Compositor mode | Toggle pin on focused window |

### UI Changes

- Pinned windows get CSS class `krypton-window--pinned`
- A small pin icon (📌 using Unicode `\u{1F4CC}` or a CSS pseudo-element) appears in the title bar area
- Pin icon styled via `--krypton-pin-color` CSS custom property (defaults to theme accent color)
- Subtle visual separator between unpinned stack and pinned stack in the right column (2x normal gap)

## Edge Cases

| Case | Behavior |
|------|----------|
| Pin the only window | Allowed; no visible layout change (single window stays in main position) |
| Pin all windows | Focus cycling becomes a no-op. All windows participate in layout normally. |
| Pin the currently focused (main) window in Focus layout | Window moves to right column; the next unpinned window takes the main position |
| Unpin while in right column | Window rejoins the unpinned pool; layout recalculates |
| Close a pinned window | Normal close behavior; pin state discarded |
| Toggle to Grid layout | Pin state is preserved but has no visual effect; all windows tile normally |
| Toggle back to Focus layout | Pin state re-activates; pinned windows go to right stack |
| Maximize a pinned window | Allowed; maximize overrides pin layout temporarily |
| directional focus (h/l) to pinned window | Allowed; pinned window receives focus but stays in right column |

## Out of Scope

- Persisting pin state across app restarts (future config work)
- Pinning across workspaces (workspaces not yet implemented)
- Configurable pin position (e.g. pin to left) — always right column
- Pin in Grid layout (pin only affects Focus layout)
