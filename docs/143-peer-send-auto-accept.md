# peer_send Auto-Accept — Implementation Spec

> Status: Implemented (blanket accept EXCEPT high-risk commands, which still prompt; revised after Codex-1 + Cursor-1 peer review)
> Date: 2026-06-04
> Milestone: ACP harness — inter-lane messaging (spec 106 / 141 line)

## Problem

When one lane delegates work to a peer via `peer_send`, the recipient processes
the message as an injected turn. Any tool call that turn raises a permission
prompt that **a human must clear** — even though the delegation was the whole
point. A user orchestrating a "lane A asks lane B to do X" workflow has to sit
and babysit B's permission gate. There is no way for the delegating send to say
"run this autonomously."

## Solution

Add an optional `auto_accept` boolean to `peer_send`. When set, the recipient's
peer-injected turn auto-resolves permission requests **except high-risk ones**,
which still prompt the human. Concretely:

- A **dedicated** per-turn flag `lane.peerAutoAcceptForTurn` (NOT a reuse of
  `acceptAllForTurn`, which is an unconditional blanket — see Mechanism). It arms
  the recipient's injected turn and resets at turn end like the existing flag.
- In the permission gate, an armed peer turn auto-accepts a request **only when it
  is not high-risk**. High-risk is decided by the existing, tested classifier
  `classifyBashCommand().highRisk` (`src/agent/tools.ts`) — destructive bash verbs
  (`rm`, `dd`, `shred`, `truncate`, `mv`, `cp`, `ln`, `rsync`, `chmod`, `chown`,
  `sed -i`), dangerous git (`reset --hard`, `clean -fd`, `checkout .`,
  `push --force`), and the conservative `script` / `network` / `unknown` /
  redirection cases. High-risk requests fall through to the normal pending queue
  and prompt the human.
- **Honored only for same-view sibling lanes.** A foreign / cross-harness sender's
  `auto_accept` is coerced to `false`; the sender is told so via the `peer_send`
  result, mirroring the `done`-coercion safety pattern and the spec 141
  cross-project trust boundary.
- **Visible** via a dedicated status chip and a system transcript line naming the
  granting peer (an *agent* armed it, not the human — make that legible).

## Research

- **Existing per-turn accept-all (verified).** `addPermission`
  (`acp-harness-view.ts:3834-3838`) auto-resolves a queued permission when
  `lane.acceptAllForTurn` is set; the human arms it manually with `A` (`:7210`).
  That flag is an **unconditional** blanket — it does not classify risk — so it is
  the wrong primitive for "except destructive". A dedicated flag is required.
- **The flag also auto-accepts fs write reviews (verified, Codex-1).**
  `acceptAllForTurn` is checked again in `appendFsWriteReview` (`:6908`), calling
  `respondFsWrite(..., true)`. The new `peerAutoAcceptForTurn` must be wired into
  **both** surfaces. File writes are low-risk (diff shown + VCS-recoverable, per
  spec 140), so they are auto-accepted under peer-auto; only bash commands are
  risk-classified.
- **Risk classification already exists and is reusable (verified).**
  `classifyBashCommand(command)` (`agent/tools.ts:164`) returns `{ …, highRisk }`,
  the single source of truth from spec 140 (table-driven tests in `tools.test.ts`).
  `extractCommandLine(call.rawInput)` is already used inside `acp-harness-view.ts`
  (`:8930`, `:10791`) to pull the command string from a permission's toolCall, and
  the same file's `permissionToolKind`-style logic treats a toolCall with a
  command as `execute`. So the harness can classify without new parsing.
- **Turn-end reset paths (verified).** `acceptAllForTurn` resets at `:3475`
  (error), `:3748` (stop/cancel), `:5071`, `:5131`, `:6893` — all **turn-end**,
  never turn-start. `peerAutoAcceptForTurn` resets at the same five sites.
- **enqueue catch leaks the flag (verified, both reviewers).**
  `enqueueSystemPrompt` (`:1371-1377`) catch sets `error` but does **not** reset
  turn flags. Arming there then a `client.prompt()` throw would strand the flag
  into a later manual turn. The catch must clear `peerAutoAcceptForTurn`.
- **Foreign-sender detection (verified).** Same-view listener rewrites `fromLaneId`
  to an internal id (`:1411-1414`); cross-view inbound keeps the sender
  `displayName` (`:1447`). `host.getLane` keys on `lane.id`, so a foreign sender is
  `null` in `drain` (`:928`) — the coercion gate, no new identity machinery.
- **Envelope plumbing (verified).** Rust `peer_send` (`hook_server.rs:1050`) emits
  the envelope; the listener does `{ ...env, … }`, so a new field flows through
  once Rust emits it and `InterLaneEnvelope` declares it.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code (subagents) | A spawned subagent inherits the parent's permission mode; `acceptEdits` flows down so the delegate does not re-prompt for edits, **but bash still prompts**. | The exact model here: delegation inherits edit-trust, never blanket bash. |
