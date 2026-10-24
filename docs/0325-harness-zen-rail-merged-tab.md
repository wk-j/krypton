# Harness Zen Rail Merged Tab — Implementation Spec

> Status: Implemented (rev 2 — a first-row tab meets the titlebar, and every body corner that faces the rail is round)
> Date: 2026-10-22
> Milestone: ACP Harness — Zen Mode polish
> Builds on: 0080 (Zen Mode) · 0125 (rail entry anatomy) · 0215 (lane identity bands) · 0301/0302 (component kernel, `LaneRail` / `RailEntry`) · 0321 (light scheme)

## Problem

**User request (2026-10-22):** "I also want to improve tab UI for harness lane, make it more smooth and blend togehter with the content like this", with a screenshot of a settings sidebar. In that screenshot the selected item is painted in the content panel's colour, has rounded corners on the sidebar side, and joins the panel through two concave curves.

In Zen Mode the active rail entry is a full-width rectangle tinted 11% with the lane accent (`rail-entry.css` `.acp-harness__rail-entry--active`). It has hard corners and stops at the rail's edge. The rail behind it is a separate translucent column (`--agent-ghost`, accent at 8%), so the selected lane does not read as connected to the transcript it opens. In a screen capture of the running app (one lane, `OMP-1`), the active row is a purple strip on a green-tinted column, beside a darker body.

**Rev 2 requirement (user, 2026-10-24):** "I want to make the UI for seamless i see the cut border is not look harmony to the overall app UI", with a screenshot of one lane (`OMP-1`) and two arrows:

- **Top arrow.** The rail's 8px top padding left a strip of rail colour between the titlebar and the first-row tab. The tab's upper fillet turned the strip's end into a notch where the tab met the body.
- **Bottom arrow.** The rail colour ended in a square corner where the body and the composer meet. That was the only square corner on the rail's edge; the tab's corners and fillets are all round.

## Solution

The active rail entry becomes a **tab cut from the body's own surface**:

- It is painted with the same colour as the active lane body (`--agent-surface-mid`).
- It is rounded on the rail side and runs flush into the body.
- Two concave fillets join it to the body, one above and one below.
- There is no seam: the tab is painted with the body colour over the same backdrop as the body, never over a painted rail.
- **Rev 2:** the body, the tab and the composer form one sheet. Every corner of that sheet that faces the rail is round, with the same radius as the tab. A first-row tab sits flush under the titlebar.

Inactive entries become 8px-rounded rows, inset from both rail edges. In Zen Mode the active lane's head and stats bands lose their tint, so the tab joins one uniform body surface. Switching lanes stays instant.

"Smooth" is read as the shape: rounded, joined, no hard rectangle. A sliding animation is not added (see Alternatives).

## Research

- **Zen is the user's daily layout.** The webview's `localStorage` holds `krypton:acp-harness:zen:<dir> = 1` for 31 project directories, including this repo.
- **Surfaces today** (`theme.ts:371-376`; `harness-shared.css:268-274`, `:1267-1276`):

  | Surface | Dark | Light |
  |---|---|---|
  | Rail (`--agent-ghost` / `--agent-surface-rail`) | accent @ 0.08 | fg/backdrop mix @ 0.92, plus a 1px `border-right` (`lane-rail.css`) |
  | Body (`--agent-surface-mid`) | backdrop @ 0.55 | white @ 0.78 |

  Both are translucent over a transparent window. There is no blur, so the wallpaper shows through.
- **Why the obvious fix leaves a seam.** If the active entry paints the body colour on top of the rail, the tab gets the body colour plus the rail tint underneath it, while the body next to it has no rail tint. The tab ends up about 3.6% accent-tinted in dark (0.45 × 0.08) and about 2% darker in light. Spec 215 measured a 3.5% wash as at the threshold of visibility on this backdrop, so a faint seam would show along the join. The tab must therefore not sit on top of a painted rail.
- **Cut-out instead of overlay.** An outer `box-shadow` "is drawn outside the border edge only: it is clipped inside the border-box of the element" (CSS Backgrounds 3), and that clip follows the border radius. One element can therefore paint the rail colour everywhere *except* its own rounded box while its own background paints the body colour. Nothing translucent sits under the tab.
- **Paint order.** In a stacking context, children with a negative `z-index` paint before every in-flow block background and every line of text (CSS 2.1 Appendix E). If the rail is its own stacking context and the tab's paint layer has `z-index: -1`, every entry's tint and text still paints over it.
- **Earlier rule about pseudo-elements.** Spec 80 says rail styling avoids "stacked `::before`/`::after` glow layers". That rule exists to keep decorative glows and their cost off the rail. This spec adds two static pseudo-elements, the tab (`::before`) and its fillets (`::after`). Both are surfaces, not glows, and neither animates. The rule is kept by its purpose.
- **Spec 215 head band.** In the stacked dashboard, the active lane's head and stats rows carry a 13% accent band so the lane can be told apart from the collapsed bands. Zen shows a single lane in the body, and the merged tab now identifies it. With the band kept, a first-row tab (the single-lane case) would join a band of a different colour.
- **Inverted-radius technique.** A known CSS approach builds inverted corners with `mask` gradients (css-tip.com). Rejected here: a mask on the rail would have to follow the active row's position, which needs JS measurement or anchor positioning.

