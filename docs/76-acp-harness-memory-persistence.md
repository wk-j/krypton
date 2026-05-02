---
status: Implemented
date: 2026-05-02
milestone: M8 — Polish
extends: docs/75-acp-harness-lane-memory.md
---

# ACP Harness Memory Persistence — Implementation Spec

## Problem

Lane memory (spec 75) is in-memory only. Closing Krypton or disposing the
harness loses every lane's living document — defeating the "living README"
framing the moment the user restarts the app. Cross-session continuity is the
whole point of a memory: agents should pick up where the team left off.

## Solution

Save each harness's per-lane documents to a JSON file keyed by **project
directory**. Restore on harness creation if a file exists. Debounced atomic
write on every `memory_set` (or clear). One file per project dir; latest writer
wins if two harnesses run for the same project.

Project dir is the natural scope — a harness in `~/Source/foo` is a different
team from one in `~/Source/bar`, but reopening the same workspace should feel
continuous.

## Research

- `HookServer.memories: HashMap<harness_id, HarnessMemoryStore>` is the
  authoritative store (`hook_server.rs:156`). `harness_id` is ephemeral
  (`hm-{seq}`), so it cannot be the persistence key.
- `create_harness_memory` (`commands.rs:198`) takes no args today. Frontend
  calls it from `acp-harness-view.ts:395` during `start()`. It runs on the
  main thread; the harness has no notion of "project dir" yet — Krypton's
  global cwd is `std::env::current_dir()` at app launch.
- `memory_set` already emits `acp-harness-memory-changed` on success
  (`hook_server.rs:407`), giving us a single chokepoint for "save now."
- `dispose_harness_memory` (`hook_server.rs:218`) drops the in-memory entry —
  that must NOT delete the file (the user expects restore on next launch).
- Spec 75 explicitly listed persistence as out of scope; this spec is the
  follow-on the user asked for. No data migration needed (memory is RAM-only).

**Alternatives considered:**

- *Per-tab key (random uuid stored in localStorage):* survives reload but not
  uninstall/reinstall, and gives no cross-machine portability. Rejected — adds
  state without solving the actual continuity problem.
- *Global single file:* simple but conflates unrelated projects. Rejected.
- *SQLite:* overkill for ≤ 4 lanes × ~8 KB per harness. Plain JSON is fine.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| tmux | `tmux-resurrect` plugin saves session/pane state to `~/.tmux/resurrect/<timestamp>.txt`; `tmux-continuum` triggers it on a timer | File-per-snapshot, restored on tmux start |
| Zellij | Built-in session resurrection: serializes layout to `~/.cache/zellij/<session>/` | Per-session directory, auto-restored by name |
| VS Code | Per-workspace state at `~/Library/Application Support/Code/User/workspaceStorage/<hash>/` keyed by workspace folder hash | Closest match — keys on workspace path |
| Cursor / Windsurf agents | Chat history persisted per workspace folder under app data dir | Same pattern as VS Code |
| Warp | Cloud-synced agent threads keyed by workspace | Different — requires account |

**Krypton delta** — match the VS-Code-style per-workspace pattern (key on
canonical project dir), store locally only (no sync), and use a flat JSON file
because the data is tiny and human-inspectable. No timer-based snapshots —
save on every change, debounced.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Add `persistence_path: Option<PathBuf>` to `HarnessMemoryStore`; load on construction; debounced save after every mutation; expose `create_harness_memory(project_dir: Option<String>)`. |
| `src-tauri/src/commands.rs` | `create_harness_memory` accepts optional `project_dir: Option<String>` arg and forwards to hook server. Add `get_app_cwd` and `clear_harness_memory_lane`. |
| `src/acp/acp-harness-view.ts` | Pass current project dir (prioritizing `this.projectDir` with `get_app_cwd` fallback) into `create_harness_memory`. |
| `src/acp/types.ts` | `HarnessMemorySession` unchanged; arg type for invoke updated. |
| `docs/75-acp-harness-lane-memory.md` | Add `extended_by: docs/76-acp-harness-memory-persistence.md`; update "Out of Scope" line for persistence. |
| `docs/05-data-flow.md` | Add load-on-create / save-on-set step to memory flow. |
| `docs/PROGRESS.md` | New entry. |

No frontend protocol change. No new Tauri events.

## Design

### Storage Location

```
~/.config/krypton/acp-harness-memory/<hash>.json
```

- `<hash>` = first 16 hex chars of SHA-256 over the canonicalized project dir
  (`std::fs::canonicalize`). Avoids filesystem-illegal chars and keeps names
  bounded. Collisions are negligible at this length for a single user.
- The file embeds the original `project_dir` string for human inspection and
  debugging.
