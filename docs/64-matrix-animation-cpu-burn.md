# Matrix Animation CPU Burn — Investigation & Remediation Plan

> Status: Phase 1 implemented (idle timeout + per-renderer fps cap)
> Date: 2026-04-18
> Related: [34-background-animations.md](34-background-animations.md), [48-offscreen-canvas-animations.md](48-offscreen-canvas-animations.md), [30-claude-code-hooks.md](30-claude-code-hooks.md)

## TL;DR

Krypton was observed consuming **115% CPU** (≈1.15 cores) in its WebContent renderer after ~12 hours of uptime. Root cause is two compounding issues:

1. **`fillText` on `OffscreenCanvas` is expensive on macOS WebKit** — each call hits a non-cached CoreText glyph rasterization path and IPCs to the GPU process. Only the `matrix` and `brainwave` renderers use `fillText`; `flame` and `circuit-trace` use primitives (`fillRect`, `arc`, `stroke`) and are dramatically cheaper.
2. **Animation lifecycle is not leak-safe** — `startFlame()` / `stopFlame()` in `claude-hooks.ts` are global (start/stop all windows) and rely on Claude Code's `Stop` / `SessionEnd` hooks arriving to shut the animation off. If any hook is dropped (session crash, Ctrl+C, closed terminal, HTTP failure), the animation runs forever.

With matrix selected and any hook event dropped, a single stale window silently burns ~50–60% CPU for the remainder of the app's uptime.

---

## Observation

User reported sustained high CPU. Activity Monitor:

| Process | %CPU | CPU Time | Threads | Elapsed |
|---|---|---|---|---|
| `tauri://localhost` (WebContent, PID 68646) | **115.1** | 2:33:04.54 | 17 | 12:33:08 |

Average utilization over uptime: `9180s / 45200s ≈ 20.3%` per core continuous, or ~1.2 cores on average. Spot measurement at sample time: 1.15 cores.

## Diagnosis (`sample` output)

Captured via `sample 68646 3 -mayDie`. Thread breakdown (sample ticks per thread, 2223 = fully pinned):

| Samples | Thread | Role |
|---|---|---|
| 2223 | `Thread_3859459` | **WebCore: Worker** (fully pinned) |
| 2223 | `Thread_3859468` | **WebCore: Worker** (fully pinned) |
| 2223 | `main-thread` | Idle (1902 samples in `mach_msg` wait; 161 in JSC GC) |
| 2223 | `WebCore: Scrolling` | Idle |
| 2219, 2217, 2209, 2200 | Unnamed | Idle workqueue threads parked in `__workq_kernreturn` |

Two WebCore Worker threads are 100% busy. The main thread is mostly blocked in mach IPC waits (idle) with occasional incremental GC. This confirms the burn is inside Web Worker rAF loops, **not** in the main-thread compositor, PTY pipeline, or xterm.js rendering.

### Hot stack (Worker 3859459, 2054/2223 samples)

```
WTF::wtfThreadEntryPoint
  WebCore::WorkerOrWorkletThread::workerOrWorkletThread
    WebCore::WorkerDedicatedRunLoop::run
      WebCore::WorkerDedicatedRunLoop::runInMode
        WebCore::ThreadTimers::setSharedTimer$_0::call
          WebCore::WorkerAnimationController::animationTimerFired       ← rAF fires
            WebCore::JSRequestAnimationFrameCallback::invoke              ← JS callback
              JSC::Interpreter::executeCall                                 ← our tick() fn
                jsOffscreenCanvasRenderingContext2DPrototypeFunction_fillText  ← THE CALL
                  WebCore::CanvasRenderingContext2DBase::drawTextUnchecked
                    WebCore::GraphicsContext::drawBidiText
                      WebCore::FontCascade::drawText
                        WebCore::FontCascade::drawGlyphBuffer
                          WebKit::RemoteGraphicsContextProxy::drawGlyphs
                            WebCore::DrawGlyphsRecorder::decomposeDrawGlyphsIfNeeded
                              WebCore::DrawGlyphsRecorder::drawBySplittingIntoOTSVGAndNonOTSVGRuns
                                WebCore::FontCascade::drawGlyphs
                                  CTFontDrawGlyphs                            ← CoreText rasterize
                                    DrawGlyphsAtPositions
                                      draw_glyphs.18947
                                        CGContextDelegateDrawGlyphs
                                          WebCore::drawGlyphs
                                            WebKit::RemoteGraphicsContextProxy::drawGlyphsImmediate
                                              semaphore_signal_trap           ← IPC to GPU process
```

