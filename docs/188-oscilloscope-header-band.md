# Oscilloscope Header Band — Implementation Spec

> Status: Implemented
> Date: 2026-07-05
> Milestone: M-chrome — window chrome polish
>
> **Resolved (2026-07-05):** (1) unfocused windows **do** animate (idle-stops when quiet),
> so the band signals background activity. (2) The `chrome.header_accent.style` config toggle
> (`ticks | oscilloscope`, default `oscilloscope`) ships in v1 for reversibility.

## Problem

The strip band below the titlebar (`.krypton-window__header-accent`) is a static
`repeating-linear-gradient` of 1px vertical ticks. It reads as visual noise / a torn edge —
no rhythm, no meaning, and it looks like a rendering glitch. It carries zero information
despite occupying prime chrome real estate directly under the window label.

## Solution

Replace the static tick band on **terminal-hosting windows** with a live **oscilloscope
trace** rendered on a per-window `<canvas>`: a continuous waveform, scrolling right→left,
glowing at the live edge, whose amplitude is driven by the window's real PTY output
throughput (bytes/sec). The band becomes a signal — you *see* the terminal working. It is
GPU-cheap and, critically, its animation loop **stops when the window goes idle**, so idle
CPU stays at 0% per the architecture budget. Under `prefers-reduced-motion` it renders a
single static hairline and never animates.

Chosen over the other candidates (ruler, morse, packets, seismograph, spectrum) because the
user selected it: it is alive and non-repeating (a real graph of output, not a tiled
pattern) while staying the quietest of the "alive" options — a single 1–2px line, not a
field of bars or particles.

## Research

**Prior art in this codebase (decisive):** canvas-in-chrome is already an established
pattern, not a new departure.
- `src/claude-hooks.ts` mounts flame/brainwave/matrix canvases into window content via
  `createAnimationCanvas()`, tracks them in a `Set<BackgroundAnimation>`, disposes them on
  window close through `disposeAnimation(canvas)` (called from `removeWindow`, compositor.ts
  ~3379), and guards against orphaned CPU with an `ANIMATION_IDLE_TIMEOUT_MS` watchdog.
- `src/flame.ts` defines the shared `BackgroundAnimation` interface
  (`getElement / start / stop / resize / dispose / isRunning`). `HeaderScope` will implement
  it so it slots into the same lifecycle conventions.
- The central PTY router (`compositor.ts` ~5556) already resolves each `pty-output` chunk to
  a `windowId` via `sessionMap`; the feed hook drops in there with no new routing.
- Per-lane accent already resolves to `--krypton-window-accent-rgb` on the window element
  (window.css:62–71) — the trace color reads straight from it.

**Constraints discovered:**
- Windows relayout constantly (Grid/Focus). Canvas width must track via `ResizeObserver`;
  DPR-aware sizing required for a crisp 1px line.
- Three header-accent build sites: `createWindow` (terminal, ~1743), content-view window
  (~1914), quick terminal (~4717), plus non-interactive dashboard panels. Only terminal and
  quick-terminal windows get the oscilloscope; content-view windows (agent/vault) keep the
  existing div because `agent.css` / `vault-view.css` restyle the band, and dashboard panels
  stay static.
- `theme.chrome.header_accent.enabled` already gates the band; honor it.

**Alternatives ruled out:**
- *One shared rAF loop for all scopes* (like a global ticker) — rejected; per-window loops
  that self-stop at idle give strictly lower idle cost (a window with no output burns
  nothing) and match the existing per-animation model in claude-hooks.
- *OffscreenCanvas worker* (as heavy animations use) — rejected for v1; a single scrolling
  polyline is trivial main-thread work. Can revisit if profiling shows jank.

## Prior Art

Oscilloscope-in-chrome is essentially **novel** as a decorative element; the closest market
equivalent is per-tab/pane activity indication.

| App | Implementation | Notes |
|-----|---------------|-------|
| tmux | `monitor-activity` sets a `#` activity flag on the window in the status line | Binary flag, not throughput |
| WezTerm | Tab bar shows a dot / can run a Lua status callback | No live signal viz |
| Kitty | Bell/activity marks on tab titles | Binary |
| iTerm2 | Activity/silence indicators per tab; broadcast dots | Binary |
| Warp | Blocks visually delimit output; no continuous meter | Block-structured, not a meter |

**Krypton delta** — no mainstream terminal draws a continuous live throughput waveform in
window chrome. This is a deliberate cyberpunk-aesthetic divergence: instead of a binary
"activity" flag, the band is an analog signal read of the pane's output rate. Keyboard-first
is unaffected (purely visual, no interaction).

## Affected Files

| File | Change |
|------|--------|
| `src/header-scope.ts` | **New.** `HeaderScope` class implementing `BackgroundAnimation`: ring buffer, DPR-aware canvas, rAF with idle-stop, `pump(bytes)`, reduced-motion static fallback, accent-color read. |
| `src/types.ts` | Add `headerScope?: HeaderScope` to `KryptonWindow`. |
| `src/compositor.ts` | Terminal & quick-terminal builders create a `<canvas>` header-accent + `HeaderScope`; `pty-output` handler pumps bytes to the window/QT scope; `removeWindow` + QT close dispose the scope; relayout calls `resize()`. |
| `src/styles/window.css` | `.krypton-window__header-accent--scope` sizing (block canvas, honors height/margin vars); keep static `.krypton-window__header-accent` for the div fallback. |
| `docs/PROGRESS.md`, `docs/04-architecture.md`, `docs/05-data-flow.md` | Document the new chrome canvas + data flow (per `/feature-implementation`). |

