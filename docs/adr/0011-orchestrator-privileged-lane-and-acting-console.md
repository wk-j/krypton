# Orchestrator is a privileged lane role with an acting console

> Status: accepted
> Date: 2026-06-30

## Context

The ACP harness is deliberately built on **symmetric, equal lanes**: peering is
cooperative (`peer_send` only drops into an inbox the recipient drains on its own
idle turn — no lane drives another), the human is treated as the **single serial
bottleneck** for judgement, and every cross-lane observability surface is
**read-only** (the lane monitor dashboard observes but never mutates; the review
matrix is "observation, not score" per ADR-0004; the controller defers authority
to the frontend per ADR-0007). Spec 180 introduces the **Orchestrator** — one
lane the human elevates as the coordination seat — and the **Orchestrator
console**, an in-app panel that *acts* on other lanes (dispatch work, interrupt /
kill / restart). This is the first asymmetric lane role and the first cross-lane
surface that mutates rather than observes, so a future reader will reasonably ask
why the all-equal / observe-only stance was broken.

## Decision

Accept one privileged, asymmetric lane role (the Orchestrator) and an in-app
console that acts, **bounded** as follows:

- The role is **behavior-neutral**: designation unlocks the console, reserves the
  lane as home for future orchestrator-only tools, and badges it — it does **not**
  inject any prompt or change how the lane's model behaves. Autonomous fan-out
  stays opt-in via the existing `#polly` prompt; role and behavior are decoupled.
- **The AI owns coordination; the human owns judgement and the kill switch.**
  Autonomous dispatch is a cooperative `peer_send` (no forced drain, no session
  wipe); genuine forks still escalate through attention triage; the human retains
  lifecycle override (interrupt-turn / kill / restart) at any moment.
- **At most one orchestrator per harness.** The console reuses existing lane
  primitives (`cancelLane` / `closeLane` / `restartLane`) — it adds no new
  lane-suspend concept and no Rust authority (ADR-0007 still holds).

## Considered Options

- **Keep all lanes symmetric; no orchestrator role.** Rejected: the user wants a
  durable coordination seat and a home for future orchestration tooling, which a
  per-task `#polly` verb alone does not provide.
- **Make the console read-only like the lane monitor dashboard.** Rejected: the
  point of the console is to *act* (dispatch + override) from inside the harness;
  a second read-only surface would duplicate the dashboard.
- **Give the orchestrator lane (the AI) direct authority to command other lanes**
  (force-drain, set another lane's permission mode). Deferred, not accepted here:
  that removes the human from the loop and would need its own ADR + safety design.

## Consequences

The harness now has one structurally special lane and one mutating cross-lane
surface — code and docs that assumed "all lanes are equal" or "cross-lane surfaces
only observe" must treat the orchestrator/console as the documented exception.
Because the role is behavior-neutral and the human keeps the kill switch, the
"human is the bottleneck for judgement" invariant survives; only "the human is the
bottleneck for every dispatch" is relaxed (and only while `#polly` autonomy runs).
AI-driven command of other lanes remains explicitly out of scope until a future
spec revisits it.

**Follow-up (spec 181):** the console may now answer a worker's *pending*
`needs_permission` request (a human-driven accept/reject in place, reusing
`resolvePermission`). This stays inside the "human keeps judgement" bound — it is
the human acting, accepting a high-risk command is blocked from the compact card
(must open the lane for full context), and the *persistent* per-lane permission
*mode* remains deferred per the option above.
