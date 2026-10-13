# ACP Harness SVG Fence Preview — Implementation Spec

> Status: Implemented
> Date: 2026-10-09
> Milestone: ACP Harness

## Revision 2 — Progressive Streaming Preview

> Status: Implemented
> Date: 2026-10-11

### Problem

A ```` ```svg ```` fence shows only `svg · drawing…` until the whole reply seals. OMP's TUI and Tern draw the figure as it streams, element by element. Krypton should do the same.

### Research

- **OMP 18.8.9** (`packages/tui/src/chat/svg-source.ts`, function `RVo`; `svg-figure.ts`, class `$ce`): the source streamed so far is cut at the end of the last complete tag, and a dangling `&entity` is dropped. Open elements are tracked on a stack (`<x>` pushes, `</x>` pops, `<x/>` and `<!…>`/`<?…?>` don't), then closed in reverse order. Quotes, comments and CDATA are skipped. The result is `null` until `<svg` has been seen. Re-rasterization is throttled to 200ms (`Uwl = 200`), and the closing fence renders immediately. Text after the last tag is kept, so `<text>` content appears letter by letter.
- **Tern**: under the Tern Surface Protocol, omp sends the reply as one `md` node with `stream: true` plus `["text", id, "append", delta]` ops. Tern draws the fence natively with usvg/resvg. Its changelog says: "drawing in as the reply streams".
- **The three reasons Krypton rejected this originally** (*Streaming* below), and how this revision answers each:
  1. *smd holds live refs to `pre`/`code`.* smd's default renderer only `appendChild`s into `data.nodes[data.index]` (`smd.js:1544-1618`). A **sibling** inserted *before* the `pre` is never touched, and later blocks still append after it. The `pre` is not wrapped or moved.
  2. *A 200ms re-encode/decode loop vs the spec 114 budget.* Work runs only for the foreground row's parser-owned body; background lanes have no parser. Per tick the cost is one linear pass each for the close, the theming and `encodeURIComponent`, all capped by `SVG_FENCE_MAX_CHARS`. The tick is skipped when the closed prefix hasn't changed, which is most deltas because they land inside an unfinished tag. Decode runs off-DOM through `HTMLImageElement.decode()`, which is async, so `DOMParser` is not used per tick.
  3. *A sealed row is rebuilt from cache anyway.* The live preview is ephemeral and never cached. At seal it is removed before `markdownHtml` is captured, and the existing card takes its place.

### Design

```ts
// harness-svg-fence.ts
export const SVG_LIVE_INTERVAL_MS = 200;               // OMP parity
export function closeSvgPrefix(source: string): string | null; // port of OMP RVo
export function updateLiveSvgFences(body: HTMLElement): void;  // after each parser_write
export function clearLiveSvgFences(body: HTMLElement): void;   // at seal, before capture
```

1. `updateStreamingAssistantMarkdownBody` calls `updateLiveSvgFences(body)` after `parser_write`. Only the smd form `pre > code.svg` is scanned, since live bodies are always smd.
2. Each fence has state in a `WeakMap<HTMLElement /*code*/, LiveSvg>`: the preview node, the last themed string, the last paint time, and a trailing timer. Within `SVG_LIVE_INTERVAL_MS` of the last paint, a single trailing `setTimeout` is armed. If the stream pauses mid-figure, the latest prefix still paints. The callback bails if `code.isConnected` is false or the body has lost `--stream-live`.
3. A tick computes `closeSvgPrefix(code.textContent)`. It skips when the result is `null`, over the cap, or the same as the last themed output. Otherwise it themes through the existing `themeSvgSource`, with the palette read per tick so a mid-stream theme switch heals. Then it does `probe = new Image(); probe.src = url; await probe.decode()`. If this is still the latest request, the visible `<img>` gets the URL and the `svgFrame` aspect ratio. A decode failure keeps the last good frame.
4. DOM: inserted before the fence's `pre` on the first successful frame:
   ```html
   <figure class="acp-harness__svg-card acp-harness__svg-card--live">
     <div class="acp-harness__svg-card-bar"><span class="acp-harness__svg-card-kind">svg · drawing…</span></div>
     <div class="acp-harness__svg-card-preview"><img alt="SVG preview (drawing)"></div>
   </figure>
   ```
   It reuses the card frame, so seal swaps the toolbar contents in place instead of jumping layout. `.acp-harness__svg-card--live + pre` is hidden, so the CSS placeholder only shows until the first frame. The live `<img>` carries no `data-svg-*`, so clicks, `f` hints and `refreshSvgFencePreviews` (which needs a `pre` child) ignore it. The kind label pulses opacity-only, with no animation under `prefers-reduced-motion`.
5. Seal branch A: right after removing `--stream-live`, `clearLiveSvgFences(body)` removes every `--live` card. Then `markdownHtml` is captured and `decorateSvgFences` builds the real card. For a complete document, `closeSvgPrefix` returns the source unchanged, so the card's data URL usually equals the last live frame and WebKit reuses the decoded image.

### Edge Cases

- **Several fences in one reply:** each `code` has its own state. Closed ones stop changing and stop repainting.
- **Body rebind / backtrack** (`initLaneStreamingMarkdown` → `replaceChildren`): the old previews and `code` nodes are dropped, the WeakMap entries are collected, pending timers bail on `isConnected`, and the fresh parse rebuilds the previews.
- **Over `SVG_FENCE_MAX_CHARS` mid-stream:** the live card is removed and the placeholder returns. The seal behaviour is unchanged.
- **Invalid final SVG:** the live card shows the last good frame until seal. Seal removes it, and `decorateSvgFences` leaves plain code as today.
- **Security:** unchanged. The preview is still an `<img>` data URL in secure animated mode, and the partial markup is never inserted as DOM.
- **Lane switched away mid-decode** (body detached): the frame is dropped and the fence's cached text is reset. The next tick on the re-attached body repaints it instead of skipping text that hasn't changed.
- **No layout shift at seal:** the live `svg · drawing…` label gets the same padding and border as a toolbar button. The live and sealed `<img>` therefore sit at identical coordinates, which was checked in a browser smoke run.

### Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-svg-fence.ts` | `closeSvgPrefix`, `updateLiveSvgFences`, `clearLiveSvgFences`, `SVG_LIVE_INTERVAL_MS` |
| `src/acp/harness-markdown.ts` | `updateStreamingAssistantMarkdownBody` calls `updateLiveSvgFences` after `parser_write` |
| `src/acp/acp-harness-view.ts` | Seal branch A calls `clearLiveSvgFences` before the `markdownHtml` capture |
| `src/styles/acp-harness.css` | `--live` card label pulse; hide the placeholder `pre` after a live card |
| `src/acp/harness-svg-fence.test.ts` | `closeSvgPrefix`: truncation at an open tag/attribute/entity, stack close order, self-closing, comments/CDATA/quoted `>`, `null` before `<svg`, identity on a complete document |
| this spec, `docs/0072-acp-harness-view.md` | The *Streaming* section and data-flow step 1 rewritten to match |

