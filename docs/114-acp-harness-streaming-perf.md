# 114. ACP Harness Streaming Performance Audit & Fixes

> Status: Implemented (rev 4 — append-only stream body + body-only RAF; Claude-1 flicker review)
> Date: 2026-05-22
> Milestone: ACP harness — performance hardening
> Builds on: Spec 94 (render batching + caching), Spec 103 (tail-window rendering)
> Amended (assistant kind only) by: Spec 117 — assistant rows now use optimistic streaming-markdown rendering instead of plain-until-seal. Thought / user rows still follow §1 of this spec.

## Problem

User reports: "when transcript grows, app performance is ruined."

Specs 94 and 103 already addressed two prior pain points:

- 94 added RAF coalescing in `scheduleRender()` and markdown HTML caching on
  non-streaming rows.
- 103 added a 60-row tail DOM window so `renderActiveTranscript()` only
  diff-renders the visible tail.

There is also an existing **300-row cap** on `lane.transcript` itself
(`acp-harness-view.ts:3580-3585`), so the JS array does not grow unbounded.
That bounds the cost of every full-transcript walk in the file.

However, a perf-checklist audit of `src/acp/acp-harness-view.ts` (6385 LOC)
identified four cost centers that **scale with single-message length** rather
than row count. These remain hot even with the 300-row cap and 60-row DOM
window, because they re-do per-frame work on the **streaming row's growing
text content**.

## Audit findings (perf-checklist)

Full table is captured in lane conversation; the load-bearing failures are:

1. **§7.2 / §1.1 — Streaming row rebuilds on every RAF.**
   - `renderActiveTranscript()` (`:2826`) reuses the streaming row's wrapper
     element across chunks (an explicit optimisation from Spec 94), but
     `renderTranscriptItem()` (`:4643-4658`) still re-runs
     `md.parse(item.text, { async: false })` and rewrites `innerHTML`
     whenever `item.markdownSource !== item.text`. During streaming, text
     changes every chunk, so the cache never hits.
   - As the assistant message grows from 1 KB → 30 KB, each per-frame
     reparse grows linearly. Across a full turn this is roughly quadratic
     in message size — the dominant cost as transcript content "grows".
   - Sync parse with `{ async: false }` also blocks input on the main thread.

2. **§6.3 — `onTranscriptScroll` has no throttle.**
   - Handler (`:4370-4379`) reads `scrollHeight`, `scrollTop`,
     `clientHeight`, then calls `captureTranscriptScrollAnchor` which loops
     `getBoundingClientRect` over every rendered transcript row, on every
     scroll event. Fast scroll on a 60-row tail drops frames.

3. **§3.x / §6.2 — `updateToolTick` walks transcript on every tool event.**
   - `lanes.some(... transcript.some(...))` (`:3356-3365`) is called from
     `renderTool` on every tool delta. Bounded by 300, but still O(rows ×
     lanes) per tool event. Easy to replace with a counter.

4. **§5.4 — No CSS `contain:` on transcript surfaces.**
   - `.acp-harness__lane-body` and `.acp-harness__msg` have no containment.
     Long, dynamic content can ripple paint/layout into adjacent chrome.

Secondary (non-critical) findings logged in audit but **out of scope for
this spec**: `chipTimer` not cleared in `dispose()`; anonymous-arrow
listeners with no removeEventListener; lane transcript Maps not cleared on
dispose; metricsTimer always-on at 2 s.

## Goals

- Streaming an assistant message of arbitrary length must not degrade
  keypress-to-render budget below 16 ms.
- Scrolling a long transcript must hold 60 fps.
- No regression in correctness: cached markdown render, sticky-scroll,
  tail-window indicator, and resume/load flows all continue to work.
- Pure frontend, single-file change set; no protocol, no backend.

## Non-goals

- Increasing or removing the 300-row `lane.transcript` cap.
- Persisting transcripts across app restart.
- Refactoring dispose / listener hygiene (tracked separately).
- Changing the 60-row DOM tail window default.

## Solution

Four targeted changes, ordered by expected impact.

### 1. Throttle streaming-row markdown reparse + special-case streaming update path

This is two coupled changes, not one. Throttling `md.parse` alone is
insufficient because `transcriptRenderSignature()` includes raw `item.text`,
so the streaming row's signature changes every chunk, which forces
`renderActiveTranscript()` to rebuild label + body and run
`replaceChildren(...)` on every coalesced render even if the parsed HTML
hasn't changed.

**State** — add to `HarnessTranscriptItem` (transient, not serialised):

