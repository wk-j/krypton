# Connected Computer Commands from ACP Harness — Implementation Spec

> Status: Implemented (manual SSH/Tauri smoke pending)
> Date: 2026-10-18
> Milestone: ACP Harness — cross-computer commands

## Problem

A lane in a local ACP Harness is tied to its local project, while a Remote Harness moves every lane and its workspace to one SSH host. The user wants any active local Harness lane, including Pi, to discover computers explicitly connected in Krypton and run an occasional command there without moving the lane or its workspace. The user also wants a dedicated view in Krypton to add, edit and manage those connections.

## Solution

Add an app-owned **Connected Computers** SSH service, separate from Remote Harness workspaces, and a dedicated `ContentView` to manage it. The view creates and edits named SSH profiles in its own app-managed settings file, connects/disconnects them, and shows live status and actionable errors. Connected hosts appear to lanes through a read-only list; a lane sends a command to one host through Krypton and receives bounded output and the exit status. Lanes receiving in-process MCP descriptors use two built-in Harness tools; Pi, Cursor, Junie and Cline use the same service through `kryptonctl` from their shell tools because their native MCP config is written to disk. Every command crosses one Krypton-owned approval gate before SSH execution.

## Research

- `remote_harness_choices` currently returns configured `remote_profiles` plus the focused SSH terminal. Its `RemoteHarnessRegistry` owns runtimes per Remote Harness, not a general computer connection registry (`src-tauri/src/remote_harness.rs`). `AcpHarnessView.workspace` is immutable, and spec 247 gives one execution host to the whole Harness. Cross-computer commands must not mutate it.
- `RemoteMethod::WorkspaceRun` is a deliberately narrow `git`/`gh`/`printenv` allowlist rooted in a remote project. It cannot be widened into arbitrary lane commands without changing the Remote Harness trust boundary (`src-tauri/remote-runtime/src/main.rs`).
- The built-in Harness MCP server already advertises per-lane tools and routes calls through `hook_server.rs`; its current auto-allow scanner recognizes named low-risk tools. An adapter may auto-allow the new built-in routing tool only after the separate app-owned command approval gate is present; that auto-allow must never execute the command by itself.
- Pi has no MCP host, but its local `bash` tool is available through `pi-acp`. The installed `kryptonctl` CLI already authenticates to Krypton's local control API. A CLI adapter lets Pi reach the same app service without changing pi or its ACP adapter. Packaging and development startup must make the CLI path available to Pi.
- OpenSSH supports a persistent `ControlMaster` connection and `-O check`. Krypton already verifies borrowed sockets in the Remote Harness path; Connected Computers can own and verify separate sockets without touching interactive PTYs.
- `config.rs::load_config_result()` explicitly never writes `krypton.toml`. The existing Telegram settings view writes a separate versioned TOML file atomically. An app-managed sidecar for connected computers lets a dedicated view save profiles without rewriting the user's main config or its comments.
- `TelegramSettingsContentView` is an existing keyboard-operated `ContentView` opened in a compositor tab; `PaneContentType` and `createContentTab()` provide the same seam for this view. Connection state must live in Rust, not in the view instance, so closing the tab does not disconnect a computer.
- VS Code Remote SSH and Zed expose named SSH targets in dedicated remote selectors. This feature gives Krypton a persistent management view while keeping the local Harness workspace and routing individual commands to a selected connected host.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| VS Code Remote SSH | SSH Targets in Remote Explorer list saved hosts; Command Palette connects to one; integrated terminals in that remote window run on the host. | Familiar managed host list and explicit connection state, but changes workspace context. |
| Zed Remote Development | Remote Projects dialog lists SSH connections, starts a remote server, and reuses its ControlMaster. | Connection reuse and visible named targets, but changes workspace context. |
| OpenSSH | `ControlMaster` shares an authenticated connection; `ssh -O check` verifies the master. | Transport and liveness check for the app-owned service. |

