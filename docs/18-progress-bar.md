# Progress Bar — Implementation Spec

> Status: Implemented
> Date: 2026-03-13
> Milestone: M8 — Polish

## Problem

Terminal programs (Zig CLI, systemd, Amp, custom scripts) use the ConEmu `OSC 9;4` escape sequence to report progress state. Modern terminals like Ghostty, Windows Terminal, and ConEmu render this as a native GUI progress bar. Krypton currently has no OSC parsing and no progress visualization, making it miss this increasingly adopted feature.

## Solution

Parse the `OSC 9;4` sequence from raw PTY output in the Rust backend, emit a typed Tauri event to the frontend, and visualize progress by transforming the existing window chrome elements — no new UI clutter. The status dot morphs into a tiny radial arc gauge showing percentage, and a subtle scanline sweep moves across the titlebar background. Supports five states: hidden, normal (with percentage), error, indeterminate (orbiting arc), and paused. Each pane tracks its own independent progress state.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/pty.rs` | Add OSC 9;4 parser in PTY reader thread; emit `pty-progress` event |
| `src-tauri/src/lib.rs` | No change needed (event emitted directly, no new command) |
| `src/compositor.ts` | Listen for `pty-progress` event; inject/update/remove SVG arc gauge on status dot, toggle titlebar scanline sweep class |
| `src/types.ts` | Add `ProgressState` enum and `ProgressEvent` interface |
| `src/styles.css` | Add `.krypton-progress-arc*` SVG styles, `.krypton-window__titlebar--progress` scanline sweep, `@keyframes` for orbit/flare/sweep |

## Design

### Data Structures

**Rust (pty.rs) — parser state (internal, not emitted):**

```rust
/// Tracks OSC parse state inside the PTY reader loop
enum OscParseState {
    Normal,
    Esc,          // saw 0x1B
    OscStart,     // saw 0x1B ]
    Osc9,         // saw "9"
    Osc9Semi,     // saw "9;"
    Osc94,        // saw "9;4"
    Osc94Semi,    // saw "9;4;"
    CollectArgs,  // collecting st;pr until ST
}
```

**Tauri event payload:**

```rust
#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    session_id: u32,
    state: u8,      // 0=remove, 1=normal, 2=error, 3=indeterminate, 4=paused
    progress: u8,   // 0-100, meaningful for state 1/2/4
}
```

**TypeScript (types.ts):**

```typescript
enum ProgressState {
  Hidden = 0,
  Normal = 1,
  Error = 2,
  Indeterminate = 3,
  Paused = 4,
}

interface ProgressEvent {
  session_id: number;
  state: ProgressState;
  progress: number;  // 0-100
}
```

### API / Commands

No new Tauri commands. This uses the event system (backend push):

| Event | Payload | Direction |
|-------|---------|-----------|
| `pty-progress` | `ProgressPayload` | Backend -> Frontend |

### Data Flow

```
1. Shell program writes OSC 9;4;1;75 ST (set progress to 75%)
2. PTY master fd delivers bytes to reader thread
3. Reader thread's inline scanner detects ESC ] 9 ; 4 ; <st> ; <pr> (BEL or ESC\)
4. Scanner extracts state=1, progress=75, emits app_handle.emit("pty-progress", payload)
5. Raw bytes (including the OSC sequence) are still forwarded via pty-output as usual
   (xterm.js will silently ignore unrecognized OSC sequences)
6. Frontend pty-progress listener looks up session_id in sessionMap -> finds window
7. If state=0 (Hidden): remove SVG arc from status dot, remove titlebar--progress class
8. If state>0: inject/update SVG arc gauge on status dot, set stroke-dasharray for fill %
9. Add krypton-window__titlebar--progress class to activate scanline sweep
10. Apply state-specific CSS modifiers (--normal/--error/--indeterminate/--paused)
```

### Sequence Format

Per the ConEmu spec, `OSC 9;4` has this grammar:

```
ESC ] 9 ; 4 ; <state> [; <progress>] ST
```

Where:
- `<state>`: single digit 0-4
  - `0` — remove progress (hide bar)
  - `1` — set progress value (0-100)
  - `2` — error state (red), progress optional
  - `3` — indeterminate (pulsing), no progress value
  - `4` — paused state (yellow), progress optional
- `<progress>`: optional integer 0-100 (defaults to 0 if absent)
- `ST` (String Terminator): either `BEL` (0x07) or `ESC \` (0x1B 0x5C)

### Parser Design

The parser is a lightweight inline state machine that runs inside the existing PTY reader loop. It does **not** buffer or strip the OSC bytes from the stream — it merely detects the pattern and emits an event. This means:

- Zero impact on normal throughput (just a state check per byte)
- xterm.js still receives all bytes (it ignores unknown OSCs gracefully)
- No need for a full VT parser crate

The parser resets to `Normal` state on any unexpected byte, ensuring malformed sequences don't cause issues.

### UI Changes

No new floating bars or overlays. Progress is expressed through two existing chrome elements:

#### 1. Status Dot → Radial Arc Gauge

The existing `.krypton-window__status-dot` (a 6px square) is wrapped in an SVG-backed radial gauge when progress is active. The dot itself remains at center; a circular arc stroke is drawn around it showing fill percentage.

**DOM structure** (injected around existing dot):

```html
<div class="krypton-window__status-dot">
  <!-- existing dot stays as-is (CSS background) -->
  <svg class="krypton-progress-arc" viewBox="0 0 20 20">
    <!-- background track (subtle ring) -->
    <circle cx="10" cy="10" r="8" class="krypton-progress-arc__track" />
    <!-- progress arc (conic stroke-dasharray) -->
    <circle cx="10" cy="10" r="8" class="krypton-progress-arc__fill"
            stroke-dasharray="<filled> <remainder>"
            transform="rotate(-90 10 10)" />
  </svg>
