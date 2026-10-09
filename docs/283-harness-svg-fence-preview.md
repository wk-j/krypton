# ACP Harness SVG Fence Preview — Implementation Spec

> Status: Implemented
> Date: 2026-10-09
> Milestone: ACP Harness

## Implementation Deviations

- **`SVG_FENCE_MAX_CHARS`, not `_BYTES`.** The 256 Ki cap is checked against the source's string length, which avoids encoding the source just to measure it.
- **`SvgFenceEntry.source`.** Each entry keeps the original fence text. Copy reads it from the model, so it works even for a row that has scrolled out of the rendered window. `svgFenceSource(card)` was not needed.
- **Root `fill` default.** `themeSvgSource` also injects `fill="<fg>"` when the root has none. This departs from OMP: SVG's initial fill is black, so unstyled text vanished on a dark theme during smoke testing.
- **Signature carries non-default state only.** `transcriptRenderSignature` includes a card only when it is labelled or showing source. Decorating a fresh row therefore never forces an extra rebuild.
- **`HarnessOpenTarget` union** in `acp-harness-view.ts` replaces the inline target union, which had grown to six members.
- **Zoom (added after ship; was Out of Scope).** Clicking a card's preview, or its `f` label while it shows the preview, opens the spec 281 image viewer in SVG mode (`HarnessImageViewer.openSvg`). The viewer re-themes `entry.source` through `svgViewerSource`, which returns the data URL plus `svgBaseSize` (explicit `width`/`height`, then the `viewBox` for a missing side, then 300×150). The SVG is not added to the lane image list, so `n`/`p` and `o` are inert. Fit fills the stage (vectors upscale; bitmaps still cap at 100%), and zoom lays the `<img>` out at the zoomed size instead of transform-scaling it, so text stays sharp. `s` closes the viewer and flips the card to Source. Because the plain label now zooms, a card already showing Source uses its plain label to return to Preview.

## Problem

When an agent answers with a ` ```svg ` fenced block (a diagram, a mockup of a proposed card, a chart), the harness transcript shows only highlighted XML. The user has to copy it elsewhere to see the picture. Agents also rarely produce SVG in the first place. OMP invites its model to draw SVG only in its own TUI, never over ACP, so a Krypton lane is never told that it can.

## Solution

When an assistant row is sealed or re-rendered from cache, each valid ` ```svg ` fence becomes an **SVG card**. The card has a toolbar (`svg` label, `Source`/`Preview` toggle, `Copy`) and a preview pane.

The preview is an `<img src="data:image/svg+xml;charset=utf-8,…">`, never inline `<svg>` DOM. HTML renders SVG used as an image in the SVG2 *secure animated mode*, which means no script execution, no external fetches, and no interaction. That protection holds even though Krypton runs `csp: null` in a webview with Tauri IPC.

Before encoding, the source is **themed** the way OMP does it: every `var(--name, fallback)` is replaced with the active Krypton theme colour from a fixed palette, and the root gets default `color`, `font-family`, and `xmlns` attributes. Themed images and the `<img>` sandbox therefore work together.

