---
name: Krypton Loopback (Binance Dark)
description: Binance-dark exchange aesthetic for the read-only loopback surfaces opened in the OS browser — near-black canvas, single yellow accent, trading green/red semantics, mono for all data
appliesTo: >
  Loopback HTTP surfaces served by src-tauri/src/hook_server.rs and opened in the
  OS browser — the artifact scaffold (src-tauri/resources/artifact-scaffold.html),
  lane-monitor dashboard (src/acp/artifact-dashboard.html), artifact gallery
  (src/acp/artifact-gallery.html), and docs browser (src/acp/artifact-docs.html).
colors:
  primary: "#fcd535"     # the single yellow accent (== accent below)
  bg: "#17191d"          # soft near-black canvas (shared by all four surfaces)
  fg: "#eaecef"          # primary text / headings
  text: "#b7bdc6"        # docs-reader body text (softer than fg; docs only)
  muted: "#707a8a"       # secondary labels, metadata, idle dots
  border: "#2f353d"      # hairline dividers, card edges
  accent: "#fcd535"      # single yellow accent — headings, focus, primary action
  card: "#21242a"        # raised surface fill
  codeBg: "#1d1f24"      # code/pre fill, gauge tracks, chip bg
  add: "#0ecb81"         # trading green — live, busy, additions, success
  del: "#f6465d"         # trading red — error, awaiting-peer, deletions, alerts
docsExceptions:          # the docs reader keeps two prose-only refinements
  text: "#b7bdc6"        # dedicated body-copy tone, distinct from heading --fg
  codeFg: "#f0b90b"      # warmer gold for inline code in prose
typography:
  sans: "BinanceNova, IBM Plex Sans, -apple-system, BlinkMacSystemFont, sans-serif"
  mono: "BinancePlex, JetBrains Mono, SF Mono, Menlo, ui-monospace, monospace"
  bodySize: "14px"
  bodyLine: 1.5
  readerSize: "15px"     # docs article body
  readerLine: 1.65
  dataSize: "10px–12px"  # mono labels/pills/metadata
rounded:
  card: "10px"
  panel: "8px"
  button: "6px"
  chip: "5px"
  inlineCode: "3px"
  borderWidth: "1px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "13px"
  xl: "18px"
  gutter: "18px"         # dashboard layout grid gap
forbidden:
  - "left accent borders (border-left rails) — runtime backstop strips them"
  - "nested containers (cards inside cards, panels inside panels)"
  - "a second accent hue — yellow is the only accent; green/red are semantic only"
  - "uppercasing file paths, filenames, or user-typed strings"
  - "backdrop-filter / blur (these are browser pages but the house rule holds)"
---

## Overview

A flat, instrument-panel aesthetic modeled on the Binance exchange dark UI: a
near-black canvas, a single warm-yellow accent, and trading green/red used
**only** as semantics (live/up vs error/down). It is the shared identity for the
**loopback browser surfaces** — read-only pages the harness serves over
authenticated loopback HTTP and the user opens in their *OS browser*, outside
the Krypton window chrome.

These pages are not terminal chrome, so they do not follow Krypton Dark
(`DESIGN.md`), the Vault Viewer's NASA look (`DESIGN.nasa.md`), or the Agent
view's amber phosphor (`DESIGN.amber.md`). They share one design system so that
a lane's generated artifact, the lane-monitor dashboard, the artifact gallery,
and the docs browser all read as one product when the user flips between browser
tabs.

The four surfaces:

| Surface | File | Role | Theming |
| --- | --- | --- | --- |
| Artifact scaffold | `src-tauri/resources/artifact-scaffold.html` | Template a lane edits into a one-off view | 3-mode toggle: `binance` / `light` / `auto` |
| Lane-monitor dashboard | `src/acp/artifact-dashboard.html` | Live status of all lanes (polls `/telemetry`) | Fixed dark |
| Artifact gallery | `src/acp/artifact-gallery.html` | Index of every lane's artifacts (polls `/artifacts`) | Fixed dark |
| Docs browser | `src/acp/artifact-docs.html` | Read-only repo markdown reader (`/docs`, `/doc`) | Auto (follows OS `prefers-color-scheme`) |

Per-surface behaviour and endpoints are specified in `docs/134`, `docs/168`,
`docs/170`, `docs/171` and `docs/adr/0002`/`0010`. **This file is the visual
contract only** — it does not restate those specs.

