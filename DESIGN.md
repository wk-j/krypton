---
name: Krypton Console
version: 2.2.0
description: Skeuomorphic instrument faceplate — brushed graphite (aluminium in the light scheme) with engraved labels, recessed display wells, raised keys and lit lamps, over a transparent desktop
appliesTo: "Every surface in the Tauri webview and the live-assist webview. Materials: src/styles/materials.css (--mat-*)."
colors:
  primary: "#ffb000"       # silk: engraved label fill, --mat-silk (light: #6e4700)
  lit: "#ffd880"           # lit legend (colour only, no glow), --mat-lit (light: #6e4700)
  plateTop: "rgba(46, 49, 56, 0.9)"
  plateBottom: "rgba(23, 25, 30, 0.9)"
  wellFill: "rgba(9, 10, 14, 0.78)"
  keyFace: "rgba(55, 58, 66, 0.95)"
  select: "rgba(255, 176, 0, 0.16)"
  foreground: "#b0c4d8"    # theme ink (krypton-dark), --krypton-fg
  accent: "#0cf"           # theme accent (krypton-dark): cursor, links, window LEDs, window focus ring
  screen: "rgba(6, 10, 18, 0.5)"   # --mat-screen = theme backdrop at [visual] opacity
  lampPass: "rgb(57, 255, 127)"    # --krypton-success-rgb
  lampFault: "rgb(255, 58, 92)"    # --krypton-danger-rgb
  lampWarn: "rgb(232, 197, 71)"    # --krypton-warning-rgb
  keyRunning: "#6dd0ff"
  keyDone: "#a8ffbf"
typography:
  label:
    fontFamily: "Mononoki, JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"                 # --krypton-chrome-font-size; uppercase, engraved
    fontWeight: 600
    letterSpacing: "0.13em"
  legend:
    fontFamily: "Mononoki, JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"                 # printed on a key
    letterSpacing: "0.09em"
  body:
    fontFamily: "Mononoki, JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    letterSpacing: "0em"
  readout:
    fontFamily: "Mononoki, JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"                 # tabular-nums, mandatory on every changing digit
rounded:
  part: "8px"        # windows, panels, wells, keys, lamp windows, readouts (--krypton-border-radius)
  tab: "6px"         # selector keys inside an 8px channel
  capsule: "999px"   # status lamps, tags, chips; LEDs stay 50% circles
  flush: "0px"       # interior panes that meet an edge: the dock column, the harness composer
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "28px"
motion:
  press: "a held key sinks 1px with an inset shadow (:active); no transition"
  layout: "WAAPI transform/opacity for window morph, workspace slide, entrance"
  ambient: "none — lamps glow steadily; only text carets and terminal cursors blink"
forbidden:
  - "backdrop-filter: blur()"
  - "fully opaque plate (max alpha 0.94; a narrow overlay adds a solid underlay)"
  - "infinite or decorative animation: pulses, sweeps, shimmers, orbits, scanlines, vignettes"
  - "glow on anything but a lamp, an LED lens or the terminal progress ring's arc: legends, labels and titles never glow (the one exception is the composer bloom's one-shot afterimage flash)"
  - "box-shadow, text-shadow or gradient on a repeated row (transcript row, diff line, list row)"
  - "a button taller than one line: a key's state badge sits beside its label or is dropped"
  - "left-edge accent rails for selection (ADR-0027)"
  - "L-shaped corner brackets or screw-head ornaments"
  - "a keyboard shortcut written as text (`[a] accept`, `esc close`) where a key cap can be drawn"
  - "colouring model findings as pass/fail (ADR-0004)"
  - "declaring --mat-* anywhere but src/styles/materials.css"
  - "raster textures; the brush is a CSS gradient"
---

# Krypton Console

## Overview

Krypton is a keyboard-driven terminal emulator dressed as a piece of instrument hardware: every
window is a brushed faceplate with a display set into it, labels engraved into the metal, what a
surface *shows* behind recessed glass, what it *does* on keys you could press, and its state on lamps.
The desktop still shows through the screens and, faintly, through the plates.

