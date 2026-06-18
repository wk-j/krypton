# ACP Harness On-Demand Memory — Implementation Spec

> Status: Implemented
> Date: 2026-05-08
> Milestone: M-ACP — Harness
> Scope refined by [docs/165-memory-handoff-only.md](165-memory-handoff-only.md): the on-demand stub no longer advertises memory at all — memory is scoped to the `#handoff` / `#resume` handoff store. The peering stub is unaffected.

## Problem

The ACP harness currently injects a full memory snapshot ("memory packet") as a leading content block on **every** `session/prompt`. The packet contains every lane's `summary` + `detail` and is rebuilt fresh per turn. This costs ~900–1,100 input tokens per turn at current memory size and grows unbounded as lanes write more `detail`. It also makes Codex display every session with the same title (`krypton://acp-harness/memory.md`) in `session/list`, because Codex uses the first resource block's URI as the session title.

## Solution

Stop injecting the memory body. Replace the packet with a **short identity stub** (~30–50 tokens) that tells the lane (a) which lane it is, (b) what other lanes exist, and (c) that memory is available via the `krypton-harness-memory` MCP server tools. The agent decides when to read (`memory_list`, `memory_get`) and write (`memory_set`). Pi lanes have no MCP host — they receive the stub for identity but cannot use memory tools, which is acceptable per user direction.

## Research