### Out of Scope

- A config switch to disable live preview.
- Live preview for Mermaid, peek-thought, lane mail or Live Assist.
- Rendering in a worker or with OffscreenCanvas.

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

Each card is a new target type in the existing `f` open-hint mode: `<label>` zooms the preview in the image viewer (or returns a Source card to Preview), `Shift+<label>` copies the source. While streaming, a fence draws in progressively as a non-interactive live card (Revision 2); the interactive card appears at seal. This is frontend only.

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
  4. Progressive render while streaming (OMP-style): rejected originally, adopted in Revision 2 (see *Streaming* below).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| OMP TUI (18.7+) | ` ```svg ` themed through `var(--…)` palette → native raster PNG → terminal graphics; progressive while streaming; source fallback | Guidance and rendering only in the main TUI, not ACP |
| Obsidian (SVG Viewer plugin) | DOMParser-sanitized inline SVG; click toggles source; hover copy button | Mouse only |
| GitHub | Renders `mermaid`/`geojson`/`topojson`/`stl` fences in a sandboxed iframe; `svg` stays code | Fence → preview pattern exists |
| Review Board (Krypton) | Inline SVG through the `sanitizeSvg` allowlist | Lane-authored charts of known shape |
| Image strip (Krypton, spec 281) | Rejects `image/svg+xml` bytes by sniffing | SVG stays out of the blob/viewer pipeline |

**Krypton delta:** uses OMP's palette contract and theming so SVG is portable across both hosts. Uses Obsidian's UX (preview default, source toggle, copy), driven through `f` hints. Safety comes from the `<img>` processing mode rather than a sanitizer. Like OMP, the figure draws in progressively while streaming (Revision 2), at the same 200ms cadence.

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
| `docs/0072-acp-harness-view.md`, `docs/0206-assistant-response-resources.md`, `docs/README.md` | Card, hint target, guidance line |

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
export function readSvgFontFamily(): string; // --agent-font → --krypton-font-family
export function themeSvgSource(source: string, palette: SvgPalette, fontFamily: string): string;
export function decorateSvgFences(body: HTMLElement, item: HarnessTranscriptItem): void;
export function refreshSvgFencePreviews(root: ParentNode): void;
```

