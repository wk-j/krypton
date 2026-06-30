# Attention Triage — Acknowledge Sends Feedback — Implementation Spec

> Status: Implemented
> Date: 2026-06-30
> Milestone: M-ACP — Harness Multi-Agent
> Terms: see `CONTEXT.md` → **Attention flag**, **Attention triage**
> Related: `docs/128-attention-triage.md`, `docs/106-inter-lane-messaging.md`, `src/acp/attention-triage.ts`, `src/acp/inter-lane.ts`

## Problem

When a lane raises an `attention_flag`, it proceeds with its best guess (`chosen`) and the decision lands in the human's triage queue. The human has two actions: **acknowledge** (`a`) and **redirect** (`r`). Today **acknowledge is silent** — `AttentionTriageStore.accept()` is "pure bookkeeping, no lane effect" (`attention-triage.ts:112`): it clears the item from the queue and tells the lane *nothing*. So the lane that made a guess never learns the human reviewed and approved it. And because acknowledge clears the item, the human cannot then `r`-redirect it — the two actions are mutually exclusive, and the only one that talks back to the lane (`redirect`) requires typing a steer. A human who simply *approves the guess* has no way to send that confirmation back.

## Solution

Make **acknowledge deliver feedback to the lane**, mirroring redirect's delivery path. Pressing `a` now (a) injects a short **acknowledgement envelope** into the flagging lane via a new `InterLaneCoordinator.deliverAcknowledge(laneId)` — "the human reviewed the decision you flagged and approved your chosen approach; no course change needed" — and (b) marks the item `accepted` as today. Redirect is unchanged (typed steer). The acknowledgement message is explicitly **no-op-friendly**: it tells the lane that if the flagged work is already complete, no reply or new work is required — so a confirmation never forces a vacuous turn's worth of output. Delivery reuses the exact `injectHarnessEnvelope` path redirect uses (drains on the lane's next idle turn); no new transport, no new lane state.

## Research

- **Redirect already has the pattern.** `deliverRedirect(laneId, text)` (`inter-lane.ts:376`) guards `unknown_lane`/`lane_stopped`, builds an `[attention] …` message, and calls `injectHarnessEnvelope(laneId, message)` (inbox drop, drained on idle — spec 106/116). `deliverAcknowledge` is the same shape with a fixed approve-and-proceed body and no `text` arg.
- **Acknowledge is silent *by design* today.** `accept()` is documented "no lane effect"; the harness handler (`acp-harness-view.ts:4126-4130`) calls `triageStore.accept(item.id)` + `flashChip('acknowledged')` only. This spec reverses that decision deliberately (the silence is the reported gap). The store method stays pure bookkeeping — the **lane effect is added in the harness handler**, alongside the existing redirect handler, keeping the store transport-free.
- **Re-engagement cost is the one real tradeoff.** A confirmation envelope wakes an idle lane for one drain turn. Mitigated by the message body explicitly authorising a no-op ("if the flagged work is complete, no reply/new work is required"), so the agent need not produce output just to acknowledge. This is the cost the original "silent" design avoided; the user has chosen feedback over silence.
- **Failure parity.** Redirect, on `lane_stopped`/`unknown_lane`, surfaces a notice and leaves the item; acknowledge should still clear the item (bookkeeping) but flash that the lane could not be notified (it's stopped — nothing to tell).

## Prior Art

| System | Behavior | Notes |
|--------|----------|-------|
| Krypton `deliverRedirect` (spec 128) | human steer → injected `[attention]` envelope, drains on idle | the direct precedent — acknowledge copies its delivery |
| GitHub PR review "Approve" vs "Request changes" | both notify the author; approve is not silent | acknowledge ≈ Approve (notify + no required change); redirect ≈ Request changes |
| Code-review tools generally | an approval is a signal the author receives | reinforces: a human sign-off should reach the actor, not just clear a queue |

**Krypton delta** — Acknowledge becomes the "approve, proceed" signal (notifies, requires nothing) and redirect stays the "change course" signal (notifies, carries a steer). Both now talk back to the lane; neither is silent. Same one-native-window, keyboard-first triage overlay — no UI restructure, only the `a` action's effect changes (+ a hint tweak).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/inter-lane.ts` | New `deliverAcknowledge(laneId): { delivered, reason? }` — same guards + `injectHarnessEnvelope` as `deliverRedirect`, with a fixed approve-and-proceed, no-op-friendly body. |
| `src/acp/acp-harness-view.ts` | `a` handler (`handleTriageKey` ~4126): call `coordinator.deliverAcknowledge(item.laneId)` before `triageStore.accept(item.id)`; flash `acknowledged → <lane>` on delivery, or `acknowledged (lane stopped — not notified)` on failure. Triage overlay hint: `a acknowledge (tells lane)`. |
| `src/acp/attention-triage.ts` | Clarify the `accept()` comment: store stays pure bookkeeping; the lane-notify effect lives in the harness handler (not the store). |
| `src/acp/inter-lane.test.ts` *(or acp test)* | Unit-test `deliverAcknowledge`: delivers to a live lane; returns `lane_stopped` for a stopped lane; message contains the approve + no-op-required wording. |
| `docs/128-attention-triage.md` | Update: acknowledge is no longer silent — it sends an approve-and-proceed envelope (with the re-engagement note + no-op-friendly mitigation). |

## Design

### New coordinator method (mirrors deliverRedirect)

```ts
deliverAcknowledge(laneId: string): { delivered: boolean; reason?: 'unknown_lane' | 'lane_stopped' } {
  const lane = this.host.getLane(laneId);
  if (!lane) return { delivered: false, reason: 'unknown_lane' };
  if (lane.status === 'stopped' || lane.status === 'error') return { delivered: false, reason: 'lane_stopped' };
  const message =
    '[attention] The human reviewed the decision you flagged and acknowledged it — your chosen approach is approved; ' +
    'no course change is needed.\n\n' +
    'This is a confirmation only: if the flagged work is already complete, no reply or new work is required. ' +
    'Continue only if there is remaining work on this task.';
  this.injectHarnessEnvelope(laneId, message);
  return { delivered: true };
}
```

### Handler (triage overlay `a`)

```
1. press a → item = selected. result = coordinator.deliverAcknowledge(item.laneId).
2. triageStore.accept(item.id)   // bookkeeping, unchanged — clears from queue regardless.
3. flash: delivered → 'acknowledged → <lane>'; !delivered → 'acknowledged (lane stopped — not notified)'.
```

Redirect (`r`) path unchanged. Lane self-resolve (`attention_resolve`) unchanged.

## Edge Cases

- **Flagging lane stopped/error:** envelope not delivered (nothing to notify); item still clears; flash says so.
- **Flagging lane busy / awaiting_peer:** envelope queues and drains on the lane's next idle (spec 116), same as redirect.
- **Lane already idle and done:** drains the envelope, reads "no reply required," may end the turn with no output — by design (no forced vacuous turn).
- **Acknowledge then nothing more from human:** lane has its approval; proceeds/closes normally.

## Open Questions

1. **Optional note on acknowledge** — *Proposed: no.* `a` sends the fixed approve-and-proceed message (one keystroke); a human who wants to add words uses `r` (redirect), which already carries typed text. Confirm vs. letting `a` open an optional one-line note like redirect.

## Out of Scope

- Changing redirect, lane self-resolve, or the gauge/weighting (spec 138).
- A distinct "approve with edits" third action — acknowledge (approve) and redirect (steer) remain the two.
- New Rust command / MCP tool / lane state / telemetry channel.

## Resources

- `src/acp/inter-lane.ts:376` (`deliverRedirect`) — the delivery pattern copied.
- `src/acp/attention-triage.ts:112` (`accept`) — the silent behavior being changed.
- `src/acp/acp-harness-view.ts:4126` (triage `a` handler), `:4173` (`submitTriageRedirect`) — handler prior art.
- `docs/128-attention-triage.md`, `docs/106-inter-lane-messaging.md`, spec 116 (inbox drain-on-idle).
- N/A external — purely internal change over existing triage + inter-lane code.
