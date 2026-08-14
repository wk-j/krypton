# Review Board — a composable, lane-authored review surface — Implementation Spec

> Status: Implemented (2026-08-07)
> Date: 2026-08-07
> Milestone: ACP harness — attention & review surfaces
> Builds on: spec 39 / 137 (Markdown Viewer) · 133 / 134 / 149 (HTML artifacts + inline feedback) ·
> 145 (`#review`) · 146 + ADR-0004 (review outcomes) · 155 / 158 (Diff Window + review comments)
> Replaces the withdrawn `211-review-console` draft (a diff-dock worklist — too narrow: code only).
>
> **Settled (2026-08-07):** answers autosave to `response.md` as they are made (debounced), with
> sending to the lane as a separate explicit act. See Design → Storage layout.
>
> **Redirected (2026-08-07):** the Board's primary job is **helping a developer understand the
> code**, not logging issues. Explanation is the spine (`walkthrough` block + prose); findings and
> decisions are optional additions; the subject may be existing code, not only a diff. See Problem
> and Solution.
>
> **Settled (2026-08-07):** every review bundle is browsable read-only at `/reviews` in the OS
> browser (`#reviews`), cloned from spec 192's Issue Analysis Viewer. See Design → Browser surface.
>
> **Settled (2026-08-07):** review results persist as a gitignored bundle under
> `.krypton/reviews/<date>-<slug>/`, following the `.krypton/analyses/` convention of spec 191/192 —
> *not* as session state. See Design → Storage layout.
>
> **Settled (2026-08-07):** the document format is Markdown + typed fenced blocks, rendered in-app —
> *not* free-form lane-authored HTML in a webview. Acknowledged by the human via attention triage
> (`jdg-1786072326406-183d6220`). Rationale and the rejected options are in Research → Alternatives.
>
> **Corrected at implementation (2026-08-07):** the picker is **`Leader Shift+R`**, not `Leader r`.
> This spec claimed `Leader r` was "free in the global leader map" — it is not: `Leader r` has
> entered **Resize mode** since the original leader map (`src/input-router.ts`, `case 'r'`), and
> `'r'`/`'R'` are both in `GLOBAL_LEADER_RESERVED_KEYS` (`src/leader-keys.ts`), so a view-scoped
> `r` would also fail the leader-key conflict test. `Leader Shift+R` keeps the mnemonic and follows
> the house pattern of pairing a Shift variant onto an existing case (`d`/`Shift+D` for the Diff
> Window, `l`/`Shift+L` for the dashboard). Every other keybinding in this spec landed as written.

## Problem

Krypton has no surface where a lane can **explain code to a developer** and that developer can
**work through it**.

The primary job here is **comprehension, not defect-hunting.** When agents write most of the code,
the human's bottleneck stops being "find the bug" and becomes "understand what now exists" — what
changed, why, how the pieces fit, what to read first, and which parts deserve a decision. Finding
problems is one *output* of that understanding, not the purpose.

What that explanation needs is broader than a diff: a walkthrough in reading order, the reasoning
behind a design, a diagram of the new data flow, a chart of what grew, a table of affected call
sites, a question the human must decide, and — yes — some code. Today each lands somewhere
different, and none of them can be read as one thing:

| The lane wants to show… | Today it goes to | Why that fails |
|---|---|---|
| an explanation of how the change works | transcript turn text | scrolls away; no structure; no anchors into the code |
| a reading order through the change | nowhere | `mark_review_priority` ranks hunks, but carries no *narrative* |
| a diff | Diff Window (spec 155) | code only; the lane cannot put its reasoning next to a hunk |
| a diagram / chart / rich layout | HTML artifact in the OS browser (133) | mouse-driven, outside the keyboard flow, opaque to the harness |
| findings from `#review` | counts in a `Leader '` overlay (146) | detached from both the code and the reasoning |
| a decision the human must make | `attention_flag` (128) | one-line question, no supporting material |

So understanding a change means reading across six surfaces and stitching it together mentally,
then replying by retyping prose. There is no single artifact called "the review", no keyboard pass
through it, and no structured way to answer it.

## Solution

Add the **Review Board**: a dedicated Krypton content window (`PaneContentType = 'review'`) that
renders a **lane-authored review document** — ordinary Markdown plus a small set of typed fenced
blocks — and lets the human read it in a guided order, jump from any point into the real code,
annotate any block, triage findings, answer decisions, and send one structured response back to
the lane.

**A review document is an explanation first.** Its spine is prose and a `walkthrough` — an ordered
tour of the change, each step anchored to `file:line`, so `Enter` on a step opens exactly that code
in the Diff Window. Findings and decisions are *additions* to that spine, present when the lane has
them and absent when it does not. A Board with zero findings is a perfectly good review: it means
"here is what this code does, and it is sound."

Because the document is an explanation, the **subject is not limited to a working diff**. A lane
can compose a Board over a diff, a design document, or **existing code the human wants to
understand** ("walk me through `src/acp/inter-lane.ts`"). The archive at `/reviews` then doubles as
a growing set of explanations of the codebase, not just a defect log.

Authoring reuses the **path-handoff protocol proven by HTML artifacts** (spec 133): `review_new`
issues a path inside a **durable review bundle** under `.krypton/reviews/…`, the lane writes and
iterates on that file with its normal edit tool, `review_register` raises a card the human opens
with a hint key. Rendering reuses the **Markdown Viewer's** stack (`marked` + `highlight.js`,
in-doc search, image resolution, heading hints) and the **Diff Window's** `diff2html` for `diff`
blocks. The response rides the existing **drain-on-idle** queue pattern (spec 149/158).

**The review result is a file on disk, not session state.** The bundle follows the
`.krypton/analyses/` convention of spec 191/192 — a gitignored, *subject-keyed* directory of
Markdown that outlives the lane, the harness view, and the app. The lane's composition lands in
`review.md`; the human's answers are written to `response.md` as they are made. Reopening a review
next week restores every triage decision, answer, and comment. See **Storage layout**.

