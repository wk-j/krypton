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

**First built-in extension: Java Resource Monitor** — shows JVM heap usage, GC stats, and OS-level CPU/memory for running Java processes using `jstat` and `ps`.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/pty.rs` | Add `get_foreground_process()` using `tcgetpgrp` + process name lookup |
| `src-tauri/src/commands.rs` | Add `get_foreground_process` and `get_java_stats` Tauri commands |
| `src-tauri/src/lib.rs` | Register new commands, add process poll timer emitting `process-changed` events |
| `src-tauri/src/config.rs` | Add `[extensions]` config section (enabled toggle + poll interval) |
| `src/extensions.ts` | New file — `ExtensionManager`: registry of built-in extensions, trigger matching, widget lifecycle |
| `src/extensions/java.ts` | New file — Java Resource Monitor extension |
| `src/compositor.ts` | Wire `process-changed` event to `ExtensionManager`; ensure pane DOM supports bar insertion |
| `src/types.ts` | Add `ContextExtension`, `ExtensionWidget`, `ProcessInfo`, `ActiveExtension`, `JavaStats` types |
| `src/config.ts` | Add `ExtensionsConfig` TypeScript interface |
| `src/styles.css` | Add `.krypton-extension-*` classes for widget bar styling |

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

A dedicated Tauri command provides JVM + OS resource stats by shelling out to `jstat` and `ps`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct JavaStats {
    // JVM heap (from jstat -gc <pid>)
    pub heap_used_mb: f64,      // Eden + Old used
    pub heap_max_mb: f64,       // Eden + Old capacity
    pub heap_percent: f64,      // used / max * 100
    pub gc_count: u64,          // total GC events (YGC + FGC)
    pub gc_time_secs: f64,      // total GC time (YGCT + FGCT)

    // OS-level (from ps -p <pid> -o %cpu,rss)
    pub cpu_percent: f64,       // CPU usage %
    pub rss_mb: f64,            // resident set size in MB

    // Process info
    pub pid: u32,
    pub main_class: String,     // extracted from cmdline (last arg without -)
}
```

#### `get_java_stats` Command

```rust
#[tauri::command]
fn get_java_stats(pid: u32) -> Result<JavaStats, String> {
    // 1. Run: jstat -gc <pid>
    //    Parse columns: S0C S1C S0U S1U EC EU OC OU MC MU ... YGC YGCT FGC FGCT GCT
    //    heap_used = S0U + S1U + EU + OU (KB -> MB)
    //    heap_max  = S0C + S1C + EC + OC (KB -> MB)
    //    gc_count  = YGC + FGC
    //    gc_time   = GCT
    //
    // 2. Run: ps -p <pid> -o %cpu=,rss=
    //    Parse CPU% and RSS (KB -> MB)
    //
    // 3. Extract main_class from /proc/<pid>/cmdline or ps -o args=
    //
    // Return combined JavaStats
}
```

This command is called by the frontend on a **2-second interval** (separate from the 500ms process poll) only while the Java extension is active. It's not part of the general process poller — it's extension-specific.

### Extension Definition (System-Level TypeScript)

#### Type Definitions

```typescript
// src/types.ts

interface ProcessInfo {
  pid: number;
  name: string;          // process basename, e.g. "java"
  cmdline: string[];     // full command line split
}

type WidgetPosition = 'top' | 'bottom';

interface ContextExtension {
  name: string;
  description: string;
  processNames: string[];                    // exact match triggers

  /** Create widget bars on activation. */
  createWidgets(process: ProcessInfo): ExtensionWidget[];

  /** Update widgets with new data. Called on poll or process info change. */
  updateWidgets?(widgets: ExtensionWidget[], process: ProcessInfo): void;

  /** Clean up on deactivation. Default: remove elements + call dispose(). */
  destroyWidgets?(widgets: ExtensionWidget[]): void;
}

interface ExtensionWidget {
  element: HTMLElement;
  position: WidgetPosition;
  dispose?: () => void;        // cleanup timers, listeners
}

interface ActiveExtension {
  extension: ContextExtension;
  widgets: ExtensionWidget[];
  process: ProcessInfo;
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

```typescript
// src/extensions/java.ts

