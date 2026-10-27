# Inline AI Verify First, on the Pane's Machine — Implementation Spec

> Status: Implemented — sections 1, 3–6 (`host_exec` and its SSH fixes). Section 2 (syntax gate) is not implemented; it awaits a separate go-ahead.
> Date: 2026-10-26
> Milestone: Inline AI
> Builds on: 0333 (ACP backend, fence) · 0334 (terminal context) · 0335 (failure follow-up) · 0318 (read-only classifier) · 0247 (focused-SSH resolution)

## Problem

Inline AI is allowed to run read-only commands before it answers, but nothing makes it do so.
In a pane that is SSH'd into a server it cannot do so usefully: the agent runs on the Mac, so
its checks read the Mac.

**Requirement (user, 2026-10-26):** "when inline AI need to awnser complex question, is should
execute command multiple time to check awnser before compose question command it should work
like that" — and: "I also should work under ssh session as wll".

## Solution

1. **Verify first.** Both modes' instructions require the agent to check every fact its answer
   depends on with read-only commands before it answers.
2. **Krypton checks the syntax.** In cmd mode, Krypton parses the final command with the pane's
   shell (`<shell> -n`) on the pane's machine. A failure goes back to the same conversation for
   a fix, at most twice, before the overlay shows it.
3. **Checks run on the server in an SSH pane.** The agent stays on the Mac. Its session gets one
   Krypton-owned MCP tool, `host_exec`, that runs a read-only command on the pane's SSH host over
   a separate, non-PTY SSH channel. The spec 318 classifier gates it in Rust, and the inline fence
   approves only that exact tool. The header names the remote shell, host and cwd.
4. **SSH fixes the feature depends on.** The 0335 follow-up arms only when the shell in front
   sends OSC 133. `detect_ssh_session` stops returning a cached host after the pane reconnects
   elsewhere.

## Research

- **Today the agent decides, and often skips checking.** Probes ran `claude -p --model haiku
  --permission-mode default` at this repo with the real `INLINE_CMD_INSTRUCTIONS` and
  `shell: fish`:
  - "delete local branches merged into master": no command run; a generic pipeline answer.
  - "run vitest, then the rust tests": no command run in one run, one `grep package.json` in
    another.
  - With a verify-first rule added: 2 calls (`git branch --merged master`, `git branch`,
    `git worktree list`), giving `git branch -d feat/harness-ui-components`, the one merged
    branch, in 8.7 s. The tests request took 4 calls in 12.7 s, against 6.3 s without the rule.
- **The agent cannot check syntax itself.** `fish -n -c '…'` is not on Claude Code's read-only
  list. All 4 attempts were permission-denied in `-p`, and in Krypton the fence declines it
  (`headless-fence.ts:16-18`). Locally, `fish --no-config -n`, `bash --norc --noprofile -n`,
  `zsh -f -n` and `sh -n` parsed without executing (`touch` created nothing). Only fish rejected
  `npm test && (cd src-tauri && cargo test)` (exit 127).
- **SSH today.**
  - The backend spawns locally in the local shell's cwd (`pty.rs:522-531`).
  - `detect_ssh_session` parses the local `ssh` argv (`ssh.rs:79-104, 377-516`) and caches the
    result forever, because `remove_session` has no caller (`ssh.rs:217-221`).
  - `shell:` is the local `[shell] program` (`compositor.ts` `shellName`).
- **Pieces that exist.**
  - `read_only_script(command, cwd) -> Option<String>` (`computer_read_only.rs:18`) is pure and
    crate-visible. It returns a re-quoted POSIX script.
  - Connected Computers runs that script as `ssh -S <sock> -T -o BatchMode=yes <host> sh -s`, with
    the script on stdin, bounded output and a timeout (`connected_computers.rs:927-1032`). That
    makes it independent of the remote login shell.
  - Remote Harness resolves a focused SSH pane: `ssh -G`, borrowing a master after `-O check`, or
    owning one (`remote_harness.rs:1136-1240, 1325-1364, 495-526`). Those helpers are private.
- **The classifier excludes `git` on purpose** (0318:21, 93). Repository config can make read-only
  git run helpers (`core.fsmonitor`, diff drivers, clean filters). Inline checks run with no
  human, the same trust case, so it stays excluded.