### Alternatives rejected

- **Body colour painted over the rail.** Leaves the 2–3.6% seam described above.
- **A sliding tab** (one indicator element, moved with `transform` on each lane switch). It needs a layout read and a `ResizeObserver` (font zoom changes row heights). Lane switching is keyboard-driven (`Ctrl+N`/`Ctrl+P`, `1`–`9`) and can repeat fast, so a 150ms slide would lag behind the keys. Keypress-to-render must stay under 16ms.
- **Masking the rail colour.** Same position-tracking problem as the inverted-radius mask.
- **Accent tint kept on the tab.** A tinted tab cannot match the body colour, which is the whole point of the request.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code (Dark Modern) | `tab.activeBackground` and `editor.background` are both `#1F1F1F`; `tab.inactiveBackground`, `editorGroupHeader.tabsBackground` and `sideBar.background` are `#181818` | The active tab is the editor's surface; corners are square |
| Chrome tab strip | The active tab takes the toolbar colour and flares into it with concave bottom curves; inactive tabs have no fill | Closest to the requested shape, but on a horizontal strip |
| User's reference (settings sidebar) | Darker sidebar; the selected row takes the panel colour, has rounded left corners, and joins the panel with concave curves | The target |
| Arc sidebar | The selected tab is a raised light card inside the sidebar, not joined to the page | Rejected look: it does not join the content |

**Krypton delta.** The shape follows Chrome and the reference. Krypton keeps its own 8px bevel token, adds no glow and no corner brackets, and does not animate the switch, because lane switching is keyboard-first.

## Affected Files

| File | Change |
|------|--------|
| `src/styles/harness-shared.css` | `.acp-harness` declares `--acp-lane-canvas: var(--agent-surface-mid, rgba(6, 10, 18, 0.48))`; `.acp-harness__lane--active` reads it. `.acp-harness__rail` declares `--acp-rail-surface`, adds `isolation: isolate`, and paints its own background only when it has no active entry. Rev 2: `--acp-rail-tab-r` moves to the zen dashboard, which also becomes `position: relative`; the rail loses its top padding and rounds its bottom-right corner; the dashboard's `::after` paints the bottom corner fillet; the active lane rounds its top-left corner when the tab is not the first row |
| `src/acp/components/lane-rail/lane-rail.css` | Light: set `--acp-rail-surface: var(--agent-surface-rail, …)` instead of `background`; drop the 1px `border-right`, which would cut through the tab |
| `src/acp/components/rail-entry/rail-entry.css` | Inset rounded rows; the active tab (`position: relative`, `::before` with the cut-out shadow, `::after` fillets); tints and the permission pulse limited to `:not(--active)`; light active rule keeps the ink colour only |
| `src/acp/components/lane-head/lane-head.css` | `.acp-harness--zen .acp-harness__lane--active > .acp-harness__lane-head { background: none }`, in the component layer and in the light-scheme layer |
| `src/acp/components/lane-stats/lane-stats.css` | The same zen rule for `.acp-harness__lane-stats` |
| `docs/0080-acp-harness-zen-mode.md`, `docs/0072-acp-harness-view.md`, `docs/0215-stacked-lane-hierarchy.md`, `DESIGN.md`, `docs/README.md` | Describe the merged tab and the zen exception to the head band; add the index row |

No TypeScript, DOM or Rust change. `LaneRail` / `RailEntry` keep their markup, deps and classes.

## Design

### Geometry

`R = --acp-rail-tab-r = min(var(--krypton-border-radius, 8px), 12px)` (the cap keeps the rounded corners inside a two-line row). Since rev 2 it is declared on `.acp-harness--zen .acp-harness__dashboard`, so the rail, its entries and the body all read it. `G = 8px` is the left gutter.

