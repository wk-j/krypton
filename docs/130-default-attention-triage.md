# Default Attention Triage — Implementation Spec

> Status: Implemented
> Date: 2026-05-30
> Milestone: M8 — Polish
> Extends: `docs/128-attention-triage.md` (spec 128), `docs/129-directive-triage-grant.md` (spec 129)

## Problem

`attention_flag` is currently hard to test and easy to miss in real use because a lane must be triage-equipped before the ACP client's first `tools/list`. Even with directive grants, already-running lanes or lanes spawned without a grant may never see the tool. The desired behavior is simpler: every lane that receives the `krypton-harness-memory` MCP server should see `attention_flag` / `attention_resolve` by default, with no directive or manual equip step.

## Solution

Make attention triage **default-on for all harness-memory-capable lanes**. The hook server will always advertise the attention tools from `tools/list` and always allow their call-time dispatch for lane-scoped harness memory connections. The frontend will mark every lane as triage-equipped before spawning or resuming so silent-turn audit counters remain accurate and the lane UI still shows that flagging is available.

This deliberately changes the trust model from "per-lane opt-in" to "ambient harness capability." The existing anti-flood guard remains the tool description plus validation: flags must carry `traded_off`, `uncertainty`, and a reversibility value, and they are non-blocking queue items, not approvals.

## Research

- `docs/128-attention-triage.md` defines the current per-lane opt-in model and notes the `tools/list` cache caveat.
- `docs/129-directive-triage-grant.md` works around that caveat with a spawn-time directive grant, but explicitly does not solve mid-session advertisement refresh.
- Before this spec, `src-tauri/src/hook_server.rs` computed `include_triage` per lane during `tools/list` and appended attention descriptors only when `is_lane_triage_equipped()` was true. It also rejected `attention_flag` / `attention_resolve` at call time for non-equipped lanes.
- `src/acp/acp-harness-view.ts` stores `triageEquipped` on each `HarnessLane`, records silent turns only when that flag is true, and mirrors equip state to Rust before directive-spawned lanes start.
- Some backends do not receive harness memory at all, notably Pi. Default-on cannot give those lanes attention tools because there is no MCP host to inject into.
- External research is not needed: this is an internal policy change to an existing Krypton-only MCP server, not a new protocol or UI pattern.

## Prior Art

| App / Tool | Implementation | Notes |
|------------|----------------|-------|
| Krypton spec 128 | Per-lane manual equip gates `attention_flag` | Safer by default, but poor ergonomics with one-shot `tools/list` clients. |
| Krypton spec 129 | Directive `triage_equipped = true` grants tools before spawn | Fixes role-based lanes, but still requires setup and does not affect already-running clients. |
| GitHub review queues | Any PR can request review; queue management is policy/social rather than hidden capability | Closest analogue for "the queue is always available; quality is governed by norms." |

**Krypton delta** — This keeps Krypton's non-blocking demand queue, ranked review cards, and static footer gauge, but removes the capability gate. The UI becomes easier to test and explain: if a lane has harness memory MCP, it can flag judgement items.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Always include `attention_flag` / `attention_resolve` in `bus_tool_descriptors`; remove the non-equipped call-time rejection for these two tools, or make it permanently true for harness lanes. Keep descriptor validation and round-trip behavior unchanged. |
| `src/acp/acp-harness-view.ts` | Default every new/resumed/restarted harness lane to `triageEquipped = true`; seed `AttentionTriageStore.equip(lane.id)` before the lane can finish a turn; stop requiring directive/manual equip as the source of availability. Name `attention_flag` / `attention_resolve` in the lane-context packet (`renderPromptMemoryPacket`) so capped tool-discovery clients can target them directly — see **Discoverability**. |
| `src/acp/types.ts` | If needed, adjust comments around `triageEquipped` from "opt-in gate" to "attention-audit participation / UI state." No payload shape changes. |
| `src-tauri/src/acp_harness_config.rs`, `src/config.ts` | Keep `triage_equipped` for compatibility, but document it as deprecated/no-op or legacy display metadata. Do not remove the field in this change. |
| `docs/128-attention-triage.md`, `docs/129-directive-triage-grant.md`, `docs/adr/0001-attention-triage-self-reported-router.md` | Update the trust model from per-lane opt-in to default-on; mark directive grants/manual equip as superseded. |
| `docs/04-architecture.md`, `docs/06-configuration.md`, `docs/PROGRESS.md` | Update architecture/config/progress text so docs no longer claim attention tools require manual or directive equip. |
| tests | Add or update tests for default descriptor advertisement, call-time acceptance, and lane default audit state. |

## Design

### Tool Advertisement

`tools/list` for the lane-scoped harness memory MCP endpoint should always include the attention descriptors:

```rust
Ok(json!({ "tools": bus_tool_descriptors() }))
```

