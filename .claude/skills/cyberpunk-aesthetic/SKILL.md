---
name: cyberpunk-aesthetic
description: Cyberpunk Aesthetic — Krypton UI Style Reference. Load when building new UI style modes, modifying visual chrome, adding CSS effects, or verifying new components match the existing aesthetic.
---

# Cyberpunk Aesthetic — Krypton UI Style Reference

> **Trigger:** Load when building new UI style modes, modifying visual chrome, adding CSS effects, or needing to understand how the current cyberpunk look is constructed. Also useful as a checklist when ensuring new components match the existing aesthetic.

## Core Design Principles

1. **Primary accent**: Cyan `#0cf` (rgb 0, 204, 255) with opacity layering from 0.03 (ghost) to 1.0 (full neon)
2. **Multi-layer glows**: Always stack a tight glow + a soft bloom (never a single shadow)
3. **No blur**: `backdrop-filter: blur()` is banned — causes WKWebView freeze on macOS
4. **Hard geometry**: Default border-radius is 0px. Angular clip-paths for tabs
5. **Monospace typography**: Uppercase, wide letter-spacing (0.08–0.2em), Mononoki / JetBrains Mono
6. **Transparency hierarchy**: Backgrounds range from rgba(6, 10, 18, 0.4) to 0.92 — never fully opaque
7. **Scanline textures**: Repeating-linear-gradient overlays at very low opacity (0.02–0.03)
8. **Pulsing animations**: 1–3 second breathing cycles on active elements
9. **CSS custom properties**: All colors flow through `--krypton-*` variables — zero hard-coded hex in component CSS
10. **Depth via shadow**: 3D perspective transforms, inset rim lights, multi-layer box-shadow

---

## Color System

### Accent Opacity Scale

| Usage | Opacity | Example |
|-------|---------|---------|
| Ghost / background texture | 0.02–0.06 | Grid dots, gauge track, selection bg |
| Inactive border | 0.12–0.15 | Tab separators, sidebar borders |
| Hover / secondary | 0.3–0.5 | Window border, whichkey border |
| Active / primary | 0.6–0.8 | Active tab left-border, uplink bar |
| Full neon | 0.85–1.0 | Status dot, badge active, text accent |

### Semantic Colors (from theme TOML)

| Role | Default | CSS Variable |
|------|---------|-------------|
| Primary accent | `#0cf` | `--krypton-window-accent` |
| Background | `rgba(6, 10, 18, *)` | `--krypton-backdrop-color` |
| Foreground text | `#b0c4d8` | `--krypton-fg` |
| Error/danger | `#ff3a5c` | ANSI red |
| Warning/caution | `#e8c547` | ANSI yellow |
| Success/active | `#39ff7f` | ANSI green |
| Info/secondary | `#4a9eff` | ANSI blue |
| Special/AI | `#c77dff` | ANSI magenta |

---

## Glow Recipes

### Box Shadow Glow (windows, borders, gauges)

```css
/* Standard neon border glow */
box-shadow: 0 0 6px rgba(0, 200, 255, 0.6),    /* tight: 6px, 60% */
            0 0 20px rgba(0, 200, 255, 0.15);   /* bloom: 20px, 15% */
```

### Text Shadow Glow (labels, badges)

```css
/* Standard text neon */
text-shadow: 0 0 8px rgba(0, 200, 255, 0.4),    /* tight: 8px, 40% */
             0 0 14px rgba(0, 200, 255, 0.15);   /* bloom: 14px, 15% */
```

### Drop Shadow Glow (SVG elements)

```css
/* SVG/filter glow (progress gauge) */
filter: drop-shadow(0 0 6px rgba(0, 204, 255, 0.5))
        drop-shadow(0 0 20px rgba(0, 204, 255, 0.15));
```

### Inset Rim Light

```css
/* Subtle inner highlight on panels */
box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
```

### Multi-Layer Panel Shadow (modals, toasts)

```css
box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5),       /* base shadow */
            0 8px 32px rgba(0, 0, 0, 0.3),       /* deep shadow */
            0 0 30px rgba(0, 200, 255, 0.08),     /* cyan bloom */
            inset 0 1px 0 rgba(255, 255, 255, 0.03); /* rim light */
```