**Every review is browsable.** Because the bundles are plain files discovered by a directory walk,
they get the same read-only loopback surface the analysis bundles have: `#reviews` opens
`/reviews` in the OS browser — an index of every review ever run (newest first, with lane, date,
and how many items were left unanswered) and a per-review page that renders `review.md` and
`response.md` in the Binance-dark loopback aesthetic. This is the *archive* view;
answering still happens in the keyboard-driven Board.

> **Superseded in part by spec 217 (2026-08-14):** the bundle page now renders both files as two
> sections of **one** page (the file strip scrolls rather than navigating), and every anchored
> walkthrough step and finding carries the **source lines it points at**, read at page-render time
> behind `validate_doc_path` + the project's `.gitignore`. See `docs/217-review-archive-self-contained.md`.

**Composability is the point.** Anything the agent can express in Markdown is already in — prose,
tables, lists, links, images, code. Seven typed blocks add what Markdown lacks and the harness needs
to *understand*: `walkthrough`, `diff`, `finding`, `decision`, `chart`, `metrics`, `svg`. Everything else stays
free-form.

**Why not just an HTML artifact.** Spec 133 already gives a lane arbitrary HTML — but in the OS
browser, mouse-first, anchored by CSS selectors that drift (the exact fragility spec 158 was
designed to avoid), and completely opaque to the harness: an artifact has no findings, no
decisions, no notion of "unanswered". The Review Board is the opposite trade — slightly less
layout freedom, in exchange for a keyboard-native in-app surface whose blocks the harness can
count, anchor, and route. **They coexist:** a review block may link to an artifact when the
content is genuinely interactive, and `svg` covers static visuals in-app.

## Invocation — what makes a lane compose one

Mirrors spec 133's stance for artifacts: **the harness offers discoverability, the agent decides.**
No new composer syntax beyond the one command below, and no automatic composition.

| Trigger | Path |
|---|---|
| **`#review [lanes] [-- note]`** (primary) | `reviewRequestPrompt` already fans the subject out to reviewer lanes and tells the convening lane to synthesize the replies. That final step changes: instead of ending in turn text, it calls `review_new`, writes the synthesis as blocks, and calls `review_register`. |
| **Natural language — explain** | "walk me through `src/acp/inter-lane.ts`", "explain how peering works", "review the auth refactor". The **comprehension** path: the subject is existing code or a design, not necessarily a diff, and the expected output is a walkthrough with prose, not a findings list. Discoverable through the `review_new` tool description, exactly as `artifact_new` is. Also the only path that works for a **solo lane** — `#review` needs reviewer lanes. |
| **Directive-driven** (spec 124) | A lane bound to a review-shaped directive has raised propensity to answer with a Board rather than prose. Existing system-prompt layer, no new mechanism. |

**Never automatic.** A lane must not compose a Board at every turn end, on every `idle`, or after
every edit. The harness runs many lanes; unsolicited Boards are bundle spam on disk and reviewer
fatigue for the human. The guard lives in the tool description, mirroring the "do not volunteer
unsolicited dashboards" clause on `artifact_new` and the "never flag proactively" clause on
`attention_flag`.

**A clean `#review` still produces a Board — and it is not an empty one.** When every reviewer says
LGTM, the convening lane still composes a Board: prose on what the change does, a `walkthrough` of
it, metrics, zero findings. That is the *normal* shape of a review under this design, not a
degenerate case — the human learns what now exists even when nothing is wrong. It also keeps
`/reviews` a **complete** archive: an archive with holes cannot answer "did anyone ever review X?",
because a missing entry would mean both "never reviewed" and "reviewed and clean".

**Language (2026-08-14).** Both prompts also fix the language of a Board, in three parts: everything
the human reads (prose, `say:`, finding titles and their detail, decision questions and options,
metric/chart labels) is **natural Thai** — written the way a Thai engineer writes, not a word-for-word
rendering of an English sentence; **technical terms are never translated** (API/type names, tool
names, flags, paths, identifiers, and established jargon stay English inside the Thai sentence); and
the **machine-parsed grammar stays English** — fence names, field keys, and the `blocking` /
`non-blocking` / `suggestion` values, because `src/review-board/parse.ts` matches them literally and a
translated key silently degrades the block. The `review_new { title }` argument is the one carve-out:
short and latin, because `review_slug` derives the bundle directory from it and a fully Thai title
collapses to `<date>-review`.

**What every Board must contain.** The `#review` prompt and the `review_new` tool description both
require an explanation spine — at minimum, prose on *what this is and how it works*, plus a
`walkthrough` when the subject spans more than one file. A Board that is only a findings list is a
regression to what `#review` already did in turn text, and reviewers are told so explicitly.

## Opening the Board

Three ways in, so a Board is never reachable only through a transcript line that has scrolled away.

| Path | Behaviour |
|---|---|
| **Hint label on the REVIEW card** | The card `review_register` raises in the transcript is hintable like the artifact card (spec 133). Pressing its label opens the Board immediately. The path for a review that just arrived. |
| **`Leader Shift+R`** | Opens the **review picker** — a summon overlay listing bundles from `list_review_bundles` (newest first: date, title, lane, step/finding counts, status), `j`/`k` to move, `Enter` to open, `/` to filter by title. The path for reopening anything, including reviews from previous sessions. |
| **Command palette → `review.open`** | Same picker, registered as a `Window`-category action with keybinding `Leader Shift+R`, mirroring `diff.open` / `analyses.open`. |

`Leader Shift+R` keeps the `R`-for-review mnemonic while leaving `Leader r` on Resize mode, which
has owned it since the original leader map. It follows the house pattern of hanging a Shift variant
off an existing `case` (`d`/`Shift+D` for the Diff Window, `l`/`Shift+L` for the dashboard) rather
than claiming a new key. It is a **global** binding in `handleCompositorKey`, not a view-scoped
leader key, so `MARKDOWN_LEADER_KEYS` and the `validateLocalLeaderKeys` conflict check do not apply
— and could not have been satisfied by a bare `r`, which is in `GLOBAL_LEADER_RESERVED_KEYS`.

**The browser archive does not launch the Board.** `/reviews` stays a read-only, one-directional
surface (the settled decision above): it shows you what exists, and you open it in the app with
`Leader Shift+R`. A browser→app "open this one" channel would be the first write path from the archive
back into the harness, for a keystroke the picker already provides.

