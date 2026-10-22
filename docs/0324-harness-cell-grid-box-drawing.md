# Harness Cell-Grid Box Drawing — Implementation Spec

> Status: Implemented (approved by the user, 2026-10-22: "Let create spec and start implmeent")
> Date: 2026-10-22
> Milestone: ACP Harness — transcript
> Builds on: 0117 (streaming-markdown seal) · 0301/0302 (component kernel, AGENTS.md constraint 10) · 0004 "WebKit Shapes Each Text Node Alone"

## Problem

ASCII diagrams in an assistant reply (`╭──╮`, `├──`, `┌─┬─┐`) render broken in harness code blocks. The configured font (`Share Tech Mono`) has no glyphs for U+2500–U+257F, so macOS draws each box character with Menlo. Menlo's cell is 0.602em wide, while the font's ASCII cell is 0.54em.

- A 49-column box's border row ends about 46px to the right of its content rows.
- The row height grows past `line-height`, because `pre` (UA `monospace`) and `code` (user font) disagree on line metrics.
- Menlo's `│` is shorter than the line box, so vertical lines show gaps.

All-ASCII frames (`+----+`, `| … |`) around Thai text drift in the same way. The font has no Thai glyphs either, so each row's border lands wherever that row's Thai, drawn by a proportional fallback font, pushed it. The agent's padding was correct in terminal cells.

## Solution

When a code block in an assistant reply is laid out by character columns, render that block on a character-cell grid. A block counts as laid out by columns when either is true:

- it contains a box-drawing (U+2500–U+257F) or block-element (U+2580–U+259F) character;
- a line has non-ASCII text followed by two or more spaces and more text. That is padding meant to line up whatever comes after it (an ASCII frame, a table, aligned comments).

The grid works like this:

- Every character occupies a fixed number of cells.
- Box characters are drawn by CSS gradients inside their cell instead of by a font glyph.

Terminals do the same (xterm.js `customGlyphs`, kitty, WezTerm). The cell geometry is pure CSS: `ch` and `lh`, rounded to device pixels with `round()`. Font, size and display-scale changes therefore reflow without JavaScript. The transform runs while the reply streams, so sealing the row changes nothing.

## Research

- **Root cause (CDP `CSS.getPlatformFontsForNode`, app font stack, 16px):**
  - `a` → Share Tech Mono, 8.64px (0.54em);
  - `─ │ ╭` → Menlo, 9.63px (0.602em);
  - `▶` → Bai Jamjuree, 10.88px.
