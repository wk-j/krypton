# Review Board Chapters and Review Map — Implementation Spec

> Status: Implemented
> Date: 2026-09-09
> Milestone: ACP harness — attention & review surfaces
> Builds on: 211 (Review Board) · 217 (self-contained review archive) ·
> 243 (Review Board smooth keyboard scrolling)

## Problem

The in-app Review Board renders every prose, walkthrough, finding, decision, chart, and metric
block in one continuous column. Long reviews become difficult to orient within even though the
document already contains authored headings and the window has enough unused horizontal space for
a navigation surface.

## Solution

Turn the Board into a chaptered reader. Derive chapters from authored `H1` and `H2` Markdown
headings, show one chapter at a time by default, and add a persistent Review Map on wide panes.
The map also exposes `Overview`, `Open items`, and `Full document` views; it becomes an on-demand
overlay on narrow panes and replaces the block outline overlay. Block ids, author order, answers,
comments, source jumps, autosave, and send behavior remain unchanged.

## Research

- `parseReviewDocument()` already receives `marked` top-level tokens, narrowed locally to
  `FenceToken { type, raw, lang?, text? }`. `marked` emits `depth` and inline `tokens` on heading
  tokens, so widening that narrowing by two optional fields is enough to derive chapter boundaries
  during the existing parse — no reparse of rendered HTML, no change to `review.md`.
- `ReviewBoardView.renderBody()` currently appends every `doc.blocks` entry. The existing `o`
  outline is a modal list of individual blocks, so it helps jumping but does not reduce the amount
  of mixed content on the page. It also owns the `o` key today (`renderOutline()`, `onOutlineKey()`,
  `Overlay = 'outline'`), which the Review Map needs — see *Retiring the block outline*.
- `moveCursor()`, `moveToUnanswered()`, and `moveStep()` each call the full `render()`, and
  `renderBody()` wipes `innerHTML` and rebuilds every block. One `n` keystroke re-renders the whole
  document today. Chapters shrink that work, but a Review Map rebuilt on the same path would give
  it straight back by recounting findings on every keystroke.
- The reading column is capped at 860px (`src/styles/review-board.css:111`). On a wide Board the
  remaining horizontal space holds a 272px map without narrowing the authored content. Pane width,
  not application viewport width, is authoritative because Krypton windows tile.
- `ContentView.onResize(width, height)` is declared in `src/types.ts:190` and implemented by most
  views, but **nothing ever calls it** — a repo-wide search finds no call site, so `onResize` is
  currently dead. Views that need their own measurement each run a `ResizeObserver`
  (`webview-view.ts`, `acp-harness-view.ts`, `header-scope.ts`). The Board must do the same; a
  responsive layout hung off `onResize` would silently never fire.
- The existing keymap reserves `1`…`9` for decision answers. The prototype's numeric chapter keys
  therefore cannot ship. `[` / `]` are free in the Board and match large-review navigation prior
  art.
- Default chapter rendering reduces DOM work. `Full document` retains the existing
  `content-visibility: auto` and large-diff summary behavior for readers who need continuous flow.
- Search currently walks rendered DOM. To retain whole-document search, entering `/` temporarily
  renders `Full document`; closing search lands in the chapter containing the active match.

Alternatives considered:

- **Tabs by block kind** (`Overview`, `Walkthrough`, `Findings`, `Decisions`) were rejected because
  they reorder lane-authored narrative and detach findings from nearby explanation. The `Overview`
  view specified below is deliberately not this: it renders no authored block at all, so it has
  nothing to reorder.
- **Independent collapsible cards** were rejected because they keep one very long page and add a
  second expansion state to every block.
- **Keep only the modal outline** was rejected because the body remains mixed and the user loses
  orientation as soon as the overlay closes.
- **Require a new chapter fence in `review.md`** was rejected because Markdown headings already
  carry the structure and old bundles must keep working unchanged.

## Prior Art

