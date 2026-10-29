---
name: Krypton Loopback (Binance Dark)
description: Binance-dark exchange aesthetic for the loopback surfaces opened in the OS browser — near-black canvas, single yellow accent, trading green/red semantics, mono for all data
appliesTo: >
  Loopback HTTP surfaces served by src-tauri/src/hook_server.rs and opened in the
  OS browser — the loopback app (src/loopback/: Home, lane monitor, artifact
  gallery, GenUI component gallery, docs/journal reader, issue analyses, review
  archive, command and MCP tool references, Terminal Control monitor, Hurl web
  client, project timeline, ACP wire profiler, e2e explorer; spec 341) and the
  self-contained artifact scaffold (src-tauri/resources/artifact-scaffold.html).
colors:
  primary: "#fcd535"     # the single yellow accent (== accent below)
  bg: "#17191d"          # soft near-black canvas (shared by all loopback surfaces)
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
  - "L-shaped corner brackets — two-side HUD ticks; full 1px border or nothing"
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

The loopback surfaces are **one application** (spec 341): every page is a
document of the Vite app in `src/loopback/`, carries the same shell, and is
built from one kit (`src/loopback/kit/`) on one token sheet
(`src/loopback/styles/base.css`). The artifact scaffold is the one exception —
it is a lane-owned file, so it stays self-contained.

| Surface | Code | Role | Theming |
| --- | --- | --- | --- |
| Home | `src/loopback/surfaces/home/` | Every surface as grouped tiles (Monitor / Project / Reference), project picker, live counts from `/app/api/directory` | Fixed dark |
| Artifact scaffold | `src-tauri/resources/artifact-scaffold.html` | Template a lane edits into a one-off view | 3-mode toggle: `binance` / `light` / `auto` |
| Lane-monitor dashboard | `src/loopback/surfaces/dashboard/` | Live status of all lanes (polls `/telemetry`) | Fixed dark |
| Artifact gallery | `src/loopback/surfaces/gallery/` | Index of every lane's artifacts (polls `/artifacts`) | Fixed dark |
| GenUI component gallery | `src/loopback/surfaces/genui/` | Searchable index rail plus one component per view: live production renderer, parameters, example source | Fixed dark **shell**; the preview stage alone follows the app (see below) |
| Docs browser + journal | `src/loopback/surfaces/docs/` (body rendered in Rust) | Read-only repo markdown reader (`/docs`, `/journal`, `/doc`) | Auto (follows OS `prefers-color-scheme`) |
| Issue analyses | `src/loopback/surfaces/analyses/` (body rendered in Rust) | Analysis bundles per project (`/analyses`, `/analysis`) | Auto |
| Review archive | `src/loopback/surfaces/reviews/` (body rendered in Rust) | Read-only Review Board archive (`/reviews`, `/review`) | Auto |
| Command reference | `src/loopback/surfaces/commands/` | Built-in `#` command + system-prompt reference (`/commands`, fetches `/commands.json` once) | Fixed dark |
| MCP tool reference | `src/loopback/surfaces/tools/` | Built-in MCP tool contract reference (`/tools`, fetches `/tools.json` once); sections come from the data | Fixed dark |
| Terminal Control monitor | `src/loopback/surfaces/termctrl/` | Read-only named-session roster; Screen view (visible screen on the harness cell grid) and Log view (full retained output, follows the tail) behind a `Screen`/`Log` toggle (capability routes under `/termctrl`) | Fixed dark |
| Hurl web client | `src/loopback/surfaces/hurl/` | Token-gated `.hurl` runner (capability routes under `/hurl`) | Fixed dark |
| ACP wire profiler | `src/loopback/surfaces/acp-wire/` | Read-only ACP traffic profiler: stat tiles, per-lane waterfall, message table + payload detail, per-method latency (capability routes under `/acp-wire`, polls while visible) | Fixed dark |
| Project timeline | `src/loopback/surfaces/timeline/` | Read-only local requirement/decision chronology (`/timeline`, refetches `/timeline.json` when the tab becomes active); superseded rows are hidden by default, and a row in an open conflict pair marks only its time cell with an accent chip | Auto (follows OS `prefers-color-scheme`) |
| E2E explorer | `src/loopback/surfaces/e2e/` | Read-only e2e cases, runs, checks, logs and evidence for one project (capability routes under `/e2e`; reloads on focus, polls only `/active` during a run) | Fixed dark |

