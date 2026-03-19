# SSH Session Multiplexing — Implementation Spec

> Status: Implemented
> Date: 2026-03-20
> Milestone: M8 — Polish

## Problem

When a user SSHes into a remote host from a Krypton terminal, opening a second terminal to the same host requires a full new SSH connection — re-authenticating, re-negotiating, and adding latency. There's no way to say "give me another shell on this remote, using the connection I already have." Users expect multiplexed remote sessions like tmux/screen provide, but natively integrated into the terminal window manager.

## Solution

Krypton will detect active SSH connections in terminal panes and offer a **"Clone SSH Session"** action that opens a new terminal (tab or window) reusing the same SSH connection via OpenSSH's built-in `ControlMaster` multiplexing. Krypton manages the SSH control sockets automatically — no manual `~/.ssh/config` edits required.

The approach is:
1. **Detect** SSH connections by monitoring the foreground process (existing `process-changed` infrastructure).
2. **Extract** SSH connection details (user, host, port) from the running `ssh` process's command-line args.
3. **Manage** control sockets in a Krypton-owned directory (`~/.config/krypton/ssh-sockets/`).
4. **Clone** sessions by spawning a new PTY with `ssh -S <socket> <user>@<host>` which piggybacks on the master connection — instant, no re-auth.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/ssh.rs` | **New** — SSH detection, control socket management, connection metadata |
| `src-tauri/src/commands.rs` | Add `detect_ssh_session`, `clone_ssh_session` commands |
| `src-tauri/src/lib.rs` | Register new commands, manage `SshManager` state |
| `src-tauri/src/pty.rs` | Minor: expose helper to spawn PTY with specific command (not just shell) |
| `src/compositor.ts` | Add `cloneSSHSession()` method, wire to keybinding and command palette |
| `src/input-router.ts` | Add keybinding for clone action (`Leader C`) |
| `src/command-palette.ts` | Register "Clone SSH Session" action |
| `src-tauri/Cargo.toml` | No new crates needed (uses `std::process::Command`, `libc`, existing deps) |

## Design

### Data Structures

**Rust (`src-tauri/src/ssh.rs`):**

```rust
/// Metadata about a detected SSH connection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnectionInfo {
    pub user: String,
    pub host: String,
    pub port: u16,
    pub pid: u32,
    /// Path to the control socket (if we're managing one)
    pub control_socket: Option<String>,
}

/// Manages SSH connection detection and control socket lifecycle
pub struct SshManager {
    /// socket_dir: ~/.config/krypton/ssh-sockets/
    socket_dir: PathBuf,
    /// Active control master connections: session_id -> SshConnectionInfo
    connections: Mutex<HashMap<u32, SshConnectionInfo>>,
}
```

**TypeScript (in `src/types.ts` or inline):**

```typescript
interface SshConnectionInfo {
  user: string;
  host: string;
  port: number;
  pid: number;
  controlSocket: string | null;
}
```

### API / Commands

| Command | Params | Returns | Description |
|---------|--------|---------|-------------|
| `detect_ssh_session` | `session_id: u32` | `Option<SshConnectionInfo>` | Checks if the given PTY's foreground process is `ssh`, extracts connection details, and optionally promotes it to a ControlMaster |
| `clone_ssh_session` | `session_id: u32, cols: u16, rows: u16` | `u32` (new session_id) | Spawns a new PTY running `ssh -S <socket> user@host` piggybacking on the master |

### Data Flow

#### Detection Flow (user presses `Leader C` or command palette "Clone SSH Session")

```
1. User presses Leader C (or selects from command palette)
2. Frontend: get focused pane's sessionId
3. Frontend: invoke('detect_ssh_session', { sessionId })
4. Backend SshManager:
   a. Call get_foreground_process(session_id) — reuse existing tcgetpgrp() infra
   b. If process name is not "ssh", return None
   c. Read /proc/<pid>/cmdline (Linux) or `ps -p <pid> -o args=` (macOS) to get full ssh command
   d. Parse args to extract: user, host, port (handle user@host, -p port, -l user forms)
   e. Check if this connection already has a control socket
   f. If not: set up a control socket by sending an SSH mux command to the existing connection
      - Run: ssh -O forward -S <socket_path> user@host  (or use -O check to verify)
      - Alternative: The original ssh may not have been started with ControlMaster.
        In that case, we CANNOT retroactively attach a control socket.
        Strategy: Start a NEW background ssh master connection using the same credentials.
        ssh -fNM -S <socket_path> -o ControlMaster=yes user@host -p <port>
        This prompts for password if key auth isn't available — same as a normal ssh.
   g. Store SshConnectionInfo in connections map
   h. Return Some(SshConnectionInfo)
