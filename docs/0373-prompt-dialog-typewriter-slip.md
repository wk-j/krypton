# Prompt Dialog Typewriter Slip — Implementation Spec

> Status: Implemented (approved 2026-11-08: "อนุมัติ docs/0373-prompt-dialog-typewriter-slip.md ตามข้อเสนอทั้งหมด (Return ขึ้นบรรทัดใหม่, ⌘Enter ส่ง, เฉพาะช่องพิมพ์เป็นกระดาษ) แล้วลงมือแก้โค้ด")
> Date: 2026-11-08
> Milestone: ACP Harness — input
> Builds on: 0061 (Smart Prompt Dialog) · 0372 (harness lane targets) · 0366 / ADR-0030 (console faceplate) · 0369 (key caps)
> Design source: `/Users/wk/Design/Ribbon TTY.html` (the "slip" sheet, rail and carriage)

## Problem

The Smart Prompt Dialog is now the place to write long, multi-line prompts for Claude terminals and
Harness lanes, but it is still a 640px plate with a 3–12 line input well (`overlays.css:307-322`,
`prompt-dialog.ts` `autoGrow`). The user asked for a larger dialog that writes like the Ribbon TTY
typewriter: a paper slip, a steel rail under the line being typed, and a carriage whose typebar strikes
each key.

## Solution

The dialog plate grows to `min(1040px, 92vw)`. The input well becomes a **slip**: a sheet of paper
inside the plate, with a kicker line (`prompt · <target> · N lines`), the margin rule, and the Ribbon
TTY rail and carriage riding under the caret's line. Each typed key strikes the typebar, leaves a
one-shot ink afterimage at the typed cell and plays the user's configured key sound; crossing 86% of
the line rings the margin bell. The editor stays a native `<textarea>`, so Thai input, selection,
undo, paste and `@` completion keep working unchanged. As on the design's slip, Return feeds a line
and `⌘Enter` sends. Everything else on the plate — target chip, picker, image strip, key-cap foot —
stays faceplate chrome.

## Research

- **Design file.** The slip (`Ribbon TTY.html:345-363`, `openSlip`/`slipType` :815-930) is a
  custom grid of `<i>` cells fed by xterm `onData`; the carriage position comes from the slip's row
  and column (`slipGeom` :793). Rail: 12px steel gradient with end caps; carriage: a 108×34 pill with
  three LEDs on a stalk whose head strikes (`strike` 110ms). Afterimage: an `.inkfx` span that fades
  in 210ms. Sounds are WebAudio clicks. Return feeds a line; `⌘↩` files the slip; Esc returns it.
  Dark mode is "lamplight": a warm radial light that follows the carriage, multiplied over the paper.
  Fonts load from Google Fonts (Courier Prime, IBM Plex Sans Thai Looped).
- **Native textarea instead of the design's cell grid.** The cell grid has no IME, selection, undo,
  or `selectionStart`, and the dialog's `@` popup (`updateMentionState`) and image tokens depend on
  textarea selection. `src/caret-position.ts` already gives the caret's pixel position inside a
  textarea (mirrored div, scroll-adjusted), which is all the carriage needs.
