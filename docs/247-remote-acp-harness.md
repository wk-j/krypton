# Remote ACP Harness via SSH Runtime — Implementation Spec

> Status: Implemented
> Date: 2026-09-13
> Milestone: ACP Harness — remote execution

## Problem

Every ACP Harness lane currently runs its agent adapter, filesystem callbacks, Git inspection, project MCP discovery, and harness-memory server on the same computer as the Krypton UI. A user cannot keep Krypton responsive on a local Mac while agents work against a repository and toolchain that exist only on an SSH-accessible computer.

## Solution

Add a **remote Harness workspace** backed by a small, protocol-compatible `krypton-remote` companion process started through the system OpenSSH client. Users can select a configured profile or derive an ephemeral target from the focused SSH terminal. Krypton automatically resolves, verifies, uploads, and caches the matching companion; the remote machine needs neither Krypton source nor a Rust toolchain. Krypton remains the ACP client and live lane-state authority; the companion only launches remote agent processes and performs remote workspace I/O. A framed JSON protocol multiplexes agent stdio, filesystem operations, and bounded process calls over SSH stdio.

The execution target belongs to the whole Harness, not an individual lane. Every lane in one Harness therefore shares one filesystem, Git checkout, Harness memory store, and process host. Local and remote lanes are never mixed inside one Harness.

## Research

- `src-tauri/src/acp.rs` creates each adapter with `tokio::process::Command`, local `current_dir`, piped stdio, and direct `std::fs` callbacks. Replacing only the command with `ssh` would still modify local files.
- `AcpHarnessView` treats `projectDir` as one local path for agent spawn, MCP, Git, tickets, notes, references, and review state. A remote path must carry host identity and route through one remote runtime.
- Krypton already detects the SSH process behind a focused terminal and tracks its remote CWD through OSC 7. The current clone path invents a Krypton control-socket path and deliberately discards the original `ControlPath`, so an active terminal is a reliable launch-context source but not proof that its transport can be reused.
- Harness memory binds to local `127.0.0.1`. An SSH reverse forward (`-R`) can give remote agents a remote-loopback address that securely reaches the existing local server.
- OpenSSH provides no-PTY remote commands (`-T`), connection sharing (`ControlMaster`/`ControlPath`), and reverse forwarding (`-R`). Host aliases remain in `~/.ssh/config`.
- Zed uses a local UI plus a version-matched SSH server and resolves external-agent commands through its remote project client. Agent and workspace services move together.
- Zed first probes a versioned remote cache, then downloads a platform-specific
  release locally and uploads it through SFTP/SCP when the remote host cannot
  download it. Krypton follows the same ownership model but uploads through a
  fixed SSH `cat` command so it can reuse the existing ControlMaster without a
  second file-transfer argument parser.
- VS Code Remote SSH likewise runs workspace extensions, source access, tasks, and terminals remotely; its docs distinguish this from SSHFS/rsync.
- ACP stays newline-delimited JSON-RPC over stdio. Krypton's outer framing preserves each ACP JSON value and opens no network ACP endpoint.

### Alternatives considered

1. **Spawn `ssh host codex-acp` directly.** Rejected because filesystem callbacks, MCP, Git, tickets, memory, and teardown would remain local or unreachable.
2. **Mirror with rsync or SSHFS.** Rejected because two writable copies create stale diffs; SSHFS adds network latency to repository-wide tools.
3. **Expose agents over TCP/WebSocket.** Rejected because adapters share stdio, not one authenticated network transport, and agent ports widen the security surface.
4. **Run the full desktop remotely.** Remote Desktop remains a workaround but gives up the responsive local UI.
5. **Long-lived daemon.** Deferred; a per-Harness companion has simpler ownership and uses agent session resume after reconnect.
6. **Drive the existing interactive SSH shell.** Rejected because injected commands can corrupt shell state and ACP framing would mix with terminal output. A focused SSH terminal supplies connection metadata and CWD; the Harness always gets a separate no-PTY channel.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Zed | Local GPUI client starts a version-matched remote server over SSH; filesystem, terminals, tasks, language servers, and remote external-agent commands run through the remote project client. | Closest architecture; also reuses an OpenSSH ControlMaster. |
| VS Code Remote SSH | Local UI connects to VS Code Server; workspace extensions and commands run beside the remote source tree. | Establishes the local-UI/remote-workspace convention and avoids file mirroring. |

