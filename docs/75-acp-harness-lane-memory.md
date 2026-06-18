---
status: Implemented
date: 2026-05-02
milestone: M8 — Polish
supersedes: docs/73-acp-harness-mcp-memory.md
extended_by: docs/76-acp-harness-memory-persistence.md
---

# ACP Harness Lane-Owned Memory — Implementation Spec

> Scope refined by [docs/165-memory-handoff-only.md](165-memory-handoff-only.md): memory is the backing store for `#handoff` / `#resume` only — not an ambient shared scratchpad. The per-turn packet no longer advertises it; cross-lane *read* is retained.

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
other agents in this tab will read. 'summary' is a SHORT one-line headline; \
put all real content in 'detail'. Empty strings clear it.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "summary": {
        "type": "string",
        "description": "One short headline only (a single sentence). Do NOT \
put the body here — anything past ~300 characters is clipped to a headline \
(never rejected). Use 'detail' for everything substantial."
      },
      "detail": {
        "type": "string",
        "maxLength": 8000,
        "description": "The full memory body. This is the long field — put \
all substantive content here."
      }
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
    summary: String,    // clipped to ≤300 chars (headline)
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
| `src-tauri/src/hook_server.rs` | Replace store, tool descriptors, handlers; ownership check on `memory_set` (lane label from URL); list/get over `lanes` map. **Added debounced atomic persistence to disk.** |
| `src-tauri/src/commands.rs` | `list_harness_memory` returns `Vec<{ lane, summary, detail, updatedAt }>`. **Added `create_harness_memory(project_dir)` and `clear_harness_memory_lane`.** |
| `src/acp/types.ts` | Replace `HarnessMemoryEntry` shape (`lane` instead of `id`). |
| `src/acp/acp-harness-view.ts` | Minimal prompt injection above; observer board grouped by lane with lane accent. **Passes `projectDir` for persistence.** |
| `src/styles/acp-harness.css` | Per-lane row styling. |
| `docs/73-acp-harness-mcp-memory.md` | Add `superseded_by: docs/75-acp-harness-lane-memory.md`. |
| `docs/05-data-flow.md` | Update memory-flow steps. |
| `docs/PROGRESS.md` | Tick the milestone entry. |

## Persistence

Lane memory is persisted to disk per project directory. See `docs/76-acp-harness-memory-persistence.md` for details.

## Edge Cases

- **Lane removed from harness:** drop its entry.
- **Lane never set memory:** `memory_get(lane)` returns `{ entry: null }`.
- **Adapter does not support MCP descriptor:** lane runs without memory tools (unchanged).
- **Oversized `summary`:** clip, don't reject. `summary` is only the scannable headline shown by `memory_list`, and the body always lives in `detail`, so an over-long `summary` is harmless — `memory_set` truncates it server-side to `MEMORY_SUMMARY_MAX` code points and appends an ellipsis (`clamp_headline`), then stores it. This replaced the earlier *instructive rejection* (`summary is 412 chars but must be ≤300: …`): the model attends to the natural-language field description far more than to JSON-Schema `maxLength` and **cannot reliably count characters itself** (Thai is worse, since the limit counts Unicode code points via `chars().count()`), so the rejection produced retry loops — the model shaving the headline down across several failed turns — instead of compliance. The qualitative nudge ("one short headline") stays in the description; the cap is now enforced by truncation, not a wall. The `summary` `maxLength` was dropped from the input schema so no MCP client hard-rejects before the server can clip.
- **Oversized `detail`:** reject with `detail exceeds 8000 characters`. Unlike `summary`, `detail` carries real content, so silently truncating it would lose substance — an over-cap body is a genuine mistake worth surfacing.
- **Mixed empty/non-empty in `memory_set`:** reject with `mixed_empty`.
- **Concurrent `memory_set` from same lane:** last writer wins (`Mutex` serializes).

## Out of Scope

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
