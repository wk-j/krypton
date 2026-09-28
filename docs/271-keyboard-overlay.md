# Keyboard Overlay (Ghost Hands) — Implementation Spec

> Status: Implemented
> Date: 2026-09-28
> Milestone: M8 — Polish

## Problem

Krypton can't show which keys are being pressed. You can't see the keyboard while demoing, screen-sharing, or recording a session. The "Keyboard study: ghost hands" artifact (`/Users/wk/Source/artirfact/Keyboard study_ ghost hands.html`) shows the look we want: a label-only keyboard with two wireframe hands that reach for each key as it is typed. It is a standalone page, though, not a layer inside Krypton.

## Solution

Port the artifact's keyboard and hand renderer into a **read-only visual overlay**. It is docked at the **center-bottom of the workspace screen**, not of any terminal window, flush on the workspace footer rail. It **observes** keydown events without consuming them, draws on an OffscreenCanvas in a Web Worker (the spec 48 pattern), and stops its animation loop when the hands settle. It never writes to a PTY. The mouse-grip pose is dropped because Krypton is keyboard-only. Password entry is masked using a termios check in the backend.

## Research

- **Source artifact** (`Keyboard study_ ghost hands.html`, 19 KB script). It lays out a canvas keyboard by physical `e.code`, with per-layout label tables (`de`, `us`, `th` Kedmanee). A touch-typing finger map (`FMAP`) and `HOME` row drive two 21-point hands in the MediaPipe landmark order. Each hand has a wrist, thumb, and four fingers with MCP/PIP/DIP/TIP joints. Fingertips lerp to the target key (0.38 per frame), and the palm follows 42% of the reach. Pressed keys glow and decay at 2.6/s. A `gripPose` blends the right hand to a mouse, and a 5 s idle "ghost" types phrases into an `<input>`. `COMPACT` mode (15.4 key-units wide) drops the mouse.
- **Prior art in this repo:**
  - `CursorTrail` (`src/cursor-trail.ts` + `cursor-trail-worker.ts`, spec 48): a full-viewport canvas transferred to a worker. The main thread only posts coordinates, so rendering survives heavy `pty-output`.
  - `ProfilerHud` (`src/profiler/profiler-hud.ts`): a non-modal `pointer-events: none` HUD that is lazy-imported on the first `Compositor.toggleProfilerHud()` (Leader `Shift+P`).
  - Workspace footer: a 28 px `position: fixed; bottom: 0; z-index: 9000` rail with `setVisible()` callbacks.
  - `InputRouter.setupKeyHandler()` is a bubbling `document` keydown listener, and summon overlays add `document` capture listeners after it.
  - `PtyManager::get_foreground_process` already calls `libc::tcgetpgrp(master.as_raw_fd())`, so the same fd can be used for `tcgetattr`.
- **Leader key space:** every lowercase letter is bound. `Shift+K` is unhandled: the `k` case ignores `shiftKey`, so it currently acts as "focus up". `K` is already in `GLOBAL_LEADER_RESERVED_KEYS`.
- **Secure-input heuristic:** a password prompt (`sudo`, `ssh` passphrase, `readpassphrase(3)`) clears `ECHO` but keeps `ICANON`. Raw TUIs (zsh ZLE, vim, tmux, an ssh session, Claude Code) clear **both**. So `!ECHO && ICANON` flags password prompts without masking every TUI.
- **Alternatives rejected:**
  - A DOM/SVG keyboard: per-frame style writes on around 60 nodes, which is the problem spec 48 removed.
  - An idle ghost that types into the terminal: it would inject input the user never pressed.
  - A per-window overlay: the user asked for workspace-screen placement.
  - Polling termios: an idle-CPU cost. We query on keydown instead.
- Web research was skipped at the user's request. The prior art below is from existing knowledge and was not re-verified online.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| KeyCastr (macOS) | Floating HUD of pressed-key chips, movable; can limit to modified keys | Hides during macOS Secure Input |
| Screenkey (Linux) | Bottom-of-screen text strip of recent keys, timeout fade | Text log, no keyboard picture |
| VS Code Screencast Mode | Command-palette toggle; keystroke chips near the bottom of the window | `screencastMode.*` settings; editor-scoped |
| macOS Keyboard Viewer | Full on-screen keyboard that lights pressed keys; clickable | Input device, not a visualizer |
| iTerm2 / WezTerm / Kitty / Ghostty | No built-in key visualizer | — |