| Element | Box |
|---|---|
| `.acp-harness__rail` | Padding `0 0 8px` (rev 2; was `8px 0`). A first-row tab starts at the titlebar, and the bottom 8px holds a last-row tab's lower fillet. `border-bottom-right-radius: R` (rev 2) |
| `.acp-harness__rail-entry` | `margin: 0 R 0 G`, `padding: 6px 8px` (was `6px 12px`, so the text column loses only 8px), `border-radius: R` |
| `.acp-harness__rail-entry--active::before` | The tab: the row's box carried on to the rail's right edge (`inset: 0 calc(-1 * R) 0 0`), `border-radius: R 0 0 R`, `z-index: -1` |
| `.acp-harness__rail-entry--active::after` | The fillets: an R-wide column at the rail's right edge, R above and below the row (`inset: calc(-1 * R) calc(-1 * R) calc(-1 * R) auto; width: R`), `z-index: -1` |

```
 rail (S)                         │ body (C)
  ╭───────────────────────────╮   │
  │  Claude-1          2  41k │   │   inactive: rounded, inset G left / R right
  ╰───────────────────────────╯ ╭─┤   ← concave fillet (S → C)
  ╭───────────────────────────────┤
  │  OMP-1            97 163k     │   active: body colour, rounded left, flush right
  ╰───────────────────────────────┤
                                ╰─┤   ← concave fillet
```

### Tab paint

`S = var(--acp-rail-surface)`, `C = var(--acp-lane-canvas)`.

- `::before` has `background: C` and `box-shadow: 0 0 0 9999px S`. An outer shadow follows the border radius and is clipped inside the border box, so `S` covers the whole rail except the rounded tab, and the tab is `C`. Inside the rail, every pixel outside the fillets is therefore `S` over the dashboard or `C` over the dashboard, as the body is. The dashboard's dot grid lies under both.
- `::after` paints the two fillets: `radial-gradient(circle at 0 0, transparent calc(R - .5px), C R) top / 100% R` and the same at `0 100%` / `bottom`. Inside each quarter circle the shadow's `S` shows through; the corner outside it is `C`.

### Rail corners (rev 2)

The tab, the body and the composer are one sheet, and the rail colour `S` shows through a hole in it. Every sheet corner that faces the rail is round, with radius `R`:

| Corner | How |
|---|---|
| Tab, rail side | Rounded `::before` (unchanged) |
| Tab joining the body, above and below | `::after` fillets (unchanged). A first-row tab's upper fillet sits above the rail's box and is clipped, because the tab meets the titlebar there |
| Rail colour ending at the body and the composer | The rail's `border-bottom-right-radius: R`. The rail clips its overflow to that curve, so the tab layer's `S` shadow ends in a round corner. The zen dashboard's `::after` paints `C` in the sliver outside the curve. It uses the same gradient as a tab fillet (`radial-gradient(circle at 0 0, transparent calc(R - .5px), C R)`), and its box is `R × R` at the bottom-right of the rail's grid cell |
| Body facing the titlebar, when the tab is not the first row | `border-top-left-radius: R` on the active lane. The sliver outside it shows the dashboard, like the titlebar beside it. When the first row is the tab, the tab joins the body at that corner, so it stays square |

Both new rules are scoped to `.acp-harness--zen:not(.acp-harness--panels-hidden)`. The fillet also requires an active entry. With `#panels hide` the rail is `display: none` and the body fills the grid, so neither corner exists.

### Stacking invariants

- `.acp-harness__rail` is a stacking context (`isolation: isolate`) and clips the shadow (`overflow-y: auto`, unchanged).
- The active entry is `position: relative` with `z-index: auto`. It must **not** get `opacity`, `transform`, `filter` or an `animation` of those: any of them would make the entry a stacking context, move the `z-index: -1` layers inside it, and paint the rail colour over the tab. For this reason the permission pulse (`acp-harness-permission-pulse`, an opacity animation on the whole entry) applies only to `:not(.acp-harness__rail-entry--active)`. The status dot keeps its own pulse.
- Inactive entries keep `z-index: auto` and no positioning. Their tint (directive, pending, permission) and their text paint above the layer, and their right margin `R` keeps the tint clear of the fillet column.
- With no active entry (no lanes yet), `.acp-harness__rail:not(:has(> .acp-harness__rail-entry--active))` paints `S` itself.
- Rev 2: the zen dashboard is `position: relative`, so the bottom fillet's grid area is its containing block. The fillet sets all four grid lines (`grid-area: 1 / 1 / 2 / 2`), because an absolutely positioned grid item reads an `auto` line as the grid's padding edge. With `grid-area: 1 / 1` it lands at the bottom-right of the whole dashboard. The fillet is positioned with `z-index: auto` and is the dashboard's last box, so it paints over the rail and the body. It sits under the overlays, which come after the dashboard in the harness body. No absolutely positioned descendant of the dashboard used the harness body as its containing block: the active entry and the active lane are both `position: relative`.

