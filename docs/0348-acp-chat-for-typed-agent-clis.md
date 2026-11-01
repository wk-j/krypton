# ACP Chat for Typed Agent CLIs — Implementation Spec

> Status: Draft
> Date: 2026-10-31
> Milestone: M8 — Polish

## Problem

Typing `claude` or `codex` in a Krypton shell runs the agent's own TUI. Tern can instead open
the agent as a native chat drawn by the terminal. Krypton's only ACP chat is the ACP Harness,
which is a multi-lane workspace and too heavy for "type `claude`, get a chat". This feature must
work **without** the Harness.

## Solution

When `[acp_chat] intercept = true`, Krypton injects a small shell function for each configured
CLI into fish and zsh panes. A bare interactive `claude` prints a private escape sequence,
`OSC 7338`, that carries a per-pane secret token. The PTY reader in Rust checks the token and
emits `acp-chat-request`. The compositor then opens an **ACP Chat** tab next to the shell. ACP
Chat is a new single-agent, single-session content view in `src/acp-chat/`. It uses the shared
ACP transport (`acp.rs`, `AcpClient`) with no Harness state, MCP servers, policy or lane model,
so the agent runs on its own settings, the same way the CLI does. Any other invocation
(arguments, pipes, `command claude`) runs the real CLI.

## Research

- **How Tern does it** (checked on this machine, Tern 0.9.8; the settings struct and shell
  scripts are embedded in the binary as text):
  - `settings.json` `agents.auto_acp` sets `TERN_ACP=<tern exe>` in new panes.
  - Its zsh, bash, fish, pwsh and xonsh integration defines `claude`, `codex` and `copilot` as
    `command "$TERN_ACP" acp "--typed=$cli" "$@"`. It skips a CLI the user already defined as a
    function or alias.
  - The chat runs `@agentclientprotocol/claude-agent-acp` (0.99.1 installed under
    `~/Library/Application Support/Tern/agents/claude`).
  - `keep_tui` lists agents that keep their TUI. `own_tools` lists agents that use their own
    file and terminal tools instead of Tern's.
- **Adapter config surface.** I spawned the installed adapter and sent
  `initialize` + `session/new`. The response has `modes` and `configOptions`:
  - `mode` (category `mode`): `default|acceptEdits|plan|auto|bypassPermissions`, current `auto`
    (from `~/.claude/settings.json`)
  - `model` (`model`): `default|opus|sonnet|haiku|…`
  - `effort` (`thought_level`): `default|low|medium|high|xhigh|max`
  - `fast` (`model_config`): `on|off`

  `initialize` returns `agentInfo {name, title, version: "0.99.1"}`. These are the
  "Default / Xhigh / Auto" chips in Tern's composer.
- **Shell injection, verified with throwaway scripts on fish 4 and zsh 5.9 (macOS):**
  - fish: put `<dir>/fish/vendor_conf.d/*.fish` first in `XDG_DATA_DIRS`. The script removes
    its dir from `XDG_DATA_DIRS` (as kitty does) and keeps the token in a non-exported global.
    A user's `~/.config/fish/functions/<cli>.fish` wins (`functions -q` autoloads it), and
    `command -s claude` still finds the real binary.
  - zsh: set `ZDOTDIR=<dir>/zsh`. Our `.zshenv` restores the original `ZDOTDIR`, sources the
    user's `.zshenv`, then defines the functions. The user's `.zshrc` still loads, and a
    function from the user's `.zshenv` wins.
  - Both: a bare `claude` emitted `ESC]7338;token=…;cli=claude BEL`, `claude --version` reached
    the real CLI, and the token was absent from the child `env`.
- **Krypton today:**
  - No shell script is injected (specs 0284, 0334). `pty.rs:392-408` sets only the login env,
    `TERM`, `COLORTERM`, `LANG` and `LC_ALL`, and `spawn_pty` has no per-pane env.
  - The PTY reader already scans raw bytes for `OSC 9;4` (`OscProgressParser`, `pty.rs:150`) and
    emits `pty-progress`. This spec adds a second scanner in the same loop.
  - `AcpClient` (`src/acp/client.ts`) is already used without the Harness by inline AI
    (`inline-ai-session.ts:64`) and assist (`acp/assist/acp-completion.ts`).
  - Transport gaps that are generic, not Harness-only:
    - `config_option_update` is dropped (`acp.rs:1701-1706`).
    - `configOptions` from `session/new` never reach the frontend.
    - There is no `acp_set_config_option`.
    - Every spawn applies `[acp_harness.lane_models.<backend>].active` (`acp.rs:1898-1907`).
    - Every spawn advertises client `fs.writeTextFile` (and `readTextFile` except for grok/omp),
      so writes park in `fs_write_pending` until the UI answers.