**Board vs archive, in one line:** `Leader Shift+R` to *work* a review, `#reviews` to *browse* them.

## Research

- **The renderer already exists.** `MarkdownContentView` (`src/markdown-view.ts`, 1408 lines)
  runs `marked` + `markedHighlight`, an in-doc search HUD (`/`, `n`/`N`), heading-hint jump (`H`),
  relative-image resolution via `convertFileSrc()`, leader-key bindings, and palette actions
  (spec 39 + 137). The Review Board reuses this pipeline and adds a block layer over it rather
  than introducing a second Markdown stack.
- **`diff2html` is already loaded and anchor-capable.** `DiffContentView` extracts
  `{ file, side, lineStart, lineEnd, quote }` from both diff2html DOM shapes (spec 158). A `diff`
  block renders through the same parser, and a `finding` carrying `file:line` can hand off to the
  Diff Window instead of re-implementing navigation.
- **A durable-bundle convention already exists.** `#analyze-github-issue` (spec 191) writes a
  lane's findings as plain Markdown into `.krypton/analyses/<owner>/<repo>/<number>/`
  (`root-cause.md`, `fix-plan.md`, downloaded resources), and spec 192 reads those bundles back by
  **walking the directory**, not from a session registry — which is exactly why they survive a
  restart. `.krypton/` is gitignored wholesale (`.gitignore:29`), so nothing pollutes the target
  repo. Review bundles adopt this layout verbatim; the artifact-style session-keyed path
  (`<harnessId>/<laneId>/<id>.html`) is deliberately **not** reused, because `hm-1/Claude-1` is
  meaningless a week later and artifacts are swept while a review result must not be.
- **The browser surface has an exact template.** Spec 192's Issue Analysis Viewer is the Docs
  browser minus the gitignore filter: `analyses_root()` + an unfiltered `WalkBuilder`,
  `analyses_index_page()` / `render_analysis_bundle()`, handlers registered in **both** the live
  router (`hook_server.rs:5164`) and the conflict-test router, an `include_str!`'d Binance-dark
  shell (`src/acp/artifact-analyses.html`) filled via `<!--SLOT-->` replacement, `html_response()`
  for headers, `validate_doc_path()` for traversal/symlink/extension guarding, plus a `#analyses`
  hash command, a `commandMeta` `surface` entry, `Compositor.openAnalyses()`, and an
  `analyses.open` palette action. `/reviews` clones all of it against `.krypton/reviews`.
- **Path-handoff is proven and auto-approved.** `artifact_new` issues a path, opens
  issued-path-only write auto-approval for the caller lane, and the harness re-stats/re-hashes on
  every observed write so the card stays current without a lane round-trip (spec 133). Reviews
  reuse this verbatim — large content never travels through MCP args or the transcript.
- **Two drain-on-idle queues already ship** — `ArtifactFeedbackQueue` (spec 149) and
  `DiffReviewQueue` (spec 158), both subscribing to `lane:status` and injecting a system turn via
  `enqueueSystemPrompt`. The review response is a third instance of the same shape.
- **Refresh has a settled rule.** ADR-0008: the Diff Window re-collects at lane quiet points
  (`harness:lane-idle`) rather than via a filesystem watcher, with a manual `r`. A live review
  file follows the same rule, so an iterating lane's edits appear without polling.
- **`#review` currently ends in prose.** `reviewRequestPrompt` (`src/acp/review.ts:136-150`) asks
  the convening lane to synthesize replies into *turn text* and record counts via
  `review_outcome`. Composing a Review Board instead is a prompt change plus a tool, not a new
  orchestration model.
- **ADR-0004 constrains the semantics.** Review output is an observation, never a score or grade.
  The Board therefore shows severities the reviewers *reported* and counts of what is unanswered —
  it never computes a quality number, ranks lanes, or renders a pass/fail badge.

**Alternatives ruled out:** (a) *render lane-authored HTML in a webview pane* (spec 102 makes this
possible) — maximum freedom, but keyboard navigation and stable anchoring into arbitrary HTML are
unsolved, the Krypton chrome/aesthetic is lost, and the harness still cannot read the content;
(b) *extend the HTML artifact + spec-149 feedback into a review surface* — keeps the review in
the browser, which the keyboard-only workflow rejects; (c) *a JSON block document* — strictly more
work for the agent than Markdown, which every model already emits natively, for no gain the
fenced blocks do not already provide.

## Prior Art