`bus_tool_descriptors()` no longer needs an `include_triage` parameter. `attention_tool_descriptors()` remains unchanged, including its strong "never flag proactively" description and required fields.

### Discoverability

Advertising the tools from `tools/list` is necessary but not sufficient: some ACP backends expose harness MCP tools to the model through a capped, ranked tool-discovery step (e.g. a `tool_search` with a small `limit`). When the harness-memory server advertises more tools than that cap, ranking can surface `attention_resolve` while dropping `attention_flag`, leaving a default-on tool effectively invisible. Krypton cannot raise the consumer's discovery cap, so `renderPromptMemoryPacket()` in `acp-harness-view.ts` names `attention_flag` / `attention_resolve` explicitly in the lane-context packet. Naming them lets the model target them directly (e.g. a `select:attention_flag` discovery) instead of depending on search ranking. The packet line repeats the anti-flood guard so naming the tool does not encourage over-flagging.

### Call-Time Authorization

The harness memory endpoint is already lane-scoped by URL (`/mcp/harness/:harness_id/lane/:lane_label`) and the tool handlers receive both identifiers. The call-time rejection based only on `triage_equipped` should be removed for `attention_flag` and `attention_resolve`.

Validation remains:

- unknown tool names still fail
- malformed `attention_flag` payloads still fail
- blank `uncertainty` / empty `traded_off` still fail
- frontend `mergeAttentionFlag()` still rejects if it cannot map the lane or insert the item

### Lane State

`HarnessLane.triageEquipped` remains for audit and UI continuity, but becomes default true for lanes that can receive harness memory MCP. The creation/spawn path should centralize this so plain add, directive add, restart, new session, resume, and load behave the same.

Recommended shape:

```ts
private enableDefaultAttentionTriage(lane: HarnessLane): void {
  lane.triageEquipped = true;
  lane.triageOverride = null;
  this.triageStore.equip(lane.id);
}
```

Call it before `spawnLane(lane)` / before `setMcpServers()` in resume/load paths. For lanes without harness memory MCP, the flag may still be true for local audit display, but no tool can appear because no MCP server is injected.

### Manual Toggle And Directive Field

The manual triage toggle is removed from the active UI:

- `Cmd+P → '` is removed from the harness leader-key surface.
- The runtime manual override path is not used for default attention tool availability.
- `[[directives]].triage_equipped` stays accepted for backward compatibility, but it no longer controls tool visibility.
- Existing directive-picker / rail badges for `triage_equipped` stay visible as
  legacy metadata so older directive files remain legible. The docs must clarify
  that the badge no longer means the directive is required to expose
  `attention_flag`; every harness-memory-capable lane gets the tool by default.

Implementation keeps the directive field/badges for compatibility, but removes the manual leader-key toggle so users do not treat equip as required configuration.

## Data Flow

```
1. User spawns, resumes, loads, or restarts an ACP harness lane.
2. AcpHarnessView defaults the lane to triageEquipped=true and seeds AttentionTriageStore stats.
3. The lane receives the normal harness-memory MCP server.
4. The backend client calls tools/list.
5. hook_server returns memory, peer, review, directive, and attention tools for that lane.
6. If the lane calls attention_flag, hook_server validates payload and emits acp-attention-flag.
7. AcpHarnessView inserts the JudgementItem; the footer gauge updates through the existing system:attention path.
```

## Edge Cases

- **Pi or any backend without an MCP host** → no attention tool appears because no harness memory MCP server is injected. This spec does not add an MCP host to those backends.
- **Existing running lane whose client cached tools before this code change** → still needs respawn/restart to refresh its client-side tool list.
- **Over-flagging** → accepted risk increases. Mitigation remains the tool description, mandatory fields, queue visibility, and human review; no deterministic throttling is added.
- **Existing directives with `triage_equipped = true`** → remain valid TOML and visible if current UI renders the badge, but no longer grant unique capability.
- **Manual unequip** → removed from the user-facing leader-key surface. Any leftover helper code is legacy/internal and must not be documented as a security boundary.

## Open Questions

None.

## Out of Scope

- Adding harness memory MCP support to Pi or any backend that lacks an MCP host.
- Adding MCP `tools/list_changed` live refresh.
- Adding a throttle, quota, or independent observer for attention flags.
- Removing `triage_equipped` from persisted config; that would be a migration and is unnecessary for this policy flip.

## Resources

- `docs/128-attention-triage.md` — current attention triage feature and MCP tool semantics.
- `docs/129-directive-triage-grant.md` — current spawn-time grant workaround and `tools/list` cache caveat.
- `docs/adr/0001-attention-triage-self-reported-router.md` — trust-model rationale that this spec intentionally revises.
- `src-tauri/src/hook_server.rs` — previous `tools/list` filter/call-time gate and the implemented default-on descriptor path.
- `src/acp/acp-harness-view.ts` — lane lifecycle, triage store integration, and spawn/resume paths.