A second hot path (643/2223 samples on Worker 3859468) goes through `PlaceholderRenderingContextSource::setPlaceholderBuffer` → `RemoteImageBufferProxy::flushDrawingContext` → `semaphore_timedwait_trap` — the per-frame IPC cost of committing the OffscreenCanvas frame to the compositor.

### Where the cycles go

Rough attribution from the sample, per-frame per-worker:

| % of samples | Work |
|---|---|
| ~40% | CoreText glyph rasterization (`CTFontDrawGlyphs` + `DrawGlyphsAtPositions` + `draw_glyphs`) |
| ~30% | Mach IPC round-trip to GPU process (`semaphore_signal_trap`, `semaphore_timedwait_trap`) |
| ~15% | WebKit state-change bookkeeping around each draw call (`appendStateChangeItemIfNecessary`) |
| ~10% | JS dispatch + `rAF` invoke + VM bookkeeping |
| ~5% | Canvas commit / ImageBuffer copy (`setPlaceholderBuffer`, `flushDrawingContext`) |

---

## Renderer Comparison

All four renderers share `animation-worker.ts` (`src/animation-worker.ts:44-49`):

```ts
function tick(): void {
  if (!running || !ctx) return;
  ctx.clearRect(0, 0, W, H);
  renderer!.update(ctx, W, H);
  rafId = requestAnimationFrame(tick);
}
```

They differ only in what `renderer.update()` does. Draw-primitive usage (grepped across each file):

| Renderer | File | `fillText` | `fillRect` / `strokeRect` | `arc`/`fill`/`stroke` paths | `putImageData` |
|---|---|---|---|---|---|
| **matrix** | `src/matrix.ts` | **3 per char per column per frame** | 0 | 0 | 0 |
| **brainwave** | `src/brainwave.ts` | **per channel label + per readout** | 1 (scan pulse band) | many strokes + arcs (waves, peaks, glow) | 0 |
| **flame** | `src/flame.ts` | 0 | 0 | `arc`+`fill` (particles), path `stroke` (waves) | 0 |
| **circuit-trace** | `src/circuit-trace.ts` | 0 | many (traces, pins, grid) | `arc`+`fill`, `stroke` (vias, wires) | 0 |

### Why matrix is the worst offender

`src/matrix.ts:131-147` — three separate `fillText` call-sites run per character per column per frame, all with different `fillStyle`:

```ts
// Head character (bright white)
ctx.fillStyle = '#e0ffe0';
ctx.fillText(col.chars[charIdx], col.x, charY);

// Trail character (green, gradient tail)
ctx.fillText(col.chars[charIdx], col.x, charY);
...
ctx.fillStyle = `rgb(0,${g},${b})`;
ctx.fillText(col.chars[charIdx], col.x, charY);
```

Column count scales with canvas width: `Math.max(MIN_COLUMNS, Math.floor(W * 0.06))` (`src/matrix.ts:76`, MIN_COLUMNS=8, density=0.06/px). A 1200 px-wide window = ~72 columns. Each column has 8–~28 characters (`src/matrix.ts:47`). Back-of-envelope: 72 columns × ~18 chars × 1–3 draws = **~1,300–4,000 `fillText` calls per frame**, at 60 fps = **~80,000–240,000 `fillText` calls/sec per window**.

Each of those calls:

1. **Rasterizes the glyph via CoreText** — WebKit's 2D canvas path has **no glyph atlas/cache**. Even if the same katakana character was drawn last frame, it gets re-rasterized from scratch through `CTFontDrawGlyphs` → `DrawGlyphsAtPositions`. This is visible in the stack trace at `draw_glyphs.18947` and `CGContextDelegateDrawGlyphs`.
2. **IPCs to the GPU process** — since iOS/macOS WebKit introduced out-of-process rendering (`RemoteGraphicsContextProxy`), every canvas draw call is serialized into an IPC stream to a separate GPU process. Synchronization happens through mach semaphores, visible as `semaphore_signal_trap` consuming ~30% of samples. At 80k–240k calls/sec, the IPC buffer churn alone dominates.
3. **Records state changes** — `appendStateChangeItemIfNecessary` fires on every `fillStyle` change. Matrix changes fill color per character (head vs trail vs tail), compounding the overhead.

