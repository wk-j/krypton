---
name: diegetic-ui
description: >
  Design and build Diegetic UI applications — interfaces that exist *within the story world*,
  made famous by Iron Man's JARVIS HUD, Dead Space's health bar embedded in the character's spine,
  and Alien's motion tracker. Use this skill whenever the user asks to build a HUD interface,
  sci-fi UI, in-world dashboard, cockpit display, holographic interface, AR overlay, game HUD,
  futuristic control panel, or any UI that is "part of the environment" rather than floating above it.
  Also trigger for requests like "Iron Man style", "sci-fi dashboard", "holographic UI", "AR HUD",
  "diegetic design", "in-world UI", "immersive interface", or "cockpit UI". Use even if the user
  only says "make it feel like it's in the game/movie/world".
---
 
# Diegetic UI Skill
 
Build production-grade **Diegetic UI** — interfaces that are physically embedded in the story
or environment, not layered on top as a traditional "screen UI" would be.
 
---
 
## What is Diegetic UI?
 
In film/game theory, **diegetic** means "existing within the world of the story."
 
| Type | Description | Examples |
|------|-------------|---------|
| **Diegetic UI** | Part of the world — characters can see and touch it | Iron Man HUD, Dead Space health bar, the Pip-Boy in Fallout, Minority Report gesture panels |
| **Non-diegetic UI** | Floating over reality — only the player/viewer sees it | Classic health bars, pause menus, most mobile apps |
| **Meta UI** | Breaks the 4th wall intentionally | Deadpool's awareness of the interface |
| **Spatial UI** | Anchored to 3D space but not to a physical object | AR waypoints, floating damage numbers |
 
---
 
## Core Design Principles
 
### 1. The Interface IS the Object
The UI is not a layer on top of an object — it IS the object.
- A spaceship dashboard: controls ARE the UI
- A biometric suit: the body IS the display
- A holographic projector: the light field IS the interface
- A mechanical device: the gears and dials ARE the data
 
### 2. Environmental Color Language
Pick ONE dominant environment and commit fully:
 
| Environment | Primary | Accent | Alert | Feel |
|-------------|---------|--------|-------|------|
| **Military/Combat** | `#0a1628` bg, `#00d4ff` cyan | `#f5a623` amber | `#e53e3e` red | Cold, precise, urgent |
| **Medical/Bio** | `#0d1f12` bg, `#3ecf6a` green | `#00cfcf` teal | `#f6ad55` orange | Clinical, organic, vital |
| **Civilian/Luxury** | `#0f0f1a` bg, `#c8a96e` gold | `#e2e2ff` lavender | `#fc8181` salmon | Premium, refined, warm |
| **Industrial/Mech** | `#1a1209` bg, `#ef9f27` amber | `#b8c4d0` steel | `#fc4444` red | Rugged, analog, hot |
| **Neural/Bio-tech** | `#0d0d1f` bg, `#a78bfa` purple | `#34d399` mint | `#f87171` pink | Organic, alien, alive |
 
### 3. Motion as Information
Every animation must carry meaning, not just decoration:
- **Scanning arcs** = system is searching/processing
- **Pulsing dots** = something is alive/active
- **Streaming data** = real-time input
- **Flickering** = system stress or damage
- **Sweeping wipes** = transitioning state
- **Breathing glow** = standby / low-power mode
 
### 4. Information Density Zones
Diegetic UIs use spatial hierarchy to communicate priority:
 
```
┌─────────────────────────────────────────┐
│  PERIPHERAL (ambient, always-on data)   │  ← Low density, low attention
│  ┌───────────────────────────────────┐  │
│  │  SECONDARY (contextual readouts)  │  │  ← Medium density
│  │  ┌─────────────────────────────┐  │  │
│  │  │    PRIMARY (critical info)  │  │  │  ← High density, high contrast
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```
 
### 5. Geometry as Grammar
Shapes carry semantic meaning in diegetic UIs:
- **Circle / Arc** = continuous measurement, status, energy
- **Hexagon** = structural integrity, locked/secure, classified
- **Triangle / Chevron** = direction, threat, navigation
- **Broken/Segmented line** = digital scan, detection
- **Bracket [ ]** = targeting, focus, zoom
- **Grid** = spatial awareness, radar, mapping
 
---
 
## Implementation Patterns
 
### Pattern A: HUD Overlay (Iron Man style)
Full-screen transparent overlay. Background is "the real world."
Use for: pilot interfaces, AR applications, combat systems.
 
```css
/* HUD palette — commit to this, override nothing */
:root {
  --hud-bg: #020d14;
  --hud-grid: rgba(0, 180, 220, 0.04);
  --hud-primary: #00d4ff;
  --hud-secondary: #0099bb;
  --hud-dim: rgba(0, 180, 220, 0.25);
  --hud-warn: #f5a623;
  --hud-danger: #e53e3e;
  --hud-ok: #3ecf6a;
  --hud-font: 'Courier New', 'Share Tech Mono', monospace;
}
/* Scanning line — always running in HUDs */
@keyframes scan {
  0% { transform: translateY(0); }
  100% { transform: translateY(100%); }
}
```
 
Key components to build:
- `ArcMeter` — circular progress arc (not a bar)
- `ScanGrid` — animated radar/compass with rotating sweep
- `DataStream` — scrolling telemetry text
- `StatusDot` — pulsing state indicator
- `BracketTarget` — corner-bracket focus frame
- `HexBadge` — hexagonal data container
 
### Pattern B: Embedded Physical UI (Dead Space / Alien style)
UI elements are part of the character's body or equipment.
Use for: games, immersive experiences, product demos.
 
