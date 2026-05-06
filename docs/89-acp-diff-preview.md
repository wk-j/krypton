# ACP Diff Preview & Gated Writes — Implementation Spec

> Status: Implemented
> Date: 2026-05-07
> Milestone: M-ACP — agent harness UX

## Problem

Three gaps in the ACP harness diminish its value as a "client that gives agents a reason to use ACP fs/* protocol":

1. **`tool_call.content[].type === 'diff'`** payloads (sent by Codex/Claude/Gemini) carry `path`, `oldText`, `newText`, but the harness renders only the path string — the +/- lines are dropped.
2. **`fs/write_text_file`** is fulfilled immediately and silently. There is no diff preview, no accept/reject gate. Agents have no UX incentive to delegate writes via ACP rather than using their own internal Write tool.
3. **No path scoping** — `fs/read_text_file` and `fs/write_text_file` happily touch any absolute path the agent supplies (including secrets outside the project).

Result: harness functions as a transport but never demonstrates the visibility or safety properties that make ACP valuable.

## Solution

Three additive changes, each independently shippable:

1. **Extract** the existing `renderDiffPreview` helper (lives in legacy `acp-view.ts`) into a shared module `src/acp/diff-render.ts`. Wire it into the harness so `tool_call.content[].type === 'diff'` renders inline +/- lines instead of just a path.
2. **Gate** `fs/write_text_file` in `acp.rs`: hold the JSON-RPC reply via a `oneshot` channel (mirroring `session/request_permission`), compute a diff against current disk content, emit a `fs_write_pending` event, route the user's accept/reject decision back through a new `acp_fs_write_response` Tauri command.
3. **Scope** all `fs/*` paths to the lane's project root in Rust, rejecting requests that escape with a JSON-RPC error.

## Research

### Existing wiring already in place
- `src/acp/types.ts:17-27` — `ToolCallContent` already has `oldText`/`newText` fields (parsed but currently discarded by the harness renderer).
- `src/acp/acp-harness-view.ts:2586` — current diff handling is `sections.push({ label: 'diff', text: item.path })`. Path-only.
- `src/acp/acp-view.ts:1329-1505` — fully built diff renderer (`renderDiffPreview`, `renderDiffRow`, `renderDiffGap`) using `diffLines` from `diff` v8.0.4, with hunk gap insertion and line numbering. Used by the legacy single-lane view; not reused.
- `src/styles/acp.css:381-414` — companion CSS classes `.acp-view__diff-line--{add,del,ctx,hunk}` with cyberpunk-aware colors (`var(--agent-accent)` green for add, `var(--krypton-error)` red for del). Already production-quality.

### Permission template (template for write-gating)
- `src-tauri/src/acp.rs:458-487` — `session/request_permission` arm: stores `oneshot::Sender<Value>` keyed by JSON-RPC ID in `perm_pending: Mutex<HashMap<u64, _>>`, emits frontend event, awaits the channel, replies via `client.reply(id, …)`.
- `src-tauri/src/acp.rs:970-988` — `acp_permission_response` Tauri command resolves the channel.
- `src/acp/acp-harness-view.ts:954-999` — `addPermission` + `resolvePermission` frontend pattern: `appendTranscript('permission', …)` with embedded payload, body rendered by `renderPermissionBody`. This is the exact pattern Spec 89's diff preview should reuse.

### Library availability
- `diff@8.0.4` and `diff2html@3.4.56` already in `package.json`. `diffLines` from `diff` is sufficient — no need for `diff2html`'s heavyweight HTML emitter; we already have row-level CSS that performs better.

### Alternatives considered
- **Use `diff2html`** — produces complete HTML side-by-side or unified views, but tags don't theme cleanly into Krypton's cyberpunk palette and bundle size adds ~80KB. Rejected: existing `renderDiffPreview` already covers our needs.
- **Render diff via xterm.js with a pty + `git diff --color`** — overkill, requires PTY, breaks the "DOM transcript" model. Rejected.
- **Implement diff preview only for `tool_call.content[].diff`, not for `fs/write_text_file`** — solves problem 1 but leaves problem 2 unsolved: no agent gets the gate-and-edit experience that defines Zed's ACP UX. Rejected: the value of Spec 89 comes from doing both.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed | Inline accept/reject diff card per `fs/write_text_file`. Agent's reply is delayed until user decides. Rejected writes return a JSON-RPC error so the agent retries differently. | Sets the ACP convention. Krypton-89 mirrors this. |
| Cursor | Modal "agent edit" review with full file diff, accept/reject per hunk. Diff is computed by the IDE, not the agent. | Modal-heavy; we keep ours inline. |
| GitHub Copilot Chat (VS Code) | "Apply" button on edit suggestions; diff inline in chat panel. No protocol-level gating — copilot writes through VS Code's own edit API. | Not ACP, but UX pattern is similar. |
| Aider | CLI tool prints unified diff in terminal, asks `[y/N]` before writing. | Closest to Krypton's keyboard-first ethos. |
| _Krypton harness today_ | Path-only label for `tool_call.content.diff`; immediate silent writes via `fs/write_text_file`. | The gap this spec fills. |

