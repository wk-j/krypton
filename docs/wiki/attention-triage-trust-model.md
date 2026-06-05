---
type: decision
title: Attention triage trust model
---

Recorded in `docs/adr/0001-attention-triage-self-reported-router.md`. Governs [[attention-triage]] and [[attention-flag]] behavior.

## Decisions (settled)

1. **Pure lane self-report** — judgement items come from `attention_flag`, not an observer LLM and not a deterministic floor (e.g. forced flags on large diffs). The working agent decides what needs human judgement.

2. **Non-blocking, end-of-turn only** — lane always proceeds with `chosen`; never waits like `needs_permission` or `awaiting_peer`.

3. **Router, not gatekeeper** — unflagged turns fall to the silent pile (not auto-approved). Lanes may `attention_resolve`; humans acknowledge/redirect. Nothing is deleted.

4. **Rank by reversibility, not [[lane-peek-heat]]** — activity heat measures busy-ness; reusing it would import the trap triage is meant to fix.

5. **Default-on tools (spec 130)** — superseded per-lane opt-in / directive grant for ergonomics and `tools/list` one-shot clients. `triage_equipped` is legacy metadata only.

## Rejected alternatives

| Option | Why rejected |
|--------|----------------|
| Independent observer LLM | New orchestration machinery, latency, same mis-judgement risk |
| Deterministic flag floor | User chose to trust self-report over forced flags |
| Blocking judgement mode | Recreates "every lane stalled waiting for you" |

## Accepted risks

- **Cognitive surrender** — lane mis-judges "no fork" on dangerous work → no item. Mitigation: silent-turn audit counts + transcript spot-check (v1 minimal).
- **Late redirect** — human correction may land after several more turns.
- **Queue flood / silence** — calibration is two-sided (spec 134): over-flagging and under-flagging both degrade the queue; prompt framing leads with positive fork triggers.

## Open questions

None recorded for the core model. Card *quality* beyond the presence floor remains a human-reading problem, not an enforced safeguard.

## Related

- [[attention-flag]], [[attention-triage]], [[judgement-item]]