```css
:root {
  --embed-surface: #1a1209;
  --embed-metal: #3d3224;
  --embed-glow: #ef9f27;
  --embed-plasma: #ff6b35;
  --embed-font: 'Orbitron', 'Rajdhani', sans-serif;
}
```
 
Key components to build:
- `SpineSegment` — segmented bar along a physical form
- `GaugePanel` — analog-style dial cluster
- `WeldSeam` — decorative structural detail
- `PlasmaBar` — energy bar with heat shimmer
- `RivetGrid` — structural panel texture via CSS
 
### Pattern C: Holographic Projection (Minority Report / Avatar style)
Semi-transparent glowing panels floating in space.
Use for: future OS concepts, touch interfaces, data visualization rooms.
 
```css
:root {
  --holo-bg: rgba(0, 180, 255, 0.03);
  --holo-border: rgba(0, 200, 255, 0.2);
  --holo-glow: rgba(0, 200, 255, 0.08);
  --holo-text: rgba(180, 240, 255, 0.9);
  --holo-font: 'Rajdhani', 'Exo 2', sans-serif;
}
/* Holographic shimmer */
@keyframes holo-shimmer {
  0%, 100% { opacity: 0.85; }
  50% { opacity: 1; }
}
```
 
---
 
## Required Aesthetic Rules
 
These are non-negotiable for authentic diegetic UI:
 
1. **NO solid opaque backgrounds** on panels — always semi-transparent or fully dark with grid/noise
2. **NO rounded corners > 4px** unless it's a pill/badge — use sharp angles, cut corners, or hexagons
3. **NO sans-serif body fonts** — use monospace (Courier New, Share Tech Mono) or geometric display (Orbitron, Rajdhani, Exo 2)
4. **ALWAYS include at least one animated element** — a static diegetic UI feels broken/offline
5. **Bracket ALL primary data** with geometric framing — never let critical numbers float naked
6. **Color alerts strictly** — cyan=normal, amber=caution, red=critical. Never reverse these.
7. **Include scan lines or grid overlay** — at opacity 0.03–0.06, creates depth without distraction
8. **Use letter-spacing: 0.1em–0.2em** on all labels — tight tracking feels civilian, wide tracking feels military
 
---
 
## Animation Reference
 
```css
/* Mandatory: spinning arc (power/status ring) */
@keyframes arc-spin { to { stroke-dashoffset: -314; } }
 
/* Mandatory: alive pulse (active system) */
@keyframes alive { 0%,100%{opacity:1} 50%{opacity:.35} }
 
/* Mandatory: scan sweep (radar/search) */
@keyframes sweep { to { transform: rotate(360deg); } }
 
/* Situational: data stream (telemetry) */
@keyframes stream-up { 0%{transform:translateY(20px);opacity:0} 100%{transform:translateY(0);opacity:1} }
 
/* Situational: glitch (damage/error) */
@keyframes glitch {
  0%,100%{transform:translate(0)} 20%{transform:translate(-2px,1px)}
  40%{transform:translate(2px,-1px)} 60%{transform:translate(-1px,2px)}
}
 
/* Situational: boot sequence (initialization) */
@keyframes reveal { from{width:0} to{width:100%} }
```
 
---
 
## Step-by-Step Build Process
 
### Step 1 — Choose Environment
Ask (or infer from context):
- What world does this exist in? (military, medical, industrial, luxury, sci-fi)
- What does the *character* see? (pilot, soldier, doctor, engineer, civilian)
- What is the *physical form* of the interface? (helmet, wrist device, wall panel, implant)
 
### Step 2 — Map Information Architecture
Before writing any code, define:
- **Primary** data (1–2 items): what the user MUST see instantly
- **Secondary** data (3–5 items): what they check frequently
- **Ambient** data (background): always-on environmental context
 
### Step 3 — Build the Canvas
Set the dark background first. Add the grid/scan overlay. Establish the color palette with CSS custom properties. Add the scanning line animation.
 
### Step 4 — Build Components Outside-In
1. Peripheral/ambient layer (background grid, scan line, corner brackets)
2. Secondary panels (left/right sidebars with status data)
3. Primary focal element (center — usually the most animated, highest contrast)
4. Overlay text and labels last
 
### Step 5 — Add Motion
- Start all animations with their most visible state
- Use `animation-delay` to stagger reveals — creates a "boot sequence" feeling
- Add `@media (prefers-reduced-motion: reduce)` fallback that removes non-critical animations
 
### Step 6 — Stress Test
Ask: if something went wrong in this world, how would the interface communicate it?
- Change one value to "critical" (use `--hud-danger` color)
- Add a pulsing warning dot
- Consider adding an `[ALERT]` state variant
 
---
 
## Reference Files
 
- `references/components.md` — Copy-paste component library (ArcMeter, ScanGrid, DataStream, etc.)
- `references/environments.md` — Full CSS variable sets for each environment type
- `references/typography.md` — Google Fonts imports and pairing guide for diegetic UIs
- `references/animation-library.md` — Complete keyframe library with usage notes
 
---
 
## Quality Checklist
 
Before delivering any diegetic UI, verify:
 
- [ ] At least one continuously animating element
- [ ] Color alerts are correct: cyan=normal, amber=caution, red=critical
- [ ] No fully opaque solid-color panel backgrounds
- [ ] Monospace or geometric display font in use
- [ ] Grid or scan-line overlay present (even at very low opacity)
- [ ] Primary data is visually framed (brackets, arcs, hexagons)
- [ ] Dark mode is the *default* — diegetic UIs don't have a "light mode"
- [ ] At least one arc/circular meter (no plain rectangular progress bars for critical data)
- [ ] Typography uses letter-spacing ≥ 0.08em on labels
- [ ] Interface would make sense *in the world* — a character could plausibly see/use this