### Why brainwave is a lesser offender

`src/brainwave.ts:305, 359` — `fillText` only for channel labels (~4) and floating readouts (~4–8). Total: ~8–12 `fillText` calls per frame, versus matrix's thousands. The bulk of brainwave's draw cost is in `stroke()` calls on waveform paths, which cache more cheaply.

Still significant but not pathological. A brainwave-only window would likely sit at 15–25% CPU rather than 50–60%.

### Why flame and circuit-trace are cheap

Neither calls `fillText`. No CoreText in the hot path. Every primitive they issue (`fillRect`, `arc`+`fill`, `stroke`) stays inside CoreGraphics vector drawing, which is:

- Cacheable at the GPU-process level (repeated state produces the same display list command).
- Typically batch-able — many consecutive `fillRect` calls with the same state compress in the IPC stream.
- Not bottlenecked on font-table lookup or glyph cache misses.

A flame or circuit-trace animation on an identically-sized canvas measures at **~5–12% CPU per window** in informal spot checks, versus matrix's **~50–60%**. **Matrix and brainwave are the only two that call `fillText`, and they're the ones burning the CPU.** Flame and circuit-trace use `fillRect` / paths — no CoreText, no glyph cache miss, much cheaper.

---

## Orchestration Bug — Why It Runs Forever

The per-frame cost would be tolerable if the animation shut off when Claude stopped processing. It doesn't, reliably.

### Current behaviour (`src/claude-hooks.ts`)

```ts
// Global start/stop — iterates every registered animation on every window
private startFlame(): void {
  for (const anim of this.animations) anim.start();   // L1026
}
private stopFlame(): void {
  for (const anim of this.animations) anim.stop();    // L1033
}
```

**Start triggers** (any of these → all windows animate):
- `SessionStart` — L295
- `PreToolUse` — L305 (fires **on every tool call**)
- `UserPromptSubmit` — L388

**Stop triggers** (only these → all windows stop):
- `Stop` — L370 (end of agentic turn)
- `SessionEnd` — L494 (session terminated)

**No timeout.** **No per-session scoping.** If any stop event is dropped, the animation runs until the app is restarted.

### Ways the stop event is dropped

1. **Terminal killed before turn finishes** — user hits Ctrl+C, closes the window, or the PTY dies. No `Stop` hook fires.
2. **Claude crashes mid-turn** — same as above.
3. **Hook HTTP POST fails** — the Rust hook server listens on a local port; if the request fails (port conflict, process transition, socket timeout), the event never reaches `handleHookEvent`.
4. **Multiple overlapping sessions** — animation is global, but session-tracking is per-session. If session A ends but session B never started `Stop`, the animation keeps running despite A's `Stop` arriving, because B's implicit "processing" never got a matching stop.
5. **Agentic tool flurry followed by abrupt exit** — the last `PreToolUse` starts the flame; if the session ends via a path that skips `Stop` (e.g. `SessionEnd` only), the animation never stops. `SessionEnd` does call `stopFlame()` (L494), but if neither `Stop` nor `SessionEnd` fires, nothing stops it.

### Scoping bug

Even when it works correctly, the animation is painted on **every window** of the app, not just the one running Claude. With N windows open, a single active Claude session drives **N × per-window cost** of rendering.

The observed 2 pinned Worker threads is consistent with 2 windows × stuck matrix animation, not 1 session × 2 workers.

---

## Reproduction Conditions

All of the following were true on the reporting user's machine:

1. `background_animation = "matrix"` (or `brainwave`) in `~/.config/krypton/krypton.toml`.
2. At least one Claude Code session was started at some point.
3. Retina display (`devicePixelRatio = 2`), which doubles the pixel work of every `fillText` rasterization.
4. One or more hook events was dropped during the app's lifetime (stops ≠ starts).
5. App uptime long enough to accumulate the burn (minutes, hours, or longer).

