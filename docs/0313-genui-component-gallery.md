# GenUI Component Gallery (Loopback Page) — Implementation Spec

> Status: Implemented (2026-10-19)
> Date: 2026-10-19
> Milestone: ACP Harness
> Builds on: [spec 309](./0309-harness-genui-catalog.md), [spec 310](./0310-harness-genui-inline-panel.md), and the loopback gallery pattern in [spec 170](./0170-artifact-gallery-endpoint.md)

## Revision 4 — Capped Shell Width, and the App's Own Reset Under the Preview

> Status: Implemented
> Date: 2026-10-19

### Problem

`.gallery` was `display: flex` across the whole viewport. The rail stayed 240px and the view stayed 820px, so on a wide display every extra pixel went into dead space *between* them: at 2560px the rail sat at the far left and the component floated 720px away, near the middle of the screen.

Separately, the preview was not laying components out the way the window does. The page links the catalog's own sheets but never `src/styles/base.css`, whose `krypton.reset` layer gives the app `box-sizing: border-box` and zeroed element margins — so markup authored against border-box measured as content-box here. Four of the 40 components spilled past their own block: `List` by 17px (`.acp-genui__list-row`, full width plus `padding: 5px 9px`), and `Input`, `TextArea` and `Form` by 20px.

### Design

`.gallery` takes `width: 100%; max-width: 1180px; margin-inline: auto` — rail and view are capped and centred as one shell, the same move `.layout` makes in the docs browser (`src/acp/artifact-docs.html`). 1180px is 240px of rail plus the 880px view column with a small gutter, so the cap never narrows either pane; below it the page is unchanged, and the `max-width: 760px` stacked breakpoint is untouched.

`gallery.css` now opens with `@import '../../styles/layers.css'` — the same order statement `src/ui/component.ts` declares, so the catalog's `krypton.component` and `krypton.scheme` sheets rank here exactly as they do in the app — and carries the reset in `krypton.reset`, scoped to the preview: `.gallery__preview, .gallery__preview *, .gallery__preview *::before, .gallery__preview *::after { margin: 0; padding: 0; box-sizing: border-box }`. The scope matters in both directions. Inside it, the component sees the app's floor; outside it the Binance shell keeps the content-box metrics it was built against. The reset layer is the lowest, so a component rule still wins — `.acp-genui__list-row` keeps its `5px 9px`.

### Verification (2026-10-19)

Chromium against the dev page at four viewports, measured with `getBoundingClientRect()`: at 2560px `.gallery` is `x 690 · w 1180` (was `x 0 · w 2560`) with the stage still 820px; at 1512px `x 166 · w 1180`; at 1100px the shell fills the viewport (`x 0 · w 1100`) exactly as before; at 700px the rail stacks above the view. `document.documentElement.scrollWidth` equalled `innerWidth` at every width, and `#Table` and `#Diagram` rendered with no console errors.

Overflow was swept over all 40 components (open each fragment, compare every laid-out descendant's `right` against the preview's): **0** overflow with the reset, **4** with the rule deleted at runtime (List 17px, Input/TextArea/Form 20px). `.acp-genui__list-row` reports `box-sizing: border-box`, `padding: 5px 9px`, and a right edge of 1269 inside its block's 1270 — before, it was 1287 against a 1270 block. Console clean.

## Revision 3 — The Preview Is the App's Own Surface

> Status: Implemented
> Date: 2026-10-19

### Problem

The original design painted the catalog with the loopback page's own dark palette and `ui-monospace`, on the argument that a browser page should show structure and behavior rather than the user's theme. That makes the gallery useless for the thing it is for: a component drawn in Binance yellow at 13px is not the component the user sees in Krypton, which is their theme's accent, their `[font] family` at their size, on the window backdrop. The page also invented tokens the app never sets (`--krypton-error`, `--krypton-danger`, `--krypton-font-mono`), so some components were drawn from values that exist nowhere else.

### Design

`GET /genui-gallery/theme.json` returns the app's live `{ theme, font }` — `ThemeEngine::resolve_for_config` (the same call `get_theme` makes) plus `[font]` from the running config. The page applies it exactly as the window does: every property of `themeCssProperties()` (which already merges a theme's `[tokens]`) on `:root`, then the `--krypton-font-*` / line-height properties `Compositor.applyConfig` sets, then `data-theme-scheme`, `data-theme` and `data-chrome`. It is applied **before** the first component mounts, because the mermaid `Diagram` renderer reads resolved tokens at render time, and re-applied on window `focus`, so a palette switch or Reload Config in Krypton lands when the user comes back to the tab.

