# Context-Aware Extensions — Implementation Spec

> Status: Implemented
> Date: 2026-03-15
> Milestone: M8 — Polish (new subsystem)

## Problem

Users want app-specific widgets and behaviors that automatically activate when a particular program (e.g., `java`, `vim`, `ssh`) is running in a terminal pane. Currently, Krypton has no way to detect the foreground process or render custom overlay widgets tied to process context.

## Solution

Add a **process detection** backend service that polls the foreground process of each active PTY session, and a **context extension** system on the frontend that matches process names to **built-in, system-level extensions** hardcoded in TypeScript. Each extension renders **widget bars at the top and/or bottom** of the terminal window when its trigger process is detected, and removes them when the process exits.

**No user-defined/custom extensions.** All extensions are part of Krypton's source code.

**Widgets are horizontal bars only** — rendered at the top and/or bottom edge of the terminal window's content area. Bars take real layout space (the terminal resizes via `addon-fit` to accommodate them).

**First built-in extension: Java Resource Monitor** — shows JVM heap usage, GC stats, and OS-level CPU/memory for running Java processes using `jstat` and `ps`. Uses **process tree ownership** to correctly identify which Java server belongs to which terminal.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/pty.rs` | Add `get_foreground_process()` using `tcgetpgrp`. Add `find_java_servers_pid()` (process tree walk) and `find_servers_among()` returning `Vec<JavaServerInfo>` |
| `src-tauri/src/commands.rs` | Add `get_foreground_process`, `get_java_stats`, `find_java_server_for_session` (returns `Vec<JavaServerInfo>`) Tauri commands |
| `src-tauri/src/lib.rs` | Register new commands, add process poll timer emitting `process-changed` events |
| `src-tauri/src/config.rs` | Add `[extensions]` config section (enabled toggle + poll interval) |
| `src/extensions.ts` | `ExtensionManager`: registry of built-in extensions, trigger matching, widget lifecycle. Uses `.krypton-pane__terminal` as reference node for insertion. Single rAF refit |
| `src/extensions/java.ts` | Java Resource Monitor extension. Calls `find_java_server_for_session` (process tree). Multi-server top bar, bottom stats panel |
| `src/compositor.ts` | Create `.krypton-pane__terminal` wrapper inside each pane. Pane is always `display: flex; flex-direction: column`. Wire `process-changed` event to `ExtensionManager` |
| `src/types.ts` | Add `ContextExtension`, `ExtensionWidget`, `ProcessInfo`, `ActiveExtension`, `JavaStats`, `JavaServerInfo` types |
| `src/config.ts` | Add `ExtensionsConfig` TypeScript interface |
| `src/styles.css` | Pane: always flex column. `.krypton-pane__terminal`: `flex: 1; min-height: 0; overflow: hidden`. Extension bars: `flex-shrink: 0`. Multi-server row styling |

## Design

### Process Detection (Rust Backend)

`portable-pty` gives us the **shell PID**. The actual running program (e.g., `java`) is in the **foreground process group**. We use `tcgetpgrp()` on the PTY master fd to detect it.

#### Data Structures

```rust
#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,          // e.g., "java", "vim", "ssh"
    pub cmdline: Vec<String>,  // e.g., ["java", "-jar", "app.jar"]
}
```

#### Implementation (macOS + Linux)

```rust
use std::os::unix::io::AsRawFd;