| App | Implementation | Contribution to this design |
|---|---|---|
| VS Code | Markdown Outline uses the document's heading hierarchy. | Use authored headings as navigation truth instead of inferring categories. |
| GitHub | A Files changed tree selects a focused diff and disappears when the screen is too narrow. | Keep the map persistent only when the pane has room. |
| GitLab | Large merge requests can show one file at a time; `[` / `]` move to previous/next and the file browser remains available. | One chapter at a time with adjacent chapter keys and a full-document escape hatch. |
| Gerrit | The change screen separates the file list, unresolved comments, checks, and reply summary. | Provide an `Open items` task view without replacing the authored reading order. |

**Krypton delta** — unlike file-oriented review tools, the Review Map navigates an explanation
whose units can be prose, walkthroughs, findings, decisions, or visual blocks. It remains
keyboard-first, uses the existing block cursor and response model, and never sorts or hides author
content without an explicit view choice.

## Affected Files

| File | Change |
|---|---|
| `src/acp/types.ts` | Add derived `ReviewSection` metadata to `ReviewDocument`. |
| `src/review-board/parse.ts` | Record structural headings and build stable chapter ranges during the existing token pass. |
| `src/review-board/parse.test.ts` | Cover heading boundaries, preamble, inline heading text, and heading-free fallback. |
| `src/review-board/view.ts` | Add view mode, active chapter, Review Map DOM, Overview, visible-block navigation, `ResizeObserver`, and search handoff; split the render paths; delete the block-outline overlay. |
| `src/review-board/view.test.ts` | Cover pure visible-index, chapter-selection, and cursor-reconciliation helpers. |
| `src/styles/review-board.css` | Add the wide two-column layout, narrow map overlay, count rows, Overview grid, focus states, and chapter chrome; retire the `__outline*` rules. |
| `docs/04-architecture.md` | Update the Review Board architecture summary. |
| `docs/05-data-flow.md` | Update load, navigation, search, refresh, and resize flows. |
| `docs/211-review-board.md` | Supersede the single-column/no-sidebar decision and the `o` block outline; document the new keymap. |
| `docs/README.md` | Index this spec. |

No Rust, Tauri IPC, compositor, InputRouter, response-file, or browser-archive changes are needed.

## Design

### Data Structures

```ts
// src/acp/types.ts
export interface ReviewSection {
  /** Heading block id, or a reserved synthetic id for preamble/fallback. */
  id: string;
  title: string;
  /** Authored heading depth; synthetic sections use 1. */
  depth: 1 | 2;
  /** Half-open range into ReviewDocument.blocks. */
  startBlock: number;
  endBlock: number;
  synthetic: boolean;
}

export interface ReviewDocument {
  title: string | null;
  laneName: string | null;
  subject: string | null;
  blocks: ReviewBlock[];
  sections: ReviewSection[];
}

// local to src/review-board/view.ts
type ReviewViewMode = 'overview' | 'section' | 'open' | 'document';
```

`ReviewSection` is derived state only. It is never serialized into `review.md`, `response.md`, an
IPC payload, or lane memory.

### Section Derivation

1. During the existing `marked` token pass, each heading token of depth 1 or 2 starts a section.
   Its block remains the first block in the section. The local `FenceToken` narrowing in
   `parse.ts` gains `depth?: number`, so the heading fields are read without widening the cast.
2. The label is extracted from the heading's inline tokens as plain text; formatting and links do
   not appear as Markdown syntax in the map. A heading whose text is empty after stripping falls
   back to `untitled section`, and labels are capped at 80 characters for the map row.
3. The section ends immediately before the next depth-1-or-2 heading. `H3`–`H6` remain nested
   content inside the active chapter.
4. **Single leading `H1` is a title, not a chapter.** Reviews are usually written as one `# Title`
   followed by `##` sections. If the document has exactly one depth-1 heading and it is the first
   structural heading, chapters come from the depth-2 headings instead, and the `H1` block plus any
   prose under it before the first `H2` fall into the synthetic `Introduction`. Any document with
   two or more `H1`s keeps the plain depth-1-or-2 rule.
5. Blocks before the first structural heading form a synthetic `Introduction` section.
6. A non-empty document with no structural headings gets one synthetic `Review` section.
7. An empty document has no sections and keeps the existing empty state.
8. A heading section id is `section:<heading-block-id>`; synthetic ids are
   `section:introduction` and `section:document`. Active-section recovery is based on the restored
   block cursor, so renaming a heading does not lose the reader's position.