- **Alternatives ruled out:**
  - *Open the Harness* (my first proposal): it keeps the multi-lane workspace, closes the shell
    tab (`mountAcpHarnessView`), and makes the feature depend on the Harness.
  - *PATH shim binary*: user rc files prepend `~/.local/bin`, so the real CLI shadows the shim.
  - *Frontend xterm OSC handler*: the token would have to live in the frontend, and a WebContent
    reload gives the pane a new `viewId`. In the Rust reader the token never leaves the backend.
  - *Control API + `curl`*: needs a bearer token and a running loopback server. The OSC path is
    already pane-scoped.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Tern | `auto_acp` wraps `claude`/`codex`/`copilot` in shell functions that call `tern acp --typed=<cli>`. Native chat with mode/model/effort chips. `keep_tui` and `own_tools` per agent | Same UX target. Off by default (`auto_acp: false`) |
| kitty | Injects through `ZDOTDIR` (zsh), `XDG_DATA_DIRS` vendor_conf.d (fish) and `ENV` in POSIX mode (bash). Wraps `sudo`/`run0` only if they are not already functions | Injection technique adopted for fish and zsh |
| Ghostty | Same injection model. Optionally wraps `ssh`/`sudo`. A `ZDOTDIR` set in `/etc/zshenv` defeats it | Adopted the "a user definition wins" rule |
| claude-agent-acp | Exposes mode/model/effort/fast as ACP `configOptions` and expects `session/set_config_option` | We render them generically |

