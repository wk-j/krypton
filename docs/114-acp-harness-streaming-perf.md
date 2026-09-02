# 114. ACP Harness Streaming Performance Audit & Fixes

> Status: Implemented (rev 15 — smooth-follow does not replay a glide when the scroll target is unchanged; rev 14 — composer key edits pin a stuck transcript in the same turn; rev 13 — a scroll-sourced sticky-drift heal pins synchronously, before paint; rev 12 — sticky-drift heal: a stuck lane short of the bottom is re-pinned; rev 11 — keyboard scroll up always unsticks; rev 10 — scroll stickiness measured at event dispatch, committed in the RAF; rev 9 — usage and plan events stay off the full lane rebuild; rev 8 — streaming tool output patches the output block in place; rev 7 — streaming smooth-follow scroll; rev 6 — stop and MCP stats stay off the full dashboard rebuild; thought/user seal matches assistant)
> Date: 2026-05-22
> Milestone: ACP harness — performance hardening
> Builds on: Spec 94 (render batching + caching), Spec 103 (tail-window rendering)
> Amended (assistant kind only) by: Spec 117 — assistant rows now use optimistic streaming-markdown rendering instead of plain-until-seal. Thought / user rows still follow §1 of this spec until seal, then stamp the sealed signature in place.
> Amended (rev 5) by: tool_call / tool_call_update and sealStreaming use `scheduleStreamingBodyOnly` instead of `scheduleLaneRender`. Existing transcript rows patch in place (`replaceChildren`); pending and in_progress share one signature so an in-flight status tick does not remount the row.
> Amended (rev 6) by: `stop` sets `needsRender = false` and patches lane chrome + composer (`patchLaneTurnChrome`) instead of `renderActiveLane`. `refreshMcpStats` calls `refreshMetricsRender` instead of `this.render()`. Thought/user seal stamps the wrapper signature like assistant. `layoutPretextRows` skips rows whose DOM already matches the line cache.
> Amended (rev 7) by: streaming smooth-follow scroll (§5) — while a lane streams, sticky scroll glides to the bottom with a per-frame exponential chase instead of teleporting; keyboard/wheel user-intent detection replaces the scroll-event heuristic while the glide holds suppression.
> Amended (rev 8) by: streaming tool output (§6) — an in-flight tool's section text stays out of `transcriptRenderSignature`; the body-only pass swaps just the `.acp-harness__tool-output` block (`patchStreamingToolBody`) instead of `replaceChildren` on the whole row. Spinner glyph seeds the live ticker frame. `fs_activity` moves to the body-only path.
> Amended (rev 10) by: `onTranscriptScroll` (§2) — stickiness is **measured at event dispatch, committed in the RAF**. The "go look later" model re-read `scrollHeight` inside the RAF; an unsuppressed scroll event (keyboard `scrollBy`, browser clamp after content shrank) dispatching just before a streaming chunk grew the body would then measure the *post-growth* distance, flip `stickToBottom` off, and kill autoscroll for the rest of the stream. The handler now snapshots `{laneId, scrollTop, distance, suppressScrollToken}` at dispatch; the RAF commits the frame's last sample and drops it when suppression, the token, or the active lane changed in between. `noteUserScroll` additionally swallows its `scrollBy`'s own async scroll event with a begin/release pair (intent is already recorded synchronously; the echo could otherwise re-measure after growth).
> Amended (rev 11) by: three scroll fixes. (a) `noteUserScroll` (§5) — a keyboard scroll **up** always unsticks. Recomputing from `STICK_THRESHOLD_PX` (32px) meant one `k` (24px) still read as "at bottom", so any following sticky pass (streamed chunk, or the full `render()` on the `i`/`Escape` focus switch to the composer) pulled the transcript back to the bottom. (b) `onTranscriptScroll` (§2) — an unstuck lane may only **re-stick when the sample moved down** toward the bottom; a stray unsuppressed event landing within the threshold without downward motion (WebKit clamp after the streaming tool row shrank, a `scrollBy` echo escaping the 2-RAF release under load) used to flip `stickToBottom` back on 24px from the bottom and undo (a). (c) the glide gate (§5) — `applyStickyScroll`/`scheduleStreamingBodyOnly`/`scheduleStickyScroll` now gate on `isLaneLive` (busy status OR open text row), not `isLaneStreaming` alone: every `tool_call` seals the text row, so tool-dominated turns (Claude) teleport-pinned on every streaming tool-output delta while text-heavy turns (Grok) glided.
> Amended (rev 15) by: same-target smooth-follow suppression (§5). Streaming execute output keeps a bounded rolling tail (`boundedOutputLines`), so a `tool_call_update` can replace `.acp-harness__tool-output` without moving the transcript's bottom. Every body-only pass still called `nudgeSmoothFollow()`, which started a glide from whatever `scrollTop` the replace (or the unidentified 14 px writer) had left. The same visible rows then eased toward a bottom that had not grown. `planSmoothFollow(scrollTop, scrollHeight, clientHeight, previousTarget)` is the pure decision: idle when already at the bottom, pin (same-frame, no chase) when the parked target did not grow, chase only when it did — restoring to the parked bottom first if a clamp dropped `scrollTop` so the glide covers new content only. `nudgeSmoothFollow` parks the target on idle/pin/catch-up; unstick (`cancelSmoothFollow`, scroll-away) forgets it. The 2 s metrics heal still glides: it clears the park before `scheduleStickyScroll` so a remainder that has already been on screen eases back rather than snapping. Keyboard/wheel unstick is unchanged (rev 11). [#18](https://github.com/wk-j/krypton/issues/18).
> Amended (rev 14) by: composer-key sticky pin (§2). Rev 13 only heals when a scroll event is delivered. Keystrokes inside the 2-RAF programmatic-scroll suppression window, or while a smooth-follow glide is already running (`smoothFollowRaf !== 0`, which skips the heal), still painted the 14 px jump. `setDraft` / `setDraftCursor` / `applyHistoryDraft` now call `pinStickyAfterComposerKey()` in the same turn as `renderComposer()`: if the active lane is stuck, write `scrollTop = scrollHeight` under programmatic-scroll suppression, even when a glide is in flight. The 1 s composer tick does **not** pin — it does not reproduce the writer, and a hard pin would snap a live glide once a second. The writer remains unidentified ([#17](https://github.com/wk-j/krypton/issues/17)).
> Amended (rev 13) by: synchronous heal on the scroll path (§2). Frame-by-frame analysis of a user recording (2026-09-02, 20 fps, lane busy in zen mode, user typing in the composer) showed the transcript jumping 14 CSS px down on every character inserted and then gliding back over ~150 ms — a visible oscillation on each keystroke. The jump is the rev 12 drift (same 14 px, idempotent: keystrokes landing on an already-drifted lane changed nothing); the glide back was the rev 12 heal itself, which answered the drift's scroll event with `scheduleStickyScroll()` — a RAF in the *next* frame that then started the rev 7 glide, so the displaced position painted for two frames before the chase. Keystrokes that landed inside the 2-RAF programmatic-scroll suppression window (right after a glide finished) had their scroll event swallowed, and the lane sat drifted until the next 2 s poll heal — which is why some keystrokes shook and others did not. The writer is still unidentified; it fires on composer keystrokes (not on the 1 s composer tick, whose `renderComposer()` is the only work a keystroke does), fires a scroll event, and is independent of composer geometry (the composer did not move in any frame). Fix: `healStickyScroll('scroll')` pins synchronously inside the scroll handler's RAF, which runs in the same rendering update as the scroll event and before paint, so the displaced frame never reaches the screen. The `'metrics'` source keeps the glide. Dev builds additionally wrap the `scrollTop` setter (`installLaneBodyScrollTracer`) to stack-trace any JS writer that leaves a lane body short of its bottom. The user-visible jump is tracked in [#17](https://github.com/wk-j/krypton/issues/17) (closed after the composer-key pin made the shake invisible; the writer is still unidentified).
> Amended (rev 12) by: sticky-drift heal (§2). Frame captures of the live app (2026-09-02) showed the pinned transcript sitting exactly 14 CSS px above the bottom — content and box unchanged, scrollbar thumb 2 device px higher — from the moment a tool finished and the model went quiet until the next transcript event, up to 21 s. During that silence Claude emits empty thought deltas that only drive the rail veil (`thought-veil:` id, no row), so no sticky pass ran. The writer of the 14 px is still unidentified. `healStickyScroll(source)` makes the outcome independent of it: when the active lane is stuck, no glide is chasing, no upward wheel landed in the last `STICKY_DRIFT_WHEEL_GRACE_MS` (600 ms), and `scrollHeight − scrollTop − clientHeight` is in `(STICKY_DRIFT_EPSILON_PX, STICK_THRESHOLD_PX]` = (1, 32] px, it calls `scheduleStickyScroll()`. Two triggers: the `onTranscriptScroll` commit (an unsuppressed event that left a stuck lane short) and the existing 2 s metrics poll (one `scrollHeight` read, no new timer). Keyboard scrolls are unaffected: intent is recorded synchronously and an upward key always unsticks (rev 11), so the heal never sees a stuck lane after `k`. Dev builds (`SPEC114_DEV`) `console.warn` + `console.trace` on every heal to locate the writer.
> Amended (rev 9) by: `usage` and `plan` events (§7) — `usage` arrives once per API round-trip mid-turn (an agentic turn with N tool calls emits N+ of them, plus context-level `usage_update` notifications) and took the full `renderActiveLane` path, flashing the whole lane while tools ran. It now patches its actual surfaces in place (`renderActiveLaneChrome` for the lane head/stats/zen rail, `renderLanePeek` for the peek card) and sets `needsRender = false`. `plan` on the active lane likewise skips the full render — `renderPlan` already patches the plan panel and `sealStreaming` schedules the body-only pass.

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
- Call `scheduleStreamingBodyOnly(lane)` at the end of `sealStreaming` to
  guarantee the final markdown render without rebuilding lane chrome.
  Thought and user rows get the same in-place seal as assistant
  (`sealStreamingTextRow` stamps `dataset.renderSignature` to the sealed
  value) so the following body-only pass is a no-op instead of
  `replaceChildren`. Callers that need composer/head (permission, error)
  still `scheduleLaneRender` via `needsRender`. `stop` patches chrome in
  place (`patchLaneTurnChrome`) and does not take that path. Resume/load
  already calls `render()` after seal.

**Background-lane caveat (pre-existing, documented not fixed).**
`scheduleStreamingBodyOnly` (and `scheduleLaneRender`) skip the
transcript pass for non-active lanes. If a sealed assistant lives on a
background lane, the final markdown render runs lazily when the user
activates that lane. Acceptable for V1; not introduced by this spec.

### 1b. Tool status ticks stay on the body-only path (rev 5)

`tool_call` / `tool_call_update` used to leave `needsRender = true`, so
every MCP pending → in_progress → output → completed tick ran
`scheduleLaneRender` → `renderActiveLane`. That rebuilds lane head,
composer, peek card, plan, pin, and queue via `innerHTML` even when only
one tool glyph changed. The transcript then looked like the whole screen
flickered.

Rev 5:

- Those two events set `needsRender = false` and call `scheduleToolRender`,
  which sets a peek-tool flag and reuses `scheduleStreamingBodyOnly`.
- The coalesced RAF paints `renderActiveTranscript` and, when the flag
  is set, an in-place peek tool-row patch. It does
  **not** rebuild composer, lane head, peek card, plan, pin, or queue.
- `renderActiveTranscript` keeps the existing `.acp-harness__msg` node on
  a signature mismatch (`className` + `replaceChildren`). `replaceWith`
  remounted the TOOL label and jumped the list.
- `transcriptRenderSignature` collapses pending and in_progress to one
  `active` token, so a status-only in-flight tick is a no-op. Terminal
  status, output, diffs, and command/title changes still patch the row.
- Empty live `thought_chunk`s do not insert a transcript row. The rail
  veil owns that state; inserting then dropping the row on `tool_call`
  was jumping the list. The thought slot hide is delayed (`THOUGHT_SLOT_HIDE_MS`)
  so the card does not collapse on the same frame as the next tool.

### 1c. Turn-end and MCP stats stay off the full dashboard (rev 6)

`stop` used to leave `needsRender = true`, so `finishTurn` → `scheduleLaneRender`
→ `renderActiveLane` rewrote head, stats, composer, peek, thought, plan,
pin, and queue in one frame. Combined with `refreshMcpStats()` calling
`this.render()` on every `acp-harness-mcp-touched` (handoff / attention /
peer / artifact at the end of a turn), the whole dashboard flashed when the
lane went idle.

Rev 6:

- `stop` sets `needsRender = false`. `finishTurn` calls `patchLaneTurnChrome`
  (lane class busy→idle, head, stats, composer) after the body-only seal.
- `refreshMcpStats` updates heads via `refreshMetricsRender` and does not
  rebuild the dashboard.
- `layoutPretextRows` skips a row whose `.acp-harness__pretext-line` children
  already match the cached line texts.
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
  `requestAnimationFrame()` the commit, clear the flag in the RAF
  callback.
- **(rev 10) Measure at dispatch, commit in the RAF.** The original rev
  re-read `scrollHeight`/`scrollTop` inside the RAF ("go look later"),
  but an unsuppressed scroll event — keyboard `scrollBy`, or the
  browser's clamp after content shrank — dispatches *between* frames: by
  the frame deadline a streaming chunk may have grown the body, so the
  live reading exceeds `STICK_THRESHOLD_PX` and `stickToBottom` flips off
  even though the user never left the bottom, killing autoscroll for the
  rest of the stream. The handler now snapshots
  `{laneId, scrollTop, distance, suppressScrollToken}` at dispatch time
  (the event target *is* the lane body, so no query). The RAF commits the
  frame's **last** sample, and drops it when suppression is active, the
  token was bumped by a programmatic scroll, or the active lane changed —
  the same staleness cases the live re-read protected against.
  `savedScrollAnchor` is still captured from live DOM at commit time.
- **(rev 11) Re-stick requires downward motion.** When the lane is already
  unstuck, the commit sets `stickToBottom = true` only if the sample is
  within `STICK_THRESHOLD_PX` **and** `sample.scrollTop` exceeds the last
  recorded `savedScrollTop`. All keyboard scrolls record intent
  synchronously in `noteUserScroll`, so an unsuppressed scroll event with
  no downward motion is noise — a WebKit clamp after the streaming tool
  row shrank/rebuilt, or a `scrollBy` echo dispatching after the 2-RAF
  suppression release under load. One `k` parks the viewport 24px < 32px
  from the bottom, exactly where such noise used to re-stick the lane and
  the next pin yanked it down again. A real wheel-down still re-sticks:
  its samples move `scrollTop` toward the bottom. Sticking → unsticking
  is unchanged (distance beyond the threshold).
- **(rev 12) Sticky-drift heal.** Right after the commit, if the lane is
  still stuck and `sample.distance > STICKY_DRIFT_EPSILON_PX` (1 px), the
  handler calls `healStickyScroll('scroll')`, which re-measures live and
  schedules a pin when the distance is in (1, 32] px, no glide is in flight
  and no upward wheel landed within 600 ms. The same check runs from
  `pollMetrics` every 2 s (`'metrics'`) for drift that produced no scroll
  event at all. Sticking → unsticking (distance beyond the threshold) and
  the rev 11 re-stick rule are unchanged; the heal only acts on lanes that
  already believe they are at the bottom.
- **(rev 13) Scroll-sourced heal is synchronous.** `healStickyScroll('scroll')`
  writes `scrollTop = scrollHeight` immediately (under programmatic-scroll
  suppression) instead of calling `scheduleStickyScroll()`. The scroll event
  that reports the drift dispatches in the rendering update's scroll steps,
  and the handler's RAF runs in that same update before style/layout/paint,
  so a pin there is invisible; a scheduled pass ran one frame later and then
  glided, which painted the displaced position and turned a per-keystroke
  14 px drift into a per-keystroke oscillation. `healStickyScroll('metrics')`
  (the 2 s poll) still schedules the glide — its drift has already been on
  screen for up to 2 s, and a gentle catch-up reads better than a snap.
- **(rev 14) Composer key edits pin in the same turn.** Rev 13 still misses
  keys whose scroll event is swallowed: the 2-RAF programmatic-scroll
  suppression window after a pin/glide, and `healStickyScroll`'s
  `smoothFollowRaf !== 0` early return while a live chase is running.
  `setDraft`, `setDraftCursor`, and `applyHistoryDraft` call
  `pinStickyAfterComposerKey()` after `renderComposer()`: if the active
  lane is stuck, write `scrollTop = scrollHeight` under suppression now,
  even during a glide. The 1 s composer tick does not pin (it does not
  reproduce the writer; a hard pin would snap a live glide once a second).
  [#17](https://github.com/wk-j/krypton/issues/17) is closed after the
  user-visible shake was confirmed gone; the writer is still unidentified.
- **(rev 10)** `noteUserScroll` swallows its `scrollBy`'s own async scroll
  event with a `beginProgrammaticScroll`/`releaseProgrammaticScroll` pair:
  keyboard intent is already recorded synchronously, and the echo event
  could otherwise dispatch after growth and re-measure. A wheel-up still
  lifts this suppression early (§5).

Effect: collapses scroll-event storms into one anchor capture per frame,
and stickiness decisions can no longer be contaminated by content growth
that happened after the scroll.

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

### 5. Streaming smooth-follow scroll (rev 7)

While a lane streams, sticky-scroll pinning (`scrollTop = scrollHeight`)
teleports the transcript at every chunk boundary. Rev 7 replaces the pin
with a per-frame exponential chase **only while streaming**; every other
sticky path (lane switch, resize, full rebuild, `G` on an idle lane)
still pins instantly.

- `smoothFollowStep(scrollTop, scrollHeight, clientHeight)` — exported
  pure step: closes `SMOOTH_FOLLOW_LERP` (0.25, ~60 ms time constant at
  60 fps) of the remaining distance per frame, with a 1 px floor so it
  cannot stall, and snaps exactly once within `SMOOTH_FOLLOW_SNAP_PX`
  (0.5) — including when content shrank and the browser clamped
  `scrollTop`.
- `planSmoothFollow(scrollTop, scrollHeight, clientHeight, previousTarget)`
  — exported pure decision (rev 15): `idle` when already at the bottom,
  `pin` when the parked target did not grow, `chase` (via `smoothFollowStep`)
  when it did. A chase that starts below the parked bottom restores there
  first so a `replaceWith` clamp does not replay already-visible rows.
- `nudgeSmoothFollow()` — RAF loop around the step. Parks when caught up
  (the next chunk re-nudges), so idle streaming frames cost nothing. Every
  frame re-reads live state (`activeLane`, `activeTranscriptBody`,
  `stickToBottom`), so lane switches and unsticks terminate it without
  call-site bookkeeping. Each frame writes under
  `beginProgrammaticScroll`/`releaseProgrammaticScroll`; successive begins
  bump the token, so suppression holds continuously across the glide and
  lifts two RAFs after the last write — same contract as the instant pin.
  - **(rev 15)** Before starting a chase, `planSmoothFollow` compares the
    live bottom to the last parked target for this body. Unchanged target
    → idle (already there) or pin (clamp/drift, written in this turn so it
    never paints). Grown target → chase, but if `scrollTop` is below the
    parked bottom the first write restores there so the glide does not
    replay already-visible rows. `cancelSmoothFollow` forgets the park
    (keyboard/wheel unstick). The metrics heal clears the park first so
    its 2 s catch-up still glides.
- `applyStickyScroll()` routes the `stickToBottom` branch to the follower
  when the lane is **live** **or** a glide is already in flight (so
  the turn-end triple-pin lets an unfinished glide finish smoothly
  instead of teleporting past the final reparse).
  - **(rev 11)** "Live" is `isLaneLive(lane)` — busy status OR an open
    text row (`isLaneStreaming`) — not `isLaneStreaming` alone. Every
    `tool_call` seals the open text row, so in a tool-dominated turn
    (Claude) `isLaneStreaming` is false for most of the turn even though
    streaming tool output keeps growing the transcript: every tool delta
    took the instant-pin path and the lane visibly teleported, while a
    text-heavy lane (Grok) glided. `scheduleStreamingBodyOnly`'s
    apply-vs-schedule fork and `scheduleStickyScroll`'s single-pass check
    use the same predicate. Lane switch and the full-rebuild pin are
    outside this gate and stay instant.
- **User-intent detection.** With suppression held for the whole glide,
  the scroll-event heuristic can no longer see user scrolls mid-stream:
  - Keyboard scroll keys (`j`/`k`, `Ctrl+d`/`u`, `PageUp`/`Down`,
    `Ctrl+Shift+J`/`K`) record stickiness synchronously via
    `noteUserScroll(body, direction)` right after their instant
    `scrollBy`. Direction disambiguates intent while the follower is
    behind the true bottom: an **upward** scroll always unsticks, and a
    **downward** scroll may only (re)stick (within `STICK_THRESHOLD_PX`)
    — pressing `j` during a glide must not read as "leave the bottom".
    `g` cancels the follower and unsticks as before.
    - **(rev 11)** The upward branch originally recomputed stickiness
      from `STICK_THRESHOLD_PX`, but a single `k` moves 24px < 32px, so
      one line up still counted as "at bottom" and the next sticky pass
      — every streamed chunk, or the full `render()` on the `i`/`Escape`
      focus switch back to the composer — yanked the transcript to the
      bottom. One deliberate keyboard scroll up now always leaves the
      bottom; the threshold applies only to (re)sticking on the way
      down.
  - An **upward wheel** is unforgeable user input: `onTranscriptWheel`
    cancels the follower and lifts suppression (bumping the token
    invalidates in-flight releases) so the ensuing native scroll events
    reach `onTranscriptScroll` and unstick through the normal path.
    Downward wheel needs nothing — suppression is only held while the
    follower runs, and the follower only runs while stuck.
- `dispose()` cancels the follower RAF.

Effect: the transcript glides at chunk boundaries instead of jumping, and
the glide also absorbs the seal-reparse height jump. A chunk that does
not move the bottom (bounded execute-output tail, replaceWith clamp)
idles or pins instead of replaying that glide (rev 15). Perf cost is one
`scrollHeight` read + one `scrollTop` write per frame, only while behind
the bottom.

### 6. Streaming tool output patches in place (rev 8)

Rev 5 moved tool events onto the body-only pass, but
`transcriptRenderSignature` still embedded every section's full text (and
`boundedOutputLines` keeps a scrolling 12-line tail for execute tools), so
**every output chunk changed the signature** and took the `replaceChildren`
branch: the whole row — spinner glyph, kind chip, subject, timer, output
sections, diff previews — was torn down and rebuilt per coalesced RAF. The
spinner node reseeded at frame 0 each time (visibly stuck/jittering under a
fast chunk stream), and the head + diff remounts were the residual
transcript flicker.

Rev 8:

- While a tool is in flight (`!isTerminalToolStatus`), the signature keeps
  section **labels/count** but drops section text. Structure changes
  (new stderr section, subject/title update, exit code, diffs, terminal
  status) still change the signature and rebuild the row once; text growth
  does not.
- On a signature match, `renderActiveTranscript` calls
  `patchStreamingToolBody` (`harness-tool-render.ts`), which swaps only the
  `.acp-harness__tool-output` element and leaves the head and diff previews
  alone. It dedupes on the concatenated section text
  (`dataset.toolStreamSig`), so a visible-but-untouched tool row costs one
  string compare per pass.
- The terminal transition re-includes section text in the signature, so the
  final state still gets one full rebuild through the existing path.
- `tickSpinner` publishes its current frame to the render module
  (`setToolSpinnerGlyph`); a structurally rebuilt in-flight glyph now seeds
  at the live frame instead of snapping back to `⠋`.
- `fs_activity` sets `needsRender = false` and rides
  `scheduleStreamingBodyOnly` like tool events. It arrives once per file
  touch mid-turn; the full `renderActiveLane` per touch was rebuilding
  chrome/peek/plan/composer while tools ran.

Effect: a streaming execute tool repaints only its own output block, at
most once per coalesced RAF and only when its text actually changed.

### 7. usage and plan stay off the full lane rebuild (rev 9)

After rev 8 the residual mid-turn flicker was not a transcript row at all:
`case 'usage'` left `needsRender = true`, so every usage event scheduled
`renderActiveLane` — a full lane remount (chrome, peek, thought slot, HUD,
plan, composer, every transcript row's DOM recreated). Usage fires once per
API round-trip, so an agentic turn with dozens of tool calls flashed the
lane dozens of times. `case 'plan'` had the same shape: one full render per
TodoWrite tick, even though `renderPlan` had already patched the plan panel
in place.

Rev 9:

- `usage` merges as before, then patches the only surfaces that display it:
  `renderActiveLaneChrome` (lane head, stats strip, zen rail) and
  `renderLanePeek` (peek card). `needsRender = false`.
- `plan` on the active lane sets `needsRender = false` — the panel patch in
  `renderPlan` plus the body-only seal from `sealStreaming` already cover
  everything the event changes. Inactive lanes keep the existing cheap
  metrics-refresh path in `scheduleLaneRender`.

Effect: during a streaming turn, no event on the hot path (`message_chunk`,
`thought_chunk`, `tool_call`, `tool_call_update`, `fs_activity`, `usage`,
`plan`, `stop`) triggers a full lane rebuild; the remaining
`renderActiveLane` triggers are genuine layout changes (permission cards,
questions, errors, mode/lane switches).

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