---

## Scanline Patterns

### Horizontal Scanlines (CRT effect)

```css
/* Apply as ::before pseudo-element */
background: repeating-linear-gradient(
  0deg,
  transparent,
  transparent 2px,
  rgba(0, 0, 0, 0.03) 2px,
  rgba(0, 0, 0, 0.03) 4px
);
```
- Used on: toast cards, hook panels
- Files: `hooks.css:190-195`

### Vertical Stripe Pattern (tech grid)

```css
background: repeating-linear-gradient(
  90deg,
  rgba(0, 200, 255, 0.02) 0px,
  rgba(0, 200, 255, 0.02) 1px,
  transparent 1px,
  transparent 4px
);
```
- Used on: tabbar background
- Files: `window.css:188-194`

### Header Accent Bar (dashed stripe)

```css
background: repeating-linear-gradient(
  90deg,
  rgba(0, 200, 255, 0.35) 0px,
  rgba(0, 200, 255, 0.35) 1px,
  transparent 1px,
  transparent 3px
);
height: 6px; /* --krypton-header-accent-height */
```
- Used on: `.krypton-window__header-accent`
- Files: `window.css:114-120`

### Micro-Dot Grid (background texture)

```css
background: radial-gradient(
  circle,
  rgba(0, 200, 255, 0.03) 0.5px,
  transparent 0.5px
);
background-size: 6px 6px;
```
- Used on: agent view background
- Files: `agent.css:17-20`

---

## Window Chrome

### Structure (BEM classes)

```
.krypton-window                     ← outer container, position: absolute
  .krypton-window__corner (×4)      ← L-shaped glowing corner accents
  .krypton-window__titlebar         ← 28px bar with drag, label, controls
    .krypton-window__status-dot     ← 6px cyan indicator
    .krypton-window__label          ← uppercase monospace title
  .krypton-window__header-accent    ← 6px striped bar below titlebar
  .krypton-window__tabbar           ← tab strip with vertical scanlines
    .krypton-tab                    ← individual tabs
  .krypton-window__content          ← terminal/pane container
    .krypton-glow-overlay           ← top edge glow
    .krypton-glow-overlay--bottom   ← bottom edge glow
```

### Corner Accents

```css
.krypton-window__corner::before,
.krypton-window__corner::after {
  content: '';
  position: absolute;
  background: var(--krypton-window-accent, #0cf);
  box-shadow: 0 0 6px rgba(0, 204, 255, 0.6);
}
/* Dimensions: 14px × 2px L-shapes at each corner */
```
- Size: `--krypton-corner-size` (14px), thickness: `--krypton-corner-thickness` (2px)
- Files: `window.css:45-108`

### Focused vs Unfocused

| Property | Unfocused | Focused |
|----------|-----------|---------|
| Border color | `rgba(0, 200, 255, 0.15)` | `rgba(0, 200, 255, 0.5)` |
| Corner glow | dimmed | full brightness |
| Label text-shadow | none | `0 0 8px rgba(0, 200, 255, 0.4)` |
| Status dot | dim | bright |

### Window Background

```css
background: var(--krypton-backdrop-color, rgba(6, 10, 18, 0.5));
border: var(--krypton-border-width, 1px) solid rgba(0, 200, 255, 0.5);
border-radius: var(--krypton-border-radius, 0px);
```

---

## Tab Styling

### Active Tab

```css
.krypton-tab--active {
  background: rgba(0, 200, 255, 0.07);
  clip-path: polygon(4px 0%, calc(100% - 4px) 0%, 100% 100%, 0% 100%);
  border-left: 2px solid rgba(0, 200, 255, 0.7);
  animation: krypton-tab-pulse 3s ease-in-out infinite;
}
```
- Angled top corners via clip-path
- Left accent border
- 3s breathing pulse animation
- Bottom 2px glow bar with separate pulse animation
- Horizontal scan-wipe pseudo-element (4s sweep)
- Files: `window.css:228-296`

### Tab Separator

