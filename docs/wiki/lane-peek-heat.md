---
type: concept
title: Lane peek heat
---

Deterministic score ranking lanes by **activity** — tools, tokens, peer traffic, process state, plus alert boosts (`error` > `needs_permission` > `pendingShell` > `awaiting_peer`). Pre-LLM baseline for "which lane looks busy."

## Contrast with [[attention-triage]]

Heat measures *busy-ness*; [[attention-flag]] surfaces *judgement weight*. The demand queue deliberately does **not** consult heat when ranking [[judgement-item]]s (see [[attention-triage-trust-model]]) — coupling them would recreate the orchestration tax triage targets.

## Related

- [[attention-triage]] — judgement-first routing
- `CONTEXT.md` — glossary entry