- **MCP plumbing.**
  - `acp_session_new` sends the client's current `mcpServers` (`acp.rs:2211-2218`).
    `setMcpServers` can change them between sessions (`client.ts:150-159`).
  - The hook server answers HTTP MCP on 127.0.0.1 (`hook_server.rs:2848-2975, 10152`).
  - claude-agent-acp v0.95.0 shapes MCP permission requests as `title = mcp__<server>__<tool>`
    and `kind = "other"`, with `_meta.claudeCode = { toolName, mcpServer }`
    (`renderer.js:168-185`, `acp-agent.js:7816-7833`).
  - Claude defers MCP tools unless the descriptor's `_meta` carries `anthropic/alwaysLoad`
    (0289:127).
  - Whether mode `default` raises `request_permission` for an HTTP MCP tool is not recorded. The
    design works either way, because the Rust gate decides.
- **OSC 7.** fish 4.2.1 sends `OSC 7 file://<host>/<cwd>` on every cwd change (measured). The
  Rust cache keeps only the path and never clears it (`ssh.rs:177-214`).
- **Alternatives rejected.**
  - *Run the agent on the server* (0247 runtime): needs Node, the adapter and a `claude` login on
    every host, and a companion upload, for a 5-second question.
  - *Type check commands into the user's SSH shell:* corrupts shell state and mixes output
    (0247:40).
  - *Approve `Bash(ssh host …)`:* permission evidence would come from `rawInput`, which the
    pair-exact-identity rule forbids.
  - *Hardened git* (`-c core.fsmonitor=false --no-ext-diff …`): clean filters still run from
    `.gitattributes`.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Warp | In a Warpified SSH session the Agent "can execute commands on the remote machine on your behalf". Without the host-side SSH extension it "falls back to terminal commands (`cat`, `sed`, `grep`)" | Runs inside the user's session; full or extension-backed access |
| iTerm2 AI Chat | A chat linked to a session gets per-category permissions (Never / Ask / Always): *Run Commands*, *View Contents*, *Control Terminal* (keystrokes) | Approval per category; ssh integration exposes remote man pages |
| VS Code Remote-SSH | Workspace extensions and tools run in VS Code Server on the host | Requires installing a server on the host |

**Krypton delta**
- Nothing is installed on the host, and the user's shell is never typed into.
- The agent keeps the Mac's login.
- Server access is read-only by an app-owned classifier, and the channel is separate and
  non-PTY.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/ssh_channel.rs` | **New.** Extracted from `remote_harness.rs`: `SshTarget`, `focused_target` (identity check, `-i`/`-J` only), `apply_ssh_config` (`ssh -G`), `select_control_socket` (borrow after `-O check`, else own), `check_master`, `configured_ssh_command`. Remote Harness calls it; no behaviour change |
| `src-tauri/src/inline_remote.rs` | **New.** `InlineRemoteManager` (token registry; `open` = resolve, connect, probe; `tools_list`/`tools_call` = classifier + `sh -s`; `close`) and the Tauri commands `inline_remote_open` / `inline_remote_close` |
| `src-tauri/src/hook_server.rs` | `GET`/`POST /mcp/inline`; the harness handler's protocol negotiation and JSON-RPC reply moved into two shared functions |
| `src-tauri/src/remote_harness.rs`, `connected_computers.rs`, `lib.rs` | Use `ssh_channel`; `random_hex` is `pub(crate)`; register the module, state and commands |
| `src-tauri/src/ssh.rs` | `detect` re-parses when the cached `ssh` pid is gone or changed |
| `src-tauri/src/config.rs`, `src/config.ts` | `[inline_ai] remote_checks` (default `true`) |
| `src/inline-ai-remote.ts` + test | **New.** `openInlineRemote`/`closeInlineRemote`, the MCP server entry, the `<pane_host>` block, the label, `hostExecCommand` |
| `src/acp/headless-fence.ts` + test | `isExactMcpTool`; `answerFencedRequest(client, event, allow?)` approves only that identity, `allow_once` |
| `src/inline-ai-session.ts` + test | `open(cfg, cwd, mcp)`: `setMcpServers` before every `sessionNew`; fence allows `host_exec`; tool events carry its command |
| `src/inline-ai.ts` | Verify-first rule; `<pane_host>` preamble on the first turn; label; status `host $ cmd` |
| `src/compositor.ts`, `src/main.ts` | Latest OSC 7 per session; open the channel, close it with the conversation; follow-up arms only after an `A`; follow-up shell = pane shell |
| Docs | 0004, 0005, 0006; amended-by notes in 0050, 0247, 0333, 0334, 0335; `README.md` |

## Design

### 1. Verify-first rule (both modes, every pane)

Appended to `READ_ONLY_RULE`:

> Before you answer, check every fact the answer depends on — paths, file contents, names,
> scripts, ports, PIDs, services, installed tools — with read-only commands. Combine checks into
> one command where you can. Never guess something you can look up. If you could not check
> something, say so in the `#` comment (cmd) or the answer (ask).

