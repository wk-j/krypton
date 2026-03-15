# Java Extension: Process Tree Ownership — Implementation Spec

> Status: Implemented
> Date: 2026-03-15
> Milestone: M8 — Polish (bug fix)

## Problem

When multiple Java services run simultaneously, the Java extension can't tell which process belongs to which terminal window. The current approach (`find_java_server_by_cwd`) searches **all system java processes** by CWD match, so terminals in the same directory see the same (wrong) service. Each terminal should only show the Java process(es) it spawned.

## Solution

Switch from CWD-based lookup to **process tree ownership**: walk descendants of the terminal's shell PID to find java servers. The command `find_java_server_for_session` already exists and does this correctly — the frontend just calls the wrong one. Additionally, return **all** matching java servers (not just the first) so terminals that spawn multiple services show all of them.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/pty.rs` | `find_java_server_pid` → `find_java_servers_pid`, returns `Vec<JavaServerInfo>` |
| `src-tauri/src/commands.rs` | `find_java_server_for_session` returns `Vec<JavaServerInfo>` |
| `src/extensions/java.ts` | Call `find_java_server_for_session`; render one top bar row per server; poll stats for each PID |
| `src/types.ts` | No change needed (`JavaServerInfo` type is already correct) |
| `src/styles.css` | Add `.krypton-extension-bar__server` for multi-server row styling |

## Design

### Backend Changes

`find_server_among` → `find_servers_among`, returns all matches instead of first:

```rust
fn find_servers_among(
    sys: &System,
    pids: &[sysinfo::Pid],
    listening: &HashMap<u32, u16>,
) -> Vec<JavaServerInfo> {
    let mut result = Vec::new();
    for &pid in pids {
        if let Some(&port) = listening.get(&pid.as_u32()) {
            let cmdline = /* ... same as before ... */;
            let main_class = extract_java_main_class(&cmdline);
            result.push(JavaServerInfo { pid: pid.as_u32(), port, main_class, cmdline });
        }
    }
    result
}

pub fn find_java_servers_pid(root_pid: u32) -> Vec<JavaServerInfo> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut java_pids = Vec::new();
    collect_java_pids_native(&sys, Pid::from_u32(root_pid), &mut java_pids, 0, 10);
    let listening = get_listening_ports();
    find_servers_among(&sys, &java_pids, &listening)
}
```

Command:
```rust
#[tauri::command]
pub fn find_java_server_for_session(
    pty_manager: State<'_, Arc<PtyManager>>,
    session_id: u32,
) -> Vec<JavaServerInfo> {
    let Some(shell_pid) = pty_manager.get_shell_pid(session_id) else {
        return Vec::new();
    };
    find_java_servers_pid(shell_pid)
}
```

### Frontend Changes

The java extension's `createWidgets()` changes:

1. Call `find_java_server_for_session` (process tree) instead of `find_java_server_by_cwd` (CWD match)
2. On success, display **all** returned servers in the top bar (one line per server)
3. Poll stats for **each** server PID on the 2s interval
4. Update all rows in the bottom panel

**Top bar** shows each server on its own line:
```
[JAVA] TliApiApplication  PID 58558  :9090
[JAVA] PaymentService     PID 58602  :8080
```

**Bottom panel** shows stats for the first (primary) server. If there's only one server, behavior is identical to today.

### Data Flow

```
1. Java process detected by foreground poll → extension activates
2. Extension calls invoke('find_java_server_for_session', { sessionId })
   — backend walks shell's process tree, returns Vec<JavaServerInfo>
3. If 0 results: retry (same as today)
4. If 1+ results: populate top bar with one row per server
5. Stats polling uses first server's PID (primary) for the bottom panel
6. All server PIDs tracked; if any server exits, top bar row removed on next poll
```

## Edge Cases

| Case | Handling |
|------|----------|
| 1 java server per terminal | Identical to current behavior |
| Multiple servers in one terminal | Top bar shows all; bottom panel shows primary (first found) |
| Server spawned by script (not direct child) | `collect_java_pids_native` walks 10 levels deep — catches most cases |
| Two terminals, same CWD, different java processes | Each terminal walks its own shell PID's subtree — correct isolation |
| Server exits while others remain | Top bar row removed on next discovery poll; stats switches to next server |

## Out of Scope

- Per-server bottom panels (one stats panel per java process) — too much vertical space
- Multiple listening ports per process (`HashMap<u32, u16>` only stores first port per PID)
- Removing `find_java_server_by_cwd` command — kept for backward compatibility
