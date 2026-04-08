# Depth / Z-Stack Layout Mode — Implementation Spec

> Status: Implemented
> Date: 2026-04-08
> Milestone: M3 — Compositor & Windows

## Problem

Krypton currently has two layout modes: Grid (auto-tile) and Focus (main + stack). Both arrange windows in a flat 2D plane. There's no spatial depth metaphor — no sense of "looking through" stacked layers. A Z-Stack mode would give the compositor a third dimension: windows stacked like cards in a deck, with the focused window at the front and background windows receding as translucent ghost layers.

## Solution

Add a `Depth` layout mode where all windows occupy the full viewport but are layered along the Z-axis using CSS 3D transforms (`perspective`, `scale`, `translateY`, `opacity`). The focused window sits at z-depth 0 (full size, full opacity). Background windows are progressively scaled down, shifted upward, and dimmed — visible as ghost layers behind the front card. Navigation pushes/pulls through the deck. Transitions animate the card shuffle.

**No `backdrop-filter: blur()`** — macOS WKWebView freeze. Ghost layers use reduced opacity + `filter: brightness()` instead.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `Depth` to `LayoutMode` enum |
| `src/compositor.ts` | Add `relayoutDepth()`, update `toggleFocusLayout()` cycle, add depth navigation methods, track depth visual order |
| `src/animation.ts` | Add `depthShuffle()` transition for card push/pull |
| `src/input-router.ts` | Add `d` key in Compositor mode for Depth layout; `j`/`k` navigation behavior in Depth mode |
| `src/styles/window.css` | Add `.krypton-window--depth-N` classes for ghost layer styling |
| `src/styles/compositor.css` | Add `perspective` on workspace container |

## Design

### Data Structures

```typescript
// types.ts — extend existing enum
export enum LayoutMode {
  Grid = 'Grid',
  Focus = 'Focus',
  Depth = 'Depth',    // <-- new
}
```

No new interfaces needed. `WindowBounds` already covers x/y/width/height. Depth-specific transforms (scale, opacity, translateY) are applied directly via inline styles and CSS classes, not stored in bounds.

### Depth Stack State

In `compositor.ts`, add:

```typescript
/** Ordered list of window IDs from front (index 0) to back. */
private depthOrder: WindowId[] = [];
```

The focused window is always `depthOrder[0]`. When focus changes, the array is reordered and a shuffle animation plays.

### Layout Algorithm — `relayoutDepth()`

All windows get the same bounds (full viewport or a comfortable inset). Depth is expressed purely through CSS transforms:

```typescript
private relayoutDepth(vw: number, vh: number, count: number): void {
  // All windows occupy the same centered region
  const w = Math.round(vw * Compositor.DEPTH_WIDTH_RATIO);   // 0.88
  const h = Math.round(vh * Compositor.DEPTH_HEIGHT_RATIO);  // 0.90
  const x = Math.round((vw - w) / 2);
  const y = Math.round((vh - h) / 2);

  // Build depth order: focused first, then remaining in MRU order
  this.depthOrder = this.buildDepthOrder();

  for (let i = 0; i < this.depthOrder.length; i++) {
    const win = this.windows.get(this.depthOrder[i]);
    if (!win) continue;

    win.bounds = { x, y, width: w, height: h };
    this.applyBounds(win);
    this.applyDepthLayer(win, i, count);
  }
}
```

### Depth Layer Visual Properties

Each layer `i` (0 = front, N = back) gets:

| Property | Formula | i=0 (front) | i=1 | i=2 | i=3+ |
|----------|---------|-------------|-----|-----|------|
| `scale` | `1 - i * 0.05` | 1.0 | 0.95 | 0.90 | 0.85... |
| `translateY` | `-i * 20px` | 0 | -20px | -40px | -60px... |
| `opacity` | `1 - i * 0.25` | 1.0 | 0.75 | 0.50 | 0.25 |
| `brightness` | `1 - i * 0.15` | 1.0 | 0.85 | 0.70 | 0.55 |
| `z-index` | `100 - i` | 100 | 99 | 98 | 97... |
| `pointer-events` | i === 0 ? 'auto' : 'none' | auto | none | none | none |

Maximum visible layers: **4** (layers beyond index 3 get `display: none` to save GPU).

```typescript
private applyDepthLayer(win: KryptonWindow, depth: number, total: number): void {
  const el = win.element;
  const MAX_VISIBLE = 4;

  if (depth >= MAX_VISIBLE) {
    el.style.display = 'none';
    return;
  }

  el.style.display = '';
  el.style.zIndex = `${100 - depth}`;
  el.style.pointerEvents = depth === 0 ? 'auto' : 'none';

  const scale = 1 - depth * 0.05;
  const ty = -depth * 20;
  el.style.transform = `scale(${scale}) translateY(${ty}px)`;
  el.style.transformOrigin = 'center bottom';
  el.style.opacity = `${Math.max(0.15, 1 - depth * 0.25)}`;
  el.style.filter = depth > 0
    ? `brightness(${1 - depth * 0.15})`
    : '';
}
```

### Depth Navigation

"Push into depth" = cycle through the deck. Two operations:

- **Pull forward** (`k` in Compositor mode when in Depth layout): Move the next card to front. Rotates `depthOrder` — pops index 1 to index 0, pushes old front to back.
- **Push back** (`j` in Compositor mode when in Depth layout): Reverse — pushes front card to back, next card becomes front.

