# Which-Key Icons — Implementation Spec

> Status: Implemented (2026-11-05; approved the same day)
> Date: 2026-11-05
> Milestone: M8 — Polish
> Amends: [0358](./0358-command-palette-icons.md) (Out of Scope: the which-key popup), [0085](./0085-contextual-leader-keys.md) (`LeaderKeySpec`)

## Problem

A which-key row is text only: key, label. The Compositor popup lists 50–60 rows in up to eight
groups, so finding `Vault Viewer` or `Review Board` means reading labels one by one. The user
wants an SVG icon on every item in the popup, like the Commands rows of the palette (spec 0358).

## Solution

`KeyEntry` and `LeaderKeySpec` get a **required** `icon: PaletteIconName`. `WhichKey.setMode`
renders each row as key · icon · label. Glyphs come from the vendored Lucide set in
`src/palette-icons.ts`: a command that already has a palette row keeps that glyph (one concept,
one glyph), and 45 new glyphs are vendored verbatim from the same `lucide-static` version. Every
mode gets icons, not only Compositor, so the popup never mixes rows with and without an icon, and
the required field makes the compiler reject a new binding that has none.

## Research

- **Render path** (`which-key.ts:399-448`): `setMode` clears `.krypton-whichkey__keys` and rebuilds
  every row on each mode change. `.krypton-whichkey__list` is a two-track grid
  (`max-content minmax(0, 1fr)`); `__entry` is a subgrid spanning both tracks.
- **Entry sources**: ten static tables in `which-key.ts` (Scroll/Stage/Wheel window keys, the
  Compositor groups, Resize, Move, Swap, TabMove, Hint, Selection) and the focused view's runtime
  `LeaderKeyBinding`s, copied by `leaderBindingsToEntries`: harness 11
  (`acp-harness-view.ts:4263`), markdown 1 (`MARKDOWN_LEADER_KEYS`), pencil 2
  (`PENCIL_LEADER_KEYS`). The review board views return `[]`. `ACP_HARNESS_LEADER_KEYS` (5 specs)
  is the static list `leader-keys.test.ts` validates; the harness builds its 11 bindings as
  separate literals, so both lists carry icons.
- **Glyph module**: `paletteIcon(name, className)` already takes a class (the Compositor emblem
  passes its own), parses each glyph once and clones per use.
- **Lucide manifest** (`lucide-static@1.67.0/icon-nodes.json`): all 45 new names exist. `music` and
  `history` are not names in 1.67.0; the shipped names are `eighth-notes` and `rotate-ccw-clock`.
  New glyphs on the Lucide LICENSE Feather list: `check`, `crosshair`, `hash`, `move`, `type` —
  they join the MIT notice list in the module header.
- **Glyph choices checked on a contact sheet at 14px.** Swap: `arrow-left-right` is the mirror of
  Hurl's `arrow-right-left`, and both rows sit in one Compositor popup; `replace` is the Lucide
  glyph tagged "swap" and reads differently. `pilcrow-right` for Word End read as "paragraph";
  `arrow-right-to-line` reads as "to the end".