### States

| Entry | Background | Text |
|---|---|---|
| Inactive | none | unchanged |
| Inactive directive / pending / `needs_permission` | today's tint, now rounded and inset; the permission pulse is unchanged | unchanged |
| Active (any status, any directive) | the merged tab; no tint of its own | today's active ink: `--acp-lane-ink` mix in dark, `--acp-lane-ink` in light |

`.acp-harness__rail-entry--directive.acp-harness__rail-entry--active` (purple 14%) and its light twin are deleted. The directive stays visible through the role tag chip.

### Zen body bands

`.acp-harness--zen .acp-harness__lane--active > .acp-harness__lane-head` and `… > .acp-harness__lane-stats` get `background: none`, in both layers. The body is then one `C` surface from top to bottom. The stacked dashboard (not Zen) keeps the spec 215 bands unchanged.

### Light scheme

`S` is `--agent-surface-rail` (cool grey @ 0.92) and `C` is white @ 0.78. The rail's `border-right` is removed: drawn on the rail's border box, it would cross the tab's flush edge. The two surfaces are still told apart by luminance, as spec 0010 requires.

### Keybindings

None change. Lane switching remains `Ctrl+N` / `Ctrl+P` / `1`–`9`; rail entries still have no click handler (spec 80).

## Edge Cases

- **Single lane / first row active (rev 2):** the tab starts at the titlebar. Its upper fillet sits above the rail's box and is clipped, and the body's top-left corner stays square because the tab joins it there.
- **Last row active:** the bottom fillet sits in the 8px bottom padding or the empty rail below it.
- **Rail scrolled (many lanes):** the layer scrolls with its row. The 9999px shadow still covers the visible rail when the active row is off screen. A tab scrolled into the rail's rounded bottom corner is clipped there, and the corner fillet shows a single body layer. The body's top-left rule checks whether the first entry is active, not what is in view. So a first-row tab scrolled out of view leaves that corner square; this needs more lanes than the rail can show.
- **Active lane `needs_permission`:** no gold tint and no row pulse on the tab. The dot still pulses gold, and the composer banner already owns the prompt.
- **`chrome.border.radius = 0`:** `R = 0`, so the corners and fillets collapse and the tab is a plain rectangle flush with the body. The rail's corner and the body's corner are square, and the corner fillet has no area. Still seamless.
- **Large radius themes:** `R` is capped at 12px so the left corners fit a two-line row. Above 8px, the outer part of a last row's lower fillet falls outside the rail's 8px bottom padding and is clipped. A first row's upper fillet is always clipped since rev 2.
- **`#panels hide`:** the rail is `display: none`, as today. The rev 2 corner rules are scoped off, so the body keeps square corners where the rail was.
- **Font zoom:** all sizes are em-relative except R and G. Nothing is measured.
- **Reduced motion:** nothing new animates.
- **Custom themes:** both colours come from the theme engine's tokens, so a theme changes rail and body together.

## Implementation Notes

Where the shipped code differs from the approved draft, and why:

- **The tab is a rounded box, not nine background tiles.** The draft painted the whole region (the tab, the bands above and below it, the gutter) with tiles inside one box spanning the rail width, plus a shadow outside that box. Rows sit at fractional pixel offsets (each row is ≈43.27px tall). A test render measured a 1px hairline along the box's top and bottom edges, where a rail-coloured tile met the rail-coloured shadow: up to 11 levels in light and 7 in dark. Both edges anti-aliased the same pixel row, so less than the full rail colour landed there. Now `::before` is just the rounded tab and its shadow paints the rest of the rail, so the rail colour is one primitive and has no internal edge. The same render measures 0–1 level at those rows. Row 250, which has no edge, measures 0–0.5.
- **The cost is inside the fillets.** `::after` paints the body colour over the shadow's rail colour in each concave corner sliver (≈14px² at R = 8). There the colour is off by the 2–3.6% the Research section describes. This is confined to the curve itself and never reaches the tab or the body.
- **Rev 2: a flush tab, not a taller strip.** With the 8px top padding, the strip above a first-row tab held only the tab's upper fillet. Rounding the strip's other corner as well would leave a lens shape inside 8px, and a taller strip would move every row down. With no top padding, the first row sits flush under the titlebar, active or not. An inactive first row's text is then 6px (its own padding) below the titlebar.
- **Rev 2: the corner fillet sets all four grid lines.** The first render placed the fillet with `grid-area: 1 / 1`. It landed on the body's bottom-right corner, because an absolutely positioned grid item reads an `auto` end line as the grid's padding edge. `grid-area: 1 / 1 / 2 / 2` keeps it in the rail's cell.
- **Rev 2: the corner fillet has no seam.** Unlike a tab fillet, it does not paint over the rail colour: the rail is clipped in that sliver, so the fillet is `C` over the dashboard, as the body is.