### View State and Visible Blocks

- `section` mode renders only the active section's half-open block range.
- `open` mode renders unanswered `finding` and `decision` blocks in document order. A finding's
  existing `detail` field keeps its explanatory paragraph inside the card.
- `document` mode renders every block exactly as today.
- First open keeps spec 211's priority: select the first unanswered block, else block 1. The active
  chapter is the one containing that block.
- Switching chapters places the cursor on the chapter's first unanswered block, else its first
  block, cancels an active RAF scroll, and resets that view to the top.
- `n` / `N` move across the visible block indices, and at a chapter edge in `section` mode they
  continue into the adjacent chapter (landing on its first/last block) rather than dead-ending.
  Continuous reading stays a one-key operation for a keyboard-only user; `[` / `]` remain the
  explicit chapter jump for readers who want to skip. `n` at the last block of the last chapter and
  `N` at the first block of the first still stop, as they do today. In `open` and `document` mode
  there is nothing to continue into and the clamp is unchanged.
- `g` / `G` target the current view's first and last visible block, not the document's.
- `}` / `{` remain global unanswered navigation. If the target is outside the visible chapter,
  section mode switches to its chapter before revealing it. In `open` and `document` mode the mode
  stays unchanged.
- `Tab` / `Shift+Tab` remain global walkthrough navigation. Section mode switches to the chapter
  containing the walkthrough block before centering the step and opening its source anchor.
- In `open` mode, answering the current item removes it from the visible set and reconciles the
  cursor to the next item, then the previous item. When none remain, the body shows
  `everything is answered`.
- Overview, full-document, and open-item modes are session-local presentation state. They do not
  alter or persist the authored document.
- **`Escape` backs out one level.** In `overview`, `open`, or `document` mode it returns to
  `section` mode at the chapter containing the cursor; only in `section` mode does it close the
  Board as it does today. `q` still closes the Board from any view, so the existing one-key exit is
  never lost. Without this, `O` would be a trap: `Escape` out of a summary page would close the
  whole review.
- In `overview` mode there is no block cursor. `j` / `k` scroll it, `[` / `]` leave it for the
  first / last chapter, and answering keys (`a`, `x`, `1`…`9`, `c`, `Enter`) are inert — the
  Overview renders no answerable block to address.

### Overview

`overview` is the map's first row and the `O` key. It is a read-only landing surface that renders
**no authored block**, so it can neither reorder nor hide lane content:

1. Identity — title, subject, lane, slug.
2. Work remaining, as **raw counts only**: unanswered findings broken out by severity
   (`blocking` / `non-blocking` / `suggestion`) and unanswered decisions. A Board with nothing
   answerable shows `reference` exactly as the header does.
3. The chapter list — index, title, block count, unanswered count — as the fastest way to pick a
   starting point.
4. Guided read — walkthrough step count, and the reminder that `Tab` starts it.
5. Resume — the block and chapter the cursor is currently on.

**Never a score.** No percentage, progress bar, completion badge, ring, or grade anywhere in the
Overview. This is the same constraint the header already honours (`renderHeader()`, ADR-0004): the
Board reports what is left, and the human judges. Counts use tabular numerics.

Overview is never the first thing shown. First open keeps spec 211's priority (first unanswered
block, else block 1) so the reader lands in the work, not on a summary page.

### Retiring the block outline

The Review Map takes `o`, so the modal block outline (`Overlay = 'outline'`, `renderOutline()`,
`onOutlineKey()`, `outlineIndex`, and the `__outline*` CSS) is **removed**, not rebound. Keeping
both would mean two overlapping navigation surfaces with one mnemonic between them. Everything the
outline did survives in the new surfaces: chapters navigate structure, `Overview` lists them with
counts, `Open items` reaches every unanswered block, and `/` still finds any block by text.

### Rendering and Performance

Today every cursor move calls `render()`, which wipes `innerHTML` and rebuilds every block. The
Board splits that into three paths so the map does not make it worse:

- `renderBody()` — runs when the visible block set changes: load, refresh, view mode, active
  chapter, expand/collapse, or an answer that removes an item in `open` mode.
