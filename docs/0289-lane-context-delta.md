# Lane Context Delta — Implementation Spec

> Status: Implemented
> Date: 2026-10-13
> Milestone: ACP Harness: prompt efficiency

## Problem

Every user turn re-sends the full lane-context packet (`krypton://acp-harness/lane-context.md`)
ahead of the user's text. Measured with the ACP wire profiler (spec 288) on a solo OMP lane: three
consecutive `session/prompt` requests carried a byte-identical 7,397-char packet (sha
`ab3f53c6…`) next to user texts of 16–120 chars. The packet sits inside a user message, so the
agent's history keeps one copy per turn: 50 turns put roughly 370k chars of duplicate policy into
the context window.

## Solution

Split the packet in two:

1. **Turn header.** Sent every turn and kept small. It carries the lane identity line, a tool-name
   line, and Telegram provenance. The tool-name line keeps spec 130's naming guarantee intact even
   after a compaction Krypton cannot detect.
2. **Lane policy.** Holds the tool rules, peering, directive/role block, and ticket pin. It is sent
   when the agent session has not seen this version yet, and omitted otherwise. "Not seen yet"
   covers a new agent session, a policy hash change, a detected compaction, or the safety refresh
   every 20 turns.

The policy also shrinks. Each rule paragraph becomes a one-line tool index that keeps the tool
*names* in view, which is why spec 130 put them in the packet. The full contract stays in the MCP
tool descriptions, which already carry it (`hook_server.rs:5740-6211`). The one rule needed only
*after* a call — the timeline conflict check — moves into the `timeline_record` ack. That is the
same just-in-time pattern spec 262's `notice` already uses.

The approach works for every backend. No adapter needs to support a system-prompt channel.

## Research

- **Packet assembly.** `buildPromptBlocks` (`acp-harness-view.ts:8525`) →
  `composeLeadingContext` (`:8552`) → `renderPromptMemoryPacket` (`:8593`). It is rebuilt on every
  `sendUserPrompt` (`:8404`), with no "already sent" state.
