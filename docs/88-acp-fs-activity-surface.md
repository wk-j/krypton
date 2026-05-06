# ACP fs/* Activity Surface — Implementation Spec

> Status: Implemented
> Date: 2026-05-07
> Milestone: M-ACP — Harness convergence

## Problem

Krypton's Rust ACP backend already implements `fs/read_text_file` and `fs/write_text_file` (`src-tauri/src/acp.rs:377-416`) and advertises both in `clientCapabilities.fs` (`acp.rs:724-727`). Agents that prefer the ACP file primitives (Claude Code, Zed-flavored Codex, etc.) call them — and Rust handles them silently, returning content/success without telling the frontend anything happened.

Result: when an agent reads or writes a file via ACP, the harness transcript shows nothing. There's no `tool_call` for it (these are *client-method* calls, not tool calls), so the user has no idea what files the agent touched. This is opaque and prevents auditing.

## Solution

Add two `acp-event-{session}` emissions in `handle_inbound_request` — one for read, one for write — carrying `{ method, path, ok, error? }`. Add matching `AcpEvent` variants and route them into the existing transcript pipeline as a new `HarnessTranscriptItem` kind ("file activity"), rendered as a single-line chip:

```
📖 read   src/foo.ts
✏️ wrote  docs/88-acp-fs-activity-surface.md
✗ read failed: /etc/secret (permission denied)
```

This is a **visibility-only** spec. It does not introduce diff preview, accept/reject UI, or path scoping — those are deferred to Spec 89.

## Research

### Current Rust handling

`src-tauri/src/acp.rs:369-458` `handle_inbound_request`:
- `fs/read_text_file` (377): `std::fs::read_to_string` with NotFound → empty content. Reply only.
- `fs/write_text_file` (395): `mkdir -p parent` + `std::fs::write`. Reply only.
- `session/request_permission` (417): bridged to frontend via oneshot — **proves the emit-event-and-reply pattern already exists**.

So the infrastructure is there. We add an emit-before-reply for the fs methods, mirroring the permission bridge but without waiting for a response.

### Why agents already use these methods

`acp.rs:724-727` initialize declares `clientCapabilities.fs.{readTextFile, writeTextFile} = true`. Per ACP spec, agents that see this capability *prefer* ACP fs over their internal tools because it lets the client gate/diff/audit. Claude's adapter (`@zed-industries/claude-code-acp`) routes nearly all reads/writes through here; Codex and Gemini route some.

### Lane coverage

| Lane | Uses fs/read_text_file | Uses fs/write_text_file |
|------|------------------------|--------------------------|
| Claude-1 | Yes (most reads) | Yes (most writes) |
| Codex-1 | Sometimes | Sometimes |
| Gemini-1 | Occasionally | Occasionally |
| OpenCode-1 | Unknown — verify in implementation |
| Droid-1 | Unknown — verify in implementation |
| Pi-1 | **No** — pi-acp does not request the capability; Pi reads/writes via internal tool calls (lean lane) |

Pi-1 stays N/A. The visibility chip will simply never fire for Pi.

### Why this is not a security feature

A read/write *visibility chip* tells the user **after** the I/O happened (read) or as it happens (write). It is informational, not a gate. Agents that abuse the channel still get to read/write; the chip just makes that visible. Real gating (path scoping, write permission popup) requires Spec 89 and explicitly waiting on a frontend response before letting Rust touch disk.

### Alternatives ruled out

- **Filter to repo-root-relative paths only** — drops absolute-path reads (e.g. `~/.config/...`) which is the exact scenario users want to see. Rejected.
- **Fold into existing `tool_call` pipeline** — these aren't tool calls; they're client method invocations. Misclassifying them breaks `tool_call_update` semantics.
- **Wait for a response from frontend before replying** — that's Spec 89. Out of scope here.

## Prior Art

| Tool | Read visibility | Write visibility |
|------|------------------|-------------------|
| Zed | Inline transcript line "Read foo.ts" with line numbers | Diff card with accept/reject |
| Cursor | Reads invisible; writes shown as diff | Diff inline before apply |
| Aider | All reads/writes echoed in chat as `+ added file` / `- modified file` | Same |

