# Agent Write Approval — Implementation Spec

> Status: Implemented
> Date: 2026-05-11
> Milestone: Agent UX

## Problem

The pi-agent `write_file` tool rendered an inline diff only after the file had already been overwritten. That made the diff useful for review, but too late to prevent a bad write.

## Solution

Add a keyboard-first approval gate around `write_file`. The tool reads the existing file, computes the same diff preview as before, asks `AgentView` for approval, and only invokes the backend `write_file` IPC after the user accepts. Rejected writes throw a tool error so the model can recover.

## Research

- `src/agent/tools.ts` already reads old file content before writing and computes a unified diff for files up to 50KB.
- `src/agent/agent-view.ts` already has inline diff preview rendering and scroll-mode `Enter` to open a full diff tab.
- `pi-agent-core` tool execution is async, so a tool can await a UI promise before returning.
- The ACP harness already uses `a`/`r` and `A`/`R` for write approvals; matching those keys keeps both agent surfaces consistent.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Aider | Shows diffs and asks for confirmation before applying edits. | Closest keyboard-first precedent. |
| Zed ACP | Holds `fs/write_text_file` until the user accepts or rejects the diff. | Krypton's ACP harness already mirrors this. |
| Cursor | Shows agent edits as reviewable apply/reject changes. | More mouse-oriented and editor-buffer centric. |

**Krypton delta** — keep the pi-agent view as a compact terminal-like surface: the write gate appears inline in the message stream, accepts `a`/`r`, and supports turn-scoped `A`/`R`. No modal and no per-hunk editing.

## Affected Files

| File | Change |
|------|--------|
| `src/agent/tools.ts` | Add `WriteApprovalHandler`; pause `write_file` before disk write. |
| `src/agent/agent.ts` | Let `AgentController` receive and pass the approval handler into tool creation. |
| `src/agent/agent-view.ts` | Render write review cards and resolve approvals via keyboard or buttons. |
| `src/styles/agent.css` | Add write review styling. |
| `docs/42-pi-agent-integration.md` | Document the updated tool flow and keys. |
| `docs/02-functional-requirements.md` | Add pi-agent write approval requirements. |
| `docs/04-architecture.md` | Document the AgentView write gate responsibility. |
| `docs/05-data-flow.md` | Add the write approval data flow. |
| `docs/PROGRESS.md` | Add recent landing. |

## Design

### Data Structures

```ts
export interface WriteApprovalRequest {
  id: string;
  path: string;
  resolvedPath: string;
  oldContent: string;
  newContent: string;
  diff?: string;
}

export type WriteApprovalHandler = (request: WriteApprovalRequest) => Promise<boolean>;
```

`AgentView` stores pending rows as `PendingWriteApproval` objects with the DOM row and promise resolver.

### Data Flow

```
1. Agent calls write_file({ path, content }).
2. tools.ts resolves the path, reads old content, and computes a diff when under the preview size cap.
3. tools.ts awaits writeApproval(request).
4. AgentView appends a WRITE REVIEW row with diff preview and waits for a/r/A/R.
5. Accept resolves true, then tools.ts invokes write_file and returns the normal tool result.
6. Reject resolves false, then tools.ts throws "User rejected write_file ...".
7. AgentView finalizes the tool row as success or error from the pi-agent-core event.
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `a` | Pending write review | Accept the oldest pending write. |
| `r` | Pending write review | Reject the oldest pending write. |
| `A` | Pending write review | Accept this write and all later writes in the current turn. |
| `R` | Pending write review | Reject this write and all later writes in the current turn. |
| `Ctrl+C` | Agent running | Reject pending writes and abort the agent run. |

## Edge Cases

- New file: old content is empty; preview shows additions.
- Large write: approval still appears, but with a "diff unavailable" note when preview generation is skipped.
- Rejected write: no file write occurs; the tool throws an error for the model.
- Abort while pending: pending writes are rejected before the controller aborts.

## Out of Scope

- Per-hunk approval.
- Editing proposed content before accepting.
- Gating `bash` commands.
- Persisting review cards into JSONL session history.

## Resources

- Internal: `docs/46-agent-inline-diff.md`
- Internal: `docs/89-acp-diff-preview.md`