`themeSvgSource` replaces `var(--name[, fallback])` with `palette[name]`, then the fallback, then `palette.fg`. On the root `<svg …>` tag, each attribute below is added only when absent: `color="<fg>"`, `xmlns`, and `xmlns:xlink` when the source uses `xlink:`.

Text always uses the harness transcript font. `readSvgFontFamily` resolves it the same way `acp-harness.css` does: `--agent-font`, then `--krypton-font-family` (the `[font] family` list from `krypton.toml`), then `ui-monospace, SFMono-Regular, Menlo, monospace`. `themeSvgSource` injects `<style>*{font-family:<font>!important}</style>` as the first child of the root (XML-escaped; skipped for a self-closing root). The `!important` author rule beats font-family attributes and plain inline styles, so an agent's own `font-family` never wins. The configured families are installed fonts, which an `<img>` SVG can use; only web fonts are blocked. Reload Config runs `applyConfig` (which sets `--krypton-font-family`) before `updateTerminalThemes` → `refreshSvgFencePreviews`, so visible cards pick up a font change in place.

`decorateSvgFences` is idempotent: it skips any `pre` already inside a card. For each `pre > code` whose classList has `svg` or `language-svg`:

1. `source = code.textContent` minus one trailing `\n`. If it is over `SVG_FENCE_MAX_BYTES`, the block stays code.
2. `themed = themeSvgSource(source, readSvgPalette(), readSvgFontFamily())`.
3. `DOMParser().parseFromString(themed, 'image/svg+xml')`. If the root is not `<svg>` or the result contains a `parsererror`, the block stays code. This is validation only and nothing parsed is inserted. Read the aspect ratio from `viewBox`, or from numeric `width`/`height`.
4. Wrap the existing `<pre>` in the card. The `<pre>` is kept, so the source pane and its highlighting are exactly as rendered. Set `img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(themed)`.
5. Rebuild `item.svgFences` with one entry per card, carrying `showSource`/`hintLabel` over from the previous entry with the same `index`. Apply `--source` and the hint badge.

`refreshSvgFencePreviews` re-themes every `.acp-harness__svg-card img` under `root` from its card's `<pre>` source. It is used on theme change and does not rebuild rows.

### Guidance line

`SVG_FENCE_GUIDANCE` is pushed in `renderLanePolicy` for every lane and backend, in both the memory-available and memory-unavailable branches. Spec 292 adds a sibling `VISUAL_FENCE_GUIDANCE` line after it; this SVG string is unchanged.