import { invoke } from '@tauri-apps/api/core';

export const javaExtension: ContextExtension = {
  name: 'java-monitor',
  description: 'JVM resource monitor — heap, GC, CPU, memory',
  processNames: ['java'],

  createWidgets(process) {
    const mainClass = extractMainClass(process.cmdline);

    // === Top bar: process identity ===
    const topBar = document.createElement('div');
    topBar.className = 'krypton-extension-bar krypton-extension-bar--accent';
    topBar.innerHTML = `
      <span class="krypton-extension-bar__label">JAVA</span>
      <span class="krypton-extension-bar__content">${mainClass}</span>
      <span class="krypton-extension-bar__stat" data-field="pid">PID ${process.pid}</span>
    `;

    // === Bottom bar: live resource stats ===
    const bottomBar = document.createElement('div');
    bottomBar.className = 'krypton-extension-bar krypton-extension-bar--stats';
    bottomBar.innerHTML = `
      <span class="krypton-extension-bar__stat" data-field="heap">
        HEAP: --/-- MB
      </span>
      <span class="krypton-extension-bar__stat" data-field="gc">
        GC: -- (--s)
      </span>
      <span class="krypton-extension-bar__stat" data-field="cpu">
        CPU: --%
      </span>
      <span class="krypton-extension-bar__stat" data-field="rss">
        RSS: -- MB
      </span>
    `;

    // Start polling jstat + ps every 2 seconds
    const pollInterval = setInterval(async () => {
      try {
        const stats: JavaStats = await invoke('get_java_stats', { pid: process.pid });
        updateStatsBar(bottomBar, stats);
      } catch {
        // Process may have exited; poller will deactivate extension
      }
    }, 2000);

    // Initial fetch
    invoke('get_java_stats', { pid: process.pid })
      .then((stats) => updateStatsBar(bottomBar, stats as JavaStats))
      .catch(() => {});

    return [
      { element: topBar, position: 'top' },
      {
        element: bottomBar,
        position: 'bottom',
        dispose: () => clearInterval(pollInterval),
      },
    ];
  },
};

function extractMainClass(cmdline: string[]): string {
  // Look for -jar <file> or the last non-flag argument
  const jarIdx = cmdline.indexOf('-jar');
  if (jarIdx >= 0 && cmdline[jarIdx + 1]) {
    return cmdline[jarIdx + 1].split('/').pop() || 'unknown';
  }
  // Find last arg that doesn't start with -
  for (let i = cmdline.length - 1; i >= 0; i--) {
    if (!cmdline[i].startsWith('-')) return cmdline[i].split('.').pop() || cmdline[i];
  }
  return 'java';
}

function updateStatsBar(bar: HTMLElement, stats: JavaStats): void {
  const heap = bar.querySelector('[data-field="heap"]');
  const gc = bar.querySelector('[data-field="gc"]');
  const cpu = bar.querySelector('[data-field="cpu"]');
  const rss = bar.querySelector('[data-field="rss"]');

  if (heap) {
    const pct = stats.heap_percent;
    const warn = pct > 80 ? ' krypton-extension-bar__stat--warn' : '';
    heap.className = `krypton-extension-bar__stat${warn}`;
    heap.textContent = `HEAP: ${stats.heap_used_mb.toFixed(0)}/${stats.heap_max_mb.toFixed(0)} MB (${pct.toFixed(0)}%)`;
  }
  if (gc) gc.textContent = `GC: ${stats.gc_count} (${stats.gc_time_secs.toFixed(1)}s)`;
  if (cpu) cpu.textContent = `CPU: ${stats.cpu_percent.toFixed(1)}%`;
  if (rss) rss.textContent = `RSS: ${stats.rss_mb.toFixed(0)} MB`;
}
```

#### Extension Registry

```typescript
// src/extensions.ts

