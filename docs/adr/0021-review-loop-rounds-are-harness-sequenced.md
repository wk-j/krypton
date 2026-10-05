# Review-till-pass rounds are harness-sequenced; plain `#review` stays agent-orchestrated

> Status: accepted
> Date: 2026-10-04

## Context

Spec 145 chose **B2** for `#review`: the harness injects one prompt, and the convening
lane itself `peer_send`s the subject to every reviewer, counts the replies, and
synthesizes them. The harness keeps no review state. That fits one round with a human
reading the result.

`#review pass` (spec 276) repeats review → fix → re-review until the reviewers pass. Under
B2 a loop has three problems:

- The stop rules (round limit, nothing changed, no progress) would be prompt text the
  agent may or may not follow.
- The lane that wrote the code would also decide whether its own review passed.
- The authoring lane re-emits the whole subject (up to 40 KB of diff) as `peer_send`
  output once per reviewer, in every round.

## Decision

For `#review pass` only, the **harness sequences the rounds**:

- `HarnessReviewLoopController` fans each round out itself over the spec-115 mention path.
- Reviewer replies are marked harness-consumed, so `InterLaneCoordinator.drain()` hands
  them to the controller instead of composing a turn for the requester.
- The harness reads each reviewer's `VERDICT:` line and decides the next step with
  deterministic rules.
- The authoring lane does only the work: one fix turn per failed round and one summary
  Board at the end.

Plain `#review` is unchanged and stays B2. Inside one round the reviewers still review and
reply on their own; the harness owns only the sequencing and the verdict.

## Considered Options

- **Agent-orchestrated loop** ("repeat until clean" in the prompt). Rejected: the round
  count and stop rules are unreliable, the author judges its own pass, and the subject is
  copied N times per round.
- **Author fixes inside its last reply turn.** Saves a turn, but the author, not the
  harness, would decide pass or fail. Rejected.
- **Harness parses the author's `review_outcome` self-report.** Rejected: it is the
  author's summary of its own review, so it repeats the conflict of interest. Matrix rows
  for loop rounds are recorded from the reviewers' replies instead (spec 146 stays raw
  counts, ADR-0004).

## Consequences

- The harness now keeps per-lane loop state (round, replies, history). It lives in
  memory, is dropped with the lane, and is not persisted.
- The pass decision depends on a parseable `VERDICT:` line. A reviewer that omits it two
  rounds running stops the loop (`no_structure`) rather than being guessed at.
- Matrix rows for loop rounds come from the harness, not the lane. They are still
  observations, not scores.
