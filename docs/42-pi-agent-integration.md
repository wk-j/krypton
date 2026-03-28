# Pi-Agent Integration — Implementation Spec

> Status: Implemented
> Date: 2026-03-28
> Milestone: M8 — Polish

## Problem

Krypton has no integrated AI coding assistant. Developers context-switch between the terminal and separate AI tools (Cursor, Claude.ai, Warp) to get help writing, editing, or debugging code. An embedded keyboard-driven coding agent living in its own persistent window — tiled alongside terminal windows — would close this loop without leaving the workspace.

## Solution

Embed `@mariozechner/pi-agent-core` directly in the TypeScript frontend (the library is browser-compatible — no Node.js sidecar). Surface the agent as a **dedicated `KryptonWindow`** (not a dashboard overlay), rendered via the existing `ContentView` interface that already powers the diff viewer and markdown viewer. The agent window participates fully in the grid layout, compositor focus cycling, and all standard window operations. Opened via `Leader a` in Compositor mode.

## Research

- `@mariozechner/pi-agent-core` v0.63.1 compiles to ES2022, no Node.js bindings — runs in WKWebView without modification
- The `Agent` class emits granular events (`message_update` with `delta`, `tool_execution_start/end`) suited to streaming DOM renders
- `ContentView` interface already exists in `types.ts` (`type`, `element`, `onKeyDown`, `dispose`, `onResize`) — diff view and markdown viewer both use it. Adding `'agent'` to `PaneContentType` follows the identical pattern; zero new compositor plumbing needed
- `run_command` Tauri command already exists (Git Status dashboard) — reuse for `bash` tool
- `get_pty_cwd` command already exists — inject focused terminal window's CWD into system prompt
- API key falls back to environment variable if config value is empty — consistent with how other tools (aider, etc.) work from a terminal

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| **Warp terminal** | Agent mode inline in terminal; `#` activates; shows reasoning + shell commands with approve/reject gate | Only terminal-native agent; keyboard-friendly but modal |
| **Cursor** | Persistent side-panel chat; agent mode applies file edits; tool calls collapsed by default | Side panel is always visible alongside editor — closest to "dedicated window" concept |
| **Zed** | Agent panel as a first-class editor split; can be positioned anywhere in the layout | Agent as a real panel in the tiling layout — strongest Prior Art for this design |
| **VS Code Copilot** | Chat panel docked to sidebar; `@workspace` context scoping | Docked, not floating; panel competes with file explorer |
| **Aider** | Pure CLI in a terminal pane; git-aware auto-commit | Most keyboard-native; running aider in a terminal split is effectively what we're formalising |
| **Claude.ai** | Canvas for code artifacts; streaming; no terminal context | Web-only; inspiration for streaming message render style |

**Krypton delta:**
- **Matches convention**: persistent dedicated panel alongside code/terminal (Zed/Cursor), streaming text render (all), CWD context injection (Aider/Warp)
- **Intentional divergence**: agent is a full `KryptonWindow` — tiled, movable, resizable, focusable via `H/J/K/L` like any other window; keyboard-only input (no mouse); styled with Krypton cyberpunk chrome including per-window accent color; no per-tool approve/reject gate in Phase 1

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `'agent'` to `PaneContentType` union |
| `src/agent/agent.ts` | New — `AgentController`: wraps pi-agent-core `Agent`, init, `prompt()`, `abort()`, `subscribe()` |
| `src/agent/tools.ts` | New — Krypton tools: `read_file`, `write_file`, `bash`, `get_cwd` |
| `src/agent/session.ts` | New — serialize/restore conversation to `~/.config/krypton/agent-sessions/` via Tauri FS |
| `src/agent/agent-view.ts` | New — `AgentView` implementing `ContentView`: message list DOM, streaming renderer, input box |
| `src/agent/index.ts` | New — re-exports public API |
| `src/compositor.ts` | Add `createAgentWindow()`, wire `Leader a` action, handle `AgentView` in pane creation |
| `src/input-router.ts` | Add `a` → `createAgentWindow()` in Compositor mode |
| `src/command-palette.ts` | Add "Open Agent Window" action |
| `package.json` | Add `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@sinclair/typebox` |
| `docs/06-configuration.md` | Document new `[agent]` config section |