## Design

### Data Structures

```ts
// src/header-scope.ts
export class HeaderScope implements BackgroundAnimation {
  constructor(hostWindowEl: HTMLElement);   // reads --krypton-window-accent-rgb from it
  getElement(): HTMLCanvasElement;          // the <canvas class="...header-accent--scope">
  pump(bytes: number): void;                // add energy; (re)start rAF if stopped
  start(): void; stop(): void; resize(): void; dispose(): void; isRunning(): boolean;
  refreshColor(): void;                     // re-read accent (theme-changed / lane accent)
}
```

Internals: `Float32Array` ring buffer of signed samples (length ≈ cssWidth/2); `energy`
(0..1) decayed each frame by `DECAY≈0.9`; `raf` handle; a `ResizeObserver`; a
`matchMedia('(prefers-reduced-motion: reduce)')` listener.

### Data Flow

```
1. Backend PTY reader emits `pty-output` [sid, bytes].
2. compositor `pty-output` handler resolves sid → windowId via sessionMap (existing).
3. NEW: win.headerScope?.pump(bytes.length)  (QT branch: qtHeaderScope?.pump(...)).
4. pump() bumps energy = min(1, energy + len/SCALE) and starts rAF if it was stopped.
5. Each frame: energy *= DECAY; push one signed sample (energy × smooth-noise) into the
   ring buffer; clear canvas; stroke the buffer as a polyline (glow on the live edge).
6. When energy < ε AND max|buffer| < ε: draw one flat frame, cancelAnimationFrame, STOP.
   → an idle window's scope consumes 0 CPU.
```

### UI Changes

- Terminal / quick-terminal header-accent element becomes
  `<canvas class="krypton-window__header-accent krypton-window__header-accent--scope">`.
- CSS: `--scope { display:block; width:calc(100% - 2×margin); height:var(--krypton-header-accent-height); }`
  (canvas is DPR-scaled internally). The base `.krypton-window__header-accent` div rule is
  retained unchanged for content-view/dashboard.
- Trace color: `rgba(var(--krypton-window-accent-rgb), α)` with α rising with energy; live
  edge gets `shadowBlur` glow. Focused vs unfocused can differ in base alpha (reuse
  `--krypton-focused-header-accent` intent) — minor, optional.
- Reduced-motion: a single static faint hairline (ghost-hairline look), no rAF.

### Configuration

Reuse existing `theme.chrome.header_accent.enabled` (disabled → no canvas, no scope).
**Proposed (see Open Questions):** add `chrome.header_accent.style = "ticks" | "oscilloscope"`
(default `"oscilloscope"`) so users can revert to the static band without a rebuild. Requires
a field in `src-tauri/src/config.rs` + `theme.ts` `ChromeHeaderAccent`.

## Edge Cases

- **Idle window** → rAF stopped, 0 CPU (core requirement).
- **Many streaming background windows** → each self-throttles; a truly idle one costs
  nothing. Watchdog (mirroring claude-hooks `ANIMATION_IDLE_TIMEOUT_MS`) force-stops any
  scope stuck running with no pumps, as a safety net.
- **Window resize / relayout** → `ResizeObserver` re-sizes canvas; buffer is re-mapped, not
  cleared, to avoid a visual pop.
- **Theme / lane-accent change** → `refreshColor()` on `theme-changed`.
- **Window close / QT close** → `dispose()` cancels rAF + disconnects observer (no leak).
- **`prefers-reduced-motion`** → static hairline; live toggle honored via media listener.
- **Multi-pane window** → all panes' output pump the single window-level band (aggregate
  throughput), which is the intended "window is busy" read.
- **`header_accent.enabled = false`** → element and scope are not created.

## Open Questions

1. **Do unfocused windows animate?** Proposed: **yes** — any window receiving output
   animates (and idle-stops otherwise), making the band a background-activity indicator.
   Alternative: only the focused window's scope runs (lowest cost, but loses the "which
   background pane is busy" signal). *Needs the user's call — this is the main behavioral
   fork.*
2. **Config `style` toggle now or later?** Adds Rust `config.rs` + `theme.ts` plumbing. Could
   ship v1 as always-oscilloscope (with reduced-motion fallback) and add the toggle in a
   follow-up. Proposed: include the toggle for reversibility.

## Out of Scope

- Content-view windows (agent/vault) and dashboard panels — they keep the static band.
  _(Superseded: agent/ACP/harness windows gained the band from streamed model output in
  [189-oscilloscope-harness-band.md](189-oscilloscope-harness-band.md). Vault + dashboard still static.)_
- Feeding the band from non-PTY signals (agent tokens, OSC 9;4 progress, audio) — future.
  _(Agent/ACP tokens now feed it via spec 189; OSC progress + audio remain future.)_
- OffscreenCanvas/worker offload — only if profiling demands it.
- Any new keybinding (purely visual feature).

## Resources

- Internal: `src/claude-hooks.ts` (canvas lifecycle, idle watchdog), `src/flame.ts`
  (`BackgroundAnimation` interface), `src/brainwave.ts` (waveform rendering reference),
  `src/compositor.ts` (`pty-output` router, window builders, `removeWindow`).
- [MDN: Canvas API / devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio) — DPR-aware crisp-line sizing.
- [MDN: ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver) — react to window relayout.
- [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) — accessibility fallback.