- `renderPromptMemoryPacket()` (`src/acp/acp-harness-view.ts:1094-1119`) builds the full markdown packet from `this.memoryEntries` every call.
- `buildPromptBlocks()` (`src/acp/acp-harness-view.ts:1063-1092`) prepends the packet either as a `resource` block (when `lane.supportsEmbeddedContext`) or as a leading `text` block. Both paths are currently triggered for every prompt.
- `lane.supportsEmbeddedContext` is set from `agent_capabilities.promptCapabilities.embeddedContext` in `configureLaneFromInfo()` (`src/acp/acp-harness-view.ts:909`). Claude-acp and Codex advertise it; Pi does not (`docs/84-acp-pi-lane.md:49`).
- The MCP server `krypton-harness-memory` is implemented in `src-tauri/src/hook_server.rs:177-814`. It exposes three tools: `memory_set` (writes only the caller's lane, identified by URL path), `memory_get(lane)`, and `memory_list()` (lists only the lanes that have a saved document, not the full roster). Server URL is per-lane: `/mcp/harness/{harness_id}/lane/{lane_label}`.
- The MCP server does **not** expose lane identity. The agent has no `whoami` tool and cannot read the URL it was wired with. Identity is conveyed only through the prompt packet today. Therefore the stub must keep the identity line.
- `mcpServersForLane()` (`src/acp/acp-harness-view.ts` ~1300) only attaches the memory server to `claude` and `pi-acp` lanes for native adapters; codex and opencode get it via the `.mcp.json` bridge. Pi lanes receive an empty MCP array (`docs/77` / Pi-lane comment) so memory tools are unreachable to Pi regardless.
- Spec 72 (`docs/72-acp-harness-view.md:25-29, 197-216`) is the authoritative spec for memory packet behavior and must be amended.
- Codex side-effect: stripping the resource block makes Codex's `session/list` use the first user-text block as the title instead of the memory URI — a UX win for Spec 97's session picker.

**Alternatives considered:**
- *Add an MCP `memory_whoami` tool and strip the stub entirely.* Rejected — adds round-trips, agent may never call it, and we lose the cheap "memory exists" hint that nudges the LLM to use it.
- *Cap packet detail size.* Rejected — still pays the cost every turn and doesn't fix the Codex title issue.
- *Send diff-only updates.* Rejected — requires per-lane version tracking and per-agent state machines; Spec 72 explicitly avoided this complexity.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code | Project memory (`CLAUDE.md`) is loaded once per session as a system message; auto-memory uses `MEMORY.md` as an index plus per-topic files read on demand. | Hybrid: identity/scope is pushed; body is pulled by name as needed. |
| Cursor / Zed | `.cursorrules` / project rules pushed on every prompt; user memory is opt-in tool. | Push for stable context, pull for mutable state. |
| MCP spec | Resources are pulled by `resources/list` + `resources/read` from the agent. Servers may declare `instructions` at `initialize` to nudge usage. | Confirms pull model is the protocol's intended pattern for mutable data. |

**Krypton delta** — Match the pull-on-demand convention for mutable inter-lane memory. Diverge from a pure pull model by retaining a tiny push-side identity stub (which lane the agent is, what other lanes exist) because MCP cannot answer those questions today.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Replace `renderPromptMemoryPacket()` body with a short identity stub. `buildPromptBlocks()` keeps the embedded-resource vs text-block split, but the resource URI changes to `krypton://acp-harness/lane-context.md` so it no longer collides with the literal memory file in Codex's session list. |
| `docs/72-acp-harness-view.md` | Amend the "Prompt Memory Packet" section to describe the stub-only model and reference this spec. |
| `docs/69-acp-agent-support.md` | Update the memory packet line if it mentions full-snapshot injection. |
| `docs/05-data-flow.md` | Update the prompt-flow description to note that memory body is pulled via MCP, not pushed. |
| `docs/PROGRESS.md` | Add Spec 98 entry. |

No Rust changes. No new MCP tools. No new Tauri commands.

## Design

### New stub format

`renderPromptMemoryPacket()` returns:

```
You are lane <self>. Lanes: <comma-separated roster>.
Shared memory is available through the krypton-harness-memory MCP server: use memory_list to see which lanes have entries, memory_get { lane } to read another lane, and memory_set { summary, detail } to update your own. Memory writes from your lane go to "<self>" automatically; you cannot write to other lanes.
```

When `roster.length === 1`, drop the second sentence's reference to "other lanes" and keep only `memory_set` + `memory_get` guidance (the lane has no peers to coordinate with yet, but we keep the hook so it knows memory exists).

Estimated size: ~60–90 tokens. Independent of memory body size.

### Resource block URI

Change the URI passed to `buildPromptBlocks()` from `krypton://acp-harness/memory.md` to `krypton://acp-harness/lane-context.md`. Reason: Codex uses the first resource URI as `session/list` title (Spec 97 picker). The new URI is descriptive and avoids implying the resource contains the memory body.

### Agent behavior expectations

- **Claude-acp / Codex / OpenCode:** receive stub + memory MCP server. Agent decides when to call `memory_list` / `memory_get` based on user task. `memory_set` is called when the lane wants to record state for peers.
- **Pi:** receives stub as a text block (no `embeddedContext` capability). MCP unreachable. Pi lanes simply do not coordinate via memory — acceptable per user direction.

### Out-of-band memory updates

Removing automatic body injection means an agent that hasn't called `memory_get` cannot see updates from peers within the current turn. This is an intentional trade — agents that need fresh peer state must call `memory_get` themselves. The stub instructs them to do so.

## Edge Cases

- **Lane added/removed mid-session:** the roster line in the stub is recomputed every prompt, so new/removed peers are visible to the agent on its next turn (already today's behavior).
- **Empty memory across all lanes:** stub is unchanged. Agent calling `memory_list` gets `{entries: []}`.
- **Lane with `roster.length === 1`:** stub omits peer-related guidance. Agent still has `memory_set` to persist state across its own turns.
- **Pi lane:** stub is delivered as a text block. The mention of MCP tools is informational; Pi will not call them. No error path needed.
- **Codex `session/list` title:** new sessions will use the first user-text block as title. Existing Codex sessions (created before this change) will keep the old `krypton://acp-harness/memory.md` title — acceptable, no migration.
- **Codex resume / load:** resumed sessions still get the new stub on their next prompt. Replayed history retains the old packet — no action needed.
- **Agent that ignores the hint and never calls `memory_get`:** agent operates without peer context, same as if memory were empty. Acceptable failure mode (the user's stated tolerance: "if agent does not support MCP just ignore it").

## Open Questions

None.

## Out of Scope

- Adding an MCP `memory_whoami` tool.
- Per-turn diffing of memory state.
- Caps on `detail` size (still 8000 chars enforced server-side; unchanged).
- MCP `resources/subscribe` notifications for memory changes.
- Pi memory support (Pi has no MCP host; out of scope until that changes).
- Migrating existing Codex session titles.
- Changing `memory_set` / `memory_get` / `memory_list` tool descriptions (existing descriptions already explain usage).

## Resources

- [MCP Specification — Resources](https://modelcontextprotocol.io/specification/2024-11-05/server/resources/) — confirms pull-by-URI model and `resources/list` + `resources/read` as the canonical access pattern.
- [MCP Specification — Server Initialization](https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle/) — `instructions` field at handshake (not used by current `hook_server.rs`; noted but not changed in this spec).
- `docs/72-acp-harness-view.md` — current memory packet spec being superseded.
- `docs/97-acp-harness-session-resume.md` — Codex session-list UX impact.
- `src-tauri/src/hook_server.rs:177-814` — krypton-harness-memory MCP server implementation.