The preview is seated like a seated panel: `.gallery__stage` reproduces `.krypton-window` (border at `--krypton-window-accent-rgb` 0.5, `--krypton-border-radius`, backdrop, glow) over an opaque base that stands in for the desktop no browser page can see, and the host block carries `acp-genui-panel__body` (the real sheet, imported) plus the typography and `--agent-*` aliases `.acp-harness` puts around a panel. The rail reads out which theme and font are on screen.

The gallery CSS keeps a fallback `:root` block with the built-in **krypton-dark** values for the one case that cannot reach the route — a debug build's Vite page, which is a different origin — and no longer declares names the app does not set, so the catalog's own literal fallbacks stand exactly as they do in-app. The page CSP gains `connect-src 'self'` for the same-origin fetch; everything else stays `'none'`.

The shell around the stage (rail, search, parameter table, pager) stays `DESIGN.binance.md` fixed dark: it is loopback chrome, and a themed chrome would make the component harder, not easier, to read against.

`loadSvgFontFaces()` now returns empty without asking the backend when there is no Tauri host. The embed exists only because WebKit blocks user-installed fonts inside an `<img>` SVG; a browser page resolves the stack itself, and with a real `[font] family` the gallery would otherwise log a failed `svg_font_faces` invoke on every Diagram.

### Verification (2026-10-19)

`npx tsc --noEmit`, `npm run build`, Vitest (197 files, 2,567 tests), 113 `hook_server` Rust tests, `cargo fmt -- --check` and `cargo clippy --all-targets -- -D warnings` passed. The payload the new route returns was produced through the same `resolve_for_config` call and served next to the built bundle: the page reported `Legacy Radiance · Share Tech Mono 16px`, `--krypton-window-accent #00C840`, `--krypton-fg #C8E0D0`, and a preview computed style of `"Share Tech Mono", … 16px` in `rgb(200, 224, 208)`. Card, Chart, Slider, Form, Table and the mermaid Diagram drew in that palette and font with an empty console; a `krypton-light` payload flipped `data-theme-scheme` to `light` and repainted the stage without touching the dark shell.

## Revision 2 — Index Rail and One Component Per View

> Status: Implemented
> Date: 2026-10-19

### Problem

The first version stacked all 40 examples in one scrolling page. Every example mounted as it entered the viewport, so the page ended up holding dozens of live previews, and reaching one component meant scrolling past the rest or filtering the whole column. The group links only jumped inside that same page.

### Design

Two flat panes on the canvas, no nested cards: a persistent index rail and the view of exactly one component.

- **Rail** (`.gallery__side`) — search box, then every `COMPONENTS` entry grouped by `GROUP_ORDER` under a sticky heading carrying that group's visible count. Items are `<a href="#<ComponentName>">`, so the fragment stays the route and browser back/forward is unchanged.
- **View** (`#gallery-detail`) — the open component only: a `Group · position / total` crumb, name, summary, Source and Reset, the live preview, the status line, the example source, and a parameter table generated from the catalog's `params` (kind, `required`, enum values, binding `holds`). A pager below it links the previous and next component by name.
- **One mounted preview.** `show()` disposes the previous component's renderers (`GalleryPreview.dispose()` → `disposeList`) and mounts the opened one; its `UiState` and view map survive, so a return visit keeps the inputs the user moved. The `IntersectionObserver` lazy-mount went away with the long page; a component's view element is built once and cached.
- **Search** filters the rail (name + summary) and the group counts, and never hides the open view. `[`/`]` and the pager walk the filtered list while it contains the open component, otherwise the full catalog.
- An empty or unknown fragment on a cold load opens the first component; an unknown fragment later leaves the open component alone.

