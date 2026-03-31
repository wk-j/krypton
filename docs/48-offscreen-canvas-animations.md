# OffscreenCanvas Animations — Implementation Spec

> Status: Implemented (Phase 1 + Phase 2)
> Date: 2026-03-31
> Milestone: M8 — Polish

## Problem

When a PTY-heavy process like Claude Code streams large amounts of output, the main thread gets saturated processing `pty-output` events (byte scanning, OSC parsing, `terminal.write()`). Background animations (matrix, flame, brainwave) and the cursor trail all run their `requestAnimationFrame` loops on the same thread and get starved — the matrix rain visibly freezes and cursor particles stutter.

The cursor trail (`cursor-trail.ts`) is especially expensive: it creates/destroys up to 120 DOM `<div>` elements with per-frame style updates (`left`, `top`, `opacity`, `transform`, `radial-gradient`, `box-shadow`), triggering style recalc + layout + paint every frame. It also polls `getBoundingClientRect()` and xterm buffer state each frame for the text cursor position.

## Solution

Two-phase migration of all animations off the main thread.

**Phase 1** — Move the three canvas-based background animations (`FlameAnimation`, `MatrixAnimation`, `BrainwaveAnimation`) to OffscreenCanvas in Web Workers. These already render to `<canvas>`, so the migration is straightforward: extract pure render logic, transfer canvas to worker, proxy control messages.

**Phase 2** — Rewrite `CursorTrail` from DOM particles to a canvas-based renderer, then move it to an OffscreenCanvas worker using the same proxy pattern from Phase 1. The main thread only sends mouse/cursor position updates via `postMessage`.

## Affected Files

### Phase 1 — Background Animations

| File | Change |
|------|--------|
| `src/animation-worker.ts` | **New** — Web Worker entry point. Receives messages, runs the correct animation renderer, owns rAF loop |
| `src/offscreen-animation.ts` | **New** — `OffscreenAnimationProxy` class implementing `BackgroundAnimation`. Creates worker, transfers canvas, sends messages |
| `src/flame.ts` | Extract pure render logic into `FlameRenderer` class (no DOM references). Keep `FlameAnimation` for fallback |
| `src/matrix.ts` | Same — extract `MatrixRenderer` |
| `src/brainwave.ts` | Same — extract `BrainwaveRenderer` |
| `src/claude-hooks.ts` | Update `createAnimationInstance()` to use `OffscreenAnimationProxy` when supported, fall back to direct classes |

### Phase 2 — Cursor Trail

| File | Change |
|------|--------|
| `src/cursor-trail.ts` | Rewrite: replace DOM particles with canvas rendering. Use `OffscreenAnimationProxy`-like pattern to run in worker. Main thread sends mouse/cursor coords via `postMessage` |
| `src/cursor-trail-worker.ts` | **New** — Worker that receives cursor positions and renders particle trail on OffscreenCanvas |
| `src/main.ts` | Update CursorTrail initialization (canvas element instead of bare init) |

## Design

### Phase 1 — Background Animations

#### Architecture

```
Main thread                          Worker thread
─────────────────────────────────    ─────────────────────────────
<canvas> ──transferControlTo──────→  OffscreenCanvas
                                     │
OffscreenAnimationProxy              animation-worker.ts
  .start()  ──postMessage('start')─→   starts rAF loop
  .stop()   ──postMessage('stop')──→   stops rAF loop
  .resize() ──postMessage('resize')→   updates canvas dimensions
  .dispose()──postMessage('dispose')→  terminates worker
```

#### Data Structures

```typescript
// Messages from main thread → worker
type AnimationWorkerMessage =
  | { type: 'init'; animation: 'flame' | 'matrix' | 'brainwave'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'dispose' };
```

### OffscreenAnimationProxy (`src/offscreen-animation.ts`)

```typescript
export class OffscreenAnimationProxy implements BackgroundAnimation {
  private canvas: HTMLCanvasElement;
  private worker: Worker;
  private running = false;

  constructor(animationType: 'flame' | 'matrix' | 'brainwave') {
    this.canvas = document.createElement('canvas');
    this.canvas.className = `krypton-${animationType}-canvas`;

    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker = new Worker(
      new URL('./animation-worker.ts', import.meta.url),
      { type: 'module' }
    );

    const dpr = window.devicePixelRatio || 1;
    this.worker.postMessage(
      { type: 'init', animation: animationType, canvas: offscreen, width: 0, height: 0, dpr },
      [offscreen]
    );
  }

  getElement(): HTMLCanvasElement { return this.canvas; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize(); // ensure dimensions are current before starting
    this.worker.postMessage({ type: 'start' });
    // Fade in via CSS on the main-thread canvas element
    this.canvas.style.opacity = '0';
    this.canvas.style.display = 'block';
    requestAnimationFrame(() => {
      this.canvas.style.transition = 'opacity 600ms ease-in';
      this.canvas.style.opacity = '0.25';
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.worker.postMessage({ type: 'stop' });
    this.canvas.style.transition = 'opacity 600ms ease-out';
    this.canvas.style.opacity = '0';
    setTimeout(() => {
      if (!this.running) this.canvas.style.display = 'none';
    }, 650);
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = parent.getBoundingClientRect();
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.worker.postMessage({ type: 'resize', width: rect.width, height: rect.height, dpr });
  }

  isRunning(): boolean { return this.running; }

  dispose(): void {
    this.running = false;
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
    this.canvas.remove();
  }
}
```

