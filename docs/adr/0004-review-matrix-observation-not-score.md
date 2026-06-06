# The review quality matrix is an observation, not a score

> Status: accepted
> Date: 2026-06-06

## Context

Krypton's ACP harness runs `#review` as agent-orchestrated multi-reviewer
fan-out over `peer_send` (spec 145). Under the common workflow where one lane
edits the shared worktree and the others only review (the [[Authoring lane]]
pattern in `CONTEXT.md`), the user wants to *observe whether a given lane keeps
producing bugs or bad design* — across successive reviews, not just one. Today
the reviewers' Blockers/Warnings are synthesized into the authoring lane's turn
text and then vanish; nothing accumulates them.

## Decision

The **review quality matrix** (`CONTEXT.md`) accumulates the raw outcomes
reviewer lanes report against an authoring lane's work and shows them as
*history per lane*. It deliberately **refuses to compute a quality score or
rank lanes**:

- It stores a **small summary** per review round — the raw blocker/warning
  counts the reviewers reported (plus a subject label and reviewer count) — and
  shows them as a trend the human eyeballs. It never blends them into one
  number, never records a self-graded verdict, and never produces a leaderboard.
- It keeps **no fine-grained per-review detail** (no stored diff size, no
  jump-back-to-transcript anchor). The actual reviewer replies live in the
  authoring lane's scrollback, so the counts stay an index into real evidence
  the human can re-read, never the final word.
- It is surfaced exactly like attention triage (a precedent it mirrors): a
  **neutral depth indicator** in the workspace status bar (a count of reviews
  recorded — *not* an alarm, *not* coloured by badness) plus a
  summon-on-demand overlay.

## Considered Options

- **A single quality score per lane (e.g. "Claude-1: 7.5/10").** Rejected:
  it launders subjective, uncalibrated LLM-reviewer output into a number that
  *looks* objective (false precision); it punishes lanes doing large/risky work
  (more blockers by nature); reviewer lenses differ in strictness so scores are
  not comparable; and a score becomes a target the human over-trusts in place
  of reading the work (metric-as-target). This also breaks faith with the
  `CONTEXT.md` rule that the backpressure gauge "shows depth, never decides."
- **An alarm-style indicator** (status-bar number turns red when blockers are
  high). Rejected for the same reason — it re-introduces "score" through the
  visual back door and conflates with the adjacent attention gauge, whose count
  genuinely means "act on me."

## Consequences

- **Accepted limitation: attribution is by workflow convention, not proof.**
  Every lane in a harness view shares one worktree, so the diff is credited to
  the authoring lane only because the user runs the "one edits, others review"
  workflow — the system cannot prove per-line ownership. The matrix is
  meaningless outside that workflow.
- **Accepted risk: the measured lane self-reports its own outcomes.** Producing
  the counts at synthesis time (consistent with the self-report model of
  [[ADR 0001|0001-attention-triage-self-reported-router]]) means the authoring
  lane could under-report blockers against itself. The mitigation is that the
  reviewers' actual replies remain in the authoring lane's scrollback — the
  count is an index into that evidence, not a verdict — plus the fact that the
  human reads the review anyway. There is no automatic safety net (and no stored
  jump-to-review anchor), by the same reasoning as ADR-0001.
- **Scope is session-only and in-memory** (no persistence), keyed by lane,
  mirroring `LaneTriageStats`. Cross-session/longitudinal observation would
  require keying by agent/model (lane numbers reset on restart) and a disk
  store — explicitly deferred. See `docs/146-review-quality-matrix.md`.
