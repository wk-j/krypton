# Progress Bar — Implementation Spec

> Status: Implemented
> Date: 2026-03-13
> Milestone: M8 — Polish

## Problem

Terminal programs (Zig CLI, systemd, Amp, custom scripts) use the ConEmu `OSC 9;4` escape sequence to report progress state. Modern terminals like Ghostty, Windows Terminal, and ConEmu render this as a native GUI progress bar. Krypton currently has no OSC parsing and no progress visualization, making it miss this increasingly adopted feature.

## Solution

Parse the `OSC 9;4` sequence from raw PTY output in the Rust backend, emit a typed Tauri event to the frontend, and render a large translucent HUD gauge centered behind the terminal content in each window. The gauge shows an arc ring with percentage text and a status label, while a scanline sweep moves across the titlebar as a secondary cue. Supports five states: hidden, normal (with percentage), error, indeterminate (orbiting arc), and paused. Each pane tracks its own independent progress state.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/pty.rs` | Add OSC 9;4 parser in PTY reader thread; emit `pty-progress` event |
| `src-tauri/src/lib.rs` | No change needed (event emitted directly, no new command) |
| `src/compositor.ts` | Listen for `pty-progress` event; create/update/remove centered SVG gauge in window content area, toggle titlebar scanline sweep class |
| `src/types.ts` | Add `ProgressState` enum, `ProgressEvent` interface, `PaneProgress` interface |
| `src/styles.css` | Add `.krypton-progress-gauge*` SVG styles, `.krypton-window__titlebar--progress` scanline sweep, `@keyframes` for orbit/flare/sweep |

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
7. If state=0 (Hidden): remove gauge div from content area, remove titlebar--progress class
8. If state>0: create/update .krypton-progress-gauge div in window's content area (behind terminal)
9. SVG arc stroke-dasharray set for fill %, percentage text + status label updated
10. Add krypton-window__titlebar--progress class to activate scanline sweep
11. Apply state-specific CSS modifiers (--error/--indeterminate/--paused)
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

#### 1. Centered Background Gauge

A large translucent arc gauge is rendered centered inside each window's `.krypton-window__content` area, behind the terminal content (z-index: 0). It acts as a HUD watermark — clearly visible but low enough opacity to keep terminal text fully readable.

**DOM structure** (inserted as first child of content area):

```html
<div class="krypton-window__content">
  <div class="krypton-progress-gauge krypton-progress-gauge--visible">
    <svg class="krypton-progress-gauge__svg" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="40" class="krypton-progress-gauge__track" />
      <circle cx="50" cy="50" r="40" class="krypton-progress-gauge__fill"
              stroke-dasharray="<filled> <remainder>"
              transform="rotate(-90 50 50)" />
      <text x="50" y="47" class="krypton-progress-gauge__pct">75%</text>
      <text x="50" y="60" class="krypton-progress-gauge__label">LOADING</text>
    </svg>
  </div>
  <!-- terminal panes render on top -->
</div>
```

The gauge container is `position: absolute; top/left: 50%; transform: translate(-50%, -50%)` with `width/height: min(60%, 220px)`. The SVG uses a 100x100 viewBox with arc radius 40.

**Opacity levels** (translucent so terminal text shows through):
- Arc fill stroke: `0.2` (accent color)
- Track stroke: `0.06`
- Percentage text: `0.12`
- Status label: `0.08`
- Drop-shadow glow: `0.5` inner, `0.15` outer

**States:**
- **Normal (1)**: Arc fills clockwise from 12 o'clock. Percentage text (e.g. `75%`) + label `LOADING`.
- **Error (2)**: Full arc in red. Text shows percentage or `ERR`. Label `ERROR`. Red glow.
- **Indeterminate (3)**: A 25% arc segment orbits continuously (`@keyframes krypton-gauge-orbit`, 1.8s). No percentage text. Label `WORKING`.
- **Paused (4)**: Arc frozen at current fill in amber. Label `PAUSED`.
- **Hidden (0)**: Gauge div removed from DOM.

**Completion**: At 100%, text shows `100%` / `COMPLETE`, the SVG glow flares (`@keyframes krypton-gauge-flare`), then the container fades out over 1.5s and is removed.

**Appearance on entry**: The gauge fades in via `opacity: 0` -> `opacity: 1` transition (0.4s) to avoid a jarring pop-in.

#### 2. Titlebar Scanline Sweep (secondary cue)

A gradient band sweeps across the `.krypton-window__titlebar` background on a 2.5s loop while progress is active. Accent color at 0.12-0.20 opacity — visible but not distracting. Error state shifts to red. Paused state freezes the animation.

#### Quick Terminal

Same treatment: the Quick Terminal's content area (`.krypton-window__body`) gets the same background gauge, and its titlebar gets the same scanline sweep.

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
6. **Quick Terminal**: Works the same — the QT's `.krypton-window__body` hosts the gauge identically to regular windows' `.krypton-window__content`.
7. **Tab/pane not visible**: The gauge lives in the window's content area (centered behind terminal text). Progress maps from session -> window, so switching tabs doesn't lose the gauge — it shows the active tab's progress.
8. **Multiple tabs with progress**: Only the active tab's progress is shown in the window's content-area gauge. Switching tabs updates the gauge to the new active tab's last known state. Each pane stores its own `ProgressState` so nothing is lost.
9. **OSC 9;4 collision with iTerm2 notifications**: We follow Ghostty's approach — `OSC 9;4` always parses as progress. Notifications starting with `;4` won't work. Reasonable trade-off given wider progress bar adoption.
10. **Gauge sizing**: The SVG gauge scales up to `min(220px, 60%)` of the window content area and is centered via flexbox, adapting naturally to any window size.

## Out of Scope

- Tab-level progress indicators (future enhancement — show per-tab arc in tab bar)
- Dock/taskbar-level progress (macOS NSProgress / Tauri window progress — future enhancement)
- Other ConEmu OSC 9 sub-commands (9;1 sleep, 9;2 messagebox, etc.)
- Configuration to disable the feature (no performance cost when not in use)
- Per-pane progress (progress is per-pane internally but displayed per-window in the content-area gauge — only active pane's progress is shown)