| Key | Context | Action |
|---|---|---|
| `/` | Page, outside an input | Focus search |
| `Escape` | Search, or the page while filtering | Clear the filter; from the search field, return focus to the open rail item |
| `Enter` | Search | Open the first match |
| `↓` / `↑` | Rail (`↓` also from search) | Move focus between visible rail items |
| `Enter` | Rail item | Open it and focus its first GenUI control |
| `[` / `]` | Page, outside an input | Open the previous/next component |
| `Tab` / `Shift+Tab` | Everywhere | Native browser focus order |

Rail scrolling is computed from rects (`revealNav`) and focus moves with `preventScroll`: both `scrollIntoView({ block: 'nearest' })` and native focus scrolling park an item underneath the sticky group heading.

### Verification (2026-10-19)

`npx tsc --noEmit`, `npm run build` (both Vite passes), and the full Vitest suite (197 files, 2,567 tests) passed. Smoke in a Chromium tab, against the dev server and then against the built `dist/genui-gallery` bundle: `#Diagram` deep-linked and rendered mermaid; `]`/`[` opened the neighbouring component and rewrote the fragment; `/` then `slider` filtered the rail to `1 / 40 match` and Enter opened `Slider`; its input moved `4 → 13` and Reset restored `4`; Source toggled the example text; back/forward restored the previous component; only one `.gallery__view` was mounted at a time; a no-match filter showed the empty note with the rail groups hidden; a cold load of an unknown fragment opened `Card`; the built page logged no console errors.

## Problem

The current GenUI catalog has 40 implemented components in five groups, but inspecting one requires an agent-authored `krypton-ui` fence inside a Harness transcript. Spec 309 names them without showing their live appearance or input behavior. A developer needs a keyboard-accessible browser page that renders the shipped components and shows the source of each example.

## Solution

Add `GET /genui-gallery` to the existing `127.0.0.1` hook server. The page displays fixed, local examples compiled by the existing GenUI compiler and drawn by the existing catalog renderers; each example has a source toggle and local input state. Build it as a separate Vite browser entry within `frontendDist`, then serve its bundled HTML and assets through Tauri's asset resolver in release builds. Open it from the command palette or `#ui-gallery`; no lane, agent turn, artifact file, or new IPC command is required.

## Research

- `src/acp/genui/catalog.ts` currently declares 7 Layout, 7 Content, 12 Data, 12 Inputs, and 2 Form components. `src/acp/components/genui-catalog/index.ts` registers the production renderers and `missingRenderers()` checks coverage. Spec 309's proposed Dev/Project/Manage and `Snippet` components are not shipped; the gallery must enumerate the current `COMPONENTS` value.
- `compile()` and `initialState()`/`evaluate()` already provide the same validated path used by `GenUiPanel`. `renderChildren()` accepts a host-supplied `GenUiContext`, so a browser example can keep input and view state in memory and map actions to demo feedback without Harness access.
- Existing loopback pages use `html_response()` and open through `get_hook_server_port` + `open_url`. The gallery page itself needs JS/CSS imported from TypeScript, whereas the older pages are self-contained HTML. `vite.config.ts` currently builds only `index.html` and `live-assist.html`; Tauri's `frontendDist` is `../dist`.
- Tauri 2.11.2's `AppHandle::asset_resolver().get(path)` reads embedded `frontendDist` assets in release and falls back to files in `dist` in dev. Dev does not build `dist` before Vite starts, so the development route should redirect to Vite's page instead of depending on that fallback.
- `Diagram` reaches `harness-mermaid-fence.ts`, whose font helper imports Tauri IPC but returns without invoking it for a generic font stack. The gallery preview must set a generic `--agent-font` and smoke-test the Diagram example in an OS browser.
- Storybook's “stories” pair fixed input examples with the actual component and optional live controls. This pattern fits Krypton's existing vanilla TypeScript renderer; adding Storybook's React-oriented runtime would duplicate the project's build and violate the app's no-framework rule.

## Prior Art

| Surface | Relevant behavior | Krypton choice |
|---|---|---|
| Storybook stories and Controls | Browse named component states, inspect their source, adjust inputs live | Fixed examples plus the production renderer and local state; no new framework |
| Krypton Artifact Gallery | Fixed OS-browser loopback page, palette and Harness open paths, keyboard navigation | Same discoverability and browser surface |
| Krypton GenUI inline panel | Compiles a bounded fence, evaluates inputs, reconciles catalog nodes | Reuse its compiler, evaluator, renderer, and CSS; do not mount a transcript row |

