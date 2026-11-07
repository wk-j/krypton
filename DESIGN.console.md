---
name: Krypton Console
version: 1.0.0
description: Skeuomorphic instrument faceplate — brushed graphite (aluminium in the light scheme) with engraved labels, recessed display wells, raised keys and lit lamps
appliesTo: ".acp-harness__dock (src/styles/harness-shared.css + the ticket-dock, rails-dock, assistant-instances and dock-action component sheets)"
colors:
  primary: "#ffb000"       # engraved label fill, --dock-silk (light: #8a5a00)
  lit: "#ffd880"           # backlit legend, --dock-lit (light: #8a5a00)
  plateTop: "rgba(46, 49, 56, 0.9)"
  plateBottom: "rgba(23, 25, 30, 0.9)"
  wellFill: "rgba(9, 10, 14, 0.78)"
  keyFace: "rgba(55, 58, 66, 0.95)"
  select: "rgba(255, 176, 0, 0.16)"
  lampPass: "rgb(57, 255, 127)"   # --krypton-success-rgb
  lampFault: "rgb(255, 58, 92)"   # --krypton-danger-rgb
  lampWarn: "rgb(232, 197, 71)"   # --krypton-warning-rgb
  keyRunning: "#6dd0ff"
  keyDone: "#a8ffbf"
typography:
  label:
    fontFamily: "inherit"            # the harness monospace
    fontSize: "11px"                 # --krypton-chrome-font-size; uppercase, engraved
    letterSpacing: "0.13em"
  body:
    fontFamily: "inherit"
    fontSize: "1em"                  # the dock body size
rounded:
  part: "8px"        # wells, keys, lamp windows, readouts (--krypton-border-radius)
  tab: "6px"         # selector keys inside the 8px tab channel
  capsule: "999px"   # status lamps, tags, chips; LEDs stay 50% circles
motion:
  press: "a held key sinks 1px with an inset shadow (:active); no transition"
  ambient: "none — lamps glow steadily"
forbidden:
  - "backdrop-filter: blur()"
  - "fully opaque plate (max alpha 0.92; the narrow overlay adds the solid underlay)"
  - "infinite or decorative animation, including lamp pulses"
  - "a button taller than one line: a key's state badge sits beside its label or is dropped"
  - "left-edge accent rails for selection (ADR-0027)"
  - "L-shaped corner brackets or screw-head ornaments"
  - "colouring model findings as pass/fail (ADR-0004)"
  - "--dock-* tokens declared anywhere but .acp-harness__dock"
---

# Krypton Console — the harness right dock

## Overview

The harness's right dock column (`.acp-harness__dock`: the tab strip plus the Ticket, Rails and
Assistants tabs) reads as a piece of hardware bolted to the side of the lane: a brushed faceplate,
labels engraved into it, what the panel *shows* behind recessed glass, what the panel *does* on
keys you could press. It is a sibling of `DESIGN.md` (Krypton Dark); nothing outside the column
uses it.

The rule that keeps it readable: **material carries role, colour carries state.** Plate, well and
key say what a thing is (label, display, control). Colour still says only what `DESIGN.md` and the
ADRs allow it to say.

## Materials

Every part reads one set of `--dock-*` custom properties declared once, on `.acp-harness__dock`
in `harness-shared.css`; the light scheme redeclares the whole set in the same file's
`krypton.scheme` layer. Component sheets never declare them.