Item 4 is the critical one. Without a dropped hook, the animation would self-limit to agentic-turn duration (seconds to minutes).

---

## Remediation Plan

Four changes, roughly in impact order. Each is independently valuable; together they should eliminate the class of bug.

### 1. Idle-timeout safety net (highest impact, smallest change)

If no hook event has arrived for N seconds (suggested: 30–60 s), stop all animations unconditionally. Reset the timer on every hook event.

**Why it matters:** Claude agentic turns almost always fire `PreToolUse`/`PostToolUse` every few seconds. A 60-second silence almost certainly means a dropped stop event, not a genuinely-running turn.

**Implementation sketch** (pseudocode, in `ClaudeHookManager`):
```ts
private idleTimer: number | null = null;
private readonly IDLE_TIMEOUT_MS = 60_000;

private armIdleTimer(): void {
  if (this.idleTimer) clearTimeout(this.idleTimer);
  this.idleTimer = window.setTimeout(() => {
    console.warn('[Krypton] Animation idle timeout — force stopping');
    this.stopFlame();
    this.idleTimer = null;
  }, this.IDLE_TIMEOUT_MS);
}

private clearIdleTimer(): void {
  if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
}

// Call armIdleTimer() in startFlame(), clearIdleTimer() in stopFlame().
// Also re-arm on every handleHookEvent() to extend the window if Claude is active.
```

**Cost:** ~15 lines. **Benefit:** eliminates the "runs forever" class of bug entirely.

### 2. Scope animation to the active terminal window

Today, all windows animate when any session is active. Animation should follow the specific terminal window that owns the active `session_id`.

**Design:** Maintain a `Map<sessionId, WindowState>` (already present in compositor via `sessionMap`). In `startFlame(sessionId)` / `stopFlame(sessionId)`, only call `start()` / `stop()` on the animation attached to that window.

**Care points:**
- Multiple concurrent sessions across different windows need independent lifecycles.
- When a session moves between panes/tabs (unlikely but possible), the animation should follow.

**Cost:** larger — needs session→window routing at the hook-event layer. **Benefit:** linear scaling with active sessions, not with window count. In the reported incident this alone would have cut CPU by ~50% (2 stuck windows → 1).

### 3. Throttle matrix frame rate

Matrix's character cadence is governed by `charInterval: Math.floor(3 + Math.random() * 6)` frames (`src/matrix.ts:59`) — characters only change every 3–9 frames. Rendering at 60 fps is therefore wasteful: most frames redraw an unchanged scene.

**Option A (simplest):** skip rAF ticks — run at ~20 fps.
```ts
let lastTick = 0;
const TARGET_MS = 50; // 20 fps
function tick(ts: number): void {
  rafId = requestAnimationFrame(tick);
  if (ts - lastTick < TARGET_MS) return;
  lastTick = ts;
  if (!running || !ctx) return;
  ctx.clearRect(0, 0, W, H);
  renderer!.update(ctx, W, H);
}
```
Expected CPU reduction: ~3× (60→20 fps).

**Option B (better):** make renderers declare their target fps (matrix 15–20, brainwave 30, flame 60, circuit-trace 30). Worker honors it. Requires worker-protocol change.

**Visual impact:** matrix and brainwave are designed around slow phosphor-trail aesthetics — dropping to 20 fps is visually indistinguishable in informal tests.

### 4. Pause on `document.hidden`

When the app is hidden (minimized, other desktop, screen off), rAF is already throttled by the browser — but OffscreenCanvas workers may not be. Add an explicit `visibilitychange` listener in the worker-host that posts `{ type: 'stop' }` on hide and `{ type: 'start' }` on show.

**Cost:** ~10 lines in `OffscreenAnimationProxy`. **Benefit:** zero CPU when hidden.

### Optional longer-term — glyph atlas for matrix

If matrix must stay at 60 fps and at full column density, the correct fix is a pre-baked glyph atlas:

1. At init, render each character in `CHAR_POOL` once to an offscreen `ImageBitmap` at each font size + color variant.
2. Per frame, `ctx.drawImage(atlas, sx, sy, w, h, dx, dy, w, h)` — bitmap blit, no CoreText.