## Affected Files

| File | Change after approval |
|---|---|
| `genui-gallery/index.html`, `src/acp/genui-gallery/main.ts`, `src/acp/genui-gallery/gallery.css` | Browser shell, navigation, preview lifecycle, and local action feedback |
| `src/acp/genui-gallery/examples.ts`, `src/acp/genui-gallery/examples.test.ts` | One bounded example per shipped component; compile/evaluate and coverage checks |
| `vite.genui-gallery.config.ts`, `package.json` | Second Vite build targeting `dist/genui-gallery` with base `/genui-gallery/`, run after the main build |
| `src-tauri/src/hook_server.rs` | `/genui-gallery` and `/genui-gallery/assets/{name}` routes; release asset responses and dev redirect |
| `src/compositor.ts`, `src/command-palette.ts` | `openGenUiGallery()` and palette entry |
| `src/acp/acp-harness-view.ts`, `src/acp/components/help-overlay/index.ts` | `#ui-gallery` command and help entry |
| `DESIGN.binance.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/README.md` | Record the browser surface and opening/data flow |

## Design

### Examples and rendering

```ts
interface GalleryExample {
  readonly component: string; // exact COMPONENTS name, unique
  readonly source: string;    // fixed krypton-ui v2 body, no remote data
}

interface GalleryPreview {
  readonly example: GalleryExample;
  readonly state: UiState;
  readonly views: Map<string, Record<string, unknown>>;
  dispose(): void;
}
```

`examples.ts` holds hand-authored samples with short, realistic data. Its test requires the set of `example.component` names to equal the set of `COMPONENTS` names, compiles every sample with zero error diagnostics, evaluates its initial state, and asserts that the named component appears in the resulting node tree. The gallery iterates `GROUP_ORDER` and `COMPONENTS` for headings and descriptions; adding a catalog entry without an example fails the test. Examples contain no `Load`/`Snippet`, external fetch, or user-provided code.

Each visible preview calls `compile` once, then `initialState` and `evaluate`; it mounts the evaluated nodes through `renderChildren()` inside `.acp-genui`. `ctx.setInput` re-evaluates only that example. `ctx.view` retains tab/expand/sort state until Reset or page reload. `ctx.run` permits local `Set` and user-initiated `Copy`; `Draft` and `OpenUrl` show a “Demo only” status instead of sending to a lane or navigating. Reset restores the sample's initial inputs and view state. Dispose renderer components when a filter removes an example. Mount previews as they enter the viewport so Diagram and charts do not all render on page load.

> The last two sentences (viewport lazy-mount, filter-time disposal) are superseded by Revision 2: one component is mounted at a time and leaving it disposes its renderers.

### Page and keyboard flow

> The page structure, fragment fallback, and keyboard table below are superseded by Revision 2; the token/palette sentence is superseded by Revision 3 — the page paints with the app's resolved theme and font, not a browser palette.

The fixed-dark loopback shell follows `DESIGN.binance.md`: near-black canvas, yellow accent, flat sections with hairline separators, and no nested shell cards. Set the GenUI `--krypton-*` tokens on the page root from the browser's dark palette (the Diagram theme reader also reads the root); this shows production structure and behavior, with browser colors rather than the user's active Tauri theme. Scope shell CSS to gallery classes so unlayered shell rules cannot override the layered component CSS. The page shows group counts, a search field, component name/summary, live preview, Source toggle, and Reset. Search matches name and summary. A URL fragment `#<ComponentName>` selects and scrolls to that example; unknown fragments fall back to the full gallery.

| Key | Context | Action |
|---|---|---|
| `/` | Page, outside an input | Focus search |
| `Escape` | Search | Clear search, then return focus to the selected example |
| `[` / `]` | Page, outside an input | Select previous/next visible example |
| `Enter` | Selected example heading | Focus its first GenUI control or Source button |
| `Tab` / `Shift+Tab` | Everywhere | Native browser focus order |

The command palette entry is “Open GenUI Component Gallery” (`genui-gallery.open`). `#ui-gallery` opens the same URL in the OS browser and does not enter `#ui`'s generation/preflight flow. Both report the existing “hook server not ready” error when the port is zero. Browser back/forward works through fragments; no polling is needed because the examples are static until page reload.

### Serving and build

