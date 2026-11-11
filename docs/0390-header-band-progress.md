# Header Band Progress — Implementation Spec

> Status: Implemented
> Date: 2026-11-11
> Milestone: Window chrome — progress presentation (amends [0018](./0018-progress-bar.md), [0364](./0364-progress-gauge-hide-working.md))

## Problem

A terminal program that reports OSC 9;4 progress gets a large ring drawn behind its text, in the
middle of the window. The header band, the 6px well under the titlebar, shows no information: it
is a flat accent tint. A thin bar in the chrome would show progress without covering terminal
text. Separately, the progress display does not follow tab switches or pane focus: it keeps the
previous pane's state until the next OSC 9;4 arrives, although spec 0018 (edge cases 7–8) says
it should follow the active tab's focused pane.

## Solution

The header band becomes a horizontal gauge while the displayed pane reports progress. The fill
grows from the left to the percentage, in the window accent, the warning colour when paused or
the danger colour on error. When no progress is reported, the band returns to its idle tint.
A new `[visual] progress_display` key picks `band` (default), `ring` or `both`. The compositor
toggles one class on `<html>` per hidden display, as spec 364 does, so Reload Config applies it
without re-rendering. The compositor's existing per-window chrome sync also re-renders progress,
so tab switches and pane focus changes show the right pane's state.

## Research