**Krypton delta:** it follows the common convention of a bottom-center placement and a toggle from both the palette and a key. It differs in three ways:
1. It draws a full physical keyboard with animated wireframe hands instead of key chips.
2. It is strictly an observer: no clicking, no input injection, mouse ignored.
3. It masks keys at terminal-level password prompts, using termios rather than OS Secure Input.

## Affected Files

| File | Change |
|------|--------|
| `src/keyboard-overlay-model.ts` | **New** — no DOM: `ROWS`, `LAYOUTS` (us/de/th), `FINGER_MAP`, `resolveCode()`, `detectLayout()`, `overlaySize()`, `KeyboardOverlayRenderer` (hand pose + drawing + ghost) and `KeyboardOverlayDriver` (canvas, rAF loop, idle stop) shared by the worker and the fallback |
| `src/keyboard-overlay-model.test.ts` | **New** — code resolution, Thai auto-detect, finger mapping, settle detection |
| `src/keyboard-overlay-worker.ts` | **New** — thin worker entry: forwards messages to a `KeyboardOverlayDriver` on the OffscreenCanvas |
| `src/keyboard-overlay.ts` | **New** — `KeyboardOverlay` main-thread proxy: canvas mount, key observer, secure-input check, theme/font/size messages, main-thread fallback |
| `src/styles/keyboard-overlay.css` | **New** — `.krypton-keyboard-overlay` placement; `@import` in `src/styles/index.css` |
| `src/compositor.ts` | `toggleKeyboardOverlay()` (lazy import, like `toggleProfilerHud`); `applyConfig()` forwards `[keyboard_overlay]` at startup and reload; `setKeyboardOverlayFooterVisible()` |
| `src/main.ts` | Feed workspace-footer visibility (`isVisible` + `onVisibleChange`) to the compositor |
| `src/input-router.ts` | Compositor `k` case: `Shift+K` → `toggleKeyboardOverlay()` |
| `src/which-key.ts` | `{ key: 'K', label: 'Keyboard Overlay', effect: 'important' }` in the tools group |
| `src/command-palette.ts` | `view.keyboardOverlay` — "Toggle Keyboard Overlay", `Leader K` |
| `src/config.ts` | `KeyboardOverlayConfig` + field on `KryptonConfig` |
| `src-tauri/src/config.rs` | `KeyboardOverlayConfig` struct + defaults |
| `src-tauri/src/pty.rs` | `PtyManager::is_secure_input(session_id) -> Option<bool>` via `libc::tcgetattr` |
| `src-tauri/src/commands.rs`, `lib.rs` | `get_pty_secure_input` command + registration |
| `docs/04-architecture.md`, `05-data-flow.md`, `06-configuration.md`, `README.md` | Module entry, key-observe flow, `[keyboard_overlay]` reference, index row |

## Design

### Data Structures

```ts
// src/config.ts
export interface KeyboardOverlayConfig {
  enabled: boolean;          // shown at startup (default false)
  layout: 'auto' | 'us' | 'de' | 'th'; // label set (default 'auto')
  width_ratio: number;       // overlay width ÷ workspace width, clamp 0.2–0.8 (default 0.36)
  opacity: number;           // 0.1–1.0 whole-overlay alpha (default 0.7)
  mask_secure_input: boolean; // suppress glow/reach at password prompts (default true)
  idle_ghost: boolean;       // hands-only phrase animation after 5 s idle (default false)
}

// main → worker (or the main-thread fallback driver)
type OverlayMessage =
  | { type: 'init'; canvas: OffscreenCanvas | HTMLCanvasElement }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'style'; style: { ink: string; accent: string; font: string; reducedMotion: boolean } }
  | { type: 'config'; layout: 'us' | 'de' | 'th'; ghost: boolean }
  | { type: 'key'; code: string; shift: boolean }   // already resolved + unmasked
  | { type: 'visible'; visible: boolean }
  | { type: 'dispose' };
```

```rust
// src-tauri/src/config.rs — #[serde(default)], field `keyboard_overlay` on KryptonConfig
pub struct KeyboardOverlayConfig {
    pub enabled: bool, pub layout: String, pub width_ratio: f64,
    pub opacity: f64, pub mask_secure_input: bool, pub idle_ghost: bool,
}
```

