# Selection Glow Overlay — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: M8 — Polish

## Problem

Krypton's selection mode highlights text via xterm.js's built-in canvas selection (a flat rgba fill). The selection cursor has a simple solid overlay. Neither element has the cyberpunk glow aesthetic that the rest of the UI uses (tab bar glow, edge glow overlays, cursor trail particles). The selection feels visually disconnected from Krypton's identity.

## Solution

Add a DOM-based glow overlay that tracks the selection region and pulses with an animated `box-shadow` glow. Also add a breathing glow animation to the existing `.krypton-selection-cursor`. This keeps the xterm.js canvas selection as the source of truth for the actual highlight while layering a glowing border/shadow effect on top via CSS.

## Affected Files

| File | Change |
|------|--------|
| `src/selection.ts` | Create/update/remove a `<div>` overlay that tracks selection bounds |
| `src/styles.css` | New `.krypton-selection-glow` class + `@keyframes krypton-selection-glow` animation; update `.krypton-selection-cursor` with glow |

## Design

### Data Structures

No new types. The existing `SelectionController` gains two private fields:

```ts
private glowOverlay: HTMLElement | null = null;
```

### API / Commands

No new IPC commands or events. All changes are frontend-only.

### Data Flow

```
1. User enters Selection mode (toggleCharSelect or toggleLineSelect)
2. SelectionController sets anchor, creates glowOverlay div inside terminalBody
3. On every cursor movement (afterMove), updateGlowOverlay() is called
4. updateGlowOverlay() reads anchor + cursor + selectionType to compute
   a bounding rect (top-left to bottom-right in pixel coords)
5. The glowOverlay div is positioned/sized to cover that rect
6. CSS applies animated box-shadow glow + faint border to glowOverlay
7. On exit() or selection cancel, glowOverlay is removed from DOM
```

### UI Changes

#### Selection Glow Overlay (`<div class="krypton-selection-glow">`)

- Created as a child of `terminalBody` (same parent as cursor overlay)
- `position: absolute`, `pointer-events: none`, `z-index: 9` (below cursor overlay at z-index 10)
- Sized and positioned to cover the selection bounding box:
  - **Char selection, single line:** exact rect from anchor.x to cursor.x on the row
  - **Char selection, multi-line:** bounding box from (0, startRow) to (cols, endRow) — full-width rectangle spanning all selected rows (simplification; exact L-shaped tracking is over-engineered)
  - **Line selection:** full-width rect from startRow to endRow
- Pixel calculations reuse the same `cellWidth`/`cellHeight`/padding math already in `updateCursorOverlay()`

#### CSS Styling

```css
.krypton-selection-glow {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 9;
  border: 1px solid rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.4);
  border-radius: 2px;
  background: rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.05);
  box-shadow:
    0 0 8px 2px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.3),
    inset 0 0 6px 1px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.1);
  animation: krypton-selection-glow 2s ease-in-out infinite alternate;
}

@keyframes krypton-selection-glow {
  from {
    box-shadow:
      0 0 8px 2px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.3),
      inset 0 0 6px 1px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.1);
  }
  to {
    box-shadow:
      0 0 16px 4px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.5),
      inset 0 0 10px 2px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.15);
  }
}
```

#### Cursor Glow Enhancement

Update `.krypton-selection-cursor` to include a subtle glow:

```css
.krypton-selection-cursor {
  /* existing properties unchanged */
  box-shadow: 0 0 6px 2px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.5);
  animation: krypton-selection-cursor-pulse 1.2s ease-in-out infinite alternate;
}

@keyframes krypton-selection-cursor-pulse {
  from { opacity: 0.7; box-shadow: 0 0 6px 2px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.5); }
  to   { opacity: 0.9; box-shadow: 0 0 12px 4px rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.7); }
}
```

### Configuration

No new config keys. The glow uses the existing per-window accent color (`--krypton-window-accent-rgb`), so it automatically matches each window's theme.

## Edge Cases

| Case | Handling |
|------|----------|
| No selection active (cursor-only mode) | `glowOverlay` is hidden (`display: none`) or not created until anchor is set |
| Selection cancelled (toggle off) | `glowOverlay` hidden, re-shown if selection restarted |
| Exit selection mode | `glowOverlay` removed from DOM |
| Terminal resized while in selection mode | `afterMove()` already fires on resize via existing flow — overlay recalculates |
| Very small selection (1 char) | Glow still renders around the single cell; `min-width`/`min-height` not needed since cell size is already visible |
| Multi-line char selection bounding box | Uses full-width bounding rect (slightly larger than exact selection) — acceptable visual approximation |
| `backdrop-filter` constraint | No `backdrop-filter` used — only `box-shadow` and `background` (safe per `docs/24-backdrop-filter-removal.md`) |

## Open Questions

None.

## Out of Scope

- Glow on selections made by programs running inside the terminal (Helix, Vim, etc.) — not detectable
- Per-character L-shaped glow tracking for multi-line char selections — over-engineered for the visual benefit
- Configurable glow intensity for selection (could be added later via `[visual] selection_glow_intensity`)
- Sound effects on selection enter/exit