</div>
```

The SVG is `position: absolute; inset: -7px` so it extends beyond the dot, creating an ~20px diameter gauge centered on the 6px dot. `pointer-events: none`.

**States:**
- **Normal (1)**: Arc fills clockwise from 12 o'clock, 0-100%. Accent color with glow filter.
- **Error (2)**: Full arc in error color, dot pulses red.
- **Indeterminate (3)**: A ~25% arc segment orbits continuously around the dot (`@keyframes krypton-arc-orbit`). Feels like a HUD scanning animation.
- **Paused (4)**: Arc frozen at current fill, paused color (amber). Dot dims slightly.
- **Hidden (0)**: SVG removed, dot returns to normal.

**Completion flash**: When progress hits 100%, the arc briefly flares (scale + opacity pulse via `@keyframes krypton-arc-flare`), then fades out over 1.5s.

#### 2. Titlebar Scanline Sweep

A subtle gradient sweep moves across the `.krypton-window__titlebar` background while progress is active. This is a `::after` pseudo-element — a narrow (40px wide) vertical band of the accent color at very low opacity (0.04-0.06) that translates left-to-right in a loop.

```css
.krypton-window__titlebar--progress::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(var(--krypton-window-accent-rgb), 0.05) 45%,
    rgba(var(--krypton-window-accent-rgb), 0.08) 50%,
    rgba(var(--krypton-window-accent-rgb), 0.05) 55%,
    transparent 100%
  );
  animation: krypton-scanline-sweep 3s linear infinite;
  pointer-events: none;
}

@keyframes krypton-scanline-sweep {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}
```

The sweep is removed when progress goes to Hidden. For Error state, the sweep color shifts to the error color. For Paused, the animation pauses (`animation-play-state: paused`).

This is extremely subtle — just enough to signal "something is happening" without being distracting. Combined with the arc gauge, it gives a "HUD systems active" feel.

#### Quick Terminal

Same treatment: the Quick Terminal's status dot gets the same arc gauge, its titlebar gets the same scanline sweep. The QT already has the same chrome structure.

### Theme Integration

The arc gauge inherits the per-window accent color (`--krypton-window-accent` / `--krypton-window-accent-rgb`) which is already set per-window by the compositor. This means each window's progress gauge automatically matches its accent color — no additional theme wiring needed for normal/indeterminate states.

Two new CSS custom properties for override states:

| Property | Default | Source |
|----------|---------|--------|
| `--krypton-progress-error` | `#ff3366` (red) | `theme.chrome.progress_error` |
| `--krypton-progress-paused` | `#ffaa00` (amber) | `theme.chrome.progress_paused` |

These are optional in the theme TOML — they fall back to the defaults above. The normal/indeterminate color comes from the window's existing accent, keeping the HUD consistent.

### Configuration

No new TOML config keys. The feature is always enabled (consistent with Ghostty/Windows Terminal behavior — there's no reason to disable it and no performance cost when not in use).

## Edge Cases

1. **Multiple rapid updates**: SVG `stroke-dasharray` updates are nearly free; CSS transition on the stroke handles smooth interpolation.
2. **Session exits while progress is active**: `pty-exit` handler destroys the pane (and its DOM including the arc SVG), so cleanup is automatic.
3. **OSC 9;4 split across read chunks**: The state machine tracks state across reads since it's per-session and persists between `read()` calls.
4. **Malformed sequences**: Any unexpected byte during parse resets to `Normal` state. No partial state is emitted.
5. **Progress > 100 or negative**: Clamp to 0-100.
6. **Quick Terminal**: Works the same — the QT has the same chrome structure (status dot + titlebar).
7. **Tab/pane not visible**: The arc lives on the window's status dot (always visible in chrome). Progress maps from session -> window, so switching tabs doesn't lose the gauge — it shows the active tab's progress.
8. **Multiple tabs with progress**: Only the active tab's progress is shown on the window's status dot. Switching tabs updates the gauge to the new active tab's last known state. Each pane stores its own `ProgressState` so nothing is lost.
9. **OSC 9;4 collision with iTerm2 notifications**: We follow Ghostty's approach — `OSC 9;4` always parses as progress. Notifications starting with `;4` won't work. Reasonable trade-off given wider progress bar adoption.
10. **Status dot size override via theme**: The SVG gauge scales relative to the dot via `inset: -7px`, so custom `--krypton-status-dot-size` values still work — the arc just orbits a larger/smaller center.

## Out of Scope

- Tab-level progress indicators (future enhancement — show per-tab arc in tab bar)
- Dock/taskbar-level progress (macOS NSProgress / Tauri window progress — future enhancement)
- Other ConEmu OSC 9 sub-commands (9;1 sleep, 9;2 messagebox, etc.)
- Configuration to disable the feature (no performance cost when not in use)
- Per-pane progress (progress is per-pane internally but displayed per-window on the status dot — only active pane's progress is shown)
