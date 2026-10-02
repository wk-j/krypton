# Wheel Ghost Eye — Implementation Spec

> Status: Implemented
> Date: 2026-10-01
> Milestone: M3 — Compositor & Windows
> Revises: [272 — Wheel Layout](./272-wheel-layout.md), [273 — Wheel Live Previews](./273-wheel-live-previews.md) (the active card's schematic)

## Problem

Every Wheel card near the apex shows its live window (spec 273), but the active card cannot: its window element is the main frame, and one element cannot be in two places. The active card falls back to a schematic. For content views (harness, agent, markdown) that is a lone glyph, so the most prominent card on the rail reads as dead. The user wants the active card to feel alive.

## Solution

Replace the active card's schematic with the **ghost eye** from the user's study (`/Users/wk/Source/artirfact/Cursor study_ the watching eye.html`). The eye is an almond of streaming text with an iris, a bold pupil, a 1px pupil box, and blinking lids. It is drawn on one canvas that moves to whichever card holds the focused window. As in the study, it **follows the mouse pointer**, flinches when the pointer enters it, and blinks on click. When the pointer has been still for 3.5 s or has left the window, the eye **watches output activity** instead: the main frame while the focused window is the busiest, otherwise the busiest other window's card. When everything is quiet, it drifts. The pupil dilates as its target gets closer or busier, and the text flows faster while the focused window writes output.

## Research

- **The study.** The eye is a `cols × rows` grid. A cell belongs to the eye when `|nx| < 1 && |ny| ≤ (1 − nx²)^0.85`. It is closed from top and bottom by `lid` (cells with `|ny| > (1 − lid)·1.02` go blank). Each cell is `SRC[(off + r·cols + c) % len]`, classed `p` (pupil box, half-size `hw = max(2, round(cols·0.045·dil))`, `hh = max(1, round(rows·0.07·dil))`), `i` (iris ellipse `rx = 2.6·hw`, `ry = 2.8·hh + 1`), or `o` (white). The gaze maps a target offset `(dx, dy)` at distance `d` to a pupil offset `k = tanh(d / reach)`, `tx = dx/d·k·cols·0.3`, `ty = dy/d·k·rows·0.27`, and dilates by `near = 1 − min(1, d / 2·reach)`. With no target it drifts `sin(t/1700)·cols·0.08`, `cos(t/2300)·rows·0.06`. A blink is 160 ms closing and 160 ms opening, every 2.6–7.1 s, plus a flinch blink when the pointer enters the eye and a blink on click. While the pointer is inside the eye, all of it turns the alert colour. The text advances one character every 420 ms. Rendering is skipped when the key `(pupil cell, hw, hh, lid step, off, alert)` is unchanged.
- **Ported:** pointer follow, dilation, the flinch, the alert colour, click-to-blink, random blinks, drift, and text flow. **Dropped:** the worm, the leader line, the reticle with its coordinate readouts, the status bar, and the controls (text input, follow slider, toggles). Those draw on a full-screen overlay canvas, which would sit over the terminals in the main frame, or they are page chrome.
- **Reach.** The study's reach is 0.45 × the eye's width on a page-sized eye. The Wheel eye is about 145px wide on screen, and the pointer can be 1500px away, so a width-based reach would pin the pupil to the rim almost always. A fixed `WHEEL_EYE_REACH` of 360px keeps the pupil moving across the near half of the screen and lets it rest on the rim, xeyes-style, beyond that.
- **Card size.** Idle cards are 112 × `cardHeight` (56–100px; 92px on 1728 × 1117), and the active card is scaled 1.5×, so it is 168 × 138 on screen.
- **Canvas over `<pre>`.** The study renders spans into a `<pre>`. At card size the text is about 3.6px, so the grid would depend on the chrome font's advance, and every change means `innerHTML` plus style recalc. A canvas with its backing store at `112 × 1.5 × dpr` keeps an exact grid (cell width = the measured advance), stays crisp after the card's 1.5× scale, and draws one `fillText` per same-class run, about 55 calls a frame.
- **No layout reads.** The eye's screen centre comes from the active card's pose plus the rail's client rect, which the rail reads once after each `setBounds` and caches. A per-tick `getBoundingClientRect` on a card the rail has just written a transform to would force style recalc.
- **Activity is already in the rail.** `WheelEntry.activity` (0–1, 1.5 s half-life) is pumped by PTY output and content-view output (`pumpWindowActivity`). The fallback gaze needs no new IPC and no compositor plumbing.
- **Clock.** The rail's rAF loop stops when nothing moves (0 idle CPU, spec 272). The eye needs its own clock, at three rates. It runs on rAF while the pointer has moved in the last second or a blink is running, so following and lids stay smooth. It ticks every 80 ms while watching activity, the same cap the rail uses so tuft decay never spins rAF at 60 Hz. It ticks every 420 ms (the text-flow step) when all is quiet. Idle cost is then about 2.4 ticks a second, plus one 320 ms rAF burst per random blink (every 2.6–7.1 s); each redraw is roughly 55 `fillText` calls, well under the 1% idle-CPU budget.
- **Native webviews** (spec 102) are OS views above the DOM, so pointer moves over them never reach `window`. The eye keeps the last known position, and after 3.5 s it falls back to activity.
- **Theme.** `theme.ts` sets `--krypton-accent-rgb`, `--krypton-fg-rgb`, and `--krypton-danger-rgb` (ANSI red) on the root. The rail already reads the accent in `refreshColors()`.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| xeyes (X11, 1988) | Two eyes whose pupils follow the mouse pointer; `-distance` changes the mapping | The archetype. It is pointer-only |
| iTerm2 | A tab shows an activity indicator while a non-selected tab receives output, and a blue dot for unseen output | Activity as a per-tab flag, with no direction |
| tmux | `monitor-activity on` flags a window `#` in the status line; `visual-activity` adds a message | Activity flag only |

**Krypton delta.** No terminal animates its switcher. The eye follows the pointer like xeyes, then falls back to something a terminal can show and xeyes cannot: unlike the iTerm2 and tmux flags, it points at the busy window on the rail. That keeps the eye meaningful for keyboard-only use. It is text-made and drawn in the theme accent, so it matches the Wheel's own look.

## Affected Files

| File | Change |
|------|--------|
| `src/wheel-eye.ts` | New. Pure grid functions and the `WheelEye` class (canvas, pointer listener, clock, blink, draw) |
| `src/wheel-eye.test.ts` | New. Shape, pupil and iris classes, lids, gaze mapping, the inside test, frame key, target priority |
| `src/wheel-rail.ts` | Own one `WheelEye`, mount it on the focused window's card, supply the eye centre and the activity target, blink on an active-card click, stop the eye on hide and dispose, forward theme changes |
| `src/wheel-layout.ts` | `WheelItem.eyeText`, folded into `wheelItemKey` |
| `src/compositor.ts` | `buildWheelItem` sets `eyeText` to `${label} ${title}` |
| `src/styles/wheel.css` | `.krypton-wheel__eye`; hide the schematic on the card that holds the eye |
| `docs/272`, `docs/273`, `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/README.md` | Active card is the eye, not a schematic |

## Design

### Data Structures

```ts
// src/wheel-eye.ts
export type WheelEyeClass = 'o' | 'i' | 'p';
export interface WheelEyeRun { cls: WheelEyeClass; col: number; text: string }
export interface WheelEyeState {
  cols: number; rows: number;
  px: number; py: number;  // pupil offset from centre, in cells
  dil: number;             // 1 … 1.9
  lid: number;             // 0 open … 1 closed
  offset: number;          // text scroll, in characters
  alert: boolean;          // pointer inside the eye
}
export function wheelEyeShape(nx: number, ny: number): boolean;
export function wheelEyePupil(s: WheelEyeState): { col: number; row: number; hw: number; hh: number };
export function wheelEyeRows(s: WheelEyeState, text: string): WheelEyeRun[][];
export function wheelEyeKey(s: WheelEyeState, textLength: number): string;
export function wheelEyeGaze(dx: number, dy: number, cols: number, rows: number): { x: number; y: number; near: number };
export function wheelEyeGrid(cellWidth: number, cardHeight: number): { cols: number; rows: number };
export function wheelEyeLid(msSinceBlink: number): number;
export function wheelEyeText(label: string, title: string): string;
/** The busiest window at or above WHEEL_EYE_WAKE (the focused one wins ties), or null. */
export function wheelEyeWatch(levels: readonly number[], active: number): { index: number; level: number } | null;

/** A point to look at, in viewport px, with a 0–1 level that drives dilation. */
export interface WheelEyePoint { x: number; y: number; level: number }
export interface WheelEyeCentre { x: number; y: number; rotate: number; scale: number }

// src/wheel-rail.ts → new WheelEye(callbacks)
export interface WheelEyeCallbacks {
  centre(): WheelEyeCentre | null;      // eye card's viewport pose, null while the rail is hidden
  activity(): WheelEyePoint | null;     // main-frame centre or the busiest card centre
  ownActivity(): number;                // focused window's activity, for the text flow
  motionEnabled(): boolean;             // false under reduced motion or animation style `none`
}

export class WheelEye {
  mount(card: HTMLElement, text: string, tabCount: number): void;  // idempotent per card
  isOn(card: HTMLElement): boolean;
  setRunning(on: boolean): void;   // listeners + clock only while the rail is shown
  resize(cardHeight: number): void;
  setStyle(style: WheelEyeStyle): void;  // font family + accent/fg/danger RGB from the rail root
  wake(): void;                    // new output: next tick at 80 ms
  blink(): void;
  dispose(): void;
}
```

`WheelItem` gains `eyeText: string` (the full label plus the tab title, whitespace collapsed, capped at 400 characters, falling back to `krypton`).

### Gaze

Each tick the eye picks one target, in priority order:

1. **Pointer**, if it is in the window and moved within `WHEEL_EYE_POINTER_IDLE_MS` (3500 ms). Level = `near`, so the pupil dilates as the pointer approaches.
2. **Activity** (`callbacks.activity()`). The rail takes `own` = the focused window's activity and `other` = the highest among the rest. Below `WHEEL_EYE_WAKE` (0.08) for both, it returns `null`. If `own ≥ other`, the point is the main frame's centre. Otherwise it is that window's card centre from `wheelItemPose(i, pos)`, which still lies on the orbit when the card is off the visible arc. Level = that activity.
3. **Drift**, the study's sin/cos wander, with level 0.

The offset `target − centre` is rotated by the card's `−rotate` into the card's frame. The pupil eases toward `wheelEyeGaze(...)`, and the dilation toward `1 + 0.9·level²`. Eases are time-based (`1 − (1 − e)^(dt / 16.7)`, with the study's `e` = 0.12 for gaze and 0.08 for dilation), so they match the study at any tick rate. The text advances one character every `420 − 340·own` ms (every 420 ms when quiet, every 80 ms at full output).

**Inside test:** the pointer, mapped into the card's frame and normalized by the eye's on-screen half-size, passes `wheelEyeShape`. Entering triggers a flinch blink and sets `alert`. A click on the card holding the eye blinks it before the usual `onActivate`, which just refocuses the active pane.

### Data Flow

```
1. syncWheelRoles → rail.setActive(i) → eye mounts on entry i's card, starting closed, and opens (a half blink)
2. pointermove on window (passive) → store x, y, time → wake the clock on rAF
3. Clock tick (rAF while the pointer moved in the last 1 s or a blink is running, 80 ms while
   awake, 420 ms while quiet; skipped while document.hidden):
   centre() → pick a target → ease pupil and dilation → inside test → advance text and lids
   → redraw only if wheelEyeKey changed
4. PTY or content-view output → rail.pump(id) → entry.activity rises and eye.wake() pulls the
   next tick in to 80 ms → once the pointer is idle, that tick watches the busy window
5. Theme change → rail.refreshColors() → eye.refreshColors() → redraw
6. Rail hidden (narrow, maximize) or disposed → eye.stop(): detach the canvas, clear the clock,
   remove the pointer listeners
```

"Awake" (80 ms) means the target is the pointer or activity, or the pupil is still more than half a cell (or the dilation more than 0.02) from its target. Drift alone never counts: the pupil follows the slow wander within half a cell, so a quiet eye stays at 420 ms. Lids run on rAF so a blink stays smooth (320 ms of frames).

Mockup: `.krypton/artifacts/hm-3/Claude-3/art-99-1c653210.html` runs this algorithm against a port of the real rail geometry.

### UI Changes

- **Position:** the eye lives on the focused window's card, and the wheel always rotates that card to the apex: the rail's vertical centre, with the card centre `arcX + 94` from the rail's left (232px on a 400px rail). On a 1728 × 1117 screen the card is 168 × 138 on screen and the eye about 146 × 66, centred in it. It leans with the card, so it is upright at rest and tilts only while the wheel turns. The caret and big label stay to its right.
- `<canvas class="krypton-wheel__eye">` fills the card. The card holding it gets `krypton-wheel__card--eye`, which hides the schematic. The canvas moves between cards by `appendChild`, and only the focused window's card ever has it.
- Grid: `cols = floor(0.88 × 112 / cw)`, where `cw` is the advance of the chrome font measured at 3.6px (about 45 columns); line height is 4px. `rows` = the odd number nearest `cols·cw·0.42 / 4`, capped at `0.7 × cardHeight / 4`. Glyphs are drawn centred in the card.
- Colours: white `rgba(accent, 0.45)` (the idle-card ink), iris `rgba(fg, 0.85)`, pupil bold `accent`, and the pupil box a full 1px `rgba(accent, 0.9)` rectangle (a full border, not corner ticks). While `alert` is set, every class and the box use `rgb(danger)`. Tab dots stay, drawn on the canvas at the schematic's positions.
- Reduced motion or animation style `none`: there is no clock. The eye is drawn once, open, with the pupil centred: no blink, no flinch, no text flow, and no pointer follow. It is redrawn only on mount, on a text change, or on a theme change.

### Configuration

None. The eye always replaces the active card's schematic.

## Implementation Notes

- The callbacks differ from the draft: `centre()` returns the card's `scale` and the eye derives its own on-screen half-size from its grid, and `ownActivity()` feeds the text flow. Colours and the font come in through `setStyle()`, which the rail calls from `refreshColors()` with the rail root's computed `font-family` and theme RGB variables.
- Four more pure helpers carry tested logic out of the class: `wheelEyeGrid`, `wheelEyeLid`, `wheelEyeText` (drops a title equal to the label), and `wheelEyeWatch` (the activity target pick).
- `mount()` is idempotent per card. A schematic repaint (`paintEntry`, run on every silhouette or title change) replaces the card's children, so the rail re-mounts the eye on the same card. That only re-attaches the canvas, with no open-blink.
- A fully closed lid leaves the centre row visible as a seam, as in the study (`|ny| > 0` blanks every other row).
- The pointer listener is on `window` in the capture phase, so a view that stops `pointermove` propagation cannot blind the eye.
- Verified in a browser against the real `WheelRail` and `wheel.css` (a temporary Vite page, since removed). The eye mounts on the focused card, the schematic is hidden there, the eye moves on focus change, and it follows the pointer and flinches red inside it. Idle, with no pointer and no output, the page measured about 8.7 rAF a second over 3 s, a window that included one blink. The installed app bundle has not been run.

## Edge Cases

| Case | Handling |
|------|----------|
| One window | Pointer first; then the eye looks right while the window writes, otherwise it drifts |
| Pointer leaves the window (`mouseleave` on the document) | The pointer target clears at once, and the eye falls back to activity or drift |
| Pointer over a native webview | Moves never arrive, so the eye keeps the last point, then falls back after 3.5 s |
| Mouse-wheel scroll before focus commits | The caret and big label follow the scroll; the eye stays on the focused window's card |
| Dock morph | The eye mounts on the new card at once and opens as the window flies out of it |
| Card height or DPR change (`setBounds`) | Re-measure `cw` and rows, resize the backing store, re-cache the rail's client rect, redraw |
| Empty label and title | Text falls back to `krypton ` |
| Busiest window off the visible arc | The gaze still points up or down along the orbit toward it |
| Leaving Wheel | `rail.dispose()` disposes the eye, its clock, and its listeners |

## Open Questions

None. Decisions taken: the pointer first, then activity, then drift; canvas, not `<pre>`; only the active card; no full-screen overlay (worm, line, reticle); no config.

## Out of Scope

The worm, the leader line and reticle, the study's controls and readouts, the eye on non-active cards, and the eye in other layouts.

## Resources

- `/Users/wk/Source/artirfact/Cursor study_ the watching eye.html` — the source algorithm (shape, classes, gaze, dilation, flinch, blink, text flow)
- [XEYES(1) manual page](https://www.x.org/releases/X11R7.5/doc/man/man1/xeyes.1.html) — prior art for pupils that follow the pointer
- [iTerm2 Appearance Preferences](https://iterm2.com/documentation-preferences-appearance.html) — tab activity and new-output indicators
- [tmux(1) man page](https://linux.die.net/man/1/tmux) — `monitor-activity`, `visual-activity`, and the `#` window flag