Per-surface behaviour and endpoints are specified in `docs/134`, `docs/168`,
`docs/170`, `docs/171`, `docs/185`, `docs/186`, `docs/192`, `docs/211`,
`docs/313`, `docs/329`, `docs/341`, and `docs/adr/0002`/`0010`/`0026`. **This
file is the visual contract only** — it does not restate those specs.

**One exception, by design (spec 313 rev 3).** Inside the GenUI component
gallery, `.lb-genui__stage` is not a loopback surface: it reproduces the Krypton
window a component actually lives in, painted from the app's own resolved theme
and `[font]` fetched over loopback. Its border, radius, backdrop and glow are
`.krypton-window`'s, not this file's, and the catalog inside it answers to
`--krypton-*` / `--agent-*`. Everything around it — rail, search, headings,
parameter table, pager — stays fixed dark as above. Do not restyle the stage to
this palette, and do not extend the exception to another surface.

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

All loopback surfaces share the same soft canvas family — `--bg #17191d`, `--card`
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

Every page caps its content and centres it (`margin: 0 auto`) instead of
running edge to edge, through the page classes in `base.css`: `.lb-page`
(`1140px`, single column: Home, dashboard, gallery, MCP tools), `.lb-page--wide`
(`1180px`, two-pane readers: docs, analyses, reviews), `.lb-page--split` and
`.lb-page--fill` (`1400px`, split and full-height tools: commands, GenUI
gallery, Terminal Control, ACP wire, Hurl, E2E). Past the cap the extra width
only separates a fixed rail from fixed content.

## Components

The kit (`src/loopback/kit/`, exported from `kit/index.ts`) is the component
catalog; a surface uses these before writing its own. Class names are BEM under
`lb-`; Rust-rendered markup uses the same classes so the kit styles it.

