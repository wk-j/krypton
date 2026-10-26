# Inline AI on an ACP Backend — Implementation Spec

> Status: Implemented
> Date: 2026-10-26
> Milestone: M8 — Polish
> Amends: [0050](./0050-inline-ai.md) (model transport only; keys, modes and overlay UI unchanged)

## Problem

Inline AI (`Cmd+K` in a terminal pane) runs on `AgentController`, which calls a vendor API with a key
from `[agent]` (default: Z.AI `glm-4.7`, `ZAI_API_KEY`). The user already pays for agent CLIs
(Claude Code, Codex, OMP) and does not want a second, separately billed API subscription only for
this overlay.

## Solution

Inline AI sends its prompts to an **ACP backend subprocess** instead of `AgentController`, the
same path the Harness lanes and the assist sidecar (spec 306) already use. The backend CLI's own
login is the credential, so no API key is needed. A new `[inline_ai]` table picks the backend,
model and agent-side session mode (default `claude` / `haiku` / `default`).

One warm process is kept per backend + pane cwd. Every `Cmd+K` opens a fresh ACP session on it, so
history from an earlier query never leaks into the next one. Follow-up questions inside one overlay
share that session, as they share one `AgentController` today. The session is fenced like the assist
sidecar: no MCP servers, every permission request declined, every file write refused, every question
cancelled. The session is also switched to the backend's asking mode (`default` for Claude), so a
user default that approves on its own cannot run state-changing commands past the fence. The
overlay's keys, modes and look do not change.

## Research

- **Inline AI today** (`src/inline-ai.ts`, `compositor.ts:5051-5089`):
  - `openInlineAI()` builds a disposable `AgentController` per overlay. `submit()` calls
    `setInlineSystemPrompt()` and sends `Working directory: <cwd>\n\n<query>` as the prompt.
  - The overlay renders `message_update` deltas and shows `Running <tool>…` on `tool_start`. It
    resets the text after a tool round, then finishes on `agent_end`.
  - The terminal-output context promised in 0050's data flow (step 7) was never implemented.
- **Today's inline bash is unapproved.**
  - The inline controller gets no `BashApprovalHandler` or `WriteApprovalHandler`.
  - `tools.ts:319` only asks for approval `if (bashApproval && …)`, so with no handler every
    `bash` call (including `kill`, `rm`, `git push`) runs through `run_command` without a prompt.
  - The fence below is stricter than today, not looser.
- **`AgentController` stays.** The Agent window (`agent-view.ts:236`), File Manager AI
  (`file-manager-ai.ts:102`) and Markdown AI (`markdown-view-ai.ts:89`) also construct it, and the
  last two use `setInlineSystemPrompt`. Only `inline-ai.ts` stops using it, so `agent.ts` and
  `[agent]` are untouched.
- **Headless ACP already works.**
  - `AcpAssistSession` (`src/acp/assist/acp-completion.ts`) does spawn(`mcpServers: []`) →
    `initializeOnly()` → `sessionNew()` → `setLaneModel()` → `prompt()`.
  - It also fences permission, write and question requests, so a request nobody answers cannot
    park `session/prompt` forever.
  - Spec 306 measured a ≈2.5 s cold start for `claude-agent-acp`.
  - It cannot be reused as is: it returns only the final text (Inline AI streams), and it keeps
    one session forever (Inline AI needs a fresh session per `Cmd+K`).
- **Several sessions on one process is normal ACP.**
  - Zed keeps one agent-server connection with a `sessions: HashMap<SessionId, AcpSession>` and
    calls `new_session` on it for every new thread (`crates/agent_servers/src/acp.rs:322, 1637`).
  - Krypton's `acp_session_new` overwrites the client's single `acp_session_id`
    (`acp.rs:2229`). Every later `acp_prompt` / `acp_cancel` reads that id, so a fresh session
    can replace the old one on a warm process.
  - Nothing in Krypton had called `session/new` twice on one process before; `#new` respawns
    (0072). Verified against `claude-agent-acp`: a second `session/new` on the same process
    returns a distinct session id, and that session cannot see the first one's history.
