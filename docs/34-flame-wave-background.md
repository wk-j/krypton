# Flame Wave Background Animation — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: N/A — Visual enhancement

## Problem

When Claude Code is processing a prompt inside a Krypton terminal, the existing visual indicators (sigil badge, neural uplink bar, tool HUD text) are subtle titlebar-level cues. There is no immersive background-level visual feedback that the AI is actively thinking. The user wants a flame particle + wave canvas animation behind the terminal content, matching the aesthetic from `ai_thinking_flame_wave.html`.

## Solution

Add a full-size `<canvas>` element behind the terminal content in each window. When Claude Code begins processing (hook events: `SessionStart`, `UserPromptSubmit`), the canvas fades in and renders a flame particle system rising from the bottom + sinusoidal wave lines. When Claude stops (`Stop`, `SessionEnd`), the canvas fades out and rendering halts to save CPU. The animation is entirely frontend — no backend changes needed.

## Affected Files

| File | Change |
|------|--------|
| `src/flame.ts` | **New** — `FlameAnimation` class: canvas setup, particle system, wave renderer, start/stop with fade |
| `src/claude-hooks.ts` | Add `createFlameCanvas()` factory, call `start()`/`stop()` on session lifecycle events, expose per-window flame instances |
| `src/compositor.ts` | Insert flame canvas into window content area during `createWindow()` |
| `src/styles.css` | CSS for `.krypton-flame-canvas` (absolute positioning, z-index behind panes) |

## Design

### Data Structures

**`src/flame.ts`:**

```typescript
/** Single flame particle */
interface Particle {
  x: number;      // horizontal position
  y: number;      // vertical position (rises from bottom)
  vx: number;     // horizontal drift
  vy: number;     // vertical velocity (negative = upward)
  life: number;   // remaining life (0-1, decrements each frame)
  maxLife: number; // initial life value
  r: number;      // radius
}

/** Wave layer definition */
interface WaveLayer {
  freq: number;   // frequency multiplier
  amp: number;    // amplitude multiplier
  speed: number;  // animation speed
  color: string;  // rgba stroke color
  width: number;  // line width
}

/** Main animation controller for one window */
class FlameAnimation {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[];
  private running: boolean;
  private animFrame: number;

  getElement(): HTMLCanvasElement;
  start(): void;   // fade in + begin rendering
  stop(): void;    // fade out + stop requestAnimationFrame
  resize(): void;  // re-measure parent, update canvas dimensions
  dispose(): void; // remove from DOM, cancel animation
}
```

### Data Flow

```
1. User submits prompt to Claude Code in terminal
2. Claude Code fires UserPromptSubmit hook → Rust HTTP server → Tauri event
3. ClaudeHookManager.handleHookEvent() receives event
4. On SessionStart/UserPromptSubmit: calls startFlame() on all window flame instances
5. FlameAnimation.start() → sets canvas display:block, fades opacity to 0.25, begins rAF loop
6. rAF loop: clears canvas, draws rising flame particles + wave lines at bottom
7. On Stop/SessionEnd: calls stopFlame() on all flame instances
8. FlameAnimation.stop() → fades opacity to 0, after fade completes cancels rAF
```

### UI Changes

**DOM insertion point** — inside `createWindow()`, the flame canvas is appended to `.krypton-window__content` as the first child (before uplink bar, activity trace, and pane tree). It uses `position: absolute; inset: 0` so it sits behind all content.

```
.krypton-window__content  (position: relative — already set)
  ├── canvas.krypton-flame-canvas   ← NEW (absolute, z-index: 0)
  ├── .krypton-uplink               (absolute, z-index: 10)
  ├── .krypton-activity-trace       (absolute, z-index: 10)
  └── .krypton-pane (tree)          (relative, z-index: 1)
```

**CSS:**

```css
.krypton-flame-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  display: none;           /* hidden until activated */
  opacity: 0;
}
```

**Animation parameters** (adapted from reference HTML):
- Flame particles: spread across full width, rise from bottom, color gradient white→yellow→orange→red→dark as life decreases
- Particle count: ~35% of canvas width in pixels (e.g., 400px wide → ~140 particles)
- Wave: 3 overlapping sine layers in flame palette, positioned in bottom quarter, with glow pass
- Canvas opacity when active: `0.25` (subtle behind terminal text)
- Fade duration: 600ms ease-in (start), 600ms ease-out (stop)

### Lifecycle Integration in ClaudeHookManager

New methods added to `ClaudeHookManager`:

```typescript
/** Create a flame canvas for a window content area */
createFlameCanvas(): HTMLCanvasElement;

/** Start all flame animations (called on session activity) */
private startFlame(): void;

/** Stop all flame animations (called on session end) */
private stopFlame(): void;
```

Events that trigger **start**: `SessionStart`, `UserPromptSubmit`
Events that trigger **stop**: `Stop`, `SessionEnd`

The manager holds a `Set<FlameAnimation>` for all created instances and iterates on start/stop. On window resize, the compositor calls `resize()` on each flame instance (piggybacking on the existing `fitAll()` path).

## Edge Cases

- **Multiple windows**: Each window gets its own `FlameAnimation` instance and canvas. All start/stop together when Claude is active (hook events are global, not per-PTY-session).
- **Window resize during animation**: `FlameAnimation.resize()` re-reads parent dimensions, updates canvas size, and re-initializes particles to fill the new area.
- **Rapid start/stop**: If `start()` is called while a fade-out is in progress, it cancels the fade-out and begins fade-in immediately. The `running` flag gates the rAF loop.
- **Window destroyed while animating**: `dispose()` cancels rAF and removes the canvas from DOM.
- **No Claude session**: Canvas stays `display: none` — zero CPU overhead.
- **Performance**: At 0.25 opacity with ~140 particles + 3 wave layers, the canvas draw is lightweight (~1ms per frame). The `display: none` when inactive ensures zero GPU compositing cost.

## Out of Scope

- Per-window flame activation (only the window running Claude). Current hook events don't reliably map to specific PTY sessions — they're global. Could be added later if session-to-PTY mapping improves.
- Configurable flame colors or intensity via TOML config.
- Flame animation for Quick Terminal overlay.
