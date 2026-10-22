# Cell Grid for All Output — Implementation Spec

> Status: Implemented (approved by the user, 2026-10-22: "Yes", then "Ok let implmeent")
> Date: 2026-10-22
> Milestone: ACP Harness — transcript
> Builds on: 0324 (cell-grid box drawing) · 0319/0315 (Execution Inspector, append-preserving output) · 0235 (grep tokens) · 0301/0302 (component kernel, AGENTS.md constraint 10)

## Problem

**User request (2026-10-22):** "yes, i want to make it perfect display for all kind of output". In a screenshot, the tool card's OUTPUT section showed a `╭──╮` panel with Thai rows. Every right border landed at a different x, while the same panel in the reply below was aligned.

Spec 324 puts column-laid-out text on a character-cell grid only in assistant-reply code blocks and the Inspector's Output section. Its Out of Scope lists "Tool output in transcript rows, Agent view and Markdown viewer". Everywhere else, Thai and box characters are drawn by fallback fonts, so frames, tables and diagrams drift. The tool card's own `…` cut also makes it worse: it counts UTF-16 code units, not cells.

## Solution

Every block that shows **output** goes through the 324 grid. Output means text from an agent, a tool, a peer lane or a program. The trigger is unchanged (`needsCellGrid`: a box or block character, or non-ASCII text padded by two or more spaces), so plain output keeps rendering exactly as it does today.

Three entry points cover every surface:

- `gridifyCodeBlocks`: markdown surfaces (already exists).
- `gridifyText`: a raw-text block such as `pre` or a `div` holding one text node.
- `gridifyLines`: a block drawn as one element per line, such as diff rows or grep rows.

The tool card's line cut moves from code units to cells.

**Gridded blocks never wrap.** Wrapping a column layout destroys it. A multi-line block scrolls sideways as one unit, as markdown code blocks already do. Single-line rows keep clipping with `…`. Output that the trigger does not catch keeps its current wrapping.

## Research

- **Inventory** (subagent sweep of `src/`, checked against the files): about 25 surfaces show output outside the grid. They fall into three DOM shapes:
  - markdown rendered with `marked`: inter-lane mail, the peek thought, Live Assist, Agent view, Review Board, the AI panels;
  - one raw-text block: the tool section `pre`, the subagent detail, the `!shell` row, the provider-error payload, Agent view tool and shell results, the Hurl response, the Inspector JSON and activity panes;
  - one element per line: `DiffBlock` (`paired`, `unified` and `raw` modes, used by the tool row, FS write review, the directive diff and GenUI `Diff`) and the grep rows (`renderGrepSection`).
