# Prompt Dialog Typewriter Slip — Implementation Spec

> Status: Implemented (approved 2026-11-08: "อนุมัติ docs/0373-prompt-dialog-typewriter-slip.md ตามข้อเสนอทั้งหมด (Return ขึ้นบรรทัดใหม่, ⌘Enter ส่ง, เฉพาะช่องพิมพ์เป็นกระดาษ) แล้วลงมือแก้โค้ด")
> Date: 2026-11-08
> Milestone: ACP Harness — input
> Builds on: 0061 (Smart Prompt Dialog) · 0372 (harness lane targets) · 0366 / ADR-0030 (console faceplate) · 0369 (key caps)
> Design source: `/Users/wk/Design/Ribbon TTY.html` (the "slip" sheet, rail and carriage)
> Amended 2026-11-08: no target picker. `Tab` / `⇧Tab` step the target chip ([0061](./0061-smart-prompt-dialog.md)); the foot reads `⌘Enter send` · `Enter newline` · `Tab/⇧Tab target` · `Esc close`.
> Amended 2026-11-08 (B): the whole dialog is the sheet of paper. The user asked for the paper to cover the whole dialog ("I want the prompt dialog background cover the hold dialog"), reversing the rejected *whole dialog as paper* alternative. See [Amendment B](#amendment-b-the-whole-dialog-is-the-sheet).
> Amended 2026-11-08 (C): faster strike and ink. The user saw too much delay between the typebar and the letter: the design's afterimage covered the textarea's own letter with paper and kept it clear until 45% of 210ms (about 95ms). The strike is now 70ms (peak about 26ms), the ink lands solid at 22% of 120ms (about 26ms, the strike's peak) and is gone at 120ms, and the green LED flashes 70ms. The carriage, rail and lamp transitions are unchanged.
> Amended 2026-11-08 (D): the ink lands on the paper it covers. The user saw a square box behind each newly typed letter and a second copy of Thai upper vowels beside the real one. The afterimage now copies the whole grapheme cluster at the textarea's own glyph position and its paper patch carries the sheet's grain, registered to the sheet. See [Amendment D](#amendment-d-the-ink-lands-on-the-paper-it-covers).

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
and `⌘Enter` sends. Everything else on the plate — target chip, image strip, key-cap foot —
stays faceplate chrome. *(Superseded by amendment B: the paper covers the whole dialog; the head and
foot are print on it.)*

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
  key caps for chrome that is not the document. Rejected at first; adopted by amendment B at the
  user's request, keeping the key caps and the target lamp as faceplate parts.
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
part with a moving carriage, and the whole dialog is the sheet (amendment B). Krypton keeps the
keyboard model of a code tool (`⌘Enter` to send) and the user's configured key sounds.

## Affected Files

| File | Change |
|------|--------|
| `src/prompt-dialog.ts` | Slip DOM (kicker, fx layer, rail, carriage, lamp); Return feeds / `⌘Enter` sends; input → strike, afterimage, sound, bell; caret → carriage sync; LEDs from state; autoGrow 10–18 lines; amendment B: the `@` popup opens clear of the carriage |
| `src/prompt-dialog-typewriter.ts` | New: `Typewriter` — owns rail, carriage, fx and lamp nodes; `sync(kind)`, `strike(index)`, `setLeds()`, grain texture; amendment B: the lamp and grain sit on the panel (the sheet) and `relight()` inks the head and foot; amendment D: `inkRange()` and the registered patch + type copy |
| `src/prompt-dialog-typewriter.test.ts` | Amendment B: `lampReach` and the lit / dark split of the head and foot; amendment D: `inkRange()` cluster widening |
| `src/caret-position.ts` | Amendment D: `getTextRangeBox()`, the unrounded box of a text range, sharing the caret mirror |
| `src/compositor.ts` | None — the dialog uses the existing public `soundEngine` getter |
| `src/styles/overlays.css` | Plate size; `.krypton-prompt-dialog__slip` block (paper, kicker, margin rule, textarea ink, rail, carriage, LEDs, afterimage, lamplight, reduced motion); amendment B: the paper, its tokens and the lamplight move to `.krypton-prompt-dialog__panel`, the chip and foot are print; amendment D: the ink is the sheet's paper and grain plus `__ink-type` |
| `DESIGN.md` | "Overlays and dialogs": the prompt dialog's slip is the one paper surface (spec 373); amendment B: the whole dialog is that paper (2.3.1) |
| `docs/0061-…`, `docs/0372-…`, `docs/0005-data-flow.md`, `docs/README.md` | Amended-by lines and key tables (`⌘Enter` sends, Enter newline); data-flow step; index |

## Design

### Data Structures

```typescript
// src/prompt-dialog-typewriter.ts
type CarriageMove = 'type' | 'cr' | 'back' | 'still';

export class Typewriter {
  // Amendment B: `sheet` is the dialog panel — it carries the grain, the lamp and `data-move`.
  constructor(sheet: HTMLElement, slip: HTMLElement, textarea: HTMLTextAreaElement, onBell: () => void);
  show(): void;   // on open: paper grain, measure the type, park the carriage
  hide(): void;   // on close
  /** Move rail + carriage under the caret line on the next frame; without a
   *  move, the direction of travel picks it. After a strike, the placement also
   *  rings `onBell` once per visual row when the caret passes 86% of the line. */
  sync(kind?: CarriageMove): void;
  /** Typebar strike + afterimage of the grapheme cluster the text typed at `index` belongs to
   *  (amendment D: a Thai mark inks its consonant's cell). */
  strike(index: number, grapheme: string): void;
  setLeds(state: { queue: boolean; error: boolean }): void;
  /** Amendment B: the head or foot was re-rendered; ink its print for the lamp on the next frame. */
  relight(): void;
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
4. strike(): restart the stalk/head animation, flash the green LED 70ms (amendment C), append one ink
   (paper patch + type copy) over the typed grapheme cluster (amendment D), removed on animationend.
5. renderFooter() (the state funnel) → setLeds: amber lit when Enter would queue (lane busy),
   red lit while the error line shows.
6. Amendment B: each placement (and relight() after renderChip / renderFooter) reads where every
   head and foot part sits against the lamp and marks it `__lit` when it is inside 0.6 of the lamp's
   reach; reads first, then writes, in the same frame.
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `⌘Enter` | Slip | Send (queue on a busy lane) |
| `Enter` / `Shift+Enter` | Slip | Feed a line (newline) |
| `Enter` / `Tab` | `@` popup open | Accept completion (unchanged) |
| `Tab` / `⇧Tab` | Slip, no `@` completion showing | Step the target chip (0061); the caret stays |
| `Esc` | — | Unchanged |

Foot: `⌘Enter send` (or `queue`) · `Enter newline` · `Tab/⇧Tab target` (two or more targets) · `Esc close`, as key caps.

### UI Changes

- Plate: `width: min(1040px, 92vw)`, `max-height: 86vh`, centred vertically and horizontally on the
  scrim (it grows about its centre as the slip grows).
- `.krypton-prompt-dialog__slip` (block owned by this dialog): paper `--prompt-paper` `#f1ecdf`,
  ink `--prompt-ink` `#24211d`, kicker ink `--prompt-paper-ink` `#6b6358` (declared on the slip, so a
  theme `[tokens]` can override them, spec 303); a 384px grain texture generated once on first open;
  a 1px red margin rule; `padding-bottom` that keeps the carriage on the sheet when the caret is on
  the last line; `overflow: hidden` (amendment B: never clipped, so the typewriter always shows
  whole).
- Kicker: `prompt` · target name (`untitled` with no target) · `N lines`, 12px, 0.12em tracking.
- Textarea: transparent, 17px in the configured `[font] family` (`var(--krypton-font-family)`, set on
  the slip and inherited), line-height 1.45, ink text-shadow `0 0 .5px currentColor`; no visible
  caret (`caret-color: transparent`, as the design's transparent xterm cursor): the typebar head over
  the next cell is the caret. 10 lines minimum, grows to 18 or to what fits in the plate's 86vh, then
  scrolls (scrollbar hidden as on the design).
- Rail, carriage (blue skin), stalk/head strike, LEDs (lens glow only when lit), `.inkfx` — the
  design's values, BEM-named under the slip; amendment C shortens the strike to 70ms and the ink to
  120ms; amendment D splits the ink into a still paper patch and a dropping type copy.
- Lamplight: under `html[data-theme-scheme='dark']` the slip shows the design's lamp (multiply) and
  flare (screen) layers, moved with the carriage; kicker ink `#cdb58f`.
- `prefers-reduced-motion`: no strike, no afterimage, carriage moves without transition.
- Amendment B overrides the plate and slip lines above where they differ; see below.

## Edge Cases

- **Thai combining marks** (สระบน, วรรณยุกต์): `insertText` of a mark does not move the carriage (the
  caret does not advance). Amendment D: its afterimage is the whole cluster (consonant + marks) at the
  consonant's cell, where the textarea draws the mark, with no extra width.
- **Paste or image token insert**: carriage moves, no per-char strike or sound.
- **Caret line scrolled out of view**: `getCaretCoordinates` subtracts `scrollTop`; the carriage is
  clamped to the slip, and the textarea scrolls the caret into view on input as it does natively.
- **`@` popup open**: the popup keeps Enter/Tab; the carriage keeps tracking.
- **`[sound] enabled = false` or `keyboard_type = "none"`**: silent; the Rust engine decides.
- **Narrow window**: `92vw` wins; the carriage centres on the caret. Since amendment B it is never
  clipped: at the margins it overhangs the sheet, border included.
- **`@` popup near the carriage** (amendment B): the popup opens below the carriage, or above the
  caret's line when the screen has no room below, so it never covers the typewriter.
- **Short screen**: the textarea's max height follows the plate's `86vh`, so the foot never leaves the
  screen.
- **Dark scheme, head or foot far from the lamp** (amendment B): one ink cannot read on both the lit
  and the dark paper, so each part is inked for where it sits. Right at the 0.6 boundary both inks
  read at about 2.8:1; the part flips as soon as the carriage moves past it.

## Open Questions

None.

## Out of Scope

- The design's shell, teletype output, `top`, file system, paper colours and carriage skins (one
  look: cream paper, blue carriage).
- The SVG ink displacement filter.
- Bundled fonts.
- Typewriter-style editing limits ("typewriters only move forward"): arrows, selection and delete
  work as in any textarea.
- Restyling the `@` popup or the image thumbnails. The target chip and foot are restyled as print by
  amendment B.

## Amendment B: the whole dialog is the sheet

> 2026-11-08. Requested by the user: "I want the prompt dialog background cover the hold dialog".

**Problem.** The slip sat inside a 10px faceplate frame, with the target chip above and the key-cap
foot below on graphite, so the paper read as a card on a plate.

**Change.**

- **The panel is the paper.** `.krypton-prompt-dialog__panel` carries the paper fill, the grain
  (`--prompt-grain`, set on the panel by `Typewriter.show()`), the tokens `--prompt-paper`,
  `--prompt-ink`, `--prompt-paper-ink` and `--prompt-rule`, and `isolation: isolate`. Its border and
  cast shadow stay, so drag-over and the rejected-submit shake still light the edge. The slip has no
  fill, radius or shadow of its own; it is the typing area (kicker, margin rule, textarea, rail,
  carriage).
- **The lamp covers the sheet.** The lamp and flare layers are children of the panel (`inset: 0`,
  `overflow: hidden`, the panel's radius), placed at the slip's offset plus the caret, so the light
  falls across the head and foot too. `data-move` moves from the slip to the panel, which is where
  the transition selectors read it.
- **The typewriter shows whole.** The slip never clips (no `overflow`) and has no stacking
  context, so at the left or right margin the carriage overhangs the sheet and its border instead of
  being cut. The carriage is the topmost part of the dialog (`z-index` 8): above the lamplight, the
  head, the foot and the `@` popup (`z-index` 7). The rail sits above the lamplight too
  (`z-index` 6), so neither part darkens at the sheet's edges. The `@` popup opens below the
  carriage (`CARRIAGE_CLEARANCE`, rail gap plus half the carriage), or above the caret's line when
  the screen has no room below, so it never sits over the typewriter.
- **Head and foot are print.** The target chip, foot and image strip sit above the lamp
  (`z-index` 6), so the target lamp, the key caps and the thumbnails are never darkened. The chip label and cwd use `--prompt-print-strong`, its meta, pid and the foot's
  legends `--prompt-print`; the chip's groove becomes a `--prompt-rule` line and the `1/2` readout a
  ruled box instead of a well. Key caps stay faceplate keys (spec 369).
- **Inks under lamplight.** In the light scheme there is no lamp and both print tokens fall back to
  the paper's dark inks. In the dark scheme the panel sets pale inks (`#e3cfa9`, `#cdb58f`), and a
  part the lamp lights (inside `LIT_REACH` 0.6 of the lamp ellipse, 520 × 360 px) is marked
  `.krypton-prompt-dialog__lit` and takes the dark inks (`--prompt-ink`, `#3a342c`). On the
  multiplied paper the two inks' contrasts cross near 0.6.

**Identity.** ADR-0030's exception was the document being written. The user extends it to the
dialog that holds that document: the dialog is the sheet. The faceplate parts that remain on it are
parts, not chrome fill: key caps and lamps. ADR-0030's enforced rules still hold (no `--mat-*`
declared, no new glow, no infinite animation).

## Amendment D: the ink lands on the paper it covers

> 2026-11-08. Reported by the user with a screen recording: "when typing the background under
> character have square box, the make the background not smooth", "I see same character as a
> shadow", "thai upper vowel have not match typewriter position".

**Problem.** Three faults in the afterimage, all visible for its 120ms:

- The patch that hides the textarea's own letter was a flat `--prompt-paper` box, but the sheet is
  that colour multiplied by the grain, so every typed key left a lighter, smooth rectangle on the
  textured paper.
- The copy sat in a `charW`-wide cell, centred, with `line-height: normal`, at the caret position
  `getCaretCoordinates` rounds to whole pixels. A Thai glyph (fallback font, proportional width) or
  any glyph whose cell did not match landed a little off the real one, so when the patch faded both
  showed: a second letter, read as a shadow.
- A Thai mark is typed as its own `insertText`. Its index is after the consonant, so the copy drew
  the mark alone in the empty cell after it, while the textarea draws it over the consonant.

**Change.**

- **One cluster.** `inkRange()` (`src/prompt-dialog-typewriter.ts`) widens the typed text to the
  grapheme clusters it belongs to (`Intl.Segmenter`, grapheme granularity), so a mark inks its
  consonant's cell and a consonant typed in front of a mark takes the mark along.
- **The textarea's own position.** `getTextRangeBox()` (`src/caret-position.ts`, the caret mirror
  without rounding) gives the cluster's inline box. The copy has the textarea's font size,
  line-height, `white-space: pre` and ink text-shadow, and is placed on that box's line, so once it
  lands it covers the textarea's glyphs exactly.
- **Paper cut from the sheet.** `.krypton-prompt-dialog__ink` paints the panel's background (grain
  multiplied over `--prompt-paper`). `strike()` starts the patch on a whole sheet pixel and sets
  `background-position` to minus that pixel, so its grain is the sheet's grain pixel for pixel; the
  copy (`.krypton-prompt-dialog__ink-type`) is padded the remaining fraction in.
- **Only the type drops.** The patch stays still and fades over the last 30%
  (`krypton-prompt-ink-paper`); the copy keeps the amendment C landing (`krypton-prompt-ink`:
  blurred and 0.16em high, solid at 22%).

Timings, carriage, rail, lamp and sounds are unchanged. A mark still does not move the carriage: the
typebar head stays over the next empty cell, as on a Thai typewriter whose mark keys do not
advance, while the mark's ink lands over its consonant.

## Resources

- `/Users/wk/Design/Ribbon TTY.html` — the slip, rail, carriage, strike, afterimage, lamplight and key model.
- [iA Writer — Write With Focus](https://ia.net/writer/how-to/write-with-focus) — Focus Mode and the Typewriter option (caret line centred).
- [Ulysses — Customize the Editor](https://help.ulysses.app/en_US/dive-into-editing/editor-customization-guide) — typewriter settings: line marker, fixed scrolling.
- [MDN — InputEvent.inputType](https://developer.mozilla.org/en-US/docs/Web/API/InputEvent/inputType) — `insertText` / `insertLineBreak` / `deleteContentBackward` / `insertFromPaste` drive strike vs. move.