- **The session cwd is fixed at spawn.**
  - `acp_session_new` sends `client.cwd` (`acp.rs:2210`), and `validate_fs_path` scopes
    `fs/read_text_file` to that root (`acp.rs:1001-1053`).
  - A pane in a different directory therefore needs its own process. A per-session cwd would
    require Rust changes to the fs scope, so this spec avoids it.
- **Context gathering survives the fence on the default backend.**
  - Claude Code runs a built-in set of read-only Bash commands (`ls`, `cat`, `grep`, `find`,
    `wc`, `diff`, `du`, read-only `git`, …) without a permission prompt in every mode.
  - So "commit changes" can still read `git diff --stat`, while state-changing commands raise a
    permission request that the fence declines.
- **The user's own default mode decides whether the fence ever sees a request** (found during
  implementation).
  - `session/new` on `claude-agent-acp` reports the session mode from the user's
    `~/.claude/settings.json`. On the dev machine that is `defaultMode = "auto"`. In that mode a
    prompt asking to `touch /tmp/…` ran the command with **no** `session/request_permission`, and
    the file was created.
  - After `session/set_mode {modeId: "default"}` on the same kind of session, `git log` still ran
    unprompted, `touch` raised a permission request, the fence declined it, and no file was
    created.
  - Krypton had no command for `session/set_mode` (harness permission modes are client-side
    auto-answers, spec 147), so this spec adds `acp_set_session_mode`.
  - Claude advertises its model as a `configOptions` entry (`category: "model"`), not `models`,
    so `session/set_model` is "Method not found". `acp_set_lane_model` already picks
    `session/set_config_option` from the `session/new` response, so `model = "haiku"` works
    through it.
- **Alternatives rejected.**
  - (a) Keep `AgentController` and point `[agent]` at Anthropic: still needs an API key billed
    apart from the subscription — the thing the user wants gone.
  - (b) Reuse `[acp_harness.assist]`: different feature, default `off`, deadline-and-breaker
    semantics meant for unattended calls.
  - (c) Route through a Harness lane: needs an open harness, pollutes a lane transcript, blocks the
    lane.
  - (d) Spawn per `Cmd+K`: ≈2.5 s cold start on every query.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Warp | Agent features meter Warp AI credits. BYOK routes to your own Anthropic/OpenAI/Google API key. A ChatGPT subscription can power the local agent, but "You can't connect a Claude consumer subscription to the Warp Agent" | The exact gap here: subscription-backed inline AI |
| Zed | Terminal inline assist on `ctrl-enter` uses `LanguageModelRegistry::inline_assistant_model()` (an API-key or Zed-account provider). The prompt carries shell, cwd and the last 50 non-empty lines, with no tools. ACP external agents (Claude Code etc.) appear only in the Agent Panel | Zed does not offer subscription-backed terminal inline assist either |
| iTerm2 | AI command generation needs the user's own OpenAI API key | Same key requirement |

**Krypton delta** — none of these let a CLI subscription drive the terminal inline prompt. Krypton
can, because it already speaks ACP to those CLIs. Keys and UX stay as they are (`Cmd+K`, `Tab`
cmd/ask, `↵` insert, `⇧↵` run).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/headless-fence.ts` | **New.** `answerFencedRequest(client, event): boolean` — the permission/write/question fence moved out of `acp-completion.ts` so both headless callers share it |
| `src/acp/assist/acp-completion.ts` | Use `answerFencedRequest`; no behaviour change |
| `src/inline-ai-session.ts` | **New.** `InlineAcpSession` + `InlineAcpConversation` (below) |
| `src/inline-ai-session.test.ts` | **New.** Lifecycle tests against a fake `AcpClient` |
| `src/inline-ai.ts` | Drop `AgentController`; take an `InlineAcpConversation`; map its events; rewrite both instruction blocks for a fenced backend |
| `src/compositor.ts` | Own one `InlineAcpSession`; keep `config.inline_ai` from `applyConfig`; `openInlineAI()` opens a conversation for the pane cwd |
| `src/config.ts` | `InlineAiConfig { backend; model; mode }`; `KryptonConfig.inline_ai` |
| `src-tauri/src/config.rs` | `InlineAiConfig` with `#[serde(default)]`, defaults `claude` / `haiku` / `default`; parse test |
| `src-tauri/src/acp.rs`, `src-tauri/src/lib.rs` | **New command** `acp_set_session_mode(session, mode_id)` → `session/set_mode` on the live session, 10 s timeout; a timeout is an error |
| `src/acp/client.ts` | `setSessionMode(modeId)` wrapper |
| `docs/0050-inline-ai.md`, `docs/0006-configuration.md`, `docs/README.md` | Amended-by note; `[inline_ai]` reference; index row |

