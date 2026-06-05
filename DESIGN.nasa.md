---
name: Krypton NASA
description: NASA Mission Control retro-futurism — cool cyan phosphor on dark navy, CRT scanlines, atmospheric vignette
appliesTo: ".krypton-vault (src/styles/vault-view.css)"
colors:
  primary: "#4fc3f7"
  primaryBright: "#81d4fa"
  primaryDim: "#4fc3f7"
  ghost: "#4fc3f7"
  background: "#060a14"
  panelBase: "#0a1020"
  foreground: "#c8dce8"
  foregroundDim: "#6a8ea8"
  orange: "#ff6b35"
  gold: "#ffd54f"
  green: "#66bb6a"
  cyanComplement: "#4dd0e1"
  danger: "#ef5350"
  magenta: "#ce93d8"
backgroundAlpha: 1.0
panelAlpha: 0.85
borderAlpha:
  idle: 0.2
  focused: 0.45
glowAlpha:
  tight: 0.3
  bloom: 0.1
scanlineAlpha: 0.06
typography:
  family: "Mononoki Nerd Font Mono, JetBrains Mono, monospace"
  display:
    size: "11px"
    weight: 700
    letterSpacing: "0.2em"
    transform: "uppercase"
  data:
    size: "11px"
    weight: 400
    letterSpacing: "0.05em"
    transform: "uppercase"
  body:
    size: "14px"
    weight: 400
    letterSpacing: "0em"
  h1:
    size: "24px"
    weight: 700
    letterSpacing: "0.1em"
rounded:
  none: "0px"
  hairline: "1px"
  subtle: "2px"
  panel: "3px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "14px"
chrome:
  borderWidth: "1px"
forbidden:
  - "warm amber tones in primary palette"
  - "border-radius > 3px"
  - "animation keyframes — state-based glows only"
  - "smooth diffuse shadows — all shadows are explicit, measured rgba"
---

## Overview

A cool, instrumented look modeled on 1960s–1970s Mission Control consoles and high-end scientific instrument panels. The interface reads like a phosphor data screen seen through a dark room — cyan light bleeding into navy void, soft vignette at the edges, tight monospace typography, and *no motion*.

This identity is applied to the **Vault Viewer** (`.krypton-vault`, `src/styles/vault-view.css`). It is a deliberate alternative to the default Krypton Dark cyberpunk identity — used where the content (long-form notes, archived material) wants a calmer, more "library" feel than the active terminal chrome.

## Colors

The primary accent is **`#4fc3f7`** — a measured, calibrated cyan distinct from the saturated `#0cf` of Krypton Dark. It reads as *equipment phosphor*, not as neon.

- **`#4fc3f7` primary** — main glow, focus state, label color.
- **`#81d4fa` bright** — hover/active accents, slightly hotter highlight.
- **`#c8dce8` foreground** — cool light-gray body text, "data printout" tone.
- **`#6a8ea8` foreground dim** — muted blue-gray for secondary labels.
- **`#060a14` background** — dark navy, deeper and cooler than Krypton Dark's `#060a12`.

Semantic colors (`orange #ff6b35`, `gold #ffd54f`, `green #66bb6a`, `red #ef5350`, `magenta #ce93d8`) appear sparingly as data classification — typically on metadata, code, and link hints. They are not decorative.

## Typography

Monospace only. The "data readout" voice is consistent across labels, breadcrumbs, and tabs — uppercase with `0.05em–0.2em` letter-spacing, font-weight 700 on display labels. Body article text is mixed-case at a calmer letter-spacing of `0em`.

H1 size is `1.714×` body, H2 `1.357×`, H3 `1.143×` — a *gentle* type scale, not magazine-grade. The aesthetic is about *instrumentation*, not editorial.

## Geometry

Slightly softer than Krypton Dark:

- Window frame: `3px` corner radius — a hint of bevel.
- Inputs/panels: `2px`.
- Minor elements: `1px`.

## Glows

Glows are dimmer and tighter than Krypton Dark — *phosphor*, not neon:

- Window idle: `0 4px 20px @ 0.6 black` + `0 0 1px @ 0.15 cyan`
- Window focused: `0 4px 24px @ 0.7 black` + `0 0 8px @ 0.08 cyan`
- Label focused: `0 0 10px @ 0.25 cyan`
- Sidebar title: `0 0 8px @ 0.3 cyan`

Single, measured layers — no multi-layer bloom stacking. The look is *the phosphor element itself glowing*, not a halo of light around it.

## Textures

- **CRT scanlines** — `repeating-linear-gradient(0deg, rgba(0,0,0,0.06) 0 1px, transparent 1px 3px)`. Tight 1px/3px cycle, twice the contrast of Krypton Dark's 2%.
- **Vignette** — `radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.3) 100%)` overlay. Darkens the edges, mimics the curvature of a CRT tube.
- **Header accent rule** — symmetric center-fade gradient (`transparent → cyan @ 0.3 → transparent`). A *calibration mark*.

## Motion

**There is no motion.** Transitions are limited to `0.1s–0.15s` on `color` and `border-color` for tab/item hovers. No keyframe animations exist in this aesthetic.

This is intentional — the NASA Mission Control mood depends on *stillness*. Movement would break the "looking at a measurement screen" frame.

## When to Use This Aesthetic

Apply to content-reading surfaces — long articles, archived notes, reference material — where the user is *consuming* rather than *operating*. Do not extend it to the active terminal, command palette, or anywhere keystrokes drive immediate state change; those belong to Krypton Dark.
