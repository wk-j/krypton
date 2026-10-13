# Agent Inline Diff View — Implementation Spec

> Status: Implemented
> Date: 2026-03-30
> Milestone: M8 — Polish

## Problem

When the AI agent writes files via `write_file`, the tool result only shows `"Written: path"`. The user has no visibility into what actually changed — they must manually diff or read the file. This makes it hard to review agent work and catch mistakes.

## Solution

Capture the old file content before each `write_file` execution, compute a unified diff, and attach it to the tool result. The `AgentView` renders an inline diff preview (compact colored +/- lines) below the tool row. Pressing `Enter` on a focused tool row opens a full `DiffContentView` in a new compositor tab for side-by-side review. No new dependencies needed — `diff` (already installed) generates unified patches, `diff2html` (already installed) renders them.

## Affected Files

| File | Change |
|------|--------|
| `src/agent/tools.ts` | `write_file` reads old content before writing, returns structured result with diff |
| `src/agent/agent.ts` | Pass structured tool result data through `tool_end` event |
| `src/agent/agent-view.ts` | Render inline diff preview in tool row; `Enter` opens full diff view |
| `src/styles.css` | Styles for inline diff preview lines |

## Design

### Tool Result Enhancement

`write_file` reads the existing file (if any) before writing, then computes a unified diff:

```typescript
// In tools.ts write_file execute():
const resolved = resolvePath(params.path, projectDir);
let oldContent = '';
try {
  oldContent = await invoke<string>('read_file', { path: resolved });
} catch {
  // New file — old content is empty
}
await invoke('write_file', { path: resolved, content: params.content });

const { createTwoFilesPatch } = await import('diff');
const patch = createTwoFilesPatch(params.path, params.path, oldContent, params.content);

return {
  content: [{ type: 'text', text: `Written: ${params.path}` }],
  details: `Written: ${params.path}`,
  diff: patch,       // unified diff string
  filePath: params.path,
};
```

### Event Data Flow

The `tool_end` event already carries an optional `result` string. Extend it to also carry diff data:

```typescript
// In agent.ts AgentEventType
| { type: 'tool_end'; name: string; isError: boolean; result?: string; diff?: string; filePath?: string }
```

Extract `diff` and `filePath` from the tool result object in the event subscription:

```typescript
case 'tool_execution_end': {
  const res = e.result as { details?: string; diff?: string; filePath?: string; content?: Array<...> };
  onEvent({
    type: 'tool_end',
    name: String(e.toolName ?? ''),
    isError: Boolean(e.isError),
    result: typeof res?.details === 'string' ? res.details : res?.content?.[0]?.text,
    diff: res?.diff,
    filePath: res?.filePath,
  });
  break;
}
```

### Inline Diff Preview

When `tool_end` fires for `write_file` with a `diff` string, `AgentView` renders a compact preview below the tool row:

```
.agent-view__tool-row
  ✓ write_file  {"path":"src/app.ts","content":"…"}
  .agent-view__tool-result   "Written: src/app.ts"
  .agent-view__diff-preview                        ← NEW
    .agent-view__diff-line.--added     "+  const x = 1;"
    .agent-view__diff-line.--removed   "-  const x = 2;"
    .agent-view__diff-line.--context   "   return x;"
    .agent-view__diff-more             "… 12 more lines  Enter → full diff"
```

Preview rules:
- Show at most **8 changed lines** (additions + deletions only, skip context-only lines for the preview)
- If more changes exist, show `"… N more lines  Enter → full diff"` hint
- New files: show `"+N lines (new file)"` summary instead of line-by-line
- No changes (content identical): show `"(no changes)"` and skip diff

### Opening Full Diff View

The tool row stores the diff string as a data attribute. When the user focuses a tool row with a diff and presses `Enter` (in scroll mode), `AgentView` calls a compositor callback to open `DiffContentView`:

```typescript
// AgentView stores diff data on the tool row DOM element
toolRow.dataset.diff = diff;
toolRow.dataset.filePath = filePath;

// In scroll mode, Enter on a tool row with diff:
private openDiffCallback: ((diff: string, title: string) => void) | null = null;

onOpenDiff(cb: (diff: string, title: string) => void): void {
  this.openDiffCallback = cb;
}
```

Compositor wires this up:

```typescript
agentView.onOpenDiff((diff, title) => this.openDiffFromString(diff, title));
```

New compositor method:

```typescript
async openDiffFromString(unifiedDiff: string, title: string): Promise<void> {
  const { DiffContentView } = await import('./diff-view');
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;overflow:hidden;';
  const diffView = new DiffContentView(unifiedDiff, container);
  diffView.onClose(() => this.closeTab());
  await this.createContentTab(title, diffView);
}
```

### Data Flow

```
1. Agent calls write_file tool
2. tool_execution_start → AgentView shows tool row with spinner
3. write_file.execute():
   a. read_file(path) → oldContent (empty string if new file)
   b. write_file(path, content) → file written
   c. createTwoFilesPatch(path, path, oldContent, content) → unified diff
   d. Returns { details, diff, filePath }
4. tool_execution_end → agent.ts extracts diff + filePath into tool_end event
5. AgentView.handleAgentEvent(tool_end):
   a. Finalizes tool row (✓/✗)
   b. If diff present: renders inline preview, stores diff on DOM element
6. User scrolls to tool row, presses Enter
7. AgentView calls openDiffCallback(diff, "DIFF // path")
8. Compositor creates DiffContentView tab with full side-by-side diff
```

### Scroll-Mode Interaction

In scroll mode, tool rows with diffs are focusable. Add a focused-row tracker:

- `j/k` scrolling already works line-by-line
- Add: when a tool row with `data-diff` scrolls into center viewport, highlight it subtly
- `Enter` in scroll mode: if a highlighted tool row has `data-diff`, open full diff
- Visual cue: tool rows with diffs get a small `▸` indicator after the checkmark

## Edge Cases

| Case | Handling |
|------|----------|
| New file (no old content) | `oldContent = ''`, diff shows all lines as additions. Preview: `"+N lines (new file)"` |
| File unchanged | `diff` will be minimal (just header). Show `"(no changes)"` |
| Binary file | `read_file` will fail or return garbage. Catch error, skip diff |
| Very large file write | `createTwoFilesPatch` could be slow. Cap at 50KB old+new combined; skip diff if larger |
| `read_file` fails (permissions) | Catch error, proceed without diff (tool result unchanged) |
| Tool row clicked/entered but no diff | `Enter` does nothing (no callback fired) |

## Out of Scope

- Inline editing of diffs (approve/reject hunks)
- Applying diffs in reverse (undo agent writes)
- Diff for `bash` tool output
- Persisting diffs in session history
