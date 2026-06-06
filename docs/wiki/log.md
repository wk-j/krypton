# Wiki Log

Append-only, chronological. Newest at the bottom.

## [2026-06-06] wiki | bootstrap (post-regeneration): review feature

First content after f36b269 dropped the original bootstrapped pages for
regeneration under the `tags` frontmatter convention. Captured the WHY of the
simplified `#review` from a session that reviewed + committed spec 145:

- Created [[review-command]] (concept) — the agent-orchestrated multi-reviewer
  model, its domain choices (subject = diff or doc, auto-detected reviewers,
  round-robin lenses, synthesis + attention_flag), and the best-effort open
  question.
- Created [[simplify-review-to-peer-send]] (decision) — why structured Review
  Lane Mode (spec 112) was deleted in favour of riding `peer_send` (spec 145),
  with the accepted B2 best-effort trade-off.
- Created [[review-git-state-collector]] (entity) — the one retained piece,
  why it is shared with attention triage, its diff-base correctness decisions,
  and peer-review-surfaced open questions (numstat textconv/sentinel mismatch,
  SHA-256 empty-tree fallback).