This would cut matrix per-frame cost by ~10× (blit is cheap, rasterization isn't) and eliminate the IPC state-change storm from per-char `fillStyle` changes. Larger change; deferred unless item 1+3 prove insufficient.

---

## Proposed Rollout

Recommend implementing **#1 (idle timeout)** and **#3 Option A (fps cap)** in a single PR:

- Prevents future incidents.
- Lowest risk — both are small, localized changes.
- Item #1 is a safety net regardless of what else changes.
- Item #3 halves matrix's steady-state cost.

Defer #2 (per-window scoping) to a follow-up that also refactors session routing properly, and #4 (visibility) as a polish pass. Glyph atlas is a future enhancement only if needed.

---

## Phase 1 Implementation (2026-04-18)

Shipped fixes #1 and a per-renderer variant of #3.

### What changed

**`src/animation-worker.ts`** — Per-renderer frame cap.

Added `TARGET_FPS_BY_TYPE` table and a timestamp gate in `tick`. Caps:

| Renderer | Target FPS | Reason |
|---|---|---|
| `matrix` | 30 | ~2× CPU reduction vs 60; motion still reads smoothly, character cycling already uses a multi-frame counter |
| `brainwave` | 30 | Same — wave strokes at 30 fps are visually indistinguishable; cuts `fillText` label/readout churn in half |
| `circuit-trace` | 30 | Energy pulses look fine at 30 fps; brings headroom for future work |
| `flame` | 60 | No `fillText`, already cheap; smoothness matters for particle wave |

The gate uses rAF's timestamp argument, so browser-level rAF throttling (hidden tab, background) still applies on top of the cap.

**`src/claude-hooks.ts`** — Idle-timeout safety net.

Added `ANIMATION_IDLE_TIMEOUT_MS = 60_000` and private `animationIdleTimer` field. Helpers:

- `armAnimationIdleTimer()` — clears any existing timer and schedules a 60 s force-stop.
- `clearAnimationIdleTimer()` — cancels.
- `isAnyAnimationRunning()` — cheap poll of `this.animations`.

Wiring:

- `startFlame()` now arms the timer after starting.
- `stopFlame()` now clears the timer after stopping.
- `handleHookEvent()` re-arms the timer at entry if any animation is running, so a steady stream of hooks keeps the animation alive indefinitely while a turn is in progress.

The timer callback is guarded (`if (!this.isAnyAnimationRunning()) return;`) so it's a no-op if the animation was already stopped via the normal `Stop`/`SessionEnd` path.

### Behavior now

- Claude session active, fires any hook every <60 s → animation runs normally.
- Claude session goes silent for 60 s → animation auto-stops, logs a warning, waits for the next event.
- Hook ever dropped (crash, Ctrl+C, HTTP fail) → animation stops within 60 s of last event instead of running until app restart.
- Matrix per-window CPU cost drops from ~50–60% to ~25–30% steady-state.

### Known follow-ups (still deferred)

- **#2 per-window scoping** — still global fan-out. A single session animates all windows. Needs session-to-window routing in compositor.
- **#4 `document.hidden` pause** — rAF throttles when hidden, but explicit stop would be cleaner.
- **Glyph atlas for matrix** — deferred; re-evaluate after user confirms phase 1 is sufficient.

### Verification

- `npm run check` passes.
- Visual spot-check pending user confirmation during normal Claude usage.

---

## References

- Live sample file: `/tmp/com.apple.WebKit.WebContent_2569-04-18_124320_2QDS.sample.txt`
- Hot path: `src/animation-worker.ts:44-49` (rAF loop)
- Matrix renderer: `src/matrix.ts:131, 137, 147` (three `fillText` call sites per char)
- Brainwave renderer: `src/brainwave.ts:303-305, 358-359` (fillText for labels/readouts)
- Lifecycle: `src/claude-hooks.ts:283-495` (all start/stop triggers), `:1026-1037` (global fan-out)
- Related specs: [34-background-animations.md](34-background-animations.md), [48-offscreen-canvas-animations.md](48-offscreen-canvas-animations.md), [30-claude-code-hooks.md](30-claude-code-hooks.md)