**Krypton delta** — match Zed's protocol-level gating semantics (hold the reply, route through a UI block) and Aider's keyboard-first UX (`a` accept, `r` reject, `A` accept-all-this-turn — already a pattern in the existing permission flow). Diverge from Zed on rendering: stick with Krypton's transcript-item model rather than a side panel; keep accept/reject buttons inline in the transcript like the current permission UI.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/diff-render.ts` | **NEW.** Extract `renderDiffPreview`, `renderDiffRow`, `renderDiffGap`, `Row`/`HunkOpts` types from `acp-view.ts`. Export pure functions returning HTML strings. |
| `src/acp/acp-view.ts` | Replace local `renderDiffPreview*` with `import` from new module. ~50 lines removed. |
| `src/acp/acp-harness-view.ts` | Use `renderDiffPreview` to render `tool_call.content[].type === 'diff'`. Add `fs_write_pending` event handler, transcript item kind `fs_write_review`, accept/reject UI block, key handlers for `a`/`r`/`A`/`R`. |
| `src/acp/types.ts` | Add `AcpEvent` variant `{ type: 'fs_write_pending'; requestId: number; path: string; oldText: string; newText: string }`. Add `HarnessTranscriptItem.kind: 'fs_write_review'` and embedded `FsWriteReviewPayload`. |
| `src/acp/client.ts` | Dispatch arm for `fs_write_pending`. New method `respondFsWrite(requestId, accept)` invoking new Tauri command. |
| `src-tauri/src/acp.rs` | (a) Replace `fs/write_text_file` arm with: read current disk content, store reply sender in new `fs_write_pending: Mutex<HashMap<u64, FsWriteCtx>>` map, emit `fs_write_pending`, await decision. (b) New `acp_fs_write_response` Tauri command. (c) Add `validate_fs_path(client, path)` helper called by both fs arms; reject paths outside `client.cwd`. |
| `src-tauri/src/lib.rs` | Register `acp_fs_write_response` in `invoke_handler!`. |
| `src/styles/acp-harness.css` | Add `.acp-harness__fs-review*` classes (mirroring `.acp-harness__perm*`). Reuse `.acp-view__diff-line*` rules already in `acp.css`. |
| `src/styles/acp.css` | (Optional) move `.acp-view__diff-line*` rules behind a `.diff-preview` neutral class so both old + new views share, OR duplicate-then-cleanup later. Decision: duplicate-then-cleanup later — keeping legacy untouched lowers risk. |
| `docs/04-architecture.md` | Add §23 "ACP diff preview & gated writes". |
| `docs/05-data-flow.md` | Add step "fs/write_text_file gated review". |
| `docs/PROGRESS.md` | Recent landing entry. |
| `docs/87-acp-extended-session-updates.md`, `docs/88-acp-fs-activity-surface.md` | No changes. |

## Design

### Data Structures

**Frontend (`src/acp/types.ts`):**
```ts
export type AcpEvent =
  | { type: 'fs_write_pending'; requestId: number; path: string; oldText: string; newText: string }
  | // existing variants…
  ;

export interface FsWriteReviewPayload {
  requestId: number;
  path: string;
  oldText: string;
  newText: string;
  resolved?: 'accepted' | 'rejected';
}
```

**Rust (`src-tauri/src/acp.rs`):**
```rust
struct FsWriteCtx {
    reply: oneshot::Sender<Result<Value, Value>>,
    path: String,
    new_content: String,
}
fs_write_pending: Mutex<HashMap<u64, FsWriteCtx>>,
```

### API / Commands

New Tauri command:
```rust
#[tauri::command]
pub async fn acp_fs_write_response(
    session: u64,
    request_id: u64,
    accept: bool,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String>
```

Frontend: `lane.client.respondFsWrite(requestId, accept)` thin wrapper.

### Data Flow (gated write, primary use case)

```
1. Agent → Rust JSON-RPC: fs/write_text_file { path, content }
2. Rust validate_fs_path(path) — reject if outside cwd → reply error
3. Rust read current disk content as oldText (empty string if not found)
4. Rust insert (request_id → FsWriteCtx { reply_tx, path, new_content }) into fs_write_pending
5. Rust emit "fs_write_pending" event { requestId, path, oldText, newText }
6. Frontend client.ts handleRaw → 'fs_write_pending' arm
7. acp-harness-view.ts appends transcript item { kind: 'fs_write_review', payload }
8. renderTranscriptItem → renderFsWriteReviewBody:
   - header: "✏️  write  src/foo.rs"
   - diff body via renderDiffPreview(oldText, newText)
   - footer buttons: [✓ Accept] [✗ Reject]
9. User presses 'a' (accept) or 'r' (reject) — same key pattern as existing permission flow
10. Frontend invokes acp_fs_write_response(session, requestId, accept)
11. Rust pops fs_write_pending[request_id], if accept → fs::write(path, new_content) and reply Ok({}),
    else reply Err({ code: -32000, message: "User rejected the write" })
12. Rust still emits fs_activity (existing) so the visibility log records the outcome
13. Frontend updates the transcript item's resolved field; renders ✓/✗ stamp; locks buttons
```

