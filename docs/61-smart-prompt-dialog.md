---
name: Smart Prompt Dialog
description: Global modal for authoring prompts with @-mention placeholders and sending them to the active Claude Code terminal tab
type: spec
---

# Smart Prompt Dialog — Implementation Spec

> Status: Implemented
> Date: 2026-04-15
> Milestone: Post-M2 — productivity layer

## Problem

Users running `claude` in a Krypton terminal tab often want to dispatch a prompt from a *different* tab (an editor view, another terminal, etc.) without the friction of tab-switching, typing, and losing context. Today there is no shortcut for "send this prompt to my Claude session" — users must manually focus the Claude tab, click into xterm, paste, and press Enter.

## Solution

A global modal invoked by `Cmd+Shift+K` from any tab or mode. The dialog has a **persistent target chip** at the top (always visible, always switchable via `Cmd+,`) plus a textarea with inline `@`-mention autocomplete for files (`@path`) and a special `@selection` placeholder for the current xterm selection. Krypton enumerates every tab whose foreground process is `claude`; the chip shows the active target, and the user can switch targets at any time without losing typed text. On submit, the prompt is written to the target's PTY with a trailing `\r` and that window flashes to confirm delivery.

- **`@path`** is passed through verbatim — Claude Code natively resolves `@file` references, so the dialog only assists autocomplete.
- **`@selection`** is expanded inline to the literal selected text (wrapped in a fenced block) before the prompt is sent.

## Research

**Krypton internals (confirmed):**
- `write_to_pty(session_id, data: Vec<u8>)` — `src-tauri/src/commands.rs:40`. TS call site pattern: `invoke('write_to_pty', { sessionId, data })`.
- `get_pty_cwd(session_id)` — `src-tauri/src/commands.rs:33`. macOS uses `lsof` (fork cost ~50–200ms), Linux uses `/proc/{pid}/cwd`. Cache on dialog open.
- `process-changed` event carries `{ session_id, process: { pid, name, cmdline }, previous }` — `src/types.ts:239`. Currently consumed by `src/extensions.ts:50`; no central cache exists — we'll add one on the Compositor.
- Session routing: `Compositor.sessionMap: Map<SessionId, SessionLocation>` — `src/compositor.ts:177`. Window enumeration via `Compositor.windows: Map<WindowId, KryptonWindow>`.
- Mode enum: `src/types.ts:23` — add `PromptDialog`.
- Modal pattern: `src/command-palette.ts:98` (overlay + container, `--visible` class toggle, `requestAnimationFrame` focus).
- Fuzzy match already implemented: `fuzzyMatch()` in `src/command-palette.ts:33` — reuse for file autocomplete scoring.
- Selection read: `terminal.getSelection()` — `src/compositor.ts:609`.

**Prior art for `@`-mention UX:**
- Warp, Cursor, Zed all use an inline popup anchored under the caret, triggered only when `@` follows whitespace or start-of-input. Up/Down navigate, Enter/Tab commit, Esc closes popup (keeps typed text), Backspace-past-`@` closes.
- Claude Code expands `@path` CLI-side with built-in fuzzy matching — confirms pass-through is safe for file paths.
- Globs (`@src/**/*.ts`) are not supported by Claude Code — we do not support them either.
- Caret positioning: mirrored-div technique (the `component/textarea-caret-position` library is the canonical implementation; port inline rather than add a dep).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Warp | Agent mode `@` dropdown; sources files from git index | Chip attach, backend expands content |
| Cursor | `@` popup under caret, tabs for Files/Code/Docs | Server-side content expansion |
| Zed Agent Panel | `@file/@symbol/@thread/@rules` | Chip-token UI, content attached not referenced |
| Claude Code CLI | `@relative/path`, `~/`, fuzzy match built in | Pass-through target for Krypton |
| Slack / Linear | `@` after whitespace, popup below caret | Enter/Tab commit, Esc keeps text |