The rule that keeps it readable: **material carries role, colour carries state.** Plate, well and key
say what a thing is (label, display, control). Colour says only what the ADRs allow it to say.

Content stays flat. The terminal grid, prose, code, diffs, canvases and documents sit in wells as plain
text on the screen fill: texture there would cost legibility where the user reads most.

## Materials

Every part reads one set of `--mat-*` custom properties declared once, on the document root, in
`src/styles/materials.css`: graphite in `krypton.base`, brushed aluminium in `krypton.scheme` under
`html[data-theme-scheme='light']`. Component and view sheets read them and never declare them.

Gradient tokens are composed from colour-stop tokens on the root (`--mat-plate-hi/mid/lo` →
`--mat-plate`), so a theme's `[tokens]` table (spec 303) can recolour any material: it is applied
inline on `<html>`, beats the sheet, and the composed gradients re-resolve with its stops.

| Token | Role |
|---|---|
| `--mat-plate`, `--mat-brush` | The faceplate: top-lit graphite at 0.9 alpha under a faint (under 1%) vertical brush |
| `--mat-bevel-hi/lo` | The plate's lit inner edge and the dark seam where it meets what is next to it |
| `--mat-well`, `--mat-well-fill` | A recessed display: gradient for a standalone well, flat fill for a well cut into rows |
| `--mat-well-depth/wall/lip`, `--mat-well-shadow` | Inner top shadow, 1px wall, light lip under the bottom edge |
| `--mat-groove-lo/hi` | An etched line: dark cut plus the light edge below it |
| `--mat-key`, `--mat-key-hover`, `--mat-key-down` | Key faces: resting, hovered, held or latched |
| `--mat-key-edge`, `--mat-key-raise`, `--mat-key-sunk` | Key outline, raised stack, pressed stack |
| `--mat-engrave`, `--mat-print` | Text cut into the plate; legend printed on a key |
| `--mat-silk`, `--mat-lit`, `--mat-lit-glow` | Amber label fill; lit legend (colour only, no glow); `--mat-lit-glow` is kept for one effect only, the composer bloom's one-shot afterimage flash |
| `--mat-lens-off/on`, `--mat-lens-glow`, `--mat-glint` | Amber LED unlit / lit, its glow, the specular glint every lens starts from |
| `--mat-select` | The full-row selection tint |
| `--mat-scrim`, `--mat-cast` | The dimmer behind a modal plate; the one shadow a floating plate casts |
| `--mat-screen` | The display behind the bezel: the theme backdrop with `[visual] opacity` applied |

A custom property that references another resolves where it is declared, so a component cannot
re-tint a composed token by overriding one stop on its own element. A coloured lamp spells its own lens
from `--mat-glint` and its state colour (see Lamps).

## Parts

Every surface is assembled from these. The recipes are the contract; deviate only with a reason in a
comment.

- **Plate.** `background: var(--mat-brush), var(--mat-plate)`, a 1px `--mat-key-edge` border on
  free-standing panels, and `inset 0 1px 0 var(--mat-bevel-hi)` on its lit edge. A plate strip that
  meets the screen (titlebar, tab bar, footer, toolbar, status bar) takes a border on that one side
  only. A floating plate (overlay, dialog, toast, picker) adds `var(--mat-cast)` and nothing else
  outside it. Brush only on plates — never on a well, a screen or a repeated row.
- **Engraving.** Headings, section and column labels, the window title: `--mat-silk` (or an ink tier
  for secondary labels), uppercase, label typography, `text-shadow: var(--mat-engrave)`. Engraving
  sits on the plate, never inside a well.
- **Well.** `background: var(--mat-well); box-shadow: var(--mat-well-shadow); border-radius: 8px`,
  inset at least 8px from the plate edge on panels. A run of sibling rows forms one well without a
  wrapper: the first slice carries the top shadow and corners, the last the bottom wall and lip, the
  rows between are split by grooves (`border-bottom: 1px solid var(--mat-groove-lo)`). A well inside
  a row (an expanded detail, a tag) is a deeper recess. Inputs are wells; their caret is the theme
  cursor colour.
