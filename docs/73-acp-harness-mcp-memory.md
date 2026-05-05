# ACP Harness MCP Memory — Implementation Spec

> Status: Superseded by [docs/75-acp-harness-lane-memory.md](75-acp-harness-lane-memory.md)
> Related: [docs/83-acp-shared-mcp-config.md](83-acp-shared-mcp-config.md) — shared `.mcp.json` bridge for non-Claude lanes (memory server is appended after the bridged list).
> Date: 2026-05-02
> Milestone: M8 — Polish

## Problem

The current ACP harness memory is indirect: Krypton infers memory from tool observations and optional `MEMORY:` footer text. The desired model is simpler and more explicit: ACP agents manage shared harness memory themselves through tools, while the human only observes the current memory board.

## Solution

Expose a Krypton-owned memory tool server to ACP lanes through `session/new.mcpServers`, reusing Krypton's existing localhost hook HTTP server instead of spawning a separate MCP process. Memory is tab-local, stored in the running Krypton instance under a `harnessId`, and mutated only through MCP-style memory tools. The human UI shows active memory summaries and expandable details, but does not approve, edit, restore, or audit memory changes. If an ACP adapter asks for permission before calling the built-in memory MCP tools, the harness auto-allows `memory_set`, `memory_get`, and `memory_list` by default and records the auto-allow in the lane transcript.

## Research

- ACP `session/new` already accepts `mcpServers`; Krypton currently sends `mcpServers: []` from `src-tauri/src/acp.rs`.
- Krypton already has a localhost Axum hook server in `src-tauri/src/hook_server.rs`, bound to `127.0.0.1` with a configurable/auto port. It currently serves Claude hook `POST /hook` and can be extended with memory routes.
- MCP tools are model-controlled; this design intentionally allows autonomous memory mutation because the tool surface is memory-only and tab-local.
- ACP adapter support for MCP transports varies. This v1 uses HTTP on the existing hook server only. If an adapter cannot use that MCP server descriptor, that lane has no memory features.
- The existing frontend memory module stores a flat entry list. The new design moves ownership to the backend hook server so all MCP-enabled lanes share one board.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Zed external agents | Forwards configured MCP context servers to ACP agents where supported. | Confirms ACP + MCP forwarding is the right layer, but support varies by agent. |
| Claude Desktop / Claude Code | MCP tools are exposed as model-callable tools. | Confirms memory should be explicit tools, not parsed assistant text. |
| Cursor / VS Code MCP integrations | User-configured MCP servers expose agent tools. | Similar tool model, though not harness-tab-scoped. |
| Current Krypton harness | Tab-local memory board injected into prompts. | Good UI basis, but creation is heuristic. |

**Krypton delta** — Krypton keeps memory local to one ACP harness tab. Agents own memory lifecycle. Humans observe current state only. No persistent global/project memory, no approval prompts, no audit/undo, and no fallback extraction.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Add lane-scoped HTTP MCP/memory endpoint and tab-local store keyed by `harnessId`. |
| `src-tauri/src/acp.rs` | Include memory MCP server descriptor in `session/new` for MCP-enabled harness lanes. |
| `src-tauri/src/commands.rs` | Add commands to create/dispose harness memory and read current board for UI. |
| `src-tauri/src/lib.rs` | Register new commands/state if needed. |
| `src/acp/client.ts` | Allow ACP spawn/initialize path to carry MCP server descriptor. |
| `src/acp/types.ts` | Add memory entry and MCP server descriptor types. |
| `src/acp/acp-harness-memory.ts` | Existing helper remains for non-memory utilities; heuristic extraction is no longer used by the harness memory flow. |
| `src/acp/acp-harness-view.ts` | Create `harnessId`, pass endpoint to lanes, inject latest summaries, render observer memory board. |
| `src/styles/acp-harness.css` | Style current memory board and expandable detail rows. |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/72-acp-harness-view.md`, `docs/PROGRESS.md` | Update after implementation. |

## Design

### Data Structures

```ts
interface HarnessMemoryEntry {
  id: string;          // M1, M2, ...
  summary: string;     // max 300 chars, injected by default
  detail: string;      // max 8000 chars, returned by memory_get
  createdBy: string;   // lane label, e.g. Codex-1
  updatedBy: string;   // lane label
  createdAt: number;
  updatedAt: number;
}

interface HarnessMemoryStore {
  harnessId: string;
  projectDir: string | null;
  nextSeq: number;
  entries: HarnessMemoryEntry[];
}