**Verified:**

- A Chromium render of the real `LaneRail` / `RailEntry` with the harness stylesheets, in dark and light, over a gradient "wallpaper" under each scheme's window backdrop (`rgba(6, 10, 18, 0.5)` / `rgba(230, 239, 246, 0.94)`). It covered two cases: the first row active, and a middle row active between a `needs_permission` neighbour and a directive-tinted neighbour.
  - The pixel 4px left of the rail edge (inside the tab) equals the pixel 4px right of it (the body), within 1 level of the wallpaper gradient.
  - The rail measured `rgba(0, 0, 0, 0)` with an active entry and the `S` colour without one.
  - Zen head and stats bands computed to `rgba(0, 0, 0, 0)`, and a non-Zen head band kept its tint.
  - The rail's `scrollHeight` was unchanged by the shadow.
- The full `vitest` suite passes, including `styles-ownership.test.ts` and `theme.test.ts`.
- **Rev 2:** a throwaway Chromium render of the Zen window with the real stylesheets. It used the user's theme tokens (legacy-radiance: window backdrop `rgba(8, 8, 8, 0.7)`, `S` = accent green @ 0.08, `C` = `rgba(8, 8, 8, 0.55)`, lane accent `#ff8552`) and a light-scheme set.
  - Computed styles: rail padding `0px 0px 8px` and bottom-right radius `8px`. The fillet box is 8 × 8px at the bottom-right of the rail's cell (its left edge is the rail's right edge minus 8px).
  - Pixels over a flat wallpaper: the outer pixel of the corner sliver equals the body pixel beside it, in dark (`18, 16, 17`) and in light (`250, 249, 250`). The top-right pixel of a first-row tab equals the body pixel beside it, in dark (`23, 22, 26`) and in light (`248, 250, 252`). The body's own bottom-right corner shows no darker square.
  - The active lane's `border-top-left-radius` was `0px` with the first row active and `8px` with the second row active. With `#panels hide`, the dashboard's `::after` had `content: none` and the lane's radius was `0px`.
  - The full `vitest` suite passes (231 files, 2935 tests), including `theme.test.ts`, `styles-ownership.test.ts` and `harness-composer-meta.test.ts`.
- **Not exercised:** WKWebView itself, and the in-app path. The installed app needs `make install` to pick up the new stylesheets.

## Open Questions

None.

## Out of Scope

- An animated (sliding) tab.
- The stacked (non-Zen) dashboard's collapsed bands and head band.
- The window footer lane strip (`krypton-window__lane`).
- Rail width, rail entry content, hover styles, click handling.

## Resources

- [CSS Backgrounds and Borders Module Level 3 — box-shadow](https://www.w3.org/TR/css-backgrounds-3/) — an outer shadow is clipped inside the element's border box; the basis of the cut-out.
- [CSS 2.1 Appendix E — Elaborate description of stacking contexts](https://www.w3.org/TR/CSS21/zindex.html) — negative `z-index` children paint before in-flow backgrounds and text.
- [Inverted border-radius using CSS mask (css-tip.com)](https://css-tip.com/inverted-radius) — the mask technique, rejected because it must track the active row.
- [VS Code Dark Modern theme](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json) and [Theme Color reference](https://code.visualstudio.com/api/references/theme-color) — the active tab shares the editor surface.
- `docs/0080-acp-harness-zen-mode.md`, `docs/0125-lane-rail-disambiguation.md`, `docs/0215-stacked-lane-hierarchy.md`, `docs/0321-light-scheme-legibility.md`, `docs/0010-theme-specification.md` — Krypton precedents and constraints.