import { javaExtension } from './extensions/java';

/** All built-in context extensions. Order = priority (first match wins). */
const EXTENSIONS: ContextExtension[] = [
  javaExtension,
  // Future: sshExtension, vimExtension, etc.
];
```

### Widget Layout Model

```
+--Window Chrome (titlebar)--------------------------+
| +-- Top bar ------------------------------------+ |
| |  [JAVA]  MyApplication.jar     PID 48291      | |
| +------------------------------------------------+ |
|                                                     |
|   xterm.js terminal content                         |
|   (resized via addon-fit to fill between bars)      |
|                                                     |
| +-- Bottom bar ---------------------------------+ |
| |  HEAP: 342/512 MB (67%)  GC: 14 (0.8s)        | |
| |  CPU: 12.3%  RSS: 580 MB                       | |
| +------------------------------------------------+ |
+--Window Chrome (bottom bar, corners)----------------+
```

Key behavior:
- Bars are **inside** the pane content area, above/below the xterm.js terminal
- When bars appear/disappear, `addon-fit` recalculates and `resize_pty` is called
- Bars take real layout space — they do NOT float over terminal content
- A pane can have 0, 1, or 2 bars (top only, bottom only, or both)
- The bottom bar updates every 2s with live stats from `jstat` + `ps`

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
  |        -> call extension.createWidgets(process)
  |        -> insert top bar before xterm container
  |        -> append bottom bar after xterm container
  |        -> trigger addon-fit recalculation + resize_pty
  |        -> store in paneExtensions map
  |        -> (Java ext starts its own 2s stats poll internally)
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
           -> trigger addon-fit recalculation + resize_pty
           -> remove from paneExtensions map
```

#### ExtensionManager Class

```typescript
class ExtensionManager {
  private paneExtensions: Map<PaneId, ActiveExtension> = new Map();
  private compositor: Compositor;
  private enabled: boolean = true;

  constructor(compositor: Compositor);

  /** Called on process-changed event from backend */
  onProcessChanged(sessionId: number, process: ProcessInfo | null): void;

  /** Find matching extension for a process name */
  private findExtension(processName: string): ContextExtension | null;

  /** Activate an extension on a pane */
  private activateExtension(pane: Pane, ext: ContextExtension, process: ProcessInfo): void;

  /** Deactivate the active extension from a pane */
  private deactivateExtension(paneId: PaneId): void;

  /** Clean up when a pane is destroyed */
  onPaneDestroyed(paneId: PaneId): void;

  /** Enable/disable all extensions */
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
   a. createWidgets() builds top bar (identity) + bottom bar (stats)
   b. Bars inserted into pane DOM, addon-fit + resize_pty triggered
   c. Bottom bar starts its own setInterval (2s) calling invoke("get_java_stats")
   d. get_java_stats shells out to jstat + ps, returns JavaStats
   e. Bottom bar DOM updated with live heap/GC/CPU/RSS values
8. On unmatch (java exits): deactivates extension
   a. clearInterval on stats poller
   b. Remove bar elements from DOM
   c. addon-fit + resize_pty triggered (terminal expands back)
```

### Configuration

```toml
# ~/.config/krypton/krypton.toml

[extensions]
enabled = true            # master toggle for all context extensions
poll_interval_ms = 500    # how often to check foreground process (ms)
```

```rust
// config.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_500")]
    pub poll_interval_ms: u64,
}
```

```typescript
// config.ts
interface ExtensionsConfig {
  enabled: boolean;
  poll_interval_ms: number;
}
```

### UI Changes

#### Pane DOM Structure

The `.krypton-pane` uses `display: flex; flex-direction: column;`. Bars are inserted as flex children before/after the terminal container:

