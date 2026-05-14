---
name: Krypton Dark
description: Cyberpunk sci-fi terminal aesthetic — cyan neon on transparent blue-black, hard geometry, monospace typography, multi-layer glows
colors:
  primary: "#0cf"
  foreground: "#b0c4d8"
  background: "#060a12"
  cursor: "#0cf"
  danger: "#ff3a5c"
  warning: "#e8c547"
  success: "#39ff7f"
  info: "#4a9eff"
  special: "#c77dff"
  selection: "#1a3a5c"
backgroundAlpha: 0.5         # backdrop opacity over desktop
selectionAlpha: 0.6
ansi:
  black: "#0a0a0f"
  red: "#ff3a5c"
  green: "#0cf"
  yellow: "#e8c547"
  blue: "#4a9eff"
  magenta: "#c77dff"
  cyan: "#0cf"
  white: "#b0c4d8"
  brightBlack: "#2a4a6c"
  brightRed: "#ff5c7a"
  brightGreen: "#33ddff"
  brightYellow: "#ffd866"
  brightBlue: "#6ab4ff"
  brightMagenta: "#d9a0ff"
  brightCyan: "#33ddff"
  brightWhite: "#ffffff"
accentOpacity:
  ghost: 0.04        # background texture, gauge tracks
  inactive: 0.15     # tab separators, idle borders
  hover: 0.4         # secondary borders, whichkey
  active: 0.7        # active tab edge, primary borders
  neon: 1.0          # status dots, full text accent
typography:
  family: "Mononoki, JetBrains Mono, ui-monospace, monospace"
  label:
    size: "11px"
    weight: 600
    letterSpacing: "0.08em"
    transform: "uppercase"
  body:
    size: "13px"
    weight: 400
    letterSpacing: "0em"
  display:
    size: "28px"
    weight: 400
    letterSpacing: "0.2em"
    transform: "uppercase"
rounded:
  none: "0px"        # default — hard geometry
  subtle: "2px"      # toast cards, badges only
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "28px"
chrome:
  borderWidth: "1px"
  cornerAccentSize: "14px"
  cornerAccentThickness: "2px"
  titlebarHeight: "28px"
  headerAccentHeight: "6px"
  statusDotSize: "6px"
effects:
  glowTight:
    blur: "6px"
    opacity: 0.6
  glowBloom:
    blur: "20px"
    opacity: 0.15
  textGlowTight:
    blur: "8px"
    opacity: 0.4
  textGlowBloom:
    blur: "14px"
    opacity: 0.15
  rimLight: "inset 0 1px 0 rgba(255, 255, 255, 0.03)"
  scanlineOpacity: 0.03
  gridDotOpacity: 0.03
  edgeGlowIntensity: 0.8
motion:
  breathingPulse: "3s ease-in-out infinite"
  ambientPulse: "1.2s ease-in-out infinite"
  dataStream: "1.8s linear infinite"
  scanWipe: "4s linear infinite"
  radarPing: "2.5s ease-in-out infinite"
  easeOut: "cubic-bezier(0, 0, 0.2, 1)"
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)"
  entrance: "cubic-bezier(0.22, 0.61, 0.36, 1)"
forbidden:
  - "backdrop-filter: blur()"    # causes WKWebView freeze on macOS
  - "fully opaque backgrounds"   # break the transparency hierarchy
  - "rounded corners > 2px"      # violates hard geometry
  - "single-layer shadow"        # glows must be tight + bloom
  - "hard-coded hex in components" # all colors flow through CSS variables
---

## Overview

Krypton is a keyboard-driven terminal emulator dressed as a piece of fictional cyberpunk hardware — a thin neon HUD layered over deep blue-black void. The interface should feel like operating a salvaged military terminal: precise, instrumented, slightly luminous, and absolutely silent until you address it. Every visible element earns its presence; ornament is replaced with *signal*.

The aesthetic is built on three tensions:

1. **Hard geometry vs. soft light** — sharp 0px corners, 1px borders, and L-shaped corner accents are softened only by multi-layer glows that bleed into the surrounding void.
2. **Transparency vs. legibility** — backgrounds are never fully opaque (they sit between 40% and 92%), so the underlying desktop bleeds through, but text remains crisp via heavy contrast and selective glow.
3. **Stillness vs. life** — most of the UI is motionless. The few elements that animate (active tabs, status dots, progress gauges) breathe on slow 1–3s cycles. Motion is reserved for *state*, never decoration.

## Colors

The palette is monochromatic by intent. A single accent — **cyan `#0cf`** — drives every focus state, glow, border, and indicator. Other colors appear only as ANSI terminal output or semantic state (error, warning, special).

- **Primary cyan `#0cf`** — focus, glow, active state. Used at every opacity from 0.02 (ghost grid) to 1.0 (status dot at full neon). Never replace with another hue without breaking brand.
- **Foreground `#b0c4d8`** — cool slate text. Reads as "phosphor white" against the void without being aggressive.
- **Background `rgba(6, 10, 18, 0.5)`** — translucent ink. The 50% alpha is load-bearing; full opacity flattens the depth hierarchy.
- **Semantic state colors** (red `#ff3a5c`, amber `#e8c547`, green `#39ff7f`, magenta `#c77dff`) appear only on toast cards, error gauges, and AI/special indicators. They must not be used decoratively.

### The Opacity Scale

