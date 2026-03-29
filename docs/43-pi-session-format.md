# Pi Session Format — Implementation Spec

> Status: Implemented
> Date: 2026-03-29
> Milestone: M3 — AI Agent

## Problem

Krypton's agent uses `@mariozechner/pi-agent-core` for LLM interaction but has its own dumbed-down session format (`StoredMessage[]` in a JSON file). This loses structured content blocks, tool call metadata, and context — and the 80-message hard truncation silently drops history with no summarization. Meanwhile, pi-mono's `SessionManager` already solves all of this.

## Solution

Replace Krypton's custom `session.ts` with a thin adapter that calls pi-mono's `SessionManager` via Tauri IPC. Since `SessionManager` uses Node.js `fs` APIs (incompatible with WebView), move session persistence to the **Rust backend** by spawning a small Node sidecar or, more practically, by reimplementing the JSONL read/write in Rust behind Tauri commands. The frontend will work with pi-agent-core's `AgentMessage` types directly instead of the lossy `StoredMessage`.

**Chosen approach:** Implement JSONL session read/write as Rust Tauri commands, matching pi-mono's file format exactly (same JSONL structure, same directory convention). The frontend adapts `AgentMessage[]` to/from this format.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/lib.rs` | Register new session commands |
| `src-tauri/src/session.rs` | **New** — Rust JSONL session read/write/list |
| `src/agent/session.ts` | Rewrite — thin IPC wrapper calling Rust session commands |
| `src/agent/agent.ts` | Persist/restore `Agent.state.messages` via new session API |
| `src/agent/agent-view.ts` | Replace `StoredMessage` rendering with `AgentMessage`-based rendering |
| `src-tauri/Cargo.toml` | Add `serde_json` line-delimited support (already has serde) |

## Design

### File Format

Match pi-mono's JSONL format exactly. Each line is a JSON object with a `type` discriminator:

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"<iso>","cwd":"/path/to/project"}
{"type":"message","id":"<uuid>","parentId":"<uuid>|null","message":{"role":"user","content":"..."}}
{"type":"message","id":"<uuid>","parentId":"<uuid>","message":{"role":"assistant","content":[...]}}
{"type":"message","id":"<uuid>","parentId":"<uuid>","message":{"role":"toolResult","content":[...]}}
{"type":"compaction","id":"<uuid>","parentId":"<uuid>","summary":"...","firstKeptEntryId":"<uuid>"}
```

Session files live at: `~/.config/krypton/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`

The `<encoded-cwd>` uses pi-mono's convention: `--Users-wk-Source-krypton--` (strip leading `/`, replace `/` with `-`, wrap in `--`).

### Rust Backend (`session.rs`)

```rust
// Tauri commands

#[tauri::command]
fn session_create(cwd: String) -> Result<SessionHandle, String>
// Creates new JSONL file with header, returns { session_id, file_path }

#[tauri::command]
fn session_append(session_id: String, entry: serde_json::Value) -> Result<(), String>
// Appends one JSON line to the session file

#[tauri::command]
fn session_load(file_path: String) -> Result<Vec<serde_json::Value>, String>
// Reads all lines from a JSONL file, returns parsed entries

#[tauri::command]
fn session_continue_recent(cwd: String) -> Result<Option<SessionHandle>, String>
// Finds most recent session file for this cwd, returns handle or None

#[tauri::command]
fn session_list(cwd: String) -> Result<Vec<SessionInfo>, String>
// Lists all sessions for a cwd with metadata (id, timestamp, message count)
```

The Rust side is intentionally **dumb** — it just manages files. All message semantics stay in TypeScript.

### Frontend Session API (`session.ts`)

```typescript
// Replaces the old StoredMessage-based API

interface SessionHandle {
  sessionId: string;
  filePath: string;
}

async function createSession(cwd: string): Promise<SessionHandle>
async function continueRecentSession(cwd: string): Promise<SessionHandle | null>
async function appendEntry(sessionId: string, entry: SessionEntry): Promise<void>
async function loadEntries(filePath: string): Promise<SessionEntry[]>
async function listSessions(cwd: string): Promise<SessionInfo[]>
```

`SessionEntry` is a TypeScript union type matching the JSONL line types (session header, message, compaction, etc.).

### Agent Integration (`agent.ts`)

```typescript
// On prompt():
// 1. If no session, createSession(cwd) or continueRecentSession(cwd)
// 2. After each agent event, appendEntry() to persist
// 3. On restore, loadEntries() and rebuild Agent.state.messages

// On reset():
// 1. Create a new session (don't delete old one — they accumulate like pi-mono)
```

Key change: instead of syncing DOM back to a flat message array, we persist structured `AgentMessage` objects as they arrive from pi-agent-core events.

### Data Flow

```
1. User opens agent pane, setProjectDir(cwd) called
2. Frontend calls continueRecentSession(cwd) via Tauri IPC
3. Rust finds most recent .jsonl for that cwd, returns handle + entries
4. Frontend rebuilds Agent.state.messages from message entries
5. Frontend renders messages in the agent view
6. User sends prompt → agent.prompt(text)
7. On each agent event (message_update, tool_start, etc.):
   a. Update UI (existing flow)
   b. appendEntry(sessionId, entry) to persist to JSONL
8. On /new command: createSession(cwd) — starts fresh file, clears agent
```

### Migration

Old `.krypton/agent-session.json` files are ignored (not migrated). Users start fresh sessions in the new format. The old files can be manually deleted.

## Edge Cases

- **No session dir exists:** Rust `session_create` creates it recursively
- **Corrupt JSONL line:** Skip malformed lines on load (log warning), don't fail the whole session
- **projectDir is null:** No persistence (in-memory only, same as current behavior)
- **Concurrent writes:** Single-threaded Tauri command handler prevents races
- **Large sessions:** Append-only JSONL means old sessions grow; future compaction can truncate

## Open Questions

None — format is dictated by pi-mono compatibility.

## Out of Scope

- **Compaction/summarization:** Future enhancement. For now, sessions grow unbounded (still better than silent 80-message truncation).
- **Tree branching/navigation:** Store parentId for future compatibility but don't implement branch UI yet.
- **Session browser UI:** Just use most recent session; no session picker yet.
- **AgentSession wrapper from pi-mono:** Too coupled to coding-agent's Node.js APIs. We replicate the format, not the class.