- **Shell** (`.lb-shell`, `AppShell`) — 44px sticky bar on every page: brand →
  Home, `/ project ▾ / surface` in mono, a `limited` marker without a session,
  and the two shell keys (`` ` `` switcher, `?` keys). Hairline bottom border,
  no card fill.
- **Switcher / key help** (`.lb-switcher`, `.lb-keyhelp` on `.lb-overlay`) —
  centred `--card` panel over a flat `rgba(0,0,0,.55)` scrim (never a blur).
  Selected row = `--tint` fill + accent border.
- **Card** (`.lb-card`, `card()`) — `--card` fill, `1px --border`, `10px`
  radius, `12–13px` padding. The standard surface; Home tiles (`.lb-tile`) are
  cards. Do **not** nest one inside another.
- **Status dot** (`.lb-dot`, `dot()`) — `10px` circle; `--muted` idle, static
  `--add` / `--accent` / `--del` states, and `live`: `--add` with the
  `lb-beacon` keyframe (expanding green ring, `2s` loop). The single sanctioned
  animation in this system.
- **Pill** (`.lb-pill--{accent,add,del,muted}`, `pill()` + `statusTone()`) —
  `10px` mono, `.04em` tracking, full 1px border in the tone; colored by the
  status table above. State badge, not a button.
- **Stat tile** (`.lb-stat`, `StatBar`) — small `--muted` mono label under a
  large accent mono numeral (`19px`, tabular); `add`/`del`/`muted` tones.
- **Chip** (`.lb-chip`, `chip()`) — `--code-bg` capsule with a mono count;
  accent numeral, red when `--alert`, `--muted` for constraint/meta labels.
- **Button** (`.lb-btn`, `button()`) — `primary` is accent-filled with
  `--on-accent` text (the one place text sits *on* the accent); `secondary` and
  `ghost`; `toggle` shows `aria-pressed="true"` as accent text + border + tint.
  Disabled: `--code-bg` fill, `--muted` text, `pointer-events:none`.
- **Tabs** (`.lb-tabs`, `Tabs`) — mono segmented row; the selected tab is
  accent-filled; optional `1`–`9` key hints.
- **Filter** (`.lb-filter`, `SearchFilter`) — `--code-bg` mono input with a
  muted match count; `/` focuses it.
- **Roster** (`.lb-roster`, `RosterList`) — keyboard list; the selected row is
  `--tint` + a full accent border (never a left rail).
- **Table** (`.lb-table`, `DataTable`) — mono cells, accent `th` on `--card`,
  hairline rows; **key/value** (`.lb-kv`, `keyValue()`).
- **Banner** (`.lb-banner`) — the transient status line: accent tint (info),
  green (ok), red (error).
- **Empty state** (`.lb-empty`) — centered `--muted` mono line. Every list/grid
  has one.
- **Key hints** (`.lb-hints`, `kbdHints()`) — `--muted` mono footer under a top
  hairline, `kbd` caps; carries poll cadence / counts.
- **Prose** (`.lb-prose`) — the markdown reader: `820px` max-width, `15px`/1.65,
  `--text` body, accent h1/h3, hairline-ruled h2, `--code-fg` inline code,
  bordered `pre`/tables, muted blockquote with `rgba(112,122,138,.08)` tint,
  `dl.frontmatter` key/value card.
- **Tree nav** (`.lb-tree-nav` / `.lb-tree`) — the analyses/reviews sidebar:
  sticky card, groups with counts, `aria-current` item in accent.
- **Gauge / resource bar** (dashboard surface, `.lb-dashboard__gauge`,
  `.lb-dashboard__bar`) — canvas arc with a `30px` accent numeral that shifts to
  `--add`/`--del` by state; `6px` track on `--code-bg` with a green fill
  (`width .3s ease`). Canvas colours are read from the CSS tokens.

## Motion

Restrained. The only ambient motion is the live status `beacon` (a `2s`
expanding-ring pulse on green dots) and `.3s` resource-bar width transitions.
Everything else is instantaneous or a sub-`150ms` color/hover transition. These
are *live status* pages, so a heartbeat is appropriate — but nothing slides,
fades in, or animates on load. Data updates by repaint, not by transition.

## Theming policy

Theming behaviour is deliberately **per-surface**, by what the page is for. The
document carries it as `<html data-scheme="dark|auto">`; `auto` swaps the light
token set under `prefers-color-scheme: light`. The shell and kit read only
tokens, so they follow the page.

- **Artifact scaffold** ships the full `binance → light → auto` toggle
  (`.ka-toggle`), best-effort persisted to `localStorage`. A lane's artifact may
  be read anywhere, so the reader controls the mode.
- **Readers** (docs/journal, analyses, reviews, timeline) are `auto` — *no
  manual toggle*, they follow the OS. A reading surface should match the
  reader's system without a control to fiddle.
- **Home, status walls and tools** (dashboard, gallery, commands, MCP tools,
  GenUI shell, Terminal Control, ACP wire, Hurl, E2E) are **fixed dark**. They
  are glanceable status walls meant to live on a second screen; a light mode
  would only invite a stray click. No toggle by design.

When adding a new loopback surface, pick the matching policy — don't add a
toggle to a status wall or strip auto-theming from a reader.

### Feedback overlay (artifact scaffold + docs browser)

The artifact scaffold (spec 149) self-injects a small fixed comment overlay; the
docs browser (spec 172) uses the kit's `FeedbackOverlay`
(`src/loopback/kit/feedback-overlay/`, `.lb-feedback*`). Both are a
bottom-right pill, an accent hover-highlight box, and a composer card built from
the shared tokens (`--card`, `--accent`, `--border`, `--muted`, mono font), so
they read as one component. It is a high-`z-index` fixed widget, never inline
chrome; keep it token-driven (the scaffold's copy keeps `var(..., fallback)`
defaults because it renders without the app's sheet) and obey the house rules —
full borders, no left rails, one accent.

## House rules

1. **No left accent borders (`border-left` rails).** To color-code a block use a
   full border, a background tint, or heading/icon color. The artifact scaffold
   ships a runtime backstop that strips any left-only border, so a rail will not
   render anyway — but author it correctly everywhere in the loopback app,
   which has no such backstop.
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
