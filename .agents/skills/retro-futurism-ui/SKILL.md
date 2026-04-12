---
name: retro-futurism-ui
description: >
  Design and build Retro-Futurism UI — interfaces that blend the optimistic machine-age
  aesthetic of 1930s–1970s visions of the future with modern web technology. Think NASA
  Mission Control panels, Fallout terminal screens, Atompunk dials, Art Deco data dashboards,
  vacuum tube computers, and analog-digital hybrids. Use this skill whenever the user requests
  "retro-futuristic", "atompunk", "dieselpunk", "space age", "1950s sci-fi", "vintage sci-fi",
  "retro NASA", "Fallout terminal", "CRT screen", "analog computer", "art deco tech", "Soviet
  space program aesthetic", "Jetsons style", "pulp sci-fi", "raygun gothic", or any UI that
  mixes vintage aesthetics with futuristic function. Also trigger for "old school sci-fi",
  "vintage futurism", "steampunk-adjacent but electric", "retro computer aesthetic", "cassette
  futurism", or requests to make something look "like a vintage sci-fi movie control room."
  Use even if the user only says "make it look retro but futuristic" or "like an old NASA panel."
---

# Retro-Futurism UI Skill

Build production-grade **Retro-Futurism UI** — interfaces that capture the beautiful tension
between analog craftsmanship and digital ambition. The aesthetic: vacuum tubes meet vector
graphics, bakelite knobs meet LED readouts, art deco geometry meets space-age ambition.

---

## What is Retro-Futurism?

Retro-Futurism is the past's vision of the future — not the future as it is, but as it was
*imagined* by someone in 1952, or 1965, or 1977.

| Subgenre | Era | Feel | Key References |
|----------|-----|------|---------------|
| **Raygun Gothic** | 1930s–50s | Streamlined chrome, atomic optimism | Flash Gordon, Buck Rogers, The Rocketeer |
| **Atompunk** | 1950s–60s | Atomic age, suburban utopia, fallout shelters | Fallout series, Disney's Tomorrowland, early NASA |
| **Space Age / NASA Core** | 1960s–70s | Mission control precision, slide-rule elegance | Apollo program, 2001: A Space Odyssey |
| **Cassette Futurism** | 1970s–80s | Clunky terminals, VHS noise, tape-era computing | Alien's MUTHUR, WarGames, old BBC Micro |
| **Soviet Cosmism** | 1960s–80s | Bold constructivist geometry, stark functionalism | Soyuz dashboards, Soviet propaganda posters |

---

## Core Design Principles

### 1. The Analog-Digital Paradox
Retro-futurism UIs look *mechanical* but are actually digital:
- Dials and gauges display data, but they're drawn with SVG
- Buttons look physical/backlit, but respond to clicks
- Fonts are clean and geometric, not hand-drawn
- The "screen" has visible pixels (low res) or CRT curvature

### 2. Era-Accurate Color Palettes

| Subgenre | Background | Primary | Accent | Alert |
|----------|-----------|---------|--------|-------|
| **Raygun Gothic** | `#1a0e05` dark mahogany | `#f5c842` warm amber | `#e85d04` red-orange | `#ff0000` red |
| **Atompunk / Fallout** | `#0d1a0d` dark green | `#33ff33` phosphor green | `#ffff00` yellow | `#ff4444` red |
| **NASA Mission Control** | `#0a0e1a` midnight | `#4fc3f7` sky blue | `#ffffff` white | `#ff6b35` orange |
| **Cassette / VHS** | `#050508` near-black | `#00ff41` matrix green | `#ff00ff` magenta | `#ffff00` yellow |
| **Soviet Constructivist** | `#1a0a00` dark rust | `#e63946` soviet red | `#f4d03f` gold | `#ffffff` white |
| **Art Deco Tech** | `#0f0c06` near black | `#d4af37` gold | `#c0a882` pale gold | `#8b0000` dark red |

### 3. Typography Hierarchy
Fonts must evoke machine-age craftsmanship. Load from Google Fonts:

```html
<!-- Retro-Futurism Font Stack -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&family=Rajdhani:wght@400;600;700&family=VT323&family=Press+Start+2P&family=Special+Elite&display=swap" rel="stylesheet">
```

