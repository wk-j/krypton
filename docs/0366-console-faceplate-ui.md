# Console Faceplate UI — Implementation Spec

> Status: Implemented
> Date: 2026-11-07
> Milestone: Visual identity — the whole app adopts the Krypton Console faceplate (extends `DESIGN.console.md` 1.0.0)

## Problem

Only the ACP harness right dock (`.acp-harness__dock`) is drawn as a skeuomorphic instrument
faceplate. Everything else — window chrome, overlays, the harness transcript, composer and pickers,
content views, the Agent and Vault views — is Krypton Dark neon (`DESIGN.md` 1.2.8) or a sibling
aesthetic. The user wants the whole app in the faceplate style, but the material tokens live only on
the dock and `DESIGN.console.md` forbids declaring them anywhere else.

## Solution

Make the faceplate Krypton's base identity in one clean cutover. Lift the dock's material tokens to
the document root as `--mat-*` in a new `src/styles/materials.css` (graphite for dark, aluminium for
light, keyed on `data-theme-scheme`). Restyle every surface in the Tauri webview from the same five
parts: plate, engraving, well, key, lamp. Content (terminal grid, prose, code, diffs, canvases) stays
flat inside wells. Neon glows, scanlines, vignettes and ambient loops go; colour still means state
only. `DESIGN.md` becomes Krypton Console 2.0.0 and absorbs `DESIGN.console.md`, `DESIGN.amber.md`
and `DESIGN.nasa.md`, which are deleted. An opt-in `chrome.style = "console"` switch that keeps both
looks was rejected: two full aesthetics across 147 stylesheets doubles the cost of every UI change.

## Research

- **Size.** 147 CSS files, 30,767 lines under `src/`: 35 global sheets in `src/styles/`, 76 harness
  component sheets in 71 directories, plus `native-output.css` and `live-assist.css`.
- **Theme pipeline.** Rust `FullTheme` → `themeCssProperties()` → inline style on `<html>`
  (`theme.ts:361-576, 682-697`). `data-theme-scheme` is `light` when the chrome backdrop luminance is
  ≥ 0.45 (`theme.ts:323`). `data-chrome` is set from `chrome.style` but no CSS reads it.
- **Theme tokens.** Spec 303 `[tokens]` are applied inline on `<html>`, after the built-ins, but the
  value allowlist has no gradient functions (`theme.rs:506-521`). Gradient-valued materials can still
  be themed if CSS composes them from colour-stop tokens, which the allowlist accepts.
- **Cascade.** Only `base.css`, `harness-shared.css`, `connected-computers.css` and
  `native-output.css` are layered; every other `index.css` sheet is unlayered and beats any layered
  rule (`layers.css:1-4`). `theme-scheme.css` is unlayered and last (`index.css:32`).
- **Shared palette.** `--agent-*` is declared at `:root` in `agent.css:15-45` and emitted inline by
  `theme.ts:515+`; 33 stylesheets outside the Agent view read it, including the harness shell.
- **Translucency.** `[visual] opacity` (default 0.5) rewrites the alpha of
  `--krypton-backdrop-color` (`compositor.ts:801-811`); light themes floor it at 0.94
  (`theme.ts:332`). xterm uses the DOM renderer with a transparent background (`compositor.ts:313`,
  `terminal.css:66-90`).
- **Motion.** About 40 `infinite` animations outside the dock: window and tab status-dot pulses
  (`window.css:64, 908`), selection scan (`terminal.css:21, 58`), gauge orbit and titlebar sweep
  (`progress.css:118, 176`), hook sigil and uplink (`hooks.css:26, 82`), inline AI, music, usage
  shimmer, Agent, hurl, webview, and 19 in the harness. The zen rail-dot `--error` pulse runs on a
  state that is not live (`rail-entry.css:305`). At least twelve have no reduced-motion guard.