- **Paths that already skip the packet:** steer (spec 278), agent slash commands (spec 279,
  `:8401`), and everything sent through `dispatchTurn` / `enqueueSystemPrompt` (peer mail, #review,
  #handoff, #recall, feedback). This spec touches only the `sendUserPrompt` path.
- **Section sizes (solo lane, all gates on):**

  | Section | Chars |
  |---|---:|
  | Attention triage | 1,291 |
  | Diff priority | 799 |
  | Timeline (record 1,684 + repair 658 + conflicts 802 + suggest 906) | 4,050 |
  | HTML artifacts | 722 |
  | SVG | 524 |
  | Identity line | 33 |

- **Tool descriptions already duplicate the rules:** `attention_flag` 1,182 chars,
  `mark_review_priority` 1,108, `timeline_record` 1,419, `timeline_merge` 857, `timeline_suggest`
  952, `artifact_new` 895. The packet paragraphs repeat them almost word for word.
- **Why the packet names tools (spec 130:63, spec 106:184).** Capped or deferred tool search can
  rank `attention_flag` out of view. Codex defers all MCP tools once there are 100 or more. A
  one-line index that names the tool still solves this.
- **Lane lifecycle.** Every respawn of an existing lane goes through `spawnLane` (`:7715`):
  - `#restart` (`restartLane` `:10676`)
  - `#new` (`newLaneSession`)
  - force-restart (spec 199, `:10641`)
  - remote reconnect (`:6640`)

  The session picker instead creates a *new* lane object (`:10304`). `spawnEpoch` is not a
  reliable "new session" marker: `restartLane` calls `spawnLane` without bumping it. A model
  switch keeps the session (`:9973`).
- **Compaction signal.** `usage_update { used, size }` is merged into `lane.usage` (`:8099`); OMP
  emits it (observed: `used 88004, size 1000000`). claude-agent-acp sends a `compaction_update`
  only when the client advertises `session.compaction` (`context-compaction.js:3`). Krypton does
  not advertise it, so the adapter reports compaction as a tool call instead. A sharp drop in
  `used` is the signal available across backends.
- **System-prompt channels were considered and ruled out as the primary fix:**
  - MCP `InitializeResult.instructions` is a MAY in the spec. Codex demotes it to tool-namespace
    metadata (openai/codex#29097). Claude Code truncates it to 2,048 chars and uses it mainly as a
    tool-search hint. Server instructions also cannot be refreshed mid-session when the roster or
    directive changes.
  - ACP `session/new` `_meta.systemPrompt` is honored by claude-agent-acp
    (`acp-agent.js:7189`: string replaces the prompt, `{append}` extends the preset). No other
    built-in backend is shown to read it.
  - Krypton sends neither today (`hook_server.rs:2415`, `acp.rs:2149`).
- **Tests.** `acp-harness-view.test.ts:3376-3391` pins packet wording by reading the source text
  (`source.toContain(...)`). It is a wording test and is deleted, not re-pinned.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code | Policy lives in the system prompt and CLAUDE.md, loaded once per session. MCP tools are deferred; only names and server instructions load upfront. `anthropic/alwaysLoad` in a tool's `_meta` forces a tool to load upfront. | Tool rules live in tool descriptions, not in user turns. |
| Codex | AGENTS.md is injected once into the initial context. MCP `instructions` become namespace descriptions. | Same once-per-session model. |
| Zed (ACP client) | Sends only user-attached context as per-prompt resource blocks; no injected policy (`crates/agent_servers`, no `systemPrompt` use). | Krypton is the outlier here. |

**Krypton delta:** this design matches the convention — policy is delivered once and tools carry
their own rules. Unlike the others, Krypton has no shared system-prompt channel across 13
backends, so "once" means once per *agent session*, tracked client-side, with a refresh when
compaction may have dropped the policy.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/lane-context.ts` (new) | Pure gate: `hashPolicy`, `planPolicyDelivery`, `isCompactionDrop`, `renderToolNameLine`, `renderToolIndex`, constants |
| `src/acp/acp-harness-view.ts` | `renderPromptMemoryPacket` / `insertTelegramProvenance` replaced by `renderTurnHeader`, `renderLanePolicy`, `renderRoleBlock`, `laneToolGates`; gate in `composeLeadingContext`; invalidation in `spawnLane`, the `usage` event, the agent-command `/compact` branch, and the `sendUserPrompt` catch |
| `src/acp/harness-ticket-controller.ts` | `insertTicketPin` removed; the policy renders `renderActiveTicketPin(ticketCtl.activeTicket)` at its head |
| `src/acp/harness-view-types.ts` | `HarnessLane.policyDelivery` field |
| `src/acp/harness-svg-fence.ts` | Shorter `SVG_FENCE_GUIDANCE` |
| `src-tauri/src/hook_server.rs` | `timeline_record` ack gains `conflict_check` (`TIMELINE_CONFLICT_CHECK`); `attention_flag` field descriptions carry the plain-language Thai guidance that lived only in the packet |
| `src/acp/lane-context.test.ts` (new) | Refresh boundary (turn 20 header-only, turn 21 policy), hash change, stale, compaction threshold, gate-driven tool advertising |
| `src/acp/acp-harness-view.test.ts` | Deleted two source-text tests the restructure broke (packet wording; spec 114 rev 9 `case 'usage'` regex window) |
| `docs/0002-functional-requirements.md`, `docs/0005-data-flow.md`, `docs/124-…`, `docs/130-…`, `docs/README.md` | Describe header + policy delivery |

## Design

### Data Structures

```ts
// harness-view-types.ts — on HarnessLane
policyDelivery: {
  hash: string;            // FNV-1a of the exact policy text sent
  turnsSince: number;      // sendUserPrompt turns since that send
  stale: boolean;          // set by compaction / prompt failure
} | null;                  // null = not sent to the current agent session; reset in spawnLane
```

### Packet content

**Turn header** (every `sendUserPrompt` turn):

1. `You are lane ${self}.`
2. The tool-name line. Each name follows the same gate as its index line in the policy. The whole
   line is omitted when harness memory is unavailable, because then no tools exist. It is 244
   chars with every gate on:

   ```
   Krypton tools (if not visible, search by exact name; rules are in each description): attention_flag, attention_resolve, mark_review_priority, artifact_new, timeline_record, timeline_merge, timeline_suggest, peer_send, peer_list, review_outcome.
   ```

3. The Telegram provenance lines, when `activeTelegramTurn` is set.

**Lane policy**, in order:

1. Roster line `Lanes: …` (only when `hasPeers`).
2. The existing peering paragraph (only when `hasPeers`).
3. The tool index below.
4. The ticket pin.
5. The role block or directive (from `composeLeadingContext`, unchanged text).

Tool index (gated lines keep their current gates):

```
Krypton tools — each tool's description is its full contract; read it before the first call.
- attention_flag: at the end of a turn where you hit a real fork — picked between viable approaches the user could decide differently on, guessed a consequential ambiguity in their intent, or did something costly or hard to undo — flag ONE decision, then keep working. Skip routine, reversible, machine-verifiable choices; never flag to cover yourself. attention_resolve if you settle it later.
- mark_review_priority: optional, at most once, at the end of a turn where you edited files.
- timeline_record / timeline_merge: ONLY when the current human message explicitly asks to record or merge timeline items — that request is the confirmation. Call timeline_list first.          [gate: local, non-pi]
- timeline_suggest: at most once per turn, only for an explicit durable decision, requirement, or outcome.   [gate: + automaticSuggestions]
- review_outcome: once, after synthesizing a #review round you convened.                                      [gate: hasPeers]
- artifact_new: ONLY when the user asks for a visual or interactive view.
- ```svg fenced blocks render inline: self-contained, root viewBox, colors via var(--fg|--muted|--border|--accent|--success|--warning|--error|--surface|--c1…--c6).
- ```visual fences render as HTML cards after f-hint (self-contained, no network/storage/forms/alerts; not ```html). Same theme vars as svg. Full pages use artifact_new.
Write these tools' free-text fields in natural Thai for a reader who does not read code; keep technical terms, IDs, paths, and quoted source verbatim.
```

The attention line keeps spec 134's positive-trigger-first wording.
Target: ≤ 1,700 chars for a solo lane with all gates on (was 7,397).

**Memory-unavailable branch.** It keeps its current text plus the SVG line and the spec 292 visual line, delivered as policy.

### Delivery gate (`buildPromptBlocks`)

```
policy = renderLanePolicy(lane); h = fnv1a(policy); d = lane.policyDelivery
send = !d || d.hash !== h || d.stale || d.turnsSince >= POLICY_REFRESH_TURNS - 1   // POLICY_REFRESH_TURNS = 20
leading = header + (send ? '\n' + policy : '')
lane.policyDelivery = send ? {hash: h, turnsSince: 0, stale: false} : {...d, turnsSince: d.turnsSince + 1}
```

`turnsSince` counts the header-only turns sent since the last policy send. The policy goes out on
turn 1, header-only on turns 2–20, and again on turn 21, so a refresh comes every 20 turns. The
delivery-gate unit test pins this boundary: turn 20 is header-only, turn 21 carries the policy.

The block shape is unchanged: one resource block when `supportsEmbeddedContext`, else one text
block. The directive still travels in the same leading block (spec 124 rule).

### Invalidation

| Trigger | Where | Effect |
|---|---|---|
| Any respawn (fresh, resume/load, force-restart, reconnect, `#new`, `#restart`) | `spawnLane` start sets `policyDelivery = null`; picker lanes start `null` | resend |
| Roster, directive, role, ticket, gate change | hash differs | resend |
| `usage_update.used` falls ≥ 40% below the previous value, and the previous value was ≥ 20,000 | `case 'usage'` (`:8099`) | `stale = true` |
| User sends agent slash `/compact` | `sendUserPrompt` agent-command branch | `stale = true` |
| `promptClient.prompt` rejects (provider error or transport) | `sendUserPrompt` catch | `policyDelivery = null` |
| 19 header-only turns since the last send | gate | resend on the next turn, i.e. every 20 turns (safety net for adapters with no `usage_update`) |

### Rust: `timeline_record` ack

Every successful ack carries `conflict_check`, whatever `new_topic` is. Today's packet rule calls
`timeline_conflict_checked` after *every* successful `timeline_record`, including a new topic with
nothing to compare. Without that call the event remains in its topic's
`timeline_conflict_list.unchecked.new_event_ids`.

```json
"conflict_check": "Compare this event ONLY against the other live events of its topic (timeline_list { topic_id }). Opposite decisions on the same subject with nothing newer settling them → timeline_conflict_record confirmed; if this event settles an open pair → resolved with it as resolution_event_id. Then call timeline_conflict_checked { topic_id, event_ids: [this event_id] } even when nothing conflicted. Events linked by supersedes are history, not conflicts. rationale in natural Thai."
```

Any direct-record rule that exists only in the packet today goes into the `timeline_record`
descriptor. One example is "report every returned event ID, topic ID, and path". The descriptor
stays under Claude Code's 2,048-char description cap.

### Data Flow

```
1. User submits → sendUserPrompt → buildPromptBlocks
2. Header always; policy only if gate says send
3. First turn of an agent session: header + policy (~1.7k chars)
4. Turns 2..20: header only (identity + tool-name line, ≤ 300 chars; plus Telegram lines if any)
5. Turn 21, or the turn after a usage_update drop / /compact / failure / hash change → policy resent
```

## Edge Cases

- **Prompt queued during a turn (spec 136).** The drain calls `sendUserPrompt`, and the gate
  applies the same way.
- **Steer (spec 278).** It still sends user blocks only. It does not count toward `turnsSince`.
- **Directive one-shot override.** The policy hash changes, so the policy is sent that turn and
  again on the next turn when the override clears.
- **Resume of a long session.** `spawnLane` resets delivery, so the policy is resent once. That
  copy is redundant but harmless.
- **Lane added or closed.** Every lane's hash changes, and each lane resends on its next turn.
- **`#polly` / `#debby` / `#salty` kickoff via `dispatchTurn`.** Unchanged. The role block
  arrives on the first `sendUserPrompt` turn, as today.
- **Adapter compacts silently with no `usage_update`.** The policy *rules* are missing for at
  most 19 turns. The tool *names* never go missing, because the header resends them every turn.
  The agent can still target `attention_flag` by exact name through capped tool search and read
  its contract from the tool description.

## Open Questions

None.

## Out of Scope

- MCP `initialize.instructions` and ACP `_meta.systemPrompt` channels. They are per-backend
  experiments, and possible follow-ups once this spec's per-turn baseline is measured.
- `anthropic/alwaysLoad` on `attention_flag` / `mark_review_priority`.
- Making the Thai output language configurable.
- Packet content for `dispatchTurn` / `enqueueSystemPrompt` paths.

## Verification

- Use the wire profiler (spec 288) on a solo lane. The turn-1 `session/prompt` lane-context should
  be ≤ 1,700 chars, turns 2–20 ≤ 300 chars and each naming `attention_flag`, and turn 21 should
  carry the full policy again.
- Exercise invalidation: `#new`, adding a lane, assigning a directive, and `/compact`. Each one
  should make the next turn carry the policy.
- Ask the agent to record one timeline event into an existing topic and one into a new topic.
  Both acks should include `conflict_check`, and the agent should call
  `timeline_conflict_checked` both times.
- Over a week, compare the `attention_flag` rate per turn against the pre-change baseline. This
  watches for the spec 134 regression.

Measured at implementation by driving `buildPromptBlocks` on a stubbed view for 22 turns (all
gates on). Solo lane:

- Turn 1: 1,591 chars, down from 7,397.
- Turns 2–20: 226 chars each.
- Turn 21: 1,591 again.

After adding a second lane, the next turn carried the 2,431-char policy (roster + peering), and the
turn after that sent only the 264-char header. The wire-profiler and live-agent checks above still
need a rebuilt app.

## Resources

- [MCP lifecycle — InitializeResult.instructions](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) — `instructions` is optional guidance clients MAY use.
- [openai/codex#29097](https://github.com/openai/codex/issues/29097) — Codex demotes server instructions to namespace metadata.
- [Codex MCP docs](https://developers.openai.com/codex/mcp.md) — documented `instructions` support.
- [Claude Code MCP docs — tool search](https://code.claude.com/docs/en/mcp) — deferred tools, 2,048-char instruction/description cap, `anthropic/alwaysLoad`.
- claude-agent-acp `dist/acp-agent.js:7185-7206`, `dist/context-compaction.js:3` (local npx cache) — `_meta.systemPrompt` handling; compaction presentation gate.
- Zed `crates/agent_servers` (local) — no system-prompt injection in its ACP client.
