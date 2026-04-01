# Pi-Agent Integration — Implementation Spec

> Status: Implemented
> Date: 2026-03-28
> Milestone: M8 — Polish

## Problem

Krypton has no integrated AI coding assistant. Developers context-switch between the terminal and separate AI tools (Cursor, Claude.ai, Warp) to get help writing, editing, or debugging code. An embedded keyboard-driven coding agent living in its own persistent window — tiled alongside terminal windows — would close this loop without leaving the workspace.

## Solution

Embed `@mariozechner/pi-agent-core` directly in the TypeScript frontend (the library is browser-compatible — no Node.js sidecar). Surface the agent as a **dedicated `KryptonWindow`** (not a dashboard overlay), rendered via the existing `ContentView` interface that already powers the diff viewer and markdown viewer. The agent window participates fully in the grid layout, compositor focus cycling, and all standard window operations. Opened via `Leader a` (Command Palette).

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `'agent'` to `PaneContentType` union |
| `src/agent/agent.ts` | `AgentController`: wraps pi-agent-core `Agent`, lazy init, `prompt()`, `abort()`, CWD-aware system prompt |
| `src/agent/tools.ts` | CWD-aware tool factories: `read_file`, `write_file`, `bash` via `createKryptonTools(projectDir)` |
| `src/agent/session.ts` | Per-project session persistence to `<projectDir>/.krypton/agent-session.json` via Tauri `read_file`/`write_file` |
| `src/agent/agent-view.ts` | `AgentView` implementing `ContentView`: message list DOM, streaming renderer, manual keyboard input |
| `src/agent/index.ts` | Re-exports public API |
| `src/compositor.ts` | `openAgentView()`: resolves CWD, creates `AgentView`, calls `createContentTab()` |
| `src/command-palette.ts` | Register "Open AI Agent Window" action with `Leader a` keybinding |
| `src-tauri/src/commands.rs` | `run_command` returns combined stdout+stderr, error on non-zero exit |
| `package.json` | `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@sinclair/typebox` |

## Design

### Model & Provider

Hardcoded to ZAI provider with `glm-4.7` model on the **coding plan** endpoint (`https://api.z.ai/api/coding/paas/v4`). The coding plan endpoint is distinct from the regular pay-per-use endpoint — models like `glm-5` require a separate subscription, while `glm-4.7`, `glm-4.7-flash`, and `glm-5.1` (once pi-ai is updated) are available on the coding plan. API key read from `ZAI_API_KEY` environment variable at runtime via Tauri `get_env_var` command. The command first checks `std::env::var`, then falls back to spawning a login shell with `printenv` (shell-agnostic, works with bash/zsh/fish). No TOML configuration yet — model/provider changes require code edits.

### Tools

Tools are created via `createKryptonTools(projectDir)` factory, which closes over the project directory:

| Tool | Description | CWD behavior |
|------|-------------|-------------|
| `read_file` | Read file contents via Tauri `read_file` command | Relative paths resolved against `projectDir` |
| `write_file` | Write/overwrite file via Tauri `write_file` command | Relative paths resolved against `projectDir` |
| `bash` | Run shell command via Tauri `run_command` | `cwd` defaults to `projectDir` if not specified by LLM |

### Session Persistence

Sessions are stored as JSON files on the local filesystem, scoped per project directory:
- **Path**: `<projectDir>/.krypton/agent-session.json`
- **Format**: JSON array of `StoredMessage` objects (role, text, toolName, isError)
- **Max messages**: 80 (oldest trimmed on save)
- **When saved**: On `agent_end` event and on `dispose()`
- **No projectDir**: Session is not persisted (no fallback to global storage)

### Data Flow

```
1. User presses Leader → a
2. Command Palette dispatches 'agent.open' action → compositor.openAgentView()
3. compositor.openAgentView():
   a. Gets focused pane, calls get_pty_cwd(sessionId) to resolve projectDir
   b. Imports AgentView from './agent/agent-view'
   c. Creates new AgentView(), calls setProjectDir(projectDir)
      - setProjectDir also sets projectDir on AgentController
      - Triggers restoreSession() to load per-project history
   d. Registers onClose callback: () => this.closeTab()
   e. Calls createContentTab('AI  glm-4.7', agentView)
4. User focuses agent window, starts typing prompt
5. AgentView.onKeyDown intercepts Enter → calls submit()
6. submit() routes by prefix:
   - `!<cmd>` → executeShellCommand(cmd): invokes get_default_shell + run_command IPC, renders output inline
   - `/<cmd>` → handleSlashCommand(): /help, /new, /context, /model, etc.
   - Otherwise → agentController.prompt(text, onEvent)
7. AgentController (lazy init on first prompt):
   a. Reads ZAI_API_KEY via Tauri get_env_var
   b. Dynamic-imports pi-agent-core and pi-ai
   c. Creates Agent with system prompt including "Working directory: <projectDir>"
   d. Tools created via createKryptonTools(projectDir)
8. agent.subscribe() maps AgentEvent → simplified AgentEventType
9. On message_update (text_delta): AgentView appends delta text to DOM
10. On tool_execution_start: AgentView inserts tool row (name + spinner)
11. On tool_execution_end: AgentView updates tool row (checkmark/cross + result)
12. On agent_end: saveCurrentSession() writes to <projectDir>/.krypton/agent-session.json
13. On error: error message displayed inline in red
14. User presses Ctrl+C → AgentController.abort()
15. Tab closed via q (scroll mode) → AgentView.dispose() → abort + persist session
```

