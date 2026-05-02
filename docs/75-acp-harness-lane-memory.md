---
status: Draft
date: 2026-05-02
milestone: M8 — Polish
supersedes: docs/73-acp-harness-mcp-memory.md
---

# ACP Harness Lane-Owned Memory — Implementation Spec

## Problem

Spec 73 implements a shared multi-entry memory store: any MCP-enabled lane can
create, update, or delete any entry, identified by opaque ids (`M1`, `M2`, ...).
In practice this encourages append-style note-dropping and makes cross-agent
ownership ambiguous (Codex implementing "Claude-1's spec" has to grep
`createdBy`).

The user's mental model is simpler: **each lane owns one living memory
document; other lanes read it but cannot modify it.**

## Solution

Replace the multi-entry shared store with **one document per lane**. Owner
writes via `memory_set` (overwrite). Anyone reads via `memory_get` /
`memory_list`. Lane label is the identity. No ids, no search, no caps.

Breaking change to spec 73's tool surface. Memory is in-memory only, so
nothing on disk to migrate.

## Tool Surface

```jsonc
{
  "name": "memory_set",
  "description":
    "Overwrite your lane's single memory document. You have one document; \
this replaces its full contents (not append). Treat it as a living README \
other agents in this tab will read. Empty strings clear it.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "summary": { "type": "string", "maxLength": 300 },
      "detail":  { "type": "string", "maxLength": 8000 }
    },
    "required": ["summary", "detail"]
  }
}

{
  "name": "memory_get",
  "description":
    "Read any lane's full memory document by lane label. Returns null if \
that lane has no memory. You can read any lane but only write your own.",
  "inputSchema": {
    "type": "object",
    "properties": { "lane": { "type": "string" } },
    "required": ["lane"]
  }
}

{
  "name": "memory_list",
  "description":
    "List all lanes in this tab and their memory summaries. Use this to \
discover what other agents are doing.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

Removed from spec 73: `memory_create`, `memory_update`, `memory_delete`,
`memory_search`, `memory_get` (by id). Empty `summary` AND empty `detail`
clears the lane's memory. Mixed empty/non-empty is rejected.

## Prompt Injection (per MCP-enabled turn)

```
You are lane <self>. Lanes: <comma-separated lane labels>.
Your memory: <summary or "empty">.
```

That is the entire injection. No other-lane summaries, no tool reminders —
the agent calls `memory_list` if curious.

## Data Structures

```rust
struct LaneMemory {
    summary: String,    // ≤300 chars
    detail: String,     // ≤8000 chars
    updated_at: u64,
}

struct HarnessMemoryStore {
    harness_id: String,
    project_dir: Option<String>,
    lanes: HashMap<String, LaneMemory>,  // key = lane label
}
```

Lane has no entry until first `memory_set`. `memory_set("", "")` removes the
entry entirely.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Replace store, tool descriptors, handlers; ownership check on `memory_set` (lane label from URL); list/get over `lanes` map. |
| `src-tauri/src/commands.rs` | `list_harness_memory` returns `Vec<{ lane, summary, detail, updatedAt }>`. |
| `src/acp/types.ts` | Replace `HarnessMemoryEntry` shape (`lane` instead of `id`). |
| `src/acp/acp-harness-view.ts` | Minimal prompt injection above; observer board grouped by lane with lane accent. |
| `src/styles/acp-harness.css` | Per-lane row styling. |
| `docs/73-acp-harness-mcp-memory.md` | Add `superseded_by: docs/75-acp-harness-lane-memory.md`. |
| `docs/05-data-flow.md` | Update memory-flow steps. |
| `docs/PROGRESS.md` | Tick the milestone entry. |

No new Tauri commands. No ACP-layer changes. No persistence.

## Edge Cases

- **Lane removed from harness:** drop its entry.
- **Lane never set memory:** `memory_get(lane)` returns `{ entry: null }`.
- **Adapter does not support MCP descriptor:** lane runs without memory tools (unchanged).
- **Oversized field:** reject with `summary_too_long` / `detail_too_long`.
- **Mixed empty/non-empty in `memory_set`:** reject with `mixed_empty`.
- **Concurrent `memory_set` from same lane:** last writer wins (`Mutex` serializes).

## Out of Scope

- Persistent / cross-tab / project-global memory.
- Audit log, undo, restore, human editing.
- Full-text search.
- Per-lane caps (one document, bounded by `detail` max).
- `memory_get_self` / `memory_list_lanes` — both redundant given prompt
  injection and the 3-tool surface above.

## Open Questions

None. Awaiting approval.

## Resources

- `docs/73-acp-harness-mcp-memory.md` — prior design (to mark superseded).
- `src-tauri/src/hook_server.rs:559-672` — current memory implementation.
- `src/acp/acp-harness-view.ts:577-610` — current prompt injection.
