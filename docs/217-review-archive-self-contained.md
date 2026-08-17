# `#reviews` — a self-contained review page — Implementation Spec

> Status: Implemented (2026-08-14)
> Date: 2026-08-14
> Milestone: ACP harness — attention & review surfaces
> Builds on: 211 (Review Board + the `/reviews` archive) · 192 (Issue Analysis Viewer, the template) ·
> 172 (Docs browser) · DESIGN.binance.md
>
> **Scope note (2026-08-14):** the subject is the **browser archive opened with `#reviews`**, not the
> transcript card. An earlier draft of this number targeted the in-app card; that reading was wrong
> and is dropped.

## Problem

A review page at `/review?...` renders `review.md` faithfully — prose, walkthrough, findings,
decisions, metrics, charts, diagrams — and then stops exactly where understanding starts:

| What the page shows today | What the reader still has to do |
|---|---|
| `1. src/acp/inter-lane.ts:812 — the guard map, this is the whole concurrency model` (`render_rv_walkthrough`, `hook_server.rs:6432`) | open `src/acp/inter-lane.ts` in an editor and scroll to 812 |
| `BLOCK · guard is set after the await · src/acp/inter-lane.ts:835` (`render_rv_finding`, `hook_server.rs:6481`) | same — the finding names a line and shows none of it |
| a file strip with `review.md` · `response.md` (`hook_server.rs:6233`) | click through to a **second page** to see the human's answers |

The walkthrough is the comprehension spine of a Board (spec 211), and in the browser it is a list of
paths with no code under them. Reading one review from the archive means a browser window, an editor
window, and a page switch — for a surface whose entire job is "understand what now exists".

This is worst exactly where the archive is most valuable: months later, answering *"has anyone
explained this part of the code before?"* means reconstructing the reviewed code from memory.

## Solution

Make the bundle page carry everything it references:

1. **Inline source excerpts.** Every anchored walkthrough step and every anchored finding renders the
   real lines from the working tree underneath it — line-numbered, the anchored line tinted, ±6 lines
   of context (or the whole range for a `path:12-40` anchor).
2. **One page, both files.** `review.md` and `response.md` render on the *same* page; the file strip
   becomes in-page jump links instead of navigation to a second URL.
3. **Honest provenance.** An excerpt is the file *now*, not at review time. Each excerpt is stamped
   with the path and, when the file's mtime is newer than the review's `created`, a `changed since
   this review` chip. An anchor that no longer resolves says so instead of silently showing the wrong
   lines.

Excerpts are read **server-side while rendering the page** — no new HTTP route, no URL-addressable
file reader, no JS fetch. The only paths ever read are the ones the review document itself anchors.

## Research

- **The renderers are string builders with the anchor already in hand.** `render_rv_walkthrough`
  (`hook_server.rs:6432`) parses `- at:` / `say:` pairs; `render_rv_finding` (`:6481`) already builds
  `file:line` from the fence's `file`/`line` keys. Both emit the anchor as escaped text and stop.
  The excerpt hooks in at exactly those two points.
- **The loopback has never served source code.** Every `validate_doc_path` call site passes
  `&["md"]` (`hook_server.rs:1365, 2504, 2609, 2719, 2770, 2807, 3165, 5426`); assets are limited to
  image extensions. Adding excerpts widens what the loopback can read, which is why they are baked
  into the page rather than exposed as a route.
- **The gitignore filter is the right guard and already a dependency.** `ignore = "0.4"` is in
  `src-tauri/Cargo.toml`; `build_docs_tree` walks with `WalkBuilder` respecting `.gitignore`
  (`hook_server.rs:4940`). `ignore::gitignore::GitignoreBuilder` gives the same policy for a single
  path, so a lane that anchors `.env`, `.krypton/`, or any ignored file gets no excerpt.
- **No syntax highlighter exists server-side.** `comrak` is pinned with `default-features = false`
  and there is no `syntect`. Excerpts therefore render as plain monospace with line numbers — one
  fewer dependency, and the Binance-dark shell already styles `--code-bg` / `--code-fg`.
