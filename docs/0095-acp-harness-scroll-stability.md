# 95. ACP Harness Scroll Stability

> Status: Implemented
> Date: 2026-05-08
> Scope: Frontend ACP harness scroll behavior during render and streaming

## Problem

Three scroll bugs surfaced repeatedly in the harness:

1. **Content jumps to top** mid-session when an action triggers a full render
   (lane switch, memory drawer, focus toggle, mode change, etc.) while the user
   has scrolled up to read earlier transcript.
2. **Stream does not always scroll to the end**, even with `stickToBottom = true`
   — the body settles slightly above the latest line.
3. **Viewport drifts while reading older transcript** when streaming markdown,
   pretext line wrapping, or late layout changes alter rows above the user's
   current viewport.

A prior attempt added `savedScrollTop` per lane and restored it after rebuild.
That patch fixed the symptom in some paths but the root cause remained, so the
issue kept reappearing under different triggers (markdown image height, code
highlight, late pretext layout).

## Root Cause

`renderDashboard()` previously performed `dashboardEl.innerHTML = ''` and then
recreated the active lane's `<div class="acp-harness__lane-body">` from scratch
on every full render. Because `render()` is invoked from 30+ call sites (lane
switch, drawer toggles, mode changes, focus changes, errors, etc.), the active
body element was destroyed and recreated extremely often.

Consequences of recreating the body element:

- The browser starts the new node at `scrollTop = 0`. Any numeric
  "save-and-restore" of `scrollTop` runs against `scrollHeight` *as of the moment
  of restore*, which is not the final layout. Pretext line wrapping, markdown
  image loads, and `highlight.js` post-processing all change `scrollHeight`
  later. The user sees the body either snap to top or stop short of the last
  line.
- All transcript rows inside the body are also rebuilt, throwing away the
  streaming wrapper/markdown DOM that Spec 94 carefully preserved across chunks.

The numeric restore could never beat layout because the underlying DOM identity
was lost. After the first fix preserved the body element, one unstable case
remained: the harness intentionally sets `overflow-anchor: none` on the lane
body, so the browser does not preserve the visible row when child content above
the viewport changes height. That means a stable scroll container can still
drift while the user is reading older content.

## Fix

Preserve the active body's **DOM identity** across `renderDashboard()` rebuilds
and preserve a transcript-row **viewport anchor** whenever the lane is not
stuck to the bottom.

The same scrollable element survives every full render, so the browser's real
scroll position is never reset, and `renderActiveTranscript()` then performs its
existing per-row diff against children that are already in place.

Implementation in `src/acp/acp-harness-view.ts`:

1. At the top of `renderDashboard()`, look up the current active body element
   and detach it from its parent before clearing `dashboardEl.innerHTML`.
2. Tag the body with `data-lane-id` so a subsequent rebuild can decide whether
   it still belongs to the (possibly re-selected) active lane.
3. While building each lane shell, if the lane is active and the previous body
   matches its lane id, reuse that element. Otherwise create a fresh empty body.
4. After the structure is in place, call `renderActiveTranscript(activeLane)`
   which diffs its children against `lane.transcript` (incremental update path,
   already used by `renderActiveLane`).
5. If `lane.stickToBottom` is true, pin to bottom once synchronously after
   reattach. `schedulePretextLayout()` then runs `applyStickyScroll()` again
   after pretext finishes, covering late layout growth.
6. If `lane.stickToBottom` is false, capture the first visible
   `.acp-harness__msg[data-msg-id]` plus its offset from the scroll container
   before transcript mutations, then restore that row to the same viewport
   offset afterward.
7. `schedulePretextLayout()` performs the same capture/restore around text
   measurement, so row height changes from pretext wrapping do not move the
   user's reading position.
8. A `ResizeObserver` watches the active transcript body and its message rows.
   If async content changes row height after render/pretext work (for example
   markdown image load), bottom-stick lanes re-pin to bottom and non-bottom
   lanes restore the last saved transcript-row anchor.

`savedScrollTop` introduced earlier is kept as a defensive fallback inside
`applyStickyScroll()` (sets `scrollTop` if it ever observes a 0 with non-zero
saved value). It is no longer load-bearing because the body is not destroyed and
the visible-row anchor handles normal non-bottom layout drift.

## Why This Is The Root Cause Fix

- The browser preserves `scrollTop` automatically across attribute changes and
  child mutations on the same element, but `scrollTop` is only a coordinate. It
  does not preserve "the row the user was reading" when earlier content changes
  height and browser anchoring is disabled.
- Late layout passes (pretext, markdown image, code highlight) modify the same
  scrollable container. With identity preserved, every late layout operates on
  the same body; with transcript-row anchoring, the visible row is restored to
  the same offset after mutations.
- Streaming row wrappers (Spec 94) survive across full renders too, so the
  flicker fix for streaming markdown also benefits.

## Files Changed

- `src/acp/acp-harness-view.ts` — `renderDashboard()` body preservation;
  transcript-row anchor capture/restore for non-bottom transcript renders and
  pretext layout; active-body/message-row `ResizeObserver` for async height changes;
  `applyStickyScroll()` defensive fallback; `g`/`G` keys update
  `stickToBottom` consistently; `onTranscriptScroll()` tracks `savedScrollTop`.

## Verification

- `npm run check`
- `npm test` (33 tests, 2 files)
- Manual: scroll up mid-stream, toggle memory drawer / switch lane / press
  Escape — content stays in place. With `G` (or stickToBottom = true), stream
  pins to bottom even when markdown images and code highlights load late.

## Lessons

- Numeric scroll restore is fundamentally racey when the underlying element is
  recreated. Preserve DOM identity instead.
- DOM identity alone is not enough for non-bottom reading mode when browser
  anchoring is disabled. Preserve the visible transcript row and its viewport
  offset around mutations.
- A render path that calls `innerHTML = ''` on a container holding scrollable
  state is hostile to scroll preservation, no matter how careful the
  save/restore code is around it.