## Design

### Data Structures

```typescript
// Addition to src/types.ts
export type PaneContentType = 'terminal' | 'diff' | 'markdown' | 'agent';

// src/agent/agent.ts
export interface AgentConfig {
  provider: 'anthropic' | 'openai' | 'google';
  model: string;           // e.g. "claude-sonnet-4-20250514"
  apiKey: string;          // falls back to ANTHROPIC_API_KEY env var
  systemPromptExtra?: string;
}

// Internal render model for AgentView
interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;            // accumulated during streaming
  toolName?: string;
  isStreaming: boolean;
  isError: boolean;
}
```

### API / Commands

No new Tauri commands. Reuses:
- `run_command(cmd: string, args: string[], cwd?: string) -> string` — for `bash` tool
- `get_pty_cwd(session_id: number) -> string` — seeds system prompt with focused terminal's CWD
- Tauri FS plugin `readTextFile` / `writeTextFile` — for `read_file` / `write_file` tools

Public TypeScript API (`src/agent/index.ts`):
```typescript
export function createAgentView(config: AgentConfig): AgentView  // returns ContentView
export class AgentView implements ContentView { ... }
```

`AgentView` implements the existing `ContentView` interface:
```typescript
class AgentView implements ContentView {
  type: PaneContentType = 'agent';
  element: HTMLElement;                        // root DOM node, owned by compositor
  onKeyDown(e: KeyboardEvent): boolean { ... } // intercepts Enter, Ctrl+C, Up
  dispose(): void { ... }                      // abort agent, persist session
  onResize(w: number, h: number): void { ... } // reflow message list
}
```

### Data Flow

```
1. User presses Leader → a (Compositor mode)
2. InputRouter calls compositor.createAgentWindow()
3. compositor.createAgentWindow():
   a. Reads AgentConfig from loaded KryptonConfig
   b. Calls createAgentView(config) → returns AgentView (ContentView)
   c. Creates KryptonWindow with one Tab, one Pane; pane.contentView = agentView
   d. Assigns window accent color (same pool as terminal windows)
   e. Titlebar set to "AI  <model-name>" (e.g. "AI  claude-sonnet-4")
   f. Window enters grid; layout recalculates
4. If agent window already exists: focus it instead of creating another
5. User focuses agent window (H/J/K/L or index), starts typing prompt
6. AgentView.onKeyDown intercepts Enter → calls agentController.prompt(inputText)
7. AgentController:
   a. Calls get_pty_cwd on the last focused terminal pane's session ID
   b. Injects CWD into first-turn system prompt ("Working directory: /path")
   c. Calls agent.prompt(text) on pi-agent-core Agent
8. pi-agent-core streams AgentEvent → AgentController.subscribe callback fires
9. On message_update: AgentView appends delta to current assistant message DOM node
10. On tool_execution_start: AgentView inserts tool row (name + spinner)
11. On tool_execution_end: AgentView updates tool row (✓ done / ✗ error)
12. On agent_end: session.ts serializes to JSONL at
    ~/.config/krypton/agent-sessions/<session-id>.jsonl
13. User presses Ctrl+C inside agent window → AgentController.abort()
14. Window closed via Leader w → AgentView.dispose() → abort + persist session
```

### Keyboard Architecture

`AgentView` has two internal states — **input state** (default) and **scroll state**. These are not global `Mode` enum values; they live entirely inside `AgentView`. The global mode stays `Normal` while the agent window is focused.