- **Sound.** `src/sound.ts` is the only sound path and says "No Web Audio API usage"; it exposes
  `playKeypress('press', key)` (the user's `[sound] keyboard_type`, repeat-suppressed) and the
  `terminal.bell` event. The compositor's one `SoundEngine` is already public as
  `Compositor.soundEngine` (`compositor.ts:2379`).
- **Fonts.** Krypton's own stylesheets declare no `@font-face`; app families are user-installed
  (spec 0372's SVG fonts embed installed families), and the only bundled font files come with
  Excalidraw. The slip types in the user's `[font] family` (`--krypton-font-family`), like every
  other Krypton surface, instead of the design's Courier Prime / Plex Thai stack.
- **Ink filter.** The design runs an SVG `feTurbulence` + `feDisplacementMap` filter over the page.
  On a live textarea that re-rasterises the whole element on every keystroke, against the
  keypress-to-render < 16ms constraint (AGENTS.md #8). The text-shadow ink bleed carries most of the
  look at no cost.
- **Identity.** ADR-0030 makes the faceplate the only in-app identity; a sibling aesthetic "needs a
  reason that is not taste (a separate document, or a surface that is not chrome)". The slip is the
  document being written, not chrome, so it is the narrow exception; the plate around it does not
  change. DESIGN.md "Motion" bans ambient effects, vignette included: the design's static edge
  shading is dropped, and the dark-scheme lamplight moves only when the carriage moves. No animation
  is `infinite`.
- **Keys.** `handleTextareaKey` sends on `Enter`, newline on `Shift+Enter`, force-sends on `⌘Enter`
  (`prompt-dialog.ts:735-752`). A sheet for several lines that sends on Return sends half-written
  prompts; the design's slip feeds a line on Return for that reason.

**Alternatives considered**
- *The whole dialog as paper* (chip, picker and foot on the sheet too): breaks ADR-0030 and spec 369
  key caps for chrome that is not the document. Rejected.
- *Port the cell grid*: loses IME (Thai), selection, undo and the `@` popup. Rejected.
- *WebAudio clicks from the design*: a second sound path beside the Rust engine. Rejected.
- *The design's Courier Prime / Plex Thai stack* (bundled, or used when installed): a dialog font that
  ignores `[font] family`, the only one in the app. Rejected; the slip uses the configured family.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Ribbon TTY (design) | Slip sheet, rail + carriage following the cursor, typebar strike, ink afterimage, margin bell, lamplight | Source of this look |
| iA Writer | Focus Mode greys all but the current sentence; the Typewriter option keeps the caret line vertically centred | Typewriter = the line you type stays put |
| Ulysses | Typewriter settings: line marker under the current line, fixed scrolling at top/middle/bottom | Marker under the active line, like the rail |

**Krypton delta**: like Ulysses' line marker, the rail marks the active line, but it is a physical
part with a moving carriage, and the sheet sits inside the instrument plate. Krypton keeps the
keyboard model of a code tool (`⌘Enter` to send) and the user's configured key sounds.

## Affected Files

| File | Change |
|------|--------|
| `src/prompt-dialog.ts` | Slip DOM (kicker, fx layer, rail, carriage, lamp); Return feeds / `⌘Enter` sends; input → strike, afterimage, sound, bell; caret → carriage sync; LEDs from state; autoGrow 10–18 lines |
| `src/prompt-dialog-typewriter.ts` | New: `Typewriter` — owns rail, carriage, fx and lamp nodes; `sync(kind)`, `strike(index)`, `setLeds()`, grain texture |
| `src/compositor.ts` | None — the dialog uses the existing public `soundEngine` getter |
| `src/styles/overlays.css` | Plate size; `.krypton-prompt-dialog__slip` block (paper, kicker, margin rule, textarea ink, rail, carriage, LEDs, afterimage, lamplight, reduced motion) |
| `DESIGN.md` | "Overlays and dialogs": the prompt dialog's slip is the one paper surface (spec 373) |
| `docs/0061-…`, `docs/0372-…`, `docs/0005-data-flow.md`, `docs/README.md` | Amended-by lines and key tables (`⌘Enter` sends, Enter newline); data-flow step; index |

## Design

### Data Structures

```typescript
// src/prompt-dialog-typewriter.ts
type CarriageMove = 'type' | 'cr' | 'back' | 'still';

export class Typewriter {
  constructor(slip: HTMLElement, textarea: HTMLTextAreaElement, onBell: () => void);
  show(): void;   // on open: paper grain, measure the type, park the carriage
  hide(): void;   // on close
  /** Move rail + carriage under the caret line on the next frame; without a
   *  move, the direction of travel picks it. After a strike, the placement also
   *  rings `onBell` once per visual row when the caret passes 86% of the line. */
  sync(kind?: CarriageMove): void;
  /** Typebar strike + afterimage of the grapheme that starts at `index`. */
  strike(index: number, grapheme: string): void;
  setLeds(state: { queue: boolean; error: boolean }): void;
}
```

### Data Flow

```
1. open(): the plate shows the slip; Typewriter.sync('still') parks the carriage under the caret.
2. Key in the textarea:
   a. ⌘Enter → submit (send or queue, 0372). Enter / Shift+Enter → native newline. With the @
      popup open, Enter / Tab still accept the completion.
   b. input event, by inputType:
      insertText (data ≤ 2 chars) → strike(selectionStart - data.length, data),
        playKeypress(key), sync('type') — whose placement rings terminal.bell past 86%;
      insertLineBreak → playKeypress('Enter'), sync('cr');
      deleteContent* → playKeypress('Backspace'), sync('back');
      insertFromPaste / drop / anything else → sync() only (no strike per pasted char, as the design).
3. sync(): one rAF; getCaretCoordinates(textarea, selectionStart) → rail at line bottom + 40px,
   carriage centred on the caret x; the class picks the move transition (type 90ms, cr 320ms,
   back 70ms, still none). Also on click, arrow keys (keyup), scroll and resize.
4. strike(): restart the stalk/head animation, flash the green LED 110ms, append one `.inkfx`
   span at the cell (removed on animationend).
5. renderFooter() (the state funnel) → setLeds: amber lit when Enter would queue (lane busy),
   red lit while the error line shows.
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `⌘Enter` | Slip | Send (queue on a busy lane) |
| `Enter` / `Shift+Enter` | Slip | Feed a line (newline) |
| `Enter` / `Tab` | `@` popup open | Accept completion (unchanged) |
| `Esc`, `⌘,`, picker keys | — | Unchanged |

Foot: `⌘Enter send` (or `queue`) · `Enter newline` · `⌘, switch target` · `Esc close`, as key caps.

### UI Changes

- Plate: `width: min(1040px, 92vw)`, `max-height: 86vh`, centred vertically and horizontally on the
  scrim (it grows about its centre as the slip grows).
- `.krypton-prompt-dialog__slip` (block owned by this dialog): paper `--prompt-paper` `#f1ecdf`,
  ink `--prompt-ink` `#24211d`, kicker ink `--prompt-paper-ink` `#6b6358` (declared on the slip, so a
  theme `[tokens]` can override them, spec 303); a 384px grain texture generated once on first open;
  a 1px red margin rule; `padding-bottom` that keeps the carriage on the sheet when the caret is on
  the last line; `overflow: hidden`.
- Kicker: `prompt` · target name (`untitled` with no target) · `N lines`, 12px, 0.12em tracking.
- Textarea: transparent, 17px in the configured `[font] family` (`var(--krypton-font-family)`, set on
  the slip and inherited), line-height 1.45, ink text-shadow `0 0 .5px currentColor`; no visible
  caret (`caret-color: transparent`, as the design's transparent xterm cursor): the typebar head over
  the next cell is the caret. 10 lines minimum, grows to 18 or to what fits in the plate's 86vh, then
  scrolls (scrollbar hidden as on the design).
- Rail, carriage (blue skin), stalk/head strike, LEDs (lens glow only when lit), `.inkfx` — the
  design's values, BEM-named under the slip.
- Lamplight: under `html[data-theme-scheme='dark']` the slip shows the design's lamp (multiply) and
  flare (screen) layers, moved with the carriage; kicker ink `#cdb58f`.
- `prefers-reduced-motion`: no strike, no afterimage, carriage moves without transition.

## Edge Cases

- **Thai combining marks** (สระบน, วรรณยุกต์): `insertText` of a mark strikes at the base cell; no
  extra afterimage width.
- **Paste or image token insert**: carriage moves, no per-char strike or sound.
- **Caret line scrolled out of view**: `getCaretCoordinates` subtracts `scrollTop`; the carriage is
  clamped to the slip, and the textarea scrolls the caret into view on input as it does natively.
- **`@` popup open**: the popup keeps Enter/Tab; the carriage keeps tracking.
- **`[sound] enabled = false` or `keyboard_type = "none"`**: silent; the Rust engine decides.
- **Narrow window**: `92vw` wins; the carriage centres on the caret and is clipped by the slip.
- **Picker open**: the carriage parks (`still`); keys go to the picker as today.
- **Short screen**: the textarea's max height follows the plate's `86vh`, so the foot never leaves the
  screen.

## Open Questions

None.

## Out of Scope

- The design's shell, teletype output, `top`, file system, paper colours and carriage skins (one
  look: cream paper, blue carriage).
- The SVG ink displacement filter.
- Bundled fonts.
- Typewriter-style editing limits ("typewriters only move forward"): arrows, selection and delete
  work as in any textarea.
- Restyling the target chip, picker, `@` popup, image strip or foot.

## Resources

- `/Users/wk/Design/Ribbon TTY.html` — the slip, rail, carriage, strike, afterimage, lamplight and key model.
- [iA Writer — Write With Focus](https://ia.net/writer/how-to/write-with-focus) — Focus Mode and the Typewriter option (caret line centred).
- [Ulysses — Customize the Editor](https://help.ulysses.app/en_US/dive-into-editing/editor-customization-guide) — typewriter settings: line marker, fixed scrolling.
- [MDN — InputEvent.inputType](https://developer.mozilla.org/en-US/docs/Web/API/InputEvent/inputType) — `insertText` / `insertLineBreak` / `deleteContentBackward` / `insertFromPaste` drive strike vs. move.
