# Hide the Working Progress Ring — Implementation Spec

> Status: Implemented
> Date: 2026-11-06
> Milestone: Window chrome — progress presentation (amends [0018](./0018-progress-bar.md))
> Amended by: [0390](./0390-header-band-progress.md) — the ring is no longer the default display (`[visual] progress_display`). This key still applies only to the ring; the header band shows busy regardless

## Problem

A program that reports OSC 9;4 state `3` (busy, no known completion) draws a large ring labelled `working` in the centre of its window, behind the text, for as long as it runs. Agents such as omp emit it for every turn, so the ring sits over the transcript most of the time. Krypton has no setting to suppress it. Hiding all progress would also lose the useful states: a real percentage, an error or a pause.

## Solution

Add `[visual] progress_gauge_working` (bool, default `true`). With `false` the centred ring is not shown while the displayed state is indeterminate. Normal, error and paused rings, the completion flare, and the titlebar sweep are unchanged. Like `window_border`, the compositor toggles one class on `<html>` and a CSS rule hides the ring. Reload Config applies it without a restart, and no progress state changes.

## Research

- `ProgressGauge.updateProgressGauge` (`src/progress-gauge.ts:102-219`) puts `krypton-progress-gauge--indeterminate` on the ring for state `3` and nothing else. It strips every state modifier on each update, so the class always matches the state being shown (the active tab's focused pane).
- `window_border` is the precedent (`src/compositor.ts:831-836`, `src/styles/window.css:93-104`): a class toggle on `document.documentElement` survives theme re-application and hot reload.
- `display: none` stops the ring's `infinite` orbit animation (`progress.css:117-120`) from running, so a hidden ring costs no frames.
- `pty-progress` also feeds `view:progress` on the ViewBus (`src/pty-bridge.ts:137`). A CSS-only hide leaves that signal untouched.
- Alternatives ruled out: dropping state `3` in the Rust parser would also drop it for every other consumer. Skipping DOM creation in `ProgressGauge` would mean re-rendering on hot reload. A theme `[tokens]` hook would need a full custom theme file just to hide one element.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Ghostty | `progress-style = false` ignores OSC 9;4 entirely | All or nothing; no per-state switch |
| Contour | Bar under the tab label, `{Progress}` status-line placeholder, Dock/taskbar; `progress_timeout` expires silent apps | Busy pulses; no per-state hide |
| Windows Terminal | Taskbar and tab progress ring | No per-state switch |
| omp | `terminal.showProgress` decides whether it emits state `3` at all | Fixes one emitter, not the terminal |

**Krypton delta:** the switch is per state, so busy can be silenced while percentages, errors and pauses keep their ring. Ghostty's switch is all-or-nothing.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/config.rs` | `VisualConfig.progress_gauge_working: bool`, default `true` |
| `src/config.ts` | `VisualConfig.progress_gauge_working: boolean` |
| `src/compositor.ts` | In `applyConfig`'s `[visual]` block, toggle `krypton-no-working-gauge` on `<html>` when the key is `false` |
| `src/styles/progress.css` | `.krypton-no-working-gauge .krypton-progress-gauge--indeterminate { display: none; }` |
| `docs/0006-configuration.md` | `[visual]` example line and reference-table row |
| `docs/0018-progress-bar.md` | Header note: amended by 0364 |
| `docs/README.md` | Index row 364 |

## Design

### Configuration

```toml
[visual]
progress_gauge_working = false   # Hide the centre ring while a program reports busy
                                 # (OSC 9;4 state 3). Percent, error and paused rings
                                 # and the titlebar sweep still show. Default: true
```

The compositor checks `=== false`, so a missing field behaves as `true`.

### Data Flow

```
1. Program writes ESC ] 9 ; 4 ; 3 ST
2. pty.rs → pty-progress → ProgressGauge.updateProgressGauge → ring gets --indeterminate
3. <html>.krypton-no-working-gauge present → ring is display:none; titlebar sweep still runs
4. Program writes ESC ] 9 ; 4 ; 1 ; 40 ST → --indeterminate removed → ring shows 40%
```

## Edge Cases

1. **Busy → percent:** the ring appears at once, without a fade-in. It was already `--visible` while hidden.
2. **Percent → busy:** the ring disappears at once.
3. **Hot reload while busy:** the class toggles, and the ring hides or shows immediately with the current state.
4. **Tabs:** the ring follows the active tab's focused pane, so switching to a tab with a percentage shows its ring.
5. **Quick Terminal:** its ring carries the same class and is hidden the same way.

## Out of Scope

- Hiding the titlebar sweep, or the ring for normal, error or paused states.
- A list-valued per-state setting.
- Expiring stale progress (Contour's `progress_timeout`).

## Resources

- [Ghostty `Config.zig` — `progress-style`](https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig): an all-or-nothing OSC 9;4 switch, the closest equivalent.
- [Contour — Progress indicator (OSC 9;4)](https://contour-terminal.org/vt-extensions/osc-9-4-progress/): state semantics (3 = busy, percentage unchanged) and where other terminals show it.
- [Ghostty — ConEmu extensions (OSC 9;n)](https://ghostty.org/docs/vt/osc/conemu): the grammar Krypton already parses.
