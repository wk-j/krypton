# The console faceplate is Krypton's one in-app visual identity

> Status: accepted
> Date: 2026-11-07

## Context

Until spec 366 the app webview carried four looks: Krypton Dark neon (`DESIGN.md` 1.x) on most
surfaces, amber phosphor on the Agent view (`DESIGN.amber.md`), NASA Mission Control on the Vault
(`DESIGN.nasa.md`), and a skeuomorphic instrument faceplate on the harness right dock
(`DESIGN.console.md`), whose `--dock-*` material tokens were confined to `.acp-harness__dock`. The user
asked for the whole UI in the faceplate style.

## Decision

The faceplate (Krypton Console, `DESIGN.md` 2.0.0) is the only visual identity inside the app
webview and the live-assist webview. Its material tokens are `--mat-*`, declared once on the
document root in `src/styles/materials.css` (graphite dark, aluminium light), and every surface is
built from the same parts: plate, engraving, well, screen, key, lamp. Content stays flat inside
wells. Ambient motion and neon glow are gone; live state is a steady lamp. The loopback app in the OS
browser keeps its own sibling identity (`DESIGN.binance.md`).

## Considered Options

- **An opt-in look** (`chrome.style = "console"` keyed on `html[data-chrome]`, keeping Krypton Dark).
  Rejected: two full aesthetics across 147 stylesheets doubles every UI change and test.
- **Copying the dock's `--dock-*` set onto each surface.** Rejected: forty light-scheme duplicates
  that drift.
- **Generating materials per theme in `theme.ts`.** Rejected: the material would live in JS strings,
  out of CSS review; composing gradients from colour-stop tokens in CSS gives themes the same reach
  through the spec 303 allowlist.

## Consequences

- `DESIGN.console.md`, `DESIGN.amber.md` and `DESIGN.nasa.md` are retired; a new in-app sibling
  aesthetic needs a reason that is not taste (a separate document, or a surface that is not chrome).
- Theme fields whose only consumers were glows are removed from the theme schema (spec 366).
- Plates hold their own alpha; `[visual] opacity` applies to screens only.

## Rails

Applies to: `src/**/*.css`

- No stylesheet other than `src/styles/materials.css` declares a `--mat-*` custom property.
- No rule adds an `infinite` animation except on a text caret, the terminal cursor or the
  selection-mode cursor.
- No rule adds a glow (`box-shadow` / `text-shadow` / `filter: drop-shadow` with blur in an accent or
  state colour) to anything but a lamp, an LED lens or a backlit legend (`--mat-lit-glow`).
- No rule puts a `box-shadow`, `text-shadow` or gradient on a repeated row (transcript row, diff line,
  tool output line, list or palette row); a groove border and the selection tint are the most it gets.
