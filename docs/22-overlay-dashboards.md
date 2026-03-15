# Overlay Dashboards — Implementation Spec

> Status: Implemented
> Date: 2026-03-15
> Milestone: Post-M8 (new feature infrastructure)

## Problem

Krypton has no generic infrastructure for full-screen overlay panels that can display rich, interactive content on top of terminal windows. Features like a Git dashboard, system monitor, keybinding reference, or session manager would all benefit from a shared overlay framework with consistent keyboard toggling, animations, and lifecycle management. Today, each overlay (command palette, which-key, hints) is built ad-hoc with its own DOM, visibility, and key handling — making new overlays expensive to add.

## Solution

Introduce a **Dashboard Registry** — a lightweight framework that lets any module register an overlay dashboard with a unique ID, keyboard shortcut, and a render/destroy lifecycle. The framework manages:

- DOM container creation and z-index stacking
- Show/hide transitions (consistent with existing overlay animations)
- InputRouter mode integration (new `Mode.Dashboard` that blocks terminal input)
- Focus trapping within the active dashboard
- A registry API so new dashboards can be added in a single call

A **Git Dashboard** will be the first concrete implementation, proving the framework works end-to-end.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `Mode.Dashboard`, `DashboardDefinition` interface |
| `src/dashboard.ts` | **New** — `DashboardManager` class (registry, DOM, lifecycle) |
| `src/input-router.ts` | Handle `Mode.Dashboard`, add global shortcut interception for dashboard toggles |
| `src/compositor.ts` | Expose `getDashboardManager()`, wire up in init |
| `src/main.ts` | Initialize `DashboardManager`, register built-in dashboards |
| `src/dashboards/git.ts` | **New** — Git Dashboard implementation |
| `src/styles.css` | Dashboard overlay styles |
| `src/command-palette.ts` | Register dashboard toggle actions |

## Design

### Data Structures

```typescript
// src/types.ts — additions

export enum Mode {
  // ... existing ...
  Dashboard = 'Dashboard',
}

/** Definition for a registerable overlay dashboard */
export interface DashboardDefinition {
  /** Unique identifier (e.g., 'git', 'system', 'keybindings') */
  id: string;
  /** Display name shown in command palette and title bar */
  title: string;
  /** Keyboard shortcut to toggle (e.g., 'Cmd+Shift+G') */
  shortcut?: DashboardShortcut;
  /**
   * Called when the dashboard opens.
   * Receives the content container element to render into.
   * May return a cleanup function called on close.
   */
  onOpen(container: HTMLElement): void | (() => void);
  /**
   * Called when the dashboard closes.
   * The framework removes the container from DOM after this.
   */
  onClose?(): void;
  /**
   * Optional: handle keyboard events while dashboard is active.
   * Return true if the event was consumed, false to let default handling proceed.
   * Default handling: Escape closes the dashboard.
   */
  onKeyDown?(e: KeyboardEvent): boolean;
}

/** Shortcut descriptor for dashboard toggle */
export interface DashboardShortcut {
  key: string;         // e.g., 'KeyG'
  meta?: boolean;      // Cmd on macOS
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}
```

### API / Commands

```typescript
// src/dashboard.ts

export class DashboardManager {
  /** Register a new dashboard. Throws if ID already registered. */
  register(definition: DashboardDefinition): void;

  /** Unregister a dashboard by ID. */
  unregister(id: string): void;

  /** Toggle a dashboard by ID. Opens if closed, closes if open. */
  toggle(id: string): void;

  /** Open a specific dashboard (no-op if already open). */
  open(id: string): void;

  /** Close the currently active dashboard (no-op if none open). */
  close(): void;

  /** Returns the currently active dashboard ID, or null. */
  get activeDashboardId(): string | null;

  /** Returns all registered dashboard definitions. */
  get registeredDashboards(): DashboardDefinition[];

  /**
   * Check if a keyboard event matches any dashboard shortcut.
   * Called by InputRouter from Normal mode.
   * Returns the dashboard ID if matched, null otherwise.
   */
  matchShortcut(e: KeyboardEvent): string | null;
}
```

No new Tauri commands are needed — dashboards are pure frontend. Individual dashboard implementations (like Git) may call existing Tauri commands (`invoke('get_pty_cwd', ...)`) to gather data.

### Data Flow

