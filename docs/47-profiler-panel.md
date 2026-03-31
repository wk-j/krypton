# Profiler HUD — Implementation Spec

> Status: Implemented
> Date: 2026-03-31
> Milestone: M8 — Polish

## Problem

There is no way to observe Krypton's runtime performance from within the app. Diagnosing slowness (e.g., agent API latency, IPC overhead, layout jank) requires external tools like Chrome DevTools or Instruments. A built-in profiler would give immediate, always-available visibility into where time and resources are spent.

## Solution

Add a **Profiler HUD** — a persistent, semi-transparent floating overlay docked to the right edge of the screen. Unlike dashboards (which are fullscreen and modal), the HUD stays visible while you work in your terminals. It does not steal focus or block keyboard input — the terminal remains fully interactive underneath. Toggle it on/off with a keyboard shortcut.

Data is gathered by instrumenting the IPC layer, PTY event stream, compositor layout, and agent lifecycle — all frontend-side. The HUD renders a compact text-based display updated every second.

## Affected Files

| File | Change |
|------|--------|
| `src/profiler/profiler-hud.ts` | **New** — HUD overlay: DOM construction, render loop, show/hide |
| `src/profiler/metrics.ts` | **New** — singleton metrics collector and data store |
| `src/profiler/ipc.ts` | **New** — instrumented `invoke()` wrapper |
| `src/styles/profiler.css` | **New** — HUD styling |
| `src/compositor.ts` | Add `toggleProfilerHud()` method, wire into layout gap |
| `src/input-router.ts` | Add `Shift+P` binding in Compositor mode |
| `src/index.html` | Import `profiler.css` |
| ~15 files importing `invoke` | Change import path from `@tauri-apps/api/core` to `../profiler/ipc` |

## Design

### HUD Overlay Architecture

The profiler HUD is a **non-modal, non-focusable overlay** appended to `document.body` with `pointer-events: none`. It floats above the workspace but does not participate in the compositor's window/pane system at all. It has no interaction with the DashboardManager (which is modal/fullscreen).

```
document.body
├── #workspace (compositor windows, terminals)
├── .krypton-quick-terminal (Quick Terminal overlay)
├── .krypton-dashboard (modal dashboard overlays)
└── .krypton-profiler-hud  ← NEW: always-on-top, pointer-events: none
```

Key properties:
- `position: fixed; top: 0; right: 0; z-index: 10000`
- `pointer-events: none` — clicks pass through to terminals underneath
- `opacity: 0.85` — semi-transparent so workspace is visible behind it
- Does not receive focus — keyboard input always goes to the active terminal/pane
- Width: `320px`, height: auto (content-driven)

### Data Structures

```typescript
// src/profiler/metrics.ts

interface IpcRecord {
  command: string;
  startTime: number;   // performance.now()
  duration: number;     // ms
  error: boolean;
}

interface IpcAggregated {
  count: number;
  totalMs: number;
  maxMs: number;
  avgMs: number;
  errorCount: number;
}

interface PtyThroughput {
  sessionId: number;
  bytesPerSecond: number;
  totalBytes: number;
}

interface AgentTiming {
  promptText: string;       // first 40 chars
  startTime: number;
  timeToFirstToken: number | null;  // ms
  totalDuration: number | null;     // ms
  outputTokens: number;
}

interface ProfilerSnapshot {
  timestamp: number;
  fps: number;
  heap: { usedMB: number; totalMB: number } | null;
  domNodes: number;
  ipc: {
    recent: IpcRecord[];
    aggregated: Map<string, IpcAggregated>;
  };
  pty: PtyThroughput[];
  agent: AgentTiming | null;
  layoutMs: number;
}
```

### Metrics Collector (`src/profiler/metrics.ts`)

A singleton `MetricsCollector` class. Collects data **from app startup** regardless of whether the HUD is visible — so when you open it, historical data is already there.

- **FPS**: `requestAnimationFrame` loop runs only while HUD is visible. Computes rolling average over last 60 frames.
- **IPC**: Instrumented `invoke()` pushes `IpcRecord`s into a ring buffer (max 200). Running counters per command for aggregated stats.
- **PTY throughput**: Counts bytes from `pty-output` events per session. Bytes-per-second computed as a 3-second rolling average.
- **Agent timing**: Exposes `agentPromptStart()` / `agentFirstToken()` / `agentPromptEnd(tokens)` called from the agent controller.
- **Layout**: Exposes `layoutStart()` / `layoutEnd()` called from compositor around layout passes.
- **DOM nodes**: `document.querySelectorAll('*').length` — sampled once per render tick (1s).
- **Heap**: `(performance as any).memory?.usedJSHeapSize` — null if unavailable in WKWebView.

```typescript
export const collector = new MetricsCollector();
```

### IPC Instrumented Wrapper (`src/profiler/ipc.ts`)

```typescript
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { collector } from './metrics';

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await tauriInvoke<T>(cmd, args);
    collector.recordIpc(cmd, performance.now() - t0, false);
    return result;
  } catch (e) {
    collector.recordIpc(cmd, performance.now() - t0, true);
    throw e;
  }
}
```

