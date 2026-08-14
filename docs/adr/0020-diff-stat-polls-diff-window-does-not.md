# The status-bar diff stat polls; the Diff Window still does not

> Status: accepted
> Date: 2026-08-14

## Context

ADR-0008 established that the Diff Window refreshes only at **lane quiet points**
and deliberately does not watch the filesystem or poll. Spec 220 puts the same
underlying fact — how much has changed in this repo — on the window status bar
as `+added -removed`, where it is expected to be *current*: a rail readout that
silently lags the worktree is worse than none, because it is read at a glance and
believed. Reusing the quiet-point rule alone would leave it frozen through every
edit made outside a harness turn: a terminal, an external editor, a `git stash`.

## Decision

The diff stat is driven by **both**: a 4 s poll per repo root, plus the same
`harness:lane-idle` push the Diff Window uses. ADR-0008 is unchanged — the Diff
Window keeps its quiet-point-only refresh. The two surfaces now answer at
different cadences on purpose.

The poll is bounded by construction: keyed by repo root so windows on one project
share a single git call; ref-counted so an unwatched repo costs nothing;
single-flight with one trailing re-fetch; stopped while
`document.visibilityState` is `hidden`; and backed by a command that returns
totals from one `git diff --numstat` (≈30 ms measured on a 733-file repo) rather
than building a diff.

## Considered Options

- **Quiet points only, as ADR-0008.** Rejected: it makes the readout a function
  of *agent* activity rather than of the worktree. A human editing in a terminal
  pane beside the harness would watch the number sit still.
- **A filesystem watcher.** Rejected for ADR-0008's reason (churn, wasted cycles
  on intermediate states) plus one of its own: a recursive watch on a repo root
  means either walking `node_modules`/`target` or reimplementing gitignore —
  disproportionate machinery for two integers, and the thing being watched is
  git's *index-aware* answer, not raw file events.
- **Poll only, dropping the lane-idle push.** Rejected: the end of a turn is the
  exact instant the human looks at the rail, and making them wait out an
  interval there is the one lag that would be noticed.

## Consequences

- Krypton now has two different freshness policies for the same underlying fact.
  The distinction is deliberate and worth stating plainly: **the Diff Window is a
  reading surface** (churn under a reader is harmful, so it moves only at review
  boundaries), while **the status bar is an instrument** (it is believed at a
  glance, so it must track the tree).
- Idle CPU carries a small, bounded new cost, and only for repos with a visible
  window. If that ever becomes a problem the cadence is one exported constant,
  `DIFF_STAT_POLL_MS`.
- If the Diff Window ever wants live counts in its title, it should subscribe to
  this store rather than growing a poll of its own.