### 2. Syntax gate (cmd mode)

After a turn's answer is parsed (`parseResponse`, plus `screenFix` for 0335 fixes), and only
when there is a command:

1. The spinner shows `Checking syntax…`. The command goes to `shell_syntax_check {shell, command}`
   (local pane) or `inline_remote_syntax_check {token, command}` (SSH pane).
   - Shells are fish (`--no-config -n -c`), bash (`--norc --noprofile -n -c`), zsh (`-f -n -c`),
     and sh/dash/ksh (`-n -c`).
   - Locally it runs argv-only with a 3 s timeout. Remotely the same argv is single-quoted into
     the `sh -s` script.
   - Any other shell, or no shell known, skips the gate.
2. **Pass:** show the result as today.
3. **Fail:** one more turn on the same conversation: `Your command does not parse in <shell>:
   <first 3 stderr lines>. Output a corrected command in the same format.` It goes back to step 1,
   at most 2 extra turns.
4. **Still failing:** show the command with `⚠ <shell> -n: <first stderr line>` in the error
   style. `↵`/`⇧↵` still work; the user decides.

### 3. Remote checks — Rust

```rust
pub struct InlineRemoteInfo {      // returned to the frontend
    token: String,                 // 32-byte random hex, the MCP capability
    display: String,               // "deploy@web-01" (ssh -G user + the probed `hostname -s`)
    shell: Option<String>,         // basename of the remote $SHELL
    cwd: Option<String>,           // the OSC 7 cwd, only if its host matches `hostname`
}
inline_remote_open(session_id: u32, osc7_host: Option<String>, osc7_cwd: Option<String>) -> Result<InlineRemoteInfo, String>
inline_remote_close(token: String)
inline_remote_syntax_check(token: String, command: String) -> Result<Option<String /*stderr*/>, String>  // section 2, not built
shell_syntax_check(shell: String, command: String) -> Result<Option<String>, String>                    // section 2, not built
```

- **`open`:**
  1. `SshManager::detect`, then `ssh_channel::resolve_focused` (identity validation, `ssh -G`).
  2. Borrow the pane's master after `-O check`; otherwise own one at
     `ssh-sockets/inline-<hash(dest,port)>` with `ControlPersist = [ssh] control_persist`.
  3. One probe script over `sh -s`: `basename "${SHELL:-sh}"; hostname -s`. Its errors carry ssh's
     stderr, e.g. a password-only host failing under `BatchMode=yes`.
- **`host_exec`:**
  1. Validate the token.
  2. `read_only_script(command, cwd)`. On `None`, return `isError` with "Not run: only Krypton's
     read-only commands run here (no git, globs, redirects, `$VAR`, `~`, `cd`). Put that step in
     your answer for the user."
  3. On a script, run it through `sh -s`: timeout default 15 s, max 30; at most 2 per host.
  4. Output keeps stdout and stderr with the exit code, the first and last 8 KiB of each, and a
     cut note.
- **`close`:** revoke the token and kill its running commands. An owned master is left to
  `ControlPersist`, so the next `Cmd+K` reuses it.

### 4. MCP endpoint and fence

- **Route.** `POST /mcp/inline` with the header `x-krypton-inline-capability: <token>`. It is
  outside `/mcp/harness/`, so no harness marker logic sees it.
  - `initialize` reports `serverInfo.name: "krypton_inline"`.
  - `tools/list` returns exactly `host_exec` `{command: string, timeoutSeconds?: 1..30}` with
    `_meta: {"anthropic/alwaysLoad": true}`. Its description names the host, cwd and the read-only
    limits.
- **Session.** `InlineAcpSession.open(cfg, cwd, mcp: Promise<AcpMcpServer[]>)`. `setup` awaits
  `mcp` and calls `client.setMcpServers(list)` before `sessionNew()`, every time, so a later
  local-pane session gets `[]` again.
- **Fence.** For an inline session with a token, the permission listener approves (`allow_once`)
  only when both hold:
  - `toolCall.title === 'mcp__krypton_inline__host_exec'`;
  - `_meta.claudeCode` is absent, or its `toolName` equals the same string and its
    `mcpServer.name === 'krypton_inline'`.
  Conflicting metadata, a different server, `rawInput` claims and every other request are
  declined as today. No substring or argument matching.

### 5. Context and prompt in an SSH pane

As implemented, a `<pane_host>` block rides the first turn (see Implementation Notes):