impl PtyManager {
    pub fn get_foreground_process(&self, session_id: u32) -> Option<ProcessInfo> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&session_id)?;
        let fd = session.master.as_raw_fd();

        let pgrp = unsafe { libc::tcgetpgrp(fd) };
        if pgrp <= 0 { return None; }
        let pid = pgrp as u32;

        let name = self.get_process_name(pid)?;
        let cmdline = self.get_process_cmdline(pid).unwrap_or_default();

        Some(ProcessInfo { pid, name, cmdline })
    }

    #[cfg(target_os = "macos")]
    fn get_process_name(&self, pid: u32) -> Option<String> {
        let output = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output().ok()?;
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let base = name.rsplit('/').next().unwrap_or(&name).to_string();
        if base.is_empty() { None } else { Some(base) }
    }

    #[cfg(target_os = "linux")]
    fn get_process_name(&self, pid: u32) -> Option<String> {
        std::fs::read_to_string(format!("/proc/{}/comm", pid))
            .ok()
            .map(|s| s.trim().to_string())
    }
}
```

#### Polling & Event Emission

A background thread in `lib.rs` polls all active sessions every **500ms** (configurable). When a session's foreground process changes, it emits a `process-changed` Tauri event:

```rust
#[derive(Clone, Serialize)]
struct ProcessChangedPayload {
    session_id: u32,
    process: Option<ProcessInfo>,  // None = shell idle
    previous: Option<String>,      // previous process name
}
```

The poller tracks `last_known: HashMap<u32, Option<String>>` to only emit on actual changes.

### Java Resource Monitoring (Rust Backend)

#### Process Tree Ownership

Each terminal's shell PID is the root of its process tree. To find Java servers belonging to a specific terminal, we walk descendants of the shell PID (up to 10 levels deep) and return **all** java processes that have a TCP listening port.

```rust
pub struct JavaServerInfo {
    pub pid: u32,
    pub port: u16,
    pub main_class: String,
    pub cmdline: Vec<String>,
}

/// Find all Java server processes among descendants of a root PID.
pub fn find_java_servers_pid(root_pid: u32) -> Vec<JavaServerInfo> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut java_pids = Vec::new();
    collect_java_pids_native(&sys, Pid::from_u32(root_pid), &mut java_pids, 0, 10);
    let listening = get_listening_ports();
    find_servers_among(&sys, &java_pids, &listening)
}

/// Among a set of java PIDs, find all that have a listening port.
fn find_servers_among(sys: &System, pids: &[Pid], listening: &HashMap<u32, u16>) -> Vec<JavaServerInfo> {
    let mut result = Vec::new();
    for &pid in pids {
        if let Some(&port) = listening.get(&pid.as_u32()) {
            let cmdline = /* sysinfo or ps fallback */;
            let main_class = extract_java_main_class(&cmdline);
            result.push(JavaServerInfo { pid: pid.as_u32(), port, main_class, cmdline });
        }
    }
    result
}
```

**Why process tree, not CWD match:** CWD-based lookup (`find_java_server_by_cwd`) searches all system java processes and matches by directory. If two terminals share the same CWD, they see each other's services. Process tree ownership is exact — terminal A's shell PID only has terminal A's descendants.

#### `find_java_server_for_session` Command

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

#### `get_java_stats` Command

```rust
#[derive(Debug, Clone, Serialize)]
pub struct JavaStats {
    // JVM heap (from jstat -gc <pid>)
    pub heap_used_mb: f64,
    pub heap_max_mb: f64,
    pub heap_percent: f64,
    pub gc_count: u64,
    pub gc_time_secs: f64,

    // OS-level (from ps -p <pid> -o %cpu,rss)
    pub cpu_percent: f64,
    pub rss_mb: f64,

    // Process info
    pub pid: u32,
    pub main_class: String,
}

#[tauri::command]
fn get_java_stats(pid: u32) -> Result<JavaStats, String> {
    // 1. Run: jstat -gc <pid>  →  parse heap/GC columns
    // 2. Run: ps -p <pid> -o %cpu=,rss=  →  parse CPU% and RSS
    // 3. Return combined JavaStats
}
```

Stats are polled by the frontend on a **2-second interval**, only while the Java extension is active.

### Extension Definition (System-Level TypeScript)

#### Type Definitions

```typescript
interface ProcessInfo {
  pid: number;
  name: string;
  cmdline: string[];
}

type WidgetPosition = 'top' | 'bottom';

interface ContextExtension {
  name: string;
  description: string;
  processNames: string[];
  createWidgets(process: ProcessInfo, sessionId: SessionId): ExtensionWidget[];
  updateWidgets?(widgets: ExtensionWidget[], process: ProcessInfo): void;
  destroyWidgets?(widgets: ExtensionWidget[]): void;
}

interface ExtensionWidget {
  element: HTMLElement;
  position: WidgetPosition;
  dispose?: () => void;
}

interface ActiveExtension {
  extension: ContextExtension;
  widgets: ExtensionWidget[];
  process: ProcessInfo;
}

interface JavaServerInfo {
  pid: number;
  port: number;
  main_class: string;
  cmdline: string[];
}

