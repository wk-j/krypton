---
type: concept
title: attention_flag (MCP tool)
---

The harness MCP tool a lane calls to surface **one decision per turn** that genuinely needs human judgement. The user-facing name in prompts is *attention flag*; the tool identifier is `attention_flag` (paired with `attention_resolve`).

## Why it exists

Running many ACP lanes is cheap; closing the loop on them is not. [[lane-peek-heat]] ranks lanes by *activity* (tools, tokens, CPU) — busy-ness decoupled from what actually needs human judgement. `attention_flag` is the lane-side hook for the complementary signal: *self-reported forks* the human may want to weigh in on, without blocking the lane's work.

See [[attention-triage]] for the demand queue, overlay, and backpressure gauge built on top of flagged items.

## When a lane should call it

Settled calibration (spec 134, after default-on exposure showed near-zero use under prohibition-heavy prompts):

- **Flag** at end-of-turn when the lane hit a *real fork*: picked among ≥2 genuinely viable approaches the user could reasonably decide differently on; resolved a consequential ambiguity in user intent by guessing (one that changes user-visible outcome, architecture, or workflow); or did something costly or hard to undo.
- **Skip** the routine, reversible, machine-verifiable ~80% — at most **one flag per turn**, never to cover yourself.
- **Symmetric error**: letting a genuine fork pass unflagged degrades the queue as much as trivia flags do.

The tool is **non-blocking**: the lane proceeds with `chosen` and keeps working; the human reviews later.

## Payload (presence floor)

Required fields on every call:

| Field | Role |
|-------|------|
| `question` | The specific decision needing judgement |
| `chosen` | Best-guess option already taken |
| `rationale` | Why that option |
| `traded_off` | Non-empty list of rejected options + why |
| `uncertainty` | Non-blank: what would change the lane's mind |
| `reversibility` | `reversible` \| `costly` \| `irreversible` — drives queue rank |

The harness **rejects** empty `traded_off` or blank `uncertainty`. That is a **presence floor, not a quality guard** — empty-calorie strings still pass. Defense is human review (those fields are always shown in the overlay, never collapsed) and optional peer review of card quality.

Returns `{ item_id }` so the lane can later call `attention_resolve`.

## Round-trip flow

1. Lane finishes work, calls `attention_flag` via the lane-scoped `krypton-harness-memory` MCP server.
2. Rust `hook_server` validates payload, registers a oneshot, emits `acp-attention-flag`.
3. `AcpHarnessView.handleAttentionFlag` inserts a [[judgement-item]] into `AttentionTriageStore` synchronously (so the bus reply beats the timeout); git blast-radius is enriched asynchronously via `buildReviewPacket`.
4. Lane receives `{ item_id }` and ends the turn.
5. Open count publishes to the workspace footer backpressure gauge; human summons the triage overlay (`Leader ;`) when ready.

`attention_flag` / `attention_resolve` calls are **auto-approved** like other built-in harness MCP tools — auto-allow preserves the non-blocking contract.

## Availability

Since spec 130, every lane that receives `krypton-harness-memory` is advertised both tools by default. Legacy `triage_equipped` on directives is metadata/badge only; it no longer gates visibility. Lanes without harness memory MCP (e.g. some backends) never see the tools.

Discoverability: some backends cap tool discovery, so the lane-context packet names `attention_flag` / `attention_resolve` explicitly so models can target them without relying on search ranking alone.

## Related

- [[attention-triage]] — demand queue, ranking, human actions
- [[attention-triage-trust-model]] — why self-report, non-blocking, router-not-gatekeeper
- Specs: `docs/128-attention-triage.md`, `docs/130-default-attention-triage.md`
- ADR: `docs/adr/0001-attention-triage-self-reported-router.md`
