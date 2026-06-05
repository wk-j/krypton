---
name: Krypton Amber Phosphor
description: Warm amber phosphor terminal — 1980s cassette-futurism CRT aesthetic with CRT scanlines, layered amber glows, and telemetry-style typography
appliesTo: ".agent-view (src/styles/agent.css)"
colors:
  primary: "#ffb000"
  primaryBright: "#ffd880"
  primaryDim: "#ffb000"
  ghost: "#ffb000"
  background: "#060a12"
  foreground: "#e8cfa4"
  foregroundDim: "#a68d68"
  green: "#8bc34a"
  danger: "#ff6e40"
  magenta: "#e091c0"
  gold: "#ffd54f"
  cyan: "#4dd0e1"
  info: "#64b5f6"
backgroundAlpha: 0.55
surfaceAlpha:
  low: 0.35
  mid: 0.55
  high: 0.85
  solid: 0.96
borderAlpha:
  idle: 0.25
  focused: 0.5
glowAlpha:
  tight: 0.5
  bloom: 0.15
scanlineAlpha: 0.06
typography:
  family: "Mononoki Nerd Font Mono, JetBrains Mono, monospace"
  label:
    size: "11px"
    weight: 700
    letterSpacing: "0.22em"
    transform: "uppercase"
  logoTitle:
    size: "16px"
    weight: 700
    letterSpacing: "0.48em"
    transform: "uppercase"
  logoSubtitle:
    size: "11px"
    weight: 400
    letterSpacing: "0.35em"
    transform: "uppercase"
  body:
    size: "14px"
    weight: 400
    letterSpacing: "0em"
  heading:
    size: "17px"
    weight: 700
    letterSpacing: "0.15em"
    transform: "uppercase"
rounded:
  none: "0px"
  subtle: "2px"
spacing:
  hairline: "1px"
  xs: "3px"
  sm: "4px"
  md: "8px"
  lg: "12px"
chrome:
  borderWidth: "1px"
roleColors:
  user: "#4dd0e1"
  assistant: "#ffb000"
  tool: "#64b5f6"
  shell: "#8bc34a"
  error: "#ff6e40"
  system: "#e091c0"
forbidden:
  - "cool colors in primary palette"
  - "rounded corners on window frame"
  - "sans-serif typography"
  - "diffuse shadows without explicit rgba + measured blur"
---

## Overview

A warm, instrumented look modeled on 1980s amber-phosphor computer terminals — IBM 3270s, vintage VT100s, the orange-on-black workstations of late Cold War flight control. Every readout glows in measured amber; the 1px amber border bolts the chrome to the frame; CRT scanlines bleed gently through; and motion is reserved for *boot*, *alert*, and *liveness* — never decoration.

This identity is applied to the **Agent view** (`.agent-view`, `src/styles/agent.css`) and its companion **Context view** (`.context-view`) — the conversation surfaces for AI assistants. The deliberate warmth contrasts with Krypton Dark's cool cyan so the user knows they are talking to a system, not driving a terminal. The `--agent-*` palette tokens are scoped to the agent/context windows (`data-content-type="agent" | "context"`); only the two cross-consumed tokens `--agent-font` and `--agent-text` remain at `:root`, where the ACP view and ACP harness inherit them.

## Colors

The primary accent is **`#ffb000`** — pure amber phosphor. This is the single hue that defines the aesthetic; using anything else for focus, borders, or primary glow breaks the identity instantly.

- **`#ffb000` primary** — all label glows, borders, focus states.
- **`#ffd880` bright** — slightly hotter highlight; used on hover and active states.
- **`#e8cfa4` foreground** — warm cream body text. Distinctly *not* cool gray.
- **`#a68d68` foreground dim** — muted tan for secondary labels.
- **`#060a12` background** — same dark base as Krypton Dark, but with `0.55` alpha so the amber feels lit-from-within.

### Role Colors