## Colors

One canvas, one accent, two semantics. The full token contract lives in the
front matter; the intent:

- **`#fcd535` accent (yellow)** is the *only* decorative hue. It carries
  headings, `th`, focus/hover, the primary action button, stat/gauge numerals,
  and the "attention" tint `rgba(252,213,53,.06)`. Never introduce a second
  accent color — if something needs to stand out and is not success/danger, it
  uses the accent or it uses weight/size/position instead.
- **`#0ecb81` green** and **`#f6465d` red** are *semantic, never decorative*.
  Green = live / busy / additions / success; red = error / awaiting-peer /
  deletions / alert counts. A card is never green "to look nice."
- **`#707a8a` muted** does the heavy lifting for the dense data voice — every
  label, timestamp, agent name, and idle status dot.
- Surfaces stack by lightness, not by border weight: `--bg` (canvas) → `--card`
  (raised panel) → `--code-bg` (inset code / track), each a hairline `--border`
  apart.

### Status color classes (dashboard & gallery)

Lane and artifact state map to color through `.st-*` classes — keep these stable
so the two surfaces agree:

- `accent` — `starting`, `needs_permission`, `pending`
- `add` (green) — `busy`, `live`
- `del` (red) — `awaiting_peer`, `error`
- `muted` — `idle`, `stopped`, `unknown`

### One canvas, two docs-only refinements

All four surfaces share the same soft canvas family — `--bg #17191d`, `--card
#21242a`, `--border #2f353d`, `--code-bg #1d1f24`. (This soft canvas, originally
the docs reader's, is now the single standard; the harder `#0b0e11` it replaced
is retired.) The docs reader keeps just two prose-only refinements, recorded in
`docsExceptions`:

- **`--text` (`#b7bdc6`)** — a softer body-copy tone for long-form markdown,
  distinct from the brighter `--fg` used for headings and `strong`. Status
  surfaces have no long body copy, so they use `--fg` directly.
- **`--code-fg` (`#f0b90b`)** — a warmer gold for inline `code` inside prose.

Keep these in the docs reader only; do not add a body/heading text split to the
dashboard or gallery, where every line is already a label.

## Typography

Two families, by job — never by decoration:

- **Sans (`--sans`)** — prose and reading. Body `14px`/1.5; the docs reader runs
  larger at `15px`/1.65 for comfort.
- **Mono (`--mono`)** — *all data*: labels, pills, chips, timestamps, agent
  names, stat/gauge numerals, breadcrumbs, footers, and code. Numeric readouts
  add `font-variant-numeric: tabular-nums` so figures don't jitter as they
  update.

The "data is mono, prose is sans" split is the core typographic rule and is what
makes the dense dashboards read as instrumentation. Data labels sit at `10–12px`
with light letter-spacing (`.04em`); they are **not** uppercased (paths,
filenames, and user strings keep their case).

Reader heading scale (docs `article.doc`): h1 `1.75em` (accent), h2 `1.35em`
(with bottom hairline rule), h3 `1.15em` (accent), h4 `1em`, h5/h6 `.9em`
(muted).

## Geometry

Soft, consistent corner radii — flatter and rounder than Krypton Dark's hard
edges, matching the exchange-UI source:

- Cards / lane tiles: `10px`
- Panels, pre blocks, the attention-tint box: `8px`
- Buttons, blockquotes, breadcrumb chips: `6px`
- Chips / progress tracks: `5px`
- Inline `code`: `3px`

`1px` borders throughout. No shadows for elevation — elevation is the
lightness step (`bg → card → code-bg`), not a drop shadow.

## Components

Shared building blocks; reuse these class shapes rather than inventing new ones.

- **Card** (`.ka-card`, `.lane`, art card) — `--card` fill, `1px --border`,
  `10px` radius, `12–13px` padding. The standard surface. Do **not** nest one
  inside another.
- **Status dot** (`.dot`, `.dot.live`) — `10px` circle; `--muted` when idle,
  `--add` with the `beacon` keyframe (expanding green ring, `2s` loop) when
  live. The single sanctioned animation in this system.
- **Pill** (`.pill` + `.st-*`) — `10px` mono, `.04em` tracking; colored by the
  status class table above. State badge, not a button.