- `ProgressGauge` (`src/progress-gauge.ts`) keeps per-session state and renders one ring per
  window into `.krypton-window__content` (or the Quick Terminal's `__body`). It also lights the
  titlebar LED (`krypton-window__titlebar--progress*`). It renders only when a `pty-progress`
  event arrives (`compositor.ts` listener near line 8822). No other path calls it, which causes
  the tab-switch gap.
- `buildHeaderAccent` (`compositor.ts:2313`) appends the band to `.krypton-window__chrome` for
  terminal windows, content windows and the Quick Terminal. Content windows (harness, views)
  have no PTY, so their band never receives progress.
- `syncWindowChrome(win)` (`compositor.ts:1754`) already re-derives the chrome "that follows
  this window's active tab's focused pane". `showActiveTab` and `updatePaneFocusIndicator`
  call it, so it is the single hook for tab switches and pane focus changes.
- Completion and error dismissal use `setTimeout` chains that are never cancelled. A new
  progress run that starts inside the 2.3 s completion fade is removed by the old timer. The
  stored state also stays at `{Normal, 100}` after the fade, so a refresh would replay the flash.
  Both must be fixed once the display can be refreshed.
- Spec 188 was removed because its canvas redrew every frame and WebKit repainted the gradient
  chrome under it. The band fill must therefore animate with `transform` on its own
  compositing layer (`will-change: transform`), so a fill change does not repaint the plate.
- DESIGN.md "Gauges and progress": a gauge is a well track with a flat fill in the state colour
  and a 1px inset top highlight, with no glow and no sweep. Indeterminate work is a steady lit
  lamp. The band already is a well, so it follows this rule exactly. Motion forbids infinite
  animation, so an indeterminate state cannot bounce the way Ghostty's and par-term's do.
- Alternatives ruled out: a `clip-path` or `width` fill (paints every transition frame); a
  second pseudo-element layer on the band (memory: no stacked pseudo layers); making the band
  the only display (the user chose a config switch).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Ghostty 1.2 | Native thin bar along the top of each split (GTK: system accent colour) | States: in progress, error, indeterminate, paused. ~15 s hard-coded timeout clears stale progress |
| par-term | Thin overlay bar, `progress_bar_position = top/bottom`, `height = 4`, per-state colours | Indeterminate is a grey bar that oscillates |
| Windows Terminal | Ring in the tab header + taskbar progress | State 4 documented as warning/paused |
| iTerm2 3.6.6+ | OSC 9;4 progress; collides with OSC 9 notifications | |
| Contour | Bar under the tab label, status-line placeholder, Dock | `progress_timeout` |

**Krypton delta:** matches Ghostty/par-term (thin top bar, per-state colour). The bar sits in a
chrome well instead of over the terminal cells, so it never covers text. Indeterminate is a
steady half-lit full band, not an oscillation (DESIGN.md Motion). A config switch keeps the
ring for anyone who wants it.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/config.rs` | `ProgressDisplay { Band, Ring, Both }` (lowercase serde, default `Band`); `VisualConfig.progress_display`; parse test |
| `src/config.ts` | `VisualConfig.progress_display: 'band' \| 'ring' \| 'both'` |
| `src/compositor.ts` | `applyConfig` toggles `krypton-no-progress-ring` / `krypton-no-progress-band` on `<html>`; host returns the displayed session id; `syncWindowChrome` calls `progressGauge.refreshWindow(win.id)` |
| `src/progress-gauge.ts` | Render the band beside the ring; `refreshWindow`; dedupe; one cancellable dismiss timer per window; dismissal drops the stored one-shot state |
| `src/progress-gauge.test.ts` | New: band states, dedupe, timer cancel, refresh, no replay after dismissal |
| `src/styles/window.css` | Band gets `position: relative; overflow: hidden` to hold the fill |
| `src/styles/progress.css` | Band progress rules; ring and band hide classes |
| `DESIGN.md` | Gauges and progress, Motion (band paragraph), version 2.4.0 changelog |
| `docs/0006-configuration.md` | `[visual] progress_display` example and table row; `progress_gauge_working` row says ring only |
| `docs/0018-progress-bar.md`, `docs/0364-progress-gauge-hide-working.md` | Header note: amended by 0390 |
| `docs/0004-architecture.md` (item 14), `docs/0005-data-flow.md` (step 10), `docs/0346-osc-support.md` (`9;4` row), `docs/README.md` | Describe band + ring + switch; index row 390 |

## Design

### Data Structures

```rust
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProgressDisplay { #[default] Band, Ring, Both }
// VisualConfig: pub progress_display: ProgressDisplay,
```

```typescript
export interface ProgressGaugeHost {
  getWindowElement(windowId: WindowId): HTMLElement | null;
  getQuickTerminalElement(): HTMLElement | null;
  /** Session of the active tab's focused pane (replaces getWindowDisplayProgress). */
  getWindowDisplaySession(windowId: WindowId): SessionId | null;
}

class ProgressGauge {
  refreshWindow(windowId: WindowId): void;          // re-render from stored state
  private lastRendered: WeakMap<HTMLElement, string>; // `${state}:${progress}` or 'none'
  private dismissTimers: WeakMap<HTMLElement, number>;
}
```

### Data Flow

```
1. Program writes ESC ] 9 ; 4 ; 1 ; 40 ST
2. pty.rs → pty-progress {session_id, state 1, progress 40} (unchanged)
3. ProgressGauge stores the session's state, resolves the window's displayed session
4. render(winEl): key "1:40" equals lastRendered → stop. Otherwise cancel the window's
   dismiss timer, update ring (existing) and band, light the titlebar LED
5. Band: add --progress, set fill transform scaleX(0.40); CSS transitions 300 ms on the
   compositor
6. User switches tab → showActiveTab → syncWindowChrome → refreshWindow → render the new
   pane's state, or idle when it has none
7. 100 % → 600 ms flash; the 1.5 s fade starts at 800 ms (today's ring timings). Then drop
   the stored {Normal,100} (only if that session still holds the same object) and render idle
```

### UI Changes

```html
<div class="krypton-window__header-accent krypton-window__header-accent--progress">
  <div class="krypton-window__header-progress" style="transform: scaleX(0.4)"></div>
</div>
```

The fill is created on the first progress state and removed when the band returns to idle.

| State | Band modifier | Fill |
|-------|---------------|------|
| none | — | none; idle flat tint (unchanged) |
| 1 normal | `--progress` | accent, alpha 0.9, `scaleX(p/100)` |
| 1 at 100 | `--progress --flare`, then `--fade-out` | full; one-shot flash, then 1.5 s opacity fade |
| 2 error | `--progress --error` | danger, `scaleX(p/100)`, or full when p = 0; dismissed after 3 s + 1.5 s fade |
| 3 busy | `--progress --busy` | accent, alpha 0.5, full width, steady |
| 4 paused | `--progress --paused` | warning, alpha 0.9, `scaleX(p/100)` |

- While `--progress` is set, the track drops from the idle tint (0.35) to an unlit 0.12 of
  `--x-rgb` over `--mat-well-fill`, so the fill reads against it. When `--fade-out` starts the
  track is back at the idle tint, so the fill fades into the resting band.
- Fill: `position: absolute; inset: 0; transform-origin: left; will-change: transform;`
  `box-shadow: inset 0 1px 0 var(--mat-bevel-hi)` (the footer music gauge's highlight); no glow.
  The completion flash is a one-shot `filter: brightness()` keyframe (600 ms), not a glow. The band's own radius and `overflow:
  hidden` round the left end; the leading edge is square.
- `--x-rgb` follows `--krypton-window-accent-rgb`, so lane accents, palette picks and
  `data-signal` tints recolour the fill.
- `prefers-reduced-motion`: no transform transition, no flash.
- Band rules are written under `html:not(.krypton-no-progress-band)`. Under
  `.krypton-no-progress-ring` the ring is `display: none`. The titlebar LED shows in every mode.

### Configuration

```toml
[visual]
progress_display = "band"   # Where OSC 9;4 progress shows: "band" (header band under the
                            # titlebar), "ring" (centre ring behind the text), or "both".
                            # Reload Config applies it. Default: "band"
```

`progress_gauge_working = false` still hides only the busy ring. The band shows busy in any mode
that includes it.

## Edge Cases

1. **Tab switch / pane focus:** `syncWindowChrome` → `refreshWindow`; a pending flash/fade
   timer is cancelled and the newly shown pane's state (or idle) is rendered.
2. **New run inside a completion fade:** the new render cancels the old timer; the new state shows.
3. **Repeated identical updates:** same key, no DOM write.
4. **Switch back to a finished pane:** its `{Normal,100}` was dropped at dismissal, so no replay.
5. **Pane or session exits:** `clearSession` as today; closing the pane moves focus, which runs
   `syncWindowChrome`.
6. **Quick Terminal:** its band and ring follow `qtProgress`; it has no tabs.
7. **Content/harness windows:** no PTY session, so their band stays idle.
8. **Reload Config:** class toggles show or hide the current state at once.
9. **Invalid value** (e.g. `"bar"`): parsing fails and the whole config falls back to defaults
   with a logged error. Every enum key behaves this way (`hints.file_action`).
10. **Default change:** the ring no longer shows by default; `progress_display = "ring"` restores it.

## Out of Scope

- A percentage or label readout on the band or titlebar.
- Expiring stale progress (Ghostty's 15 s timeout, Contour's `progress_timeout`).
- Tab-label or Dock progress; Rust parser changes; any indeterminate animation.

## Resources

- [Ghostty — ConEmu extensions (OSC 9;n)](https://ghostty.org/docs/vt/osc/conemu) — bar on top of each split, state semantics, 15 s timeout.
- [Ghostty 1.2.0 release notes](https://ghostty.org/docs/install/release-notes/1-2-0) — native thin progress bar at the top of the terminal.
- [par-term PROGRESS_BARS.md](https://docs.rs/crate/par-term/0.40.0/source/docs/features/PROGRESS_BARS.md) — top/bottom thin bar, 4px height, per-state colours, oscillating indeterminate.
- [Windows Terminal — progress bar sequences](https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences) — tab ring and taskbar; state 4 as warning.
- [iTerm2 3.6 escape codes](https://iterm2.com/3.6/documentation-escape-codes.html) — OSC 9;4 support and the OSC 9 notification collision.
