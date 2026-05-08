# 94. ACP Harness Render Performance

> Status: Implemented
> Date: 2026-05-08
> Scope: Frontend-only ACP harness rendering performance

## Problem

The ACP harness transcript can receive many small events during one agent turn:
assistant message chunks, thought chunks, tool call updates, usage updates, mode
updates, and plan updates. Before this change, every event ended by calling
`render()` synchronously. A full render clears the dashboard, rebuilds the active
lane transcript, reparses assistant markdown, and schedules pretext line layout.
With a long visible transcript, streaming could therefore repeat expensive work
many times per animation frame.

The transcript already caps stored rows at 300, but the hot path was still
O(visible rows) per event.

## Implementation

`AcpHarnessView` now batches event-driven full renders:

1. `onLaneEvent()` mutates lane state as before.
2. Expensive refreshes call `scheduleRender()` instead of `render()` directly.
3. `scheduleRender()` coalesces multiple event updates into one
   `requestAnimationFrame` callback.
4. `render()` clears the pending flag and performs the existing dashboard,
   overlay, plan, picker, composer, pretext, and sticky-scroll pass.

Small event types that do not require transcript rebuilds patch only their
affected surface:

- `available_commands` refreshes the composer so the slash palette can appear or
  update without rebuilding the transcript.
- `mode_update` refreshes lane heads through the existing lightweight metrics
  render path.

Assistant transcript items cache their rendered markdown:

- `HarnessTranscriptItem.markdownSource` stores the source text used for the
  current markdown render.
- `HarnessTranscriptItem.markdownHtml` stores the parsed/highlighted HTML.
- Old assistant rows reuse the cached HTML across full renders.
- A streaming assistant row invalidates naturally when `item.text` changes.

Pretext transcript rows cache line layout:

- `HarnessTranscriptItem.pretextSource`, width, font, and line-height identify
  the cache key.
- `HarnessTranscriptItem.pretextLines` stores the computed visual lines.
- Rows reuse cached lines across full renders until text or layout metrics
  change.

Streaming rows reuse their wrapper element across chunks:

- `renderActiveTranscript()` detects rows that match `lane.currentAssistantId`
  or `lane.currentThoughtId` and updates them in place via
  `current.replaceChildren(...next.childNodes)` instead of `replaceWith(next)`.
  Without this, the wrapper DOM node was thrown out and recreated every rAF,
  causing visible flicker even though the signature-based diff already
  prevented whole-dashboard rebuilds.

Per-paragraph and per-line stagger reveal animations were removed entirely:

- The earlier `data-anim="in"` / `--i` reveal (Spec 93) was incompatible with
  the streaming `replaceChildren` path: every chunk rebuilt the markdown DOM
  from scratch, so block nodes had a shorter lifetime than the 180ms
  animation duration and the index-based `assistantBlockCounts` /
  `pretextLineCounts` counters never matched the freshly-recreated nodes.
  The result was that no animation ever became visible during streaming.
- The `acp-harness-line-in` keyframe, the gated `data-anim="in"` rules in
  `acp-harness.css`, the `applyAssistantBlockStagger()` helper, and both
  per-lane counters were deleted. Row-level entrance, caret blink, busy
  pulse, and streaming pulse animations are unaffected.

Off-screen render skipping (`content-visibility: auto`) was attempted but
reverted: the `contain-intrinsic-size: auto 48px` placeholder undersized
not-yet-painted rows, so `body.scrollHeight` was below the true content
height. `body.scrollTop = body.scrollHeight` then settled above the real
bottom, breaking sticky auto-scroll during streaming. The lesson matches
the stagger-reveal removal: optimizations whose measurements lag the
streaming DOM lifecycle break user-visible behavior — delete rather than
fight.

No backend or protocol changes were required.

## Non-Goals

- DOM virtualization for thousands of transcript rows.
- Incremental transcript DOM reconciliation keyed by row id.
- Persisting transcript render caches across `#new`, `#new!`, `#restart`, or
  harness tab close.

Those remain future options if Krypton needs history far beyond the current
300-row active transcript cap.