## Design

### Data Structures

```ts
// src/config.ts
export interface InlineAiConfig { backend: string; model: string; mode: string }

// src/inline-ai-session.ts
export type InlineTurnEvent =
  | { type: 'status'; text: string }   // 'Starting claude…', 'Thinking…'
  | { type: 'tool'; title: string }    // ACP tool_call → spinner 'Running <title>…'
  | { type: 'chunk'; text: string };   // agent_message_chunk text

export class InlineAiError extends Error {}  // message is shown verbatim in the overlay

export class InlineAcpSession {
  // fake spawn and a short cancel grace in tests
  constructor(deps?: { spawn?: InlineAcpSpawn; graceMs?: number });
  /** Called on Cmd+K. Supersedes the previous conversation, starts (or reuses) the
   *  process for backend+cwd, then opens a fresh session in the background. Returns at once. */
  open(cfg: InlineAiConfig, cwd: string | null): InlineAcpConversation;
}

export interface InlineAcpConversation {
  /** One turn. Resolves on end_turn; rejects with InlineAiError otherwise. */
  prompt(text: string, onEvent: (e: InlineTurnEvent) => void): Promise<void>;
  /** Escape/close: session/cancel if a turn runs; later events are dropped. */
  close(): void;
}
```

### Rules

1. **Process key = `backend\0cwd`.** A matching warm client is reused. A mismatch disposes it and
   spawns `AcpClient.spawn(backend, cwd, [])` → `initializeOnly()`.
2. **Session per conversation.** `open()` chains `sessionNew()`, then `setLaneModel(model)` when
   `model !== ''`, then `setSessionMode(mode)` when `mode !== ''`. Both are per session, so an
   edit takes effect on the next `Cmd+K` without a respawn.
3. **One turn at a time per process.** Setup and turns run through one serial queue, so a
   conversation's `sessionNew()` waits for the previous conversation's last `prompt()` to settle
   (including a cancelled one). A late chunk from a cancelled turn therefore cannot land in the next
   overlay, and the single `acp_session_id` is never swapped under a running turn. A conversation
   closed before its setup ran never spawns or opens a session.
4. **Listener per turn.** `prompt()` attaches `onEvent` and removes it when `session/prompt`
   settles. After `close()` nothing is delivered. `thought_chunk` is ignored.
5. **Fence.** `answerFencedRequest` declines `permission_request`, refuses `fs_write_pending`, and
   answers `ask_user_question` / `elicitation_request` with `session/cancel`. Its listener lives as
   long as the process, so a request raised after a turn settled is still answered.
6. **Death.** A `stop` event carrying `reason` drops the client, and the next `open()` respawns.
7. **Cancel grace.** `close()` mid-turn sends `session/cancel`. If the turn has not settled 5 s
   later (`CANCEL_GRACE_MS`), the process is killed, so the next `Cmd+K` is not stuck behind an
   agent that ignores the cancel.

### Data Flow

```
1. Cmd+K in a terminal pane → InputRouter → compositor.openInlineAI()
2. compositor: cwd = get_pty_cwd(pane); conv = inlineSession.open(config.inline_ai, cwd)
   → spawn/initialize (cold) or reuse, then session/new + model + mode — while the user types
3. Enter → overlay.submit(): text = <mode instructions> + "Working directory: <cwd>" + <query>
   → conv.prompt(text, onEvent); spinner shows 'Starting claude…' until the session is ready
4. ACP session/update → AcpClient event → conv maps it to InlineTurnEvent:
   chunk → append + render (cmd: parseResponse; ask: markdown)
   tool  → clear partial text, spinner 'Running <title>…' (today's tool_start behaviour)
5. session/prompt resolves end_turn → overlay.onComplete() (unchanged reveal + hints)
6. ↵ / ⇧↵ / Tab / ⌘C / Esc behave as today; Esc → conv.close() → session/cancel
```