| Tool | Implementation | Notes |
|---|---|---|
| [difit](https://github.com/yoshiko-pg/difit) | Local diff viewer for the agent loop; `--comment file:line` preloads agent findings; per-comment "Copy Prompt" | Findings-into-the-view idea, but the container is still a diff — no analysis, no visuals. |
| [crit](https://crit.md) | Click any element on a rendered page, comment, agent addresses it | The annotate-anything loop; mouse-first and anchors by CSS selector — the Board anchors by block id instead. |
| GitHub PR "review summary" + inline comments | A prose body plus line-anchored threads, submitted as one review | The compose-then-submit-once model the Board's send step mirrors. |
| [Zed agent panel](https://zed.dev/docs/ai/agent-panel) | Multibuffer review of agent edits; keyboard keep/reject per hunk | Keyboard triage of agent output, code-only. |
| Jupyter / Observable notebooks | A document of typed cells — prose, code, charts — rendered inline, navigable by cell | The closest structural analogue to the block document; the Board is a *read-and-answer* notebook rather than an executable one. |
| Google Docs suggestion mode | Anchored comments + accept/reject on someone else's draft | The "respond to another author's work" interaction, mouse-first. |

**Krypton delta** — the composed review is authored by an *agent for a human*, lives in a
keyboard-only in-app window with Krypton chrome, its blocks are semantically typed so the harness
can count unanswered decisions and route findings, and the human's response goes straight back
into the same long-lived lane as a system turn. No browser, no PR, no clipboard.

## Affected Files

| File | Change |
|---|---|
| `src/review-board/parse.ts` | **New.** Pure Markdown→`ReviewBlock[]` parser: splits on `marked`'s lexer tokens, decodes typed fenced blocks, assigns stable block ids, collects parse diagnostics. |
| `src/review-board/parse.test.ts` | **New.** Block typing, malformed-block degradation, id stability across edits. |
| `src/review-board/render.ts` | **New.** Per-block DOM builders (markdown passthrough, diff via `diff2html`, finding, decision, chart→SVG, metrics, sanitized svg). |
| `src/review-board/render.test.ts` | **New.** Chart geometry, SVG sanitizer, finding/decision markup. |
| `src/review-board/view.ts` | **New.** `ReviewBoardView implements ContentView` — block cursor, keymap, comment composer, outline overlay, send-preview, live refresh. |
| `src/review-board/response.ts` | **New.** `ReviewResponse` model + `composeResponsePrompt()` (JSON-payload framing, mirroring `diff-review.ts`). |
| `src/review-board/response-file.ts` | **New.** Serialize/parse `response.md` (YAML frontmatter = state, body = generated readable rendering); debounced autosave. |
| `src/review-board/response-file.test.ts` | **New.** Round-trip, unknown-key tolerance, corrupt-frontmatter degradation, body regeneration. |
| `src/acp/review-response-queue.ts` | **New.** Drain-on-idle queue, sibling of `artifact-feedback.ts` / `diff-review.ts`. |
| `src/types.ts` | `PaneContentType` gains `'review'`. |
| `src/acp/types.ts` | `ReviewBoardRecord`, `ReviewBlock`, `ReviewResponse`, `ReviewResponseEnvelope`. |
| `src-tauri/src/hook_server.rs` | `review_new` / `review_register` / `review_cancel` MCP tools + registry, cloned from the artifact path-handoff + auto-approval + teardown paths; bundle-dir allocation (date+slug, collision suffix) and `list_review_bundles()` by directory walk (mirrors `discover_analyses_per_harness`). |
| `src-tauri/src/lib.rs` | `write_review_response` command — atomic write of `response.md` into the bundle (the frontend never gets raw FS access). |
| `src-tauri/src/hook_server.rs` (browser surface) | `reviews_root()` + unfiltered bundle walk; `reviews_index_page()`, `render_review_bundle()`, `render_review_blocks()` (fence-aware post-pass over comrak output); handlers `handle_reviews` / `handle_review` / `handle_review_asset`; register `/reviews`, `/review`, `/review-asset` in **both** routers. |
| `src/acp/artifact-reviews.html` | **New.** Binance-dark page shell cloned from `artifact-analyses.html`, own `<!--REVIEWS_*-->` slots. |
| `src/acp/hash-commands.ts` | `{ name: 'reviews', … }` in `HASH_COMMANDS`; `reviews: { category: 'surface', badges: [] }` in `commandMeta()`. |
| `src/command-palette.ts` | `reviews.open` (browser archive) mirroring `analyses.open`, and `review.open` (`Leader Shift+R`) opening the in-app review picker, mirroring `diff.open`. |
| `src/review-board/picker.ts` | **New.** Summon overlay over `list_review_bundles` — `j`/`k`, `/` filter, `Enter` opens the Board. Same shape as the diff view's file-list overlay. |
| `docs/192-issue-analysis-viewer.md` | Cross-reference: `/reviews` is a sibling surface built from the same template. |
| `src/acp/acp-harness-view.ts` | Review card in the transcript (hintable, like the artifact card); `review.response` control op → queue; open-in-window dispatch; `#reviews` branch mirroring `#analyses`; teardown on lane close / `#new`. |
| `src/compositor.ts` | `openReviewBoard(dir)` → `createContentTab`; `openReviews()` mirroring `openAnalyses()`; wire `harness:lane-idle` refresh + the response channel. |
| `src/acp/review.ts` | Step 3 of `reviewRequestPrompt` changes from "report the synthesis in your turn text" to "compose a Review Board" (`review_new` → write blocks → `review_register`), including the clean-review case; `review_outcome` is still called with the same counts. |
| `src/styles/review-board.css` | **New.** Block chrome, cursor tint, chips, chart/metric styling (Krypton Dark; DESIGN.md). |
| `CONTEXT.md`, `docs/PROGRESS.md`, `docs/133`, `docs/145`, `docs/158` | Glossary entry + cross-references. |

## Design

### Storage layout

One gitignored bundle per review round, keyed by **date + slug of the title** — human-meaningful
and chronologically sortable, with no session identifiers in the path:

```
.krypton/reviews/
  2026-08-07-peering-guard-rewrite/
    review.md        # the lane's composition (blocks) — written by the lane
    response.md      # the human's answers — written by the Board
    assets/          # images the lane attached, if any
  2026-08-07-peering-guard-rewrite-2/   # same-day title collision → numeric suffix
  2026-07-30-mcp-bridge-init-split/
```

`review.md` carries a small frontmatter stamp (`title`, `lane`, `subject`, `created`) so a bundle
is self-describing on disk. `response.md` is **one file with two halves**:

```markdown
---
review: 2026-08-07-peering-guard-rewrite
responded_at: 2026-08-07T14:22:10+07:00
note: ship 1 plus the regression test, park the rest
findings:
  - block: b7-9f2a1c
    state: accepted
  - block: b11-31de00
    state: dismissed
decisions:
  - block: b9-4c11ab
    chosen: 2
comments:
  - block: b8-77aa02
    quote: "await this.deliver(envelope);"
    body: add a regression test for the interleaved send
---

<!-- generated from the frontmatter above; edit answers in the Review Board, not here -->

## Answers
- **accepted** · guard is set after the await — `src/acp/inter-lane.ts:835`
- **dismissed** · extract the id hash — `src/review-board/parse.ts:44`
- **decision** · per-target vs global guard → *2 · global — serializes fan-out*
…
```

**The frontmatter is the source of truth; the body is a generated readable rendering** and is
rewritten on every save. This keeps the bundle greppable and `cat`-able like an analysis bundle
while still restoring exact state when the Board reopens. Answers **autosave** (debounced ~400 ms)
as they are made, so closing the window never loses work — sending is a separate, explicit act.

Reviews are **never swept**. Artifacts have a `swept` state (spec 133) because they are throwaway
views; a review result is a record, so the bundle persists until the human deletes it. Because
`.krypton/` is gitignored, bundles never enter the target repo's history.

### Document format

An ordinary Markdown file. Top-level structure is whatever the lane writes; the parser walks
`marked`'s token stream and emits one `ReviewBlock` per top-level token, upgrading fenced code
blocks whose info string names a review type.

````markdown
# Peering guard rewrite — review

The change moves the per-target guard after the `await`, which reopens the double-send
window we closed in spec 106. Two call sites are affected.

```review:metrics
files: 6 changed, +214 / -38
tests: 41 passed, 0 failed
new deps: none
```

```review:walkthrough
title: read it in this order
steps:
  - at: src/acp/inter-lane.ts:812
    say: the guard map — one entry per in-flight target, this is the whole concurrency model
  - at: src/acp/inter-lane.ts:835
    say: the send path; note the guard now moves after the await (the change under review)
  - at: src/acp/lane-inbox.ts:96
    say: where the delivered envelope lands, and why a duplicate is not idempotent here
```

```review:finding
severity: blocking
file: src/acp/inter-lane.ts
line: 835
title: guard is set after the await
```
A second `peer_send` to the same target can enter between the check and the set.
Set the guard synchronously before any `await`.

```review:chart
kind: bar
title: lines changed by area
data:
  acp/: 152
  diff-view: 41
  compositor: 21
```

```diff
@@ -829,10 +829,14 @@
-  this.inFlight.set(target, envelope);
-  await this.deliver(envelope);
+  await this.deliver(envelope);
+  this.inFlight.set(target, envelope);
```

```review:decision
question: keep the guard per-target, or make it global while a fan-out is in flight?
options:
  - per-target (today) — allows parallel fan-out, keeps the race surface
  - global — serializes fan-out, simplest to reason about
recommended: 1
```
````

Block bodies are YAML-ish `key: value` (and `key:` + indented list/map) — the shape agents emit
most reliably. A block that fails to parse degrades to a plain code block with a diagnostic chip;
it is never dropped and never throws.

### Data Structures

```ts
// src/acp/types.ts
export type ReviewBlockKind =
  | 'markdown' | 'walkthrough' | 'diff' | 'finding' | 'decision' | 'chart' | 'metrics' | 'svg';

export interface ReviewBlock {
  /** Stable within a document: `b${ordinal}-${fnv1a(rawSource)}`. Survives edits
   *  elsewhere in the file, so comments/triage re-attach after the lane iterates. */
  id: string;
  kind: ReviewBlockKind;
  /** Original fenced/markdown source — the escape hatch and the diagnostic view. */
  raw: string;
  /** Decoded payload; shape depends on `kind`. Absent when parsing failed. */
  data?: ReviewBlockData;
  /** Non-fatal parse complaint shown as a chip on the block. */
  diagnostic?: string;
}

/** The comprehension spine: an ordered tour of the code, each step anchored. */
export interface ReviewWalkthroughBlock {
  title?: string;
  steps: {
    /** `path` or `path:line` (or `path:lineStart-lineEnd`), repo-relative. */
    at: string;
    /** What this location does / why it matters — one or two sentences. */
    say: string;
  }[];
}

export interface ReviewFindingBlock {
  severity: 'blocking' | 'non-blocking' | 'suggestion';
  title: string;
  file?: string;
  line?: number;
}
export interface ReviewDecisionBlock {
  question: string;
  options: string[];
  /** 1-based index of the lane's recommendation, if it made one. */
  recommended?: number;
}
export interface ReviewChartBlock {
  kind: 'bar' | 'line' | 'sparkline';
  title?: string;
  data: { label: string; value: number }[];
}

/** What the human sends back — and, verbatim, what `response.md`'s frontmatter
 *  holds. One shape serves both the wire and the file, so a reopened bundle
 *  restores exactly what was sent (or what was answered but not yet sent). */
export interface ReviewResponse {
  reviewId: string;
  /** Free-text note typed in the send preview, optional. */
  note?: string;
  comments: { blockId: string; quote: string; body: string }[];
  findings: { blockId: string; state: 'accepted' | 'dismissed' }[];
  decisions: { blockId: string; chosen: number }[];
  /** Set when the response was last handed to the lane; absent while it is only
   *  autosaved. Lets a reopened Board distinguish "answered" from "delivered". */
  sentAt?: number;
}

/** One bundle discovered by walking `.krypton/reviews/` (no session registry). */
export interface ReviewBundle {
  /** Directory name — the durable id, e.g. `2026-08-07-peering-guard-rewrite`. */
  slug: string;
  dir: string;
  title: string;
  laneName: string;
  createdAt: number;
  /** Present once the human has answered anything. */
  respondedAt?: number;
  counts: { blocks: number; findings: number; decisions: number; unanswered: number };
}
```

### API / Commands

Three MCP tools on `krypton-harness-bus`, mirroring `artifact_*` exactly (same registry, same
issued-path write auto-approval, same close/`#new` teardown, same `#restart` survival):

| Tool | Input | Returns |
|---|---|---|
| `review_new` | `{ title, subject? }` | `{ id, slug, dir, path }` — `dir` is the bundle, `path` is `<dir>/review.md` |
| `review_register` | `{ id }` | `{ ok, id, slug, size, hash, blocks, findings, decisions }` |
| `review_cancel` | `{ id }` | `{ ok }` (pending only; also removes the empty bundle dir) |

Write auto-approval covers the whole bundle directory, not one file — the lane may add
`assets/diagram.png` and reference it from `review.md`.

Two Tauri commands (the frontend never touches the filesystem directly):

```
write_review_response { dir, response }  → { ok }      // atomic: temp file + rename
list_review_bundles   { cwd }            → ReviewBundle[]   // directory walk, newest first
read_review_bundle    { dir }            → { review: string, response?: ReviewResponse }
```

One harness control op: `review.response { reviewId, response }` → queue → system turn.
Note the split of duties: **the file write is the Board's own job and happens immediately**; the
control op only delivers the response to the lane. A review whose lane has died is still fully
recorded on disk.

Reviews are **not** served over HTTP (unlike artifacts, spec 149) — the surface is in-app, so
there is no browser origin to satisfy and no token to issue.

### Data Flow

```
1. Lane calls review_new { title } → allocates `.krypton/reviews/<date>-<slug>/`, returns
   `{ id, slug, dir, path }`; the harness opens write auto-approval for that directory
   and records a `pending` entry
2. Lane writes review.md with its normal file tool (iterating across turns is expected)
3. Lane calls review_register { id } → validation, `pending → registered_live`, a hintable
   REVIEW card appears in the transcript with block/finding/decision counts
4. Human opens it — the card's hint label, or `Leader Shift+R` → review picker → Enter — and the
   compositor creates a Review Board content tab
5. parse.ts turns review.md into ReviewBlock[]; response.md (if any) is read back and its
   answers re-attached by block id; render.ts builds the DOM; the block cursor starts at
   the first unanswered finding/decision, or block 1
6. Human walks it: n/N between blocks, c comments, a/x triages findings, 1-9 answers
   decisions, Enter on an anchored finding jumps the Diff Window to file:line
7. EVERY answer schedules a debounced write_review_response → response.md on disk.
   Closing the window now loses nothing
8. `s` opens the send preview (everything about to go, plus an optional note); confirm
   stamps `sentAt`, writes response.md once more, and sends `review.response` →
   ReviewResponseQueue.accept()
9. The queue drains on the lane's next idle into a system turn; the lane edits code and/or
   review.md
10. `harness:lane-idle` re-reads review.md; the Board re-parses and re-renders, preserving
    the cursor and re-attaching answers by block id (ADR-0008 refresh rule, manual `r` too)
11. Days later: `list_review_bundles` finds the bundle by directory walk — no session state
    involved — and the Board reopens it with every answer intact
```

### Browser surface — `/reviews`

A read-only loopback archive, cloned from spec 192's Issue Analysis Viewer.

```
GET /reviews                                   → index: every bundle, newest first
GET /review?harness=<id>&slug=<slug>[&file=review|response]
                                               → one bundle: file strip + rendered document
GET /review-asset?harness=<id>&path=<rel within .krypton/reviews>
                                               → png/jpg/jpeg/gif/svg/webp from assets/
```

All three take `harness` like `/docs` (defaults to the first harness). Opened with `#reviews`
(a `surface`-category hash command) or the `reviews.open` palette action; `validate_doc_path`
guards traversal, symlinks, and extensions exactly as the analyses routes do.

**Index page** — one row per bundle, newest first, showing what the human actually needs to
triage across reviews:

```
2026-08-07   peering guard rewrite        Codex-2    11 blocks · 3 steps    ✓ sent    2 unanswered
2026-08-05   inter-lane peering explained Claude-1    9 blocks · 6 steps    reference
2026-08-05   mcp bridge init split        Claude-3    7 blocks · 2 steps    ⋯ answered, not sent
2026-07-30   telegram allowlist audit     Codex-1    14 blocks · 4 steps    ✓ sent    —
2026-07-28   live-assist chrome pass      Cursor-1    5 blocks · 3 steps    · never opened
```

Walkthrough step count sits next to the block count, because on a comprehension Board it is the
better measure of "how much is here to read". Status comes from `response.md`: absent →
`never opened`; present without `sentAt` → `answered, not sent`; present with `sentAt` → `sent`.
A Board with no findings and no decisions has nothing to answer and is labelled **`reference`**
rather than given a status — it is an explanation to come back to, not a task.

This page answers two questions the in-app Board cannot, because it only ever shows one review:
**"which reviews did I leave hanging"** and **"has anyone explained this part of the code before?"**

**Bundle page** — a two-entry file strip (`review` · `response`, active one marked) over the
rendered document, plus an asset strip. `response.md` renders its generated body; the frontmatter
is shown as a small summary card at the top (the same front-matter card the Docs browser already
renders).

**Rendering the typed blocks in Rust.** comrak would emit `review:finding` as a plain code block,
so `render_review_blocks()` post-processes the known fences into simple semantic HTML — an ordered
list with monospace anchors for `walkthrough`, a bordered card for `finding` (severity in the
heading colour, never a left rail), an ordered list for `decision` with the chosen option marked,
a definition row for `metrics`, prefix-coloured lines for `diff`, and sanitized passthrough for
`svg`. Walkthrough anchors were plain text in the browser (no jump target exists outside the app);
**since spec 217 they carry the source lines inline instead** — there is still no jump target, so the
code comes to the anchor rather than the reader going to the code. **`chart` deliberately does not reuse the
frontend's SVG geometry**: the browser renders it as label/value rows with proportional CSS bar
widths (and `line`/`sparkline` fall back to a plain table). Two presentations of the same data,
no shared geometry code to drift — the browser is an archive, not a pixel-faithful mirror.
An unknown fence stays a plain code block, same as in the Board.

### Keybindings

| Key | Action |
|---|---|
| `j` / `k` | Scroll |
| `n` / `N` | Next / previous block (moves the block cursor) |
| `}` / `{` | Next / previous **unanswered** finding or decision |
| `Tab` / `Shift+Tab` | Next / previous **walkthrough step** — the guided read; each step scrolls the Diff Window to its anchor if one is open |
| `g` / `G` | Top / bottom |
| `Enter` | Context action: expand a folded block; on an anchored finding, open the Diff Window at `file:line` |
| `c` | Comment on the focused block (selection quoted if any, else the block's head) |
| `a` / `x` | Accept / dismiss the focused finding |
| `1`…`9` | Answer the focused decision with that option |
| `o` | Outline overlay — block list with kind + answered state, `j`/`k` + `Enter` to jump |
| `/` `n` `N` | In-doc search (inherited from the Markdown Viewer, spec 137) |
| `s` | Send preview → confirm to send the response |
| `r` | Reload the file now |
| `q` / `Esc` | Close |

### UI

A single reading column in Krypton Dark chrome — **no persistent sidebar** (it would steal width
from the content, and the outline is one keystroke away).

- **Header:** `REVIEW // <title>` · authoring lane · `block 4/17` · `2 unanswered` · sync age.
- **Block cursor:** the focused block takes a full-width background tint (`rgba(accent, .10)`) —
  no left accent rail, per the house rule.
- **Walkthrough block:** numbered steps, each `at` rendered as a dim monospace anchor and `say` as
  the explanation. The current step (driven by `Tab`) takes an accent tint; `Enter` opens its
  anchor in the Diff Window. This is the block the human reads first, so it renders full-width and
  is never folded.
- **Finding block:** severity chip (`BLOCK` error accent / `WARN` amber / `SUGG` muted), title,
  optional `file:line` in the corner, state glyph (`·` open, `✓` accepted, `✗` dismissed).
- **Decision block:** the question, then numbered options; the lane's recommendation is marked
  `rec`; the chosen one takes an accent tint. Unanswered decisions are what `}` hunts.
- **Chart / metrics:** inline SVG generated by `render.ts` (bar / line / sparkline) and a stat
  row; palette from the `dataviz` skill's accessible defaults, mapped onto Krypton Dark tokens.
- **`svg` block:** rendered inline after sanitization (allowlisted elements/attributes; no
  `<script>`, no `<foreignObject>`, no external references).
- **Comment marks:** a commented block shows a `✎ n` chip in its corner; the comments themselves
  live in the send preview, not inline, so reading stays uncluttered.
- **Save state:** a muted right-hand segment reads `saved` / `saving…` / `not sent yet` — the
  answers are on disk continuously, and `s` is what hands them to the lane. The bundle slug is
  shown in the header so the human knows the on-disk name without leaving the window.

### Configuration

None.

## Edge Cases

- **Malformed typed block** — renders as a plain code block with a diagnostic chip; the document
  still opens. Parsing never throws (a review is the lane's output, and half a review beats none).
- **Unknown `review:*` kind** — same treatment; forward-compatible with newer lanes.
- **Lane edits the file while the Board is open** — refresh on `harness:lane-idle` (+ `r`), block
  ids re-attach comments/answers; answers on blocks that vanished are dropped from the response
  with a one-line notice at the top of the send preview.
- **Empty document / no blocks** — empty state: `no blocks yet — the lane is still composing`.
- **Board with no findings and no decisions** — the normal comprehension case, not an error. The
  header shows `reference` instead of an unanswered count, `}` reports nothing to answer, and `s`
  sends only comments and the note (or no-ops). `Tab` still walks the steps.
- **Walkthrough anchor that no longer resolves** (file moved, line gone) — the step renders with a
  dim `drifted` mark and `Enter` opens the file at its top instead of the line; the explanation
  text is still worth reading, so the step is never hidden.
- **Walkthrough step pointing outside the working diff** — expected on a comprehension Board over
  existing code. `Enter` opens the file in the Markdown/editor path rather than the Diff Window,
  since there may be no diff at all.
- **`s` with nothing answered** — allowed; sends just the note, or no-ops with a notice if the
  note is empty too.
- **Send while the lane is busy** — queued, drained on next idle, exactly as spec 158.
- **Lane closes / `#new`** — the *registry* entry is dropped (same teardown path as artifacts) but
  **the bundle on disk is untouched**: `review.md` and every answer stay. An open Board keeps
  working and keeps autosaving; only `s` reports `no-live-lane`, and the response is already
  recorded for a later lane to read.
- **Bundle deleted or renamed under the app** — the Board detects the missing directory on its
  next save, shows a banner, and keeps the response in memory so a re-created bundle can take it.
- **Corrupt / hand-edited `response.md` frontmatter** — parsed leniently: unknown keys ignored,
  malformed entries skipped with a count in a banner, the rest restored. A totally unparseable
  frontmatter is backed up to `response.md.bak` and a fresh response starts, so a bad edit never
  blocks the review.
- **Body of `response.md` hand-edited** — silently overwritten on the next save; the frontmatter is
  the source of truth and the body says so in a generated comment line.
- **Title collides on the same day** — bundle dir gets a `-2`, `-3` suffix; the slug in the
  registry always matches the directory actually created.
- **Two lanes compose reviews concurrently** — separate bundles by construction (distinct titles →
  distinct slugs; identical titles → suffix), so no interleaved writes.
- **Untrusted content** — every field in the response is serialized into one JSON payload behind
  a trusted framing line (`composeResponsePrompt`, copied from `diff-review.ts`), so a hostile
  quote cannot break framing. Inbound `svg`/markdown is sanitized before insertion.
- **Huge document** — blocks render lazily below the fold (`content-visibility: auto`), and a
  `diff` block over ~2,000 lines renders a summary with `Enter` to expand, per the 16ms budget.
- **Browser open while the Board is answering** — `/reviews` reads from disk on each request with
  `no-store` headers (the loopback standard), so a refresh always shows the latest autosave. No
  push, no SSE; the archive does not need to be live.
- **Bundle with no `review.md`** (lane called `review_new` then died before writing) — the index
  shows it as `never composed` and the bundle page renders an empty state rather than 404-ing.
- **Two Boards open on the same review** — last writer wins on `response.md` (both autosave the
  full response, so no partial merge is possible); a Board that sees a newer `respondedAt` on disk
  than its own shows a banner offering `r` to reload. Sends stay per-window, de-duped per comment
  id by the queue.

## Out of Scope

- **Interactive/scripted content.** Blocks are declarative and sanitized; no JS in a review. When
  the lane needs genuine interactivity it emits an HTML artifact (spec 133) and links to it.
- **Human-authored reviews.** V1 is lane→human. A human composing a Board for a lane can come later.
- **Composing a Board from the Diff Window.** A key in the Diff Window that asks a lane "review
  what I'm looking at into a Board" is a plausible fourth trigger, deliberately deferred — the
  three above cover the workflow, and adding a cross-surface command before the Board exists would
  be speculative.
- **Answering a review from the browser.** `/reviews` is read-only. The Docs browser has inline
  feedback (spec 172) and artifacts have theirs (spec 149), so the precedent exists — but two
  writers to one `response.md` is a merge problem with no good keyboard-first payoff. Triage stays
  in the Board; the browser is the archive.
- **Search / filter across reviews.** The index is a chronological list; no full-text search over
  bundles, no filter by lane or status. Browser `Ctrl+F` covers the MVP.
- **Retention, sweeping, or size limits on `.krypton/reviews/`.** Bundles accumulate until the
  human deletes them, exactly like `.krypton/analyses/`. No TTL, no cap, no auto-prune.
- **Committing review bundles.** `.krypton/` stays gitignored; sharing a review with a team is out
  of scope.
- **Replacing the Diff Window, the `Leader '` matrix, or the `Leader /` roll-up.** They keep their
  roles; the Board links into the Diff Window rather than absorbing it.
- **Unifying the three drain-on-idle queues** (artifact feedback, diff review, review response)
  into one — a worthwhile follow-up refactor of already-shipped code, deliberately not bundled here.
- **Any score, grade, or pass/fail badge** — ADR-0004 stands.
- **Serving reviews over loopback HTTP / a browser view** — the surface is in-app by design.

## Implementation notes (2026-08-07)

Everything above landed as specified except where noted here.

- **`Leader Shift+R`, not `Leader r`.** See the corrected note at the top of this spec.
- **Tauri commands.** Five, not three: `write_review_response { dir, contents }`,
  `read_review_bundle { dir }`, `list_review_bundles { harnessId }`,
  `acp_refresh_review { harnessId, laneLabel, id }`, and
  `acp_cancel_pending_reviews { harnessId, laneLabel }`. Plus
  `backup_review_response { dir }`, which the spec implied but did not name: the Board calls it the
  moment it reads a `response.md` whose frontmatter is unparseable, so the file is moved aside
  *before* the first autosave can overwrite it rather than at some later save.
  `write_review_response` takes the fully-serialized file text, not a `ReviewResponse` — the
  frontmatter/body split is a frontend concern, so exactly one implementation of it exists.
- **`list_review_bundles` is keyed by `harnessId`, not `cwd`.** The review store already holds each
  harness's project dir, so the caller does not have to supply (and possibly disagree about) one.
- **Bundle path validation.** `resolve_review_dir` canonicalizes a caller-supplied directory and
  requires its *parent* to be a canonical review root of some live harness. That rejects the project
  root, the review root itself, `assets/`, and any unrelated directory — the two bundle-file commands
  have no other gate.
- **`review_cancel` reclaims only an untouched bundle.** The spec said cancel "also removes the empty
  bundle dir"; the implementation removes it only when `review.md` still counts zero blocks and the
  directory holds nothing else. Abandoning a draft the lane *did* write into must not delete work, and
  the `/reviews` index labels such a bundle `never composed`.
- **Write auto-approval is a directory prefix.** `reviewWritePathMatches` grants writes anywhere under
  the issued bundle (so `assets/` works), with a trailing-slash boundary so a sibling bundle sharing a
  name prefix (`…-guard-rewrite-2`) cannot match a grant issued for `…-guard-rewrite`. A relative
  target must carry the project-relative bundle prefix; a bare `review.md` fails closed into a normal
  permission prompt rather than being guessed at.
- **No card rehydration.** Unlike artifacts (spec 173), review cards are not replayed from disk at
  harness start: a review is reopened through the picker, so replaying every past bundle as a
  transcript card would be noise. The bundles are still all findable — that is the picker's job.
- **A registered review's card never goes "unavailable".** The artifact card has that state because an
  artifact is swept; a review bundle is a record, so the card stays openable after the lane dies.
- **`ReviewBlock` is a discriminated union** on `kind` rather than the spec's
  `{ kind, data?: ReviewBlockData }`, so `data` narrows without a cast and a decoder returning the
  wrong payload is a compile error. Field names are otherwise as specified. `ReviewFindingBlock`
  gained `detail?`, holding the prose paragraph that follows the fence.
- **`ReviewResponseEnvelope` gained `blockLabels`** — a human-readable label per answered block id.
  Without it the lane receives opaque ids like `b7-9f2a1c` and has to re-read `review.md` to learn what
  was accepted.
- **Block re-attachment.** Ids are `b<ordinal>-<fnv1a(raw)>` as specified. Because inserting a block
  shifts every following ordinal, `reattachBlockId` falls back from an exact id match to a **unique**
  hash match; an ambiguous hash (the lane duplicated a block verbatim) is left unattached rather than
  guessed at, and the answer is reported as dropped.
- **Backend block counts are approximate by design.** `count_review_blocks` is a fence-aware line scan,
  not a Markdown parse: it feeds a card label and an index row, while the authoritative parse is
  `src/review-board/parse.ts`. It is deliberately strict about fences, so a `review:finding` *mentioned
  in prose* is not counted and a nested fence cannot open a phantom block.
- **`svg` sanitization differs between the two surfaces, deliberately.** In-app, `sanitizeSvg` uses
  `DOMParser` and strips disallowed elements/attributes, keeping the rest. In the browser archive there
  is no DOM, so `render_rv_svg` refuses a suspicious document *whole* and shows its escaped source —
  which is still informative in an archive. Both allowlist the same vocabulary.
- **Test coverage note.** This repo has no DOM test environment, so `render.test.ts` covers the
  renderer's *pure* core — chart geometry (including the truncated-axis and divide-by-zero cases) and
  the sanitizer's policy predicates — rather than feeding markup through `DOMParser`. Adding jsdom for
  this one file was not worth a new dev dependency.
- **Not implemented from the spec's Edge Cases:** the "two Boards open on the same review" reload
  banner. `Compositor.openReviewBoard` is idempotent on the slug — a review already open is focused
  rather than opened twice — so the second Board cannot exist within one app instance.
  `ReviewBoardView.hasNewerResponseOnDisk` is in place for the cross-instance case, but nothing calls
  it yet; two app instances over one repo would still be last-writer-wins.

## Resources

- [Using Claude Code: the unreasonable effectiveness of HTML](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) —
  the argument behind spec 133 that structured visual output beats prose; the Board applies it in-app.
- [crit](https://crit.md) — annotate-anything review loop; its CSS-selector anchoring is the failure
  mode block ids avoid.
- [difit](https://github.com/yoshiko-pg/difit) — findings preloaded into a local review view.
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) — keyboard triage of agent output.
- [marked](https://marked.js.org/) / [diff2html](https://diff2html.xyz/) — the already-pinned
  renderers the Board composes; `marked`'s lexer is what makes block-level splitting cheap.