**Krypton delta** — the lane remains in its current Harness and project; the host is an explicit parameter of each remote command. No project file routing or agent process moves to that host.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/connected_computers.rs` (new), `src-tauri/src/lib.rs` | Own the versioned sidecar profile store, verified SSH masters, command lifecycle, limits, status events, and Tauri commands. |
| `src-tauri/src/hook_server.rs` | Advertise `computer_list` / `computer_exec`; bind calls to a live Harness lane and route through the shared execution gate. |
| `src-tauri/src/control.rs`, `src-tauri/src/bin/kryptonctl.rs` | Add authenticated lane-scoped CLI entry points for file-configured backends; never expose the lane capability in output. |
| `src/acp/acp-harness-view.ts`, `src/acp/harness-permission-scan.ts` | Add short tool/CLI guidance, lane capability lifecycle, and the command approval request/reply UI. Auto-allow only the authenticated MCP routing step; keep command execution behind the separate app gate. |
| `src/types.ts`, `src/compositor.ts`, `src/command-palette.ts` | Add the `connected_computers` pane type, open/focus the one management view, and expose its keyboard route. |
| `src/connected-computers-view.ts` (new), `src/styles/connected-computers.css` (new) | Profile list/editor, connect/disconnect controls, status/error details, responsive keyboard-first layout. |
| `src/acp/computer-approval.ts` (new) | Turn the Rust approval request into the `PermissionPayload` the lane's transcript already renders — no dialog of its own. |
| `scripts/stage-remote-runtime.sh`, app resource packaging | Make `kryptonctl` available to CLI-routed lanes in dev and installed builds. |
| Focused Rust/TS tests; `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0006-configuration.md`, `docs/0072-acp-harness-view.md`, `docs/README.md` | Verify and document the contract and its limits. |

## Design

### Profiles and identity

The view owns `~/.config/krypton/connected-computers.toml`, separate from the read-only main `krypton.toml`. A missing file means an empty list. The app writes this sidecar only after a user saves or removes a profile, using a versioned schema and an atomic same-directory rename with `0600` permissions on Unix. Load errors preserve the file and show an error in the view. Save and delete check the file revision/hash first, so an external edit made while the form was open cannot be silently overwritten; the user can reload and reapply the edit.

```toml
schema_version = 1