| Claude Code (`acceptEdits`) | Auto-accepts file edits + basic fs ops; all other bash prompts. | Matches our "writes auto, commands risk-gated" split. |
| Cursor (YOLO denylist) | Auto-runs allow/deny-listed commands; denylist shown bypassable (base64 `curl`). | spec 140 lesson: treat unknown as high-risk — which `classifyBashCommand` already does. |
| Zed agent | Per-tool "always allow"; no per-delegation grant. | No equivalent of a delegated autonomous turn. |

**Krypton delta** — Match Claude Code's "delegation auto-accepts edits but never
blanket-approves commands" stance, generalized via the spec 140 `highRisk`
classifier (destructive verbs + conservative unknowns still prompt). Diverge:
the grant is set by a *peer agent* (made legible with a chip + named system line),
scoped to a single injected turn, refused across the cross-harness trust boundary,
and disarmed only by `#cancel` / turn end (harness `Esc` on a permission row =
reject, NOT disarm — unlike agent-view spec 140).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | `peer_send` parses optional `auto_accept` (default false); add `"autoAccept": auto_accept` to the envelope JSON; add `auto_accept` to the `peer_send` `inputSchema` (delegation grant; same-view only; high-risk still prompts). |
| `src/acp/types.ts` | Add `autoAccept?: boolean` to `InterLaneEnvelope`. |
| `src/acp/inter-lane.ts` | Add `autoAcceptPermissions?: boolean` to `CoordinatorDrainContext`. In `drain`, set it true iff **every** drained *mail* envelope is local (`getLane` non-null) **and** has `autoAccept` (tightened from "any" → "all", per Codex-1; otherwise do not arm). Pass to `enqueueSystemPrompt`. |
| `src/acp/acp-harness-view.ts` | Add `peerAutoAcceptForTurn: boolean` lane field (+ default false). In `enqueueSystemPrompt`, when `drain?.autoAcceptPermissions`, set it true and append a system line naming the peer; **clear it in the catch**. In `addPermission`, new branch: if `peerAutoAcceptForTurn && !isHighRiskPermission(permission)` → `resolvePermission(lane,'accept',true)` (reason "peer-auto"). Add `isHighRiskPermission` (execute-kind → `classifyBashCommand(extractCommandLine(rawInput)).highRisk`; non-command → false). Wire `peerAutoAcceptForTurn` into `appendFsWriteReview` (`:6908`) auto-resolve and into all five turn-end resets (`:3475/:3748/:5071/:5131/:6893`). Render a dedicated chip near `:9740`. |
| `src/agent/tools.ts` | None — `classifyBashCommand` / `highRisk` reused as-is (import only). |
| `docs/106-inter-lane-messaging.md`, `docs/PROGRESS.md`, `CLAUDE.md` | Document the `auto_accept` param + semantics. |

## Design

### Data Structures

```ts
// types.ts
export interface InterLaneEnvelope {
  // ...existing...
  /** spec 143: sender requests the recipient's peer-injected turn auto-accept
   *  non-high-risk permissions. Honored only for same-view sibling senders;
   *  coerced to false (and reported back) for foreign/cross-harness senders. */
  autoAccept?: boolean;
}

// inter-lane.ts
export interface CoordinatorDrainContext {
  envelopeIds: string[];
  primaryPeerDisplayName: string | null;
  envelopeCount: number;
  autoAcceptPermissions?: boolean; // spec 143
}

// acp-harness-view.ts — HarnessLane
peerAutoAcceptForTurn: boolean; // armed for one injected turn; reset at turn end
```

### Risk gate

```ts
private isHighRiskPermission(p: HarnessPermission): boolean {
  const cmd = extractCommandLine(p.toolCall.rawInput);   // null for non-command surfaces
  if (!cmd) return false;                                // edits/writes/etc → not gated here
  return classifyBashCommand(cmd).highRisk;              // spec 140 single source of truth
}
```

### Permission gate (addPermission, after harness/artifact auto-allow checks)

```ts
lane.pendingPermissions.push(permission);
this.setLaneStatus(lane, 'needs_permission');
if (lane.acceptAllForTurn || lane.rejectAllForTurn) {            // existing
  void this.resolvePermission(lane, lane.rejectAllForTurn ? 'reject' : 'accept', true);
  return;
}
if (lane.peerAutoAcceptForTurn && !this.isHighRiskPermission(permission)) {  // spec 143
  void this.resolvePermission(lane, 'accept', true);            // high-risk stays pending → human
}
```

### Data Flow