**Krypton delta** — for v1 (this spec) match Aider's "every event becomes a transcript line" — simpler than Zed/Cursor, no UI components beyond a chip. Spec 89 will catch up to Zed-grade diff UX for writes.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | In `handle_inbound_request` add `client.emit_event(app, json!({...}))` calls for both `fs/read_text_file` and `fs/write_text_file` arms. Emit on success **and** failure (so the chip shows errors). Reply unchanged. |
| `src/acp/types.ts` | Extend `AcpEvent` union with `{ type: 'fs_activity'; method: 'read' \| 'write'; path: string; ok: boolean; error?: string }`. |
| `src/acp/client.ts` | Add new `case 'fs_activity'` in `handleRaw()` top-level switch (parallel to `session_update` / `permission_request` / `stop` / `error`). Update `RawAcpEvent.type` union. |
| `src/acp/acp-harness-view.ts` | New `HarnessTranscriptItem` variant `{ kind: 'fs_activity', method, path, ok, error }`. Event handler appends a transcript item. New renderer `renderFsActivityRow()`. |
| `src/styles/acp-harness.css` | Style `.acp-harness__fs-activity` — single-line chip, monospace path, dim by default, red tint on failure. |
| `docs/PROGRESS.md` | Record Spec 88 under M-ACP. |
| `docs/04-architecture.md` | §20 note: "ACP fs/* invocations now emit visibility events; transcript shows file reads/writes inline." |
| `docs/05-data-flow.md` | Add an "ACP fs activity" subsection: agent → Rust handler → emit `fs_activity` → frontend transcript. |

No new Tauri commands. No protocol-level changes (clientCapabilities already declared).

## Design

### Rust emit-on-handle pattern

```rust
// src-tauri/src/acp.rs handle_inbound_request, fs/read_text_file arm
let result = match std::fs::read_to_string(&path) {
    Ok(content) => {
        client.emit_event(&app, json!({
            "type": "fs_activity",
            "method": "read",
            "path": path,
            "ok": true,
        }));
        Ok(json!({ "content": content }))
    }
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
        // Existing behavior: NotFound returns empty content, not an error.
        // Still emit a chip — it's an attempted read.
        client.emit_event(&app, json!({
            "type": "fs_activity",
            "method": "read",
            "path": path,
            "ok": true,           // intentional — request succeeded with empty payload
        }));
        Ok(json!({ "content": "" }))
    }
    Err(e) => {
        let msg = format!("{e}");
        client.emit_event(&app, json!({
            "type": "fs_activity",
            "method": "read",
            "path": path,
            "ok": false,
            "error": msg,
        }));
        Err(json!({ "code": -32000, "message": format!("fs/read_text_file: {e}") }))
    }
};
```

Same pattern for `fs/write_text_file` — emit before returning Ok or after the io::Error is captured.

### Frontend dispatcher

```ts
// src/acp/client.ts handleRaw()
case 'fs_activity':
  event = {
    type: 'fs_activity',
    method: (raw as any).method === 'write' ? 'write' : 'read',
    path: String((raw as any).path ?? ''),
    ok: Boolean((raw as any).ok),
    error: typeof (raw as any).error === 'string' ? (raw as any).error : undefined,
  };
  break;
```

`RawAcpEvent.type` union grows to include `'fs_activity'`.

### Transcript item

```ts
// inside HarnessTranscriptItem union
| {
    kind: 'fs_activity';
    id: string;
    method: 'read' | 'write';
    path: string;
    ok: boolean;
    error?: string;
  }
```

Append on every `fs_activity` event. No coalescing — repeated reads of the same file each get their own row (matches user mental model: "agent did N reads").

### Renderer

```ts
function renderFsActivityRow(item: FsActivityItem, lane: HarnessLane): string {
  const icon = item.ok
    ? (item.method === 'read' ? '📖' : '✏️')
    : '✗';
  const verb = item.method === 'read' ? 'read' : 'wrote';
  const cls = item.ok ? 'acp-harness__fs-activity' : 'acp-harness__fs-activity acp-harness__fs-activity--err';
  const errSuffix = item.error ? ` <span class="err">${esc(item.error)}</span>` : '';
  return `<div class="${cls}"><span class="icon">${icon}</span><span class="verb">${verb}</span><span class="path">${esc(displayPath(item.path, lane))}</span>${errSuffix}</div>`;
}
```

