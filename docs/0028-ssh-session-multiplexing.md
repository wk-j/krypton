# SSH Session Multiplexing — Implementation Spec

> Status: Implemented
> Date: 2026-03-20
> Milestone: M8 — Polish

## Problem

When a user SSHes into a remote host from a Krypton terminal, opening a second terminal to the same host requires a full new SSH connection — re-authenticating, re-negotiating, and adding latency. There's no way to say "give me another shell on this remote, using the connection I already have." Users expect multiplexed remote sessions like tmux/screen provide, but natively integrated into the terminal window manager.

Additionally, the cloned session should start in the **same working directory** as the original — not the remote home directory.

## Solution

Krypton detects active SSH connections in terminal panes and offers a **"Clone SSH Session"** action that opens a new terminal (tab or window) reusing the same SSH connection via OpenSSH's built-in `ControlMaster` multiplexing. Krypton manages the SSH control sockets automatically — no manual `~/.ssh/config` edits required.

The cloned session inherits the remote working directory via a **frontend PTY probe** that invisibly queries `pwd` on the remote shell before spawning the clone.

The approach is:
1. **Detect** SSH connections by inspecting the process tree under the PTY shell (via `sysinfo`).
2. **Extract** SSH connection details (user, host, port, extra args) from the running `ssh` process's command-line args.
3. **Manage** control sockets in a Krypton-owned directory (`~/.config/krypton/ssh-sockets/`).
4. **Probe** the remote CWD invisibly through the existing PTY (stty -echo + OSC 7337 escape sequence).
5. **Clone** sessions by spawning a new PTY with `ssh -o ControlPath=<socket> -o ControlMaster=auto <user>@<host>` which piggybacks on the master connection — instant, no re-auth — and `cd`s into the probed remote directory.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/ssh.rs` | **New** — `SshConnectionInfo`, `SshManager` (detect, clone command, remote CWD tracking, hostname filtering) |
| `src-tauri/src/commands.rs` | Add `detect_ssh_session`, `clone_ssh_session`, `set_ssh_remote_cwd` commands |
| `src-tauri/src/lib.rs` | Register new commands, manage `SshManager` state |
| `src-tauri/src/pty.rs` | Minor: expose helper to spawn PTY with specific command (not just shell) |
| `src/compositor.ts` | Add `probeRemoteCwd()`, `cloneSshSession()`, `cloneSshSessionToNewWindow()` methods; OSC 7 hostname filtering in `parseOsc7()` |
| `src/input-router.ts` | Add keybindings: `Leader c` (clone to tab), `Leader C` (clone to window) |
| `src/command-palette.ts` | Register "Clone SSH Session (New Tab)" and "Clone SSH Session (New Window)" actions |
| `src-tauri/Cargo.toml` | Add `hostname = "0.4"` crate for local hostname detection |

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
    /// Path to the ControlMaster socket managed by Krypton.
    pub control_socket: Option<String>,
    /// Additional SSH args to preserve (e.g., -i keyfile, -J jumphost).
    pub extra_args: Vec<String>,
}

/// Manages SSH connection detection and control socket lifecycle.
pub struct SshManager {
    /// socket_dir: ~/.config/krypton/ssh-sockets/
    socket_dir: PathBuf,
    /// Cached connection info per PTY session ID.
    connections: Mutex<HashMap<u32, SshConnectionInfo>>,
    /// Last-known remote CWD per session, reported by frontend via OSC 7.
    remote_cwds: Mutex<HashMap<u32, String>>,
    /// Seconds to keep a ControlMaster alive after the last client disconnects.
    control_persist: u64,
    /// Local hostname, cached at startup for filtering OSC 7 CWD updates.
    local_hostname: String,
}
```

**TypeScript (in `src/compositor.ts`):**

```typescript
interface SshConnectionInfo {
  user: string;
  host: string;
  port: number;
  controlSocket: string | null;
  extraArgs: string[];
}
```

### API / Commands

| Command | Params | Returns | Description |
|---------|--------|---------|-------------|
| `detect_ssh_session` | `session_id: u32` | `Option<SshConnectionInfo>` | Walks the PTY's process tree to find an `ssh` process, extracts connection details |
| `clone_ssh_session` | `session_id: u32, cols: u16, rows: u16, remote_cwd: Option<String>` | `u32` (new session_id) | Spawns a new PTY running `ssh -o ControlPath=... user@host` with optional `cd <remote_cwd>` |
| `set_ssh_remote_cwd` | `session_id: u32, cwd: String, hostname: String` | `()` | Stores remote CWD from OSC 7, filtered by hostname (ignores local CWD updates) |
| `write_to_pty` | `session_id: u32, data: Vec<u8>` | `()` | Writes raw bytes to a PTY (used by the frontend CWD probe) |

### Data Flow

#### Detection Flow (user presses `Leader c` or command palette "Clone SSH Session")

```
1. User presses Leader c (or selects from command palette)
2. Frontend: get focused pane's sessionId
3. Frontend: invoke('detect_ssh_session', { sessionId })
4. Backend SshManager.detect():
   a. Check cache — return immediately if this session was already detected
   b. Call pty_manager.get_shell_pid(session_id) to get the PTY's shell PID
   c. Walk the process tree downward (via sysinfo) looking for an "ssh" process
   d. If no ssh process found via sysinfo, fall back to `ps -o ppid,pid,comm`
   e. Read SSH process's command line from sysinfo (or ps fallback on macOS)
   f. Parse args: extract user, host, port, identity files, jump hosts, extra args
   g. Assign control socket path: ~/.config/krypton/ssh-sockets/<user>@<host>:<port>
   h. Cache SshConnectionInfo and return it
5. Frontend receives SshConnectionInfo (or null → show "No SSH session" toast)
```