### Keyboard Architecture

`AgentView` has two internal states — **input state** (default) and **scroll state**. These are not global `Mode` enum values; they live entirely inside `AgentView`. The global mode stays `Normal` while the agent window is focused.

**State transitions:**
```
[Input state] ──Escape (empty input)──→ [Scroll state]
[Scroll state] ──Escape or i──────────→ [Input state]
```

### Keybindings

**Input state (default on focus)**

| Key | Action |
|-----|--------|
| Any printable char | Inserted at cursor position |
| `Enter` | Submit prompt |
| `Shift+Enter` | Insert newline (multi-line prompt) |
| `Up` (empty input) | Recall previous sent prompt |
| `Down` (empty input) | Recall next prompt in history |
| `Ctrl+C` | Abort running turn; clear input if idle |
| `Ctrl+W` | Delete word before cursor in input |
| `Cmd+V` / `Ctrl+V` | Paste from clipboard |
| `Backspace` / `Delete` | Delete character |
| `Left` / `Right` | Move cursor |
| `Home` / `End` / `Cmd+Left` / `Cmd+Right` | Jump to start/end of input |
| `Page Up` / `Ctrl+U` | Scroll message list up half-page (stays in input state) |
| `Page Down` / `Ctrl+D` | Scroll message list down half-page (stays in input state) |
| `Escape` (empty input) | Enter scroll state |

**Shell command prefix**

| Input | Action |
|-------|--------|
| `!<command>` | Execute shell command directly in `projectDir` (e.g., `!ls -la`, `!git status`). Output displayed inline with 20-line cap. Uses `get_default_shell` + `run_command` IPC — combined stdout+stderr, non-zero exit shown as error. |

**Scroll state (Escape from empty input)**

| Key | Action |
|-----|--------|
| `j` / `Down` | Scroll down one line |
| `k` / `Up` | Scroll up one line |
| `Ctrl+D` / `Page Down` | Scroll down half-page |
| `Ctrl+U` / `Page Up` | Scroll up half-page |
| `g` | Scroll to top (oldest message) |
| `G` | Scroll to bottom (latest message) |
| `y` | Yank last assistant message to clipboard |
| `Y` | Yank full conversation to clipboard |
| `c` | Open dedicated context window (ContextView in separate compositor tab) |
| `q` | Close the agent tab |
| `Escape` / `i` | Return to input state |

### UI Structure

```
.agent-view                                    ← fills pane bounds, flex column
  .agent-view__messages                        ← flex-col, overflow-y: auto, flex: 1
    .agent-view__msg.agent-view__msg--user
      .agent-view__msg-label                   ← "YOU" (12px)
      .agent-view__msg-body                    ← plain text, preserves newlines
    .agent-view__msg.agent-view__msg--assistant
      .agent-view__msg-label                   ← "AI" (12px)
      .agent-view__msg-body                    ← streamed delta by delta
      .agent-view__stream-cursor               ← blinking "▋", removed on agent_end
    .agent-view__msg.agent-view__msg--shell     ← shell command (! prefix)
      .agent-view__msg-label--shell             ← "SH" green badge
      .agent-view__msg-body                     ← "$ <command>"
    .agent-view__shell-result                   ← output (20-line cap, pre-wrap)
    .agent-view__shell-result--error            ← red variant for non-zero exit
    .agent-view__tool-row                      ← tool execution row (13px)
      .agent-view__tool-icon                   ← spinning braille → "✓"/"✗"
      .agent-view__tool-name                   ← e.g. "bash"
      .agent-view__tool-args                   ← truncated args, dim
      .agent-view__tool-result                 ← output text, max 10 lines + "N more"
    .agent-view__error                         ← red error message (14px)
  .agent-view__state-hint                      ← scroll mode hint, visible only in scroll state
  .agent-view__input-row                       ← fixed at bottom, dimmed while running
    .agent-view__prompt-glyph                  ← "❯" or spinner glyph
    .agent-view__input-display                 ← manual text rendering with cursor
```