interface AcpMcpServerDescriptor {
  name: string;
  url: string; // http://127.0.0.1:<port>/mcp/harness/:harnessId/lane/:laneLabel
}
```

Memory limits:

- Active entries cap: 100.
- On `memory_create` at cap: auto-evict oldest by `updatedAt`.
- Duplicate handling: reject exact duplicate active `summary` after whitespace normalization.
- No audit log. Evicted/deleted memory is gone.

### Tools

```ts
memory_create({ summary: string, detail: string })
memory_update({ id: string, summary?: string, detail?: string })
memory_delete({ id: string })
memory_search({ query: string, limit?: number })
memory_get({ id: string })
```

Tool behavior:

- `summary` max 300 chars.
- `detail` max 8000 chars.
- `memory_search.query` is required.
- `memory_search.limit` defaults to 10 and caps at 20.
- Search covers both `summary` and `detail`, ranks summary matches above detail matches, and returns summaries only.
- `memory_get` returns full detail.
- Any MCP-enabled lane can update/delete any memory.

Tool guidance:

- Store memory only when future agents would lose important context if the turn ended now.
- `memory_create` is for information future agents need and cannot reliably recover from the repo, git history, or current user prompt.
- Good cases: user-approved decisions, draft specs/plans not yet in docs, exact partial-work status, root-cause analysis, repro steps, non-obvious gotchas, or links between conversation decisions and repo files.
- Do not create memory for normal chat summaries, generic progress updates, information already present in docs/code, private scratch notes, or facts that can be cheaply rediscovered.
- `memory_update` is for materially changed decisions/status or old handoffs that would mislead future agents. Prefer updating a relevant entry over creating duplicates.

### API / Commands

New Tauri commands:

```ts
create_harness_memory(): Promise<{ harnessId: string; hookPort: number }>;
list_harness_memory(harnessId: string): Promise<HarnessMemoryEntry[]>;
dispose_harness_memory(harnessId: string): Promise<void>;
```

ACP session setup:

```ts
AcpClient.spawn(
  backendId: string,
  cwd: string | null,
  mcpServers?: AcpMcpServerDescriptor[],
): Promise<AcpClient>;
```

Each lane gets a lane-scoped endpoint:

```text
http://127.0.0.1:<hookPort>/mcp/harness/<harnessId>/lane/<laneLabel>
```

No token/auth in v1. The server remains bound to `127.0.0.1`.

### Data Flow

```
1. User opens ACP Harness.
2. AcpHarnessView calls create_harness_memory(projectDir).
3. Rust creates a tab-local memory store and returns harnessId + hookPort.
4. Each lane gets an MCP server descriptor pointing at /mcp/harness/<harnessId>/lane/<laneLabel>.
5. During session/new, acp.rs includes that descriptor in mcpServers.
6. If the ACP adapter supports this HTTP MCP descriptor, the model sees memory tools.
7. Agent calls memory_create/update/delete/search/get.
8. hook_server.rs validates limits, mutates the shared store, and returns tool results.
9. AcpHarnessView reads current memory with list_harness_memory and renders the observer board.
10. Prompt construction injects latest 10 active summaries only for MCP-enabled lanes.
11. Closing the harness disposes ACP clients and calls dispose_harness_memory; memory is dropped.
```

### Prompt Guidance

Every MCP-enabled lane receives short guidance with the prompt:

```text
Use Krypton memory tools when useful:
- create memory only when future agents would lose important context without it
- update memory when recorded decisions/status materially change
- search/get memory before relying on uncertain prior work
Keep summaries short; put full context in detail.
```

Latest 10 active summaries by `updatedAt` are injected automatically. Details are never auto-injected; agents call `memory_get`.

### UI Changes

- Memory drawer shows active memory only.
- Rows show `id`, `summary`, `updatedBy`, and `updatedAt`.
- Rows can expand to show `detail`.
- Human can read only. No create/update/delete/restore.
- Existing `#mem` commands are removed/disabled in MCP memory mode.
- No audit view.

### Configuration

No new config in v1. MCP memory is the harness default once implemented.

## Edge Cases

- **Adapter does not support the HTTP MCP descriptor:** lane runs normally with memory off. It does not receive latest summary injection.
- **Memory cap reached:** create succeeds after auto-evicting oldest active entry by `updatedAt`.
- **Duplicate summary:** create fails with `duplicate_summary`.
- **Oversized entry:** create/update fails with `summary_too_long` or `detail_too_long`.
- **Deleted memory:** hard-deleted and unavailable immediately.
- **Search empty query:** rejected.
- **Harness closes while tool call is in flight:** memory endpoint returns missing harness/store error.

## Open Questions

None. The simple v1 intentionally accepts no auth, no audit, no fallback extraction, and no non-MCP lane memory. **Persistence is implemented per project directory.**

## Out of Scope

- Stdio MCP shim or separate sidecar MCP process.
- Audit log, restore, undo, or human editing.
- Footer memory extraction.
- Tool-observation memory extraction.
- Token/auth for localhost endpoint.
- Exposing filesystem, shell, git, browser, or Krypton UI-control tools through MCP.
- Supporting adapters that cannot consume the HTTP MCP descriptor.

## Resources

- [ACP Session Setup](https://agentclientprotocol.com/protocol/session-setup) — `session/new` supports `mcpServers`.
- [ACP Schema](https://agentclientprotocol.com/protocol/schema) — `NewSessionRequest.mcpServers` shape.
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — tool discovery and call semantics.
- [MCP Schema Reference](https://modelcontextprotocol.io/specification/2025-06-18/schema) — tools capability and list-changed notifications.
- [Zed External Agents](https://zed.dev/docs/ai/external-agents) — ACP external-agent/MCP support varies by adapter.
- [Zed MCP docs](https://zed.dev/docs/ai/mcp) — prior art for MCP server configuration and tool handling.