- `renderMap()` — runs when sections, answers, or the active view change. Never on a plain cursor
  move.
- `moveCursor()` — moves the `krypton-review__block--cursor` class between two elements and updates
  the header position segment. No rebuild, so `n` / `N` stay well inside the 16ms budget and the
  spec 243 RAF scroll is no longer fighting a fresh DOM.

Cursor movement that crosses a chapter boundary is the one case that still rebuilds the body.

### Review Map

The root DOM becomes:

```html
<div class="krypton-review">
  <div class="krypton-review__header">…</div>
  <div class="krypton-review__content">
    <aside class="krypton-review__map">…</aside>
    <div class="krypton-review__body">…</div>
  </div>
</div>
```

The map contains:

1. Global counts: blocks, findings/decisions, unanswered — the one-line form of what `Overview`
   shows in full. Both read the same `answerableBlocks()` / `unansweredBlocks()` helpers; neither
   keeps its own tally.
2. Authored chapters in document order, indented by heading depth, with block and unanswered
   counts.
3. `Overview`, `Open items`, and `Full document` smart rows — `Overview` first, the other two last.
4. A footer reminder for map and chapter keys.

The active row uses a full background tint and full border, never a left accent rail. All changing
counts use tabular numerics. Rows use buttons with `aria-current="page"`; keyboard focus uses the
required `:focus-visible` ring.

### Responsive Layout

- A `ResizeObserver` on `this.element` compares pane width against
  `REVIEW_MAP_WIDE_MIN_PX = 1180` and sets a root layout attribute. It is created in the
  constructor and disconnected in `dispose()`. `onResize()` is *not* the trigger: the compositor
  never calls it (see Research). The Board keeps a no-op `onResize()` so it still satisfies
  `ContentView`.
- At or above the threshold, the 272px map is persistent and the 860px reading column retains its
  current maximum width.
- Below the threshold, the map is hidden by default and opens as an opaque, bordered overlay over
  the body. No `backdrop-filter` is used.
- Crossing from wide to narrow closes map focus and hides the overlay. Crossing back restores the
  persistent map. There is no saved width preference.
- Pointer clicks on a map row select its view and return focus to the Board; the narrow overlay
  closes after selection.

### Search

1. `/` records the current view and cursor, switches to `document`, renders all blocks, and opens
   the existing search HUD.
2. Existing DOM highlighting, `n` / `N`, cap, and smooth reveal behavior remain unchanged.
3. On search close, if there is a current match, the Board selects that match's enclosing block
   and its chapter. With no current match it restores the prior view and cursor.
4. Map activation is disabled while the search input owns focus; closing search restores normal
   routing.
5. The header shows `search · full document` while search is open, so the temporary whole-document
   rendering is announced rather than looking like the chapter silently vanished.

### Header

The existing header remains one line but replaces the lone position segment with:

```text
chapter 2/5 · block 8/19
```

`Open items` displays `open items · block 2/5`; `Full document` displays the original global block
position; `Overview` displays `overview`. Unanswered, save, send, and sync segments remain global
and unchanged.

The header is already eight segments wide before this change. Segments therefore drop in a fixed
order as the pane narrows — slug, then lane, then steps — so position, unanswered, save, and sync
survive on the narrowest pane. The title truncates with an ellipsis and never wraps: the header
stays one line at every width.

### API / Commands

None. Chapter state is derived entirely in the frontend from the existing `review.md` contents.

### Data Flow

```text
1. read_review_bundle returns review.md + response.md as today
2. parseReviewDocument emits blocks plus derived H1/H2 section ranges
3. response answers reattach by unchanged block ids
4. the restored/initial block cursor selects the active section
5. view mode produces a list of visible global block indices
6. renderBody renders only those blocks; the map renders section/smart-view counts
7. chapter/open/document navigation changes presentation state, never response state
8. answer/comment/decision actions continue to address global block ids and autosave unchanged
9. refresh reparses sections, restores the cursor by block id, then selects its new section
10. a ResizeObserver on the root changes only map presentation between persistent and overlay
11. cursor moves inside one chapter reclass the cursor element instead of re-rendering
```