- `lastMarkdownAt: number` — timestamp of last successful reparse.
- `streamPlainSource: string` — last raw text written via the textContent
  fallback. Distinct from `markdownSource`, which continues to mean "last
  text actually parsed into `markdownHtml`."

**Render path** — `renderActiveTranscript()` (`:2826`) gains a streaming
fast path. **Critical:** the fast path must execute as an early branch
**before** the existing `dataset.renderSignature === signature` compare at
`:2877`. If it only runs inside the signature-mismatch branch, the second
chunk onward will match `'stream'` against `'stream'` and hit the no-op
`previous = current` branch — the visible body would freeze. Pseudocode:

```ts
for (const item of itemsToRender) {
  expected.add(item.id);
  const streaming = item.id === lane.currentAssistantId
    || item.id === lane.currentThoughtId
    || item.id === lane.currentUserId;
  const current = existing.get(item.id) ?? null;

  // EARLY BRANCH — streaming assistant fast path
  if (current && item.kind === 'assistant'
      && item.id === lane.currentAssistantId) {
    const body = current.querySelector<HTMLElement>('.acp-harness__msg-body');
    if (body) {
      updateStreamingAssistantBody(body, item);          // see below
      current.dataset.renderSignature = 'stream';
      lane.seenTranscriptIds.add(item.id);
      previous = current;
      continue;
    }
  }

  // ...existing signature compare / rebuild path unchanged...
}
```

`updateStreamingAssistantBody(body, item)`:

- If `now - item.lastMarkdownAt >= MARKDOWN_STREAM_INTERVAL_MS`
  (400 ms, ≈2.5 Hz): call `md.parse(item.text, { async: false })`, set
  `item.markdownHtml`, `item.markdownSource`, `item.lastMarkdownAt = now`,
  write `body.innerHTML = item.markdownHtml`,
  `body.classList.remove('acp-harness__msg-body--stream-plain')`,
  `body.classList.add('acp-harness__msg-body--markdown')`.
- Otherwise: set `body.textContent = item.text`, set
  `item.streamPlainSource = item.text`,
  `body.classList.remove('acp-harness__msg-body--markdown')`,
  `body.classList.add('acp-harness__msg-body--stream-plain')`. The
  `--markdown` class must be removed (not just have `--stream-plain`
  added) — otherwise stale block styles from a prior markdown frame
  remain when the body is now raw text.

The `existing` Map (`:2833-2837`) and the `expected` Set / stale-row
removal loop (`:2901-2903`) are unaffected — the row id is still added to
`expected`, so the cleanup loop does not touch the streaming row.

**Seal path** — `sealStreaming(lane)` (`:3664`):

- **Capture the assistant id BEFORE nulling.** Read
  `const assistantId = lane.currentAssistantId;` first, then null the
  three `current*Id` fields. Without this, the lookup for "the row that
  was just streaming" would fail.
- Find the assistant item by id and clear its `markdownSource` (set to
  `undefined` or null) so the next non-streaming render path is
  guaranteed to reparse. Do not touch `streamPlainSource`.
- Call `scheduleLaneRender(lane)` at the end of `sealStreaming` to
  guarantee the final markdown render. Normal `stop` events already
  schedule a render (`:1836`) and resume/load already calls `render()`
  after seal (`:2446`), but seal directly schedules its own to be safe.

**Background-lane caveat (pre-existing, documented not fixed).**
`scheduleLaneRender` no-ops for non-active lanes (`:2753-2755`). If a
sealed assistant lives on a background lane, the final markdown render
runs lazily when the user activates that lane. Acceptable for V1; not
introduced by this spec.

**Fallback styling** — `src/styles/acp-harness.css`:

- `.acp-harness__msg-body--markdown` keeps its current styling.
- Add `.acp-harness__msg-body--stream-plain { white-space: pre-wrap; }`.
  Without this, the throttled fallback would collapse newlines and code
  fences (the markdown class uses `white-space: normal`).

**Non-streaming rows** — unchanged. Existing cache hit on
`markdownSource === text` keeps current behaviour for sealed messages and
non-active rows.

**V1 scope: assistant streaming only.** `thought` and `user` streaming
rows go through the existing rebuild path; their signatures include
`item.text` (`transcriptRenderSignature`, `:4748`), so they still
`replaceChildren` every coalesced render. Thought messages are typically
short and user messages are bounded by composer input, so the cost is
acceptable for V1. If thought-heavy sessions become a problem, the same
in-place + stable-signature pattern extends to `currentThoughtId`
without further design work.

Effect: bounds per-frame work to a single `textContent =` assignment most
frames, with a markdown reparse only at the throttle cadence and at seal.
Decouples streaming row render cost from message length.