`displayPath` shortens to repo-relative when the path is inside the lane cwd; otherwise prints absolute (with `~` collapse if under `$HOME`).

### CSS

```css
.acp-harness__fs-activity {
  font-size: 0.85em;
  color: var(--krypton-fg-dim, #7a8aa0);
  font-family: var(--krypton-mono, ui-monospace, monospace);
  padding: 2px 6px;
}
.acp-harness__fs-activity .icon { margin-right: 6px; }
.acp-harness__fs-activity .verb { width: 5ch; display: inline-block; }
.acp-harness__fs-activity--err { color: var(--krypton-accent-warn, #ff6b6b); }
```

### Click/keyboard interaction

- Click on path → opens in Helix tab via `editor-open.ts` (existing helper from OpenCode-1 commit `aa9b30a`).
- No keyboard binding for jumping to specific row — out of scope for visibility spec.

## Edge Cases

- **Empty path** (agent sends `""`) → emit with `path: ""`; renderer shows `📖 read «empty»`. Surfaces malformed agent calls.
- **Path with embedded newline** → `esc()` neutralizes; visible as escaped string.
- **Very long path** → CSS clips with `text-overflow: ellipsis`; full path in `title=`.
- **High-volume reads** (agent reads 50 files in a turn) → 50 rows. Acceptable for v1; if turn-summary aggregation is wanted, defer to Spec 89.
- **Read of non-existent file** (returns empty content) → still shows as `📖 read` (success). Matches the actual wire result; agents may probe filesystem and that's worth seeing.
- **Pi-1** → no emissions (Pi doesn't use fs capability). No special-casing needed in renderer.
- **Lane re-spawn during request** → `client.emit_event` no-ops on disposed clients (existing behavior). Reply still attempts and may fail silently.

## Open Questions

1. **Should NotFound reads emit `ok: true` or a distinct flag?** The current Rust code returns empty string for NotFound (not an error). User-visibly that's still "the read happened and returned nothing." **Recommendation: ok: true** to match wire semantics. Add `notFound: true` field if user demand surfaces.
2. **Coalesce identical consecutive reads** (same path within 200ms)? Avoids spam if agent re-reads in a tight loop. **Recommendation: no for v1**; if log gets noisy, revisit in Spec 89.
3. **Where to render — inline in transcript flow, or in a dedicated "side rail"?** Inline matches Aider; side rail matches Zed's "files modified" panel. **Recommendation: inline for v1** (smallest surface area). Side rail is a Spec 89 candidate when diff cards land.

## Out of Scope

- Diff preview before write — **Spec 89**.
- Accept/reject permission popup before write — **Spec 89**.
- Path scoping (refuse writes outside cwd subtree) — **Spec 89**.
- Aggregating per-turn fs activity into a summary chip — possible Spec 89 follow-up.
- `terminal/*` visibility — separate future spec.
- Pi-1 fs visibility — Pi doesn't use the capability.
- Editor unsaved-buffer integration (`fs/read_text_file` returning in-memory content for files open in the user's editor) — far-future spec.

## Resources

- [ACP spec — Filesystem methods](https://agentclientprotocol.com/protocol/file-system) — `fs/read_text_file`, `fs/write_text_file` request/response shapes
- [ACP spec — Initialize / clientCapabilities](https://agentclientprotocol.com/protocol/initialize) — `fs.{readTextFile,writeTextFile}` boolean capability declaration
- `src-tauri/src/acp.rs:369-458` — current `handle_inbound_request`; insertion point for emits
- `src-tauri/src/acp.rs:724-727` — `clientCapabilities.fs` declaration (already in place)
- `src-tauri/src/acp.rs:417-445` — `session/request_permission` bridge; reference pattern for emit-then-act
- `src/acp/client.ts:163-229` — frontend dispatcher; new `fs_activity` case
- `src/acp/acp-harness-view.ts` (HarnessTranscriptItem union, transcript renderer) — append point
- `src/editor-open.ts` — Helix opener (used for click-to-open path interaction)
- `docs/72-acp-harness-view.md` — harness architecture
- Spec 89 (planned) — diff preview + permission gate for `fs/write_text_file`
