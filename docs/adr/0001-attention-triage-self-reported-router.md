# Attention triage is a non-blocking, self-reported router — not a gatekeeper, observer, or blocker

## Context

Krypton's ACP harness runs multiple agent lanes in parallel. Per *The Orchestration Tax* (Addy Osmani, 2026), the human's attention is the single serial bottleneck — the GIL of the agent fleet — and the failure mode is "feeling busy" decoupled from shipped work. Attention triage surfaces, per lane, the specific decisions that genuinely need human judgement (see `CONTEXT.md`: *judgement item*, *demand queue*, *silent pile*, *backpressure gauge*).

## Decision

We chose, against reasonable alternatives, the following shape:

1. **Judgement items are produced by pure lane self-report** (a new `attention_flag` MCP tool injected per-lane, user-chosen), *not* by an independent observer LLM and *not* backed by a deterministic floor (e.g. forced flags on large diffs / sensitive paths). The agent decides what needs human judgement.
2. **Triage is non-blocking and end-of-turn only.** A lane always proceeds with its best guess and flags for later review; it never halts to wait for the human. There is no blocking judgement mode.
3. **Triage is a router, not a gatekeeper.** A turn with no flagged item is not auto-approved — it falls into the silent pile, reviewable on demand. A lane may *retract* an item (demote to self-resolved) but nothing is deleted. The human keeps the lock; the LLM only orders what to look at first.
4. **The demand queue ranks by reversibility / blast-radius, never by `lane peek heat`.** Activity heat measures busy-ness, which the source argues is decoupled from what needs judgement; reusing it would import the busy-not-productive trap into the feature meant to fix it. (This sort choice is cheap to reverse and is recorded here only as the rationale for *not* reusing heat.)

## Considered Options

- **Independent observer LLM** watching all lane streams — rejected: it is itself a new piece of orchestration machinery to maintain, adds latency before work reaches the human, and can mis-judge just like the working agent.
- **Deterministic floor** forcing flags on large diffs / sensitive paths even when the lane is silent — rejected by the user in favour of trusting self-report.
- **Blocking judgement mode** (lane waits like `needs_permission` / `awaiting_peer`) — rejected: returns the fleet to "every lane stalled waiting for you," the exact tax the feature targets.

## Consequences

- **Accepted risk: cognitive surrender.** A lane that mis-judges its own work ("no judgement needed") on a dangerous change raises no judgement item — that turn never demands attention. This is the price of pure self-report; there is no automatic safety net. The only mitigation is auditability, and that mitigation must actually ship: v1 surfaces a per-lane silent-turn count plus jump-to-transcript (the "minimal silent-turn audit" in `docs/128-attention-triage.md`) so a human can spot-check what the lanes decided *not* to flag. The presence floor on `tradedOff` / `uncertainty` fields is a prompt to the agent, **not** a guard against low-quality "rosy" cards — the human reading those fields during review is the actual defense.
- **Accepted risk: late redirect cost.** Because lanes never block, a human `redirect` may arrive several turns late (delivered on the lane's next idle via the existing `InterLaneCoordinator` / `enqueueSystemPrompt` path). The resulting rework is treated as cheap machine work, traded for saved human attention.
- The `attention_flag` tool must carry a strong "never flag proactively / only on genuine judgement" guard, mirroring `peer_send` and `review_request`; without it the demand queue floods and the backpressure gauge lies.
- **Follow-up (spec 129): per-lane opt-in may be *sourced* from a directive.** The trust model is unchanged — equip is still per-lane and opt-in, never harness-wide — but the source of the grant can now be a directive (`triage_equipped = true`, spec 124) in addition to the manual `Leader '` toggle. This is a *spawn-time default grant*: a lane born with the directive is equipped before its first `tools/list`. A manual override still wins over the directive and survives a directive's deletion/disable. Because the grant is a capability (who may call for the human's attention), the directive approval card surfaces it explicitly rather than hiding it in TOML metadata. See `docs/129-directive-triage-grant.md`.