- **Prototype measured in WKWebView** (Swift; the app's engine) **and Chromium** (DPR 1 and 2):
  - Matrix: 3 font stacks × sizes 13/16/20 × line-height 1.0/1.28/1.6.
  - Fixtures: five, including the misrendered box.
  - Checks: ~12,400 pixel probes per variant, one at every cell boundary.

  | Variant (WebKit) | Max column offset | Row pitch error | Failing probes |
  |---|---|---|---|
  | Current rendering | 221px | 4.6px | 945 / 10,125 |
  | Cells only | 0 | 4.6px | 1,682 / 12,393 |
  | + `code` as block, rounded line-height | 0 | 0.016px | 444 |
  | + device-pixel cell/stroke snapping | 0 | 0 | 0 |
  | + 0.5px overdraw at cell edges | 0 | 0 | 0 (also 0 in Chromium DPR 1 and 2) |

  Cells whose origins sit at fractional pixels are snapped one by one, which leaves 1-device-px seams. Snapping alone still left 1,635 seams in Chromium at DPR 2. Both the snapping and the overdraw are required.
- **Streaming:** 25 random chunkings × 5 fixtures produced cell positions identical to a one-shot render, and `parser_end` detached no node in either engine. The `marked` + highlight.js path gives identical positions with the cells nested inside the highlight spans. Selecting the code block returns the source text exactly.
- **CSS support:** `round(nearest, 1ch, 0.5px)`, `lh` inside `line-height` (it refers to the parent), and a step that changes with `@media (min-resolution: …)` were all verified in WKWebView (macOS 27) and Chromium at DPR 1, 2 and 3.
- **Render paths that produce assistant markdown:**
  - streaming `AssistantRow.openParser` (`makeSafeRenderer`);
  - the seal-time table fallback (`rerenderAssistantMarkdownWithMarked`);
  - `AssistantRow.paintSealed` (`md.parse`);
  - `captureAssistantMarkdownOffscreen` (`acp-harness-view.ts`).

  The SVG, Mermaid and GenUI decorators read `code.textContent`, which the grid leaves unchanged.
- **Annotations:** `transcript-annotation.ts::wrapRange` falls back to `extractContents()` when a quote crosses elements. Across cells that clones half-cells, each still carrying its full width, so the change handles grid ranges per text node instead.
- **Ruled out:**
  - **A `size-adjust` fallback font:** fixes widths only, and the vertical gaps grow.
  - **Changing the user font:** affects one machine and the whole app.
  - **Asking agents not to draw diagrams:** Krypton cannot control agent or tool output.
  - **An xterm.js instance per block:** too heavy for transcript rows.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| xterm.js | `customGlyphs` (default `true`) draws box-drawing and block elements itself "instead of using the font", for "continuous lines, even when line height and letter spacing is used" | Canvas/WebGL renderers only; Krypton terminals already get it |
| VS Code | Terminal custom glyphs via xterm.js | Editor and markdown preview use font glyphs |
| WezTerm | `custom_block_glyphs = true` (default) computes U+2500, U+2580, legacy computing, Braille and Powerline glyphs | Per-terminal option |
| kitty | Draws box-drawing characters itself; `box_drawing_scale 0.001, 1, 1.5, 2` sets the line widths | Not font-dependent |

**Krypton delta:** the terminal convention applied to DOM markdown. It covers only blocks laid out by columns: box or block characters, or non-ASCII text padded to line up what follows. The text stays the original characters, so selection, copy, search and annotations see the source.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/cell-grid.ts` | **New.** Width table, glyph geometry tables, `CellGridWriter`, `gridifyCodeBlocks`, generated per-glyph rules |
| `src/acp/cell-grid.css` | **New.** Grid geometry and cell rules, `@layer krypton.base` |
| `src/acp/cell-grid.test.ts` | **New.** Structure, streaming equivalence, coverage, annotations |
| `src/acp/harness-markdown.ts` | `makeSafeRenderer(root, { cellGrid })` routes fenced-code text to a writer |
| `src/acp/components/assistant-row/index.ts` | Grid on in `openParser`; `gridifyCodeBlocks` after the table fallback and in `paintSealed` |
| `src/acp/components/assistant-row/assistant-row.test.ts` | A streamed diagram keeps its nodes through seal |
| `src/acp/acp-harness-view.ts` | Offscreen capture uses the grid renderer and grids the `marked` fallback |
| `src/acp/transcript-annotation.ts` | A quote touching a grid cell is marked per text node |
| `src/acp/components/execution-dialog/index.ts`, `execution-dialog.css` | Execution Inspector (spec 319) Output text parts laid out by columns sit on the grid in a `pre > code`. Appended output keeps streaming into the same writer, and plain output that turns column-laid-out mid-run is converted once (rev 4) |
| Docs | 0004 (module list, platform gotcha), 0072 (transcript features, Execution Inspector), 0319, `README.md` index |

## Design

### DOM

```html
<pre><code class="acp-cellgrid">
  <span class="acp-cellgrid__cell acp-cellgrid__cell--box acp-cellgrid__cell--u256d">╭</span>
  <span class="acp-cellgrid__cell acp-cellgrid__cell--box acp-cellgrid__cell--u2500" style="--acp-cg-n: 47">──…</span>
  <span class="acp-cellgrid__cell acp-cellgrid__cell--glyph">▶</span>
  <span class="acp-cellgrid__cell acp-cellgrid__cell--run" style="--acp-cg-n: 45"> run full ci …</span>
  ↵ (plain text node)
</code></pre>
```

| Cell kind | Content | Width (cells) |
|---|---|---|
| `--run` | A maximal run of printable ASCII | Its length |
| `--glyph` | One other grapheme | `cellCols()`: the sum of its code points as `wcswidth` counts them. East Asian Wide/Fullwidth (Unicode 16.0, 86 ranges) is 2; `\p{Mn}\p{Me}\p{Cf}` and Hangul conjoining vowels/finals are 0; everything else, including ambiguous and spacing marks, is 1. An emoji ZWJ or VS16 sequence is 2. So `กำ` is one grapheme (U+0E33 SARA AM is a SpacingMark) but two cells |
| `--tab` | `\t` | To the next multiple of 8 |
| `--box` | One box/block character. Identical horizontal-only characters (`─━═┄┅┈┉╌╍`) merge into one cell | 1 each |

- A stream chunk that starts inside a grapheme (a Thai mark or SARA AM, an emoji ZWJ tail) extends the previous grapheme's cell and `Text` node instead of opening a new one. The cluster never splits across nodes (the 0004 WebKit gotcha), and the streamed DOM equals the one-shot DOM.
- Newlines stay plain text nodes.

### Geometry (CSS only)

| Property | Value |
|---|---|
| `--acp-cg-step` | `1px`, `0.5px` at ≥ 2dppx, `1px/3` at ≥ 3dppx |
| Cell width `--acp-cg-w` | `round(nearest, 1ch, step)` |
| `line-height` on `.acp-cellgrid` (`display: block`) | `round(nearest, 1lh, step)`; the block `code` owns its strut |
| Stroke centres `--acp-cg-cx`, `--acp-cg-cy` | Rounded so a 1px stroke starts on a device pixel |
| Double-line offset `--acp-cg-g` | `max(1.5px, round(0.2 × width))` |
| ASCII runs | `letter-spacing: width − 1ch` |
| Box cells | `-webkit-text-fill-color: transparent`; strokes on a `::before` inset by −0.5px (overdraw) |

`--acp-cg-w`, `--acp-cg-cx`, `--acp-cg-cy` and `--acp-cg-g` are registered with `@property` as `<length>`. They compute once on the block, and cells inherit plain pixels.

### Glyph drawing

Per-glyph rules (`.acp-cellgrid__cell--u<hex>`) are generated from the tables and injected once per document as a `<style>` in `@layer krypton.base`.

| Glyph group | How it is drawn |
|---|---|
| Light/heavy lines | Arms (up/right/down/left) at 1px/2px |
| Double lines | The outline of the union of the double-arm channels |
| `╭╮╯╰` | A rounded `::after` border |
| Dashes | Repeating gradients |
| `╱╲╳` | Diagonal gradients |
| Block elements | Fractional fills; shades use `color-mix` |

All strokes use `currentColor`, so highlight colours and themes apply unchanged.

### Data Flow

```
1. AssistantRow streams: smd add_text for a fenced <code> → CellGridWriter.write().
   Plain mode appends to the trailing Text node exactly as makeSafeRenderer does.
2. The first box character in that block: convert the block's existing text once (the row is
   live), then emit cells. Runs and merged lines extend in place across chunks.