5. Frontend receives info:
   - If None: show notification "No SSH session detected in focused terminal"
   - If Some: proceed to clone
```

#### Clone Flow

```
1. Frontend has SshConnectionInfo from detect step
2. Frontend: invoke('clone_ssh_session', { sessionId, cols, rows })
3. Backend:
   a. Look up SshConnectionInfo for session_id
   b. Build command: ssh -S <control_socket> -o ControlMaster=no <user>@<host> -p <port>
   c. Spawn PTY with this command (instead of default shell)
   d. Return new session_id
4. Frontend:
   a. Create new tab in the same window (default) or new window
   b. Wire new pane to the returned session_id
   c. Terminal connects instantly (reuses master connection, no re-auth)
```

#### Simplified Alternative (ControlMaster auto-config)

Instead of managing sockets ourselves, we can configure Krypton-spawned shells to use ControlMaster automatically:

```
1. On PTY spawn, set SSH_AUTH_SOCK and inject SSH config:
   env SSH_CONFIG="-o ControlMaster=auto -o ControlPath=~/.config/krypton/ssh-sockets/%r@%h:%p -o ControlPersist=600"
2. Actually: set these via ~/.ssh/config or via ssh_config(5) Include directive
```

**Chosen approach: Hybrid.** Krypton will:
- Detect active SSH connections via process inspection
- For cloning, spawn `ssh -S <path> -o ControlMaster=auto -o ControlPath=<krypton_dir>/%r@%h:%p user@host`
- The first connection becomes the master automatically, subsequent ones multiplex

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader C` | Compositor mode | Clone SSH session from focused pane (opens in new tab) |
| `Leader Shift+C` | Compositor mode | Clone SSH session from focused pane (opens in new window) |

### UI Changes

- **Titlebar indicator**: When an SSH connection is detected, the titlebar PTY status shows `SSH: user@host` instead of just the CWD.
- **Notification toast**: "No SSH session detected" if user tries to clone a non-SSH terminal.

### Configuration

```toml
[ssh]
enabled = true                                          # Master toggle
control_socket_dir = "~/.config/krypton/ssh-sockets"   # Socket directory
control_persist = 600                                   # Seconds to keep master alive after last session
clone_target = "tab"                                    # Default target: "tab" or "window"
```

## Edge Cases

1. **SSH process not in foreground** (user is in vim over SSH) — `tcgetpgrp()` returns vim, not ssh. Solution: walk the process tree upward to find the ssh ancestor process.
2. **Nested SSH** (ssh into host A, then ssh into host B) — detect the innermost ssh. The clone will connect to the same host as the detected ssh process.
3. **SSH with jump hosts** (`ssh -J jump host`) — parse `-J` from args and include in clone command.
4. **Key-based auth only, no agent** — if the original connection used a key file (`-i`), parse and include it in clone.
5. **Control socket already exists** — `ControlMaster=auto` handles this: if socket exists, use it; if not, become master.
6. **Master connection drops** — the cloned session dies like any ssh session. No special handling needed.
7. **Socket directory cleanup** — on Krypton exit, clean up stale sockets. Also clean on startup.
8. **Permission on sockets** — ensure socket dir is `0700` for security.
9. **Non-OpenSSH implementations** — Only OpenSSH supports `ControlMaster`. Detect via `ssh -V` at startup. If not OpenSSH, disable the feature gracefully.
10. **Windows/WSL** — `ControlMaster` is Unix-only. Feature is disabled on Windows (unless WSL).

## Out of Scope

- **Built-in SSH client** — We're not integrating `russh` or `libssh2`. We rely on the system's `ssh` binary.
- **SSH key management** — Krypton doesn't manage keys, agents, or known_hosts.
- **Remote file browsing** — No SFTP/SCP integration.
- **SSH config editing UI** — Users manage `~/.ssh/config` themselves.
- **Persistent SSH sessions across Krypton restarts** — Control sockets are cleaned up on exit.