- **Screen.** The display a window or lane exists to show: `background: var(--mat-screen)` with the
  well's inset depth drawn inside the existing box, so the terminal cell grid never shrinks.
- **Key.** One line, `min-height` 28px (24px in dense rows), `border: 1px solid var(--mat-key-edge)`,
  `border-radius: 8px`, `background: var(--mat-key)`, `box-shadow: var(--mat-key-raise)`, ink legend
  with `text-shadow: var(--mat-print)`. Hover: `--mat-key-hover`. Held (`:active`) or latched
  (`aria-pressed="true"`, `--active`): `--mat-key-down` + `--mat-key-sunk`, legend `--mat-lit` with no
  glow. Running action: latched and backlit cyan (`#6dd0ff`); done: raised and backlit green
  (`#a8ffbf`) — the key face is lit, the legend takes the colour without a glow. Disabled: unpowered
  at 0.45 opacity, except a running key. A state badge sits
  after the label behind an etched divider; it is cut first, and a key under 128px drops it.
- **Key cap.** A keyboard shortcut drawn in text is a `<kbd>` built by `src/ui/kbd.ts`, styled by the
  one rule in `src/styles/kbd.css`: inline, `padding: 0 4px`, `border: 1px solid var(--mat-key-edge)`,
  `border-radius: 4px`, `background: var(--mat-key)`, `box-shadow: var(--mat-key-raise)`, legend
  `--mat-lit` with `text-shadow: var(--mat-print)` at 0.92em, `line-height: 1.1` so a cap never grows
  its row. The action follows as printed legend in the host's ink (`a accept` reads as a cap, then
  `accept`); a cap and its legend never wrap apart. Legends print what is pressed: letters as typed
  (`a`, `A`), named keys as words (`Esc`, `Enter`, `Tab`), modifiers as macOS symbols inside the cap
  (`⌘Enter`, `⌃C`). A cap is never recoloured: a state colour goes on the legend. Text that cannot
  hold markup (tooltips, `aria-label`, input placeholders) keeps the same spelling as plain text.
- **Selector keys.** Tabs: a recessed channel (a well with 3px padding) of 6px keys, each with a 6px
  LED before its legend. The shown tab is latched down with its LED lit; a count is a small readout
  window on the key.
- **Lamps.** An LED is a 6px circle (8px in titlebars):
  - unlit: `background: var(--mat-lens-off); box-shadow: inset 0 1px 1px rgba(0,0,0,.6), 0 1px 0 rgba(255,255,255,.08)`;
  - lit amber: `background: var(--mat-lens-on); box-shadow: var(--mat-lens-glow)`;
  - lit colour `--x-rgb`: `background: radial-gradient(circle at 35% 30%, var(--mat-glint) 0 12%,
    rgb(var(--x-rgb)) 45%, rgba(var(--x-rgb), .55) 100%); box-shadow: 0 0 4px rgba(var(--x-rgb), .9),
    0 0 10px rgba(var(--x-rgb), .4)`.

  A status capsule is lit glass: `border: 1px solid rgba(var(--x-rgb), .5); border-radius: 999px;
  background: radial-gradient(ellipse at 50% 0%, rgba(var(--x-rgb), .3), rgba(var(--x-rgb), .07) 75%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 0 6px rgba(var(--x-rgb), .22)`, legend in the
  state ink. An unlit capsule is a `--mat-well-fill` capsule in ink. A status lamp that belongs to a
  chip or capsule sits inside it, before the legend, never beside it.
- **Chips.** Verdicts and kinds outside the transcript are embossed labels on a key face, tinted by
  their colour, with the status LED first on the key face, 5px before the legend. Every label in the
  transcript (tool kind, permission and question decision, execution state, provider-error meta,
  notice action) is flat ink: no key face, capsule, border, or shadow; its LED, when it has one, sits
  before the legend.