These reuse `j`/`k` which are already "focus up/down" in Grid and Focus. In Depth mode they mean "pull forward / push back" — consistent spatial metaphor (k = up/forward, j = down/back).

```typescript
/** Rotate the depth stack: bring next card forward */
async depthPullForward(): Promise<void> {
  if (this.depthOrder.length < 2) return;
  const snapshots = this.snapshotBounds();
  const front = this.depthOrder.shift()!;
  this.depthOrder.push(front);
  this.focusWindow(this.depthOrder[0]);
  this.relayoutDepth(window.innerWidth, window.innerHeight, this.windows.size);
  await this.animation.depthShuffle(snapshots, 'forward');
}

/** Rotate the depth stack: send front card to back */
async depthPushBack(): Promise<void> {
  if (this.depthOrder.length < 2) return;
  const snapshots = this.snapshotBounds();
  const back = this.depthOrder.pop()!;
  this.depthOrder.unshift(back);
  this.focusWindow(this.depthOrder[0]);
  this.relayoutDepth(window.innerWidth, window.innerHeight, this.windows.size);
  await this.animation.depthShuffle(snapshots, 'backward');
}
```

### Shuffle Animation — `depthShuffle()`

New method in `AnimationEngine`:

```typescript
async depthShuffle(
  direction: 'forward' | 'backward',
  windows: Map<WindowId, { element: HTMLElement; depth: number }>,
  duration: number = 200,
): Promise<void>
```

**Forward animation** (pull next card up):
- Old front: scale down + fade + slide back (→ depth 1 position)
- New front: scale up + brighten + slide forward (depth 1 → depth 0)
- All others: shift one position deeper

**Backward animation**: reverse.

Uses WAAPI keyframes on `transform`, `opacity`, and `filter` simultaneously. Duration: 200ms with `EaseOut` easing — fast and snappy, feels like flipping cards.

### Mode Toggle Cycle

Update `toggleFocusLayout()` to cycle through three modes:

```
Grid → Focus → Depth → Grid
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `f` | Compositor mode | Cycle layout: Grid → Focus → Depth → Grid (existing key, extended cycle) |
| `j` | Compositor + Depth layout | Push back (send front to back of deck) |
| `k` | Compositor + Depth layout | Pull forward (bring next card to front) |
| `1-9` | Compositor + Depth layout | Jump to window N (reorder deck so that window is at front) |

`j`/`k` already mean "focus down/up" in Grid and Focus modes. In Depth mode they take on the deck navigation meaning. The input router checks `this.compositor.currentLayoutMode === LayoutMode.Depth` to branch.

### CSS Changes

```css
/* compositor.css — add perspective context to workspace */
.krypton-workspace {
  perspective: 1200px;
  perspective-origin: center 80%;
}

/* window.css — depth layer base transition for smooth property changes */
.krypton-window--depth {
  transition: transform 200ms cubic-bezier(0, 0, 0.2, 1),
              opacity 200ms cubic-bezier(0, 0, 0.2, 1),
              filter 200ms cubic-bezier(0, 0, 0.2, 1);
  transform-origin: center bottom;
}
```

The `--depth` modifier class is added/removed when entering/leaving Depth layout mode. Individual layer properties (scale, opacity, etc.) are applied inline by `applyDepthLayer()`.

### Cleaning Up on Mode Exit

When switching away from Depth layout, `relayout()` must clear depth-specific inline styles:

```typescript
private clearDepthStyles(): void {
  for (const [, win] of this.windows) {
    win.element.classList.remove('krypton-window--depth');
    win.element.style.transform = '';
    win.element.style.opacity = '';
    win.element.style.filter = '';
    win.element.style.pointerEvents = '';
    win.element.style.display = '';
    win.element.style.zIndex = '';
  }
}
```

Called at the top of `relayoutGrid()` and `relayoutFocus()`, or in the mode toggle before switching away from Depth.

## Edge Cases

| Case | Handling |
|------|----------|
| **Single window** | Full viewport, no ghost layers. Depth mode looks identical to maximized. |
| **Window created while in Depth** | Append to back of `depthOrder`, apply layer styling. If it should auto-focus, move to front. |
| **Window closed while in Depth** | Remove from `depthOrder`, relayout remaining. If front window was closed, next card promotes to front. |
| **Maximized + Depth** | Maximize overrides depth (hides all others). Un-maximize returns to depth layout. |
| **Pinned windows** | Pinned windows stay at their depth position — they don't auto-sort to back. Pin toggling doesn't affect depth order. |
| **Resize mode in Depth** | Only the front window (depth 0) can be resized. Entering resize on a background window is a no-op. |
| **> 4 windows** | Layers 4+ are `display: none`. They exist in the deck but aren't rendered until navigated to. |

## Out of Scope

- **Mouse/trackpad gestures** (swipe to navigate deck) — keyboard-first, mouse support later
- **3D perspective rotation** (tilting cards in 3D space like a Rolodex) — too heavy for v1, revisit if the flat Z-stack feels too simple
- **Per-workspace depth order persistence** — depth order resets when switching workspaces (same as focus order today)
- **Configuration** (depth scale factor, max visible layers, etc.) — hardcode sensible defaults first, make configurable later if requested