**Krypton delta** — use the familiar local-UI/remote-runtime split, but keep the companion per-Harness, non-daemonized, and accessible only through system SSH configuration. Preserve Krypton's keyboard-first multi-lane UI, permissions, queues, peering, and local controls without repository sync or a public runtime port.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/remote_harness.rs` | New SSH manager, framed-protocol client, request registry, reverse forward, and teardown. |
| `src-tauri/remote-protocol/` | New Serde-only crate shared by the app and companion. |
| `src-tauri/remote-runtime/` | New headless `krypton-remote` package with no Tauri/WebKit/audio dependency. |
| `src-tauri/remote-binaries/`, `scripts/stage-remote-runtime.sh` | Stage the host helper as an app resource for development and packaging. |
| `.github/workflows/remote-runtime-release.yml` | Publish four platform helpers and SHA-256 files on each Krypton release. |
| `src-tauri/src/acp.rs` | Add local/remote agent transports while retaining ACP JSON-RPC, permissions, and event semantics locally. |
| `src-tauri/src/ssh.rs` | Resolve a focused SSH terminal into a safe launch descriptor and verify any reusable ControlMaster socket. |
| `src-tauri/src/config.rs` | Add remote Harness profile configuration and validation. |
| `src-tauri/src/lib.rs` | Manage `RemoteHarnessRegistry` and register remote commands/events. |
| `src-tauri/Cargo.toml` | Add workspace members/path dependency while keeping the desktop app the default member. |
| `src/types.ts` | Add `WorkspaceRef`/`WorkspaceKey` and optional content-view workspace identity. |
| `src/acp/types.ts` | Add remote profile, connection state, and Harness execution-target types. |
| `src/acp/client.ts` | Pass an execution target when spawning/probing ACP sessions. |
| `src/acp/harness-directory.ts` | Carry a host-qualified workspace key so equal remote paths on different hosts do not collide. |
| `src/acp/acp-harness-view.ts` | Own one immutable workspace target, route project operations, show remote state, and recover lanes after reconnect. |
| `src/acp/remote-harness-picker.ts` | New keyboard-first picker for the focused SSH terminal and configured profiles, including missing-CWD and connection errors. |
| `src/ssh-session.ts` | Expose detected SSH metadata and passive remote-CWD state without injecting a probe command. |
| `src/compositor.ts` | Open a remote Harness and preserve its workspace identity when opening related views. |
| `src/input-router.ts` / `src/which-key.ts` | Add `Leader Shift+S` for the remote Harness profile picker. |
| `src/command-palette.ts` | Add “Open Remote ACP Harness…” and “Reconnect Remote Harness”. |
| `src/styles/acp-harness.css` | Remote badge, picker, connecting, disconnected, and retry states. |
| `src-tauri/src/*test*`, `src/acp/*.test.ts` | Protocol, path confinement, SSH parsing, picker, and UI regression coverage. |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/06-configuration.md`, `docs/69-acp-agent-support.md`, `docs/72-acp-harness-view.md` | Document the implemented remote path. |

## Design

### Workspace identity

```ts
export type WorkspaceRef =
  | { kind: 'local'; path: string | null }
  | {
      kind: 'ssh';
      source: 'profile' | 'focused_ssh';
      profile: string | null;
      user: string;
      host: string;
      port: number;
      path: string;       // canonical absolute remote project path
      runtimeId: string;  // live connection id; not persisted
    };

export type RemoteHarnessLaunch =
  | { kind: 'profile'; profile: string }
  | { kind: 'focused_ssh'; terminalSessionId: number; projectDir?: string };

export function workspaceKey(workspace: WorkspaceRef): string;
// local:/Users/wk/Source/krypton
// ssh:builder@buildbox:22:/srv/repos/krypton
```

`AcpHarnessView.workspace` is immutable for the life of the view. Its
`getWorkingDirectory()` continues to return the path for existing display-only
consumers; a new `getWorkspace?(): WorkspaceRef` is authoritative for routing.
`HarnessDirectory` stores both `cwd` and `workspaceKey`.

`RemoteHarnessLaunch` is consumed only while connecting. A focused-session launch is resolved into the same immutable `WorkspaceRef` used by a profile, so reconnect does not depend on the original terminal remaining alive. The resolved `user`, `host`, `port`, and canonical path make identity stable across both entry points.

### Configuration

```toml
[acp_harness]
idle_flash_sound = true
memory_footer = true