```
<pane_host>
This terminal pane is an SSH session on deploy@web-01. Commands the user runs from your answer execute on web-01, not on this Mac.
Your own Bash tool runs on this Mac. To check anything on web-01, call the host_exec tool. It runs only Krypton's read-only commands (no git, globs, redirects, $VAR, ~, cd); pipes and && are fine.
shell: fish (web-01 $SHELL)
cwd: /srv/app (web-01, from OSC 7)        ← or: "cwd on web-01: unknown (host_exec runs in $HOME; use absolute paths)"
</pane_host>
```

- When `open` failed, the block says the checks are unavailable, gives the reason, and asks the
  agent to answer from the terminal context and say what it could not check; no MCP server is
  sent.
- The overlay label gains `· checks on web-01` or `· no remote checks`.
- The spinner shows `web-01 $ <command>` for `host_exec` calls; the command comes from the
  permission request (`InlineTurnEvent.tool.command`).
- 0335's `buildCommandResult` and fix request use the same pane shell.

### 6. Frontend wiring

- **OSC 7.** `main.ts` `onCwd` also calls `compositor.noteOsc7(sessionId, cwd, hostname)`, which
  keeps the latest report per session (local reports included).
- **`openInlineAI`.** With `remote_checks` on and the foreground process `ssh`, it calls
  `inline_remote_open(sessionId, latestOsc7)` without awaiting, and passes the promise to the
  session (`mcp`) and to the context builder.
  - The overlay opens at once; `Starting <backend>…` covers the connect.
  - The connect is bounded by `ConnectTimeout = 15`.
- **Close.** The token is closed when the conversation ends: overlay `close()`, or follow-up
  `dispose()`.
- **0335 arming.** `osc133Terminals: WeakSet` becomes `osc133Last: WeakMap<Terminal, kind>`. An
  accept arms only when the last event is `prompt` (a prompt that sends OSC 133 is in front).
  A local fish that ran `ssh` to a bash host has `C` as its last event, so it is not armed. The
  reproduced bogus fix on logout goes away.
- **`detect` staleness.** The cache entry stores the `ssh` pid. `detect` walks the process tree
  first and re-parses when the pid differs.

### Keybindings

No new keys.

### Configuration

```toml
[inline_ai]
remote_checks = true   # in an SSH pane, let Cmd+K run read-only checks on that host (spec 336)
```

## Edge Cases

- **Password-only host without a usable ControlMaster:** `BatchMode` fails, the label says
  `no remote checks`, and the error names it. Setting `ControlMaster auto` + `ControlPath` in
  `~/.ssh/config` lets Krypton borrow the pane's own master.
- **Nested hop** (`ssh a`, then `ssh b` on a): the channel reaches `a`. The header names
  `hostname -s` from the probe, so a mismatch with the screen is visible. A fish on `b` sends
  OSC 7 with host `b`, which no longer matches, so cwd is reported unknown.
- **Remote bash/zsh without OSC 7:** cwd unknown, and checks run in `$HOME`; the header says so.
  The agent can use absolute paths it sees on screen.
- **Agent asks for git, globs or redirects on the host:** `host_exec` refuses with the reason;
  the agent puts the step in its answer.
- **`tail -f` / `docker logs -f`:** stopped at the timeout (default 15 s).
- **Backend that never asks permission for MCP tools:** the call runs, gated by the same
  classifier.
- **Backend whose permission title is not the exact identity** (other adapters): declined; that
  backend gets no remote checks.
- **`remote_checks = false`:** no connection; the header keeps 0334's SSH line.
- **Syntax gate for a shell Krypton does not know** (`nu`, `xonsh`): skipped.
- **Syntax gate in ask mode:** none; answers are prose.
- **Pane closes or conversation superseded mid-check:** the token is revoked and its commands are
  killed.
- **Secrets:** `host_exec` output goes to the model as tool output, like the local Bash tool's.
  The classifier's guards (no `/proc`, no hidden paths, `ps` without `e`) still apply.

## Tests

- `inline_remote.rs`: token lifecycle (unknown and revoked tokens refused); a classifier refusal
  is `isError` with nothing spawned (injected runner); a third concurrent check is busy; output
  head/tail cut; OSC 7 cwd only on a host match; borrowed vs owned ssh argv; `tools/list` only
  for a live token; probe and failure parsing.
- `ssh.rs`: `detect` re-parses after the pid changes (injected process lookup). `ssh_channel.rs`:
  the two moved Remote Harness tests.
- `headless-fence.test.ts`: exact identity approved, with or without `_meta`; declined: another
  server with the same tool, a lookalike server, mismatching `toolName` or `mcpServer.name`,
  `_meta` without the server, a Bash request, the identity only in `rawInput`.