### Path Scoping

Helper:
```rust
fn validate_fs_path(client: &Arc<AcpClient>, raw_path: &str) -> Result<PathBuf, Value> {
    let p = PathBuf::from(raw_path);
    let abs = if p.is_absolute() { p } else { client.cwd.join(&p) };
    let canon = abs.canonicalize()
        .or_else(|_| abs.parent().and_then(|par| par.canonicalize().ok()).map(|c| c.join(p.file_name().unwrap_or_default())).ok_or(...))?;
    if !canon.starts_with(&client.cwd) {
        return Err(json!({ "code": -32602, "message": "Path outside project root" }));
    }
    Ok(canon)
}
```

Both `fs/read_text_file` and `fs/write_text_file` arms call this first; on error, emit `fs_activity` with `ok=false, error="…"` and reply the JSON-RPC error.

### Keybindings (when an `fs_write_review` item is the focused-pending review for the focused lane)

| Key | Context | Action |
|-----|---------|--------|
| `a` | fs_write_review pending | Accept |
| `r` | fs_write_review pending | Reject |
| `A` | fs_write_review pending | Accept all writes for this turn |
| `R` | fs_write_review pending | Reject all writes for this turn |

Reuses the existing `acceptAllForTurn` / `rejectAllForTurn` lane flags introduced for permissions.

### UI Changes

New transcript item kind `fs_write_review` rendered as a card:
```
┌─ ✏️ write  src/foo.rs ─────────────────────────────────┐
│  1   │ -  function old() { return 1; }                │
│      │ 2 +  function newer() {                        │
│      │ 3 +    return 42;                              │
│      │ 4 +  }                                         │
│  ⋯ context omitted                                    │
│  [✓ Accept (a)]   [✗ Reject (r)]   [⏵ Accept all (A)] │
└──────────────────────────────────────────────────────┘
```

CSS reuses `.acp-view__diff-line*` rules. New `.acp-harness__fs-review` wrapper, `.acp-harness__fs-review-actions` button row.

### Configuration

None.

## Edge Cases

- **Disk file does not exist** — `oldText = ""`; entire content is rendered as additions. fs_activity already handles this case as `ok=true`.
- **Disk file unreadable (permission denied)** — emit fs_activity error, reply JSON-RPC error to agent. No review UI.
- **Agent cancels mid-review** — agent disconnect drops the `oneshot::Sender`; `rx.await` returns `Err(_)`; existing pattern already replies error.
- **Rejected write** — reply `{ code: -32000, message: "User rejected the write" }`. Agent typically retries with a different approach. Existing fs_activity emits `ok=false, error="rejected"`.
- **Multiple pending reviews queue** — store all in lane.transcript in order; `a/r` resolves the oldest unresolved review; `A/R` resolves all in order until queue empty.
- **Lane disposed while review pending** — drop all `fs_write_pending` channels for that session; agent gets disconnect error (already handled by existing dispose paths).
- **Symlinks escaping project root** — `canonicalize()` resolves them; rejected by scope check.
- **Path scoping false-positive on case-insensitive fs (macOS)** — `canonicalize` normalizes case; `starts_with` works on normalized paths.

## Open Questions

None — all reviewed during research.

## Out of Scope

- Per-hunk accept/reject (whole-file decision only)
- Inline editing of the proposed write before accepting
- Diff syntax highlighting per language (plain text +/- only)
- `terminal` content type rendering (separate spec)
- `tool_call.locations` clickable-to-Helix integration (already partially handled by spec 86 / OpenCode-1's editor opener)

## Resources

- [Agent Client Protocol — fs/write_text_file](https://agentclientprotocol.com/protocol/file-system) — confirms client may delay reply for user review; rejected writes should return error response.
- [`diff` package on npm](https://www.npmjs.com/package/diff) — `diffLines(a, b) => Change[]` API used by existing `acp-view.ts`.
- [`oneshot` channel in `tokio::sync`](https://docs.rs/tokio/latest/tokio/sync/oneshot/) — pattern already in use for `perm_pending`; reused.
- `src/acp/acp-view.ts:1329-1505` (this repo) — reference implementation of `renderDiffPreview` to extract.
- `src/styles/acp.css:381-414` (this repo) — diff CSS to reuse.
- `src-tauri/src/acp.rs:458-487, 970-988` (this repo) — permission gate template.
