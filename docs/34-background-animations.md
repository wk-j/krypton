# Background Animations — Flame, Brainwave, Matrix

> Status: Implemented
> Date: 2026-03-23
> Milestone: N/A — Visual enhancement
>
> Consolidates: former docs 34 (flame wave), 35 (configurable animations), 36 (matrix)

---

## 1. Overview

Full-size `<canvas>` elements behind terminal content that activate when Claude Code is processing. Three animation styles are available, selected via TOML config. All implement a shared `BackgroundAnimation` interface.

### Configuration

```toml
[hooks]
animation = "flame"   # "flame" | "brainwave" | "matrix" | "none"
```

### Architecture

```typescript
export interface BackgroundAnimation {
  getElement(): HTMLCanvasElement;
  start(): void;
  stop(): void;
  resize(): void;
  dispose(): void;
  isRunning(): boolean;
}
```

The `ClaudeHookManager` reads `config.hooks.animation`, instantiates the correct class, and manages lifecycle:
- **Start triggers**: `SessionStart`, `UserPromptSubmit` hook events
- **Stop triggers**: `Stop`, `SessionEnd` hook events
- Canvas opacity when active: `0.20-0.25` (subtle behind terminal text)
- Fade duration: 600ms ease-in (start), 600ms ease-out (stop)

### DOM Placement

```
.krypton-window__content  (position: relative)
  +-- canvas.krypton-flame-canvas    (absolute, z-index: 0, pointer-events: none)
  +-- .krypton-uplink                (absolute, z-index: 10)
  +-- .krypton-activity-trace        (absolute, z-index: 10)
  +-- .krypton-pane (tree)           (relative, z-index: 1)
```

### Hot-Reload

When `config-changed` fires and the `animation` field differs: dispose all current animations, re-create with new type, immediately start if Claude is active.

---

## 2. Flame Animation (`"flame"`)

Flame particle system rising from the bottom + sinusoidal wave lines.

### Particles

```typescript
interface Particle {
  x: number;      // horizontal position
  y: number;      // vertical position (rises from bottom)
  vx: number;     // horizontal drift
  vy: number;     // vertical velocity (negative = upward)
  life: number;   // remaining life (0-1)
  maxLife: number;
  r: number;      // radius
}
```

- Spread across full width, rise from bottom
- Color gradient: white -> yellow -> orange -> red -> dark as life decreases
- Count: ~35% of canvas width in pixels (e.g., 400px -> ~140 particles)

### Waves

3 overlapping sine layers in flame palette, positioned in bottom quarter, with glow pass.

### Affected Files

| File | Change |
|------|--------|
| `src/flame.ts` | `FlameAnimation` class: canvas setup, particle system, wave renderer |
| `src/claude-hooks.ts` | Lifecycle integration, per-window flame instances |
| `src/compositor.ts` | Insert flame canvas into window content area |
| `src/styles.css` | `.krypton-flame-canvas` positioning |

---

## 3. Brainwave Animation (`"brainwave"`)

EEG-style horizontal waveforms — neural/electric aesthetic.

- 5 horizontal wave channels evenly spaced vertically
- Each channel: base sine wave + higher-frequency noise bursts (alpha/beta/gamma rhythms)
- Color palette: cyan (`rgba(0,255,200,...)`), blue (`rgba(0,180,255,...)`), purple (`rgba(120,80,255,...)`)
- Subtle glow pass on each wave
- Occasional "spike" events — random amplitude bursts traveling along the wave
- No particles — waves only
- Canvas opacity: `0.20`

### Affected Files

| File | Change |
|------|--------|
| `src/brainwave.ts` | `BrainwaveAnimation` implementing `BackgroundAnimation` |
| `src/claude-hooks.ts` | Import and register in factory |

---

## 4. Matrix Animation (`"matrix"`)

Classic falling character rain with simulated 3D depth.

### Columns

```typescript
interface MatrixColumn {
  x: number;           // pixel x position
  y: number;           // current head y position
  speed: number;       // pixels per frame
  length: number;      // visible chars in tail
  depth: number;       // 0.0 (front) to 1.0 (back)
  chars: string[];     // ring buffer of glyphs
  charTimer: number;
  charInterval: number;
}
```

- ~40-80 columns depending on canvas width, randomly distributed
- **Depth simulation**: deeper columns have smaller font (14px-8px), lower opacity (0.9-0.3), slower speed — parallax 3D feel
- **Character set**: Katakana (U+30A0-U+30FF), digits 0-9, select Latin uppercase
- Head character glows bright white-green (`#00ff41`), tail fades to transparent
- Glyph cycling: periodic random character swaps for "decoding" flicker effect

### Affected Files

| File | Change |
|------|--------|
| `src/matrix.ts` | `MatrixAnimation` implementing `BackgroundAnimation` |
| `src/claude-hooks.ts` | Import and register in factory |
| `src/styles.css` | `.krypton-matrix-canvas` selector |

---

## Edge Cases

| Case | Handling |
|------|----------|
| `animation = "none"` | No canvas created, zero CPU overhead |
| Invalid config value | Defaults to `"flame"` |
| Multiple windows | Each window gets its own animation instance; all start/stop together |
| Window resize during animation | `resize()` re-reads parent dimensions, updates canvas |
| Rapid start/stop | Cancels in-progress fade, begins new transition immediately |
| Window destroyed while animating | `dispose()` cancels rAF and removes canvas from DOM |
| No Claude session | Canvas stays `display: none` |
| Narrow windows (matrix) | Column count reduced proportionally; minimum 8 columns |

## Out of Scope

- Per-window animation activation (hook events are global, not per-PTY)
- Configurable colors/intensity per animation type
- Custom user-written animations or plugin system
- WebGL / actual 3D rendering for matrix
