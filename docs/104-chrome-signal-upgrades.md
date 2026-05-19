# Chrome Signal Upgrades — Implementation Spec

> Status: Draft (revised 2026-05-18 to match Krypton's mode-based input system)
> Date: 2026-05-18
> Milestone: Post-M-current polish

## Problem

`DESIGN.md` is tight but most of the *signal* it promises (corner accents change with state, gauges breathe, tabs feel machined, HUD reads instrumented) is not yet wired into the chrome. Today windows look correct but communicate very little beyond focused/unfocused. We want the chrome to *speak* — without breaking the hard-geometry, mono-cyan, keyboard-first identity.

## Solution

Ship seven small, scoped upgrades to the existing Krypton Dark chrome. Each upgrade reuses tokens already declared in `DESIGN.md` frontmatter (opacity tiers, glow stack, motion curves) — no new colors, no new layers, no new ambient animations beyond what spec allows. The seven are independent and can be merged in any order; together they turn idle chrome into a quiet HUD.

## Research

Codebase findings (paths and selectors):

- **Corner accents** exist (`src/styles/window.css:35–107`, classes `.krypton-window__corner--{tl,tr,bl,br}`) but only the *border color* responds to focus, not the brackets themselves. They are already keyed to CSS custom properties via `box-shadow`.
- **Edge glow** is implemented (`src/styles/window.css:349–383`, class `.krypton-glow-overlay`) at fixed intensity. No coupling to PTY output rate.
- **Tab chamfer** is described in `DESIGN.md:244` ("angled clip-paths … chamfered top corners") but `.krypton-tab--active` currently only paints a 1px bottom rule (`window.css:196–273`). No clip-path is applied. Pane role is already on the DOM via `data-content-type` (agent, vault, shell, etc.).
- **Mode entry** is driven by `src/input-router.ts` (`setMode()`) with modes Normal / Compositor / Resize / Move / Swap / Selection / Hint / TabMove / CommandPalette / Dashboard. `which-key.ts` shows a next-key popup immediately on mode entry, but there is no large display-typography readout of the mode name itself. Krypton is **mode-based, not chord-based** — there is no multi-key chord prefix state (e.g. Helix-style `Space → f → r`), so a "chord pending" trigger does not exist; the closest analog is the mode entry moment.
- **Workspace switching** is *not yet implemented* — `#krypton-workspace` is a single DOM container, not a multi-workspace state machine. Sound event `workspace.switch` is declared in `sound.ts:22` but never fired. Animation styles (`Slide`, `Crossfade`, `Morph`) declared in `src/types.ts:220` are unused. Any workspace-related trigger must be deferred until that feature lands.
- **Titlebar** (`compositor.ts:1347–1379`) has `.krypton-window__label-group` (left), optional center Claude-tool indicator, and `.krypton-window__pty-status` (right). The right side is a free single text node. No HUD numerics surfaced today; process metrics are not piped into the titlebar.
- **Scan wipe** keyframes `krypton-scanline-sweep` exist (`src/styles/progress.css:152–192`) but only as an *infinite* sweep on the OSC 9;4 progress state. No one-shot ack pattern yet.
- **Breathing pulse** has multiple task-specific variants (`hooks.css:274,462,479`) but no generic `--krypton-motion-breathing` token consumer, and no "peak shift to brightCyan" pattern.

Alternatives ruled out:

- *Adding pseudo-element layers per upgrade* — violates memory `feedback_no_layered_ui` (keep effects flat). All seven upgrades reuse existing elements/pseudo-elements.
- *Toast on workspace switch* — too loud and competes with the existing toast lane. Display-typography flash is quieter and matches the "instrumented" voice.
- *New color for state corners* — would break the mono-cyan brand. We reuse `danger`/`warning`/`success`/`special` semantic tokens that already exist for toasts.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| WezTerm | Status bar shows pane title, CPU, time; tab bar bottom-aligned with no chamfer | Conventional, but text-only |
| Kitty | Tab bar has powerline separators; status text via shell integration | Chamfered tabs via powerline glyphs |
| iTerm2 | Status bar with configurable components (battery, git, CPU); badge text | Closest analogue for HUD numerics |
| tmux | Status line at bottom, format strings for any metric | Very flexible but unstyled |
| Warp | Block-based with subtle corner highlights on focus; no chamfer | Closest analogue for state-coloured corner accents |
| VS Code | Workspace switcher shows centered overlay with workspace name briefly | Closest analogue for the display-typography workspace flash |

**Krypton delta** — we converge on the *iTerm2 status row* and *VS Code workspace flash* conventions for familiarity, and diverge by (a) using corner accents instead of border-colour for state, which no terminal does today, and (b) coupling edge-glow intensity to throughput, which is novel — no surveyed app does this.

## Affected Files

| File | Change |
|------|--------|
| `src/styles/window.css` | Add state modifier rules for `.krypton-window__corner` (color/glow); add `--krypton-edge-intensity` CSS var consumed by `.krypton-glow-overlay`; add `clip-path` rule on `.krypton-tab--active` with `data-role` switch; add `.krypton-window__hud` block; add `.krypton-window__titlebar--ack` one-shot rule and `krypton-ack-wipe` keyframes; add `krypton-breathing` keyframes that target `--krypton-color-primary-shift` |
| `src/styles/overlays.css` *(or new `src/styles/display-flash.css` imported from `main.ts`)* | `.krypton-display-flash` element used by mode entry (and later, workspace switch) |
| `src/compositor.ts` | (a) read PTY-output activity rate per window → write `--krypton-edge-intensity`; (b) add `data-role` to tabs (`shell` \| `agent` \| `quick` \| `vault` \| `webview`); (c) build `.krypton-window__hud` DOM in `renderTitlebar()`; (d) expose `flashAck(windowId)` that adds/removes `--ack` class on titlebar |
| `src/input-router.ts` | In `setMode()`, schedule `showDisplayFlash(modeName)` after 120ms for non-Normal modes; cancel if the mode exits before the timeout fires (so single-action keys that pop straight back to Normal stay silent) |
| `src/window-state.ts` *(or wherever window state enum lives)* | Add `signalState: 'normal' \| 'ok' \| 'warn' \| 'err' \| 'special'` on `WindowState` |
| `src-tauri/src/pty.rs` | Emit lightweight `pty-activity` event (bytes since last tick, 200ms tick) for the edge-glow coupling — *only if not already inferable from existing `pty-output` event volume on the frontend* (verify before adding) |
| `docs/PROGRESS.md` | Tick off the seven upgrades |
| `docs/04-architecture.md` | One paragraph: chrome signal model (state → corner colour, throughput → edge glow) |
| `DESIGN.md` | Bump to `1.2.0`; add `chrome.cornerAccentStateColors`, `chrome.edgeGlowDynamic`, `chrome.tabChamferByRole`, `motion.ackWipe`, `motion.breathingShift` tokens; add changelog entry |

## Design

### Data Structures

```ts
// window-state.ts
export type SignalState = 'normal' | 'ok' | 'warn' | 'err' | 'special';

export interface WindowState {
  // …existing fields…
  signalState: SignalState;        // drives corner accent colour
  bytesPerSecond: number;          // smoothed PTY output rate (EMA, α=0.3)
}

// compositor.ts
type PaneRole = 'shell' | 'agent' | 'quick' | 'vault' | 'webview';
```

### CSS Tokens (added to `:root`)

```css
:root {
  --krypton-edge-intensity: 0.35;          /* default; live-updated per window */
  --krypton-color-signal: var(--krypton-color-primary);  /* swapped per signalState */
  --krypton-color-primary-shift: var(--krypton-color-primary);  /* targets brightCyan at breathing peak */
}

.krypton-window[data-signal="ok"]      { --krypton-color-signal: var(--krypton-color-success); }
.krypton-window[data-signal="warn"]    { --krypton-color-signal: var(--krypton-color-warning); }
.krypton-window[data-signal="err"]     { --krypton-color-signal: var(--krypton-color-danger);  }
.krypton-window[data-signal="special"] { --krypton-color-signal: var(--krypton-color-special); }
```

### The Seven Upgrades

**1. Corner-accent state colour.** `.krypton-window__corner` `box-shadow` reads `--krypton-color-signal` instead of hard-coded primary. Compositor writes `data-signal` on the `.krypton-window` element based on `signalState`. Transitions: 220ms ease-out on the box-shadow colour. No new pseudo-element. Reverts to `normal` after 1.5s for one-shot states (success/error pulse); stays at `special` for the duration of agent activity.

**2. Activity-coupled edge glow.** `.krypton-glow-overlay` linear-gradient alpha pulled from `--krypton-edge-intensity` (default 0.35). Compositor maintains a 200ms-EMA of bytes/s per window from existing `pty-output` events (no new Rust event needed — verify by inspecting current event payload size). Map: `intensity = clamp(0.2 + bytesPerSecond/16384, 0.2, 0.7)`. Updates throttled to one `style.setProperty` call per 200ms.

**3. Per-role tab chamfer.** `.krypton-tab--active` gains `clip-path: polygon(…)` with the angle controlled by `--krypton-tab-chamfer`. Defaults: shell 12°, agent 24°, quick 0° (flat top), vault 6°, webview 18°. Driven by `[data-role="…"]` on the tab DOM (set in `compositor.ts` where tabs are rendered).

**4. Display-typography moments.** A single shared `<div class="krypton-display-flash">` mounted in `index.html`; `showDisplayFlash(text, ms)` sets text, adds `--visible` modifier, removes after `ms`. Used by **mode entry**: 120ms after entering a non-Normal mode (Compositor / Resize / Move / Swap / Hint / TabMove), flash the mode name in display typography for 400ms — e.g. `"RESIZE"`, `"HINT"`. If the mode exits before the 120ms timeout (single-action Compositor keys that auto-return to Normal), no flash fires. Workspace-switch flash (`"WS 03"`) is **deferred** until workspace switching is implemented; the same `showDisplayFlash()` API will be reused. Display typography is `display` tier from `DESIGN.md` (28px / 0.2em uppercase). Centered with `position: fixed; inset: 0; display: grid; place-items: center; z-index: var(--krypton-z-hint)`. Pointer-events none. Coexists with the which-key popup (which sits in a corner) — the flash is centered display-typography, the popup is corner key-list, no visual conflict.

**5. HUD numerics row.** Replace `.krypton-window__pty-status` with `.krypton-window__hud` containing four micro-readouts: `[UP 00:14:22]  [B/s 4.2K]  [PID 38421]  [EXIT —]`. Each readout uses label typography (11px / 0.08em uppercase) with `font-variant-numeric: tabular-nums`. Values update at 1Hz max via `requestAnimationFrame`-throttled writes. PTY status text moves into a tooltip on the leftmost readout. Below 320px window width, HUD collapses to just `B/s`.

**6. Scan-wipe as one-shot ack.** New `@keyframes krypton-ack-wipe` (400ms linear, single iteration). New rule `.krypton-window__titlebar--ack::after { animation: krypton-ack-wipe 400ms linear; }`. Compositor exposes `flashAck(windowId)` which toggles the class and removes it on `animationend`. Use sites: confirm dialog OK, palette commit, hint-mode selection. Does *not* replace the OSC 9;4 progress sweep (which stays infinite on its own pseudo-element layer of the same rule).

**7. Breathing brightness shift at peak.** New `@keyframes krypton-breathing { 0%, 100% { --krypton-color-primary-shift: var(--krypton-color-primary); } 50% { --krypton-color-primary-shift: var(--krypton-ansi-bright-cyan); } }`. Applied only to the focused window's corner accents and the status dot: `animation: krypton-breathing var(--krypton-motion-breathing);`. Because the shift is on a custom property (CSS Houdini `@property` registration required for interpolation), we use `currentColor` swap on a wrapper element rather than property interpolation if `@property` is unavailable. Fallback: discrete 50% switch — still reads as a subtle pulse.

### API / Commands

No new Tauri commands. Possibly one new event:

- `pty-activity` (per-window, 200ms tick, payload `{ window_id, bytes_in_window }`) — *only added if we cannot derive throughput from existing `pty-output` event volume on the frontend.* Decision deferred to implementation.

### Data Flow (HUD throughput example)

```
1. pty-output event arrives on frontend (existing event)
2. compositor.ts increments per-window byte counter
3. 200ms tick: bytesPerSecond_ema = α·new + (1−α)·old
4. tick writes window.element.style.setProperty('--krypton-edge-intensity', mapped)
5. tick writes HUD `B/s` readout text
6. CSS gradient & HUD repaint; no JS layout
```

### Keybindings

No new keybindings. Display flash piggybacks on the existing mode state machine in `input-router.ts` (`setMode()` is the single entry point for every mode transition). When workspace switching ships later, its existing keys will also call `showDisplayFlash()` — no new keys at that time either.

### UI Changes

- `data-signal` attribute on `.krypton-window`
- `data-role` attribute on `.krypton-tab`
- New `.krypton-window__hud` block replaces single-line PTY status
- New `.krypton-display-flash` singleton, mounted once at app boot
- New `--ack` modifier on `.krypton-window__titlebar`

### Configuration

New optional TOML keys in `krypton.toml` under `[chrome.signals]`:

```toml
[chrome.signals]
state_corner_colors = true        # default true; off → corners always primary
edge_glow_dynamic = true          # default true; off → fixed 0.35
tab_chamfer_by_role = true        # default true; off → uniform 12° on all
hud_numerics = true               # default true; off → fall back to PTY status text
display_flash = true              # default true; off → no mode-entry flash
breathing_peak_shift = true       # default true; off → no brightCyan peak
```

All default to on. The toggles exist mainly to let users with `prefers-reduced-motion` or low-end GPUs opt out without abandoning Krypton Dark.

## Edge Cases

- **Reduced motion** — `@media (prefers-reduced-motion: reduce)` drops `krypton-breathing`, `krypton-ack-wipe` (per existing `reducedMotionPolicy`). Corner state colour still applies (informational, not decorative). Edge-glow intensity update interval drops from 200ms to 1000ms.
- **Hi-DPI hairlines** — HUD label `font-size: 11px` survives @2x; no extra rule needed.
- **Below min window size** — HUD collapses to `B/s` only; below 200px wide the window closes (existing behavior).
- **Many windows, high throughput** — throttle setProperty to one call per 200ms per window; never per-frame. EMA prevents flicker.
- **PTY exits with non-zero status** — `signalState = 'err'` for 4s then revert to `'normal'`; `EXIT` HUD slot shows the code permanently until the window is closed.
- **Custom theme overrides `ansi.brightCyan`** — breathing peak picks up whatever the theme defines. Acceptable.
- **Sibling aesthetics (Vault, Agent)** — they scope under `.krypton-vault` / `.krypton-agent` and define their own corner/edge rules. The new state/data-attribute hooks live on `.krypton-window` outside those scopes, so siblings inherit only the parts they choose to consume. No bleed.

## Open Questions

1. **Throughput source.** Is the existing `pty-output` event payload size sufficient to derive bytes/s on the frontend, or do we need a new `pty-activity` event? Verify during implementation. *Resolution:* if frontend can measure, skip the Rust change entirely.
2. **`@property` support for breathing colour interpolation.** macOS WKWebView supports `@property` in recent versions, but the fallback is acceptable — proceed with the fallback by default and add `@property` registration as a progressive enhancement.
3. **Order of merge.** Original suggested order was (6) → (1) → (4) → (7) → (3) → (5) → (2). As of 2026-05-18, upgrades 1, 2, 3, 6, 7 are already merged (see commits `c1ec1d6`, `2b0c1e4`, `454f78c`). Remaining: (4) display flash and (5) HUD numerics. (5) is the higher-value next step since all of its data sources already exist; (4) ships the singleton infra now and re-wires the workspace-switch trigger once workspaces land.

## UI Improvement Backlog

App-wide UI improvement candidates live in `docs/108-overall-ui-improvements.md`. This document stays scoped to chrome signal behavior: window chrome, state communication, HUD readouts, and display moments.

## Out of Scope

- Adding new colours to the palette beyond the existing semantic tokens
- Changing the cyan-primary identity of Krypton Dark
- Reworking sibling aesthetics (`DESIGN.nasa.md`, `DESIGN.amber.md`) — they define their own chrome
- New keybindings, new modes, new dialogs
- Mouse-driven interactions on the chrome (keyboard-only per project memory)
- Sound design for the ack pulse (handled separately by sound theme work)
- Telemetry / metrics persistence for HUD readouts beyond the live values

## Resources

- `DESIGN.md` (project, v1.1.0) — token table and forbidden list
- `src/styles/window.css` — current corner/edge/tab CSS
- `src/styles/progress.css` — existing `krypton-scanline-sweep` keyframes to model the one-shot ack on
- `src/compositor.ts` — titlebar render, tab render, window lifecycle
- `src/input-router.ts` (`setMode()`) & `src/which-key.ts` — mode state machine (Krypton is mode-based, not chord-based)
- [CSS `@property` (MDN)](https://developer.mozilla.org/en-US/docs/Web/CSS/@property) — used for the breathing colour interpolation enhancement
- [W3C `prefers-reduced-motion`](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion) — drives the reduced-motion branch
- iTerm2 status bar docs, Kitty tab-bar docs, WezTerm status-bar docs — surveyed for prior-art table above (no external links cited; behavior observed directly in the apps)
