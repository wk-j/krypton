---
type: decision
title: "Simplify #review to ride peer_send (spec 145 supersedes 112)"
tags: [decision]
---

# Decision: simplify `#review` to ride `peer_send`

**Date:** 2026-06-06 · **Spec:** `docs/145-harness-design-review-panel.md`
(supersedes the delivery/findings/UI machinery of `docs/112-acp-review-lane-mode.md`).

## Decision

Remove the structured "Review Lane Mode" and re-implement [[review-command]]
as an agent-orchestrated multi-reviewer fan-out over [[peer-send]]. The net
change is a large **deletion**.

Removed:
- the `review_request` / `review_reply` MCP tools and their Rust handlers,
- the `ReviewPacket` / `ReviewFinding` schema and the `ReviewCard` UI (+ its
  CSS),
- the `review` envelope / transcript *kind*,
- all coordinator-side review state (`inFlightReviews`, `openReviewPackets`,
  `assignedReviewPackets`, the dedicated delivery path, the per-sender
  in-flight guard, the lane-close review fan-out),
- lane state `reviewedThrough` / `reviewReplyAttemptsThisTurn`.

Retained: a **simplified shared git-state collector** —
[[review-git-state-collector]] — because [[attention-triage]] still consumes
its diffstat for a flagged decision's blast-radius.

## Why

The structured Review Lane Mode was **over-engineered for a keyboard tool
with a human in the loop**:

- It carried a worktree fingerprint, partial-staging detection, churn-sorted
  hunk caps, a rigid findings schema, dedicated MCP tools, a bespoke delivery
  path, and a card UI — substantial machinery and surface area.
- Critically, it reviewed **one lane only**. The whole point of a multi-lane
  harness is getting *several* independent perspectives; a single-reviewer
  protocol misses that.

Modelling `#review` on the `#wiki` pattern (one-shot injected prompt, see
spec 144) collapses all of that into a prompt string plus the retained
collector. The discipline lives in the prompt, not in code/state.

## Trade-offs accepted

- **B2 — best-effort, not guaranteed.** All-reviewer delivery and synthesis
  are now model-driven: the convening lane *should* fan out to every reviewer
  and synthesize, but nothing in the harness enforces it. The user chose this
  over rebuilding coordinator-side guarantees. See the open question in
  [[review-command]].
- Round-robin lenses partially compensate for losing the structured findings
  schema — they push reviewers toward complementary coverage instead of a
  rigid form.

## Provenance

Spec 145 was reviewed pre-implementation by peer lanes (architecture/
correctness + requirements-fit/simplicity); their findings — the `peer_send`
"end your turn" fan-out risk, untracked / unborn-HEAD gaps, intent-in-prompt,
the skim template — were folded into the spec. The implementation commit was
later reviewed again by peer lanes; that review surfaced doc-drift and
collector edge cases (carried as open questions on
[[review-git-state-collector]]) but no blockers.