#### Remote CWD Probing (invisible PTY probe)

```
1. Frontend: probeRemoteCwd(sessionId) called before clone
2. Generate unique marker: __KR_<timestamp>_<random>__
3. Listen on raw 'pty-output' events for OSC 7337 response
4. Write probe command to PTY via invoke('write_to_pty'):
   \r\x1b[2K                                      — CR + erase line (clear prompt)
    stty -echo;                                    — suppress TTY echo
    printf '\033]7337;<marker>;%s\007' "$(pwd)";   — emit CWD as private OSC escape
    stty echo\n                                    — restore echo + execute
5. Remote shell executes the compound command:
   - stty -echo prevents the command and printf output from appearing
   - printf emits ESC ] 7337 ; <marker> ; <cwd> BEL
   - OSC 7337 is a private-use sequence that xterm.js silently discards
   - But raw bytes still flow through pty-output events before xterm processing
6. Frontend listener captures <cwd> from the OSC 7337 response
7. stty echo restores normal terminal echo; shell prints a fresh prompt
8. Return cwd (or null on 3-second timeout)
```

**Why OSC 7337?** Standard OSC codes (like OSC 7) would be interpreted by xterm.js and might trigger side effects. OSC 7337 is in the private-use range — xterm.js silently ignores it, but the raw bytes are still delivered via the `pty-output` Tauri event before xterm.js processes them.

**Why stty -echo?** Without it, the remote TTY driver echoes every character we type back to the terminal. With `stty -echo`, neither the command text nor the printf output appear in the terminal. The user sees nothing.

#### Clone Flow

```
1. Frontend has SshConnectionInfo from detect step
2. Frontend: probeRemoteCwd(sessionId) — gets remote CWD (or null)
3. Frontend: creates new tab (DOM elements, pane, xterm.js instance)
4. Frontend: invoke('clone_ssh_session', { sessionId, cols, rows, remoteCwd })
5. Backend clone_ssh_session():
   a. Call detect() to get/verify SshConnectionInfo
   b. Use provided remote_cwd, or fall back to get_remote_cwd() (OSC 7 tracked)
   c. Build command via build_clone_command():
      ssh -o ControlPath=<socket> -o ControlMaster=auto -o ControlPersist=600
          [-p port] [extra_args...] [-t] user@host [cd '<cwd>' && exec $SHELL -l]
   d. Call pty_manager.spawn() with this ssh command (not the default shell)
   e. Return new session_id
6. Compositor: registers new session in sessionMap, wires input
7. xterm.js connects instantly (ControlMaster reuses existing TCP connection)
8. Shell starts in the same directory as the source terminal
9. Titlebar updated to show "SSH: user@host"
```

#### OSC 7 Remote CWD Tracking (passive, background)

```
1. Remote shell emits OSC 7: \033]7;file://<hostname>/<path>\007
   (Requires shell configuration on the remote server — not always available)
2. Frontend parseOsc7(): extracts hostname and path from the URI
3. Frontend: invoke('set_ssh_remote_cwd', { sessionId, cwd, hostname })
4. Backend SshManager.set_remote_cwd():
   a. Compare hostname against local_hostname (cached at startup via `hostname` crate)
   b. If hostname is "" / "localhost" / matches local_hostname → ignore (local CWD)
   c. If hostname is different → store as remote CWD for this session
5. On clone, get_remote_cwd() returns the last-stored remote CWD as a fallback
   (used when probeRemoteCwd() fails or times out)
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader c` | Compositor mode | Clone SSH session from focused pane (opens in new tab) |
| `Leader C` (Shift+c) | Compositor mode | Clone SSH session from focused pane (opens in new window) |

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

1. **SSH process not in foreground** (user is in vim over SSH) — `detect()` walks the process tree from the PTY shell *downward* through children, finding the `ssh` process regardless of which child is in the foreground.
2. **Nested SSH** (ssh into host A, then ssh into host B) — detects the innermost ssh. The clone will connect to the same host as the detected ssh process.
3. **SSH with jump hosts** (`ssh -J jump host`) — parses `-J` from args and includes it in `extra_args`, which are passed to the clone command.
4. **Key-based auth with explicit key file** (`-i`) — parsed and included in `extra_args`.
5. **Control socket already exists** — `ControlMaster=auto` handles this: if socket exists, use it; if not, become master.
6. **Master connection drops** — the cloned session dies like any ssh session. No special handling needed.
7. **Socket directory cleanup** — on Krypton exit, clean up stale sockets. Also clean on startup.
8. **Permission on sockets** — socket dir is created with `0700` for security.
9. **Remote shell doesn't emit OSC 7** — the probeRemoteCwd() PTY probe handles this case by directly running `pwd` on the remote shell.
10. **stty -echo probe timeout** — if the remote shell doesn't respond within 3 seconds, the probe returns null and the clone starts in the home directory.
11. **Non-OpenSSH implementations** — Only OpenSSH supports `ControlMaster`. Detect via `ssh -V` at startup. If not OpenSSH, disable the feature gracefully.
12. **Windows/WSL** — `ControlMaster` is Unix-only. Feature is disabled on Windows (unless WSL).

## Out of Scope

- **Built-in SSH client** — We're not integrating `russh` or `libssh2`. We rely on the system's `ssh` binary.
- **SSH key management** — Krypton doesn't manage keys, agents, or known_hosts.
- **Remote file browsing** — No SFTP/SCP integration.
- **SSH config editing UI** — Users manage `~/.ssh/config` themselves.
- **Persistent SSH sessions across Krypton restarts** — Control sockets are cleaned up on exit.