- **Tool card text is pre-trimmed** (`harness-tool-render.ts::boundedOutputLines`). It strips ANSI and controls, drops empty lines, trims trailing space, removes the common indent, and keeps 6 lines (12 for `execute`, 80 for `git diff`). Lines over 140 are then cut with `line.slice(0, 139) + '…'`. That cut counts code units, so a Thai row is cut further left than an ASCII row of the same cell width, and it can split a cluster or a surrogate pair.
- **Tool rows rebuild their output** on every deps change (`tool-row/index.ts::paintOutput`, `setChildren`). Gridding inside that rebuild adds no deps and no append path. The deps are still the whole diff (constraint 10).
- **`.acp-cellgrid` assumes a `code` element.** Its rounded `line-height` uses `1lh` of the parent. UA `code` sets `font-family: monospace`, which the Inspector undoes with `> code { font: inherit }` (rev 4). A raw-text block needs that rule built in.
- **Per-line blocks** need every line gridded once any line needs it. Otherwise ASCII rows advance by `1ch` and gridded rows by the rounded `ch`. Rows must also share one rounded line height with no row gap, or vertical lines break between rows. Grep rows have a 3px gap, and diff gutter spans keep an unrounded `1.4`.
- **Ellipsis with cells.** CSS Overflow 3 §6.1: "implementations must hide characters and atomic inline-level elements at the end edge of the line" to fit the ellipsis, and the first one on a line "must be clipped rather than ellipsed". A gridded grep or unified-diff row therefore still ends with `…`, after the last whole cell.
- **Ruled out:**
  - **An xterm.js instance per tool card** (Zed's choice for terminal tool calls): too heavy for transcript rows (324). Tool output arrives already trimmed, not as a PTY stream.
  - **Gridding prose surfaces** (thought, user and question rows, the memory detail): they have no block boundary. A Thai paragraph with a double space would trip the padding trigger, become one line that does not wrap, and scroll.
  - **Moving `cell-grid.ts` to `src/ui/`:** it would rename `acp-cellgrid` and churn 324's tests for no behaviour change. Other modules import it from `src/acp/`, as `review-board` already imports `acp/types`.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed agent panel | ACP `Terminal` tool content is an embedded `TerminalView`, held at `h_72` when expanded (`thread_view.rs:8479`, `:8644-8652`). Other tool content renders as markdown in the agent font (`render_markdown_output`, `:11186`) | The terminal gets a real cell grid. Markdown output does not |
| VS Code chat | Each command's output opens inline with **Show Output**; **Show Terminal** opens the full output in the integrated terminal. `chat.tools.terminal.outputLocation` picks which one | The inline rendering technology is not documented |
| xterm.js / WezTerm / kitty | Box and block glyphs are drawn by the renderer, not the font (324) | Terminal convention |

**Krypton delta:** Zed gives terminal output a real grid and leaves all other output to the font. Krypton uses the 324 grid for every output block, markdown and raw text alike. It is DOM-only, keeps the original characters for copy and selection, and leaves prose wrapping as it is.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/cell-grid.ts` | New `gridifyText`, `gridifyLines`, `CellGridText` (moved out of the Inspector), `sliceCells`, `STREAMING_GRID_MAX_LINES`; `gridifyCodeBlocks` takes `{ maxLines }` |
| `src/acp/cell-grid.css` | `.acp-cellgrid--text` (raw block) and `.acp-cellgrid-lines` (per-line container) rules |
| `src/acp/harness-tool-render.ts` | `boundedOutputLines` cuts at 140 cells. `renderGrepSection` grids its text cells |
| `src/acp/components/tool-row/index.ts`, `tool-row.css` | `plainSection` grids its `pre`. Gridded grep, unified and paired diff rows get a rounded pitch and no gap, and a gridded paired body scrolls as one block |
| `src/acp/components/diff-block/index.ts` | `paired`, `unified` and `raw` grid their text elements after each paint |
| `genui-catalog/data.css` | Rounded row pitch for gridded GenUI diffs (the directive diff needs no rule; see Implementation Notes) |
| `src/acp/components/subagent-card/index.ts` | Detail `pre` gridded |
| `src/acp/components/system-row/index.ts` | `!shell` output body gridded (kind `shell` only) |
| `src/acp/components/provider-error-row/index.ts` | Raw payload `pre` gridded |
| `src/acp/components/inter-lane-row/index.ts` | `gridifyCodeBlocks` after the cached HTML is set at paint |
| `src/acp/harness-markdown.ts` | `renderPeekThoughtMarkdown` grids its output |
| `src/acp/components/genui-catalog/data.ts` | GenUI `Code` body gridded (`Diff` is covered by `DiffBlock`) |
| `src/acp/components/execution-dialog/index.ts` | Uses `CellGridText`. JSON and activity panes gridded too; Code section unchanged |
| `src/acp/live-assist-markdown.ts` | `makeSafeRenderer(body, { cellGrid: true })`, `gridifyCodeBlocks` on the `marked` paths |
| `src/agent/agent-view.ts`, `src/styles/agent.css` | `gridifyCodeBlocks` after each `md.parse` (bounded while streaming); tool result and shell result `gridifyText`; a rounding rule for gridded fences in the unlayered sheet |
| `src/review-board/render.ts` | `renderMarkdown` and `diff-raw` gridded |
| `src/markdown-view-ai.ts`, `src/file-manager-ai.ts`, `src/inline-ai.ts` | `gridifyCodeBlocks` after each `md.parse` (bounded while streaming), and a full pass when the reply ends |
| `src/hurl-view.ts` | Response `pre` gridded (ANSI spans kept, like hljs spans) |
| Tests | `cell-grid.test.ts`, `harness-tool-render.test.ts`, `tool-row.test.ts`, `diff-block` and `inter-lane-row` tests, `execution-dialog.test.ts` (unchanged behaviour) |
| Docs | 0324 (amended-by note, Out of Scope), 0072 (transcript features), 0319, 0004 (module list), `README.md` index |

## Design

### API (`cell-grid.ts`)

```ts
/** The longest prefix of whole graphemes that fits in `maxCols` cells. */
export function sliceCells(text: string, maxCols: number): string;

/** Grid a raw-text block in place when its text needs it: the text moves into
 *  `code.acp-cellgrid.acp-cellgrid--text`. Returns whether it gridded. Idempotent. */
export function gridifyText(host: HTMLElement): boolean;

/** Grid one block drawn as one element per line. If the joined text needs the
 *  grid, every line element gets its own writer and `container` gets
 *  `acp-cellgrid-lines`. Returns whether it gridded. */
export function gridifyLines(container: HTMLElement, lines: readonly HTMLElement[]): boolean;

/** A raw-text block updated over time (the Inspector's text parts). `set` appends
 *  in place when the new text extends the old, converts once when the text first
 *  needs the grid, and rebuilds otherwise. */
export class CellGridText {
  constructor(host: HTMLElement, text: string);
  set(text: string): void;
}
```

### CSS

`cell-grid.css` (`@layer krypton.base`) holds the rules for the grid's own elements:

| Selector | Rule |
|---|---|
| `.acp-cellgrid--text` | `font: inherit; white-space: pre; overflow-x: auto`. It replaces the Inspector's `> code` rule |
| `.acp-cellgrid-lines` | Defines `--acp-cg-step` as `.acp-cellgrid` does |
| `.acp-cellgrid-lines .acp-cellgrid` | `white-space: pre`: a gridded line never wraps |

Row rules go in the sheet that owns the rows (`tool-row.css`, GenUI `data.css`), gated on `.acp-cellgrid-lines`. The rows' `line-height` and `gap` are `krypton.component` declarations, and a `krypton.base` rule cannot override them.

- **Rows:** `line-height: round(nearest, <the row's current line-height>, var(--acp-cg-step))`, and the container drops its `row-gap`. Every row then has the pitch its cells have, and vertical lines join across rows.
- **Paired diff body** (`.acp-harness__tool-body--diff`): scrolls sideways as one block (`overflow-x: auto`, a single `minmax(100%, max-content)` track). Every row takes the widest row's width, so add/del tints reach the end.
- **Grep and unified-diff rows:** keep `overflow: hidden; text-overflow: ellipsis`. Cells past the edge are hidden and the row ends in `…` (CSS Overflow 3 §6.1).

### Surfaces

| Surface | Entry point | Where |
|---|---|---|
| Tool section text (stdout, stderr, output, …) | `gridifyText(pre)` | `plainSection`, inside the deps-gated rebuild |
| Grep section | `gridifyLines(rich, tokTexts)` | `renderGrepSection` |
| `DiffBlock` paired / unified / raw | `gridifyLines(body or el, textEls)` | after each mode's `setChildren` |
| Subagent detail, provider-error payload, `!shell` body | `gridifyText` | each component's paint |
| Inter-lane mail, peek thought (cold), GenUI `Code` | `gridifyCodeBlocks` | after `innerHTML` / when the block is built |
| Live Assist reply | `cellGrid: true` while streaming; `gridifyCodeBlocks` on `marked` paths | `live-assist-markdown.ts` |
| Agent view reply / tool result / shell result | `gridifyCodeBlocks` / `gridifyText` | the three `md.parse` sites, `finalizeToolRow`, `appendShellResultDom` |
| Review Board markdown / raw diff | `gridifyCodeBlocks` / `gridifyText` | `renderMarkdown`, `diff-raw` |
| AI panels (markdown, file manager, inline ask) | `gridifyCodeBlocks` | after each `md.parse`, bounded to 60-line fences while streaming; full pass at the end |
| Hurl response | `gridifyText` | after the `ansiToHtml` `innerHTML` |
| Inspector Output / JSON / activity | `CellGridText` / `gridifyText` | `execution-dialog` |

### Data Flow

```
1. ACP tool update → buildToolPayload → boundedOutputLines cuts lines over 140 cells
   at 139 cells + '…' (sliceCells), so a frame wider than the card is cut on one column.
2. ToolRow.paintOutput (deps changed) → plainSection builds the pre → gridifyText(pre):
   plain output keeps its single Text node; column output becomes cells.
3. Terminal status seals the row. No later paint, so no later grid work (constraint 10).
4. Marked surfaces: innerHTML = md.parse(…) → gridifyCodeBlocks(root). Surfaces that
   re-parse every frame pass { maxLines: 60 } while streaming, then a full pass at the end.
5. Per-line surfaces: rows built → gridifyLines(container, textEls) decides on the
   joined text once per paint.
```

## Edge Cases

- **Plain output:** never gridded. DOM, wrapping and selection are as today.
- **Thai prose with a double space in tool output:** gridded and no longer wraps; it scrolls sideways. The tool card caps lines at 140 cells, so the scroll stays bounded. Other raw surfaces scroll as markdown code blocks do.
- **A per-line block where only some lines need the grid:** every line is gridded, so ASCII rows advance by the same rounded cell.
- **Grep rows from different files:** path and line-number columns size per row, so text aligns across rows only within one file's context block, as today.
- **ANSI in `!shell` output:** not stripped today; ESC stays a zero-width attachment and the visible `[1;37m` stays. Unchanged.
- **Agent view, AI panels, Hurl:** they re-render the whole buffer while streaming, so `gridifyCodeBlocks`/`gridifyText` reruns each time. Cost is proportional to gridded blocks only (verified below).
- **Agent view virtualisation:** saved `innerHTML` holds the cells; restoring it needs no new grid work.
- **Copy, selection, `textContent` readers:** cells hold the original characters, so all of them see the source text.
- **A wide diagram that the tool card truncates at 12 lines:** cut, not misaligned. The full output stays in the Inspector.

## Out of Scope

- Prose surfaces: thought rows, user rows, system rows other than `!shell`, question detail, memory drawer, review-thread preview, GenUI panel source, the permission preview line, peek one-liners, Live Assist non-reply rows.
- File and debug viewers: Markdown viewer, file-manager previews, quick overview, Vault viewer, Context view, OS-browser loopback pages.
- The tool card's line caps, empty-line dropping and ANSI handling in `!shell` rows.
- Drawing Legacy Computing, Braille and Powerline glyphs. They still take their cells, so alignment holds, but the font draws them.
- Any config option.

## Implementation Notes

Where the shipped code differs from the draft, and why:

- **No `textCells`.** `sliceCells` answers both questions `boundedOutputLines` asks: whether a line fits in 140 cells (the slice is the whole line) and where to cut it.
- **`font: inherit` resets `line-height`.** The first WebKit measurement showed a gridded tool section stepping 22.39/22.4px, not on the device-pixel step. `.acp-cellgrid--text` restates `line-height: round(nearest, 1lh, step)` after the shorthand; the pitch became 22.5px.
- **Unlayered sheets.** `agent.css` sets `line-height` on `.agent-view__msg-body--markdown pre code`, which outranks the grid's `krypton.base` rule, so it gains a `code.acp-cellgrid` rule that rounds the same value. The other surface sheets set only fonts and colours on `code`.
- **Rows align to the top.** Gridded grep, unified and paired diff rows use `align-items: start`. Baseline alignment pushes the smaller gutter mark (`0.78em`) about a pixel down and grows the row past its cells.
- **No directive-diff CSS.** The directive diff's line `div`s are the gridded elements themselves, so their own `.acp-cellgrid` rule rounds the pitch.
- **Inter-lane mail grids at paint**, after `innerHTML`, instead of before caching. The cache keeps the parser's HTML, and paint runs only when the deps change.
- **Streaming bound (`STREAMING_GRID_MAX_LINES = 60`).** The Agent view and the AI panels re-parse the whole reply every frame. Re-gridding a fence each frame cost, in WebKit (p50, parse result reused, layout forced):

  | Fence rows | Plain | Gridded |
  |---|---|---|
  | 20 | 1ms | 3ms |
  | 40 | 1ms | 7ms |
  | 60 | 1ms | 10ms |
  | 100 | 18ms | 132ms |
  | 200 | 40ms | 282ms |

  While those surfaces stream, they grid only fences up to 60 lines (`gridifyCodeBlocks(root, { maxLines })`). A full pass when the reply ends grids the rest: `finalizeAssistantMessage`, `agent_end` in both AI panels, and `onComplete` in inline AI. A longer fence looks as it did before this spec until the reply ends. The Harness and Live Assist stream through `CellGridWriter`, which appends, so they need no bound.
- **Agent view cursor.** The streaming cursor `▋` (U+258B) is a block element. The grid runs before the cursor is inserted; afterwards, every fence the cursor ends would be gridded.
- **"More lines" notes stay outside the grid.** The Agent view's tool and shell results are gridded first, then the note is appended.
- **Inspector rebuild in place.** A gridded text part whose new text does not extend the old is now reset in place by `CellGridText`. It used to be replaced by a new `pre`.

**Verified:**

- **Unit tests:**
  - `sliceCells` with `กำ`, `日本` and tabs;
  - `boundedOutputLines` cuts a Thai row (`กั`, two code units per cell) and an ASCII row of the same width on the same cell, keeps a 280-code-unit Thai line that fits in 140 cells, and cuts `日` lines on a whole character;
  - `gridifyText` leaves plain text as one `Text` node, is idempotent, and keeps colour spans;
  - `gridifyLines` grids every line once one needs it, and clears the container class when none does;
  - `CellGridText` appends in place, converts once, and resets;
  - the `maxLines` bound;
  - `ToolRow`: a gridded and a plain section side by side, and a gridded row that seals with no later mutation;
  - `DiffBlock`: paired, unified and raw modes;
  - `InterLaneRow`: a fenced diagram.

  Full suite: 2919 tests pass. `npm run check` and `npm run build` pass.
- **WKWebView render** (Swift, DPR 2, the user's stack `'Share Tech Mono', 'Bai Jamjuree', 'Ayuthaya', 'Mali'` at 16px). The reported panel and table went through `boundedOutputLines` and the real `ToolRow`:
  - Plain `pre` (the old path): frame rows end at 479.2px, content rows anywhere from 436.11 to 450.19px. Table borders end at 381.69px, rows from 384.78 to 391.69px.
  - Gridded: all 9 frame rows end at 1319.89px and all 7 table rows at 1268.89px. The pitch is 22.5px.
  - A paired `DiffBlock` of the diagram: 11 rows end at 538.45px, at a 22px pitch.
  - A grep context block: 5 rows end at 1595.39px.
  - An Agent view fence: 9 rows end at 1238px, at a 24px line height.
  - Pixel probe of the screenshot: the left and right frame lines of the tool panel, the diff and the grep block have no dark pixel inside their spans.
- **Not exercised:**
  - 324's full cell-boundary probe matrix: only frame lines were probed.
  - The in-app path in a rebuilt Krypton.
  - Visual renders of Live Assist, Review Board, the AI panels and Hurl. They are covered only by types and the shared helpers' tests.
- **Found, not fixed here:**
  - `isGrepPathHeader` (`harness-tool-render.ts`, spec 235) takes a grep context line with no whitespace, such as `docs/x.md-10-╭────╮`, for a file header and drops it. All-box border rows of a grepped diagram are therefore missing from the grep card.
  - Review Board diffs rendered by `diff2html` are not gridded. Only its raw-text fallback is.

## Verification Plan

- Unit:
  - `sliceCells` with `กำ`, wide CJK and tabs;
  - `boundedOutputLines` cuts a Thai row and an ASCII row of the same width at the same cell;
  - `gridifyText` and `gridifyLines` are idempotent and leave plain text as one `Text` node;
  - a gridded tool row seals with no node replaced;
  - each surface grids its fixture.
- WKWebView with the user's font stack:
  - the reported panel and table, rendered through the real `ToolRow`, every frame row ending at one x;
  - a paired diff of a spec diagram;
  - a grep context block;
  - 0 failing cell-boundary probes, as in 324.
- Cost: a 200-row diagram re-rendered per frame in the Agent view, as a WebKit p50/p95 frame time.

## Resources

- [CSS Overflow 3 §6.1 `text-overflow`](https://drafts.csswg.org/css-overflow-3/#text-overflow): atomic inlines are hidden to fit the ellipsis, so cell rows keep `…`.
- [VS Code: Use tools with agents](https://code.visualstudio.com/docs/agents/run/tools): inline Show Output / Show Terminal, and `chat.tools.terminal.outputLocation`.
- Zed `crates/agent_ui/src/conversation_view/thread_view.rs` (local, `/Users/wk/Source/zed`): terminal tool calls embed `TerminalView`; other tool content is markdown.
- Spec 324 Resources (xterm.js `customGlyphs`, WezTerm `custom_block_glyphs`, kitty `box_drawing_scale`): the terminal convention reused here.