### 2. RAF-throttle `onTranscriptScroll`

`onTranscriptScroll` (`:4370-4379`):

- Add a `scrollHandlerRaf: boolean` flag on the view.
- On scroll, if `scrollHandlerRaf` is true, return. Otherwise set it,
  `requestAnimationFrame()` the existing body, clear the flag in the RAF
  callback.
- **Re-read live state inside the RAF callback** — `activeLane()`,
  `activeTranscriptBody()`, and `suppressScrollListener` can all change
  between the scroll event firing and the frame deadline. Without this,
  the throttled handler may write `savedScrollAnchor` to a stale lane or
  fight a programmatic scroll. Treat the scroll event as a "go look later"
  signal, not as a snapshot.

Effect: collapses scroll-event storms into one anchor capture per frame.

### 3. Cache `activeToolCount` on lane state

> **Note** — this is a cleanup, not a likely user-visible slowdown. The
> scan is bounded by 300 rows and only fires on tool deltas. Codex-1's
> review correctly downgraded its priority relative to (1) and (2).

- Add `activeToolCount: number` to `HarnessLane`.
- Compute the mutation as a **before/after delta** around the tool update
  in `renderTool()` (`:3670`):
  - `const wasActive = target.toolStartedAt !== undefined && target.toolEndedAt === undefined;`
  - apply updates to `target`
  - `const isActive = target.toolStartedAt !== undefined && target.toolEndedAt === undefined;`
  - `if (wasActive !== isActive) lane.activeToolCount += isActive ? 1 : -1;`
  - This handles new active tool, ongoing update, and completion uniformly.
- **Handle the 300-row cap drift.** `appendTranscript()` (`:3580-3585`)
  drops the oldest row via `transcript.shift()`. If the dropped row is an
  active tool, `activeToolCount` must decrement, and `toolTranscriptIds`
  must drop the stale mapping so a later update for that tool doesn't
  reuse the dropped row's id. Add this cleanup inline in
  `appendTranscript()` whenever a tool row is shifted out.
- `updateToolTick()` (`:3356-3365`) becomes
  `this.lanes.some((l) => l.activeToolCount > 0)`.
- Dev assertion (debug builds only): assert
  `lane.activeToolCount === lane.transcript.filter(i => i.kind === 'tool' && i.toolStartedAt !== undefined && i.toolEndedAt === undefined).length`
  after each `renderTool()` and after each `appendTranscript()` shift.

Effect: removes the recurring O(rows) scan; bounded-cost change.

### 4. CSS containment on the scroll container only

`src/styles/acp-harness.css`:

- `.acp-harness__lane-body { contain: layout paint; }`. The lane body is
  the scroll container; nothing visible should overflow its bounds, so
  `paint` containment is safe and yields the largest paint-region win.

**Row-level containment dropped.** An earlier rev proposed
`.acp-harness__msg { contain: layout; }` as a Pass B. Cursor-1's review
correctly noted that each row is already a shallow subtree, and `layout`
containment does not isolate the row's own `translateY(4px)`
row-entrance animation (which lives on the same element). The marginal
win does not justify the risk; ship only the lane-body rule. Revisit
only if profiling shows cross-row layout invalidation as a real cost.

Effect: isolates paint of the scroll container from adjacent lane chrome.

## Implementation order

1. (1) markdown throttle — biggest win, most localised.
2. (3) tool counter — trivial, removes a recurring scan.
3. (2) scroll RAF — trivial, defensive against fast scroll.
4. (4) CSS containment — last, easiest to revert if it causes paint
   artefacts.

Each change is independently revertable.

## Risks

- **Markdown throttle visual hiccup.** Snapping between text-only and
  formatted view every 400 ms could feel laggy. The `--stream-plain`
  fallback uses `white-space: pre-wrap` so code fences and newlines stay
  readable, but inline markdown (`*emphasis*`, `**bold**`, `` `code` ``)
  will be visible as literal characters between snaps. If this proves too
  jarring, options for a follow-up: (a) reparse-in-RAF with incremental
  marked tokens, (b) lighter regex pre-pass that styles inline markers
  only, (c) move parsing to a Worker.
- **Final reparse height jump on seal.** When `sealStreaming` triggers the
  final markdown reparse, row height may change (block code, headings,
  lists). If the user has scrolled away from bottom, the scroll anchor
  must hold. `renderActiveTranscript()` already captures/restores anchor
  around the diff loop, but verify by manually scrolling up mid-stream of
  a long response with mixed block elements, then letting it seal.