- **`response.md` is already readable in place.** `render_review_bundle` reads whichever file the
  `file=` param selects (`hook_server.rs:6255-6260`); rendering both is a loop, not a new mechanism.
  Its body is a *generated readable rendering* of the frontmatter (spec 211 Storage layout), so it
  needs no block-id machinery to be understood.
- **Block ids are not available in Rust.** Ids are `b<ordinal>-<fnv1a(raw)>` computed by
  `src/review-board/parse.ts`; the browser pass is a fence-aware post-pass over comrak output with no
  notion of block identity. That rules out attaching each answer to its finding *inline* on this
  page — the answers render as their own section instead.
- **The archive is deliberately read-only.** Spec 211 settled that answering happens only in the
  in-app Board; nothing here changes that.

**Alternatives ruled out:** (a) *a `/review-source` route serving arbitrary repo files* — a
URL-addressable reader over the project tree is a much larger surface than "the lines this document
points at", and nothing needs it; (b) *client-side fetch of excerpts* — same route problem, plus the
page stops working from a saved copy; (c) *rendering the review's `diff` blocks as the code context*
— only works when the lane wrote a diff block, and says nothing about a comprehension review over
existing code; (d) *matching answers to findings by re-implementing block ids in Rust* — duplicates a
hashing scheme whose only authority is the TS parser.

## Prior Art