### API / Commands

- `get_pty_secure_input(session_id: u32) -> Result<Option<bool>, String>`. It returns `Some(true)` when the PTY termios has `ECHO` cleared and `ICANON` set, `Some(false)` otherwise, and `None` when the session is gone, the fd is unavailable, or on non-Unix platforms. It is read-only and has no events.
- `Compositor.toggleKeyboardOverlay(): Promise<void>` and `KeyboardOverlay.setEnabled(on: boolean)` / `applyConfig(cfg)`.

### Data Flow

```
1. Keydown anywhere → KeyboardOverlay's window-level capture listener (passive, registered
   once; runs before every document listener, never calls preventDefault/stopPropagation).
2. Skip if hidden, e.repeat, or e.metaKey (app shortcuts incl. the Cmd+P leader).
3. code = resolveCode(e) (e.code if drawn, else ' '→Space, else label lookup); null → skip.
   layout 'auto': a Thai e.key (U+0E00–U+0E7F) switches labels to 'th'; an ASCII letter
   switches back to 'us' → post {config}.
4. mask_secure_input && compositor.getFocusedSessionId() !== null:
   cached flag < 250 ms old → use it; else invoke('get_pty_secure_input') and decide when it
   resolves (≈1 ms). secure → drop the key. Error/None → treat as not secure.
5. post {key, code, shift} → worker sets finger target + glow, (re)starts its rAF loop.
6. Worker loop: pose → draw → when every glow is 0, every tip is within 0.1 px of its target,
   and ghost is off/not due → stop the loop (0 frames at idle).
```