### Prompt Text

ACP has no system-prompt field, so every prompt starts with the mode's instructions:

- **cmd:** "Output ONE shell command for the request and nothing else. You may run read-only
  commands (git status/diff/log, ls, cat, grep, find) to gather context first. Never run anything
  that changes state; such calls are refused." The output format stays the same: line 1 is the
  command, optional line 2 is `# explanation`, no markdown, fences or prose.
- **ask:** the current ask text, with "use the bash tool" replaced by the same read-only sentence.

### Configuration

```toml
[inline_ai]
backend = "claude"   # ACP backend id (same ids as the Harness backend picker)
model = "haiku"      # applied after session/new; "" keeps the backend default
mode = "default"     # session/set_mode after session/new; "" keeps the backend's own mode
```

`[agent]` is no longer read by Inline AI; it still drives the Agent window, File Manager AI and
Markdown AI.

### UI Changes

None to DOM or CSS. Only the spinner text sources change (`Starting <backend>…`, `Thinking…`,
`Running <title>…`). Errors reuse the existing error line.

## Edge Cases

- **Backend missing or not logged in:** spawn or `session/new` fails → `inline AI: "claude" did not
  start — <reason>`; the next `Cmd+K` retries.
- **Model or mode rejected** (backends with no model state, e.g. `omp`, `cursor`; backends whose
  mode ids differ, e.g. `codex`): `setLaneModel` / `setSessionMode` throws → `inline AI: "omp"
  rejected model "haiku" — set [inline_ai] model = ""` (or the same for `mode`). The process is
  kept; every `Cmd+K` fails the same way until the config is edited.
- **Backend that never asks:** with `mode = ""`, or a backend that runs tools without
  `request_permission`, the fence only sees requests that are sent. This is still stricter than
  before this spec, where every inline bash call ran unapproved.
- **Pane cwd changed since the last `Cmd+K`:** the process is respawned. The cold start overlaps
  typing because it begins at overlay open.
- **Unknown cwd** (`get_pty_cwd` fails): `cwd = null`; Rust uses its existing fallback (the Krypton
  process cwd), the same as a harness spawned without a project dir.
- **Escape, then `Cmd+K` at once:** the new conversation waits for the cancelled turn to settle
  (rule 3), or for the 5 s grace (rule 7); the spinner shows `Starting…` meanwhile.
- **Config hot reload:** the backend change is applied on the next `Cmd+K` (key mismatch →
  respawn), model and mode changes on the next session. The overlay that is open keeps its session.
- **Process memory:** one warm backend process (Node, for `claude-agent-acp`) lives until the key
  changes or the app exits. No idle reaper (see Out of Scope).
- **Claude Code hooks (0030):** if the user installed Krypton's hook snippet, the inline session
  posts hook events too, and the server routes them to the pane whose cwd matches. Accepted: the
  events describe real work in that directory.
- **Per-query cost:** the backend loads its own system prompt, tools and the project's
  `CLAUDE.md`/`AGENTS.md` for each session. Measured on this repo with `haiku`: about 65–99K
  tokens per query, most of them cache reads. That is far more input than the old raw API call,
  and it spends subscription quota.

## Tests

`src/inline-ai-session.test.ts`, against a fake `AcpClient`:

- two `open()` calls with the same backend and cwd → one spawn, two `sessionNew`, model and mode
  applied to each;
- follow-ups inside one conversation reuse its session;
- a cwd or backend change → dispose + respawn;
- model and mode are skipped when `''`;
- an overlay closed before setup ran never spawns;
- chunks and tool titles stream after the `Starting` and `Thinking` statuses; `thought_chunk` is dropped;
- the fence answers each request type, including one raised after the turn settled;
- `close()` mid-turn → `cancel`, and the next `sessionNew` waits until the cancelled `prompt`
  settles; a late chunk is not delivered;
- a cancelled turn that never settles → process killed after the grace (fake timers), next
  `Cmd+K` respawns;
- a spawn failure gives an error that names the backend; a rejected mode keeps the process;
- `stop` with `reason` → the next `open()` respawns.

`acp-completion.test.ts` stays green unchanged, which proves the fence extraction changed nothing.
The Rust test parses `[inline_ai]` and the defaults.