### Keybindings

| Key | Context | Action |
|---|---|---|
| `[` / `]` | Body | Previous / next authored chapter; stop at the ends. |
| `O` | Body | Open the Overview view. |
| `o` | Body | Enter the Review Map; reveal the narrow overlay first when needed. Replaces the block outline, which is removed. |
| `n` / `N` | Body | Next / previous block in the visible set; in `section` mode, continues into the adjacent chapter at an edge. |
| `j` / `k`, arrows | Review Map | Move map selection. |
| `Enter` | Review Map | Open the selected chapter or smart view. |
| `o`, `q`, `Esc` | Review Map | Return focus to the body; also close the narrow overlay. |
| `Esc` | Overview / Open items / Full document | Back out to `section` mode at the cursor's chapter. |
| `Esc` | Section mode | Close the Board, unchanged. |
| `q` | Any view | Close the Board, unchanged. |
| Existing keys | Body | Preserve spec 211 exactly, scoped to visible blocks where described above. |

`1`…`9` remain decision answers and are never chapter shortcuts, and `0` stays unbound so a
mistyped decision key does nothing. `O` is free today; the Board's keymap only handles `N` and `G`
in uppercase.

### Configuration

None.

## Edge Cases

- **One or zero chapters** — keep the map because `Overview`, `Open items`, and `Full document`
  still provide value; empty documents keep the existing empty state.
- **Title-only `H1`** — a review written as one `# Title` plus `##` sections chapters on the `H2`s,
  so the reader never gets one near-empty title chapter in front of the content.
- **Nothing answerable** — the Overview shows `reference` and omits the work-remaining rows
  entirely; it never renders `0 unanswered`.
- **Duplicate heading text** — section ids come from heading block ids, not labels.
- **Heading renamed during refresh** — restore the block cursor first, then select the section that
  now contains it.
- **Current block removed during refresh** — reuse current block reattachment/fallback, then derive
  the section from the resulting cursor.
- **Open item answered while filtered** — remove it immediately and advance deterministically.
- **All open items answered** — show the empty success state; global header becomes `all answered`.
- **`Escape` from a non-section view** — returns to the chapter, never closes the Board; the
  regression to watch for is `O` then `Escape` dropping the human out of the review entirely.
- **Search in a very large review** — temporarily uses today's full rendering path, including lazy
  blocks and large-diff summaries; closing search returns to focused chapter rendering.
- **Narrow pane resized while map is active** — leave map-focus state safely, hide the overlay, and
  keep the active chapter/cursor.
- **Mouse selection inside prose** — map and chapter rerenders must not fire unless a navigation row
  is activated; existing copy-on-select behavior remains intact.
- **Reduced motion** — chapter replacement is instant; all scroll reveals keep the existing
  reduced-motion branch.
- **Browser archive** — unchanged; spec 217 deliberately remains a self-contained continuous page.

## Open Questions

None.

## Out of Scope

- Changing the `review.md` authoring format or requiring headings from lanes.
- Grouping or sorting blocks by kind, severity, reviewer, or file.
- Persisting the selected chapter/view mode across app restarts.
- Replacing the send preview with a permanent response pane.
- Changing the `/reviews` browser archive.
- Adding backend commands, settings, dependencies, or a frontend framework.

## Resources

- [VS Code Markdown Outline](https://code.visualstudio.com/docs/languages/markdown#_document-outline) — heading hierarchy as document navigation.
- [GitHub commit file tree](https://docs.github.com/en/pull-requests/reference/commits#using-the-file-tree) — focused navigation with a narrow-screen fallback.
- [GitLab merge request changes](https://docs.gitlab.com/user/project/merge_requests/changes/#show-one-file-at-a-time) — one-at-a-time review, file browser, and `[` / `]` navigation.
- [Gerrit Review UI](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html) — separate file, unresolved-comment, and reply-summary work surfaces.
- [Marked documentation](https://marked.js.org/using_pro) — the lexer/token API already used by `parseReviewDocument()`.
- `docs/211-review-board.md` — current Review Board format, navigation, and persistence contract.
- `DESIGN.md` — Krypton Dark geometry, focus, accessibility, and platform constraints.