```css
.krypton-tab + .krypton-tab::before {
  width: 1px;
  background: rgba(0, 200, 255, 0.12);
  transform: rotate(12deg); /* angled diagonal */
}
```

---

## Animation Patterns

### Breathing Pulse (active elements)

```css
@keyframes krypton-tab-pulse {
  0%, 100% { background: rgba(..., 0.05); box-shadow: inset 0 0 8px rgba(..., 0.05); }
  50%      { background: rgba(..., 0.2);  box-shadow: inset 0 0 20px rgba(..., 0.15); }
}
/* Duration: 3s, easing: ease-in-out, infinite */
```

### Gradient Sweep (data stream)

```css
@keyframes krypton-uplink-stream {
  0%   { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
/* Duration: 1.8s, linear, infinite */
```

### Horizontal Scan Wipe

```css
@keyframes krypton-tab-scan {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}
/* Duration: 4s, linear, infinite */
```

### Scale Pulse (radar ping)

```css
@keyframes krypton-icon-scale-pulse {
  0%, 100% { transform: scale(1); opacity: 0.2; }
  50%      { transform: scale(1.15); opacity: 0.45; }
}
/* Duration: 2.5s, ease-in-out, infinite */
```

### Entry Animations

- **Slide-in from right**: `transform: translateX(60px)` → `translateX(0)` with `cubic-bezier(0.22, 0.61, 0.36, 1)`
- **Scale-up**: `transform: scale(0.96)` → `scale(1)` with 0.15s ease
- **Toast scanline**: 1px line sweeps top→bottom in 0.5s on card entry
- **3D float** (Quick Terminal): `perspective(800px) rotateX(1.5deg) translateZ(20px)`

### WAAPI Animations (TypeScript)

- Engine in `animation.ts` — morph, slide, crossfade styles
- Easing: `cubic-bezier(0, 0, 0.2, 1)` (EaseOut), `cubic-bezier(0.34, 1.56, 0.64, 1)` (Spring)
- Window entrance: ScaleUp, FadeIn, SlideDown
- Window exit: FadeOut, ScaleDown
- Input buffered during animations (keys queued, replayed after)

---

## Edge Glow Overlays

```css
.krypton-glow-overlay {
  height: calc(var(--krypton-terminal-cell-height, 17px) * 5 + 4px);
  background: linear-gradient(to bottom, rgba(0, 200, 255, 0.35), transparent);
  opacity: var(--krypton-glow-intensity, 0.8);
  mask-image: linear-gradient(to bottom, black 0%, transparent 100%);
  pointer-events: none;
}
```
- Top and bottom edges of terminal content
- Height spans ~5 terminal rows
- Intensity controlled by `--krypton-glow-intensity`
- Files: `window.css:437-465`

---

## Toast / HUD Cards

### Structure

```css
.krypton-claude-toast {
  background: linear-gradient(160deg, rgb(8, 14, 24), rgb(12, 18, 30));
  border: 1px solid rgba(var(--card-accent), 0.08);
  border-left: 3px solid rgba(var(--card-accent), 0.6);
  border-radius: 2px;
}
```

### Card Type Accents (RGB values for --card-accent)

| Type | RGB | Visual |
|------|-----|--------|
| Session | 80, 220, 100 | Green |
| Tool | 0, 200, 255 | Cyan |
| Notification | 250, 200, 99 | Amber |
| Permission | 255, 180, 40 | Orange (pulsing) |
| Error | 255, 64, 64 | Red |
| Success | 80, 220, 100 | Green |
| Stop | 200, 100, 255 | Magenta |

### Card Features

- Horizontal scanline overlay (::before pseudo-element)
- 32px circular icon with accent border
- Activity trace (3px right-edge seismograph with colored ticks)
- Slide-in from right with cubic-bezier easing

---

## Progress Gauge (Circular HUD)

- Centered SVG circle, max 220px
- Track: 3px stroke at 6% opacity
- Fill: 4px rounded stroke at 20% opacity, 300ms transitions
- Percentage text: 28px monospace at 12% opacity (very dim)
- Indeterminate: 1.8s rotating orbit animation
- Completion: 0.8s bloom flare animation
- Error state: recolors to red/magenta
- Paused state: recolors to amber/orange
- Files: `progress.css`