Different content types are color-coded by role — this is functional, not decorative:

- **User message** — cyan `#4dd0e1` (the human, cool)
- **Assistant message** — amber `#ffb000` (the system, warm)
- **Tool call** — blue `#64b5f6`
- **Shell output** — green `#8bc34a`
- **Error** — red `#ff6e40`
- **System notice** — magenta `#e091c0`

## Typography

Monospace, uppercase, tight letter-spacing. The aesthetic is *telemetry readout* — every label looks engraved into a metal panel:

- **Labels**: `11px / 700 / 0.22em` uppercase.
- **Logo title**: `0.48em` letter-spacing — extreme spread, like a unit serial number.
- **Logo subtitle**: `0.35em` — calibration tag voice.
- **Body**: mixed-case `0em` letter-spacing — reserved for actual message content the user reads.
- **Headings**: `0.15em` uppercase with decorative rules above/below.

## Geometry

The hardest geometry of any Krypton aesthetic:

- Window radius: **`0px`** — no concession to softness.
- Minor elements: `2px` maximum.

## Glows

Layered bloom is mandatory — single-layer shadows look flat in amber:

- Window idle: `0 4px 24px @ 0.7 black` + `0 0 1px @ 0.2 amber` + `inset 0 0 60px @ 0.02 amber`
- Window focused: `0 4px 28px @ 0.8 black` + `0 0 12px @ 0.06 amber` + `inset 0 0 80px @ 0.03 amber`
- Label focused: `0 0 10px @ 0.5 amber`
- Heading: `0 0 8px @ 0.4 amber` + `0 0 25px @ 0.12 amber` *(tight + bloom)*
- Assistant message label: `0 0 8px @ 0.5 amber` + `0 0 20px @ 0.15 amber`

The **inset amber glow** on the window edge is the signature move — it makes the chrome feel *lit from inside*, like the phosphor coating is energized.

## Textures

- **CRT scanlines** — `repeating-linear-gradient(0deg, rgba(0,0,0,0.06) 0 1px, transparent 1px 3px)`. Identical to NASA aesthetic; the scanline pattern is the shared retro-futurism gesture.
- **Vignette** — `radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.15) 100%)`. Tighter than NASA's 60% — the amber needs less edge darkness to read as "screen".
- **Decorative rules** — gradient-stroked lines flanking headings, input rows, and code blocks. Always center-peaked amber.

## Motion

Six named animations — all functional, none decorative:

- `logo-text-reveal` — 0.5s ease-out boot animation, staggered subtitle.
- `msg-boot` — 0.4s ease-out fade+slide for new assistant messages.
- `error-flash` — 2s, repeats 3×, on error state appearance.
- `status-alert` — 2s infinite opacity pulse on alert badge.
- `timer-pulse` — 1.5s infinite opacity pulse on running timer.
- `live-dot-pulse` — 1s infinite, fastest cycle, on live indicator only.

Each animation marks a *state*. The fastest pulse (1s) is reserved for the live indicator — the most attention-demanding signal. Slower pulses (2s) are alerts and timers. Boot animations are one-shot. No infinite animations are added decoratively.

## Signature Elements

- **Amber phosphor text-shadow on every label** — single tight + wide bloom layer.
- **Inset amber glow** on window edges (`inset 0 0 60–80px @ 0.02–0.03`) — imperceptible until the window is focused, then warmth radiates inward.
- **Telemetry chevrons** (`»`, `❯`, `◆`, `⟨ ⟩`) as prefix/suffix pseudo-content on labels and rows.
- **Symmetric gradient rules** above code blocks and below headings — center-peaked amber, fading both directions.

## When to Use This Aesthetic

Apply where the user is *conversing with a system* — agent chat, AI responses, machine-generated long-form output. Do not extend to interactive terminals (those are Krypton Dark) or content reading (that is NASA). The warmth signals that the *machine is speaking back*.