| Tool | Implementation | Notes |
|---|---|---|
| GitHub PR review comment | Renders the diff hunk the comment anchors to, directly under the comment body | The convention: a finding is never shown without its code. |
| Gerrit / Graphite | Comment threads sit inside the file view, with surrounding context always visible | Code-first; the reviewer never leaves the page. |
| Sourcegraph search results | Each hit shows ±N lines of context with line numbers, matched line highlighted | The excerpt shape adopted here, including the line-number gutter. |
| [difit](https://github.com/yoshiko-pg/difit) | `--comment file:line` preloads agent findings **into the diff view** | Findings and code in one surface — but only for a diff. |
| Sentry / Datadog stack frames | A frame shows source context inline, marked "may differ from the deployed version" | The provenance stamp this spec copies for `changed since this review`. |

**Krypton delta** — the excerpt is driven by a *typed anchor* in a lane-authored document rather than
a diff position, so it works for a comprehension review over unchanged code; it is rendered
server-side into a static page with no new route; and it is filtered by gitignore, so the archive can
never surface a secret the repo already refuses to track.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/hook_server.rs` | `rv_anchor()` (parse `path` / `path:line` / `path:a-b`), `rv_excerpt()` (guarded read + window + drift/mtime state), `render_rv_excerpt()` (markup); call from `render_rv_walkthrough` and `render_rv_finding`; `render_review_bundle` renders both files on one page with the strip as jump links. |
| `src-tauri/src/hook_server.rs` (tests) | Anchor parsing, traversal/absolute/symlink rejection, gitignored path rejection, extension rejection, drifted anchor, range clamp, excerpt budget. |
| `src/acp/artifact-reviews.html` | Styles for `.rv-src`, `.rv-src__head`, `.rv-src__chip`, `.rv-src__line`, `.rv-src__ln`, `.rv-src__line--anchor`, `.rv-src--drifted`, `.rv-answers`; strip restyled as jump links. |
| `docs/211-review-board.md` | Update the Browser-surface section: anchors are no longer plain text, and the page is one document. |
| `docs/README.md` | Spec index entry. |

## Design

### Anchor parsing

```rust
struct RvAnchor { rel: String, start: Option<usize>, end: Option<usize> }

/// `src/acp/inter-lane.ts` · `…:835` · `…:812-840`. Returns None for anything
/// else, so a prose `at:` still renders as text and never reads a file.
fn rv_anchor(at: &str) -> Option<RvAnchor>;
```

### Excerpt extraction

```rust
struct RvExcerpt {
    rel: String,
    first_line: usize,          // 1-based line number of the first rendered row
    lines: Vec<String>,         // clamped to EXCERPT_COL_MAX chars
    anchor_line: Option<usize>, // the tinted row, when the anchor named one
    omitted: usize,             // rows dropped by EXCERPT_RANGE_MAX
    stale: bool,                // file mtime newer than the review's `created`
}

fn rv_excerpt(project_dir: &StdPath, anchor: &RvAnchor, created: i64) -> Result<RvExcerpt, RvSkip>;
```

Guards, in order — any failure means **no excerpt**, and the anchor still renders as text:

1. `validate_doc_path(project_dir, rel, EXCERPT_EXTS)` — relative only, canonicalized, inside the
   project root, symlink-escape rejected, extension allowlisted.
2. `GitignoreBuilder` over the project root — an ignored path is skipped (`.env`, `.krypton/`,
   build output, anything the repo already refuses to track).
3. File size ≤ `EXCERPT_FILE_BYTES` and valid UTF-8.
4. Anchor line within the file; otherwise `RvSkip::Drifted { lines }`.

| Budget | Value |
|---|---|
| `EXCERPT_CONTEXT` | 6 lines each side of a single-line anchor |
| `EXCERPT_RANGE_MAX` | 40 rows for a range anchor, remainder reported as `+N more lines` |
| `EXCERPT_COL_MAX` | 400 chars per line |
| `EXCERPT_FILE_BYTES` | 2 MB |
| `EXCERPT_PER_PAGE` | 60 excerpts; beyond that anchors render as text with one notice |

Reads are deduplicated per page render (a file anchored five times is read once).

### Page composition

`render_review_bundle` changes from "render the selected file" to:

```
1. strip → in-page links (#rv-review, #rv-answers), the second only when response.md exists
2. <section id="rv-review">  review.md   → render_markdown_doc → render_review_blocks (+ excerpts)
3. <section id="rv-answers"> response.md → render_markdown_doc (frontmatter card + generated body)
4. assets grid (unchanged)
```

`file=` is still accepted so existing links keep working, but it now scrolls rather than filters.

### UI

Under a step or finding, flush in the same block — **not a card inside a card**:

```
  src/acp/inter-lane.ts:830-841                              changed since this review
  830   const target = envelope.to;
  831   if (this.inFlight.has(target)) return;
  …
  835   await this.deliver(envelope);          ← tinted row (background tint, no left rail)
  …
```

- Head row: the path (never upper-cased), then chips only when they carry news —
  `changed since this review`, `+N more lines`, `drifted — file has 812 lines`.
- Line numbers in a dim gutter column; the anchored row takes a background tint in `--warn` at ~10%.
- Monospace, `--code-bg`, no syntax highlighting, `overflow-x: auto` on long lines.
- A drifted or skipped anchor renders the head row alone with its reason — the explanation text is
  still worth reading, so nothing is hidden.
- `.rv-answers` is a plain section with its own heading, not a second column.

### Configuration

None. The archive stays a zero-config read-only surface.

## Edge Cases

- **Anchor outside the project** (`/etc/passwd`, `../..`, an absolute path) — rejected by
  `validate_doc_path`; anchor renders as text.
- **Anchor at a gitignored file** — skipped by the gitignore guard, even though it resolves.
- **Anchor at a binary or unknown extension** — no excerpt, no read past the extension check.
- **Line number past EOF / file deleted / renamed** — `drifted` chip with the file's current length;
  for a deleted file, `file no longer exists`.
- **File changed since the review** — rendered with the `changed since this review` chip; the reader
  is never told the excerpt is what the lane saw.
- **Review with 200 anchors** — first 60 excerpts render, the rest fall back to text with one notice
  at the top of the section.
- **Very long lines** (minified, generated) — clamped at 400 chars with an ellipsis.
- **`response.md` missing** — the jump link is absent and the section is not rendered, as today.
- **`response.md` frontmatter corrupt** — rendered as-is by comrak; the archive never re-parses it.
- **Bundle with no `review.md`** — unchanged: `never composed` empty state.
- **The reviewed repo is not the current project** — excerpts are resolved against the harness's own
  project dir, which is what the bundle's path is keyed by; a bundle from another harness renders
  under that harness's root.

## Out of Scope

- **Answering, commenting, or editing from the browser** — spec 211's settled boundary stands.
- **A full-file viewer or "expand to whole file"** — the excerpt window is the deliverable; the
  editor is one keystroke away for anyone who wants more.
- **Syntax highlighting** — would mean a new dependency (`syntect`/`tree-sitter`) for an archive page.
- **Showing the code *as it was* at review time** — needs git object lookup per anchor; the
  provenance chip is the honest cheap answer. Xenon (spec 230) instead ships a **publish-time
  snapshot** in `excerpts.json`; this loopback page still reads the live tree.
- **Attaching each answer to its finding inline** — blocked on block ids the Rust pass does not have.
- **Changing the in-app Board or the transcript card.**
- **Index page changes** (`/reviews` rows stay as they are).

## Implementation notes (2026-08-14)

Everything above landed as specified except these.

- **A prerequisite bug had to be fixed first: the archive was dropping every walkthrough anchor.**
  `rv_group` only collected *indented* lines under a `key:`, but lanes write the list flush left
  (`- at: src/x.rs:812` at column zero with an indented `say:` under it) — both are valid YAML, and
  the real bundles in `.krypton/reviews/` use the flush-left form throughout. The archive therefore
  rendered walkthrough steps with their explanations but **no `at:` anchors at all**, and there would
  have been nothing for an excerpt to hang off. `rv_group` now accepts an indented line *or* a `- `
  item at column zero, and stops at the next top-level key. Covered by
  `review_walkthrough_reads_flush_left_list_items`.
- **Excerpt lines wrap; they do not scroll sideways.** The spec said `overflow-x: auto`. A horizontal
  scrollbar inside a card is the one thing a keyboard reader cannot reach, so `.rv-src__line` is
  `pre-wrap` with the gutter as a fixed flex column — a wrapped continuation lines up under the code
  rather than under the line number. `overflow-x: auto` remains on the body as a backstop.
- **The budget notice sits at the end of the review section, not the top.** The count is only known
  after the blocks are rendered, and the alternative was a second pass over the finished HTML.
- **`.krypton/` is refused independently of `.gitignore`.** A project that has not ignored the
  harness scratch tree would otherwise let one review quote another. The matcher also loads
  `.git/info/exclude`; **nested `.gitignore` files are not consulted** — the root file plus the
  explicit `.krypton` rule covers the real cases, and a per-path builder walk was not worth it.
- **Missing/drifted notices carry the anchor as the lane wrote it** (`docs/PROGRESS.md:24`), not the
  bare path, so the reader sees which line was meant.
- **`file=` still works.** It no longer selects which document renders — both always render — but it
  still marks the active strip entry, so old links and index rows keep their meaning.
- **Verified against a real bundle**, not only fixtures: `2026-08-13-grok-acp-writes-reach-the-review-card`
  renders 11 anchors — 10 excerpts (2 stamped `ไฟล์เปลี่ยนหลังรีวิวนี้`) and one
  `ไฟล์นี้ไม่มีแล้ว` for `docs/PROGRESS.md:24`, a file deleted since that review was written.

## Resources

- [difit](https://github.com/yoshiko-pg/difit) — findings preloaded into the code view; the
  "never show a finding without its code" convention.
- `docs/211-review-board.md` — the archive's contract, the block vocabulary, and the read-only rule.
- `docs/192-issue-analysis-viewer.md` — the loopback page template these routes were cloned from.
- [`ignore` crate — `GitignoreBuilder`](https://docs.rs/ignore/latest/ignore/gitignore/struct.GitignoreBuilder.html) —
  single-path gitignore matching, the guard that keeps untracked secrets out of the archive.