interface JavaStats {
  heap_used_mb: number;
  heap_max_mb: number;
  heap_percent: number;
  gc_count: number;
  gc_time_secs: number;
  cpu_percent: number;
  rss_mb: number;
  pid: number;
  main_class: string;
}
```

#### Java Resource Monitor Extension

The java extension discovers servers via process tree ownership (`find_java_server_for_session`) and supports **multiple servers per terminal**.

- **Top bar**: One row per server showing main class, PID, and port
- **Bottom panel**: Heap gauge + GC/CPU/RSS metrics for the primary (first) server
- **Re-discovery**: Every 10 seconds, re-queries the process tree to catch new/exited servers

```typescript
export const javaExtension: ContextExtension = {
  name: 'java-monitor',
  description: 'JVM resource monitor — heap, GC, CPU, memory',
  processNames: ['java'],

  createWidgets(_process, sessionId) {
    // Top bar: shows "Searching..." then populates with server rows
    // Bottom panel: heap gauge + GC/CPU/RSS metrics

    // 1. Call find_java_server_for_session (process tree, returns Vec)
    // 2. On success: render one row per server in top bar
    // 3. Start 2s stats poll for primary server
    // 4. Every 5th poll (10s): re-discover servers to catch changes

    return [
      { element: topBar, position: 'top' },
      { element: bottomBar, position: 'bottom', dispose: () => { /* clear intervals */ } },
    ];
  },
};
```

**Multi-server top bar** (when 2+ servers found):
```
[JAVA] TliApiApplication  PID 58558  :9090
[JAVA] PaymentService     PID 58602  :8080
```

#### Extension Registry

```typescript
import { javaExtension } from './extensions/java';

const EXTENSIONS: ContextExtension[] = [
  javaExtension,
  // Future: sshExtension, vimExtension, etc.
];
```

### Widget Layout Model

```
+--Window Chrome (titlebar)--------------------------+
| +-- Top bar ------------------------------------+ |
| |  [JAVA]  TliApiApplication  PID 58558  :9090   | |
| |  [JAVA]  PaymentService    PID 58602  :8080   | |
| +------------------------------------------------+ |
|                                                     |
|   xterm.js terminal content                         |
|   (fills remaining space via flex: 1)               |
|                                                     |
| +-- Bottom panel --------------------------------+ |
| |  HEAP ██████░░ 67%  342/512 MB                 | |
| |  GC: 14 (0.8s)  CPU: 12.3%  RSS: 580 MB       | |
| +------------------------------------------------+ |
+--Window Chrome (bottom bar, corners)----------------+
```

#### Layout strategy — always flex column

The pane is **always** `display: flex; flex-direction: column`, not just when an extension is active. This eliminates the layout mode switch that caused terminal overflow:

```
.krypton-pane              flex-direction: column
  [extension top bar]      flex-shrink: 0  (only present when active)
  .krypton-pane__terminal  flex: 1; min-height: 0; overflow: hidden
    .xterm                 height: 100%; width: 100%  (unchanged)
  [extension bottom bar]   flex-shrink: 0  (only present when active)
```

**Why this works:**
1. The pane is always flex column. No CSS class toggle changes the layout mode.
2. Bars are `flex-shrink: 0` — they keep their intrinsic height (never compressed).
3. The terminal container (`.krypton-pane__terminal`) is `flex: 1; min-height: 0` — it fills whatever space remains after bars.
4. `overflow: hidden` on the terminal container clips xterm if it momentarily oversizes.
5. When bars are inserted or removed, the flex algorithm instantly recomputes — a single `fitAddon.fit()` in one `requestAnimationFrame` is sufficient.

Key behavior:
- Bars are **inside** the pane, above/below the terminal container
- When bars appear/disappear, a single `fitAddon.fit()` in one rAF is sufficient
- Bars take real layout space — they do NOT float over terminal content
- The `.krypton-pane--has-extension` class is still added for styling hooks but does NOT change the layout mode

### Frontend Architecture

```
process-changed event (from Rust poller, every 500ms)
  |
  v
ExtensionManager.onProcessChanged(sessionId, processInfo)
  |
  v
[Find pane by sessionId via compositor.sessionMap]
  |
  v