### Worker Entry Point (`src/animation-worker.ts`)

```typescript
// Receives OffscreenCanvas, runs animation rAF loop off main thread.
// Imports pure render functions from flame/matrix/brainwave modules.

let canvas: OffscreenCanvas;
let ctx: OffscreenCanvasRenderingContext2D;
let renderer: { update(ctx, W, H): void; init?(W, H): void };
let running = false;
let rafId: number = 0;
let W = 0, H = 0;

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  switch (e.data.type) {
    case 'init':
      canvas = e.data.canvas;
      ctx = canvas.getContext('2d')!;
      // Select renderer based on animation type
      break;
    case 'start':
      running = true;
      tick();
      break;
    case 'stop':
      running = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      break;
    case 'resize':
      W = e.data.width; H = e.data.height;
      canvas.width = W * e.data.dpr;
      canvas.height = H * e.data.dpr;
      ctx.setTransform(e.data.dpr, 0, 0, e.data.dpr, 0, 0);
      renderer.init?.(W, H);
      break;
    case 'dispose':
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      self.close();
      break;
  }
};

function tick() {
  if (!running) return;
  ctx.clearRect(0, 0, W, H);
  renderer.update(ctx, W, H);
  rafId = requestAnimationFrame(tick);
}
```

#### Render Logic Extraction

Each animation file gets a new exported class containing pure render logic that only needs a `CanvasRenderingContext2D` (or `OffscreenCanvasRenderingContext2D`), width, and height — no DOM access:

- `flame.ts` → export `FlameRenderer` (particle + wave update/draw, using passed-in ctx)
- `matrix.ts` → export `MatrixRenderer` (column state + draw, using passed-in ctx)
- `brainwave.ts` → export `BrainwaveRenderer` (channel + spike + grid draw, using passed-in ctx)

The existing `FlameAnimation`, `MatrixAnimation`, `BrainwaveAnimation` classes remain as fallbacks (they already work). The renderer extraction just separates "canvas drawing" from "DOM lifecycle".

#### Integration (`src/claude-hooks.ts`)

```typescript
private createAnimationInstance(type: string): BackgroundAnimation {
  // Feature-detect OffscreenCanvas + worker support
  if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function') {
    return new OffscreenAnimationProxy(type as 'flame' | 'matrix' | 'brainwave');
  }
  // Fallback to main-thread animations
  if (type === 'brainwave') return new BrainwaveAnimation();
  if (type === 'matrix') return new MatrixAnimation();
  return new FlameAnimation();
}
```

#### Phase 1 Data Flow

```
1. ClaudeHookManager.createAnimationCanvas() called for a window
2. createAnimationInstance() checks for OffscreenCanvas support
3. If supported: creates OffscreenAnimationProxy
   a. Proxy creates <canvas>, transfers to OffscreenCanvas
   b. Spawns Worker, sends 'init' with transferred canvas
   c. Worker stores canvas + ctx, selects renderer
4. When Claude session starts → startFlame() → proxy.start()
   a. Proxy sends 'start' to worker
   b. Worker begins rAF loop, draws to OffscreenCanvas
   c. Browser composites OffscreenCanvas onto visible <canvas> automatically
   d. Proxy applies CSS fade-in on main thread
5. PTY output floods main thread — worker rAF loop is unaffected
6. When session ends → proxy.stop() → worker pauses rAF
7. On window resize → proxy.resize() → worker adjusts canvas dimensions
8. On window close → proxy.dispose() → worker terminates
```

### Phase 2 — Cursor Trail

#### Problem with Current Implementation

`CursorTrail` creates up to 120 DOM `<div>` elements as particles, each updated per-frame with:
- `style.left`, `style.top` (triggers layout)
- `style.transform` (GPU-composited, but combined with layout properties)
- `style.background` with `radial-gradient()` (triggers paint)
- `style.boxShadow` (triggers paint)
- `style.opacity` (triggers composite)