```
1. User presses Cmd+Shift+G (Git Dashboard shortcut)
2. InputRouter (Normal mode) calls dashboardManager.matchShortcut(e) → 'git'
3. InputRouter calls dashboardManager.toggle('git')
4. DashboardManager.open('git'):
   a. Creates backdrop overlay element (full viewport, semi-transparent)
   b. Creates content container element inside overlay
   c. Calls definition.onOpen(container) — Git Dashboard renders its UI
   d. Plays entrance animation (fade-in + scale-up, 150ms)
   e. Calls inputRouter.setMode(Mode.Dashboard)
5. User interacts with dashboard (keyboard events routed through onKeyDown)
6. User presses Escape (or Cmd+Shift+G again)
7. DashboardManager.close():
   a. Calls definition.onClose() if provided
   b. Calls cleanup function returned from onOpen() if any
   c. Plays exit animation (fade-out, 120ms)
   d. Removes DOM elements
   e. Calls inputRouter.setMode(Mode.Normal)
   f. Restores focus to previously focused terminal
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+Shift+G` | Normal / Dashboard(git) | Toggle Git Dashboard |
| `Escape` | Dashboard (any) | Close active dashboard |
| `Cmd+Shift+P` | Dashboard (any) | Close dashboard, open command palette |

Individual dashboards define their own internal keybindings via `onKeyDown`.

### UI Changes

**DOM structure:**
```
document.body
  > .krypton-dashboard (position: fixed, inset: 0, z-index: 9500)
    > .krypton-dashboard__backdrop (full viewport, click-to-close)
    > .krypton-dashboard__panel (centered, 80vw × 80vh, rounded corners)
      > .krypton-dashboard__header
        > .krypton-dashboard__title (dashboard name)
        > .krypton-dashboard__close (×, keyboard: Escape)
      > .krypton-dashboard__content (scrollable, passed to onOpen)
```

**Z-index placement:** 9500 — above hint overlays (9000) but below which-key (10000) and command palette (10002). This ensures the command palette can still be opened over a dashboard.

**Visual style:**
- Backdrop: `rgba(0, 0, 0, 0.5)` with `backdrop-filter: blur(8px)`
- Panel: themed background (`--krypton-bg`), themed border, `border-radius: 8px`
- Header: bottom border separator, title left-aligned, close button right
- Content: `overflow-y: auto`, padding, inherits all `--krypton-*` theme variables
- Animations: CSS transitions via `--visible` modifier class (consistent with existing overlays)

### Configuration

No new TOML config keys initially. Dashboard shortcuts are hardcoded per-dashboard. A future spec can add `[dashboards]` configuration for custom shortcut overrides.

## Git Dashboard (First Implementation)

The Git Dashboard is a read-only overlay showing git status for the CWD of the focused terminal's PTY session.

**Data gathering:** Calls `invoke('get_pty_cwd', { sessionId })` to get the CWD, then uses the existing `invoke('spawn_pty', ...)` mechanism is NOT used — instead, adds a new Tauri command `run_command` that executes a command and returns stdout (no PTY, no streaming). This avoids polluting the session pool.

Actually, to keep this spec focused on the dashboard **infrastructure**, the Git Dashboard implementation will be minimal — just enough to prove the framework:

- Shows current branch, file status (staged/unstaged/untracked counts)
- Static render on open (no live updating)
- Internal keybindings: `r` to refresh

The Git Dashboard's full feature set (diff viewer, staging, commit) is out of scope and would get its own spec.

### New Tauri Command

```rust
// src-tauri/src/commands.rs
#[tauri::command]
async fn run_command(program: String, args: Vec<String>, cwd: Option<String>) -> Result<String, String>
```

Runs a short-lived command, captures stdout, returns it. Used by dashboards to gather data (e.g., `git status --porcelain`, `git branch --show-current`). Capped at 5 seconds timeout. Not a PTY — just `std::process::Command`.

## Edge Cases

- **Multiple dashboard shortcuts pressed rapidly:** `toggle()` checks if animation is in progress, ignores input during transitions.
- **Dashboard open + command palette shortcut:** Command palette takes priority — close the dashboard first, then open palette.
- **No focused terminal when Git Dashboard opens:** Show "No active terminal session" message in the dashboard content.
- **Window resize while dashboard is open:** Dashboard uses viewport-relative sizing (`vw`/`vh`), auto-adjusts.
- **Theme change while dashboard is open:** Dashboard inherits `--krypton-*` variables, updates automatically.

## Open Questions

None — all design decisions are resolved.

## Out of Scope

- Full Git operations (staging, committing, diffing, log browsing) — future spec
- Dashboard configuration in TOML (custom shortcuts, enable/disable)
- Dashboard persistence (remembering which dashboard was last open)
- Multiple dashboards open simultaneously (stacking)
- Dashboard plugins / external dashboard loading