`npm run build` keeps the current `tsc --noEmit && vite build`, then runs `vite build --config vite.genui-gallery.config.ts`. The second config has root `genui-gallery`, an absolute output path to the repo's `dist/genui-gallery` (Vite resolves a relative `outDir` from its root), `emptyOutDir: false`, and base `/genui-gallery/`; its HTML imports `src/acp/genui-gallery/main.ts`, the existing catalog modules, and their CSS. The first build clears `dist`, then the second adds the gallery. The existing Tauri `beforeBuildCommand` therefore bundles both; direct `cargo build` still follows the repository's existing requirement that `dist` be prepared for `frontendDist`.

In a release, `GET /genui-gallery` serves `genui-gallery/index.html` from `app_handle.asset_resolver()`. `GET /genui-gallery/assets/{name}` accepts one Vite asset basename only (`[A-Za-z0-9._-]+`), resolves `genui-gallery/assets/{name}`, and returns its MIME type and bytes or 404. Check that the exact path is embedded before calling `get()`: Tauri otherwise falls back to the main app's `index.html` for a missing key and would return 200. Both return `nosniff`, `no-referrer`, and `no-store`; the page uses a gallery-scoped CSP (`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'`). Inline styles are required by production GenUI renderers for chart geometry and controls; no inline script is used. In a debug build, `/genui-gallery` redirects to `http://127.0.0.1:1420/genui-gallery/` so Vite supplies TypeScript and HMR during Tauri dev; this is still a local browser page.

> `connect-src 'none'` is superseded by Revision 3: the directive is `connect-src 'self'`, for the same-origin `/genui-gallery/theme.json` fetch.

## Edge Cases and Verification

- A missing or malformed built asset returns 404 or an explicit unavailable page, never the main app's `index.html`. Asset names cannot traverse out of the gallery output directory.
- An example diagnostic shows next to that example and leaves other previews usable; the compile/evaluate coverage test should catch committed bad examples before build.
- No gallery action handler can submit a prompt or call Tauri IPC. `Diagram` uses the generic font stack, so the existing font helper returns before its IPC call; its lazy result is ignored after preview disposal.
- A catalog addition fails the example-coverage test until a representative example is added. A renderer addition must also pass the existing `missingRenderers()` test.
- Verify `npm run check`, focused example/component tests, `npm run build`, Rust route tests, `cargo fmt -- --check`, and an OS-browser smoke of search, keyboard navigation, inputs, Diagram, Source, and Reset in both dev and a packaged app. Automated tests alone do not establish the packaged browser result.

## Verification (2026-10-19)

`npm run build`, the full Vitest suite (197 files, 2,567 tests), 75 Rust hook-server tests, `cargo fmt -- --check`, and `cargo clippy -- -D warnings` passed. `npx tauri build --bundles app --no-sign` produced an unsigned macOS app. Its loopback route served the gallery and a bundled JavaScript asset with 200, returned 404 for a missing asset, and rendered all 40 examples without gallery diagnostics in an OS browser. Search, an editable input and Reset, Source, Diagram, and the local Draft/OpenUrl feedback were exercised. The page's keyboard handlers were checked with dispatched key events because the Browser Control extension intercepts `/` itself. Signed packaging was not verified because the local `Krypton Dev` signing identity is unavailable.

## Open Questions

None. This spec chooses live production renderers, local fixed examples, and the loopback dark palette.

## Out of Scope

- Editing or executing arbitrary pasted `krypton-ui` source in the browser.
- Loading project files or live lane/agent data, changing the GenUI language/catalog, or persisting gallery input state.
- Sending prompts, opening external URLs from examples, or replacing the inline Harness panel.
- Installing Storybook or a frontend framework.

## Resources

- [Storybook: How to write stories](https://storybook.js.org/docs/writing-stories/index) — fixed examples of rendered component states.
- [Storybook: Controls](https://storybook.js.org/docs/essentials/controls) — local input adjustment pattern.
- [Vite: Building for Production](https://vite.dev/guide/build.html) — multi-page and separate build output behavior.
- [MDN: CSP `script-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src) — self-hosted script policy for the browser page.
- Tauri 2.11.2 local source, `tauri/src/app.rs::AssetResolver::get` — release embedded-asset and dev `dist` behavior.