**Krypton delta:**
- Matches Tern's trigger (type the CLI name) and its escape (`command claude`).
- Diverges in three places:
  - Only bare invocations are intercepted.
  - The chat opens as a tab beside the shell, so the shell and its scrollback survive.
  - A per-pane token guards the trigger, because Krypton reads it from pane output and does
    not spawn a helper process.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp_chat_shell.rs` (new) | `ShellKind` detection, integration env builder, script install, `OscAgentCliParser`, token generation |
| `src-tauri/shell-integration/fish/krypton-acp-chat.fish`, `src-tauri/shell-integration/zsh/zshenv.zsh` (new) | Shell functions, embedded with `include_str!` |
| `src-tauri/src/pty.rs` | `spawn` takes `extra_env` and `chat: Option<ChatScan>`. The reader feeds the parser and emits `acp-chat-request` |
| `src-tauri/src/commands.rs` | `spawn_pty` builds the integration env from live `[acp_chat]` and the resolved shell |
| `src-tauri/src/config.rs` | `[acp_chat]` section (Rust only; the frontend never reads it) |
| `src-tauri/src/acp.rs`, `src-tauri/src/lib.rs` | `acp_spawn` gains `apply_lane_model` and `client_fs`. Forward `config_option_update`. `configOptions`/`agentInfo` in session/init info. New `acp_set_config_option`. Install scripts at setup |
| `src/acp/client.ts`, `src/acp/types.ts` | Spawn options, `setConfigOption`, `SessionConfigOption` types, `config_options` event |
| `src/acp-chat/` (new) | `acp-chat-view.ts`, `chat-session.ts`, `chat-model.ts` (+ test), `components/` (rows, permission card, config bar, picker, composer), `acp-chat.css` |
| `src/types.ts` | `PaneContentType` adds `'acp_chat'` |
| `src/compositor.ts` | `openAcpChat`, `acp-chat-request` listener, `createContentTab` gains an `afterTabId` placement |
| `src/command-palette.ts` | `acp-chat.open.claude` and `acp-chat.open.codex` |
| `docs/0004`, `0005`, `0006`, `0346`, `README.md`; amendment notes in `0284`, `0334` | Architecture, flow, config, OSC 7338 row, "Krypton now injects a script when `intercept` is on" |

## Design

### Independence boundary

`src/acp-chat/` may import only these from `src/acp/`:
- the transport: `client.ts`, `types.ts`
- pure helpers: `harness-markdown.ts` (sanitized markdown), `harness-tool-render.ts`
  (`buildToolPayload`, `mergeToolCall`), `harness-permission-scan.ts` (`permissionArgsPreview`)
- type-only imports from `harness-view-types.ts` (`ToolPayload`), which are erased at build time

None of these modules holds Harness state. `harness-tool-render.ts` also loads its own pure
helpers (`harness-tool-retention`, `harness-format`, `cell-grid`, `acp-harness-memory`'s
`extractModifiedPath`) and `src/agent/tools.ts` (for `classifyBashCommand`).

It does **not** import `acp-harness-view.ts`, `src/acp/components/**` or any Harness state, and
it does not register in the harness directory, peering, memory, lessons, rails or the hook
server. Its rows and styles are its own (`.krypton-acp-chat__*`).

### Data Structures

```rust
// config.rs — [acp_chat]
#[serde(default)] pub struct AcpChatConfig { pub intercept: bool /* false */, pub clis: Vec<String> /* ["claude","codex"] */ }
// acp_chat_shell.rs
pub enum ShellKind { Fish, Zsh }                                 // basename of the spawned program
const CLI_BACKENDS: [(&str, &str); 2] = [("claude", "claude"), ("codex", "codex")]; // cli → backend id
pub struct ChatScan { token: [u8; 16], clis: Vec<String> }       // moved into the reader thread
pub struct OscAgentCliParser { /* ESC ] 7338 ; … (BEL | ESC \), payload ≤ 128 bytes */ }
```

```ts
// src/acp/types.ts
export interface SessionConfigSelectOption { value: string; name: string; description?: string }
export interface SessionConfigSelectGroup { group: string; name: string; options: SessionConfigSelectOption[] }
export interface SessionConfigOption {
  id: string; name: string; description?: string; category?: string; type: string;
  currentValue: string | boolean; options?: Array<SessionConfigSelectOption | SessionConfigSelectGroup>;
}
// AcpEvent gains: { type: 'config_options'; options: SessionConfigOption[] }
export interface AcpSpawnOptions { applyLaneModel?: boolean; clientFs?: boolean } // both default true
// src/acp-chat/chat-model.ts — pure reducer over AcpEvent
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant' | 'thought'; id: string; text: string; sealed: boolean }
  | { kind: 'tool'; id: string; payload: ToolPayload }
  | { kind: 'plan'; id: string; entries: PlanEntry[] }
  | { kind: 'permission'; id: string; requestId: number; toolCall: ToolCall; options: PermissionOption[]; chosen: string | null | undefined }
  | { kind: 'notice'; id: string; tone: 'info' | 'error'; text: string };
export type ChatPhase = 'starting' | 'ready' | 'running' | 'failed';
```

### API / Commands

- `acp_spawn(…, apply_lane_model: Option<bool>, client_fs: Option<bool>)`. `None` keeps
  today's behaviour, so Harness, inline AI and assist do not change. ACP Chat passes
  `false, false`: no `[acp_harness.lane_models]` override, and `fs` capabilities are not
  advertised, so the agent uses its own file tools (Tern's `own_tools`).
- `acp_set_config_option(session: u64, config_id: String, value: Value) -> Result<Value, String>`
  sends `session/set_config_option` and returns the full `configOptions` array.
- `AgentSessionInfo.config_options: Option<Value>` (from new/resume/load) and
  `AgentInitInfo.agent_info: Option<Value>`.
- Event `acp-chat-request` `{ sessionId: u32, backendId: string }`. The token is never in the
  payload.
- `AcpClient.spawn(…, options: AcpSpawnOptions = {})` and
  `AcpClient.setConfigOption(id, value): Promise<SessionConfigOption[]>`.
- `Compositor.openAcpChat(backendId: string, cwd: string, placement?: { windowId: WindowId; afterTabId: string })`.

### Shell functions (fish shown; zsh is equivalent and was verified)

```fish
# vendor_conf.d/krypton-acp-chat.fish — remove our dir from XDG_DATA_DIRS (kitty pattern), then:
status is-interactive; or exit 0
set -g __krypton_chat_token $KRYPTON_CHAT_TOKEN; set -e KRYPTON_CHAT_TOKEN  # not inherited
for cli in (string split ' ' -- $KRYPTON_CHAT_CLIS)
    functions -q $cli; and continue                                         # user definition wins
    function $cli --inherit-variable cli
        if test (count $argv) -eq 0; and isatty stdin; and isatty stdout
            printf '\e]7338;token=%s;cli=%s\a' $__krypton_chat_token $cli; return 0
        end
        command $cli $argv
    end