- **Stat tile** (`.stat`) — small `--muted` mono label over a large accent mono
  numeral (`19px`); the dashboard summary unit.
- **Gauge** (`.gauge`) — canvas-drawn arc with a centered `30px` accent numeral
  (`.gauge-val`); color shifts to `--add`/`--del` by state.
- **Resource bar** (`.res-bar`) — `6px` track on `--code-bg`, green fill, width
  animates `width .3s ease`.
- **Chip** (`.chip`, `.chip.alert`) — `--code-bg` capsule with mono count;
  accent numeral normally, red when `.alert`.
- **Primary action** (`.art-open`) — accent-filled button with `--bg` text;
  disabled state goes `--code-bg` fill + `--muted` text + `pointer-events:none`.
  The one place text sits *on* the accent rather than the accent being the text.
- **Empty state** (`.empty`) — centered `--muted` mono line. Every list/grid has
  one.
- **Footer** (`.footer`) — `--muted` mono, separated by a top hairline. Carries
  poll cadence / counts.
- **Docs reader** (`article.doc`) — `820px` max-width, `15px`/1.65, accent h1/h3,
  hairline-ruled h2, `--code-fg` inline code, bordered `pre`/tables, muted
  blockquote with `rgba(112,122,138,.08)` tint. Front matter renders as a
  `dl.frontmatter` key/value card above the body.
- **Tree / breadcrumbs** (docs) — `.tree-pane` sidebar at a translucent card
  tint, `nav.crumbs` mono path with accent hover. Single-file view drops the
  sidebar for full-width reading.

## Motion

Restrained. The only ambient motion is the live status `beacon` (a `2s`
expanding-ring pulse on green dots) and `.3s` resource-bar width transitions.
Everything else is instantaneous or a sub-`150ms` color/hover transition. These
are *live status* pages, so a heartbeat is appropriate — but nothing slides,
fades in, or animates on load. Data updates by repaint, not by transition.

## Theming policy

Theming behaviour is deliberately **per-surface**, by what the page is for:

- **Artifact scaffold** ships the full `binance → light → auto` toggle
  (`.ka-toggle`), best-effort persisted to `localStorage`. A lane's artifact may
  be read anywhere, so the reader controls the mode.
- **Docs browser** has *no manual toggle* — it follows the OS via
  `@media (prefers-color-scheme)`. A reading surface should match the reader's
  system without a control to fiddle.
- **Dashboard & gallery** are **fixed dark**. They are glanceable status walls
  meant to live on a second screen; a light mode would only invite a stray
  click. No toggle by design.

When adding a new loopback surface, pick the matching policy — don't add a
toggle to a status wall or strip auto-theming from a reader.

## House rules

1. **No left accent borders (`border-left` rails).** To color-code a block use a
   full border, a background tint, or heading/icon color. The artifact scaffold
   ships a runtime backstop that strips any left-only border, so a rail will not
   render anyway — but author it correctly everywhere, including the dashboard,
   gallery, and docs, which have no such backstop.
2. **Flat, single-surface chrome.** No nested containers (no card-in-card,
   panel-in-panel). One `--card` step is the whole depth budget.
3. **One accent.** Yellow only. Green and red are semantics, never decoration.
4. **Mono for data, sans for prose** — never mix the convention for visual
   variety.
5. **Don't uppercase** paths, filenames, or user-typed strings. Letter-spaced
   mono labels are for chrome labels only.

## Relationship to the other DESIGN docs

| Doc | Identity | Surface |
| --- | --- | --- |
| `DESIGN.md` | Krypton Dark — cyan neon cyberpunk | The terminal window chrome (in-app) |
| `DESIGN.nasa.md` | NASA Mission Control — cyan phosphor | Vault Viewer (in-app) |
| `DESIGN.amber.md` | Amber phosphor cassette-futurism | Agent view (in-app) |
| `DESIGN.binance.md` | Binance dark exchange | **Loopback pages in the OS browser** |

The first three are *in-app* identities rendered inside the single Krypton
window. This one is the only identity that lives **outside** the app, in a real
browser — which is why it is a self-contained, web-conventional system (system
fonts as fallbacks, OS theme awareness, plain semantic HTML) rather than an
extension of the in-app chrome. Keep that boundary: do not import Krypton Dark's
neon, glows, or hard geometry into these pages, and do not push Binance yellow
back into the terminal.