> SVG figures: when a diagram, chart, or UI mockup explains something better than prose, you may include it as a ```svg fenced block — Krypton renders it inline as an image (the user can toggle to source). Keep it self-contained: scripts, external images, and web fonts are blocked. Give the root a viewBox. Use theme colors via var(--fg), var(--muted), var(--border), var(--accent), var(--success), var(--warning), var(--error), var(--surface), var(--c1)…var(--c6), optionally with a fallback such as var(--accent, #0cf).

### Streaming

Revision 2 replaced the seal-only rule: a fence now draws in while the reply streams. *Revision 2* at the top of this spec has the design. The original seal-only reasoning is kept below for history, with each point answered there.

- ~~smd keeps live references to the `pre`/`code` nodes until `parser_end`, so it cannot wrap them mid-stream.~~ The live card is a sibling inserted before the `pre`, which smd never touches.
- ~~A 200ms re-encode and decode loop on the main thread works against the harness streaming budget (spec 114).~~ This only runs for the foreground row. A tick is skipped when the fence text or the closed prefix hasn't changed, and decoding is async through `img.decode()`.
- A sealed row is rebuilt from cache anyway. That still holds: live cards are removed before the capture.

The placeholder is CSS only. `initLaneStreamingMarkdown` adds `acp-harness__msg-body--stream-live` to the parser-owned body, and `sealAssistantStreamingMarkdown` branch A removes it right after `parser_end`. While the class is present, `pre:has(> code.svg)` hides its `<code>` with `display: none`, so smd still writes into the hidden node but the text never reaches layout. The `pre` shows a pulsing `::before` label until the fence's first live frame decodes. From then on, `.acp-harness__svg-card--live + pre` is hidden and the live card stands in for it. Its `svg · drawing…` label pulses too, and its box matches a toolbar button so the swap at seal doesn't shift the figure. Both pulses are opacity-only and are disabled under `prefers-reduced-motion`. Once the class is gone, `clearLiveSvgFences` removes the live cards. A valid fence then becomes a card and an invalid one shows as plain code. The persistent `--stream-markdown` class cannot carry this state because it stays on the body after seal.

### Data Flow

```
0. Each turn: renderPromptMemoryPacket includes SVG_FENCE_GUIDANCE
1. Agent streams a ```svg fence → body has --stream-live → updateStreamingAssistantMarkdownBody
   → parser_write → updateLiveSvgFences: ≤ every 200ms (plus a trailing tick),
   closeSvgPrefix → themeSvgSource → off-DOM decode → live card before the <pre>
   (the "svg · drawing…" CSS placeholder shows only until the first frame)
2. Seal branch A: parser_end → drop --stream-live → clearLiveSvgFences → cache
   markdownHtml (pure) → decorateSvgFences(live body) → scan → rail [decoration never cached]
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

- Card: full 1px `--krypton-border-color` border, transparent background, `width: fit-content; max-width: 100%`, so the card wraps the figure instead of spanning the lane. The `--source` and `--broken` states use `width: auto` so long source lines keep the full lane width. The streaming `svg · drawing…` placeholder spans the lane, so the card narrows to the figure when its first live frame replaces it.
- Toolbar: muted mono label style.
- Preview pane: no fixed height cap; the image uses `max-width: 100%`, `height: auto`, and `object-fit: contain` to preserve its aspect ratio. `svgFrame(source, devicePixelRatio)` sets the `<img>` width to the figure's own size — explicit `width`, else `viewBox` units as CSS px (same base as the zoom viewer's 100%) — fitted inside Full HD measured in **device pixels** (1920×1080 physical, aspect kept): 960×540 CSS px on a 2× Retina screen, 1920×1080 CSS px at 1×. A figure under the cap shows at its own size; `max-width: 100%` scales any figure down in narrower lanes. A root with neither `width` nor `viewBox` gets no width attribute and renders at the browser default (300×150). The ratio is read when the preview is set (card build, live frame, theme refresh); moving the window to a display with a different scale keeps existing cards at their old width until the next re-theme.
- Banned: corner brackets, a left accent rail, and `backdrop-filter`.
- If the image fires an `error` event, the card switches to `--source` and the toggle is hidden.

## Edge Cases

- **Unterminated fence at seal:** smd closes it at `parser_end`. If the source does not parse, the block stays code.
- **Missing `xmlns`:** injected by `themeSvgSource`, so the `<img>` renders.
- **Unknown `var(--x)`:** the fallback is used, otherwise `fg`. `currentColor` resolves to the injected root `color`.
- **Prolog before `<svg>` (e.g. `<?xml …?>`, comments):** DOMParser accepts it, and the root regex targets the first `<svg` tag.
- **External images, fonts, or CSS in the SVG:** blocked by the `<img>` mode, which renders without them. Text uses the configured harness font (installed fonts only).
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
