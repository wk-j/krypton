# Visual Chrome Polish — Terminal Glow, Tab Styling, Selection Effects

> Status: Implemented
> Date: 2026-03-20 (glow overlays), 2026-03-22 (tab styling), 2026-03-23 (selection glow)
> Milestone: M5/M8 — Visual Polish
>
> Consolidates: former docs 29 (terminal glow), 32 (tab styling), 33 (selection glow)

---

## 1. Terminal Glow Overlays

Accent-tinted gradient glows on the top and bottom edges of each terminal pane, adding visual depth and atmosphere.

### DOM Structure

Each terminal wrapper gets two overlay children:

```
.krypton-pane__terminal
  +-- .krypton-glow-overlay              (top)
  +-- .krypton-glow-overlay--bottom      (bottom)
  +-- .xterm (terminal canvas)
```

Same structure for Quick Terminal's `.krypton-window__body`.

### CSS

```css
.krypton-glow-overlay {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: calc(var(--krypton-terminal-cell-height, 17px) * 5 + 4px);
  background: linear-gradient(to bottom,
    rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.35), transparent 100%);
  opacity: var(--krypton-glow-intensity, 0.8);
  mask-image: linear-gradient(to bottom, black 0%, transparent 100%);
  pointer-events: none;
  z-index: 12;
}

.krypton-glow-overlay--bottom {
  top: auto; bottom: 0;
  background: linear-gradient(to top,
    rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.35), transparent 100%);
  mask-image: linear-gradient(to top, black 0%, transparent 100%);
}
```

### Configuration

```toml
[visual]
glow_intensity = 0.8   # 0.0 = off, 3.0 = max. Default: 0.8
```

CSS custom properties `--krypton-terminal-cell-height` and `--krypton-glow-intensity` are set on document root by `applyConfig()`. If `glow_intensity == 0`, overlays are hidden.

### Affected Files

| File | Change |
|------|--------|
| `src/styles.css` | `.krypton-glow-overlay` base + `--bottom` modifier rules |
| `src/compositor.ts` | Create overlay elements in `createPane()` and Quick Terminal; set CSS custom properties |
| `src-tauri/src/config.rs` | `glow_intensity: f64` in `VisualConfig` (default `0.8`) |

---

## 2. Futuristic Tab Styling

Tab bar restyled as a **HUD segment strip** matching Krypton's cyberpunk design language.

### New DOM Structure

```html
<div class="krypton-window__tabbar krypton-window__tabbar--visible">
  <div class="krypton-tab krypton-tab--active" data-tab-id="tab-0">
    <span class="krypton-tab__index">01</span>
    <span class="krypton-tab__dot"></span>
    <span class="krypton-tab__title">Shell 1</span>
  </div>
  <div class="krypton-tab" data-tab-id="tab-1">
    <span class="krypton-tab__index">02</span>
    <span class="krypton-tab__dot"></span>
    <span class="krypton-tab__title">vim</span>
  </div>
</div>
```

- **`.krypton-tab__index`** -- Zero-padded tab number (`01`, `02`, ...) styled as a dim HUD readout (8px, monospace, tabular-nums)
- **`.krypton-tab__dot`** -- 4px x 4px square status indicator (bright on active, dim on inactive)

### Active Tab Effects

- Clip-path trapezoid shape: `clip-path: polygon(4px 0%, calc(100% - 4px) 0%, 100% 100%, 0% 100%)`
- Semi-transparent accent background (`rgba(accent, 0.08)`)
- 2px left border accent
- Text shadow glow: `0 0 8px rgba(accent, 0.4)`
- Animated scan line (`::after`): horizontal gradient sweep, 4s loop, 0.06 opacity

```css
@keyframes krypton-tab-scan {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}
```

### Inactive Tabs

No clip-path, no background fill, dimmed (0.2-0.3 opacity), slight brightening on hover.

### Visual Reference

```
+-------------------------------------------------+
| . SESSION_01                           zsh      |  <- titlebar
| :::::::::::::::::::::::::::::::::::::::::::::::  |  <- header accent
| |/01 # SHELL 1 /  02 . VIM   03 . LOGS        |  <- tab bar (01 active)
|                                                 |
| $ _                                             |  <- terminal content
+-------------------------------------------------+
```

### Affected Files

| File | Change |
|------|--------|
| `src/styles.css` | Replace tab bar CSS with HUD segment styling, add keyframe animations |
| `src/compositor.ts` | Update `rebuildTabBar()`, `createTab()`, `createWindow()` to emit new DOM elements |

---

## 3. Selection Glow Overlay

Scan-line sweep animation over the selection region + breathing glow on the selection cursor.

### DOM

A `<div class="krypton-selection-glow">` is created inside `terminalBody` when selection starts, positioned/sized to cover the selection bounding box. Removed on exit.

- `position: absolute`, `pointer-events: none`, `z-index: 9` (below cursor overlay at z-10)
- Sizing: char selection single-line = exact rect; multi-line = full-width bounding box; line selection = full-width rows

### CSS

```css
.krypton-selection-glow {
  position: absolute;
  pointer-events: none;
  z-index: 9;
  background: rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.06);
  overflow: hidden;
}

/* Horizontal scan-line sweep */
.krypton-selection-glow::after {
  content: '';
  position: absolute;
  top: 0; left: -100%; width: 100%; height: 100%;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(var(--krypton-window-accent-rgb), 0.15) 40%,
    rgba(var(--krypton-window-accent-rgb), 0.3) 50%,
    rgba(var(--krypton-window-accent-rgb), 0.15) 60%,
    transparent 100%);
  animation: krypton-selection-scan 3s linear infinite;
}

@keyframes krypton-selection-scan {
  from { left: -100%; }
  to   { left: 100%; }
}
```

### Cursor Glow Enhancement

```css
.krypton-selection-cursor {
  box-shadow: 0 0 6px 2px rgba(var(--krypton-window-accent-rgb), 0.5);
  animation: krypton-selection-cursor-pulse 1.2s ease-in-out infinite alternate;
}

@keyframes krypton-selection-cursor-pulse {
  from { opacity: 0.7; box-shadow: 0 0 6px 2px rgba(var(--krypton-window-accent-rgb), 0.5); }
  to   { opacity: 0.9; box-shadow: 0 0 12px 4px rgba(var(--krypton-window-accent-rgb), 0.7); }
}
```

### Affected Files

| File | Change |
|------|--------|
| `src/selection.ts` | Create/update/remove glow overlay div tracking selection bounds |
| `src/styles.css` | `.krypton-selection-glow` + `@keyframes krypton-selection-scan`; cursor glow update |

---

## Edge Cases (All Sections)

| Case | Handling |
|------|----------|
| Font size change | `--krypton-terminal-cell-height` updates, overlay height adjusts via CSS `calc()` |
| `glow_intensity = 0` | Both glow overlays hidden entirely |
| Short terminals (< 10 rows) | Top and bottom glows overlap naturally |
| 10+ tabs | Index numbers handle double digits; titles use `text-overflow: ellipsis` |
| Theme changes | All colors use `--krypton-window-accent-rgb`, hot-reload works automatically |
| No selection active | Glow overlay hidden or not created until anchor is set |
| Terminal resized in selection mode | `afterMove()` fires, overlay recalculates |
| `backdrop-filter` constraint | No `backdrop-filter` used anywhere (see architecture doc) |