[[acp_harness.remote_profiles]]
name = "buildbox"
host = "buildbox"                 # alias from ~/.ssh/config
project_dir = "/srv/repos/krypton"
connect_timeout_seconds = 15
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHarnessProfile {
    pub name: String,
    pub host: String,
    pub project_dir: String,
    pub connect_timeout_seconds: u64,
}
```

`connect_timeout_seconds` defaults to 15. Profiles are optional. Profile names are unique, `host` matches `[A-Za-z0-9._-]+` and cannot start with `-`, and `project_dir` is absolute. User, port, identity, ProxyJump, and host-key policy stay in `~/.ssh/config`.

For a profile or focused session without a reusable master, Krypton sets `BatchMode=yes`, `ControlMaster=auto`, a Krypton-owned `ControlPath`, `ControlPersist=60`, `ServerAliveInterval=15`, `ServerAliveCountMax=2`, and `ExitOnForwardFailure=yes`. Password/passphrase and host-key prompts are not collected; failure tells the user to establish `ssh <host>` in a terminal.

For `focused_ssh`, Rust calls the existing `detect_ssh_session`, accepts only its structured destination, port, identity-file, and jump-host fields, and resolves effective settings with `ssh -G`. It uses the passively cached OSC 7 CWD; if none exists, the picker requires an absolute project path. This flow never calls `probeRemoteCwd` or writes into the active PTY. If the detected or resolved `ControlPath` passes `ssh -O check`, Krypton borrows it; otherwise it opens a new Krypton-owned master and may require authentication.

```rust
enum ControlMasterLease {
    Borrowed { socket: PathBuf },
    Owned { socket: PathBuf },
}
```

Teardown cancels only the exact reverse forward on a borrowed master and never closes that master. It closes an owned master after the companion and forward stop.

Krypton probes `uname` through the resolved SSH target and normalizes the result
to one of `aarch64-apple-darwin`, `x86_64-apple-darwin`,
`aarch64-unknown-linux-gnu`, or `x86_64-unknown-linux-gnu`. Unsupported targets
fail before any upload. It resolves the companion from a bundled resource first,
then a verified local download cache. Release downloads come from the matching
Krypton GitHub release and must match the accompanying SHA-256 file.

The verified bytes are streamed over SSH stdin to a mode-0700 temporary file,
then renamed atomically to
`~/.cache/krypton/remote/<app-version>/krypton-remote`. A successful `version`
probe skips all download/upload work on later connections. The runtime is
launched by that exact versioned path, never through remote `PATH`.

### Runtime protocol

Bootstrap uses only fixed `uname`, version-probe, and atomic-install commands.
The long-lived runtime channel then executes only this fixed remote command:

```text
ssh -T <fixed-options> <validated-host> exec "$HOME/.cache/krypton/remote/<app-version>/krypton-remote" serve --stdio
```

No project path, backend argument, environment value, or user text appears in the remote shell command. Those values are sent after connection as JSON.

```rust
#[serde(tag = "stream", rename_all = "snake_case")]
enum RuntimeFrame {
    Hello { protocol: u16, app_version: String, workspace: RemoteWorkspace },
    Request { id: u64, method: RemoteMethod, params: serde_json::Value },
    Response { id: u64, result: Option<Value>, error: Option<RuntimeError> },
    Event { topic: String, payload: Value },
}

