# Command Palette Icons — Implementation Spec

> Status: Implemented (2026-11-04; approved the same day)
> Date: 2026-11-04
> Milestone: M8 — Polish
> Amends: [0349](./0349-unified-search-palette-tabs.md) (Commands row content), [0110](./0110-context-aware-command-palette.md) (`PaletteAction`)
> Amended by: [0360](./0360-which-key-icons.md) — which-key rows draw glyphs from the same module

## Problem

A Commands row is text only: category tag, label, key. With 115 rows, 40 of them tagged
`WINDOW`, the eye has to read every label to tell `Open Docs Browser` from `Open Artifact
Gallery`. The user wants every command to carry an SVG icon so the list can be scanned by
shape.

## Solution

Every `PaletteAction` gets a **required** `icon` field naming one glyph from a vendored
Lucide subset (`src/palette-icons.ts`). `ActionRow.render` puts the icon first in the row, in
a fixed-width column at the same x on every row, before the category tag. One concept keeps
one glyph across categories (every "focus left" is `arrow-left`; the tag tells window from
pane). The field is required, so the compiler rejects any static, dynamic or contextual
action that has no icon.

## Research

- **Row today** (`command-palette.ts:86-119`): category `span`, optional swatch (spec 304),
  label with `<mark>` matches, key. `SearchPalette.setRows` (`search-palette.ts:323-354`)
  rebuilds every row element on each query; there is no virtualisation.
- **Action sources**: 95 `register`/`push` sites in `command-palette.ts` (static, plus
  dynamic unpin, dashboards, harness openers, color themes, window colors, sound themes),
  `AcpHarnessView.getPaletteActions` (10, `acp-harness-view.ts:15831`) and
  `UsageView.getPaletteActions` (1, `usage-view.ts:533`). No other `PaletteAction` producers.
- **Icon convention in the repo**: `review-board/icons.ts` — a name union, a
  `Record<Name, body>`, each SVG parsed once and cloned per use, `currentColor` stroke set by
  CSS, `aria-hidden`. The footer and harness icons use the same `currentColor` idea. This
  spec reuses that module shape.