When the compositor gives focus to the agent window, `AgentView` immediately routes all printable keystrokes to the input box — no mouse click required to start typing. Leader key sequences always pass through to the compositor unchanged.

**State transitions:**
```
[Input state] ──Escape (empty input)──→ [Scroll state]
[Scroll state] ──Escape or i──────────→ [Input state]
```

### Keybindings

**Compositor level (always active)**

| Key | Context | Action |
|-----|---------|--------|
| `Leader` → `a` | Compositor mode | Create agent window (or focus existing) |
| `Leader` → `H/J/K/L` | Compositor mode | Focus adjacent window |
| `Leader` → `z` | Compositor mode | Maximize / restore |
| `Leader` → `w` | Compositor mode | Close agent window (abort + persist) |
| `Leader` → `m` / `r` | Compositor mode | Move / Resize mode |

**Input state (default on focus)**

| Key | Action |
|-----|--------|
| Any printable char | Appended to input box — no click needed |
| `Enter` | Submit prompt |
| `Shift+Enter` | Insert newline (multi-line prompt) |
| `Up` (empty input) | Recall previous sent prompt |
| `Down` (empty input) | Recall next prompt in history |
| `Ctrl+C` | Abort running turn; clear input if idle |
| `Ctrl+W` | Delete word before cursor in input |
| `Cmd+A` | Select all text in input |
| `Page Up` / `Ctrl+U` | Scroll message list up half-page (stays in input state) |
| `Page Down` / `Ctrl+D` | Scroll message list down half-page (stays in input state) |
| `Cmd+N` | New session (persists current, starts fresh) |
| `Escape` (empty input) | Enter scroll state |

**Scroll state (Escape from empty input)**

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down one line |
| `k` / `↑` | Scroll up one line |
| `Ctrl+D` / `Page Down` | Scroll down half-page |
| `Ctrl+U` / `Page Up` | Scroll up half-page |
| `g` | Scroll to top (oldest message) |
| `G` | Scroll to bottom (latest message) |
| `y` | Yank last assistant message to clipboard |
| `Y` | Yank full conversation to clipboard |
| `Escape` / `i` | Return to input state, re-focus input box |
| `Ctrl+E` | Expand / collapse tool output under cursor (if > 10 lines) |

### UI Changes

`AgentView` builds and owns this DOM tree, mounted as the pane's content element:

```
.agent-view                                    ← fills pane bounds, flex column
.agent-view--scroll-state                      ← modifier when in scroll state

  .agent-view__messages                        ← flex-col, overflow-y: auto, flex: 1
                                                  scroll state: subtle top/bottom
                                                  fade to signal scrollability

    .agent-view__msg.agent-view__msg--user
      .agent-view__msg-label                   ← "YOU"
      .agent-view__msg-text                    ← plain text, preserves newlines

    .agent-view__msg.agent-view__msg--assistant
      .agent-view__msg-label                   ← "AI"
      .agent-view__msg-text                    ← streamed delta by delta
      .agent-view__msg-cursor                  ← blinking "▋" during streaming,
                                                  hidden on agent_end

    .agent-view__msg.agent-view__msg--tool
      .agent-view__tool-icon                   ← spinning braille char while running,
                                                  "✓" success, "✗" error
      .agent-view__tool-name                   ← e.g. "bash"
      .agent-view__tool-args                   ← full args, monospace, dim
      .agent-view__tool-result                 ← full output, monospace, collapsible
                                                  if > 10 lines: show 10 + "… N more"
                                                  Ctrl+E toggles expand in scroll state

  .agent-view__state-hint                      ← dim label, bottom-right of messages area
                                                  "SCROLL  g/G  j/k  y  i→insert"
                                                  only visible in scroll state

  .agent-view__input-row                       ← fixed at bottom, no flex-shrink
                                                  dimmed + pointer-events:none while
                                                  agent is running
    .agent-view__prompt-glyph                  ← "❯" in accent color
                                                  "⠋" spinner glyph while running
    .agent-view__input                         ← contenteditable, multiline capable
                                                  auto-focused on window focus
                                                  hidden (height: 0) in scroll state
```