- **Cost.** Every diff line in a tool row carries a `text-shadow` (`tool-row.css:416-437`), every
  Agent message label a two-layer glow (`agent.css:360-362`), and every window a 20px blurred shadow
  while WAAPI transforms it (`window.css:20`, `animation.ts:155-170`). Large blurred shadows are a
  known paint cost in WebKit ([bug 22102](https://bugs.webkit.org/show_bug.cgi?id=22102)).
- **Light contrast.** The dock's light silk `#8a5a00` on its 0.92 aluminium plate is 3.6:1 over a
  black wallpaper, under 4.5:1 for 11px labels. `#6e4700` on a 0.94 plate (spec 321's floor) is
  5.2:1 over black and 6.1:1 over white (computed with WCAG relative luminance).
- **Debris the cutover removes.** Left-edge selection rails in hurl and vault break ADR-0027
  (`hurl-view.css:106, 124, 375, 383`, `vault-view.css:283, 320, 850, 858`). The Agent and Vault
  window-chrome overrides keyed on `.krypton-window[data-content-type]` never match, because both
  views open through `createContentTab` and only `createContentWindow` sets the attribute
  (`compositor.ts:3251` vs `:4060, :5028`).
- **Not in the webview.** The loopback app is a separate React document opened in the OS browser
  (`loopback-open.ts:21`, `vite.loopback.config.ts`). Its GenUI preview does import the in-app
  catalog CSS and re-declares `--krypton-*` (`src/loopback/surfaces/genui/genui.css:32-39`).
- **Alternatives ruled out.** (1) `html[data-chrome='console']` opt-in: two aesthetics forever.
  (2) Per-surface copies of `--dock-*`: forty light-scheme duplicates. (3) Materials generated in
  `theme.ts` as JS strings: hides the material from CSS review, and colour-stop tokens already give
  themes the same reach.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| cool-retro-term | Emulates a CRT on the *screen* with QML shaders: curvature, bloom, burn-in, optional frame | Hardware look on the content; Krypton puts it on the chrome and keeps the grid flat |
| Arturia V Collection | Photoreal synth panels: wood, knobs, VU meters | Raster textures; Krypton uses CSS gradients and shadows only |
| Halide | Etched type and dial controls modelled on camera bodies | Closest to engraved labels on keys you press |
| Apple Liquid Glass (iOS 26, macOS Tahoe) | Depth from refraction and blur | Needs backdrop blur, which freezes Krypton's transparent WKWebView |
| iTerm2, WezTerm, Warp | Flat chrome | The convention Krypton departs from |

**Krypton delta.** No terminal ships skeuomorphic chrome; cool-retro-term skins the screen instead.
Krypton keeps data-dense content flat, because that is where texture costs the most legibility
(NN/g, Superdesign), keeps every key reachable by shortcut (the keys are visual, not new mouse
targets), and uses no images.

## Affected Files

| Slice | Files | Change |
|---|---|---|
| S0 Foundation | `src/styles/materials.css` (new), `src/styles/index.css`, `src/live-assist-main.ts`, `src/loopback/surfaces/genui/genui.css` | Root `--mat-*` set, dark + light; imported first after `base.css`, by live-assist and by the GenUI preview |
| S0 | `src/styles/harness-shared.css`, `src/acp/components/{ticket-dock,rails-dock,assistant-instances,dock-action}/*.css` | Delete the dock-local `--dock-*` blocks; rename `--dock-*` → `--mat-*` |
| S1 Window | `window.css`, `terminal.css`, `theme-scheme.css`, `workspace-footer.css`, `progress.css`, `hooks.css`, `extensions.css`, `native-output.css`; inline toast in `compositor.ts:8993-9015` | Bezel, screen well, selector-key tabs, footer plates, lamps |
| S2 Overlays | `overlays.css`, `search-palette.css`, `quick-overview.css`, `dashboard.css`, `wheel.css`, `inline-ai.css`, `profiler.css`, `music.css`, `keyboard-overlay.ts` + `wheel-rail.ts` canvas colours, dashboard opacity writes in `compositor.ts:818-822` | Floating plate panels, input wells, list wells, key caps |
| S3 Harness shell | `harness-shared.css` (outside the dock), transcript, tool, composer, lane-head, rail-entry and lane-rail-card component sheets | Lane screen well, head plate, composer plate, engraved labels, lamps |
| S4 Harness overlays | Picker, dialog, review, triage, orchestrator, metrics, genui and other overlay component sheets | Same panel recipe as S2 |
| S5 Content views | `markdown-view.css`, `diff-view.css`, `file-manager.css`, `hurl-view.css`, `pencil-view.css`, `webview-view.css`, `usage-view.css`, `review-board.css`, `connected-computers.css`, `telegram-settings.css` | Chrome to parts; documents stay flat |
| S6 Sibling looks | `agent.css`, `vault-view.css`, `live-assist.css` | Drop amber phosphor and NASA palettes, scanlines, vignettes, glows; same parts |
| Tests | `window-title-label`, `window-footer-*`, `theme`, `harness-composer-meta`, `hash-commands`, `harness-tool-render`, `acp-harness-view`, `genui-catalog/data`, `styles-ownership` tests | Re-point CSS assertions that encode a removed look; keep behaviour assertions |
| Theme | `src-tauri/src/theme.rs`, `src-tauri/themes/{krypton-dark,krypton-light,legacy-radiance}.toml`, `src/theme.ts`, `src/loopback/surfaces/genui/genui.css:102` | Remove the shadow fields this cutover leaves without a consumer (below); built-in descriptions stop saying "cyberpunk" |
| Docs | `DESIGN.md` (2.0.0), `DESIGN.console.md` / `DESIGN.amber.md` / `DESIGN.nasa.md` (deleted), `DESIGN.binance.md` (sibling table), `CLAUDE.md`, `docs/adr/0030-console-faceplate-is-the-base-identity.md` (new), `docs/0004-architecture.md`, `docs/0006-configuration.md`, `docs/0010-theme-specification.md`, `docs/README.md`, the specs listed under Edge Cases | New identity, retired siblings, removed theme fields, superseded styling notes |

## Design

### Materials

`src/styles/materials.css` holds `@layer krypton.base { :root { … } }` and
`@layer krypton.scheme { html[data-theme-scheme='light'] { … } }`. Every `--dock-*` name becomes
`--mat-*` with the same role (DESIGN.console.md table). Gradient tokens are composed from
colour-stop tokens, so a theme's `[tokens]` can recolour any material through the existing allowlist:

```css
:root {
  --mat-plate-hi: rgba(46, 49, 56, 0.9);  --mat-plate-mid: rgba(32, 34, 40, 0.9);
  --mat-plate-lo: rgba(23, 25, 30, 0.9);
  --mat-plate: linear-gradient(180deg, rgba(255,255,255,0.035), transparent 160px),
               linear-gradient(180deg, var(--mat-plate-hi), var(--mat-plate-mid) 50%, var(--mat-plate-lo));
  /* same pattern: --mat-key-hi/mid/lo → --mat-key, --mat-key-hover, --mat-key-down;
     --mat-well-hi/lo → --mat-well; --mat-lens-on-hi/mid/lo → --mat-lens-on */
  --mat-scrim: rgba(4, 5, 8, 0.55);          /* new: dimmer behind a modal plate */
  --mat-cast: 0 10px 28px rgba(0, 0, 0, 0.45); /* new: one shadow under a floating plate */
  --mat-screen: var(--krypton-backdrop-color); /* new: the terminal / lane screen fill */
}
```

Inline `[tokens]` on `<html>` beat these `:root` values, and the composed tokens re-resolve on the
same element. The light set is the dock's aluminium set with the plate stops at 0.94 alpha and
`--mat-silk` / `--mat-lit` at `#6e4700` (contrast above). Component sheets never declare `--mat-*`.

### Parts on every surface

| Part | Recipe | Used for |
|---|---|---|
| Plate | `--mat-brush` + `--mat-plate`, 1px `--mat-key-edge`, inner `--mat-bevel-hi` | Titlebar, tab bar, footers, panel heads, sidebars, overlay panels, composer |
| Engraving | `--mat-silk` or ink + `--mat-engrave` text-shadow, uppercase chrome size | Titles, section and column headings, key legends on the plate |
| Well | `--mat-well` / `--mat-well-fill` + `--mat-well-shadow` | Terminal and lane screens, inputs, lists, readouts, code blocks in chrome |
| Key | `--mat-key` + `--mat-key-raise`; `:active` / latched `--mat-key-down` + `--mat-key-sunk` | Buttons, view toggles, which-key and hint caps, tabs (selector keys) |
| Lamp | Lit capsule or LED (`--mat-lens-*`), colour from state tokens | Status dots, verdicts, mode / attention chips, live indicators |

- **Terminal window.** The titlebar, tab bar and footer are plate strips. The body is the screen
  well: `--mat-screen` fill plus the well's inset shadow, drawn inside the existing box, so titlebar
  28px, tab 28px, radius 8px and the terminal cell grid do not change. The window keeps one
  `--mat-cast` shadow; the 20px accent glow goes. Focused: titlebar LED lit in the window accent,
  label lit `--mat-lit` with no glow (the label clips, so a bloom reads as a box), a 1px accent
  outline at 0.55 alpha (no glow). Unfocused: LED unlit, label engraved ink.
- **Window accent** (`--krypton-window-accent`, lane accents, manual pick, signal states) colours the
  window's LEDs (titlebar, its tabs) and the focus outline only. Labels stay silk. Footer lane marks
  carry no LED.
- **Overlays and dialogs** (palette, which-key, hints, prompt dialog, quick overview, dashboards,
  inline AI, toasts, harness pickers and dialogs): one floating plate with `--mat-cast` over
  `--mat-scrim`; engraved head; input well; result list as one well with grooves and a full-row
  `--mat-select` tint; actions are keys; the key-hint foot is printed legend.
- **Quick Terminal**: a plate drawer around a screen well.
- **Harness.** Lane body = screen well (the window's screen fill shows through; a lane adds the
  well's inset shadow, not a second fill); lane head = plate strip with the name engraved and status as
  a lamp; zen rail = plate column of selector keys with LEDs; composer = plate with the draft line in
  a well; transcript rows are flat text in the lane well with engraved labels; every transcript
  label (tool kind, permission and question decision, execution state) is flat ink with its status LED
  before the legend; tool rows add an output well; permission and question options are keys; floating lane cards
  (peek, queue, plan, thought, grammar, heat) are small plates. The right dock column and the shown
  lane's head strip are one plate as well: the column holds its top stop for the strip's height, and
  the screen draws its own right edge.
- **Content views.** Toolbars, status bars, breadcrumbs and sidebars become plates, readouts and
  wells; markdown prose, diff2html tables, file previews, hurl source/response, the Excalidraw canvas,
  the native webview and the review-board document stay flat.
- **Agent, Vault, live-assist, Telegram.** Same parts. The amber phosphor and NASA palettes,
  scanlines and vignettes go. `--agent-*` keeps its names (33 consumers, emitted by `theme.ts`); only
  the amber-only tokens and rules in `agent.css` are rewritten. The dead
  `.krypton-window[data-content-type=agent|vault]` chrome overrides are deleted.

### Colour and state

- Labels and lit legends are `--mat-silk` / `--mat-lit` (amber hardware ink) everywhere.
- The theme accent keeps its jobs: cursor, links, window LEDs, focus outline.
- Lamps take `--krypton-success/danger/warning-rgb`; actions are cyan running, green done.
- ADR-0004, 0017 and 0027 are unchanged. Hard-coded literals found by the research (cyan
  `rgba(0,200,255,…)`, `#c77dff`, `#f4bf75`, `#0a0e18`, unemitted `--krypton-foreground` /
  `--krypton-background` / `--krypton-cyan` fallbacks) move to tokens.

### Motion

- **Removed:** every decorative or ambient loop — scanline and titlebar sweeps, orbits, shimmers,
  data streams, glow and status pulses, vignettes, `msg-boot`.
- **Live state is a steady lit lamp**, as in the dock. The only blinking things are text carets,
  the xterm cursor and the selection-mode cursor (`terminal.css:21`), which stop under
  `prefers-reduced-motion`. A JS spinner glyph and ticking counters stay: they change content, not
  light.
- **Kept:** WAAPI layout transitions (transform / opacity), the 1px press, one-shot event flashes up
  to 600ms redrawn as a lamp flash, the 220ms row enter.
- **Config effects keep their behaviour:** `[shader]`, cursor trail, `[fire]`, the `[music]` circuit
  trace (only while music plays), and the default-on 2° perspective tilt (`[visual]
  perspective_tilt_x`, `config.rs:342-352`). The header oscilloscope, on by default on every window
  (spec 188, `compositor.ts:2705`), stays and is redrawn as a display well.
- **Decorative textures go:** the help-overlay scanlines
  (`src/acp/components/help-overlay/help-overlay.css:19`) and the harness dashboard dot grid
  (`harness-shared.css:394-396, 1639-1641`).

### Performance budget

- Brush texture and stacked bevels only on plate strips and panels, never on the screen well or a
  repeated row.
- A repeated row (transcript row, diff line, tool output line, file row, palette result) gets no
  box-shadow, text-shadow or gradient: at most one `border-bottom` groove and the selection tint.
- One `--mat-cast` per floating plate; no outer glows.
- Budget (CLAUDE.md constraint 8) checked in the running app with the profiler HUD (spec 47):
  keypress-to-render < 16ms with 6 terminal windows and a harness with a 200-row transcript; window
  morph and workspace slide at 60 FPS in the Web Inspector timeline.

### Configuration

No new keys. `[visual] opacity` sets the terminal and Quick Terminal screens only
(`compositor.ts:811, 816`); plates hold their own alpha (0.9 dark, 0.94 light). The dashboard
becomes a floating plate over `--mat-scrim` like every overlay, so its two opacity writes
(`compositor.ts:819-822`) are removed. `docs/0006-configuration.md` says so.

### Theme schema

The look reads the theme's colours, `border.radius`, titlebar and tab heights, status-dot size,
`header_accent` and the `ui.*` panel colours as today. These fields lose their last consumer when the
glows go, so they are removed from `theme.rs`, the `FullTheme` interface and `themeCssProperties()`
in `theme.ts`, the three built-in TOMLs and `docs/0010`: the whole `[chrome.shadow]` table (`blur`
fed only the window and dashboard glows, `window.css:20`, `dashboard.css:38`; its other fields were
never read), `focused.shadow_color` / `focused.shadow_blur` (`window.css:38, 56`), and
`ui.quick_terminal.shadow_color` / `shadow_blur` (`overlays.css:233, 243, 253`). No theme struct
uses `deny_unknown_fields`, so a user theme that still sets them loads and serde ignores the keys.

### Keybindings

None. Pure restyle: no behaviour or shortcut changes. DOM changes are limited to a class or an empty
LED element where a part cannot be drawn with a pseudo-element.

## Edge Cases

- **Low `[visual] opacity`.** The screen gets more transparent; plates do not, so chrome stays legible
  over any wallpaper.
- **Light themes.** Aluminium set; plates floor at 0.94 like the light backdrop (spec 321).
- **Windows under 320 × 120.** Titlebar-only plate, as today.
- **Accent overrides with `!important`** (`window.css:123-147`) keep working: they feed the LED and
  outline tokens.
- **Custom themes.** A theme that sets no `[tokens]` gets graphite or aluminium by its scheme;
  `[tokens]` may recolour any `--mat-*` stop or shadow.
- **GenUI preview in the browser.** Imports `materials.css`, so the catalog renders the same parts.
- **Reduced motion.** With ambient loops gone, caret blinks stop and the remaining one-shots follow
  the existing policy (entrance only, capped at 120ms).
- **Stale specs.** Each of these candidates is read, and gets a one-line "Styling superseded by spec
  0366 / DESIGN.md 2.0.0" note under its header where its text describes a removed look: 10, 29, 38,
  39, 41, 42, 47, 52, 59, 60, 65, 71, 102, 104, 107, 111, 121, 125, 137, 142, 151, 188, 189, 215, 218,
  226, 232, 235, 236, 252, 290, 301, 303, 304, 317, 321, 350, 354.

## Delivery and Verification

S0 lands first; S1–S6 then run in parallel, each slice owning its files. Done means: `npm run check`,
`npm test`, `cargo test` and `cargo clippy` pass; every surface in the Affected Files table is
checked in the running app (`npx tauri dev`) under `krypton-dark` and `krypton-light`, with
screenshots; the performance budget above is measured; `DESIGN.md`'s forbidden list is grep-clean
(`infinite` only on carets, no glow `text-shadow` / `box-shadow` outside lamps, no `--dock-*`).

## Open Questions

None.

## Implementation Notes

Deviations found while implementing, each with its reason:

- **More theme fields lost their last consumer than the Theme schema section listed.** The overlay
  and chrome restyle stopped reading the panel colours (a palette is a plate, labels are silk), so
  `[ui.command_palette]`, `[ui.which_key]`, `[ui.hints]`, `chrome.titlebar.background` /
  `text_color`, `chrome.status_dot.color` and `focused.border_color` were removed by the same rule,
  with the CSS variables only they fed (`--krypton-palette-*`, `--krypton-whichkey-*`,
  `--krypton-hint-*`, `--krypton-titlebar-bg/-text`, `--krypton-fg-dim`, `--krypton-bg-elev`,
  `--krypton-focused-border`, `--krypton-status-dot-color`, the `--krypton-opacity-*` scale). The
  `--vault-*` palette and the `--agent-*` names nothing reads any more (`--agent-bg`, `-panel`,
  `-surface-low/mid/high/rail`, `-border(-active)`, `-primary(-rgb)`, `-ghost`, `-text-rgb`,
  `-text-dim`, `-blue-rgb`) went from `theme.ts` and the `agent.css` fallbacks. The audit compared
  `var()` readers against `HEAD`; variables that were already unread before this change stay (Out of
  Scope). `[chrome.tabs] height` stays live: it caps the tab channel at
  `min(tab, titlebar) - 4px`.
- **The transcript GenUI card is a small plate, not a well.** Its inputs, gauges and readouts vanished
  into a dark well.
- **Provider errors keep per-kind lamp colours** (auth / quota fault, context info, others warning),
  as before, rather than all-fault.
- **The built-in titlebar and tab rows are 36px, not 28px.** At 28px the selector keys were 18px
  tall around a 13px legend (`[font] size = 16`), and the bar read as thin against the terminal
  text. The three built-in themes and the `theme.rs` defaults now set `[chrome.titlebar] height`
  and `[chrome.tabs] height` to 36: a 32px channel of 26px selector keys, the titlebar view toggles
  at the 24px dense key size (they shrink to keep 4px of plate on a rail under 32px), and the
  focused session mark at 28px. A custom theme keeps whatever height it sets. The footer stays
  28px.
- **Model findings in the review board and review matrix are amber / ink only** (ADR-0004), so
  blocking and non-blocking differ by word and brightness, not red / yellow.
- **The file browser and the markdown reader are one faceplate.** Drawn as plate strips around a
  flush list well and a bare screen, they read as the old flat look with amber labels. The whole
  view is now the plate (`--mat-plate`), the path and status are readout wells (`::before`, so the
  components still write plain `textContent`), and the list (`--mat-well`) and the preview
  (`--mat-screen`) are wells inset 8px. The File Manager's visible row count is measured from the
  list well's own height (`view.ts` `onResize`), not the pane height less the strips.
- **Plated foot.** A plate strip ending above the window footer showed a seam, a bevel and the
  footer's top-lit gradient starting over: the harness prompt and the status rail read as two
  parts. A view whose bottom edge is a plate sets `ContentView.platedFoot` (harness, File Manager,
  markdown reader); while it is the only pane of the shown tab the compositor puts
  `krypton-window--plated-foot` on the window (`syncWindowPlatedFoot`), and the footer drops its
  seam and bevel and fills with flat `--mat-plate-lo`. The command centre is shorter than the
  plate's 160px sheen, so under a plated foot it spreads the sheen over its own height and ends
  exactly on `--mat-plate-lo`.
- **Zen frame.** In Zen the rail column, the shown lane's head strip and the command centre read
  as three parts: the rail drew a seam down its whole right edge (beside the head strip too), the
  command centre's seam and lit lip ran under the rail, and the head strip shaded down to the bottom
  colour stop beside a rail still at the top one. With the rail shown they are now one plate around
  the lane's screen. The rail takes no right border; the screen draws its own left edge
  (`.acp-harness__lane-body`), the stats row's seam its top edge, and the command centre's
  `::before` its bottom edge from the rail's width (`--acp-zen-rail-width`) on. The head strip holds
  the top colour stop and the sheen, the rail holds that stop for the strip's 56px and then runs to
  the bottom stop, and the command centre holds the bottom stop (through
  `--acp-command-center-plate`, so the spec-365 fire rule still clears it), which a plated foot
  carries on.
- **Row labels sit on the body's first baseline.** The engraved row label is 0.64em on its own
  line box, so with the row grid aligned to the top it rode about a third of an em above the
  body's first line (5–6px at a 16px font; a user screenshot of `PERM` / `TOOL` rows). The label
  now opens with an invisible strut at the body's size and line height (`::before`, `'\200b' /
  ''`), so its first line box is a body text line; tool, permission and question rows, whose head
  line is taller than a text line, align label and body on the head's baseline. Grid baseline
  alignment is not used for every row: an assistant body has layout containment (no baseline to
  align to), and a body can open with a scroll container. The thought label is a plain block so
  the strut stays on its first line, with the effort meter 3px below.

## Out of Scope

- Loopback browser pages (`DESIGN.binance.md`), apart from the GenUI preview import; the Raycast
  extension.
- Terminal content: ANSI palette, fonts, cursor style; Excalidraw and native webview internals.
- Behaviour of the config effects (shaders, cursor trail, fire, music circuit trace, perspective).
- New theme keys or a per-theme choice of look.
- Theme fields that were already unread before this change (`corner_accents`, `tabs` colours,
  `[ui.search]`, `[ui.mode_indicator]`, `backdrop.blur` and the `ui.*.backdrop_blur` fields,
  `chrome.style`) and
  `[visual] glow_intensity`, which paints nothing today (`window.css:1018-1020`).

## Resources

- [Skeuomorphism — NN/g](https://www.nngroup.com/articles/skeuomorphism/) — texture as clutter in
  dense interfaces; why the content stays flat.
- [Skeuomorphism CSS recipe — Superdesign](https://superdesign.dev/styles/skeuomorphism) — one top
  light source, contact + ambient + bevel shadow stack, letterpress labels, real 1px borders,
  contrast traps, a separate token set per scheme.
- [cool-retro-term](https://github.com/Swordfish90/cool-retro-term) — the one skeuomorphic terminal;
  skins the screen rather than the chrome.
- [WebKit bug 22102](https://bugs.webkit.org/show_bug.cgi?id=22102) — large box-shadows slow
  scroll and redraw; basis for the per-row budget.
- `DESIGN.console.md` 1.0.0 and `harness-shared.css:113-142, 1647-1675` — the reference material set.
