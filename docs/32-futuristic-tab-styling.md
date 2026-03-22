# Futuristic Tab Styling — Implementation Spec

> Status: Implemented
> Date: 2026-03-22
> Milestone: M5 — Tabs & Panes (visual polish)

## Problem

The current tab bar is visually plain — just uppercase text with a 1px underline on the active tab. It doesn't match the cyberpunk HUD aesthetic of the rest of the window chrome (corner accents, striped header bar, status dots, glowing borders). Tabs feel like an afterthought rather than an integrated part of the sci-fi terminal experience.

## Solution

Restyle the tab bar as a **HUD segment strip** that matches Krypton's cyberpunk design language. Each tab becomes a distinct visual segment with an index number, status indicator, angled clip-path shape, and glow effects. The active tab gets an animated scan line and prominent glow. No functionality changes — this is purely CSS + minor DOM structure updates.

## Affected Files

| File | Change |
|------|--------|
| `src/styles.css` | Replace tab bar CSS with new HUD segment styling, add keyframe animations |
| `src/compositor.ts` | Update `rebuildTabBar()`, `createTab()`, and initial tab creation in `createWindow()` to emit new DOM elements (index span, status dot) |

## Design

### New DOM Structure

Each tab gains two new child elements — an index number and a status indicator:

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

- **`.krypton-tab__index`** — Zero-padded tab number (`01`, `02`, ...) styled as a dim HUD readout
- **`.krypton-tab__dot`** — Small square status indicator (bright on active, dim on inactive)

### CSS Changes

#### Tab Bar

- Add a thin top border line (accent color at low opacity) to separate from header accent
- Add a subtle repeating stripe background (matching the header accent pattern) at very low opacity
- Slightly taller height (28px instead of 24px) to accommodate the richer tab content

#### Individual Tabs

- **Clip-path trapezoid shape on active tab** — `clip-path: polygon(4px 0%, calc(100% - 4px) 0%, 100% 100%, 0% 100%)` gives a subtle angled/beveled look
- **Background on active tab** — semi-transparent accent color fill (`rgba(accent, 0.08)`)
- **Left border accent** — 2px left border on active tab in accent color
- **Increased gap** between tabs (8px) with a small diagonal separator mark between them using `::before` on non-first tabs

#### Tab Index

- Smaller font size (8px), slightly dimmer than the title
- Fixed width so numbers align
- Monospace with tabular-nums for consistent width

#### Tab Dot (Status Indicator)

- 4px x 4px square (not circle — fits the angular HUD aesthetic)
- Active: full accent color with box-shadow glow
- Inactive: very dim accent color (0.15 opacity)

#### Active Tab Effects

- **Text shadow glow** on the title: `0 0 8px rgba(accent, 0.4)`
- **Bottom accent line** upgraded from 1px to 2px with glow (`box-shadow: 0 0 6px`)
- **Animated scan line** — a `::after` pseudo-element with a horizontal gradient that sweeps left-to-right every 4 seconds using `@keyframes krypton-tab-scan`. Very subtle (0.06 opacity) so it doesn't distract

#### Inactive Tabs

- No clip-path (flat edges)
- No background fill
- Dimmed index, dot, and title (0.2-0.3 opacity range)
- On hover: slight brightening to 0.4 opacity

### Keyframe Animations

```css
@keyframes krypton-tab-scan {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}
```

Applied only to `.krypton-tab--active::after` with `animation: krypton-tab-scan 4s linear infinite`.

### Compositor Changes

The `rebuildTabBar()` method and tab creation in `createTab()` / `createWindow()` need to create the new child elements. A small helper `buildTabElement(tabId, index, title)` will be extracted to avoid duplication across the three call sites.

```typescript
private buildTabElement(tabId: TabId, index: number, title: string): HTMLElement {
  const tabEl = document.createElement('div');
  tabEl.className = 'krypton-tab';
  tabEl.dataset.tabId = tabId;

  const indexSpan = document.createElement('span');
  indexSpan.className = 'krypton-tab__index';
  indexSpan.textContent = String(index + 1).padStart(2, '0');

  const dot = document.createElement('span');
  dot.className = 'krypton-tab__dot';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'krypton-tab__title';
  titleSpan.textContent = title;

  tabEl.appendChild(indexSpan);
  tabEl.appendChild(dot);
  tabEl.appendChild(titleSpan);
  return tabEl;
}
```

### Visual Reference

```
┌─────────────────────────────────────────────────┐
│ ● SESSION_01                           zsh      │  ← titlebar
│ ╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶╶  │  ← header accent
│ ▎/01 ■ SHELL 1 /  02 ▪ VIM   03 ▪ LOGS        │  ← tab bar (01 is active)
│                                                 │
│ $ _                                             │  ← terminal content
│                                                 │
└─────────────────────────────────────────────────┘
```

Active tab `01` has: left border accent (`▎`), bright index, bright dot (`■`), bright title, angled clip-path background, and animated scan line. Inactive tabs have dim index, dim dot (`▪`), dim title.

## Edge Cases

1. **10+ tabs** — Index numbers naturally handle double digits (`10`, `11`, etc.). The `padStart(2, '0')` only pads single digits.
2. **Very narrow window** — Tabs use `overflow: hidden` and `text-overflow: ellipsis` on titles (existing behavior preserved). Index and dot have fixed width so they're always visible.
3. **Single tab with `always_show_tabbar`** — The styling works for a single tab. The scan line animation runs on the single active tab.
4. **Theme changes** — All colors use existing `--krypton-window-accent-rgb` CSS custom properties, so theme hot-reload works automatically.

## Out of Scope

- Tab close buttons (mouse interaction — Krypton is keyboard-first)
- Tab reordering via drag-and-drop
- Tab group colors or labels
- Configurable animation speed (hardcoded 4s scan is fine for now)