Plus `pollTextCursor()` calls `getBoundingClientRect()` + xterm buffer queries every frame, forcing layout recalc.

#### Architecture

```
Main thread                              Worker thread
──────────────────────────────────────   ─────────────────────────────
<canvas class="krypton-cursor-trail">    cursor-trail-worker.ts
  transferControlToOffscreen() ────────→   OffscreenCanvas + ctx
                                          │
mousemove listener                        rAF loop:
  ──postMessage('mouse', x, y)─────────→    spawn particles at (x,y)
                                            update physics
pollTextCursor (throttled to 50ms)          draw radial gradients
  ──postMessage('cursor', x, y)────────→    fade & recycle
                                          │
toggle/dispose                            (no DOM access needed)
  ──postMessage('stop'/'dispose')──────→
```

#### Data Structures

```typescript
type CursorTrailWorkerMessage =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { type: 'mouse'; x: number; y: number }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'stop' }
  | { type: 'start' }
  | { type: 'dispose' };
```

#### Canvas-based Particle Rendering

The worker replaces DOM divs with canvas-drawn particles:
- Radial gradient circles via `ctx.createRadialGradient()` (replaces CSS `radial-gradient`)
- Glow via `ctx.shadowBlur` + `ctx.shadowColor` (replaces CSS `box-shadow`)
- HSL color cycling computed in JS (same math as current implementation)
- Canvas covers the full viewport (`position: fixed; inset: 0; pointer-events: none`)

#### Main Thread Changes (`src/cursor-trail.ts`)

The rewritten class becomes thin:
- `mousemove` listener → sends `{ type: 'mouse', x, y }` to worker (throttled as before)
- `pollTextCursor()` → still reads xterm buffer + `getBoundingClientRect()` on main thread (must access DOM), but throttled to 50ms and only sends `{ type: 'cursor', x, y }` coords to worker
- No particle state, no DOM element creation, no per-frame style updates
- `init()` creates a full-viewport canvas, transfers to worker
- `toggle()` / `destroy()` send control messages

#### Phase 2 Data Flow

```
1. CursorTrail.init() creates full-viewport <canvas>, transfers to worker
2. Worker receives OffscreenCanvas, starts rAF loop
3. On mousemove: main thread sends (x, y) to worker (throttled 10ms)
4. On text cursor move: main thread polls xterm buffer (throttled 50ms),
   computes pixel position, sends (x, y) to worker
5. Worker spawns particles at received positions, runs physics + drawing
6. PTY floods main thread → mouse events still fire (browser guarantees),
   worker rAF is unaffected → particles stay smooth
7. toggle()/destroy() sends stop/dispose to worker
```

## Edge Cases

### Phase 1
- **OffscreenCanvas unsupported**: Fall back to existing main-thread classes. Tauri on older macOS WebKit may lack support — the feature-detect handles this cleanly.
- **Worker fails to load**: Wrap worker creation in try/catch, fall back to main-thread animation.
- **Multiple animations**: Each window pane gets its own worker. With 4-6 panes this is fine — workers are lightweight when idle.
- **Animation type switch (config hot-reload)**: `setAnimationType()` already disposes old animations and creates new ones. The proxy's `dispose()` terminates the worker.
- **Resize before start**: `resize()` sends dimensions to worker even if not running, so `start()` has correct size.
- **Canvas fade in/out**: CSS `opacity` transition stays on main thread (it's a compositor-level property, doesn't need rAF).

### Phase 2
- **Mouse position during PTY flood**: Browser still dispatches `mousemove` events even under JS load — they may be coalesced (fewer events), but the worker will still get positions to render.
- **Text cursor poll during PTY flood**: The 50ms-throttled poll may occasionally miss frames, but the cursor position message will catch up on the next poll. Acceptable — trail is a visual flourish, not precision-critical.
- **Canvas layering**: The cursor trail canvas must sit above terminal content but below modals. Use `z-index: 9999` (below profiler HUD's 10000) with `pointer-events: none`.
- **Particle visual fidelity**: Canvas radial gradients + shadowBlur closely match the current CSS `radial-gradient` + `box-shadow` look. Minor differences are acceptable.
- **OffscreenCanvas fallback**: If unsupported, keep the existing DOM-based `CursorTrail` as-is.

## Out of Scope

- Batching/throttling PTY output (separate optimization)
- SharedArrayBuffer communication (postMessage is sufficient for control messages)
- GPU/WebGL rendering (canvas 2D is adequate)
- Applying this pattern to the profiler HUD (text-based, low CPU)