**Krypton delta:** Matches convention on keybinding (Up/Down/Enter/Tab/Esc) and popup positioning. Diverges in two ways: (a) *auto-targets a specific external process* (`claude`) rather than the current editor — a terminal-emulator-specific affordance; (b) *pass-through for `@path`* rather than content expansion, since Claude Code is the downstream expander. No direct market equivalent for "dispatch prompt from tab A to process in tab B."

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | Add `list_cwd_files` command |
| `src-tauri/src/file_index.rs` | New module: cached file-listing via `rg --files` with TTL |
| `src-tauri/src/lib.rs` | Register new command |
| `src/types.ts` | Add `Mode.PromptDialog`; extend `KryptonWindow` or add sidecar map for last-known process |
| `src/prompt-dialog.ts` | **New** — dialog controller, autocomplete popup, send logic |
| `src/caret-position.ts` | **New** — mirrored-div caret-position helper (inlined, ~60 lines) |
| `src/compositor.ts` | Expose `findSessionsByProcess(name)`; cache latest `ProcessInfo` per session; add `flashWindow(windowId)` |
| `src/input-router.ts` | Register `PromptDialog` mode; route `Cmd+Shift+K` from Normal/Compositor/etc. |
| `src/main.ts` | Construct `PromptDialog`, wire to compositor + input router |
| `src/styles/overlays.css` | Styles for `.krypton-prompt-dialog`, `.krypton-prompt-dialog__mention-popup` |

## Design

### Data Structures

```typescript
// src/types.ts additions
export enum Mode {
  // ...existing...
  PromptDialog,
}

// src/prompt-dialog.ts
interface MentionState {
  active: boolean;
  start: number;      // index of '@' in textarea value
  query: string;      // substring from '@'+1 to caret
  items: FileMatch[]; // current ranked results
  selectedIndex: number;
}

interface FileMatch {
  path: string;       // relative to CWD
  score: number;
  matchIndices: number[];
}

interface ClaudeTarget {
  sessionId: SessionId;
  windowId: WindowId;
  windowTitle: string;
  cwd: string | null;   // null while get_pty_cwd is in flight
  pid: number;
}

interface TargetState {
  candidates: ClaudeTarget[];        // all live claude sessions
  selectedIndex: number;             // which candidate is active
  pickerOpen: boolean;               // picker row expanded
}

// Module-level (persists across dialog opens within a session)
let lastUsedSessionId: SessionId | null = null;
```

```rust
// src-tauri/src/file_index.rs
pub struct FileIndexCache {
    entries: Mutex<HashMap<PathBuf, CachedIndex>>,
}

struct CachedIndex {
    files: Vec<String>,
    indexed_at: Instant,
}

// TTL: 10s. On miss, run `rg --files --hidden --glob '!.git'` in cwd.
```

### API / Commands

```rust
#[tauri::command]
pub fn list_cwd_files(
    cache: State<'_, Arc<FileIndexCache>>,
    cwd: String,
    limit: Option<usize>,  // default 5000
) -> Result<Vec<String>, String>
```

No new IPC events.

### Data Flow

```
1. User presses Cmd+Shift+K (any mode).
2. InputRouter.setMode(Mode.PromptDialog) — PromptDialog.open() runs.
3. Enumerate targets: Compositor.findSessionsByProcess('claude') → ClaudeTarget[].
   For each candidate, fire-and-forget get_pty_cwd(sessionId) to populate the chip.
4. Pick initial target:
   - 0 candidates → chip renders in empty/error state, textarea still focusable but submit disabled.
   - 1 candidate → auto-select, chip populated, focus → textarea.
   - N candidates → auto-select lastUsedSessionId if still present, else first; picker opens
     automatically so the user sees the choice. Focus → picker (not textarea).
5. Once a target is selected, kick off list_cwd_files(target.cwd) and cache for the dialog lifetime.
6. User may press Cmd+, at any time to re-open the picker without losing typed text.
   Picker navigation: 1-9 hotkey, Up/Down+Enter, Esc to dismiss picker (keeps last target).
7. User types in textarea. On each keystroke:
   a. If current char is '@' AND preceded by whitespace or start — enter mention mode, record start index.
   b. In mention mode: query = value.slice(start+1, caret). Run fuzzyMatch against cached file list, render popup under caret.
   c. Space/Enter/Tab/Esc/Backspace-past-'@' handled per Slack/Linear conventions (see Edge Cases).
8. User presses Enter (outside mention mode) or Cmd+Enter.
9. PromptDialog.submit():
   a. If no target → toast "No target selected", abort.
   b. Expand @selection → read source tab's xterm selection, replace with fenced block.
   c. Leave @path tokens untouched (Claude Code expands them CLI-side).
   d. invoke('write_to_pty', { sessionId: target.sessionId, data: utf8Bytes(prompt + '\r') }).
   e. lastUsedSessionId = target.sessionId.
   f. Compositor.flashWindow(target.windowId) — 400ms CSS glow pulse.
   g. Close dialog, return to previous mode.
```