---

## Selection & Cursor

- **Selection cursor**: Cyan square, 6px glow spread, 1.2s breathing pulse
- **Selection glow**: 6% cyan background, horizontal 3s scan-wipe overlay
- Files: `terminal.css:12-64`

---

## Theme Integration

### TOML → CSS Variable Pipeline

1. Rust loads `~/.config/krypton/themes/*.toml` (or built-in themes)
2. Frontend `theme.ts` receives theme data via IPC
3. `applyTheme()` sets 100+ `--krypton-*` CSS variables on `document.documentElement`
4. CSS references variables with fallback defaults: `var(--krypton-window-accent, #0cf)`
5. Filesystem watcher triggers hot-reload (300ms debounce)

### Key Theme Properties (TOML paths)

```toml
[colors]
foreground = "#b0c4d8"
background = "#060a12"
cursor = "#0cf"

[chrome.border]
color = "rgba(0, 200, 255, 0.5)"
width = "1px"
radius = "0px"

[chrome.corners]
size = "14px"
thickness = "2px"

[chrome.titlebar]
height = "28px"
background = "transparent"

[chrome.glow]
intensity = 0.8
```

### CSS Variable Namespace

| Prefix | Controls |
|--------|----------|
| `--krypton-fg`, `--krypton-bg` | Terminal foreground/background |
| `--krypton-ansi-0` through `--krypton-ansi-15` | ANSI color palette |
| `--krypton-border-*` | Window border properties |
| `--krypton-shadow-*` | Window shadow properties |
| `--krypton-backdrop-*` | Window background |
| `--krypton-titlebar-*` | Titlebar chrome |
| `--krypton-corner-*` | Corner accent geometry |
| `--krypton-tab-*` | Tab styling |
| `--krypton-focused-*` | Focused state overrides |
| `--krypton-glow-*` | Edge glow overlays |
| `--krypton-whichkey-*` | Whichkey popup |
| `--krypton-palette-*` | Command palette |
| `--krypton-qt-*` | Quick Terminal |

---

## File Map

| File | Cyberpunk Patterns |
|------|-------------------|
| `src/styles/window.css` | Window chrome, corners, tabs, glows, header accent, edge overlays |
| `src/styles/terminal.css` | Selection cursor, selection glow, scan-wipe |
| `src/styles/overlays.css` | Whichkey, command palette, hints, quick terminal 3D float |
| `src/styles/progress.css` | Circular gauge, orbit animation, flare bloom |
| `src/styles/hooks.css` | Claude badge, uplink bar, toast cards, activity trace, icon animations |
| `src/styles/dashboard.css` | Dashboard panel, tab buttons |
| `src/styles/agent.css` | Micro-dot grid, logo glow |
| `src/styles/inline-ai.css` | AI overlay panel |
| `src/styles/extensions.css` | Extension bars, stat labels, heap gauge |
| `src/styles/base.css` | Global resets, CSS variable defaults |
| `src/theme.ts` | CSS variable application, theme change callbacks |
| `src/animation.ts` | WAAPI transitions, easing curves, entrance/exit animations |
| `src-tauri/themes/krypton-dark.toml` | Default cyberpunk theme values |

---

## Checklist: Does My New Component Match?

When adding a new UI element, verify:

- [ ] Uses `--krypton-*` CSS variables (no hard-coded colors)
- [ ] Background is semi-transparent `rgba(6, 10, 18, 0.4–0.92)` — not opaque
- [ ] Borders are 1px solid with accent at 0.15–0.5 opacity
- [ ] Text is monospace, uppercase where appropriate, with letter-spacing
- [ ] Active/focused states have glow (box-shadow or text-shadow, double-layered)
- [ ] No `backdrop-filter: blur()` anywhere
- [ ] Animations use ease-in-out, 1–3s duration, infinite for ambient effects
- [ ] BEM class naming: `.krypton-{component}__{element}--{modifier}`
- [ ] Corner radius is 0–2px (sharp, not rounded)
- [ ] Hover states add subtle brightness (0.03 alpha increase)