[Match process.name against EXTENSIONS[].processNames]
  |
  +-- Match found, extension NOT already active on this pane
  |     -> activateExtension(pane, extension, processInfo)
  |        -> call extension.createWidgets(process, sessionId)
  |        -> find .krypton-pane__terminal inside the pane element
  |        -> insert top widgets before __terminal (pane.insertBefore)
  |        -> append bottom widgets after __terminal (pane.appendChild)
  |        -> add .krypton-pane--has-extension class (styling only)
  |        -> single requestAnimationFrame → fitAddon.fit() + resize_pty
  |        -> store in paneExtensions map
  |        -> (Java ext calls find_java_server_for_session, starts stats poll)
  |
  +-- Match found, SAME extension already active
  |     -> call extension.updateWidgets(widgets, processInfo) if defined
  |
  +-- Match found, DIFFERENT extension already active
  |     -> deactivateExtension(pane)
  |     -> activateExtension(pane, newExt, processInfo)
  |
  +-- No match, extension WAS active
        -> deactivateExtension(pane)
           -> call widget.dispose() on each widget (clears intervals)
           -> remove bar elements from DOM
           -> remove .krypton-pane--has-extension class
           -> single requestAnimationFrame → fitAddon.fit() + resize_pty
           -> remove from paneExtensions map
```

#### ExtensionManager Class

```typescript
class ExtensionManager {
  private paneExtensions: Map<PaneId, ActiveExtension> = new Map();
  private host: ExtensionHost;
  private enabled: boolean = true;

  constructor(host: ExtensionHost);

  onProcessChanged(sessionId: number, process: ProcessInfo | null): void;
  private findExtension(processName: string): ContextExtension | null;

  /**
   * Uses paneElement.querySelector('.krypton-pane__terminal') as the reference
   * node: top widgets go before it, bottom widgets go after it.
   * Single requestAnimationFrame → refitPane() (no double refit).
   */
  private activateExtension(
    paneId: PaneId, paneElement: HTMLElement,
    ext: ContextExtension, process: ProcessInfo, sessionId: SessionId
  ): void;

  private deactivateExtension(paneId: PaneId): void;
  onPaneDestroyed(paneId: PaneId): void;
  setEnabled(enabled: boolean): void;
}
```

### Data Flow

```
1. Rust poller thread ticks every 500ms
2. For each active session: call get_foreground_process(session_id)
3. Compare with last_known process name for that session
4. If changed: emit Tauri event "process-changed" { session_id, process, previous }
5. Frontend: ExtensionManager receives event, finds pane via sessionMap
6. Matches process.name against EXTENSIONS registry
7. On match ("java"): activates Java extension
   a. createWidgets() builds top bar + bottom panel
   b. Bars inserted relative to .krypton-pane__terminal
   c. Single requestAnimationFrame → fitAddon.fit() + resize_pty
   d. Extension calls invoke('find_java_server_for_session', { sessionId })
      — backend walks shell PID's process tree, returns Vec<JavaServerInfo>
   e. Top bar populated with one row per server
   f. Stats poll starts for primary server (2s interval via get_java_stats)
   g. Re-discovery every 10s to catch new/exited servers
8. On unmatch (java exits): deactivates extension
   a. clearInterval on stats poller
   b. Remove bar elements from DOM
   c. Single requestAnimationFrame → fitAddon.fit() + resize_pty
```

### Configuration

```toml
# ~/.config/krypton/krypton.toml

[extensions]
enabled = true            # master toggle for all context extensions
poll_interval_ms = 500    # how often to check foreground process (ms)
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_500")]
    pub poll_interval_ms: u64,
}
```

### UI Changes

#### Pane DOM Structure

The `.krypton-pane` is **always** `display: flex; flex-direction: column`. The xterm terminal lives inside a dedicated `.krypton-pane__terminal` wrapper. Extension bars are inserted as siblings before/after this wrapper.

**Normal pane (no extension):**
```html
<div class="krypton-pane" data-pane-id="pane-0">
  <div class="krypton-pane__terminal">
    <div class="xterm"><!-- xterm.js canvas --></div>
  </div>