end
set -e KRYPTON_CHAT_CLIS
```

The pane env is set only when `intercept` is on and the spawned program's basename is `fish`
or `zsh`. It contains `KRYPTON_CHAT_TOKEN` (32 hex chars from `getrandom`) and
`KRYPTON_CHAT_CLIS`, plus, for fish, `XDG_DATA_DIRS=<dir>:<original or /usr/local/share:/usr/share>`
and `KRYPTON_FISH_XDG_DATA_DIR`, or, for zsh, `ZDOTDIR=<dir>/zsh` and `KRYPTON_ORIG_ZDOTDIR`
(only when the original `ZDOTDIR` is set). `<dir>` is `app_data_dir()/shell-integration`.
Setup writes the embedded scripts there when their content differs.

### Data Flow

```
1. User types `claude` (no args) in a fish/zsh pane spawned with intercept on.
2. The shell function prints ESC]7338;token=<t>;cli=claude BEL and returns; the shell redraws its prompt.
3. pty.rs reader: OscAgentCliParser.feed(bytes). Token equal (constant-time) and cli in ChatScan.clis
   → emit acp-chat-request {sessionId, backendId:"claude"}. The bytes still go to pty-output;
   xterm.js ignores the unknown OSC.
4. Compositor listener: sessionMap.get(sessionId) → window/tab; cwd = get_pty_cwd(sessionId)
   (the shell's cwd, where the user typed) → openAcpChat("claude", cwd, {windowId, afterTabId}).
5. AcpChatView mounts in a new tab right after the shell tab and focuses the composer.
   ChatSession: AcpClient.spawn("claude", cwd, [], …, {applyLaneModel:false, clientFs:false})
   → initialize() (init + session/new) → config chips from configOptions, header from agentInfo.
6. Enter sends prompt(); session updates go through applyEvent() → rows (LiveComponent) on one
   RenderScheduler frame. stop → seal streaming rows → phase 'ready'.
7. permission_request → permission card; 1–9 answers it. Esc answers null (cancelled) and calls cancel().
8. Closing the tab: cancel() if running, then dispose(), which kills the adapter process group.
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Enter` / `Shift+Enter` | Composer, phase `ready` | Send / newline |
| `Esc` | Phase `running` | Decline an open permission, then `cancel()` the turn |
| `1`–`9` | Permission card open | Choose option *n* |
| `Shift+Tab` | Chat | Cycle the first `mode`-category option to its next value |
| `Alt+M` / `Alt+E` / `Alt+O` | Chat | Picker for `model` / `thought_level` / all select options (match `e.code`; Option changes `e.key` on macOS) |
| `↑` `↓` `Enter` `Esc` | Picker | Move / apply (`setConfigOption`) / close |
| `Alt+T` | Chat | Expand or collapse thought rows |
| `PageUp` / `PageDown` | Chat | Scroll the transcript |
| `Ctrl+R` | Phase `failed` | Respawn the agent with a new session |
| `Ctrl+D` | Composer empty, phase not `running` | Close the chat tab |
| Palette `ACP Chat: Claude here` / `Codex here` | Any | `openAcpChat` with the focused cwd |

### UI Changes

`.krypton-acp-chat` has three parts:
- a header with the backend name, `agentInfo.title` + version, and the cwd;
- the transcript, with user, assistant (sanitized markdown), thought (collapsed), tool
  (label, status, command line, and for edits the tool call's `diff` content as old/new line
  pairs drawn by the chat's own diff row, capped at 40 lines), plan,
  permission and notice rows;
- a composer box with config chips in the agent's order (mode, model, effort, fast) and a
  status line (`starting…`, `running`, `failed`).

Styles live in `@layer krypton.component` with `--krypton-*` tokens. Rows follow the
transcript rules in `AGENTS.md`: `readDeps()` lists exactly what `paint()` reads,
`seal()` is the only live→static path, and no `infinite` animation runs once a row is sealed.
No `backdrop-filter`, no corner brackets.

### Configuration

```toml
[acp_chat]
intercept = false              # inject the shell functions into new fish/zsh panes
clis = ["claude", "codex"]     # subset of: claude, codex (unknown names are dropped with a warning)
```

Reload Config applies to panes spawned afterwards. Running shells keep what they started with.

## Edge Cases

- **Arguments, pipes, non-TTY, `command claude`**: these run the real CLI. Use
  `command claude` when you want the TUI.
- **The user's own `claude` function or alias**: fish autoload, or zsh `.zshenv`, wins. A
  definition later in `config.fish`/`.zshrc` replaces ours.
- **`cat` of a file, or remote output, that contains OSC 7338**: the token does not match, so
  it is ignored with a `debug` log. Child processes never see the token in their env.
- **Sequence split across reads; BEL or `ESC \`; payload over 128 bytes**: the parser carries
  state between reads, accepts both terminators, and discards anything too long.
- **`ZDOTDIR` set in `/etc/zshenv`**, or bash, nushell, editor (`hx`) and `ssh` tabs: no
  injection, so the plain CLI runs.
- **A nested shell inside the pane** (e.g. `fish` inside tmux): the integration was cleaned
  from its env, so it gets no functions.
- **Quick Terminal session** (tracked as `qtSessionId`, never in `sessionMap`): hide the Quick
  Terminal and open the chat in the focused window. With no window, open a content window.
- **WebContent reload**: the token lives in the Rust reader thread and reattached panes are
  re-added to `sessionMap` (`compositor.ts:3037`), so typing `claude` keeps working afterwards.
- **First run of `npx` / login needed**: status `starting…`, using `acp.rs`'s 300 s
  init timeout. An init error becomes an error notice ("run `command claude` to sign in") and
  phase `failed`, where `Ctrl+R` retries.
- **Agent process dies**: the `stop` event with `reason` gives phase `failed` and a notice.
- **`ask_user_question` / `elicitation_request`**: answered with cancel, plus a notice. Forms
  are out of scope.
- **Any `fs_write_pending`** (should not happen with `clientFs:false`): rejected, with a notice.
- **The adapter sends no `configOptions`**: no chips. `Shift+Tab` and the picker do nothing.
- **Closing the shell tab first**: the chat is unaffected. When the chat closes, focus returns
  to the shell tab it was launched from if that tab still exists, otherwise to the neighbouring
  tab.

## Out of Scope

- Harness features in the chat: lanes, peering, memory, lessons, rails, reviews, timeline,
  GenUI, MCP servers.
- Intercepting invocations with arguments (`-p`, `-c`, `--resume`, a prompt argument), session
  history and resume, and steering while a turn runs.
- Slash-command autocomplete, `@` file mentions, image paste, usage meters and Program Status
  badges for the chat tab.
- bash, nushell and elvish injection, injection over SSH, and Windows shells.
- Restoring a chat after WebContent reload or app restart.

## Resources

- [Tern · Stencil](https://stencil.so/tern): product page (TSP vs ACP, agent blocks).
- [Tern Plugin SDK docs](https://docs.stencil.so/tern/): shell integration and spawn hooks
  context.
- [awesome-tern](https://github.com/theblazehen/awesome-tern): ecosystem references to Tern's
  ACP chats.
- Local Tern 0.9.8 install: `settings.json` `agents`, the embedded `AgentSettings` doc comments
  and zsh/fish wrapper scripts (via `strings`), and `agents/claude/package.json`.
- [kitty shell integration](https://sw.kovidgoyal.net/kitty/shell-integration/) and its
  [fish script](https://github.com/kovidgoyal/kitty/blob/master/shell-integration/fish/vendor_conf.d/kitty-shell-integration.fish):
  `ZDOTDIR` / `XDG_DATA_DIRS` injection and XDG cleanup.
- [Ghostty shell integration](https://ghostty.org/docs/features/shell-integration) and its
  [README](https://github.com/ghostty-org/ghostty/blob/main/src/shell-integration/README.md):
  the `ZDOTDIR` restore and the `/etc/zshenv` limitation.
- [ACP Session Config Options](https://agentclientprotocol.com/protocol/session-config-options):
  `configOptions`, categories, `session/set_config_option`, `config_option_update`.
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp): adapter
  capabilities. Local probe of 0.99.1 for the actual `configOptions`.