All files currently importing `invoke` from `@tauri-apps/api/core` switch to `./profiler/ipc` (or a re-export at `src/ipc.ts` to keep import paths short).

### Profiler HUD (`src/profiler/profiler-hud.ts`)

```typescript
export class ProfilerHud {
  private element: HTMLElement;
  private visible = false;
  private renderInterval: number | null = null;
  private rafId: number | null = null;

  constructor() { /* build DOM, append to body, hidden by default */ }
  show(): void   { /* set visible, start rAF + 1s render interval */ }
  hide(): void   { /* stop rAF + interval, hide element */ }
  toggle(): void { this.visible ? this.hide() : this.show(); }
  private render(snapshot: ProfilerSnapshot): void { /* update DOM text */ }
}
```

### Data Flow

```
1. App startup: MetricsCollector singleton created, IPC wrapper active
2. User presses Cmd+P → Shift+P
3. InputRouter calls compositor.toggleProfilerHud()
4. Compositor calls profilerHud.toggle()
5. HUD becomes visible, starts rAF loop + 1s render interval
6. Every second:
   a. HUD calls collector.getSnapshot()
   b. Renders snapshot into DOM (textContent updates, no innerHTML)
7. Meanwhile, all invoke() calls and PTY events feed data to collector
8. User presses Cmd+P → Shift+P again → HUD hides, loops stop
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Shift+P` | Compositor mode | Toggle profiler HUD on/off |

### UI Layout

Compact monospace text, docked top-right. Themed with `--krypton-*` CSS custom properties.

```
┌─ PROFILER ──────────────────┐
│                              │
│  FPS  60  Heap 42/128MB     │
│  DOM  847                    │
│                              │
│  IPC (30s)        total 1247 │
│  write_to_pty ×1102 avg 0.3  │
│  resize_pty    ×24  avg 1.1  │
│  get_pty_cwd   ×12  avg 2.1  │
│  get_env_var    ×1  avg 182  │
│                              │
│  PTY                         │
│  #1  24.3 KB/s   1.2 MB     │
│  #2   0.1 KB/s    48 KB     │
│                              │
│  Agent                       │
│  "explain the comp…"  8.2s   │
│  TTFT 1.2s  847tok  104t/s   │
│                              │
│  Layout  0.4ms               │
└──────────────────────────────┘
```

Width: `320px`. Height: auto. Position: fixed top-right with `8px` margin.

### CSS (`src/styles/profiler.css`)

```css
.krypton-profiler-hud {
  position: fixed;
  top: 8px;
  right: 8px;
  width: 320px;
  z-index: 10000;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s ease;
  font-family: var(--krypton-font-family, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--krypton-foreground);
  background: var(--krypton-background);
  border: 1px solid var(--krypton-border);
  border-radius: 4px;
  padding: 8px 12px;
  overflow: hidden;
}

.krypton-profiler-hud--visible {
  opacity: 0.85;
}

.krypton-profiler-hud__title {
  color: var(--krypton-accent);
  font-weight: bold;
  margin-bottom: 4px;
}

.krypton-profiler-hud__section {
  margin-top: 6px;
  color: var(--krypton-dim);
}

.krypton-profiler-hud__row {
  white-space: pre;
}

.krypton-profiler-hud__highlight {
  color: var(--krypton-accent);
}

.krypton-profiler-hud__warn {
  color: var(--krypton-yellow, #f0c674);
}

.krypton-profiler-hud__error {
  color: var(--krypton-red, #cc6666);
}
```

### Integration with Compositor

The compositor owns the `ProfilerHud` instance (lazy-created on first toggle):

```typescript
// In Compositor class
private profilerHud: ProfilerHud | null = null;

async toggleProfilerHud(): Promise<void> {
  if (!this.profilerHud) {
    const { ProfilerHud } = await import('./profiler/profiler-hud');
    this.profilerHud = new ProfilerHud();
  }
  this.profilerHud.toggle();
}
```

No changes to layout algorithms — the HUD is `position: fixed` and does not affect compositor window bounds.

### Configuration

None. The profiler is a development/diagnostic tool with no user-configurable options.

## Edge Cases

- **Heap API unavailable**: WKWebView may not expose `performance.memory`. Show `Heap n/a`.
- **No active PTY sessions**: Show `PTY  (none)`.
- **No agent prompt yet**: Show `Agent  (none)`.
- **HUD overlaps window content**: Acceptable since it's semi-transparent and `pointer-events: none`. User can toggle off if needed.
- **High-frequency IPC (write_to_pty)**: Ring buffer caps at 200. Aggregated stats use running counters, always accurate.
- **Performance of the profiler itself**: DOM updates use `textContent` (no innerHTML parsing). rAF loop is trivial (frame time delta). 1s render interval keeps CPU cost negligible.

## Out of Scope

- Rust backend profiling (use `tracing` crate or Instruments separately)
- Persistent profiling data / export to file
- Graphs, sparklines, or charts (text-only for v1)
- Interactive elements (the HUD is read-only, `pointer-events: none`)
- CPU profiling of JS (use DevTools Performance tab)
- Docking to different edges or resizing