- **Readouts.** A small well holding a tabular-nums figure, with its label engraved beside or under it.
- **Scrim.** Behind a modal plate: `background: var(--mat-scrim)`. Never blur.

## Surfaces

- **Terminal window.** A bezel around a screen. The titlebar (36px), tab bar and footer are plate
  strips; the body is the screen. The window has a 1px `--mat-key-edge` border, the bevel on its top
  edge and one `--mat-cast`. Focused: the titlebar LED lit in the window accent, the title in
  `--mat-lit` with no glow (the title clips, so a bloom would read as a box), and a 1px window-accent
  ring at 0.55 alpha (`box-shadow: 0 0 0 1px`), no glow. The shown tab's title is lit the same way.
  Unfocused: LED unlit, title engraved ink. When the shown tab is one view whose bottom edge is a
  plate (the harness command centre, a content view's status readout), the footer continues that
  plate: no seam, no bevel, flat `--mat-plate-lo`, which is where the view's plate ends.
- **Window accent** (`--krypton-window-accent`, lane accents, manual pick, signal states) colours the
  window's LEDs — titlebar and its tabs — and the window focus ring. Labels stay silk. Footer lane
  marks carry no LED: the initials alone name the lanes.
- **Overlays and dialogs** (palette, which-key, hints, prompt dialog, quick overview, dashboards,
  inline AI, toasts, harness pickers and dialogs): one floating plate over `--mat-scrim`; engraved
  head; input well; the result list is one well with grooves and a full-row `--mat-select` tint;
  actions are keys; the key-hint foot prints each key as a key cap and its action as legend. Which-key
  and hint labels are key caps.
- **Quick Terminal.** A plate drawer around a screen.
- **Harness.** The lane body is a screen (the window's screen shows through; a lane adds the well's
  inset depth, not a second fill). The lane head is a plate strip with the name engraved and status as
  a lamp; the zen rail is a plate column of selector keys with LEDs; in Zen the rail, the shown
  lane's head strip and the composer plate are one plate around the lane's screen, with no seam where
  plate meets plate (the screen draws its own edges); the composer is a flush plate with
  the draft line in a well; transcript rows are flat text on the screen under engraved labels; tool
  rows are a flat kind label with the status LED before it and an output well aligned with the label (a
  plain output well has no label; only a label that says something, like `stderr`, is engraved);
  resolved permission and question rows carry their LED before a flat decision label; a decision
  composer's `PERM` / `ASK` label is a readout like the composer's mode readout, at the same 0.72em,
  its amber LED lit; permission and question options print their keys as key caps;
  floating lane cards are small plates. The right dock column is a flush plate of wells, keys and lamps,
  and it is one plate with the shown lane's head strip beside it: no seam, bevel or cast shadow where
  they meet; the screen draws its own right edge.
- **Content views.** The file browser and the markdown reader are one plate: the path and the status
  are readout wells engraved into it; the list is a well and the preview a screen well, set side by
  side 8px apart. Other views' toolbars, status bars, breadcrumbs and sidebars are plates, readouts
  and wells. Markdown prose, diff tables, file previews, request/response bodies, the Excalidraw
  canvas, the native webview and review-board documents stay flat.

## Colour and state

- Labels and lit legends are `--mat-silk` / `--mat-lit` everywhere: amber hardware ink.
- Body text uses the theme ink: `--krypton-fg` with its alpha ladder in the dark scheme, the
  `--krypton-ink-2/3/4` tiers in the light scheme (spec 321). Never dim text with `opacity`.
- The theme accent keeps four jobs: the terminal cursor, links, window LEDs and the window focus
  ring. Controls focus with a `--mat-lit` outline (see Focus).
- Lamps take `--krypton-success-rgb` (pass), `--krypton-danger-rgb` (fault),
  `--krypton-warning-rgb` (warning). Actions are cyan running, green done; those are not verdicts.
- Model findings stay neutral evidence (ADR-0004): severities, tags and clean/findings verdicts use
  ink and amber only. Colour appears only for a fault or something the human must act on (ADR-0017).
- Selection is a full-row `--mat-select` tint inside its well, never an edge rail (ADR-0027).
- All colours flow through tokens: `--krypton-*` (theme, written inline on `<html>` by `theme.ts`),
  `--mat-*` (materials), `--agent-*` (the shared surface palette `theme.ts` emits), or a
  component-local `--x-rgb` state variable set from one of those.

## Typography

Monospace everywhere. Labels are uppercase engraving (11px, 600, `0.13em`); key legends 11px at
`0.09em`; tab titles keep their natural case (a path or a command). Body is mixed case at normal
spacing. Every digit that changes — timers, counts, gauges, sizes, percentages — uses
`font-variant-numeric: tabular-nums`, and sits in a readout when it is a figure on its own.

## Geometry

8px on every rectangular part: windows, panels, wells, keys, readouts, toasts. 6px only for selector
keys inside an 8px channel. Capsules are `999px`; LEDs and status discs are circles. 0px only on an
interior pane flush with an edge (the dock column, the harness composer). Titlebar and tab heights
come from the theme (36px built in, so the selector keys are 26px and the titlebar keys 24px). Below
`320 × 120` a window collapses to its titlebar plate; below 200px wide it closes.

```
┌─ plate ─────────────────────────────────────────────────────┐
│ ● TITLE (engraved / lit when focused)        [key] [key] NN │  ← titlebar strip, LED in window accent
│ ╭ channel ─────────────────────────────╮                    │  ← tab bar: selector keys (2+ tabs)
│ │ [● 01 tab] [● 02 active↓] [● 03 tab] │                    │
├─────────────────────────────────────────────────────────────┤
│▓ screen well (inset depth, --mat-screen, flat terminal grid) │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ [readout] [readout]                         footer strip    │
└─────────────────────────────────────────────────────────────┘
```

## Focus

Keyboard-first: every focusable element shows `:focus-visible`. Windows: lit LED, lit title,
1px accent ring. Controls: `outline: 1px solid var(--mat-lit); outline-offset: 2px`, solid, no glow.
The active row of a list is the full-row `--mat-select` tint (plus its outline when it has focus).
A panel that holds the keyboard (the dock's Rails, Ticket and Assistants panes) draws no border or
outline around itself. A list panel says it holds the keys through its selected row instead: while
focus is inside, that row's text is lit `--mat-lit`; state colours (pills, outcomes, chips) and
backend logos keep their own. Off focus the row keeps only the `--mat-select` tint.

## Form controls

Buttons are keys; the single confirming action of a dialog is a key with a lit legend. Text inputs
and textareas are wells. Checkboxes are a 12px key that latches down with its LED lit. Selects open as
palette-style overlays, never native menus. Disabled controls keep their geometry and drop to 0.45.

## Scrollbars

8px, WebKit pseudo-elements only. The track is transparent (the well shows through); the thumb is
`rgba(var(--krypton-fg-rgb), .18)` with the 8px radius, `.32` on hover. No buttons.

## Gauges and progress

A gauge is a 4px well track with a flat fill in `--mat-silk` or the state colour and a 1px inset top
highlight; no glow, no sweep. Its label is engraved above it, its value a readout at the right end.
Indeterminate work shows a steady lit lamp and a label saying what is running.

The terminal progress ring (OSC 9;4, centred behind the terminal text) is the one glowing gauge. Its
arc is lit in the state colour (the window accent, warning when paused, fault on error) with a soft
halo of its own colour, over an unlit ring of that colour at the same width: no well, so no dark
edge. Its percentage readout and label never glow, and it has no sweep and no orbit.

## States

- **Disabled** — unpowered: 0.45 opacity, geometry kept, `cursor: not-allowed`.
- **Loading** — a one-line label and a steady lamp. Spinner glyphs and ticking counters may change
  content; nothing pulses.
- **Empty** — an engraved headline and a body line, centred in the well.

## Links and inline code

Links use the theme link colour, underlined with a 2px offset; no glow. Inline code sits in a small
`--mat-well-fill` chip with a 1px groove border.

## Motion

- **None ambient.** No pulse, breathing, sweep, shimmer, orbit, scanline, radar ping or vignette.
  Live state is a steady lit lamp.
- **Blinks** — only text carets, the terminal cursor and the selection-mode cursor; they stop under
  `prefers-reduced-motion`. A JS spinner glyph and ticking counters stay: they change content, not
  light.
- **Kept** — WAAPI layout transitions on transform and opacity (window morph, workspace slide,
  entrance and exit), the 1px key press, one-shot event flashes up to 600ms drawn as a lamp flash,
  the 220ms transcript row enter.
- **Reduced motion** — entrances capped at 120ms; caret blinks stop; hover and focus changes are
  instant.
- **Config effects** keep their own behaviour and are not part of the chrome: `[shader]`, cursor
  trail, `[fire]`, the `[music]` circuit trace, perspective tilt. The header oscilloscope (spec 188)
  draws inside a display well.

## Elevation and z-index

| Layer | z-index | What lives there |
|---|---|---|
| base | 0 | Workspace surface |
| window | 100 | Terminal windows (unfocused) |
| windowFocused | 110 | The focused window |
| paneOverlay | 200 | Overlays drawn on a pane |
| overlay | 1000 | Quick Terminal, command palette, which-key |
| modal | 2000 | Confirmation dialogs, blocking forms |
| toast | 3000 | Transient notifications |
| hint | 4000 | Leader-key hints, hint-mode labels, debug overlays |

## Transparency hierarchy

1. **Workspace** — fully transparent; the desktop shows through.
2. **Screen** — `--mat-screen`: the theme backdrop at `[visual] opacity` (default 0.5; light themes
   floor at 0.94).
3. **Plates** — 0.9 (dark) / 0.94 (light), whatever `[visual] opacity` says, so chrome stays legible.
4. **Floating plates** — the same plate over `--mat-scrim`.

Nothing is fully opaque. A narrow overlay that must hide what is under it adds a solid underlay
(`--agent-surface-solid`) beneath the plate.

## Performance

- Brush and stacked bevels only on plate strips and panels.
- A repeated row (transcript row, diff line, tool output line, file row, palette result) gets no
  box-shadow, text-shadow or gradient: at most one groove border and the selection tint.
- One `--mat-cast` per floating plate; no outer glows on windows.
- Budget: keypress-to-render under 16ms, layout animation at 60 FPS, idle CPU under 1%.

## Accessibility

- **Contrast.** Dark: `--mat-silk` on the plate is 9.0:1 over a black wallpaper and 6.4:1 over white;
  `--krypton-fg` 9.2:1 / 6.5:1. Light: `#6e4700` on the 0.94 aluminium plate is 5.2:1 / 6.1:1.
- **Real edges.** Every key keeps its 1px border, so it reads as a control without its shadows.
- **Focus** is mandatory and keyboard-only (`:focus-visible`).
- **Reduced motion** — see Motion.

## Theming

A theme TOML at `~/.config/krypton/themes/<name>.toml` may set the `colors` palette, the `ansi` table,
the backdrop and selection alphas, the accent, and the Quick Terminal screen fill. Panels, palettes
and key caps take no theme colours: they are material. Its `[tokens]` table may recolour any
`--mat-*` colour stop or shadow (values pass the spec 303 allowlist; gradients are composed in
`materials.css`). A theme may not change geometry, motion, typography or focus: those are the
identity, not the palette.

## Platform constraints

- **`backdrop-filter: blur()` is banned.** It freezes the transparent WKWebView on macOS. Depth comes
  from alpha, gradients and shadows.
- **No CSS frameworks, no UI libraries.** Vanilla CSS, BEM naming, `krypton.*` cascade layers
  (`src/styles/layers.css`).
- **No images for materials.** Brush, bevels, wells and lenses are CSS gradients and shadows.

## Sibling aesthetics

Every surface in the app webview follows this file. The only sibling is **`DESIGN.binance.md`**: the
loopback app opened in the OS browser (`src/loopback/`), a separate document with its own tokens. Its
GenUI preview stage imports `materials.css`, so catalog components render as they do in the app.

A new sibling needs a reason that is not taste: a separate document, or a surface that is not Krypton
chrome. It gets its own `DESIGN.<name>.md` with this frontmatter shape and a single root scoping
selector, and nothing in it bleeds out of that selector.

## Changelog

- **2.2.0** — A system row raised by a harness subsystem is a notice (spec 371): the source is the
  row label (`triage`, `xenon`, `review`, `usage`, `event`), the action a flat-ink legend with an
  amber or fault LED before it when the human should look, then the subject. The bracket tag no
  longer prints in the body.
- **2.1.0** — Every keyboard shortcut drawn in text is a key cap (spec 369): a `<kbd>` from
  `src/ui/kbd.ts` with one shared rule, followed by its action as legend. Bracket notation
  (`[a] accept`) and plain-text hint lines (`j/k move · esc cancel`) are gone; the key-hint foot
  prints caps. The fs write-review and agent-view accept/reject actions drop their key face and read
  like the permission row. The per-surface `kbd` rules are gone.
- **2.0.3** — Every transcript label is flat ink. The tool kind, the permission and question
  decision, and the provider-error chips no longer sit on a key face, and an execution card's state
  is no longer a capsule. Their status LED stays before the legend. Pressable keys and hint caps are
  unchanged.
- **2.0.2** — The terminal progress ring glows: its arc is lit with a soft halo in the state colour
  over a dim ring of the same colour and width. The dark well track under it is gone, and with it the
  black edge on both sides of the arc. The readout and label stay unlit.
- **2.0.1** — A status LED that belongs to a chip or readout sits inside it, before the legend: the
  tool kind chip, the permission and question decision chips and the decision composer's `PERM` /
  `ASK` label, which is now a chrome-size readout instead of a full-size lit capsule. The tool output
  well aligns with the chip. The right dock column and the shown
  lane's head strip are one plate: the seam and cast shadow between them are gone. Footer lane marks
  drop their LED. No legend, label or title glows anywhere any more: `--mat-lit-glow` left every latched
  key, selector tab, live row label, focused title and readout, and the cyan / green / fault / outcome
  text glows went with it; it stays only on the composer bloom's afterimage flash. The dock's Rails,
  Ticket and Assistants panes lose the amber outline they drew while holding the keyboard; in Rails
  and Assistants the selected row's text lights amber while the pane holds the keys.
- **2.0.0** — Krypton Console replaces Krypton Dark as the base identity (spec 366). The dock's
  faceplate becomes every surface's: `--mat-*` tokens at the root in `src/styles/materials.css`
  (the dock-local `--dock-*` set is gone), plate / engraving / well / screen / key / lamp parts,
  steady lamps instead of ambient motion, no neon glow outside lamps. `DESIGN.console.md`,
  `DESIGN.amber.md` and `DESIGN.nasa.md` are absorbed and deleted. Light silk darkens from `#8a5a00`
  to `#6e4700` and light plates rise to 0.94 alpha for 4.5:1 labels.
- **1.2.8** — The ACP harness right dock column moves to the sibling `DESIGN.console.md` faceplate.
- **1.2.7** — ACP harness Zen rail: body, tab and composer read as one sheet (spec 325 rev 2).
- **1.2.6** — ACP harness Zen rail: the active lane is a tab merged into the lane body (spec 325).
- **1.2.5** — ACP harness docked ticket panel is a flush 0px interior pane.
- **1.2.4** — ACP harness host window uses the 8px token again; only the composer stays 0px.
- **1.2.3** — NASA Vault containers use the 8px token.
- **1.2.2** — Default container radius is 8px (`--krypton-border-radius`).
- **1.2.1** — L-shaped corner brackets are forbidden on every surface.
- **1.2.0** — Default container radius is 4px.
- **1.1.0** — Focus, form, scrollbar, cursor, z-index, overlay, gauge, accessibility specs.
- **1.0.0** — Initial Krypton Dark spec.