### Target Selection

Target is a first-class, always-visible element — **not** a fallback that only appears on ambiguity.

- **Persistent chip** at the top of the dialog renders the current target (window title, CWD, PID). Visible even when there's only one Claude session.
- **Picker** opens by `Cmd+,`, clicking the chip's `[⇅]` affordance, or automatically when the dialog opens with N≥2 candidates.
- **Enumeration** comes from `Compositor.findSessionsByProcess('claude')`, which reads a per-session `ProcessInfo` cache populated by the existing `process-changed` event. No polling.
- **Last-used** session id is kept in a module-level variable (`lastUsedSessionId`), scoped to the app session — cleared on quit. It's used only to pre-select a row in the picker; it never overrides an explicit user choice.
- **Live updates:** while the dialog is open, the dialog subscribes to `process-changed`. New Claude sessions join the candidate list; the current target disappearing marks the chip `--stale` but preserves the typed prompt so the user can re-pick.
- **Empty state:** when there are no Claude candidates, the chip shows `⚠ no Claude session` and submit is disabled. Typing is still permitted (so the prompt isn't lost) — a Claude spawn hint is shown in the footer.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+Shift+K` | Any mode | Open Smart Prompt Dialog |
| `Cmd+,` | PromptDialog (any state) | Open/close target picker |
| `1`–`9` | PromptDialog (picker open) | Jump to candidate N |
| `Up` / `Down` | PromptDialog (picker open) | Navigate candidates |
| `Enter` | PromptDialog (picker open) | Confirm target, focus textarea |
| `Esc` | PromptDialog (picker open) | Close picker, keep last target |
| `Esc` | PromptDialog (mention popup open) | Close popup, keep text |
| `Esc` | PromptDialog (no popup/picker) | Close dialog |
| `Enter` | PromptDialog (textarea) | Submit prompt |
| `Shift+Enter` | PromptDialog (textarea) | Insert newline |
| `Enter` / `Tab` | PromptDialog (mention popup open) | Commit selected completion |
| `Up` / `Down` | PromptDialog (mention popup open) | Navigate completions |
| `Cmd+Enter` | PromptDialog (textarea) | Force-submit (ignore mention popup) |

### UI Changes

```
┌───────────────────────────────────────────────────┐
│ → Claude · ~/Source/krypton · pid 4321        [⇅] │  ← target chip (always visible)
├───────────────────────────────────────────────────┤
│ [textarea — 3 lines min, grows to 12]             │
│                                                   │
│                                                   │
├───────────────────────────────────────────────────┤
│ ⏎ send   ⇧⏎ newline   ⌘, switch target   esc      │  ← footer hints
└───────────────────────────────────────────────────┘
```

When the picker is open, it replaces the chip and expands above the textarea:

```
┌───────────────────────────────────────────────────┐
│ Select target Claude session                      │
│ › 1  claude  ~/Source/krypton    pid 4321  (last) │
│   2  claude  ~/Source/pi-mono    pid 4388         │
│   3  claude  ~/projects/app      pid 4502         │
├───────────────────────────────────────────────────┤
│ [textarea]                                        │
└───────────────────────────────────────────────────┘
```

- `.krypton-prompt-dialog` — centered overlay, 640px wide, max-height 480px. Mirrors palette chrome with a distinct accent color (`--krypton-accent-alt`) to signal "dispatch" vs "search."
- `.krypton-prompt-dialog__target-chip` — persistent row showing target window name, CWD, PID, and `[⇅]` affordance. Modifier classes: `--empty` (no target), `--loading` (cwd resolving), `--stale` (target process exited mid-dialog).
- `.krypton-prompt-dialog__picker` — list row rendered in place of the chip when `pickerOpen`. Rows have hotkey digit, process name, CWD, PID, and `(last)` badge.
- `.krypton-prompt-dialog__textarea` — 3-line minimum, auto-grows to 12 lines. Dimmed + disabled while picker is open or chip is empty.
- `.krypton-prompt-dialog__mention-popup` — absolutely positioned below caret, max 8 items, fuzzy-match highlights via `<span class="hl">`.
- `.krypton-prompt-dialog__footer` — small monospace hint row listing the 3–4 most relevant keybindings for the current state.
- Target window flash: adds `.krypton-window--flash` for 400ms (keyframe glow pulse on the existing accent outline).

### Configuration

New TOML under `[prompt_dialog]`:

```toml
[prompt_dialog]
keybinding = "Cmd+Shift+K"     # global open shortcut
target_process = "claude"       # process name to auto-detect
file_index_limit = 5000          # max files per CWD in autocomplete
```

## Edge Cases

- **No Claude tab at open:** chip renders in `--empty` state, submit disabled, textarea still writable so the user can draft. Footer shows "Press `c` to spawn Claude in a new tab."
- **Multiple Claude tabs at open:** picker auto-opens with last-used pre-selected (or first candidate if last-used is gone). Picker is the same UI the user gets via `Cmd+,`.
- **Target process exits while dialog is open:** chip flips to `--stale` (visual: dim + strikethrough), submit is disabled, prompt text preserved. If other candidates exist, a "Switch target" hint appears; otherwise `--empty` state.
- **New Claude tab spawned while dialog is open:** `process-changed` subscription adds it to `candidates`; the chip does not auto-switch (never surprise the user), but a subtle `(N available)` badge appears next to the chip.
- **Claude tab CWD changes mid-session:** CWD is re-read on every dialog open; file index cache keyed by CWD so it invalidates naturally.
- **User opens picker with Cmd+, and Escapes:** picker closes, last selected target retained, focus returns to textarea with caret preserved.
- **`@` mid-word (e.g. `foo@bar.com`):** do not trigger popup. Guard: only activate when char at `start-1` is whitespace or `start === 0`.
- **Typing `@` then space with empty query:** dismiss popup, keep the `@ ` as literal text.
- **Backspace past the `@`:** dismiss popup, resume normal typing.
- **`rg` not installed:** backend falls back to `walkdir` (respects a minimal ignore list: `.git`, `node_modules`, `target`, `dist`).
- **`get_pty_cwd` returns None (process gone):** show error, close dialog.
- **Prompt contains literal `\r` or `\n` sequences:** `\n` is converted to `\r` on write (terminal newline convention); multiline prompts use heredoc or bracketed paste — out of scope for v1, see Out of Scope.
- **Selection on source tab is empty but `@selection` used:** expand to empty string (no fenced block) and surface a warning toast.
- **Dialog opened while an animation is in progress:** input router already buffers during animations; respect the same buffering.

## Open Questions

None — all resolved in conversation (v1 scope: `@path` + `@selection`; backend uses `rg --files`; auto-detect Claude via process name).

## Out of Scope

- Bracketed-paste handling for multiline prompts (v2 — current impl joins lines with `\r`).
- `@window` (reference another terminal's buffer) and `@clipboard` — deferred to v2.
- Manual "mark as Claude tab" override — deferred to v2 if auto-detect proves unreliable.
- Glob patterns in `@path` — Claude Code does not support, we will not either.
- Command templates loaded from `.claude/commands/*.md` — the agent view already does this; can be cross-wired later.
- History / recall of previous prompts — v2.

## Resources

- [Warp classic input](https://docs.warp.dev/terminal/classic-input) — `@` context dropdown UX
- [Warp AI overview](https://www.warp.dev/warp-ai) — confirms content-expansion model
- [Cursor features](https://cursor.com/features) — tabbed `@` popup pattern
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) — `@file/@symbol/@rules` taxonomy
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) — confirms `@path` pass-through viability
- [MCPcat @ references guide](https://mcpcat.io/guides/reference-other-files/) — Claude Code's built-in fuzzy matching
- [VS Code Command Palette UX guidelines](https://code.visualstudio.com/api/ux-guidelines/command-palette) — result list anti-flicker, key conventions
- [textarea-caret-position](https://github.com/component/textarea-caret-position) — mirrored-div caret-positioning technique (port inline)
- [ripgrep --files](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md) — `rg --files` output format and `.gitignore` semantics
