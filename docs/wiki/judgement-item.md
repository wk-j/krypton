---
type: entity
title: Judgement item
---

The unit of [[attention-triage]]: one specific decision within a lane's work that genuinely requires human judgement — not a whole lane, not a whole turn.

## Lifecycle

1. **Created** — lane calls [[attention-flag]]; harness inserts item with `status: open`.
2. **Open** — ranked in the demand queue until the human acts or the lane self-resolves.
3. **Terminal** — `accepted` (human acknowledge), `redirected` (human correction queued), or `self_resolved` (lane `attention_resolve`). Terminal items leave the demand queue but remain in the store (silent pile).

Human acknowledge does **not** signal the lane — the lane already proceeded with `chosen`. Redirect may arrive several turns late (next-idle delivery); rework is accepted as cheap machine work.

## Stored fields

Beyond the flag payload (`question`, `chosen`, `rationale`, `tradedOff`, `uncertainty`, `reversibility`):

- `id`, `laneId`, `createdAt`, `status`
- `packetId`, `diffstat` — git blast-radius from `buildReviewPacket`, filled asynchronously after insert so the MCP round-trip does not wait on git

Overlay always renders traded-off and uncertainty blocks (never collapsed).

## Related

- [[attention-flag]] — creation path
- [[attention-triage]] — queue ranking and human actions