A one-line **per-turn guidance** tells every lane that ` ```svg ` renders and names the palette variables. The palette names are the same as OMP's, so one SVG renders correctly in both the OMP TUI and Krypton.

Each card is a new target type in the existing `f` open-hint mode: `<label>` zooms the preview in the image viewer (or returns a Source card to Preview), `Shift+<label>` copies the source. Fences render only at seal, not while streaming. This is frontend only.

## Research

- **Render paths.** `sealAssistantStreamingMarkdown` branch A (live smd body, `acp-harness-view.ts:14019-14070`) captures `item.markdownHtml` at :14060 and appends the resources rail *after* the capture. Branch B (offscreen) only caches. Every visible sealed or cold row is built by `renderTranscriptItem` (`harness-transcript-render.ts:334-358`): `innerHTML = item.markdownHtml` → `resolveLocalImageSrcs` → `applyTranscriptAnnotations` → `scanMessageResourceBody` → `appendMessageResourceRail`. This spec follows the rail pattern: the cache holds pure markdown and decoration runs on every render.
- **Fence DOM differs by producer.** smd emits `<pre><code class="svg">` with raw text; the whole info string becomes `class` (`smd.js:680`, `:143`). marked plus marked-highlight emits `<pre><code class="hljs language-svg">` with hljs spans (hljs aliases `svg` to `xml`) and a trailing `\n`. The detector matches both class forms and reads `textContent` minus one trailing newline.
- **Security.** `tauri.conf.json:28` sets `csp: null`. An inline `<svg>` inserted through `innerHTML` would run `<script>` and `on*` handlers and would let `<foreignObject>` HTML into the IPC-capable webview. `<img>` gets the protection from the browser instead of from an allowlist we maintain (compare `sanitizeSvg`, `src/review-board/render.ts:134`). `resolveLocalImageSrcs` skips `data:` (`harness-markdown.ts:97`).
- **OMP prior art** (`omp/18.8.6` bundle, `packages/tui/src/chat/svg-figure.ts`; changelog 18.7.0):
  - Fence detection: splits assistant markdown into markdown and `svg` segments, using the first word of the info string.
  - Theming (`uDt`): replaces `var(--name, fallback)` with theme hex from the palette `fg, muted, border, accent, success, warning, error, surface, c1–c6`; `c1–c6` are the syntax keyword, string, function, type, number, and variable colours. It then injects `color`, `font-family="sans-serif"`, `xmlns` (and `xmlns:xlink` when `xlink:` is used) on the root.
  - Rendering: native `rasterizeSvg` to PNG, capped at 4096px and 80% of terminal rows.
  - Streaming: auto-closes open tags and redraws every 200ms.
  - Failure: falls back to the source code block.
  - Model guidance: `tui.renderSvg` ("Invite the agent to draw diagrams and charts as SVG…") is gated by `tuiTranscript && !subagent`. The changelog says the guidance is "main TUI session only, not to subagents, print, RPC, or ACP", and Krypton spawns `omp acp` (`src-tauri/src/acp.rs:121-124`).
  - Takeaway: a renderer alone is not enough, because the model has to be told SVG is available.
- **Missing `xmlns`.** Agents often omit it. A `data:` SVG `<img>` without `xmlns="http://www.w3.org/2000/svg"` fails to render, so injecting it is required for correctness, not only for consistency with OMP.
- **Guidance channel.** `renderPromptMemoryPacket` (`acp-harness-view.ts:8527-8603`) builds the per-turn Krypton preamble. It has an early-return branch when harness memory is unavailable (:8532-8537). SVG guidance needs no MCP tools, so it goes into both branches and applies to every backend.
- **Theme change.** `FrontendThemeEngine.apply` sets the CSS variables and then calls its callbacks (`theme.ts:600-606`). `Compositor.updateTerminalThemes` (`compositor.ts:1913-1950`) is the existing fan-out that refreshes live surfaces on a theme switch.
- **Keyboard.** The only action surface for transcript elements is `f` open-hint mode (spec 206). Targets are model objects with a mutable `hintLabel`, collected in `activeLaneOpenTargets` (`acp-harness-view.ts:9424-9441`) and dispatched by shape in `handleOpenHintKey` (:9470-9506). Hint labels are part of `transcriptRenderSignature`. Spec 282 subagent rows are the precedent for a toggle target, and spec 102 for `Shift+<hint>`. Copy follows the existing precedent: `navigator.clipboard.writeText` then `flashChip` (`harness-ticket-controller.ts:918-922`).
- **Layout.** Assistant rows are not Pretext-laid. The per-row ResizeObserver (`acp-harness-view.ts:15390-15452`) handles a late image decode, and an `aspect-ratio` taken from `viewBox` avoids the jump.
- **Annotations.** `applyTranscriptAnnotations` wraps text nodes except under `SKIP_WRAP` (`transcript-annotation.ts:24`). Toolbar text must be listed there.
- **Alternatives rejected.**
  1. Inline SVG plus `sanitizeSvg`: theming no longer favours it, and its safety rests on an allowlist.
  2. Sandboxed `<iframe srcdoc>`: heavy per block, and sizing is awkward.
  3. `blob:` URLs: they do not survive the `markdownHtml` round-trip and need revoke bookkeeping.
  4. Progressive render while streaming (OMP-style): see *Streaming* below.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| OMP TUI (18.7+) | ` ```svg ` themed through `var(--…)` palette → native raster PNG → terminal graphics; progressive while streaming; source fallback | Guidance and rendering only in the main TUI, not ACP |
