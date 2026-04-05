# File Manager AI Assistant — Implementation Spec

> Status: Implemented
> Date: 2026-04-05
> Milestone: M8 — Polish

## Problem

The file manager supports manual operations (rename, copy, move, delete, create) but lacks intelligent file management. Users can't ask "rename all these files to kebab-case", "summarize this folder", "generate a README for this project", or "explain what this file does" without switching to a separate agent view and manually providing file paths as context.

## Solution

Add an inline AI overlay to the `FileManagerView` that sits at the bottom of the file manager panel (same pattern as the terminal's `InlineAIOverlay`). The AI automatically receives context about the current directory, cursor file, and marked files. It uses the existing `AgentController` with a file-manager-specific system prompt that instructs it to perform file operations. After the AI completes, the directory listing auto-refreshes.

## Affected Files

| File | Change |
|------|--------|
| `src/file-manager.ts` | Add AI overlay lifecycle, context building, key handler for `i` |
| `src/file-manager-ai.ts` | **New** — `FileManagerAI` overlay class |
| `src/styles/file-manager.css` | Add `.krypton-file-manager-ai*` styles |

## Design

### Data Structures

```typescript
// file-manager-ai.ts

/** Context passed to the AI about the file manager's current state */
interface FileManagerContext {
  cwd: string;                    // Current working directory
  cursorFile: FileEntry | null;   // File/dir under cursor
  markedFiles: FileEntry[];       // All marked/selected files
  totalEntries: number;           // Total items in directory
}

type AIPhase = 'input' | 'loading' | 'result';
```

### API / Commands

No new Tauri commands. Uses existing `AgentController` with existing tools (`read_file`, `write_file`, `bash`). The file manager context is injected into the user prompt, not the system prompt, so it stays lightweight.

### Data Flow

**Opening the AI overlay:**
```
1. User presses `i` in file manager (normal mode)
2. FileManagerView enters AI mode, creates FileManagerAI overlay
3. Overlay attaches to bottom of file manager element
4. Input field gets focus
5. File manager key handler delegates to overlay while AI mode is active
```

**Submitting a prompt:**
```
1. User types prompt and presses Enter
2. FileManagerAI builds context string from current FM state:
   - CWD path
   - Cursor file name + type + size
   - Marked file list (names + types)
3. Creates disposable AgentController (same pattern as InlineAIOverlay)
4. Sends context + user prompt to agent
5. Agent streams response, overlay renders markdown
6. On agent_end, overlay shows result with action hints
7. FileManagerView calls loadDirectory(cwd) to refresh listing
```

**Context injection format (prepended to user message):**
```
Working directory: /Users/wk/Source/krypton
Current file: src/compositor.ts (file, 84.2K)
Marked files (3):
  - src/types.ts (file, 8.1K)
  - src/input-router.ts (file, 24.6K)  
  - src/layout.ts (file, 6.3K)

User request: <actual prompt>
```

### Keybindings

**File manager normal mode:**

| Key | Action |
|-----|--------|
| `i` | Open AI overlay (focus input) |

**AI overlay active:**

| Key | Action |
|-----|--------|
| `Enter` | Submit prompt |
| `Escape` | Close overlay, return to file manager |
| `Tab` | Toggle mode: ACT (perform operations) / ASK (answer questions) |

**AI overlay result phase:**

| Key | Action |
|-----|--------|
| `Escape` | Close overlay |
| `Enter` | Ask another question (return to input) |
| `Cmd+C` | Copy response to clipboard |

### UI Structure

```
┌─────────────────────────────────────────────────────┐
│ ~/Source/krypton                                     │ breadcrumb
├──────────────────────┬──────────────────────────────┤
│  ▸ src/              │  preview content ...         │
│  ● package.json      │                              │
│  ● tsconfig.json     │                              │
│    Makefile           │                              │
├──────────────────────┴──────────────────────────────┤
│ ┌─── AI overlay ──────────────────────────────────┐ │
│ │ ACT ▸ rename marked files to kebab-case         │ │
│ │                                                  │ │
│ │ ✓ Done. Renamed 2 files:                        │ │
│ │   tsconfig.json → tsconfig.json (unchanged)     │ │
│ │   package.json → package.json (unchanged)       │ │
│ │                                                  │ │
│ │               ↵ again · ⌘C copy · ⎋ dismiss    │ │
│ └──────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│ 12 items | 2 marked | sort: name ↑                  │ status bar
└─────────────────────────────────────────────────────┘
```

**DOM structure:**

```html
<div class="krypton-file-manager-ai">
  <div class="krypton-file-manager-ai__input-row">
    <span class="krypton-file-manager-ai__prompt">ACT ▸</span>
    <input class="krypton-file-manager-ai__input" />
    <span class="krypton-file-manager-ai__mode">⇥ ask</span>
  </div>
  <div class="krypton-file-manager-ai__result">
    <div class="krypton-file-manager-ai__response"><!-- streamed markdown --></div>
  </div>
  <div class="krypton-file-manager-ai__spinner">
    <span class="krypton-file-manager-ai__dots">Thinking...</span>
  </div>
  <div class="krypton-file-manager-ai__hint">↵ submit · ⇥ ask · ⎋ dismiss</div>
</div>
```

### System Prompt

```
You are a file management AI assistant inside Krypton terminal's file browser.
You have tools to read files, write files, and run shell commands.

MODES:
- ACT mode: Perform file operations (rename, move, organize, generate, transform).
  Execute operations using your tools, then report what you did concisely.
- ASK mode: Answer questions about files, explain code, summarize contents.
  Read relevant files, then answer concisely.

RULES:
- Always use absolute paths derived from the working directory.
- After modifying files, briefly list what changed.
- Be concise — 1-5 sentences max.
- Never ask follow-up questions. Make your best judgment.
```

## Edge Cases

- **No files marked, no cursor file**: AI gets only CWD context. Prompt like "create a README" still works.
- **AI modifies directory structure**: After agent_end, loadDirectory refreshes. Cursor resets to 0 — acceptable since the directory may have changed significantly.
- **Large number of marked files (100+)**: Truncate context to first 50 marked files with a note "(and N more)". Prevents token waste.
- **AI is still running when user presses Escape**: Abort the controller, close overlay, refresh directory.
- **Binary files in marked set**: Include name/size but note "(binary)" — don't read content.

## Out of Scope

- Persistent AI conversation history within file manager (each prompt is independent)
- Drag-and-drop file context (keyboard-only)
- Custom tool registration for file manager AI
- Multi-turn agent chat (use the dedicated agent view `a` for that)
- Image/media understanding