- **Glyph source**: all 87 names below exist in `lucide-static` v1.67.0 (checked against
  unpkg). Lucide is ISC-licensed, 24×24, 2px round stroke, no fills — one consistent outline
  family. Two candidates were swapped after a contact-sheet check at 14px: `ferris-wheel`
  (illegible) → `orbit`, `gallery-thumbnails` → `gallery-horizontal-end` (reads as Stage
  Manager's side strip).
- **Alternatives ruled out:**
  - *One icon per category*: repeats the tag and does nothing for the 40 `WINDOW` rows.
  - *Hand-drawn 16×16 set* (the footer/review convention): 87 new glyphs with no designer,
    uneven weight. Lucide already solves consistency.
  - *`lucide` npm dependency*: a runtime package for ~10 KB of path strings; vendoring the
    bodies adds no dependency.
  - *Optional `icon?` with a category fallback*: a new command could ship without its own
    icon and nobody would notice.
  - *Semantic colours* (JetBrains green create / red destroy): the tag is already the coloured
    element; a second colour per row adds noise. Icons are monochrome.
  - *Icon replaces the tag*: not asked, and the query matches `Category: Label`.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Raycast | Leading icon on every root result; the 2022 redesign made it larger "making it quicker to scan" | Matches the ask |
| Linear (Setproduct teardown) | Row = icon, label, optional description, right-aligned shortcut | Same row anatomy as this spec |
| JetBrains Find Action | Shows an action's toolbar icon in a left column; icons are monochrome grey by default | Grey default adopted |
| VS Code | Command palette shows no icons (microsoft/vscode#104549) | Text only, like Krypton today |
| Zed | No per-command icon; only a history-rerun glyph on recent rows (`command_palette.rs:473`) | Text only |

**Krypton delta:** follows Raycast/Linear (icon on every row). Keeps the category tag and
key column. Icons are ink-coloured and light up on the selected row; nothing needs the mouse.

## Affected Files

| File | Change |
|------|--------|
| `src/palette-icons.ts` (new) | `PaletteIconName` union, Lucide bodies, `paletteIcon(name)` parse-once/clone, ISC notice |
| `src/palette-types.ts` | `PaletteAction.icon: PaletteIconName` (required) |
| `src/command-palette.ts` | `ActionRow.render` prepends the icon; every static and dynamic action names its icon |
| `src/acp/acp-harness-view.ts` | 10 context actions name their icon |
| `src/usage-view.ts` | `usage.refresh` names its icon |
| `src/styles/search-palette.css` | `.krypton-search-palette__icon` + selected-row colour |
| `docs/0349`, `docs/0110`, `docs/README.md` | Row content, `PaletteAction` shape, "Amended by 0358" notes, index row |

## Design

### Data Structures

```ts
// src/palette-icons.ts
const ICON_BODY = { /* Lucide inner-markup strings, verbatim: 87 here, 132 after spec 0360 */ } as const satisfies Record<string, string>;
export type PaletteIconName = keyof typeof ICON_BODY; // the names live in one place
export function paletteIcon(name: PaletteIconName, className = 'krypton-search-palette__icon'): SVGElement;
// <svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">…</svg>
// The which-key popup passes 'krypton-whichkey__icon' for its rows (spec 0360) and
// 'krypton-whichkey__emblem-icon' for its Compositor emblem.

// src/palette-types.ts
export interface PaletteAction {
  // …existing fields…
  /** Glyph drawn first in the row. Same concept, same glyph across categories. */
  icon: PaletteIconName;
}
```

### Icon Map

| Category | id → icon |
|---|---|
| Window | `window.create` square-plus · `window.close` x · `window.maximize` maximize-2 · `window.pin` pin · `window.unpin.*` pin-off · `window.focus-left/right/up/down` arrow-left/right/up/down · `window.focus-next/prev` chevrons-right/left |
| Window (openers) | `diff.open`, `diff.open-staged` diff · `agent.open` sparkles · `markdown.open` file-text · `daily.open` calendar · `pencil.open` pencil · `usage.open` chart-column · `telegram.settings` send · `computers.open` monitor · `loopback.home` house · `dashboard.open` activity · `gallery.open` images · `genui-gallery.open` shapes · `docs.open` book-open · `analyses.open` file-search · `review.open` clipboard-list · `reviews.open` archive · `termctrl.open` radar · `program-status.next` bell-ring · `hurl.open` arrow-right-left · `hurl.open-web` globe · `hurl.clear-cache` trash-2 · `acp.harness.open` bot · `acp.harness.open-remote` server |
| Window (ACP Wire) | `acp-wire.open` cable · `acp-wire.capture-off` circle-off · `acp-wire.capture-meta` circle-dashed · `acp-wire.capture-full` circle-dot · `acp-wire.clear` trash-2 |
| Workspace | `workspace.footer.toggle-density` list · `workspace.footer.toggle-visible` panel-bottom · `workspace.keyboard-overlay.toggle` keyboard |
| Layout | `layout.toggle` repeat · `layout.scroll` gallery-horizontal · `layout.grid` layout-grid · `layout.focus` layout-panel-left · `layout.depth` layers · `layout.stage` gallery-horizontal-end · `layout.wheel` orbit |
| Tab | `tab.create` plus · `tab.close` x · `tab.next/prev` chevrons-right/left |
| Pane | `pane.split-vertical` columns-2 · `pane.split-horizontal` rows-2 · `pane.close` x · `pane.focus-*` arrow-* · `pane.cycle-next/prev` chevrons-right/left · `pane.markdown-to-side` panel-right · `pane.split-grow-left/right/up/down` arrow-left/right/up/down-from-line · `pane.split-equalize` scale |
| Terminal | `terminal.quick-toggle` square-terminal · `terminal.scroll-up/down` arrow-up/down-to-line · `terminal.native-output.toggle` toggle-left · `terminal.native-output.copy` copy |
| ACP | `acp.live-assist.toggle` picture-in-picture-2 · `acp.peek.show/hide` eye/eye-off · `acp.peek.next/prev` chevrons-right/left · `acp.peek.activate` corner-down-left · `acp.peek.unlock` lock-open · `acp.peek.heat.metric` flame · `acp.peek.heat.window` clock · `acp.peek.heat.detail` list · `lessons.open` lightbulb |
| ACP Harness (context) | `reconnect-remote` link · `acp.backends.update` download · `assistants` square-stack · `start-review-thread` messages-square · `cancel` circle-stop · `restart` rotate-ccw · `switch-lane` arrow-up-down · `show-memory` brain · `dispatch-github-issue` wrench · `open-issue` external-link (ids under `acp.harness.`) |
| Others | `ssh.clone-tab/window` copy-plus · `config.reload` refresh-cw · `claude.copy-hook-config` copy · `claude.show-hook-port` plug · `dashboard.*` layout-dashboard · `theme.color.*` palette · `window.accent.*` droplet · `sound.theme.*` volume-2 · `usage.refresh` refresh-cw |

### Data Flow

```
1. CommandScope.rebuildActions() builds PaletteAction[]; each carries `icon` (type-checked).
2. filter(q) wraps actions in ActionRow; SearchPalette.setRows calls row.render(el).
3. render appends paletteIcon(action.icon) — a clone of a template parsed on first use —
   then category, swatch (Window Color only), label, key.
```

### UI Changes

```
.krypton-search-palette__row
  svg.krypton-search-palette__icon   ← new, first child
  span.__category · span.__swatch? · span.__label · span.__key
```

- `.krypton-search-palette__icon`: `flex: none; width/height: 1.3em` (scales with the chrome
  font), `fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap/join: round`,
  `color: var(--krypton-palette-text)` at `opacity: 0.7`.
- `.krypton-search-palette__row--selected .krypton-search-palette__icon`:
  `color: var(--krypton-palette-highlight); opacity: 1`.
- Context rows stay marked only on their tag (ADR-0027); the icon is not a second marker.
- No animation, no `backdrop-filter`, no corner brackets; Files and Grep rows unchanged.

## Edge Cases

- **Window Color rows** show the droplet icon and the colour swatch; the swatch stays the
  colour cue (spec 304).
- **A future context action without an icon** fails `npm run check`, not at runtime.
- **Long labels** (`Cycle Layout (Grid/Focus/Depth/Scroll/Stage/Wheel)`): the row gains
  ~1.3em + 8px gap; at 600px the longest label plus its key still fits on one line.
- **Per-keystroke cost**: one clone of a small SVG per result row per query; templates are
  parsed once per glyph, never per row. Row height is unchanged (25.19px with and without
  the icon in the smoke run).
- **Filled dots**: Lucide fills the dots of `images` and `palette` with
  `fill="currentColor"`. CSS sets `fill: none` on the `<svg>` only, so those attributes win
  over the inherited value and the dots stay filled.
- **Light themes**: `currentColor` follows `--krypton-palette-text` / `-highlight`, so
  `krypton-light` and custom themes need no change.

## Out of Scope

- Icons on Files and Grep rows, the harness `#` inline palette and the keyboard overlay. (The
  which-key popup was listed here; spec 0360 gives every which-key row a glyph from this module.)
- Changing, removing or restyling the category tag.
- Theme schema or `[tokens]` changes.
- Migrating the footer, harness or Review Board icons to Lucide.

## Resources

- [Lucide icons (lucide-static v1.67.0)](https://lucide.dev/icons/) — glyph source; bodies
  fetched from `https://unpkg.com/lucide-static@1.67.0/icons/<name>.svg`.
- [Lucide license (ISC, plus MIT for Feather-derived icons)](https://github.com/lucide-icons/lucide/blob/main/LICENSE) —
  both notices and the list of the 17 Feather-derived glyphs used are in the module header.
- [Raycast — A fresh look and feel](https://www.raycast.com/blog/a-fresh-look-and-feel) —
  leading result icons enlarged "making it quicker to scan".
- [Setproduct — Command Palette UI Design](https://www.setproduct.com/blog/command-palette-ui-design-guide) —
  row anatomy: icon, label, description, shortcut.
- [IntelliJ Platform — Icons](https://plugins.jetbrains.com/docs/intellij/icons-style.html) —
  monochrome grey action icons by default; colour only for semantics.
- [microsoft/vscode#104549](https://github.com/microsoft/vscode/issues/104549) — VS Code's
  command palette shows no icons.
- Zed `crates/command_palette/src/command_palette.rs:473` (local `/Users/wk/Source/zed`) —
  only the history row has an icon.