| Obsidian (SVG Viewer plugin) | DOMParser-sanitized inline SVG; click toggles source; hover copy button | Mouse only |
| GitHub | Renders `mermaid`/`geojson`/`topojson`/`stl` fences in a sandboxed iframe; `svg` stays code | Fence → preview pattern exists |
| Review Board (Krypton) | Inline SVG through the `sanitizeSvg` allowlist | Lane-authored charts of known shape |
| Image strip (Krypton, spec 281) | Rejects `image/svg+xml` bytes by sniffing | SVG stays out of the blob/viewer pipeline |

**Krypton delta:** uses OMP's palette contract and theming so SVG is portable across both hosts. Uses Obsidian's UX (preview default, source toggle, copy), driven through `f` hints. Safety comes from the `<img>` processing mode rather than a sanitizer. Rendering happens at seal, not progressively.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-svg-fence.ts` (new) | Palette read, theming, detection/validation, card build, `item.svgFences` sync, theme refresh |
| `src/acp/harness-view-types.ts` | `SvgFenceEntry`; `HarnessTranscriptItem.svgFences?` |
| `src/acp/harness-transcript-render.ts` | Call the decorator after the cached-HTML restore, before annotations; add svg state to `transcriptRenderSignature` |
| `src/acp/acp-harness-view.ts` | Call the decorator in seal branch A after cache capture; hint target collection and dispatch; delegated toolbar clicks; SVG guidance line in `renderPromptMemoryPacket` (both branches) |
| `src/compositor.ts` | `updateTerminalThemes` calls `refreshSvgFencePreviews(document)` |
| `src/acp/transcript-annotation.ts` | Add `.acp-harness__svg-card-bar` to `SKIP_WRAP` |
| `src/styles/acp-harness.css` | `.acp-harness__svg-card*` BEM styles |
| `src/acp/harness-svg-fence.test.ts` (new) | Theming, detection/validation, idempotence |
| `docs/72-acp-harness-view.md`, `docs/206-assistant-response-resources.md`, `docs/README.md` | Card, hint target, guidance line |

## Design

### Data Structures

```ts
// harness-view-types.ts
export interface SvgFenceEntry {
  index: number;            // nth valid svg fence in the row body (document order)
  hintLabel: string | null; // f-mode label, like SubagentEntry
  showSource: boolean;      // card is showing the source pane
}
// HarnessTranscriptItem
svgFences?: SvgFenceEntry[];

// harness-svg-fence.ts
type SvgPalette = Record<
  'fg' | 'muted' | 'border' | 'accent' | 'success' | 'warning' | 'error' | 'surface'
  | 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6',
  string