- `inline-ai-session.test.ts`: `setMcpServers` before each `sessionNew`; a local session after a
  remote one gets `[]`; `session/new` waits for the channel; `host_exec` approved with
  `allow_once` and its command shown, other requests declined.
- `inline-ai-remote.test.ts`: the `<pane_host>` block (on, cwd unknown, off with reason), the MCP
  entry, the label, `hostExecCommand`.
- Not covered by a unit test: the compositor wiring (arming after `A`, open/close of the channel);
  the compositor has no harness for it.

## Implementation Notes

- **Real payload** (claude-agent-acp v0.95.0, mode `default`): every `host_exec` call raised
  `session/request_permission` with `title` = `name` = `mcp__krypton_inline__host_exec`,
  `kind: "other"`, `rawInput: {command}`, `_meta.claudeCode = {toolName: <same>, mcpServer:
  {name: "krypton_inline", source: "dynamic"}}`, options `allow_once`/`allow_always`/`reject_once`.
  Its `tool_call` arrives with an empty input, so the overlay takes the command from the
  permission request.
- **The host block is its own `<pane_host>` section** sent with the first turn, not lines in
  `<terminal_context>`: the snapshot is taken at `Cmd+K`, before the channel has connected. In an
  SSH pane with remote checks, the snapshot omits its `ssh:` and `shell:` lines.
- **Commands live in `inline_remote.rs`**, as Remote Harness's do, not in `commands.rs`.
- **Exit 255** (ssh's own failure) is `isError` with its output; other non-zero exits are normal
  results. The probe reads the last two non-empty lines, so rc-file noise does not break it.

## Verification

- `npm run check`; `npx vitest run` (237 files, 3029 tests); `cargo fmt -- --check`;
  `cargo test` (576 lib tests); `cargo clippy --all-targets` (only the existing
  `bool_assert_comparison` warning).
- **Live smoke** (throwaway, deleted): a user-level `sshd` on 127.0.0.1:2222 (login shell fish)
  with a temporary key; the "pane" was an `ssh -M` master; a throwaway Rust test opened the real
  `InlineRemoteManager` and served the `/mcp/inline` logic; a real `InlineAIOverlay` +
  `InlineAcpSession` ran `claude-agent-acp` (`haiku`) through a stdio shim. The OSC 7 cwd held
  three files that do not exist in the local cwd.
  - Borrowed master: `display wk@wks-Mac-Studio`, `shell fish`, cwd taken from OSC 7. Owned
    master: `ssh to wk@127.0.0.1 failed: Host key verification failed.`
  - ASK "which files are in the current directory on this host": `host_exec ls -la`, then the
    three host-only files; `grep ^wk: /etc/passwd` and `dscl …` were refused, and the answer said
    the shell was unverified.
  - CMD "delete the ONLY-ON-HOST files": `ls -la`, `cat …`, then `rm -f -- ONLY-ON-HOST-alpha.txt
    ONLY-ON-HOST-beta.log`; nothing was deleted.
  - ASK "latest git commit on this host": `ls -la`, `cat .git/HEAD` (refused, hidden path); the
    answer said the directory is not a repository.
- **Not exercised:** the app's Tauri IPC (`inline_remote_open` from a real pane, `detect` on a live
  PTY) and the WKWebView label; a remote host other than loopback.

## Out of Scope

- Running non-read-only commands on the host, or any approval UI for them in Inline AI.
- `git`, globs, redirects, variables and `cd` on the host (0318's list stays as is).
- Running the agent itself on the host (that is 0247's Remote Harness).
- The Quick Terminal; Windows/non-OpenSSH hosts; hosts without `sh`.
- Changing what the local Bash tool may run (Claude Code's own list).

## Resources

- [Warp — Feature support over SSH](https://docs.warp.dev/code/ssh-feature-support/) — the Agent runs commands on the remote host, and falls back to `cat`/`sed`/`grep` without the extension.
- [iTerm2 — AI Chat](https://iterm2.com/documentation-ai-chat.html) — per-category permissions: Run Commands, View Contents, Control Terminal.
- [Claude Code — MCP / tool search](https://code.claude.com/docs/en/mcp) — deferred MCP tools and `anthropic/alwaysLoad` (via 0289).
- Internal: 0318 (classifier, git rationale), 0311 (`sh -s` channel), 0247 (focused-SSH resolution), 0333/0334/0335; probes from this session (claude 2.1.309, fish 4.2.1, bash/zsh `-n`).