**Focus routing:** `AgentView` calls `this.inputEl.focus()` inside `onKeyDown` for any printable key received in input state — this ensures the first keystroke after focusing the window lands in the input without a click. In scroll state the input is hidden (`height: 0; overflow: hidden`) so the compositor never routes to it.

Styling uses existing `--krypton-*` CSS custom properties and the window's accent color. No new color tokens. The braille spinner reuses the existing animation from the notification system.

The window titlebar shows the model name as the title (e.g. `claude-sonnet-4`) with the standard cyberpunk chrome and the window's unique accent color — indistinguishable from a terminal window from the outside.

### Configuration

New `[agent]` section in `krypton.toml`:

```toml
[agent]
provider = "anthropic"                    # anthropic | openai | google
model = "claude-sonnet-4-20250514"
api_key = ""                              # fallback: ANTHROPIC_API_KEY env var
system_prompt_extra = ""                  # appended after built-in system prompt
```

Config loaded at startup via existing `get_config` Tauri command. No hot-reload for agent config (restart required to change model/key).

## Edge Cases

| Case | Handling |
|------|----------|
| `api_key` empty and env var not set | AgentView shows inline error message on first prompt; does not crash |
| Agent window already open, `Leader a` pressed | Focus the existing agent window; do not create a second one |
| Agent aborted mid-stream | Partial message shown with `[aborted]` label; session still persisted |
| `run_command` tool times out | Tool returns error result; agent sees it and can recover |
| Agent window closed while turn running | `AgentView.dispose()` calls `abort()` first, then persists partial session |
| Printable key fires before `focus()` completes | `onKeyDown` dispatches a synthetic `InputEvent` to the contenteditable to avoid dropping the first character |
| Scroll state entered mid-stream | `j/k/g/G` scroll normally; input remains hidden; agent continues streaming uninterrupted |
| Paste (Cmd+V) in input state | Contenteditable receives paste natively; strips HTML, keeps plain text only (intercept `paste` event) |
| No focused terminal (no CWD to inject) | CWD line omitted from system prompt silently |
| Agent window in Focus layout | Treated identically to a terminal window — can be pinned to right column |

## Open Questions

None — all design decisions resolved.

## Out of Scope

- Per-tool approve/reject gate (Phase 2)
- Multiple simultaneous agent windows (Phase 2 — `createAgentWindow` focuses existing in Phase 1)
- Tabs within the agent window for multiple conversations (Phase 2)
- pi-web-ui ChatPanel (uses Lit — violates "no frontend frameworks" rule)
- MCP tool integration (separate spec)
- Inline diff view for file edits (see `docs/38-diff-view-window.md`)
- Agent-initiated compositor actions (opening windows, switching workspaces)

## Resources

- [pi-mono GitHub](https://github.com/badlogic/pi-mono) — Agent class API, AgentEvent union, tool schema format
- [@mariozechner/pi-agent-core npm](https://www.npmjs.com/package/@mariozechner/pi-agent-core) — install, changelog
- [@sinclair/typebox](https://github.com/sinclairzx81/typebox) — TypeBox schema library used for tool parameter definitions
- [Zed AI panel architecture](https://zed.dev/blog/zed-ai) — primary prior art for "agent as a real tiling panel" UX pattern
- [Aider architecture](https://aider.chat/docs/more/edit-formats.html) — reference for keyboard-native coding agent without approve/reject gates
- [Warp AI terminal](https://www.warp.dev/blog/introducing-warp-ai) — reference for terminal-native streaming agent UX
- [pi-agent-core source](https://github.com/badlogic/pi-mono/tree/main/packages/pi-agent-core/src) — Agent constructor, public methods, full AgentEvent type union