```html
<div class="krypton-pane" data-pane-id="pane-0">
  <!-- TOP bar (inserted by ExtensionManager) -->
  <div class="krypton-extension-bar krypton-extension-bar--accent">
    <span class="krypton-extension-bar__label">JAVA</span>
    <span class="krypton-extension-bar__content">MyApp.jar</span>
    <span class="krypton-extension-bar__stat">PID 48291</span>
  </div>

  <!-- xterm.js container (flex: 1, fills remaining space) -->
  <div class="krypton-pane__terminal">
    <!-- xterm.js canvas -->
  </div>

  <!-- BOTTOM bar (inserted by ExtensionManager) -->
  <div class="krypton-extension-bar krypton-extension-bar--stats">
    <span class="krypton-extension-bar__stat">HEAP: 342/512 MB (67%)</span>
    <span class="krypton-extension-bar__stat">GC: 14 (0.8s)</span>
    <span class="krypton-extension-bar__stat">CPU: 12.3%</span>
    <span class="krypton-extension-bar__stat">RSS: 580 MB</span>
  </div>
</div>
```

#### CSS Classes

```css
.krypton-pane {
  display: flex;
  flex-direction: column;
}

.krypton-pane__terminal {
  flex: 1;
  min-height: 0;
  position: relative;
}

/* Extension bar — horizontal strip at top or bottom */
.krypton-extension-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 10px;
  font-family: var(--krypton-font-family);
  font-size: 11px;
  color: var(--krypton-chrome-text);
  background: var(--krypton-chrome-bg-80);
  flex-shrink: 0;
}

/* Top bar: border on bottom */
.krypton-pane__terminal ~ .krypton-extension-bar {
  border-top: 1px solid var(--krypton-chrome-border);
}

/* Accent style for identity bars */
.krypton-extension-bar--accent {
  background: var(--krypton-accent-color-10);
  border-bottom: 1px solid var(--krypton-accent-color-30);
}

/* Stats bar with monospace numbers */
.krypton-extension-bar--stats {
  font-variant-numeric: tabular-nums;
}

.krypton-extension-bar__label {
  font-weight: 700;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--krypton-accent-color);
  padding: 1px 6px;
  border: 1px solid var(--krypton-accent-color-30);
  border-radius: 2px;
}

.krypton-extension-bar__content {
  color: var(--krypton-chrome-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.krypton-extension-bar__stat {
  color: var(--krypton-chrome-text-dim);
  white-space: nowrap;
}

/* Warning state: heap > 80% */
.krypton-extension-bar__stat--warn {
  color: var(--krypton-color-amber, #fac863);
}

/* Critical state: heap > 95% */
.krypton-extension-bar__stat--critical {
  color: var(--krypton-color-red, #ec5f67);
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
| `jstat` access denied | Same as above — graceful error message in the stats bar |
| Java process is short-lived | Stats poll may get 1-2 readings before process exits. Extension deactivates cleanly |
| Multiple Java processes in panes | Each pane has its own `ActiveExtension` with its own stats poll interval, targeting the correct PID |
| Bar added/removed resizes terminal | `addon-fit` recalculates rows/cols; `resize_pty` sent to backend; shell receives `SIGWINCH` |
| Config hot-reload disables extensions | `setEnabled(false)` deactivates all, removes all bars, clears all intervals |
| Quick Terminal runs Java | QT has its own session; poller includes it. Extension works on QT pane too |

## Out of Scope

- **User-defined/custom extensions** — System-level only. No TOML files, no directory scanning.
- **Side panels or floating widgets** — Bars are top/bottom horizontal only.
- **JMX/remote monitoring** — Only local process stats via `jstat` and `ps`.
- **Historical metrics / charts** — Bars show current-moment values only. No time-series.
- **Windows OS support** — `tcgetpgrp` and `jstat` are Unix. Windows deferred.
- **Process argument-based triggers** — Triggers match on process basename only.