enum RemoteMethod {
    RuntimeShutdown,
    AgentSpawn,
    AgentWrite,
    AgentTerminate,
    RuntimeOverlayWrite,
    RuntimeOverlayRemove,
    WorkspaceCanonicalize,
    WorkspaceRead,
    WorkspaceWrite,
    WorkspaceRemove,
    WorkspaceStat,
    WorkspaceReadDir,
    WorkspaceRun,
}
```

Frames are newline-delimited UTF-8 JSON with a 32 MiB decoded-line cap. ACP values remain nested under `params`/`payload`; neither side parses agent text as shell. Unknown methods, duplicate ids, oversized frames, and version mismatch close with a typed error. `WorkspaceRemove` exists for exact project-file cleanup (currently Cursor MCP entries); directories require `recursive: true`, and the companion rejects paths outside the canonical workspace. Junie/Cline overlays use the dedicated runtime-overlay methods, live under a mode-0700 temporary directory outside the repository, and are removed with the companion.

The companion emits `agent_stdout`, `agent_stderr`, and `agent_exit` events keyed by remote child id. Local `acp.rs` feeds stdout JSON into its existing dispatcher and retains request correlation, permissions, fs-write review, session state, and `acp-event-<session>` emission. `WorkspaceRun` uses `Command::new` with argv, never a shell, and accepts only the executable families required by existing Harness operations.

### Harness MCP reverse tunnel

The existing hook server stays local because it owns Harness memory and routes peering/control events to the local frontend. After the SSH ControlMaster starts, local Rust requests a dynamically allocated remote-loopback forward:

```text
127.0.0.1:<remote-port> -> SSH -> 127.0.0.1:<local-hook-port>
```

OpenSSH `-O forward -R 127.0.0.1:0:127.0.0.1:<local-hook-port>` reports the allocated remote port. Remote agents receive that remote-loopback URL; local dashboard/gallery/docs pages keep their current local URL. Both ends remain loopback-only. If forwarding fails, ACP lanes continue without Harness MCP tools and show the normal memory-unavailable state.

### Project operations and feature boundary

Remote mode never falls back to local `std::fs` or local `run_command` for a remote path. The implemented core path routes:

- ACP adapter spawn, session lifecycle, model/mode, permissions, and cancel;
- ACP `fs/*` validation, diff preview, approval, read, and write;
- project `.mcp.json` loading plus backend-specific Cursor/Cline overlays;
- Harness memory and frontend-routed peering/attention tools through the reverse tunnel;
- Git branch and explicit working/staged diff reads through the remote command allowlist.

Unsupported operations are visibly disabled and never fall back locally. The current implementation disables local Helix/Markdown opens for remote files, File Manager, Vault, Pencil, Hurl, tickets, docs, artifacts, daily notes, Xenon, usage persistence, and local image resolution. Harness memory remains available in-memory through the reverse tunnel; project-backed Harness persistence and loopback project browsers are deferred until the hook server has target-aware storage.
Project-backed MCP tools are omitted from `tools/list` for this in-memory
session and cached calls are rejected, while handoff, peering, attention, review
outcomes, and review-priority hints remain available.

Local `kryptonctl`, Telegram, browser extension, queues, orchestration, permissions, transcripts, and lane selection still target `AcpHarnessView`, preserving ADR-0007 frontend authority.

### Connection and lane lifecycle

```text
1. User focuses an SSH terminal, presses Leader Shift+S, or selects Open Remote
   ACP Harness…
2. The picker shows Current SSH first when detection succeeds, followed by
   configured profiles. If passive remote CWD is missing, Current SSH requires
   the user to enter an absolute project path.
3. Local Rust resolves the selected launch source. It borrows a verified active
   ControlMaster when available; otherwise it starts a dedicated one for the
   same destination.
4. Local probes the versioned remote helper. If absent, it detects the remote
   platform, resolves a bundled or SHA-256-verified release asset, uploads it
   atomically to the remote user cache, and verifies `krypton-remote version`.
5. Local starts the exact cached helper path with no PTY, then sends Hello.
6. Remote verifies protocol compatibility, canonicalizes the project root, and
   returns its app version and runtime capabilities.
7. Local creates the loopback-only reverse MCP forward, then Compositor creates
   AcpHarnessView with an immutable SSH WorkspaceRef.
8. The existing lane picker opens. Every lane spawn routes to this runtime;
   agent adapters inherit the remote login environment and remote cwd.
9. Agent stdio crosses the runtime stream; local ACP dispatch and frontend
   rendering remain unchanged.
10. On view close, local sends RuntimeShutdown. Remote cancels pending requests,
   SIGTERMs each agent process group, waits two seconds, SIGKILLs survivors,
   exits. Local cancels the exact reverse forward and closes the ControlMaster
   only when Krypton owns it.
```

If SSH drops, the Harness becomes `disconnected`, in-flight requests become outcome-unknown, and transcripts, drafts, queues, session ids, and permissions remain. It never replays prompts. Reconnect starts a fresh companion and tries `session/resume`, then `session/load`, then a warned fresh session.

### UI and keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader Shift+S` | Compositor | Open the remote-Harness picker; show focused SSH first when available. |
| `j` / `k`, arrows | Remote profile picker | Move selection. |
| `Enter` | Remote profile picker or disconnected card | Connect/reconnect. |
| `Esc` | Remote profile picker | Close without starting a connection. |

`Leader s` remains Swap; only the unused shifted variant changes. A profile-backed header shows `SSH <profile> · <remote-path>`; a focused-session launch shows `SSH <user>@<host>:<port> · <remote-path>`. Connection state (`connecting|connected|disconnected|closing`) stays separate from lane/provider state. Remote controls use existing full-border components and no L-shaped brackets.

## Edge Cases

- **Remote cache missing:** automatically resolve and upload the matching helper;
  never ask the user to install or compile it manually.
- **Download unavailable:** keep the terminal/Harness launch surface intact and
  report the target triple plus release URL; never upload unverified bytes.
- **Checksum mismatch:** delete the local temporary download and abort before SSH upload.
- **Unsupported remote OS/architecture:** fail before upload with the normalized
  `uname` values and the supported target list.
- **Protocol mismatch:** replace the versioned cached helper once; if the fresh
  helper still disagrees, abort before lanes.
- **Host key/password needed:** `BatchMode` fails with bounded stderr and tells the user to connect once in a terminal.
- **Focused terminal is not SSH:** omit Current SSH and leave configured profiles available.
- **Focused SSH has no passive CWD:** request an absolute project path; never inject `pwd` into the PTY or silently use remote `$HOME`.
- **Active SSH has no reusable master:** connect separately to the detected destination and state that authentication may be required.
- **Borrowed master disappears:** mark the Harness disconnected and use the resolved descriptor to reconnect through an owned master; never replay an in-flight prompt.
- **Invalid remote path:** hello returns `invalid_workspace`; never fall back to `$HOME`.
- **Same path on two hosts:** host-qualified `workspaceKey` separates memory, peering, usage, and reviews.
- **Reverse-forward failure:** lanes continue without Harness MCP, matching local hook degradation.
- **Drop during write/prompt:** mark outcome unknown, never replay, and refresh Git/files after reconnect.
- **Remote child after channel loss:** companion owns process groups and disposes them on EOF; keepalives bound detection.
- **Remote agent auth missing:** report adapter stderr and require remote CLI auth; copy no local keys or secrets.
- **Agent forwarding:** Krypton never adds `-A` and warns if `ssh -G` reports it enabled.
- **Large prompt:** the 32 MiB cap rejects before partial send and keeps the draft/images staged.
- **Cross-target peering:** allowed across Harnesses, but each Harness stays single-target and labels peers with host-qualified workspace.
- **Unclean exit:** next start checks only its exact runtime id and never uses broad `pkill`.

## Validation

- Rust unit tests cover protocol framing/capabilities, workspace confinement,
  runtime-overlay scoping, the read-only command allowlist, profile validation,
  safe SSH argument reuse, focused-session identity validation, platform
  normalization, versioned paths, and SHA-256 verification.
- TypeScript tests cover picker ordering, missing passive CWD, and host-qualified
  workspace identity; the full existing frontend suite guards the shared
  ACP/Harness UI.
- Direct stdio smoke tests cover hello/shutdown, workspace write/read/remove,
  agent stdout forwarding, and agent exit.
- `npm test`, `npm run check`, `npm run build`, `cargo fmt -- --check`, targeted
  `cargo clippy -D warnings`, and sequential `cargo test --workspace` pass.
- Manual two-machine acceptance remains required for two lanes, gated write, memory, network loss, resume, and clean remote exit.

## Open Questions

None. Version 1 deliberately chooses a per-Harness companion, configured-profile
or focused-SSH launch, remote-owned workspace services, and automatic verified
bootstrap into the remote user's cache.

## Out of Scope

- A general Krypton remote terminal/workspace mode outside ACP Harness.
- Mixing local and remote lanes in one Harness.
- Repository synchronization, SSHFS mounting, or automatic Git cloning.
- Managing SSH keys, passwords, known_hosts, ProxyJump, or SSH config files.
- Forwarding local API keys, keychains, SSH agent, or environment wholesale.
- Installing system packages or writing outside the remote user's cache.
- Keeping agents alive after the Harness closes or across an SSH disconnect.
- Remote Windows hosts in version 1; Linux and macOS remote hosts are supported.
- Direct public TCP/WebSocket access to ACP agents or the hook server.
- Running ACP framing inside or taking ownership of an existing interactive SSH shell.
- Full local-editor integration for remote file paths.
- Remote project-backed ticket/docs/artifact/gallery/review storage and browser rendering.

## Resources

- [Agent Client Protocol Rust SDK protocol](https://github.com/agentclientprotocol/rust-sdk/blob/main/md/protocol-v2.md) — ACP lifecycle and real stdio transport behavior.
- [OpenSSH `ssh(1)` manual](https://man.openbsd.org/ssh) — remote commands, `-T`, ControlMaster, control sockets, keepalives, and loopback port forwarding.
- [Zed Remote Development](https://zed.dev/docs/remote-development) — local UI, version-matched remote server, SSH ControlMaster, reconnect, and remote project services.
- [Zed External Agents](https://zed.dev/docs/ai/external-agents) — ACP process/config/auth boundary and remote-project caveats.
- Zed local checkout `crates/agent_servers/src/acp.rs`, `AcpConnection::stdio` — confirms external-agent commands are resolved through the project's remote client before attaching stdio ACP.
- [VS Code Remote Development using SSH](https://code.visualstudio.com/docs/remote/ssh) — remote server/workspace execution model and limitations of SSHFS/rsync for local tools.
