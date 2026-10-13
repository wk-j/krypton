# ACP Harness Mermaid Fence Preview — Implementation Spec

> Status: Implemented
> Date: 2026-10-13
> Milestone: ACP Harness

## Implementation Deviations

- **No `diagramType` on `SvgFenceEntry`.** The label lives on the card; the viewer reads the cached render through `figureViewerSource(entry)` (replaces `svgViewerSource`), which is null while a mermaid card is pending or broken.
- **Live code lives in `harness-svg-fence.ts`.** `updateLiveSvgFences` also drives mermaid fences and `clearLiveSvgFences` cancels them, so `harness-markdown.ts` and the seal branch are unchanged; there is no `updateLiveMermaidFences`/`clearLiveMermaidFences` export. `isFenceClosed` is exported for tests.
- **Renderer signature.** `renderMermaid(source, theme, wanted?)` / `cachedMermaid(source, theme)` take a `MermaidTheme` built by `readMermaidTheme()`; `wanted` predicates from every joined caller decide whether a queued render still runs (null = skipped, not cached).
- **Theme inputs.** `darkMode` comes from `html[data-theme-scheme]`, not luminance. Palette colours are normalized through a canvas `fillStyle` so khroma always parses them. Node borders and lines use `muted` (Krypton's border colour is a faint translucent tint). `cScale0…5` = `c1…c6` with `cScaleLabel` = `surface`, otherwise mindmap/timeline branches take the background colour. `altFontFamily` is also locked.
- **`--pending` hides the preview** instead of reserving a line.
- **Smoke (Chromium via the Vite dev server, not WKWebView):** flowchart (Thai labels, `<br/>`), sequence, pie, and mindmap render with no `<foreignObject>`; a parse error gives `mermaid · error` with source; a closed streaming fence draws a live card and seal repaints it synchronously from cache; an `%%{init}%%` setting `theme`, `themeCSS`, and `securityLevel` is ignored, an `<img onerror>` label is sanitized, and no render nodes are left in `document.body`.
- **Font (spec 283 Revision 3).** WebKit draws `<img>` SVG without user-installed fonts, which the Chromium smoke could not show. `renderNow` therefore embeds subset `@font-face` faces of `config.fontFamily` (`loadSvgFontFaces` → `embedSvgFontFaces`) before caching, so labels draw in the same font mermaid measured them with.

## Problem

Agents answer with ` ```mermaid ` fences all the time (flows, sequences, state machines). The harness transcript shows them as plain code. Tern renders the same omp reply as a themed diagram card (`mermaid · flowchart`, Source / Copy / Open); Krypton should too.

## Solution

Treat a ` ```mermaid ` fence as a second **figure kind** on the spec 283 SVG card. The official `mermaid` library renders the source to an SVG string in the main document (lazy-loaded, `securityLevel: 'strict'`, Krypton palette as `themeVariables`, harness font). The string goes into the existing `<img src="data:image/svg+xml,…">` preview, so the rendered diagram stays inert exactly like an SVG fence, and the card reuses spec 283's toolbar, `f`-hint, Source toggle, Copy, and zoom viewer unchanged.

Rendering is async, so results are cached by `(theme, source)`; a row rebuild from `markdownHtml` hits the cache and paints synchronously. While streaming, a fence renders once **it closes** (OMP TUI behaviour), not per delta.

## Research

- **`mermaid` 11.14.0 is already installed and already bundled.** `@excalidraw/excalidraw` → `@excalidraw/mermaid-to-excalidraw@2.2.2` → `mermaid@11.14.0` (`npm ls mermaid`). `dist/assets` already contains `flowDiagram-*.js`, `sequenceDiagram-*.js`, `dagre-*.js`. Declaring it as a direct dependency (`^11.14.0`) dedupes; the extra bundle cost is ~0.
- **API** (`node_modules/mermaid/dist/mermaidAPI.d.ts`, `types.d.ts`): `render(id, text) → Promise<{ svg, diagramType }>`; `parse(text, { suppressErrors })`. Root-level `htmlLabels` (diagram-level ones are deprecated) — `false` gives SVG `<text>` labels, the safe shape for `<img>`. `fontFamily`, `themeVariables`, `securityLevel: 'strict'` (DOMPurify on labels, no click callbacks), `secure: string[]` (config keys `%%{init}%%` directives may not override), `maxTextSize` (default 50 000).
- **Theme engine needs concrete colours.** Mermaid derives shades with khroma; `var(--x)` fails (`Unsupported color format`). `readSvgPalette()` already returns computed concrete colours, so it feeds `themeVariables` directly. The output SVG carries baked colours in its own `<style>`; a theme switch re-renders.
- **Sizing.** Mermaid emits `width="100%"` plus `viewBox`. `svgFrame`'s `numericAttr` rejects `100%`, so it falls back to `viewBox` — the existing preview sizing and `svgBaseSize` zoom base work unchanged.
- **OMP 18.10.3** (Tern-bundled binary, `strings`): TUI renders mermaid as ASCII via native `renderMermaidAscii`, setting `tui.renderMermaid`, and skips a fence while `lang === "mermaid" && !closed` — i.e. it draws each fence when it closes, mid-stream.
- **Tern** (binary strings): Rust-native mermaid renderer pinned to the Mermaid 11 baseline (headless, merman-style), card header `mermaid · <type>`, Source / Copy / Open (lightbox pan-zoom), source shown on render failure.
- **Integration points** (spec 283): `decorateSvgFences` runs after the `markdownHtml` restore (`harness-transcript-render.ts:343`) and in seal branch A after capture (`acp-harness-view.ts:14424`); `updateLiveSvgFences` after `parser_write` (`harness-markdown.ts:224`); `refreshSvgFencePreviews` from `Compositor.updateTerminalThemes` (`compositor.ts:2115`); hint collection `:9559`, dispatch `:9614-9618`, click delegation `:6337-6341`, viewer `openSvgViewer` `:14238`; policy line `renderLanePolicy` `:8656`.

### Alternatives considered

| Option | Why not |
|--------|---------|
| `beautiful-mermaid` (sync, zero-DOM, 2 MB) | 6 diagram types only — no gantt, pie, mindmap, timeline, gitGraph; a new dependency when mermaid is already bundled |
| Rust `merman` crate via a Tauri command (Tern's route) | New heavy crate compile; backend role is PTY/config, not rendering; headless text metrics diverge from the webview font |
| Inline `<svg>` DOM from `mermaid.render` | Safety would rest on mermaid's sanitiser alone; `<img>` keeps spec 283's browser-enforced inertness |
| Progressive per-line render while streaming | Every new node re-runs layout → diagram jumps each tick; 20–100 ms main-thread render per tick vs the 16 ms keypress budget |

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Tern | Native renderer, card `mermaid · flowchart`, Source / Copy / Open lightbox | Target look |
| OMP TUI | ASCII render when the fence closes; `tui.renderMermaid` toggle | Closed-fence rule adopted |
| GitHub | ` ```mermaid ` → sandboxed iframe viewer | Fence → preview |
| Obsidian | mermaid.js inline in preview | Mouse only |

**Krypton delta:** Tern's card and parity goal, OMP's closed-fence timing, spec 283's `<img>` sandbox and `f`-hint keyboard path. No separate "Open" button: preview click / `f` label already zooms (spec 283).

## Affected Files

| File | Change |
|------|--------|
| `package.json` | `"mermaid": "^11.14.0"` direct dependency (dedupes the excalidraw copy) |
| `src/acp/harness-mermaid-fence.ts` (new) | Lazy loader, config/`themeVariables`, serialized render queue, LRU cache, `MERMAID_FENCE_GUIDANCE`, live closed-fence render |
| `src/acp/harness-svg-fence.ts` | Detector also matches `mermaid`/`language-mermaid`; one shared index sequence; card build/state by `kind`; `refreshSvgFencePreviews` dispatches by kind |
| `src/acp/harness-view-types.ts` | `SvgFenceEntry.kind`, `diagramType?` |
| `src/acp/harness-markdown.ts` | `updateLiveMermaidFences(body)` after `updateLiveSvgFences` |
| `src/acp/acp-harness-view.ts` | Seal: `clearLiveMermaidFences`; `openSvgViewer` + copy chip branch on `kind`; policy line |
| `src/styles/acp-harness.css` | Streaming placeholder for `code.mermaid`; `--pending` preview state |
| `src/acp/harness-mermaid-fence.test.ts` (new) | Pure logic (below) |
| `docs/0283-…`, `docs/0072-acp-harness-view.md`, `docs/0289-lane-context-delta.md`, `docs/README.md` | Cross-link, data flow, policy example, index |

## Design

### Data structures

```ts
// harness-view-types.ts — spec 283 entry gains a kind; one array, one index sequence per row.
export interface SvgFenceEntry {
  index: number;
  kind: 'svg' | 'mermaid';
  hintLabel: string | null;
  showSource: boolean;
  source: string;            // fence text; Copy copies this (mermaid source for mermaid)
  diagramType?: string;      // mermaid only, e.g. 'flowchart', 'sequence'
}

// harness-mermaid-fence.ts
export const MERMAID_FENCE_MAX_CHARS = 50_000;     // mermaid's own maxTextSize default
const MERMAID_CACHE_MAX = 64;                      // LRU entries
type MermaidResult = { ok: true; svg: string; diagramType: string } | { ok: false; error: string };
export function cachedMermaid(source: string): MermaidResult | undefined;      // current theme key
export function renderMermaid(source: string): Promise<MermaidResult>;         // queued, caches
export function mermaidThemeVariables(palette: SvgPalette): Record<string, string>;
export function normalizeDiagramType(raw: string): string;                     // 'flowchart-v2' → 'flowchart'
export function updateLiveMermaidFences(body: HTMLElement): void;
export function clearLiveMermaidFences(body: HTMLElement): void;
```

### Renderer

- `import('mermaid')` on first use; one module promise.
- Before each render whose theme key (`palette + font` joined) differs from the last, call `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base', darkMode, fontFamily, themeVariables, maxTextSize: MERMAID_FENCE_MAX_CHARS, secure: [...defaults, 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'darkMode', 'htmlLabels'] })`. Agents cannot re-theme or inject `themeCSS` via `%%{init}%%`.
- Renders run one at a time through a module promise chain (initialize is global state). Ids are `krypton-mmd-<n>`.
- `themeVariables` from `readSvgPalette()`: `background`/`mainBkg`/`primaryColor` = `surface`, `primaryTextColor`/`textColor` = `fg`, `primaryBorderColor`/`nodeBorder` = `border`, `lineColor` = `muted`, `secondaryColor`/`tertiaryColor` = `surface`, `clusterBorder` = `border`, `edgeLabelBackground` = `surface`, `noteBkgColor` = `surface`, `noteTextColor` = `fg`, `titleColor` = `accent`, `pie1…6` = `c1…c6`. `darkMode` from `fg` luminance > `surface` luminance.
- Result svg is used as-is (it already has `xmlns`, a `viewBox`, and baked colours). Never inserted as DOM; only into the card `<img>` via the spec 283 `setPreview`.
- Errors (parse failure, over cap) cache as `{ ok: false }` so rebuilds don't retry.

### Card

`decorateSvgFences` walks `pre > code` in document order matching `svg|language-svg|mermaid|language-mermaid`; index is shared. For a mermaid fence:

1. Cache hit `ok` → card built and painted synchronously; kind label `mermaid · <diagramType>`.
2. Cache hit error → `--broken` card (source shown, toggle hidden), label `mermaid · error`, `title` = error message.
3. Miss → card with `--pending` (empty preview reserving one line, label `mermaid · rendering…`), then `renderMermaid`. On settle, if the card is still connected, patch only that card (img, label, classes). If disconnected, drop the result paint; the cache still holds it for the next build.

The patch touches only the card's sub-DOM and never calls `render()` (constraint 10). The render signature is unchanged (`index:hint:source` only), so rendering status never forces a rebuild.

```html
<figure class="acp-harness__svg-card acp-harness__svg-card--mermaid [--pending|--broken|--source]" data-svg-index="1" data-svg-kind="mermaid">
  <div class="acp-harness__svg-card-bar">
    <span class="acp-harness__svg-card-kind">mermaid · flowchart</span> … Source · Copy
  </div>
  <div class="acp-harness__svg-card-preview"><img alt="Mermaid diagram" data-svg-zoom data-svg-index="1" src="data:image/svg+xml;…"></div>
  <pre><code class="…mermaid">…</code></pre>
</figure>
```

### Streaming

- CSS: under `--stream-live`, `pre:has(> code.mermaid)` hides its code and shows a pulsing `mermaid · drawing…` `::before` (same rule as svg, opacity-only, off under `prefers-reduced-motion`).
- `updateLiveMermaidFences(body)` after each `parser_write`: a `pre > code.mermaid` is **closed** when any node follows the `pre` in document order inside the body (smd only appends, so content after the fence means it left it). On first closed sighting, `renderMermaid(source)` once; on success insert a non-interactive `--live` card before the `pre` (spec 283 rev 2 shape; no `data-svg-*`). A `WeakMap<code, state>` guarantees one render per fence. The last fence in the reply closes at seal.
- Seal branch A: `clearLiveMermaidFences(body)` next to `clearLiveSvgFences`, before the `markdownHtml` capture; `decorateSvgFences` then hits the cache and builds the real card at the same coordinates.

### Theme switch

`refreshSvgFencePreviews` keeps re-theming svg cards from their `pre`, and for `data-svg-kind="mermaid"` cards calls `renderMermaid(source)` and patches on settle. The old frame stays until the new one decodes (no flash).

### Keyboard / mouse

Identical to spec 283 for both kinds: `f` → label zooms (viewer gets `{ src, width, height }` from the cached render via `svgBaseSize`), label on Source returns to Preview, `Shift+<label>` copies the mermaid source (`flashChip('copied mermaid')`). `--pending`/`--broken` cards: label toggles Source instead of zooming. Toolbar buttons and preview click keep the existing `data-svg-*` delegation.

### Guidance

`renderLanePolicy` pushes, after `SVG_FENCE_GUIDANCE`, in both branches (≈90 chars; policy stays under spec 289's 1 700 target):

```
```mermaid fenced blocks render inline as themed diagrams; don't set theme or themeCSS in %%{init}%%.
```

## Edge Cases

- **Unsupported/invalid syntax:** `--broken` card showing source, `mermaid · error`; Copy and `Shift+label` still work.
- **Over `MERMAID_FENCE_MAX_CHARS`:** stays plain code (not carded), like an over-cap svg fence.
- **Diagram types that still emit `<foreignObject>` with `htmlLabels: false`** (e.g. mindmap): `<img>` renders it statically in WebKit `[INFERENCE: verify in smoke]`; if it fails, the img `error` path turns the card `--broken`.
- **Many fences on cold load:** queued one at a time; disconnected cards are skipped before rendering (re-queued by the next build), so off-window rows cost nothing.
- **`%%{init}%%` directives:** honoured except the `secure` keys above.
- **Background-lane seal (branch B):** not decorated offscreen; first visible render decorates (spec 283 rule).
- **Remote/SSH harness:** identical; render is local to the webview.
- **Security:** mermaid runs `strict` in the main document (its temporary render node lives in `document.body` during `render`); the returned svg only ever reaches an `<img>` data URL. Residual: a mermaid parser/sanitiser CVE during `render` executes in the main document — mitigated by `strict`, `htmlLabels: false`, and tracking mermaid patch releases.

## Verification

- Unit (`harness-mermaid-fence.test.ts`): `normalizeDiagramType`; `mermaidThemeVariables` mapping incl. `darkMode`; the closed-fence predicate (fence last vs followed by text/list sibling); LRU eviction keeps the newest; theme-key change misses the cache; render-signature unchanged by `--pending`→ready.
- Smoke (`npx tauri dev`): a lane reply with flowchart, sequence, gantt, and a broken fence → cards render, labels show type, `f` zoom/copy/Source work, theme switch re-renders, a streamed fence draws when its closing ``` arrives, no layout jump at seal.

## Out of Scope

- Progressive per-line live render.
- Copy Image / save PNG, `n`/`p` stepping between cards in the viewer.
- Mermaid in lane mail, peek-thought, Live Assist, Agent view, markdown viewer.
- A config toggle.

## Resources

- [Mermaid configuration schema](https://mermaid.js.org/config/schema-docs/config.html) — `htmlLabels`, `securityLevel`, `secure`, `maxTextSize`, `themeVariables`.
- [Mermaid theming](https://mermaid.js.org/config/theming.html) — `base` theme + `themeVariables`, hex-only colours.
- [beautiful-mermaid README](https://github.com/lukilabs/beautiful-mermaid) — zero-DOM alternative; 6 diagram types.
- [merman (docs.rs)](https://docs.rs/merman) — headless Rust Mermaid at 11.x parity; Tern-style route.
- OMP 18.10.3 binary (`~/Library/Application Support/Tern/omp/versions/18.10.3`, `strings`) — `tui.renderMermaid`, closed-fence gate.
- Tern binary (`/Applications/Tern.app`, `strings`) — card label, Source/Copy/Open, native renderer, failure → source.
- `node_modules/mermaid/dist/{mermaidAPI,types,config.type}.d.ts`; `npm ls mermaid`; `dist/assets` chunk listing.
- `docs/0283-harness-svg-fence-preview.md` — card, viewer, streaming, palette contract reused here.