3. Seal: parser_end flushes the held-back character into the same writer; no node is replaced.
   captureMarkdown() caches the grid HTML in item.markdownHtml.
4. Table fallback at seal (existing marked re-render) → gridifyCodeBlocks(body) before capture.
5. Sealed mount: body.innerHTML = cache → gridifyCodeBlocks skips gridded blocks; a fresh
   md.parse is gridded and re-cached before decorations.
6. Offscreen capture: smd with { cellGrid: true }; marked fallback → gridifyCodeBlocks.
```

## Edge Cases

- **Code not laid out by columns, and inline code:** untouched. That includes Thai only at a line's end, such as a trailing comment, and non-ASCII followed by a single space.
- **A block whose first lines are plain ASCII** (a frame's `+----+` top border): stays plain until the first padded line arrives, then converts once while the row is still live.
- **SVG, Mermaid and GenUI fences:** `textContent` is unchanged, so the decorators behave as before.
- **Thai or other narrow fallback glyphs:** forced into one centred cell each. The grid holds, but a glyph wider than the cell looks tighter, as in a terminal.
- **Proportional ASCII font:** run boxes keep the grid at run edges, while text inside a run drifts within its box.
- **Font, size or display-scale change:** `ch`, `lh` and the resolution query reflow the grid with no repaint code.
- **Cached HTML from before this change:** gridded on mount (step 5).
- **A grapheme split across stream chunks:** joined back into the previous cell, with its width recounted.
- **Annotation across cells:** one `<mark>` per text node. Cells are never split.

## Out of Scope

- Live Assist, thought, user, inter-lane and peek rows.
- Tool output in transcript rows, Agent view and Markdown viewer. The Execution Inspector's Output section is in scope (rev 4).
- Symbols for Legacy Computing, Braille and Powerline glyphs.
- Any config option.

## Implementation Notes

Where the shipped code differs from the draft, and why:

- **Registered geometry properties.** Unregistered custom properties are token streams, so every cell re-ran the `round(…1ch…)` expressions. Registering the four geometry properties computes them once on the block. In WebKit, layout of a 200-row diagram went from 137ms to 105ms. Pixel results did not change.
- **Grapheme segmentation reuses `graphemeUnits`** (`harness-composer-bloom.ts`), which already shims `Intl.Segmenter` for the ES2021 TypeScript lib.
- **Merged horizontal lines** draw from edge to edge with `100%` sizes. Single-cell and merged cells share one rule per glyph, and a run of `─` is one span. The 200-row table went from 12,800 to 5,800 spans.
- **Grapheme width is the sum of its code points (rev 2, 2026-10-22).**
  - The first build counted a grapheme by its first code point.
  - The user's screenshot of a rebuilt app showed two diagram rows one cell short. Those rows were exactly the ones containing `กำ`/`ทำ`, taken from the reply's own text in the session log.
  - `Intl.Segmenter` groups U+0E33 SARA AM with its base, but terminals and agents padding a diagram count it as a cell.
  - A chunk split inside a grapheme now rejoins the previous cell. The emoji ZWJ case that used to become its own cell is joined too.
- **Padded non-ASCII text also triggers the grid (rev 3, 2026-10-22).**
  - The user's next screenshot showed an all-ASCII `+---+`/`|` frame around Thai text with every right border at a different x.
  - The session log showed all 17 rows padded to exactly 62 cells by `wcswidth`. With no box character the block was never gridded, so each row's Thai, drawn by a proportional fallback, moved its border.
  - The trigger is now a box/block character **or** non-ASCII text followed by two or more spaces and more text on the same line (`PADDED_AFTER_NON_ASCII_RE`).
  - In streaming plain mode, the writer tests the lines each chunk completes plus the unfinished line it carries over, so a frame whose first padded line arrives late still converts.
  - Code with Thai only at a line's end stays plain, so ordinary Thai comments keep their natural rendering.
- **Execution Inspector output (rev 4, 2026-10-22).**
  - The user asked for the same fix in the spec 319 Inspector, whose Output section showed the same drifting frame from a Python cell.
  - A text part that `needsCellGrid` renders as `pre.acp-execution-dialog__text > code.acp-cellgrid`. The `code` takes the `pre`'s font (`font: inherit`) and rounds its line height.
  - Spec 315's append-preserving update writes only the new tail through the part's `CellGridWriter`.
  - A plain part whose appended text first makes it column-laid-out is converted once.
  - Plain output keeps its single `Text` node, so the existing selection-preservation behavior is unchanged.
  - The Code section is not gridded: its line-number gutter is a separate `pre`, and a rounded line height there would drift against the numbers.

**Verified:**

- **Unit tests** (`cell-grid.test.ts`, happy-dom):
  - code that is not laid out by columns stays plain, including Thai at a line's end and non-ASCII followed by a single space;
  - an all-ASCII frame padded after Thai text is gridded with every row 16 cells wide, and 30 random chunkings (the trigger arrives on line 2) equal the one-shot DOM;
  - exact cell layout (runs, merged lines, wide and Thai graphemes) with the source text kept;
  - 30 random stream chunkings plus cuts inside a Thai cluster and before SARA AM, all identical to the one-shot DOM;
  - a combining mark stays in its base's text node;
  - `กำ`/`ทำ` take two cells, so a row padded the way agents pad stays aligned;
  - the `marked` path stays inside highlight spans and is idempotent;
  - every code point U+2500–U+259F has drawing geometry;
  - an annotation across cells leaves every cell intact. This test fails without the `wrapRange` change.
- **`assistant-row.test.ts`:** a streamed diagram seals without any node being replaced or detached, and a never-streamed reply caches the gridded HTML.
- **Real module rendered by the real harness CSS:** WKWebView (Swift, 2x) and Chromium (DPR 1 and 2), 27 configurations each (3 font stacks × 13/16/20px × line-height 1.0/1.28/1.6), 5 fixtures, streamed in random chunks. Results:
  - 0 of 12,393 cell-boundary pixel probes failing in every engine/DPR;
  - column offset 0 and row pitch error 0;
  - every block gridded;
  - selection text equal to the source in every block.
- **WebKit cost** (fresh process, 40-character chunks, layout forced after each):

  | Diagram | Gridded per chunk | Plain text per chunk |
  |---|---|---|
  | 40 rows | p50 1ms, max 3ms | 0–1ms |
  | 200 rows | p50 5ms, p95 13ms, max 16ms | 1–2ms |

  The whole code block re-lays out on each append, so the cost grows with block size.
- **The reported reply, re-rendered after rev 2.** Its three fences were taken from the session log and rendered in WKWebView by the real module with the user's font stack. Every row of the correctly padded box ends at the same x (383px), as does every table row (349px). The `len()`-padded box stays ragged because its source text is.
- **The reported ASCII frame, re-rendered after rev 3.** It was taken from the session log and rendered in WKWebView with the user's font stack, streamed in random chunks.
  - Plain (the old path): row right edges spread from 559px to 577px.
  - Gridded: all 17 rows end at 553px, and the table columns line up.
- **The reported Inspector output, re-rendered after rev 4.** The Python cell's output was taken from the session log and fed to the real `ExecutionDialog` in WKWebView, 40 characters per update, with the user's font stack. All 20 frame rows end at 482px, and the region's text equals the output.
- **`execution-dialog.test.ts`:** plain output becomes gridded once column padding arrives, and later appends keep the same `code` and cells.
- **Not exercised:** the in-app path in a rebuilt Krypton (live lane turn → seal → remount, live Inspector) after revs 2–4.

## Resources

- [xterm.js `ITerminalOptions.customGlyphs`](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/): the terminal convention and the rationale behind it (continuous lines with line-height).
- [xterm.js typings 6.0.0](https://github.com/xtermjs/xterm.js/blob/6.0.0/typings/xterm.d.ts): the default `true` and the scope (box drawing and block elements).
- [WezTerm `custom_block_glyphs`](https://wezterm.org/config/lua/config/custom_block_glyphs.html): the default-on choice and the Unicode blocks to cover.
- [kitty.conf `box_drawing_scale`](https://manpages.debian.org/testing/kitty/kitty.conf.5.en.html): self-drawn box lines with light/heavy widths.
- [VS Code issue #286021, "Test: Terminal custom glyphs"](https://github.com/microsoft/vscode/issues/286021): custom glyphs shipped in a mainstream editor terminal.