```
1. Lane A: peer_send { to_lane:"Claude-2", message, auto_accept:true }
2. Rust emits acp-inter-lane-message { ..., autoAccept:true }
   - cross-view target → autoAccept stripped; result hint "auto_accept ignored: cross-view sender"
3. listener spreads ...env → coordinator.deliver(translated)
4. recipient idle → Coordinator.drain(laneId)
5. drain: ALL mail envelopes local && autoAccept? → drainCtx.autoAcceptPermissions = true
6. host.enqueueSystemPrompt(laneId, text, drainCtx)
7. enqueueSystemPrompt: lane.peerAutoAcceptForTurn = true;
   appendTranscript(system, "auto-accept (non-high-risk) armed by <A> for this turn");
   chip shows. (catch → clear the flag if prompt throws.)
8. addPermission per request: not-high-risk → auto-accept; high-risk → stays pending (human prompts).
   fs write reviews → auto-accepted (low-risk).
9. turn ends / #cancel → peerAutoAcceptForTurn reset to false.
```

### UI Changes

Dedicated status chip `peer-auto` (distinct from `accept-all`) near `:9740`, plus
one `system` transcript line per armed turn naming the granting peer. No new DOM
structure beyond the chip span.

### Configuration

None.

## Edge Cases

- **High-risk request during armed turn** → not auto-accepted; lane stays
  `needs_permission`; human resolves it. (The point of "except destructive".)
- **Unparseable / unknown command** → `classifyBashCommand` returns
  `highRisk:true` → prompts (conservative, spec 140).
- **Foreign / cross-harness sender** → `autoAccept` stripped; never arms; sender's
  `peer_send` result carries `auto_accept ignored: cross-view sender`.
- **Mixed batch** → arm only if **every** mail envelope is local + `autoAccept`;
  one non-delegated or foreign envelope in the drained turn ⇒ no arming (prevents
  privilege amplification across the single composed prompt, per Codex-1).
- **`enqueueSystemPrompt` prompt throw after arming** → catch clears
  `peerAutoAcceptForTurn` (and existing flags) so it never leaks into a later
  manual turn.
- **fs write review** → auto-accepted under peer-auto (low-risk, recoverable);
  documented, not silent.
- **Replier sets `auto_accept`** → **not honored in v1**; only request/initiation
  envelopes arm. (Codex-1: avoid a callee granting itself influence over the
  initiator's lane. Drop reply-side arming until a concrete workflow needs it.)
- **`auto_accept` + `done:true`** → orthogonal; both may be set (fire-and-forget
  autonomous delegation).
- **No permission requests that turn** → flag set, unused, auto-resets. Harmless.

## Product Decision — high-risk still prompts; everything else auto-accepts

Per the user: blanket auto-accept **except destructive/high-risk commands**, which
continue to prompt the human. We reuse spec 140's `highRisk` classifier as the gate
(the single tested source of truth); it is a *superset* of bare "destructive verbs"
— it also holds `script` / `network` / `unknown` / redirection — which is strictly
safer and avoids a second, divergent classification. If the user later wants a
narrower destructive-verbs-only gate, that is a one-line predicate change.

This resolves Codex-1's core objection (a peer agent must not be able to silently
auto-accept destructive commands) while keeping the autonomous-delegation
ergonomics the user asked for. Cursor-1's blanket-for-v1 stance is superseded by
the user's explicit "except destructive" choice.

## Open Questions

None blocking. Resolved: (1) dedicated `peerAutoAcceptForTurn` flag, not a reuse of
the unconditional `acceptAllForTurn`; (2) high-risk gate = spec 140 `highRisk`
superset; (3) same-view only, foreign coerced + reported; (4) mixed batch armed
only when all-local-all-autoAccept; (5) catch-path cleanup; (6) fs write reviews
auto-accepted (documented); (7) v1 honors initiation envelopes only, not replies.

## Out of Scope

- A narrower "destructive-verbs-only" gate (reuse the broader `highRisk` superset).
- Honoring `auto_accept` across the cross-harness trust boundary.
- Reply-side (`callee`) auto-accept arming.
- A persistent multi-turn autonomous mode; a config-driven default.
- Changing the agent-view classifier or the ACP permission protocol.

## Acceptance Criteria / Tests

- Local `auto_accept` → chip shown; non-high-risk permission auto-resolved.
- Local `auto_accept` + **high-risk** execute command → stays pending, human prompts.
- Cross-view inbound with `autoAccept:true` → not armed; sender gets coercion hint.
- Mixed local+foreign (or local non-delegated) batch → turn not armed.
- `client.prompt` throw after arming → `peerAutoAcceptForTurn` cleared.
- fs write review under peer-auto → auto-accepted.
- Back-to-back peer turns: flag cleared at turn 1 end, re-armed on turn 2 only if requested.
- Replier-set `auto_accept` → ignored (turn not armed).

## Resources

- [Claude Code — Subagents](https://code.claude.com/docs/en/sub-agents) — delegated agents inherit edit-trust, not blanket bash.
- [Claude Code — Permission modes](https://code.claude.com/docs/en/permission-modes) — `acceptEdits` scope; bash still prompts.
- `docs/140-approval-gate-safety.md` — the `highRisk` classifier reused here and the "unknown ⇒ high-risk" stance.
- `docs/141-cross-harness-peering.md` — cross-project trust boundary gating foreign `auto_accept`.
