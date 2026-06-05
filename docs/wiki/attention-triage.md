---
type: concept
title: Attention triage
---

Default-on harness subsystem that distils, from many parallel lanes, the **specific decisions** that need the human — not lane activity. Vocabulary aligns with `CONTEXT.md` (*attention triage*, *judgement item*, *demand queue*, *silent pile*, *backpressure gauge*).

## Problem being solved

The human's attention is the serial bottleneck of an agent fleet ("orchestration tax"). Dashboards that surface *what agents are doing* recreate the busy-not-productive trap. Attention triage surfaces only *self-flagged judgement* and batches review in one summon-on-demand place.

## Core objects

### [[judgement-item]]

A single specific decision (e.g. "pick auth schema direction") — not a whole lane, not a whole turn. Created when a lane calls [[attention-flag]] at end-of-turn.

### Demand queue

Open judgement items, ranked by `reversibility` (`irreversible` > `costly` > `reversible`), ties **oldest first**. [[lane-peek-heat]] is explicitly **not** used — activity ≠ judgement weight.

### Silent pile

Turns that ended without a flag, plus items a lane `attention_resolve`d. Reviewable on demand; **not** auto-approved or deleted. "Silent" means the machine proceeded without demanding attention, not that the human waived review.

### Backpressure gauge

Static workspace-footer chip: open count (summed across harness tabs), weight-dynamic colour by heaviest open reversibility tier (spec 138), pip strip for count. No blink/pulse — depth signal only. Hidden at zero.

## Human review (overlay)

Summoned with `Leader ;`. One ranked card at a time; `j`/`k` page; header shows cursor (`2 / 5`).

| Key | Action |
|-----|--------|
| `a` | Acknowledge — dequeue, **no lane effect** (lane already took `chosen`) |
| `r` | Redirect — inject correction via `enqueueSystemPrompt` on lane's **next idle** |
| `o` / Enter | Dig — open lane transcript |
| Esc | Dismiss overlay |

Defer = do nothing; item stays ranked. No dismiss/delete action.

## Silent-turn audit (v1)

Pure self-report means a lane that never flags dangerous work raises no item ([[attention-triage-trust-model]]). Mitigation: per-lane `LaneTriageStats` — flagged vs silent turn counts shown in overlay header; human can spot-check transcript. Count + jump, not a full pile browser (deferred).

## Lane participation

Spec 130: all harness-memory lanes are equipped at creation (`AttentionTriageStore.equip`); silent-turn audit starts from first response. `HarnessLane.triageEquipped` remains for audit/UI continuity.

## Related

- [[attention-flag]] — lane-side MCP tool
- [[attention-triage-trust-model]] — architectural trust choices
- `docs/128-attention-triage.md`, `docs/138-attention-gauge-weight-dynamic.md`