- **Alternatives ruled out:**
  - *Compositor mode only*: Resize/Move/Selection would be the only text-only rows of one popup.
  - *Optional `icon?`*: a new binding could ship without one and nobody would notice (0358's reason).
  - *Nerd Font glyphs in the label*: depend on the user's terminal font; the palette uses SVG.
  - *Icon before the key*: the key is what the user scans for; which-key.nvim puts the icon
    between key and description.
  - *A second colour for icons*: the row's effect colour (important/danger) already marks it.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| which-key.nvim | Columns `key` · `sep` · `icon` · `desc` (`view.lua`); `icon` per mapping or by rule, colour per icon highlight | Placement adopted |
| VSCode Which Key (VSpaceCode) | `BindingItem.icon?: string` names a VS Code product icon, shown before the name; `whichkey.showIcons` toggles | Per-binding field, optional |
| Helix | `Info::new` writes `key  desc` lines; no icons (`helix-view/src/info.rs`) | Text only, like Krypton today |

**Krypton delta:** follows which-key.nvim's placement. Unlike VSpaceCode the field is required and
there is no show/hide setting (not asked). Icons are monochrome and take the row's colour.

## Affected Files

| File | Change |
|------|--------|
| `src/which-key.ts` | `KeyEntry.icon` (required); an icon on every static entry; `leaderBindingsToEntries` copies it; `setMode` appends the svg between key and label |
| `src/types.ts` | `LeaderKeySpec.icon: PaletteIconName` (required) |
| `src/acp/acp-harness-view.ts` | `ACP_HARNESS_LEADER_KEYS` and the 11 `getLeaderKeyBindings()` literals name their icon |
| `src/markdown-view.ts`, `src/pencil-view.ts` | `MARKDOWN_LEADER_KEYS`, `PENCIL_LEADER_KEYS` name their icon |
| `src/palette-icons.ts` | 45 Lucide bodies; header comment and Feather list |
| `src/styles/overlays.css` | Three-track list grid; `.krypton-whichkey__icon`; effect colours cover the icon |
| `docs/0004-architecture.md` | Which-key DOM comment; local leader keys paragraph names `icon` |
| `docs/0358`, `docs/0085`, `docs/README.md` | "Amended by 0360" notes, `LeaderKeySpec` shape, index row |

## Design

### Data Structures

```ts
// src/which-key.ts
interface KeyEntry {
  key: string;
  label: string;
  /** Glyph drawn between key and label. Same concept, same glyph as the palette. */
  icon: PaletteIconName;
  effect?: 'important' | 'danger';
  group?: string;
  contentTypes?: (PaneContentType | null)[];
}

// src/types.ts
export interface LeaderKeySpec {
  key: LeaderKeyId;
  label: string;
  icon: PaletteIconName;
  group?: string;
  effect?: 'important' | 'danger';
}
```

### Icon Map

`*` = new glyph vendored by this spec; the rest already exist for a palette row.

| Group | key → icon |
|---|---|
| Windows (all layouts) | `n` square-plus · `x` x · `h` `j` `k` `l` arrow-left/down/up/right · `1-9` hash* · `!` bell-ring · `f` repeat · `r` scaling* · `m` move* · `s` replace* · `z` maximize-2 · `p` pin |
| Windows (Scroll) | `,` arrow-left-to-line* · `.` arrow-right-to-line* · `=` unfold-horizontal* |
| Windows (Stage, Wheel) | `h/k` chevrons-left · `j/l` chevrons-right · Stage `=` rotate-ccw-square* · Wheel `s` Reorder replace* |
| Tabs / Panes | `t` plus · `w` x · `[` chevrons-left · `]` chevrons-right · `T` square-arrow-right* · `\` columns-2 · `-` rows-2 · `A-hjkl` crosshair* · `A-x` x · `O` panel-right |
| Apps | `b` folder-tree* · `u` vault* · `e` pencil · `q` arrow-right-left · `$` chart-column · `M` eighth-notes* · `P` gauge* · `K` keyboard · `H` mouse-pointer-click* · `X` satellite-dish* |
| AI | `a` sparkles · `Y` bot · `S` server · `R` clipboard-list |
| Terminal | `v` text-cursor* · `V` text-align-start* · `d` `D` diff · `i` toggle-left · `I` copy · `o` file-text · `J` calendar · `c` `C` copy-plus · `g` `G` wand-sparkles* |
| Markdown | compositor `o` file-text · local `;` Link Hints mouse-pointer-click* |
| Pencil (local) | `/` Open Drawing Here folder-open* · `?` New Drawing file-plus-corner* |
| Harness / Lane (local) | `+` circle-plus* · `_` x · `=` chart-line* · `0` rotate-ccw-clock* · `.` scroll-text* · `,` cpu* · `;` inbox* · `'` grid-3x3* · `/` flag* · `` ` `` network* |
| Resize | `←` chevrons-right-left* · `→` chevrons-left-right* · `↑` chevrons-down-up* · `↓` chevrons-up-down* · `H/L` separator-vertical* · `K/J` separator-horizontal* · `=` scale · `Esc` Done check* |
| Move, Swap | arrows arrow-left/right/up/down · Move `Esc` Done check* |
| TabMove, Hint | `1-9` hash* · `a-z` type* · `Bksp` delete* · `Esc` Cancel circle-x* |
| Selection | `h/l` move-horizontal* · `j/k` move-vertical* · `w/b` whole-word* · `e` arrow-right-to-line* · `0/$` arrow-left-right* · `gg/G` arrow-up-down · `v` text-cursor* · `V` text-align-start* · `y` clipboard-copy* · `Esc` Exit circle-x* |

### Data Flow

```
1. InputRouter mode change → WhichKey.setMode(mode, contentType, leaderKeys, layoutMode).
2. Entries = the mode's static table (+ enabled focused-view bindings in Compositor);
   each carries `icon` (type-checked), bindings via leaderBindingsToEntries.
3. Each row appends key span, paletteIcon(entry.icon, 'krypton-whichkey__icon')
   (a clone of a template parsed on first use), label span.
```

### UI Changes

```
.krypton-whichkey__entry
  span.krypton-whichkey__key
  svg.krypton-whichkey__icon      ← new, second child
  span.krypton-whichkey__label
```

- `.krypton-whichkey__list`: `grid-template-columns: max-content max-content minmax(0, 1fr)`;
  `column-gap` stays 10px. Group headers keep `grid-column: 1 / -1`.
- `.krypton-whichkey__icon`: `font-size: var(--krypton-font-size, 13px); width/height: 1em`
  (13px), `fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap/join: round;
  color: var(--krypton-whichkey-label, …)`. *Deviation from the approved draft:* the draft said
  1.1em (14.3px, the palette icon's size); in the smoke run that made every row 0.3px taller
  (18.30px vs 18.00px) and the Compositor popup 8px taller, so the icon is 1em and stays inside
  the label's line box.
- The existing `--important` / `--danger` colour rules add `.krypton-whichkey__icon` to their
  selector lists, so the icon takes the label's colour on every row.
- No animation, no filter, no `backdrop-filter`, no corner brackets. The Compositor emblem is
  unchanged.

## Edge Cases

- **Variant pairs share a glyph** (`d`/`D` diff, `c`/`C` copy-plus, `g`/`G` wand-sparkles, every
  close `x`), as in the palette; key and label tell them apart.
- **Content-type filtered rows** keep their icon; filtering removes the whole entry.
- **Disabled local bindings** stay hidden (spec 0085); no icon is drawn for them.
- **Row height**: the 1em icon sits inside the label's line box. Measured in Chromium: 18.00px
  per row with and without icons in Compositor, Resize and Selection; popup height unchanged
  (680px Compositor · acp_harness · Stage), and the emblem still shows there.
- **Popup width** grows by one icon track plus one gap per column: +38px in all five measured
  modes (459→497px Compositor · acp_harness · Stage); `max-width: min(760px, …)` is unchanged.
- **Filled dots**: `vault` fills its four bolt dots with `fill="currentColor"`, like `images` and
  `palette` (spec 0358). `fill: none` sits on the svg only, so the attribute wins and the dots stay
  filled; the module header's list of filled glyphs gains `vault`.
- **Light themes**: `currentColor` follows the `--krypton-whichkey-*` variables.
- **Cost**: at most ~70 clones per mode change; templates are parsed once per glyph.

## Open Questions

None.

## Out of Scope

- Icons on the keyboard overlay, the harness `#` inline palette, Files and Grep rows.
- A setting to hide icons, or user-configurable icons.
- Renaming `palette-icons.ts` / `paletteIcon` now that the popup uses them too.
- Changing keys, labels, groups or the Compositor emblem.

## Resources

- [which-key.nvim README](https://github.com/folke/which-key.nvim) and
  [`lua/which-key/view.lua`](https://github.com/folke/which-key.nvim/blob/main/lua/which-key/view.lua) —
  key · sep · icon · desc column order; per-mapping `icon`.
- [VSpaceCode Which Key reference](https://vspacecode.github.io/docs/whichkey/reference) —
  `BindingItem.icon?`, `whichkey.showIcons`.
- [Helix `helix-view/src/info.rs`](https://github.com/helix-editor/helix/blob/master/helix-view/src/info.rs) —
  key/description text only.
- [lucide-static@1.67.0 `icon-nodes.json` / `tags.json`](https://unpkg.com/lucide-static@1.67.0/) —
  name check, "swap" tag; bodies come from `icons/<name>.svg`.
- [Lucide LICENSE](https://github.com/lucide-icons/lucide/blob/main/LICENSE) — ISC, plus MIT for the
  Feather-derived list.