[[computers]]
id = "buildbox"
host = "buildbox"                 # OpenSSH alias or hostname
user = "alice"                   # optional; otherwise OpenSSH config/default
port = 22                        # optional; otherwise OpenSSH config/default
default_cwd = "/srv/builds"      # optional; omitted means remote login home
```

`id` is unique and matches `[a-z][a-z0-9_-]*`; `host` is a non-option-like OpenSSH alias or hostname. `user` and `port` are optional explicit overrides; when absent, OpenSSH resolves them from `~/.ssh/config`. Identity file, jump hosts and host-key policy remain in OpenSSH config. `default_cwd`, when present, is absolute. No password, private key or token enters the sidecar. Existing `acp_harness.remote_profiles` remain independent because they name a *project workspace*, whereas these entries name a *command target*.

The app stores `Configured`, `Connecting`, `Connected`, or `Disconnected` per ID. At app startup, saved profiles load as `Configured`; Krypton does not auto-connect them. Only a user action in the view connects a configured host. Connect resolves the effective user, hostname and port with `ssh -G` plus the profile's explicit overrides and displays that identity beside the alias. `Connected` means the app-owned SSH master has passed `ssh -O check`; a saved profile alone is not called connected. A lightweight child-exit monitor emits status changes, while list and command calls recheck the SSH master before claiming a host is connected. Editing or removing a connected profile requires disconnecting it first, and a canceled in-flight command must finish before that ID can be edited or reconnected. No LAN scanning or agent-initiated connect.

### Service and APIs

`ConnectedComputerManager` owns one ControlMaster child/socket per connected ID, allocates socket paths under Krypton's existing private SSH socket directory, and closes only its own master. Connect uses `ssh -M -N -T` with `BatchMode=yes` and a bounded timeout. Noninteractive SSH authentication (usually a loaded key/agent) and host-key trust must already work; the view shows the exact target and an **Open SSH Terminal** action to diagnose/setup failed authentication, without claiming that one password login will make `BatchMode=yes` work later. Disconnect rejects new calls and ends app-owned sessions; app shutdown disposes them all. Closing the management view leaves connections running. A failed `-O check` marks the target disconnected and returns a typed error.

```ts
type ComputerProfile = { id: string; host: string; user?: string; port?: number; defaultCwd?: string };
type ComputerStatus = { profile: ComputerProfile; state: 'configured' | 'connecting' | 'connected' | 'disconnected'; resolvedTarget: string | null; activeCommands: number; lastError: string | null };
type ComputerList = { revision: string; computers: ComputerStatus[] };
type ComputerExecRequest = { computerId: string; command: string; cwd?: string; timeoutSeconds?: number };
type ComputerExecResult = { computerId: string; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; outcome: 'completed' | 'unknown' };
```

Tauri commands `computer_list`, `computer_profile_save({ profile, expectedRevision })`, `computer_profile_delete({ id, expectedRevision })`, `computer_connect({ id })`, and `computer_disconnect({ id })` serve the management view. Save/delete reject stale revisions and connected profiles. List responses carry the current profile-store revision alongside statuses; status-change events do not change that revision. The per-lane built-in MCP tools are `computer_list` (read-only statuses) and `computer_exec` (request above). `computer_exec` returns a normal MCP tool result with `isError: true` for refusal, timeout, lost connection or missing host; command nonzero exit is a completed command with its exit code, not a protocol error.

Pi, Cursor, Junie and Cline use `kryptonctl computer list --json` and `kryptonctl computer exec <id> --cwd <path> -- <command>` through their shell tools. Krypton injects an opaque, revocable capability into each *local* lane process environment, bound to harness ID, lane ID and spawn epoch. The CLI reads it from the environment; lanes with in-process MCP descriptors send it as a header on Krypton's built-in per-lane MCP server descriptor. Native MCP configurations written to disk never receive this header, including project-local `.cursor/mcp.json`. Both servers validate the capability for these two tools, so a caller cannot gain access by naming another lane in a URL or CLI argument. The capability is not included in lane context or tool output. Closing/restarting a lane or Harness revokes it. The bundled or built `kryptonctl` path is given in the CLI-routed lanes' short context so this path works even when `~/.local/bin` is absent from `PATH`. Both MCP and CLI calls reach the same gate and executor.

### Command gate and process contract

1. Validate the live lane binding, connected target ID, command length (1–16 KiB), absolute `cwd` and timeout (1–600 seconds; default 120) before presenting approval. A stale lane, removed profile or disconnected host fails closed.
2. Present the request as a permission row in the requesting lane's transcript — the harness permission chrome, carrying the resolved SSH identity, `cwd`, exact command and a one-line `approval applies once` note — and show `⚠ remote` on the lane until it is answered. `a` approves once, `r` declines; `A`/`R` resolve as plain `a`/`r` because a remote command never inherits a turn-wide answer. No modal dialog opens, and no command starts before this decision. The pending queue is NOT `lane.pendingPermissions`: that one is drained automatically by permission mode, the per-turn accept/reject-all flags, a Telegram turn and the Polly/Salty roles, every one of which would otherwise run a command under the user's SSH identity unasked. The existing backend permission prompt auto-allows only the *built-in routing tool* after its server identity is verified; the app-owned command gate still waits for the human. Pi reaches the identical gate without depending on a provider permission popup.
3. After approval, recheck lane epoch and SSH master, then run a fresh no-PTY channel over that master. Send `cd '<escaped cwd>'` (when set) and the command on stdin to a fixed remote `sh -s`; close stdin after writing. The command is never interpolated into a local shell or appended to SSH options. v1 requires a Unix-like remote host with `sh`.
4. Stream/drain stdout and stderr concurrently, retain at most 256 KiB of each, set `truncated` if more arrives, and return the exit code. Limit to two concurrent commands per host and four per app; reject excess with `busy`. Do not store full command output outside the normal tool transcript.
5. On timeout, lane cancellation, host disconnect or app shutdown, terminate the local SSH child and return `outcome: 'unknown'` where remote completion cannot be proven. Never auto-retry an approved command. A remote process that detaches itself may survive SSH termination; the result says so plainly.

### Management view and user flow

`Cmd+Shift+P` → **Connected Computers…** opens a dedicated `connected_computers` `ContentView` tab titled `CONNECTIONS // computers`. Reopening focuses the existing tab instead of creating a duplicate. It is a normal compositor content tab, not a second native OS window. The app-owned manager retains profiles and live connections when this tab closes, across workspaces and while no Harness view is open.

The view has a searchable computer list and a detail/editor region. It shows at most the first 100 matches and asks the user to refine the search for another target. Each list row shows the profile ID, resolved `user@host:port` when known, connection state and active command count. The detail region shows host, optional user/port/default directory, the last failure with its target, and actions to Save, Connect, Disconnect, Open SSH Terminal and Remove. In a narrow pane the same regions stack. Empty, connecting, disconnected and load-error states have explicit text; load failure disables profile edits without discarding the file. Status events refresh the list and detail without replacing the active editor input or stealing focus. The view unsubscribes on disposal; Rust keeps the connections and status.