</div>
```

**Pane with Java extension active (2 servers):**
```html
<div class="krypton-pane krypton-pane--has-extension" data-pane-id="pane-0">
  <!-- TOP bar with server rows -->
  <div class="krypton-extension-bar krypton-extension-bar--accent">
    <div class="krypton-extension-bar__server">
      <span class="krypton-extension-bar__label">JAVA</span>
      <span class="krypton-extension-bar__content">TliApiApplication</span>
      <span class="krypton-extension-bar__stat">PID 58558</span>
      <span class="krypton-extension-bar__stat">:9090</span>
    </div>
    <div class="krypton-extension-bar__server">
      <span class="krypton-extension-bar__label">JAVA</span>
      <span class="krypton-extension-bar__content">PaymentService</span>
      <span class="krypton-extension-bar__stat">PID 58602</span>
      <span class="krypton-extension-bar__stat">:8080</span>
    </div>
  </div>

  <!-- Terminal wrapper -->
  <div class="krypton-pane__terminal">
    <div class="xterm"><!-- xterm.js canvas --></div>
  </div>

  <!-- BOTTOM panel (stats for primary server) -->
  <div class="krypton-java-panel">
    <!-- heap gauge + GC/CPU/RSS metrics -->
  </div>
</div>
```

#### CSS Classes

```css
.krypton-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.krypton-pane__terminal {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.krypton-pane__terminal .xterm {
  height: 100%;
  width: 100%;
  padding: 4px 6px;
}

.krypton-extension-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  font-family: var(--krypton-font-family);
  font-size: 11px;
  background: rgba(0, 0, 0, 0.5);
  flex-shrink: 0;
  flex-grow: 0;
}

.krypton-extension-bar--accent {
  background: rgba(var(--krypton-window-accent-rgb), 0.08);
  border-bottom: 1px solid rgba(var(--krypton-window-accent-rgb), 0.3);
  flex-wrap: wrap;  /* stack multi-server rows vertically */
}

.krypton-extension-bar__server {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.krypton-extension-bar__server + .krypton-extension-bar__server {
  border-top: 1px solid rgba(var(--krypton-window-accent-rgb), 0.1);
  padding-top: 4px;
  margin-top: 2px;
}

.krypton-java-panel {
  flex-shrink: 0;
  flex-grow: 0;
  border-top: 1px solid rgba(var(--krypton-window-accent-rgb), 0.15);
}

.krypton-pane--has-extension {
  /* styling hook only — no layout overrides */
}
```

## Edge Cases

| Case | Handling |
|------|----------|
| Process exits faster than poll interval | Next poll detects shell is foreground, deactivates extension. Max latency = 500ms |
| Multiple extensions match same process | First match in `EXTENSIONS` array wins |
| Pane destroyed while extension active | `onPaneDestroyed()` calls `dispose()` on each widget (clears intervals), removes from map |
| PTY exits while extension active | `pty-exit` triggers pane cleanup, which calls `onPaneDestroyed()` |
| `tcgetpgrp` fails | Return `None` — "shell idle", deactivate any active extension |
| Shell is foreground process | No extension matches `zsh`/`bash`/`fish`, no bars shown |
| `jstat` not installed (no JDK) | `get_java_stats` returns error; bottom bar shows "jstat unavailable — install JDK for metrics" |
| 1 java server per terminal | Single server row in top bar, stats for that server. Identical to single-server UX |
| Multiple java servers in one terminal | Top bar shows one row per server; bottom panel shows primary (first found) |
| Two terminals, same CWD, different java processes | Process tree ownership: each terminal walks its own shell PID's subtree — correct isolation |
| Server exits while others remain | Re-discovery poll (10s) removes row; stats switches to next server |
| Server spawned by script (not direct child) | `collect_java_pids_native` walks 10 levels deep — catches most cases |
| Bar added/removed resizes terminal | Flex layout instantly recomputes; single `fitAddon.fit()` in one rAF is sufficient |
| Bars consume all vertical space (tiny split pane) | `min-height: 0` on `__terminal` allows it to shrink to zero |
| Config hot-reload disables extensions | `setEnabled(false)` deactivates all, removes all bars, clears all intervals |

## Out of Scope

- **User-defined/custom extensions** — System-level only. No TOML files, no directory scanning.
- **Side panels or floating widgets** — Bars are top/bottom horizontal only.
- **JMX/remote monitoring** — Only local process stats via `jstat` and `ps`.
- **Historical metrics / charts** — Bars show current-moment values only. No time-series.
- **Windows OS support** — `tcgetpgrp` and `jstat` are Unix. Windows deferred.
- **Per-server bottom panels** — One stats panel per java process would consume too much vertical space.
- **Multiple listening ports per process** — `HashMap<u32, u16>` stores first port per PID.