A single accent color stretches across the entire UI via opacity layering. Use the named tier (ghost / inactive / hover / active / neon) rather than reaching for a new color. Higher opacity = more salience; the scale is the brightness ladder of the whole interface.

## Typography

Monospace everywhere. The terminal nature of the product is the brand — proportional fonts would betray it. Default to **Mononoki** or **JetBrains Mono**.

- **Labels** (titlebar, tab text, badges) are uppercase with `0.08em` letter-spacing. This is the "panel labeling" voice — feels engraved into the chrome.
- **Body** is mixed case, normal spacing — reserved for content that the user actually reads (terminal output, prompts, dialog text).
- **Display** (large numerics, mode indicators) is uppercase with `0.2em` letter-spacing — wide, instrumented, console-readout feel.

## Geometry

**0px corner radius is the default.** Hard angles are non-negotiable for windows, panels, palettes, dialogs. A 2px radius is permitted only on toast cards and small badges where the curve reads as a manufactured bevel rather than a soft pillow.

**Angled clip-paths** appear on active tabs (chamfered top corners), giving an industrial "machined" silhouette. Diagonals also appear in tab separators (12° rotation) — a subtle "this is not a spreadsheet" cue.

Every window has **four L-shaped corner accents** (14px × 2px brackets) drawn just inside the border. They glow at the focused-window opacity tier and serve as the primary focus indicator — more readable than a border color change alone.

## Glows

Glow is the signature visual mechanic. **Never use a single shadow.** Stack a tight inner glow with a wide outer bloom — this is what gives the accent its phosphor/neon character rather than a generic CSS drop-shadow.

- **Border glows** combine `0 0 6px @ 0.6` (tight) with `0 0 20px @ 0.15` (bloom).
- **Text glows** combine `0 0 8px @ 0.4` with `0 0 14px @ 0.15`.
- **Inset rim lights** (`inset 0 1px 0 rgba(255,255,255,0.03)`) add a "top edge catches the light" highlight on panels — a subtle hint of 3D extrusion.

Edge glow overlays (~5 terminal rows tall, fading to transparent) sit at the top and bottom of every terminal pane. They imply that the content is *emitting* light rather than being drawn on a screen.

## Textures

Three repeating patterns add machine-grade detail without becoming busy:

- **Horizontal scanlines** (`rgba(0,0,0,0.03)` every 2px) on cards and panels — CRT artifact.
- **Vertical stripes** (`rgba(0,200,255,0.02)` every 4px) on tab bars — tech-grid feel.
- **Micro-dot grid** (radial gradient, 6px spacing, 3% opacity) on large background surfaces — instrumented field.

All three sit at 2–3% opacity. If the user *notices* them, they're too strong.

## Motion

Almost everything is still. The interface is a *terminal*, not a website — it should not draw attention to itself. Motion is allocated by importance:

- **Breathing pulses** (3s ease-in-out) on active tabs and primary indicators — slow enough to feel like a heartbeat, fast enough to confirm the element is live.
- **Data stream sweeps** (1.8s linear) on uplink bars and progress gradients — implies throughput.
- **Scan wipes** (4s linear) horizontal highlight pass across active tabs — implies sensor scanning.
- **Radar pings** (2.5s) on icon scale-pulses — implies acquisition.
- **Entrance animations** use `cubic-bezier(0.22, 0.61, 0.36, 1)` — a deliberate "hardware deploying" curve, not a bouncy spring. Toasts slide in from the right; windows scale up from 0.96.

All ambient animation must be `infinite` and `ease-in-out`. Linear is reserved for sweep effects where the constant velocity is the point.

## Transparency Hierarchy

The interface is a stack of translucent surfaces over the user's desktop wallpaper. Maintain the order:

1. **Workspace surface** — fully transparent (the user's desktop shows through).
2. **Window backdrop** — `rgba(6, 10, 18, 0.5)` — 50% deep ink.
3. **Overlays** (palette, whichkey, toasts) — `rgba(6, 10, 18, 0.85)` — denser ink that still shows depth.
4. **Modal foreground** (input fields, active cells) — up to `0.92` — never fully `1.0`.

Breaking this order — for example, an opaque modal over a translucent palette — collapses the depth model and the interface looks "broken."

## Platform Constraints

- **`backdrop-filter: blur()` is banned.** On macOS WKWebView with transparent windows, it freezes rendering. Translucency must be achieved through plain alpha-blended backgrounds, not native blur. This shaped the entire aesthetic — what looks like a blurred panel is actually a stack of low-alpha layers and scanline textures.
- **No CSS frameworks, no UI libraries.** All styling is vanilla CSS with BEM naming (`.krypton-window__titlebar--focused`). New components should match this convention.
- **All colors flow through `--krypton-*` CSS custom properties.** Hard-coded hex in component CSS is a smell — themes won't reach it. The token table at the top of this file is the source of truth.

## When to Break the Rules

The rules above describe the *core* Krypton Dark identity. They are intentionally tight because the product's brand depends on consistency across a long-running, always-on, full-screen surface that the user lives inside.

If you are building something fundamentally different in character (a Retro-Futurism mode, a Diegetic HUD overlay, a Cassette-Futurism nostalgia skin), do not bend Krypton Dark — define a new theme TOML with its own tokens. The chrome architecture supports it. What must *not* happen is partial drift: a rounded corner here, an opaque modal there, a single-layer shadow somewhere else. That reads as bugs, not style.