- If `project_dir` is `None` (caller didn't provide), persistence is disabled
  for that harness — backwards-compatible with existing callers.

### File Format

```jsonc
{
  "version": 1,
  "projectDir": "/Users/wk/Source/krypton",
  "savedAt": 1746201600000,
  "lanes": {
    "Claude-1": {
      "summary": "...",
      "detail": "...",
      "updatedAt": 1746201500000
    },
    "Codex-1": { ... }
  }
}
```

Unknown `version` → log a warning and start empty (don't crash, don't delete).

### Data Structures (Rust)

```rust
struct HarnessMemoryStore {
    lanes: HashMap<String, LaneMemoryDoc>,
    persistence_path: Option<PathBuf>,    // None = ephemeral
    project_dir: Option<String>,           // recorded in the file
    save_pending: Arc<AtomicBool>,         // debounce flag
}

#[derive(Serialize, Deserialize)]
struct PersistedMemory {
    version: u32,                          // = 1
    project_dir: String,
    saved_at: u64,
    lanes: HashMap<String, LaneMemoryDoc>,
}
```

`LaneMemoryDoc` gets `Serialize + Deserialize` (already `Clone`).

### Save Flow

1. `memory_set` mutates `store.lanes` under the existing mutex.
2. Before releasing the lock, if `persistence_path` is `Some`, schedule a
   debounced save: spawn a thread (or use an existing tokio handle) that sleeps
   500 ms then atomically writes the snapshot. The `save_pending` flag prevents
   stacking writers — only one save in flight per store.
3. Atomic write: serialize → write to `<path>.tmp` → `fs::rename` to final.
4. Errors logged via `log::warn!` — never propagate to the agent (memory
   write succeeds in-memory regardless of disk failure).

### Load Flow

1. `create_harness_memory(project_dir)` resolves `<hash>.json`.
2. If file exists & parses & `version == 1` → populate `lanes` from it.
3. If parse fails → rename to `<hash>.json.broken-<ts>` for forensics, start
   empty.
4. New `harness_id` returned as today (callers don't care about persistence).

### Dispose Flow

`dispose_harness_memory` drops the RAM entry **without touching the file**.
The next `create_harness_memory(same project_dir)` reads it back.

### Frontend Change

`acp-harness-view.ts:395`:

```ts
const projectDir = this.projectDir || await invoke<string>('get_app_cwd').catch(() => null);
const session = await invoke<HarnessMemorySession>('create_harness_memory', { projectDir });
```

Uses `this.projectDir` (set during harness creation from the focused workspace
CWD) with a fallback to `get_app_cwd` (Krypton's global launch CWD).

## Edge Cases

- **No project dir available:** persistence disabled; harness behaves as today.
- **Two harnesses, same project dir:** both load the same snapshot, both save
  independently → last save wins. Acceptable; document the behavior.
- **Lane backend uninstalled between sessions:** the lane's saved memory still
  loads and is visible via `memory_list`. When the backend is reinstalled, the
  same lane label resumes ownership. Stale orphans (lane never reappears) are
  user-cleared via `memory_set("", "")` from any reinstated lane is not
  possible — add `clear_harness_memory_lane(harness_id, lane)` Tauri command
  for manual cleanup from the UI.
- **Disk full / permission denied:** log warning, continue. Memory remains in
  RAM. Next successful save overwrites.
- **Corrupt JSON:** quarantine + start empty (above).
- **`project_dir` not canonicalizable** (deleted): hash the input string as-is,
  log warning.
- **App killed mid-write:** atomic rename means either old or new content,
  never partial.

## Open Questions

None. Defaults chosen above; ready for approval.

## Out of Scope

- Cross-machine sync (cloud / git).
- Per-tab or per-harness-instance separation within the same project dir.
- Versioned history / undo.
- Encryption at rest (memory contents are user-visible plain text by design).
- A UI to browse / edit persisted files outside the harness view.
- Migration tooling beyond `version` field (none needed at v1).

## Resources

- `docs/75-acp-harness-lane-memory.md` — base spec being extended.
- `src-tauri/src/hook_server.rs:140-460` — current memory implementation.
- `src-tauri/src/commands.rs:198-228` — current Tauri command surface.
- `src/acp/acp-harness-view.ts:367-430` — current init flow.
- [serde_json::to_writer_pretty](https://docs.rs/serde_json/latest/serde_json/fn.to_writer_pretty.html) — used for persisted file.
- [std::fs::rename atomic-on-same-fs guarantee](https://doc.rust-lang.org/std/fs/fn.rename.html) — basis for atomic write strategy.
- VS Code workspaceStorage layout — pattern for hashing workspace path as the persistence key.