| Token | Role |
|---|---|
| `--dock-plate`, `--dock-brush` | The faceplate: a top-lit graphite gradient at 0.9 alpha under a 2–3% vertical brush texture |
| `--dock-bevel-hi/lo` | The plate's lit inner edge and the dark seam where it meets the lane |
| `--dock-well`, `--dock-well-fill` | A recessed display: gradient for a standalone well, flat fill for a well cut into row slices |
| `--dock-well-depth/wall/lip`, `--dock-well-shadow` | Inner top shadow, 1px wall, light lip under the bottom edge |
| `--dock-groove-lo/hi` | An etched line: dark cut plus the light edge below it |
| `--dock-key`, `--dock-key-hover`, `--dock-key-down` | Key faces: resting, hovered, held or latched |
| `--dock-key-edge`, `--dock-key-raise`, `--dock-key-sunk` | Key outline, raised stack, pressed stack |
| `--dock-engrave`, `--dock-print` | Text cut into the plate; legend printed on a key |
| `--dock-silk`, `--dock-lit`, `--dock-lit-glow` | Amber label fill; backlit legend and its tight + bloom glow |
| `--dock-lens-off/on`, `--dock-lens-glow` | LED lens unlit / lit and its glow |
| `--dock-select` | The row selection tint |

## Parts

- **Plate.** The column itself. Flush with the harness edge (0px, spec 238); a 1px light bevel on
  its inner edges and a soft shadow cast onto the lane. Below 960px, where the column overlays the
  transcript, the same plate sits on `--agent-surface-solid`.
- **Engraving.** Section headings, the Actions heading, the target line and the key legend are
  amber or ink text with `--dock-engrave`. They sit on the plate, never inside a well.
- **Wells.** Content sits in recessed displays inset 8px from the plate edge. A run of sibling rows
  (Rails sections, the Ticket status + meta lines) forms one well without a wrapper: the first slice
  carries the top shadow and corners, the last the bottom wall and lip, rows between are split by
  grooves. A well nested in a row (an expanded detail, a tag) is a deeper recess.
- **Keys.** `DockActionButton`, the Ticket `›` and the dock tabs. One line each, 28px tall: icon,
  label, then the state badge behind an etched divider; the badge is cut first, and a key under
  128px drops it (a done key keeps `✓`; the tooltip holds the detail). Raised at rest; sink 1px
  while held; a running action is latched down and backlit cyan; a done action is raised and
  backlit green; disabled keys are unpowered at 0.45 opacity, except a running one.
- **Selector keys.** The tab strip is a recessed channel of 6px keys, each with an LED. The shown
  tab is latched down with its LED lit; a count is a small readout window on the key.
- **Lamps.** Status capsules (the Rails verdict, the ticket status, live / warning / fault chips) are
  lit glass; an unlit lamp is a well-coloured capsule in ink. Rails check outcomes are lamp windows:
  an LED then the label (`PASS`, `FAIL`, `TIMEOUT`, `ERROR`); `skipped` / `not run` keep a grey,
  unlit LED.
- **Chips.** Rails run verdicts (`✓ CLEAN`, `✗ CHECK FAILED`, `• FINDINGS`, `! ERROR`) are embossed
  labels on a key face, tinted by their verdict colour.
- **Readouts.** The Assistants counts are four small wells, figure over label.

## Colour and state

- Model findings stay neutral evidence (ADR-0004): severities, tags, clean/findings verdicts use
  ink and amber only. Only a failed check is a fault (ADR-0017): red lamp, red chip.
- Check lamps: success for PASS, fault for FAIL and TIMEOUT, warning for ERROR.
- Action states are not verdicts: cyan running, green done, shared by Ticket and Rails.
- Selection is a full-row `--dock-select` tint inside its well, never an edge rail (ADR-0027).

## Light scheme

Brushed aluminium. Wells are a darker grey recess with a white lip; keys are white-to-grey with a
white top highlight; engraving is a white highlight under the text. Amber labels and lit legends
cap to `#8a5a00`, and neon lamp legends to legible ink (`#b3261e`, `#136b3b`); their text glow
drops because a backlight does not read on a light plate. LED lenses still glow.

## Motion

None beyond the press. Lamps are steady, latched keys are static, and nothing in the column
animates on its own (CLAUDE.md constraint 10, spec 344).

## Changelog

- **1.0.0** — The right dock column becomes a skeuomorphic faceplate: tokens on
  `.acp-harness__dock`, engraved labels, segmented wells, raised / latched one-line keys, lamps
  and readouts, with a full aluminium light scheme.
