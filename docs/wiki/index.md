# Code Wiki — Index

The persistent *why* layer for Krypton: rationale, domain model, decisions,
trade-offs. Code and git cover *what/how*. Pages are flat and linked by
filename stem via `[[page]]`.

## Concepts

- [[review-command]] — `#review`: agent-orchestrated multi-reviewer fan-out over `peer_send`.

## Decisions

- [[simplify-review-to-peer-send]] — why spec 145 deleted structured Review Lane Mode and rode `peer_send` instead.

## Entities

- [[review-git-state-collector]] — the shared git-state snapshot, kept for `#review` and attention triage.