From the list, `j`/`k` or arrows move selection, `n` creates a profile, `e` edits, `Enter` connects a disconnected selection, `x` disconnects, `t` opens an SSH terminal, `Delete` removes a disconnected profile after confirmation, `r` refreshes and `q` closes the tab. `/` focuses search. In the editor, `Tab`/`Shift+Tab` move among fields, `Cmd+Enter` saves and `Esc` cancels editing and returns to the list. Shortcuts do not intercept text typed into inputs. Disconnecting a host with active commands requires confirmation and tells the user those results may be unknown. Editing or removing a connected host first requires disconnecting it. A failed save caused by an external file change offers Reload while preserving the unsaved form values for reapplication. The **Open SSH Terminal** action opens a normal Krypton terminal aimed at the selected target for interactive diagnosis or authentication; it does not mark the managed service connected.

1. User opens **Connected Computers…**, creates a profile using a host name or existing OpenSSH alias, and saves it. OpenSSH config can supply user, port, key and jump-host settings. The view can open a terminal to set up SSH access. Connect then verifies that noninteractive authentication and host-key trust work.
2. Any active local Harness lane calls `computer_list` or uses CLI list for a file-configured backend, chooses a `connected` ID, and requests `computer_exec` or CLI exec. The lane's local project, `WorkspaceRef`, Git context and other tools remain local.
3. The user approves the exact command; the lane receives bounded output and exit status in its normal tool result. Several lanes can use the same connected host, within the concurrency cap.

### Verification

Rust unit tests cover profile round trips, stale revisions, validation, per-lane capability revocation and output caps. TS tests cover editor preservation through status events and conflicts, the approval row's display contract (exact command, resolved target, remote directory), that an armed lane — bypass mode, accept-all for the turn, a Telegram turn — still parks a remote command for the human, and built-in routing permission identity. Run frontend check/build/test, Rust fmt/Clippy/tests, and a manual two-computer SSH smoke with both an MCP lane and a CLI-routed lane before calling the feature verified end to end. The manual SSH and Tauri UI smoke remain environment-dependent verification gates.

## Edge Cases

- A configured host is offline or needs interactive SSH authentication: connect fails with a clear status; no lane may run commands on it.
- The sidecar is malformed or changes externally while a form is open: display the parse error or revision conflict, preserve the file and unsaved form, and require an explicit reload before another save.
- The management tab closes or its workspace changes: the app-owned manager keeps verified connections available to every local Harness lane; reopening shows the current state.
- A user disconnects while commands run: require confirmation, reject new calls, terminate the app-owned SSH children and report uncertain remote completion.
- Two profiles resolve to one physical host: they remain separate IDs and approval targets; no command switches target when configuration changes.
- A caller submits shell syntax or a destructive command: the exact text is shown for per-command human approval; Krypton does not pretend a shell command is safely classifiable from its first word.
- A command expects a TTY or stdin: it fails normally in v1's noninteractive channel; the result identifies the target and exit status.
- A command prints secrets or huge output: output is bounded and visible only in the ordinary lane/tool transcript; no background log copies it.
- The hook/MCP or control endpoint receives an unbound request: it rejects before requesting approval or opening SSH.
- `kryptonctl` is missing in a development or packaged build: CLI-routed capability setup fails visibly; the feature is not presented to that lane as available. Packaging and dev build checks must prevent this shipping state.

## Open Questions

None for the local Harness scope defined above.

## Out of Scope

- Moving an ACP lane, its files, or its agent process to the connected computer; Remote Harness (spec 247) retains that role.
- Remote Harness lanes calling back into this local service; that requires a separate transport/identity design. This spec covers **every local Harness lane, including Pi**.
- Interactive PTYs, file sync, command scheduling, persistent remote jobs, automatic host discovery, agent-initiated connection, or credentials management.

## Resources

- [OpenSSH `ssh(1)`](https://man.openbsd.org/ssh) and [`ssh_config(5)`](https://man.openbsd.org/ssh_config) — remote command channels, ControlMaster and connection configuration.
- [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) — saved hosts, connect picker and remote terminal behavior.
- [Zed Remote Development](https://zed.dev/docs/remote-development) — SSH target selection and verified connection reuse.
- [Pi coding agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) and [pi-acp README](https://github.com/svkozak/pi-acp) — Pi's built-in bash path and lack of MCP host in the adapter.