| Use Case | Font | Weight | Feel |
|----------|------|--------|------|
| **Terminal/Readouts** | `VT323`, `Share Tech Mono` | 400 | CRT phosphor text |
| **Panel Headers** | `Orbitron` | 700–900 | Space-age authority |
| **Data Labels** | `Rajdhani` | 600 | Military technical |
| **Typewriter/Atompunk** | `Special Elite` | 400 | Mechanical age |
| **Pixel/8-bit** | `Press Start 2P` | 400 | Early digital |

Rules:
- **NEVER** use Inter, Roboto, or Arial — they break the illusion entirely
- All-caps with `letter-spacing: 0.15em–0.3em` on headers
- Body text size minimum 14px for VT323 (it's a pixel font, goes large)
- Numbers should use a monospace font so digits don't shift width

### 4. Shape Grammar

| Shape | Meaning | Use |
|-------|---------|-----|
| **Concentric circles** | Power, radiation, radar | Status rings, energy meters |
| **Chevrons `>>>` / `<<<`** | Direction, loading, signal | Progress indicators, flow |
| **Segmented arcs** | Analog gauges | Measurement displays |
| **Diamond / Lozenge** | Alert, classification | Warning badges |
| **Ruled lines** | Structure, precision | Panel dividers, borders |
| **Hexagon** | Technical classification | Data containers, maps |
| **Corner brackets `⌐ ¬`** | Targeting, framing | Highlight boxes |

### 5. Texture and Noise
Retro-futurism relies on simulated physical media:
- **CRT scanlines**: `repeating-linear-gradient` at low opacity
- **Phosphor glow**: `text-shadow` + `box-shadow` in the primary color
- **Static/noise**: CSS `filter: contrast()` + SVG `feTurbulence`
- **Vignette**: Radial gradient darkening from edges
- **Flicker**: `@keyframes` with irregular opacity jumps

---

## Implementation Patterns

### Pattern A: Terminal / Phosphor Screen (Fallout / Cassette Futurism)

The interface IS an old computer terminal. Green phosphor on dark glass, scanlines, cursor blink.

```css
:root {
  --term-bg: #0a1a0a;
  --term-screen: #0d1f0d;
  --term-phosphor: #33ff33;
  --term-bright: #66ff66;
  --term-dim: rgba(51, 255, 51, 0.4);
  --term-amber: #ffb000;  /* alternate phosphor color */
  --term-font: 'VT323', 'Share Tech Mono', monospace;
  --term-scanline: rgba(0, 0, 0, 0.15);
}

/* CRT scanline effect */
.crt-screen::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    var(--term-scanline) 0px,
    var(--term-scanline) 1px,
    transparent 1px,
    transparent 3px
  );
  pointer-events: none;
  z-index: 10;
}

/* Phosphor text glow */
.phosphor-text {
  color: var(--term-phosphor);
  text-shadow:
    0 0 5px var(--term-phosphor),
    0 0 15px rgba(51, 255, 51, 0.5),
    0 0 30px rgba(51, 255, 51, 0.2);
}

/* Cursor blink */
@keyframes cursor-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
.cursor::after {
  content: '█';
  animation: cursor-blink 1s step-end infinite;
}
```

Key components:
- `TerminalWindow` — bordered panel with corner chrome decorations
- `PhosphorText` — glowing text with scanline overlay
- `CommandLine` — typed input with cursor
- `ProgressBar` — ASCII-style `[████░░░░]` or `[▓▓▓▓░░░░]`
- `StatusReadout` — labeled value pairs in fixed-width columns

### Pattern B: Mission Control / NASA Panel

Precision engineering aesthetic. Dark blue-black, cold sky blue, white. Analog gauges rendered in SVG. Everything is *measured*.

```css
:root {
  --mc-bg: #070b14;
  --mc-panel: #0d1526;
  --mc-border: #1e3a5f;
  --mc-primary: #4fc3f7;
  --mc-bright: #81d4fa;
  --mc-dim: rgba(79, 195, 247, 0.3);
  --mc-white: #e8f4fd;
  --mc-orange: #ff6b35;  /* alert/critical */
  --mc-gold: #ffd54f;    /* caution */
  --mc-font-display: 'Orbitron', sans-serif;
  --mc-font-data: 'Share Tech Mono', monospace;
}

/* Panel border with corner brackets */
.mc-panel {
  background: var(--mc-panel);
  border: 1px solid var(--mc-border);
  position: relative;
}
.mc-panel::before,
.mc-panel::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  border-color: var(--mc-primary);
  border-style: solid;
}
.mc-panel::before { top: -1px; left: -1px; border-width: 2px 0 0 2px; }
.mc-panel::after  { bottom: -1px; right: -1px; border-width: 0 2px 2px 0; }
```

Key components:
- `GaugeArc` — SVG analog gauge with needle
- `SevenSegDisplay` — seven-segment number display (like a digital clock from 1975)
- `MissionTimer` — countdown/countup with mission-log format `T+04:23:11`
- `TelemetryRow` — labeled parameter with live value
- `StatusMatrix` — grid of colored indicator lights (like Apollo DSKY)
- `FrequencyBand` — horizontal spectrum/signal display

### Pattern C: Art Deco Tech / Raygun Gothic

Ornate geometric borders, warm amber/gold on dark, fan shapes, symmetry. The future imagined by someone who loved 1930s architecture.

```css
:root {
  --deco-bg: #0d0a04;
  --deco-panel: #1a1206;
  --deco-gold: #d4af37;
  --deco-amber: #f5c842;
  --deco-copper: #b87333;
  --deco-dim: rgba(212, 175, 55, 0.25);
  --deco-chrome: #c0c0c0;
  --deco-red: #8b0000;
  --deco-font: 'Orbitron', 'Rajdhani', sans-serif;
}

/* Art deco border with notched corners */
.deco-panel {
  background: var(--deco-panel);
  border: 2px solid var(--deco-gold);
  clip-path: polygon(
    12px 0%, calc(100% - 12px) 0%,
    100% 12px, 100% calc(100% - 12px),
    calc(100% - 12px) 100%, 12px 100%,
    0% calc(100% - 12px), 0% 12px
  );
}

/* Deco divider with center ornament */
.deco-rule {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--deco-gold);
}
.deco-rule::before,
.deco-rule::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--deco-gold));
}
.deco-rule::after { background: linear-gradient(90deg, var(--deco-gold), transparent); }
```

Key components:
- `DecoGauge` — fan-shaped gauge with ornamental borders
- `ArtDecoCard` — panel with notched corners and gold borders
- `FanMeter` — semicircle meter with ornate tick marks
- `OrnamentDivider` — decorative rule with geometric center piece
- `ChromeButton` — beveled button with metallic gradient
- `VoltmeterDisplay` — analog needle meter in art deco frame

---

## Required Aesthetic Rules

Non-negotiable for authentic retro-futurism:

1. **NO flat modern colors** — use warm ambers, phosphor greens, cool NASA blues, or art deco golds. Pure `#ffffff` only for contrast on dark, never as a background.
2. **NO rounded-corner cards** — use sharp corners, notched corners (`clip-path`), or mechanically-framed panels. Max `border-radius: 3px`.
3. **ALWAYS include a texture layer** — scanlines, noise, grain, or a radial vignette. Even subtle is enough.
4. **ALWAYS include phosphor/neon glow** — `text-shadow` and `box-shadow` using the primary color at multiple radii.
5. **NO modern sans-serif fonts** — use Orbitron, VT323, Share Tech Mono, Rajdhani, or Special Elite.
6. **ALWAYS include at least one analog-style element** — a gauge, dial, segmented display, or ticker.
7. **Data must look measured** — use fixed-width columns, aligned decimals, military time, and unit labels.
8. **Label everything** — every panel, every readout, every button gets a label in small-caps or all-caps.

---

## Animation Library

```css
/* Terminal: cursor blink */
@keyframes cursor-blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }

/* CRT: screen flicker */
@keyframes crt-flicker {
  0%,100%{opacity:1} 92%{opacity:1} 93%{opacity:.85} 94%{opacity:1} 97%{opacity:1} 98%{opacity:.9} 99%{opacity:1}
}

/* Phosphor: text pulse */
@keyframes phosphor-pulse {
  0%,100%{text-shadow:0 0 5px currentColor,0 0 15px rgba(51,255,51,.5)}
  50%{text-shadow:0 0 8px currentColor,0 0 25px rgba(51,255,51,.7),0 0 40px rgba(51,255,51,.3)}
}

/* Gauge: needle sweep (use CSS transform on SVG line) */
@keyframes needle-sweep { from{transform:rotate(-135deg)} to{transform:rotate(135deg)} }

/* Boot: text reveal character by character effect */
@keyframes type-reveal { from{width:0} to{width:100%} }

/* Signal: horizontal scan */
@keyframes h-scan {
  0%{transform:translateX(-100%)} 100%{transform:translateX(100%)}
}

/* Alert: warning flash */
@keyframes alert-flash {
  0%,100%{background:transparent;color:var(--alert)} 
  50%{background:var(--alert);color:#000}
}

/* Dial: rotate with stepping (feels mechanical) */
@keyframes dial-step { to{transform:rotate(360deg)} }
/* Use: animation-timing-function: steps(60) */
```

---

## Step-by-Step Build Process

### Step 1 — Identify the Subgenre
Ask (or infer from keywords):
- **"terminal" / "green screen" / "Fallout"** → Cassette Futurism / Atompunk terminal
- **"NASA" / "mission control" / "Apollo"** → Mission Control / Space Age
- **"art deco" / "1930s" / "Raygun Gothic"** → Art Deco Tech
- **"Soviet" / "Constructivist" / "Soyuz"** → Soviet Cosmism
- No clear subgenre → ask, or default to NASA Mission Control (most versatile)

### Step 2 — Apply the Color System
Open `references/palettes.md` and copy the CSS variables for the chosen subgenre. Paste as `:root {}` block. Never mix palettes from different subgenres.

### Step 3 — Set the Scene
1. Dark background with subtle texture (noise or scanlines)
2. Vignette (radial gradient darkening at edges)
3. Panel borders with the era-appropriate style
4. Font imports

### Step 4 — Build the Information Structure
Map content to retro-futurism components:
- **Text/status** → Terminal readout or labeled panel
- **Numbers/metrics** → Seven-segment display or segmented arc gauge
- **Progress** → ASCII progress bar or analog needle
- **Navigation** → Backlit button row or toggle switches
- **Alerts** → Blinking indicator lights + warning text

### Step 5 — Add Physicality
- Glow effects on all active elements
- Subtle texture overlay on screens
- Corner bracket details on panels
- All-caps labels with wide letter-spacing
- Unit suffixes on all numbers (`MHz`, `KBPS`, `°C`, `PSI`)

### Step 6 — Animate the Machine
Add at minimum:
- One continuously animating element (cursor blink, gauge needle, signal scan)
- Staggered boot/reveal animation (panels appear one by one with `animation-delay`)
- One reactive element (hover state that adds glow or changes label)

---

## Reference Files

Read these when building specific subgenre UIs:
- `references/palettes.md` — Complete CSS variable sets for all 5 subgenres
- `references/components.md` — Copy-paste HTML/CSS component library
- `references/typography.md` — Font pairing guide and letter-spacing rules
- `references/animation-library.md` — Complete keyframe library with usage examples

---

## Quality Checklist

Before delivering any Retro-Futurism UI, verify:

- [ ] Correct subgenre palette applied (no palette mixing)
- [ ] Era-appropriate font in use (no Inter, Roboto, Arial)
- [ ] At least one texture layer (scanlines, noise, or grain)
- [ ] Phosphor/neon glow on primary text and key elements
- [ ] At least one analog-style element (gauge, dial, segmented display, ASCII bar)
- [ ] All panels labeled in ALL-CAPS with appropriate letter-spacing
- [ ] At least one continuously animating element
- [ ] Data values include unit labels
- [ ] No modern rounded-corner cards (sharp or notched corners only)
- [ ] Vignette or atmospheric depth present
- [ ] Boot/reveal animation sequence on load
- [ ] The UI would look at home in the target era's sci-fi movie or control room