- **CSS containment paint bugs.** Mitigated by staged rollout in §4
  (lane-body first with paint; row uses layout-only). Verify hidden-rows
  indicator, row-entrance translate, pretext animation.
- **`activeToolCount` drift.** Counter must be incremented/decremented in
  exactly the right places, including the 300-row shift in
  `appendTranscript()`. Dev-build assertion in §3 catches drift.
- **`toolTranscriptIds` stale entries on cap shift.** Same root as above
  — when a tool row is shifted out, its entry in `toolTranscriptIds` must
  also be removed, otherwise a late update for that toolCallId may
  resurrect a phantom row.

## Test plan

- Manual: stream a 30 KB assistant response in one lane while monitoring
  the profiler HUD; confirm keypress-to-render stays < 16 ms.
- Manual: while a long assistant response is mid-stream, scroll up
  ~halfway through earlier rows. Let the response seal. Verify the
  scroll anchor holds (no yank to bottom, no jump from final reparse
  height change).
- Manual: scroll up during a long **thought** stream (thought rows defer
  pretext layout until seal, `:4688-4694`). Let the turn end. Verify no
  yank when the pretext layout pass runs after the anchor restore.
- Manual: scroll-flick a full 60-row transcript via Ctrl+Shift+J/K; watch
  for dropped frames.
- Manual: run a turn with ~10 tool calls; verify spinner timer continues
  to tick and stops on completion. Force the 300-row cap by streaming
  past it with at least one active tool in the dropped prefix; verify
  `activeToolCount` stays correct and no phantom tool rows appear.
- Manual: visually inspect row-entrance fade, hidden-rows indicator, and
  pretext animation against the staged CSS containment (Pass A only
  first, then Pass B).
- Automated tests deferred. The current `acp-harness-view.test.ts`
  exercises only pure helpers, and the streaming + tool-counter logic is
  on the class and depends on DOM (no jsdom/happy-dom configured). Adding
  meaningful automated coverage would require pulling in a DOM test
  environment — tracked as a follow-up. Dev-only
  `assertActiveToolCount()` (gated by `SPEC114_DEV`) detects counter
  drift at runtime in the meantime.

## Open questions

- Should the markdown throttle be configurable per-lane (e.g. 4 Hz on
  slower machines)? Default constant is fine for V1.
- Should `sealStreaming` also trigger pretext layout, or is the existing
  `schedulePretextLayout()` after the render enough? Default: leave as-is.

## Out of scope (follow-up spec)

- Listener hygiene cleanup in `dispose()` (anonymous arrows, `chipTimer`,
  lane Maps).
- Async/yielding markdown parser for very large messages (>100 KB).
- Lower default `metricsTimer` cadence when no lane has an active turn.
- Incremental markdown tokeniser (e.g. `marked.Lexer`) — peer review
  noted markdown is not append-stable (fences, list indentation, link
  references, table separators can reinterpret prior text), so a true
  incremental parser is not worth the correctness risk for V1.

## Peer review log

- **rev 1 → rev 2** — incorporated Codex-1 review:
  - Coupled markdown throttle with streaming render-path special case
    (§1).
  - Added `--stream-plain` modifier + `white-space: pre-wrap` for
    fallback styling (§1, §4 risks).
  - Separated `streamPlainSource` from `markdownSource` and added
    explicit seal-path reparse trigger (§1).
  - Staged CSS containment: `paint` on lane-body, `layout`-only on row
    (§4).
  - Tool counter: before/after delta + 300-row cap drift handling +
    `toolTranscriptIds` cleanup (§3).
  - Scroll RAF: re-read live state inside callback (§2).
  - Downgraded §3's relative priority in the audit summary.
- **rev 2 → rev 3** — incorporated Cursor-1 review:
  - §1: Made the streaming fast path an **early branch before the
    signature compare**, with pseudocode. Prior text would have frozen
    after the first chunk because `'stream' === 'stream'` matches the
    no-op equal-signature branch.
  - §1: Specified `body.classList.remove('--markdown')` /
    `remove('--stream-plain')` on every class swap so stale block
    styles cannot leak across throttle frames.
  - §1: Spelled out that `assistantId` must be captured **before**
    nulling `current*Id` in `sealStreaming`.
  - §1: Called out V1 scope = assistant streaming only; thought / user
    streaming intentionally unchanged.
  - §1: Documented the pre-existing background-lane caveat
    (`scheduleLaneRender` no-ops on non-active lanes).
  - §4: Dropped row-level `contain: layout` — marginal gain, doesn't
    isolate the row's own translate. Ship only the lane-body rule.
  - Test plan: added scroll-up-during-thought-stream + seal test for
    the pretext-layout-after-anchor-restore risk.