## Implementation Notes

**Deviation from the approved draft: `mode` and `acp_set_session_mode`.** The draft accepted "a
backend that never asks" as a residual risk. The measurement in Research showed that on the
user's actual configuration (`defaultMode = "auto"`) this was the normal case, not an edge: the
fence would never have seen a `touch`. The fence exists to keep Inline AI from changing state, so
`[inline_ai] mode` (default `"default"`) and the Rust command were added. `mode = ""` restores the
draft's behaviour.

**Draft API trimmed.** `InlineAcpSession.dispose()` was dropped: nothing would call it. The
compositor keeps one session for the app's lifetime, and Rust kills ACP children on exit.

## Verification

- `npm run check`; `npx vitest run`: 233 files, 2958 tests; `cargo fmt -- --check`; `cargo test
  --lib inline_ai`. `cargo clippy --all-targets` reports one warning, `bool_assert_comparison` in a
  timeline test this spec does not touch.
- **Protocol smoke** (stdio JSON-RPC to `npx -y @agentclientprotocol/claude-agent-acp@latest`):
  - `initialize` took 1.2 s and `session/new` 0.6 s.
  - A second `session/new` on the same process was distinct and had no memory of the first.
  - `session/set_config_option model=haiku` ran the turn on `claude-haiku-5-5`.
  - The `auto` vs `default` mode result is in Research.
- **Overlay smoke** (throwaway, deleted after the run): a happy-dom test drove the real
  `InlineAIOverlay` + `InlineAcpSession` against that adapter through a stdio shim that stands in
  for the Tauri IPC layer.
  - `commit changes` took 8.3 s, including the cold start. The backend read the diff with a
    `Terminal` tool call and returned a `git add … && git commit -m "feat(inline-ai): … (spec 333)"`
    command, which `↵` wrote to the PTY callback without a newline.
  - `create an empty file at /tmp/…` took 3.5 s and returned `touch /tmp/…`; the file was not
    created.
  - `Esc` mid-turn sent `session/cancel`. The next `Cmd+K` (`list markdown files under docs`)
    answered `find docs -name '*.md'` in 2.6 s.
  - The four conversations used one spawned process.
- **Not exercised:** the Tauri IPC layer inside the running app. WKWebView cannot be driven from
  here, and launching a dev instance would take over the user's screen. The Rust side is
  `acp_set_session_mode` (new, mirrors `acp_set_lane_model`) and the existing spawn, session and
  model commands.

## Out of Scope

- The Agent window, File Manager AI and Markdown AI keep `AgentController` + `[agent]`. They could
  move the same way in a later spec.
- Sending terminal output (last N lines) as context. 0050 promised it but it was never built;
  [0334](./0334-inline-ai-terminal-context.md) now does it.
- Per-session cwd on one process (needs Rust fs-scope changes).
- An idle timeout for the warm process.
- Choosing the backend from inside the overlay.
- SSH and remote panes: the backend runs locally in the cwd that `get_pty_cwd` reports, as
  today's local bash does.

## Resources

- [Claude Code — Configure permissions: read-only commands](https://code.claude.com/docs/en/permissions) — read-only Bash runs without a prompt in every mode; basis for "context gathering survives the fence".
- [Warp — Bring Your Own API Key](https://docs.warp.dev/agent-platform/inference/bring-your-own-api-key.md) and [Agents FAQ](https://docs.warp.dev/agents/getting-started/faqs) — credits/BYOK model; no Claude-subscription path.
- [Warp vs iTerm2](https://www.warp.dev/compare-terminal-tools/iterm2-vs-warp) — iTerm2 AI requires the user's own OpenAI key.
- Zed source: `crates/agent_ui/src/terminal_inline_assistant.rs:37, 216-283` (model registry, 50-line context, no tools); `assets/keymaps/default-macos.json:1365` (`ctrl-enter`); `crates/agent_servers/src/acp.rs:322, 1637` (many sessions per connection).
- Internal: specs 0050, 0306, 0030, 0126; `src/acp/assist/acp-completion.ts`; `src-tauri/src/acp.rs:1001-1053, 2199-2251`; `src/agent/tools.ts:310-340`.