>;
```

### Palette contract

The names match OMP. Values are read from computed `document.documentElement` styles at decorate time:

| Name | Krypton source | Name | Krypton source |
|------|----------------|------|----------------|
| `fg` | `--krypton-fg` | `surface` | `--krypton-bg-elev` |
| `muted` | `--krypton-fg-dim` | `c1` (keyword) | `--krypton-ansi-5` |
| `border` | `--krypton-border-color` | `c2` (string) | `--krypton-ansi-2` |
| `accent` | `--krypton-accent` | `c3` (function) | `--krypton-ansi-4` |
| `success` | `rgb(--krypton-success-rgb)` | `c4` (type) | `--krypton-ansi-3` |
| `warning` | `rgb(--krypton-warning-rgb)` | `c5` (number) | `--krypton-ansi-6` |
| `error` | `rgb(--krypton-danger-rgb)` | `c6` (variable) | `--krypton-ansi-1` |

### API

```ts
// harness-svg-fence.ts
export const SVG_FENCE_MAX_BYTES = 256 * 1024;
export const SVG_FENCE_GUIDANCE: string; // the per-turn preamble line
export function readSvgPalette(): SvgPalette;
export function themeSvgSource(source: string, palette: SvgPalette): string;
export function decorateSvgFences(body: HTMLElement, item: HarnessTranscriptItem): void;
export function refreshSvgFencePreviews(root: ParentNode): void;
```

`themeSvgSource` replaces `var(--name[, fallback])` with `palette[name]`, then the fallback, then `palette.fg`. On the root `<svg …>` tag, each attribute below is added only when absent: `color="<fg>"`, `font-family="ui-monospace, SFMono-Regular, Menlo, monospace"` (Krypton's mono voice; system fonts only, since `<img>` cannot load web fonts), `xmlns`, and `xmlns:xlink` when the source uses `xlink:`.

`decorateSvgFences` is idempotent: it skips any `pre` already inside a card. For each `pre > code` whose classList has `svg` or `language-svg`:

1. `source = code.textContent` minus one trailing `\n`. If it is over `SVG_FENCE_MAX_BYTES`, the block stays code.
2. `themed = themeSvgSource(source, readSvgPalette())`.
3. `DOMParser().parseFromString(themed, 'image/svg+xml')`. If the root is not `<svg>` or the result contains a `parsererror`, the block stays code. This is validation only and nothing parsed is inserted. Read the aspect ratio from `viewBox`, or from numeric `width`/`height`.
4. Wrap the existing `<pre>` in the card. The `<pre>` is kept, so the source pane and its highlighting are exactly as rendered. Set `img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(themed)`.
5. Rebuild `item.svgFences` with one entry per card, carrying `showSource`/`hintLabel` over from the previous entry with the same `index`. Apply `--source` and the hint badge.

`refreshSvgFencePreviews` re-themes every `.acp-harness__svg-card img` under `root` from its card's `<pre>` source. It is used on theme change and does not rebuild rows.

### Guidance line

`SVG_FENCE_GUIDANCE` is pushed in `renderPromptMemoryPacket` for every lane and backend, in both the memory-available and memory-unavailable branches:

> SVG figures: when a diagram, chart, or UI mockup explains something better than prose, you may include it as a ```svg fenced block — Krypton renders it inline as an image (the user can toggle to source). Keep it self-contained: scripts, external images, and web fonts are blocked. Give the root a viewBox. Use theme colors via var(--fg), var(--muted), var(--border), var(--accent), var(--success), var(--warning), var(--error), var(--surface), var(--c1)…var(--c6), optionally with a fallback such as var(--accent, #0cf).

### Streaming

Fences render only at seal; while streaming they stay plain code. This is a deliberate decision:

- smd keeps live references to the `pre`/`code` nodes until `parser_end`, so it cannot wrap them mid-stream.
- A 200ms re-encode and decode loop on the main thread works against the harness streaming budget (spec 114).
- A sealed row is rebuilt from cache anyway.

### Data Flow

```
0. Each turn: renderPromptMemoryPacket includes SVG_FENCE_GUIDANCE
1. Agent streams a ```svg fence → smd shows plain code (P1/P2, untouched)
2. Seal branch A: cache markdownHtml (pure) → decorateSvgFences(live body)
   → scan → rail                                    [decoration never cached]
3. Any later render (cold load, label change, toggle): innerHTML = markdownHtml
   → resolveLocalImageSrcs → decorateSvgFences → annotations → scan → rail
4. Theme switch / Reload Config: ThemeEngine.apply → Compositor.updateTerminalThemes
   → refreshSvgFencePreviews(document) re-themes visible cards in place
5. f → SVG cards get labels (after artifact/review/resources/images/subagents)
6. <label> → Source card: entry.showSource = false; render()
            Preview card: imageViewer.openSvg(svgViewerSource(entry.source))
   Shift+<label> → navigator.clipboard.writeText(source); flashChip('copied svg')
7. Viewer: =/- zoom · 0 fit · 1 100% · hjkl pan · s → close + showSource · Esc close
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `f` | Transcript | Enter open-hint mode (existing); SVG cards receive labels |
| `<label>` | Open-hint mode, SVG card showing Preview | Zoom the SVG in the image viewer, exit hint mode |
| `<label>` | Open-hint mode, SVG card showing Source | Return to Preview, exit hint mode |
| `Shift+<label>` | Open-hint mode, SVG card | Copy the original (unthemed) SVG source, exit hint mode |
| `=` / `-` / `0` / `1` / `hjkl` | Image viewer, SVG | Zoom in / out / fit / 100% / pan |
| `s` | Image viewer, SVG | Close the viewer and show the card's Source |
| `Esc` | Image viewer, SVG | Close |

Mouse is secondary. The toolbar `Source` and `Copy` buttons carry `data-svg-toggle` / `data-svg-copy`, and the preview `<img>` carries `data-svg-zoom` (cursor `zoom-in`); all three also carry `data-svg-index` and are handled by the delegated transcript click listener in `acp-harness-view.ts`.

### UI Changes

```html
<figure class="acp-harness__svg-card [acp-harness__svg-card--source]" data-svg-index="0">
  <div class="acp-harness__svg-card-bar">
    <span class="acp-harness__svg-card-kind">svg</span>
    <span class="acp-harness__svg-card-hint">a</span>          <!-- only in f mode; card gets --hinted -->
    <button data-svg-toggle data-svg-index="0">Source</button> <!-- "Preview" when --source -->
    <button data-svg-copy data-svg-index="0">Copy</button>
  </div>
  <div class="acp-harness__svg-card-preview">
    <img alt="SVG preview" decoding="async" data-svg-zoom data-svg-index="0" style="aspect-ratio: W / H" src="data:image/svg+xml;charset=utf-8,…">
  </div>
  <pre><code class="…svg">…</code></pre>                         <!-- hidden unless --source -->
</figure>
```

Styling:

- Card: full 1px `--krypton-border-color` border, transparent background.
- Toolbar: muted mono label style.
- Preview pane: `max-height: 480px`; the image uses `max-width: 100%` and `object-fit: contain`.
- Banned: corner brackets, a left accent rail, and `backdrop-filter`.
- If the image fires an `error` event, the card switches to `--source` and the toggle is hidden.

## Edge Cases

- **Unterminated fence at seal:** smd closes it at `parser_end`. If the source does not parse, the block stays code.
- **Missing `xmlns`:** injected by `themeSvgSource`, so the `<img>` renders.
- **Unknown `var(--x)`:** the fallback is used, otherwise `fg`. `currentColor` resolves to the injected root `color`.
- **Prolog before `<svg>` (e.g. `<?xml …?>`, comments):** DOMParser accepts it, and the root regex targets the first `<svg` tag.
- **External images, fonts, or CSS in the SVG:** blocked by the `<img>` mode, which renders without them. Text uses system fonts.
- **`<script>` / `on*` / `<foreignObject>`:** inert inside `<img>`. The source pane shows them as escaped code.
- **Copy:** copies the original source, not the themed one, so it stays portable.
- **Multiple fences in one row:** indexed in document order, one label each.
- **Remote (ssh) harness:** identical behaviour; `data:` needs no filesystem access.
- **Annotations:** offsets cover only code text, never the toolbar (`SKIP_WRAP`).
- **Background-lane seal (branch B):** not decorated offscreen; the first visible render decorates it with the then-current palette.
- **Clipboard failure:** `flashChip('copy failed: …')`.

## Open Questions

None.

## Out of Scope

- Lane-mail bodies, peek-thought cards, Live Assist, and the legacy ACP/agent views. Their fences stay code.
- Mermaid or other diagram fences.
- Saving SVG to disk, and stepping between SVG cards with `n`/`p` in the viewer.
- A config switch for the guidance line.
- The existing gap where marked passes raw inline HTML (`<img onerror>`, raw `<svg>`) into transcript DOM on cold-load paths. That is a separate security fix.

## Resources

- [SVG 2 — Conformance: processing modes](https://svgwg.org/svg2-draft/conform.html): `<img>`/CSS-image SVG uses secure animated mode (no script, no external refs, no interaction).
- [Obsidian SVG Viewer plugin](https://github.com/konstantinosGkilas/Obsidian-SVG-Viewer): fence → preview UX, source toggle, copy, sanitize list.
- [GitHub Docs — Creating diagrams](https://docs.github.com/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams): precedent for rendering fenced diagram languages.
- OMP `omp/18.8.6` bundle (`~/.bun/bin/omp`), `packages/tui/src/chat/svg-figure.ts` plus CHANGELOG 18.7.0/18.8.0: palette contract, theming and `xmlns` injection, ACP exclusion of the guidance.
- `node_modules/streaming-markdown/smd.js`, `node_modules/marked-highlight/src/index.js`, `node_modules/highlight.js/lib/languages/xml.js`: fence DOM shape per producer.
