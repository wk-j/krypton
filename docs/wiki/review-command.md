---
type: concept
title: "#review — agent-orchestrated multi-reviewer"
tags: [concept]
---

# `#review` — agent-orchestrated multi-reviewer

`#review` is the ACP-harness composer command for getting a piece of work
reviewed by the *other* lanes in the harness. The defining idea is that the
harness does **almost nothing**: it injects **one** prompt that directs the
convening lane to do the orchestration itself.

## What the command actually does

On `#review [<lane> …] [-- <docpath | note>]` the harness builds a single
prompt (via `enqueueSystemPrompt`) instructing the convening lane to:

1. `peer_send` the review *subject* to **every** chosen reviewer **in one
   turn** — this deliberately overrides the usual "end your turn after one
   `peer_send`" rule (see [[peer-send]]).
2. End the turn; each reviewer's reply arrives later as a separate message.
3. Once all reviewers answer (or the user runs `#cancel`), **synthesize**:
   cluster concerns raised by ≥2 reviewers (high signal), list conflicts
   between reviewers, and note unique catches.
4. Route a *genuine unresolved fork* to the human via [[attention-flag]] —
   never auto-commit or auto-apply fixes.

## Domain choices baked into the prompt

- **Subject = diff *or* design doc.** Bare `#review` reviews the working
  `git diff`; `-- <docpath>` reviews a design document instead. The diff path
  needs a shared worktree, so it is **same-project only** — reviewers are
  drawn from `this.lanes` (the same harness view), not cross-harness peers.
- **Reviewer set is auto-detected.** Bare `#review` = all other live local
  lanes; naming lanes is a *subset override*, not a requirement.
- **Round-robin lenses** (architecture / requirements-fit / simplicity) are
  assigned so reviewers don't all share the author's blind spot. Coverage is
  split deliberately rather than letting reviewers overlap.
- **Skim reply format** (`### Blockers` / `### Warnings`, `path:line —
  concern`) keeps replies scannable for a keyboard-driven, human-in-the-loop
  tool.

## Why it is shaped this way

This is the *simplified* `#review`. It replaced a much heavier structured
"Review Lane Mode" — see the decision [[simplify-review-to-peer-send]] for the
rationale and trade-offs. The feature rides [[peer-send]] and the shared
[[review-git-state-collector]]; it has **no** bespoke MCP review tools, no
review card UI, and no coordinator-side review state.

## Open questions / accepted residuals

- **Delivery + synthesis are model-driven best-effort, not
  harness-guaranteed** — the convening lane could fan out to only some
  reviewers, or skip synthesis. This is the accepted "B2" trade-off recorded
  in [[simplify-review-to-peer-send]]; there is no coordinator-level mutex
  enforcing "all N reviewers answered before synthesis".
- An empty worktree is **no longer rejected** (the old `no_changes` guard was
  removed); a bare `#review` with nothing changed proceeds on intent +
  untracked excerpts only. Whether that should warn the user is unsettled.