Font sizes: body 15px, labels 12px, tools/results 13px, errors 14px, hints 12px.

### Error Handling

- **No API key**: Inline error "ZAI_API_KEY not set" on first prompt
- **Agent init failure**: Inline error "Failed to initialize agent: ..."
- **API errors (429, CORS, etc.)**: Extracted from `agent_end` event's last message `errorMessage` field
- **Unexpected throws**: Caught in try/catch around `controller.prompt()`, displayed inline
- **Global errors**: `unhandledrejection` and `error` handlers route to `NotificationController`

## Edge Cases

| Case | Handling |
|------|----------|
| `ZAI_API_KEY` not set | Inline error on first prompt; does not crash |
| `Leader a` pressed again | Creates new agent tab (not singleton) |
| Agent aborted mid-stream | Partial message preserved; session persisted |
| Tool execution error | Tool row shows "✗"; agent sees error result and can recover |
| Tab closed while turn running | `dispose()` calls `abort()` first, then persists session |
| Scroll state entered mid-stream | Scrolling works; streaming continues uninterrupted |
| Paste (Cmd+V) | Reads clipboard via `navigator.clipboard.readText()`, inserts at cursor |
| No focused terminal (no CWD) | projectDir = null; no session persistence, tools use app CWD |
| Agent window in Focus layout | Treated identically to a terminal window |

## Not Yet Implemented

- `[agent]` TOML configuration section (model/provider/key currently hardcoded)
- `Cmd+N` new session keybinding
- `Ctrl+E` expand/collapse tool output
- Per-tool approve/reject gate
- ~~Skill system (custom instructions/workflows)~~ — implemented (see `docs/44-agent-skill-auto-detection.md`); also supports `.claude/commands/*.md` (Claude Code format)
- MCP tool integration
- Inline diff view for file edits
- Agent-initiated compositor actions

## Resources

- [pi-mono GitHub](https://github.com/badlogic/pi-mono) — Agent class API, AgentEvent union, tool schema format
- [@mariozechner/pi-agent-core npm](https://www.npmjs.com/package/@mariozechner/pi-agent-core) — install, changelog
- [@sinclair/typebox](https://github.com/sinclairzx81/typebox) — TypeBox schema library used for tool parameter definitions
- [pi-agent-core source](https://github.com/badlogic/pi-mono/tree/main/packages/pi-agent-core/src) — Agent constructor, public methods, full AgentEvent type union

---

## Agent Markdown Visual Effects

Futuristic visual effects applied to AI agent markdown responses, giving the agent view a cyberpunk HUD aesthetic. All effects are pure CSS in `src/styles/agent.css` — no JavaScript changes required. They use GPU-friendly properties (`transform`, `opacity`, `filter`) and respect `--krypton-window-accent-rgb`.

### Effects Summary

| Element | Effect | Details |
|---------|--------|---------|
| Assistant message | Scanline overlay + materialize animation | Horizontal lines every 4px at 1.2% accent opacity; 0.3s fade-in with 4px slide + blur |
| Message label | Flicker animation | 4s cycle with micro-opacity dips — digital interference |
| Headings (h1–h4) | Neon glow pulse | 3s breathing cycle between two `text-shadow` glow intensities |
| H1 | Gradient wash | Subtle accent-colored background fading right, with bottom border |
| Code blocks (`pre`) | Animated edge sweep + inner glow | 1px gradient line sweeps top edge in 4s loop; inset 30px soft glow |
| Inline code | Neon text-shadow | 6px accent glow at 15% opacity |
| Blockquotes | Holographic shimmer | Translucent highlight sweeps across surface on 6s loop |
| Horizontal rules | Traveling pulse | 30px glowing dot slides left-to-right in 3s |
| Tables | Row hover highlight + header glow | Rows light up on hover; neon glow on header text |
| Lists | Custom bullets | Glowing cyan `▸` arrow markers |
| Links | Hover glow | Text-shadow intensifies, color brightens on hover |
| Bold | Subtle glow | 4px foreground-color text-shadow |
| Italic | Accent color | Uses accent color at 70% opacity |

### Performance

- All animations use `transform`, `opacity`, or `background-position` — composited on GPU
- Pseudo-element overlays use `pointer-events: none`
- Scanline repeating-gradient is static (no animation), very cheap to render