Other inputs:
- `theme-changed`/config reload: re-read `--krypton-fg`, `--krypton-accent`, and the terminal font family, then post `{style}`.
- `window` resize: post `{resize}`.
- Footer `setVisible` callback: toggle the `--no-footer` modifier.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Shift+K` | Compositor mode (after `Cmd+P`) | Toggle keyboard overlay, return to Normal |
| "Toggle Keyboard Overlay" | Command Palette | Same |

### UI Changes

- One `<canvas class="krypton-keyboard-overlay">` is appended to `document.body`:
  - Positioning: `position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%)`. That puts it flush on the 28 px footer. With `--no-footer` it sits at `bottom: 0`.
  - Size: width `round(innerWidth × width_ratio)`, height `width × 8.1 / 15.4`, using the artifact's COMPACT geometry. The top margin is tightened from 0.7U to 0.5U (the artifact's 9.6U height reserved space for the mouse). The height ends just under the lowest hand box: a bottom-row reach drops the wrist to 7.72U, plus the 0.3U box pad = 8.02U.
  - Layering: `pointer-events: none; z-index: 7900`, above windows and the Quick Terminal (5000), below inline AI / Markdown AI prompts (8000), the hint overlay and footer (9000), the profiler (10000), palette/overlays, and the cursor trail (99999).
  - Visibility: `opacity: var(--kb-opacity)`, with a 150 ms fade on show and hide.
- Background: none. The canvas is fully transparent, so no card, no border, and no L-brackets (constraint 9). Only three things are drawn:
  - Key labels, in the ink color at 28% alpha, rising to 100% while lit, plus a 1 px full-square outline while lit.
  - The spacebar, as a single rule.
  - The hands: 1 px bone lines at 55% alpha, 2.4 px joint squares, an 8 px solid square on a pressed fingertip, a 1 px dim full bounding box, and the artifact's debug label (`['hand0:u'] 0.4600000`).
- Colors: ink = `--krypton-fg`; the lit outline and pressed tip use `--krypton-accent`; dim = ink at 45% alpha.
- Font: the user's configured terminal font family, per the reading-surface rule, not the artifact's IBM Plex.
- Reduced motion: tips and palm snap without lerp.
- Removed from the artifact: the mouse and grip pose, the `<input>` line, the header, the stats footer, the layout buttons, and pointer-driven key presses.

### Configuration

```toml
[keyboard_overlay]
enabled = false            # show at startup; Leader Shift+K toggles at runtime (not persisted)
layout = "auto"            # auto | us | de | th — auto follows typed script (us ↔ th)
width_ratio = 0.36         # overlay width as a fraction of the workspace width (0.2–0.8)
opacity = 0.7              # whole-overlay alpha (0.1–1.0)
mask_secure_input = true   # hide keys while a terminal password prompt has echo off
idle_ghost = false         # after 5 s idle, hands play demo phrases (visual only, never typed)
```

Reload Config applies every key live. `enabled` only changes visibility on reload when the value changes.

## Edge Cases

- **Password inside ssh / tmux / a TUI**: the local PTY is raw (`ICANON` off), so a remote `sudo` prompt is **not** detectable and its keys are shown. This is documented as a limitation; toggle the overlay off (`Shift+K`) when it matters.
- **Non-terminal panes** (agent, harness, vault, editor, Quick File Search): there is no session id, so keys are shown and there is no secure check.
- **IME / Thai input**: `e.code` stays physical, so the right key lights. Dead keys and composition events are resolved by `e.code` only. Keys that aren't drawn (arrows, F-keys, Tab, Ctrl, Alt, Cmd) are ignored. Ctrl combos light their letter key.
- **Mode keys** (compositor, hint, selection) are shown like any other key. Only Meta combos are skipped.
- **Worker unavailable** (`transferControlToOffscreen` missing): the same renderer runs on the main thread with the same idle stop, following the spec 48 fallback.
- **Web fonts**: the worker can only use system-installed fonts, so a document-only webfont falls back to `monospace`.
- **Workspace switch, maximize, Quick Terminal**: the overlay is fixed to the viewport and unaffected. It stays above windows and below modal overlays.
- **Very small screens**: the key unit is clamped to at least 12 px, matching the artifact, so labels stay legible.
- **Hidden overlay**: the key listener returns at step 2, no IPC runs, and the worker loop is stopped.

## Open Questions

None. The user fixed the placement (center-bottom of the workspace screen). The other defaults were proposed and left standing: ghost off, termios masking on, auto QWERTY/Kedmanee labels.

## Out of Scope

- Clicking or typing through the overlay (it is not an input device).
- Chord chips or keystroke history text (Screenkey-style).
- A mouse pose.
- Per-window placement.
- Persisting the runtime toggle.
- Layouts beyond us/de/th.
- Detecting remote password prompts.

## Implementation Notes

Deviations from the approved draft, made during implementation:

- **z-index 7900, not 8500.** 8500 would have drawn the overlay over the Inline AI and Markdown AI prompt boxes (8000). 7900 keeps it above every window and the Quick Terminal.
- **One driver for both paths.** The renderer and the rAF/idle-stop loop live in `keyboard-overlay-model.ts` as `KeyboardOverlayRenderer` + `KeyboardOverlayDriver`. The worker is a thin message forwarder and the main-thread fallback runs the same driver, so the two paths cannot drift.
- **Thai labels are drawn without "◌".** On a worker canvas, "◌" + a combining mark (◌ุ ◌ั ◌ี ◌้ …) split across fonts and rendered as tofu. A bare mark renders, and the Thai font draws its own dotted circle, so `LABELS` stores stripped labels and the style font appends `Thonburi, 'Noto Sans Thai', sans-serif`.
- **Docked lower, flush on the footer.** At the user's request the overlay moved down: the 8 px gap above the footer was dropped (`bottom: 36px` → `28px`, no footer `8px` → `0`), and the height was trimmed from 8.4U to 8.1U. The resting hands left about 0.8U of empty canvas below them, and even a bottom-row reach only needs 8.02U, so the resting hands now sit 0.3U + 8 px lower (≈ 18 px at `width_ratio = 0.36` on a 1440 px workspace). The remaining 0.5U below them is reach headroom; lowering further would let bottom-row reaches cross into the footer rail.
- **Theme/font pickup** uses a `MutationObserver` on `<html>`'s inline `style` (where both the theme engine and `Compositor.applyConfig` write `--krypton-*`), coalesced to one read per frame. No new event subscription was needed.

## Resources

- `/Users/wk/Source/artirfact/Keyboard study_ ghost hands.html` — source renderer (geometry, finger map, hand pose, ghost), identical to the claude.ai artifact `EMTRR3yHkmVR3qQHNkq36W`
- [docs/48-offscreen-canvas-animations.md](./48-offscreen-canvas-animations.md) — worker + OffscreenCanvas proxy pattern and fallback
- `termios(4)` / `readpassphrase(3)` man pages — `ECHO`/`ICANON` semantics behind the secure-input heuristic
