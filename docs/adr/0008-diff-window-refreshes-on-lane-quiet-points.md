# The Diff Window refreshes on lane quiet points, not file watching

> Status: accepted
> Date: 2026-06-11

## Context

The Diff Window (spec 38) renders a one-shot snapshot of the working diff at
open time. In the ACP harness workflow — lanes continuously editing the shared
worktree while the human watches — the snapshot is stale almost immediately,
forcing a close/reopen cycle to see current work. The obvious fix is a
filesystem watcher that re-renders on every write.

## Decision

The Diff Window auto-refreshes at **lane quiet points**: it re-collects the
[[Working diff]] when a harness lane in the same repo (matched by repo root,
any harness view) transitions to `idle` on the ViewBus `lane:status` event.
Mid-turn freshness is available on demand via a manual refresh key (`r`).
While the window is a hidden background tab it only marks itself dirty and
refreshes once on reveal. Every refresh preserves the current file and scroll
position.

It deliberately does **not** watch the filesystem and does **not** update while
a lane is writing. If the diff looks frozen during a long turn, that is the
design, not a bug.

## Considered Options

- **Filesystem watcher (debounced re-render on every write).** Rejected: lanes
  write in bursts mid-turn, so the diff would churn under the reader — scroll
  anchors shifting while the human is reading the very content being judged.
  It also burns git + parse + highlight cycles on intermediate states nobody
  will review (agents routinely rewrite the same file several times in one
  turn), against the idle-CPU < 1% budget. A turn's end is the natural review
  boundary; the `idle` transition is a signal the harness already centralizes,
  so no watcher infrastructure is needed.
- **Manual refresh only.** Rejected: it keeps the close/reopen pain in
  lighter form — the human polls by hand for an event the system already
  observes.

## Consequences

- The generic Diff Window now optionally subscribes to a harness signal
  (ViewBus `lane:status`). Without a matching harness it degrades to
  manual-refresh-only; the coupling is one event subscription, not a
  structural dependency.
- A reader mid-file when a refresh lands still sees content change under
  them at quiet points; preserving file + scroll position is the mitigation,
  and `r` puts the timing in the human's hands when that is not enough.
