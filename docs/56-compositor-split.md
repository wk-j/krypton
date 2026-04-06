# Compositor Split — Implementation Spec

> Status: Partially Implemented
> Date: 2026-04-06
> Milestone: M3 — Compositor & Windows

## Problem

`compositor.ts` is 4410 lines handling 10+ concerns: window lifecycle, tabs, panes, layout, Quick Terminal, progress bars, SSH multiplexing, content views, accent colors, perspective mouse fix, and more. Too large to navigate or modify safely.

## Solution

Extract 5 cohesive modules from the Compositor class. Each becomes a standalone class that receives the minimal state it needs (usually the `windows` Map and a few callbacks). The Compositor becomes a thin orchestrator delegating to these modules. Public API unchanged.

## Extraction Plan

### 1. `quick-terminal.ts` (~440 lines)

Extract the entire Quick Terminal overlay system.

**Move:** `toggleQuickTerminal`, `showQuickTerminal`, `hideQuickTerminal`, `destroyQuickTerminal`, `initQuickTerminal`, `animateQtShow`, `animateQtHide`, `positionQuickTerminal` + all `qt*` properties.

**Class:** `QuickTerminal` — constructed with workspace element, config, theme, sound engine. Compositor calls `qt.toggle()`, `qt.isVisible`, etc.

### 2. `progress-gauge.ts` (~250 lines)

Extract OSC 9;4 progress bar rendering.

**Move:** `handleProgress`, `getWindowDisplayProgress`, `updateProgressGauge`, `createGaugeElement`, `removeProgressGauge` + `sessionProgress`/`qtProgress` maps + SVG constants.

**Class:** `ProgressGauge` — constructed with session→window lookup callback. Compositor calls `gauge.handleProgress(sessionId, state, progress, windowId)`.

### 3. `content-views.ts` (~400 lines)

Extract content view factory methods.

**Move:** `createContentWindow`, `openDiffView`, `openMarkdownView`, `openFileManager`, `openAgentView`, `openContextView`, `openDiffFromString`, `isGitRepo`, `openInlineAI`, `closeInlineAI`, `handleInlineAIKey`, `toggleProfilerHud`.

**Pattern:** These become standalone functions (not a class) that receive the Compositor instance or a narrow interface. e.g. `openFileManager(compositor)`.

### 4. `ssh-session.ts` (~270 lines)

Extract SSH session multiplexing.

**Move:** `probeRemoteCwd`, `cloneSshSession`, `cloneSshSessionToNewWindow` + `SshConnectionInfo` interface + SSH-related state.

**Class:** `SshSessionManager` — constructed with session map and a `createWindow`/`createTab` callback.

### 5. `perspective-fix.ts` (~100 lines)

Extract perspective projection mouse coordinate correction.

**Move:** `inversePerspectiveProjection`, `installPerspectiveMouseFix`.

**Pattern:** Standalone exported functions — no class needed.

## Affected Files

| File | Change |
|------|--------|
| `src/compositor.ts` | Remove ~1460 lines, add imports, delegate to new modules |
| `src/quick-terminal.ts` | New — QuickTerminal class |
| `src/progress-gauge.ts` | New — ProgressGauge class |
| `src/content-views.ts` | New — content view factory functions |
| `src/ssh-session.ts` | New — SshSessionManager class |
| `src/perspective-fix.ts` | New — perspective utility functions |

## Rules

1. **No behavior changes.** This is a pure structural refactor.
2. **No new features.** Don't fix bugs or improve code while extracting.
3. **Compositor remains the entry point.** All public methods stay on Compositor (they just delegate). External callers (input-router.ts, main.ts) don't change.
4. **Each module compiles independently.** No circular imports between extracted modules.

## Out of Scope

- Extracting pane tree operations (too tightly coupled to window state)
- Extracting tab bar rendering (same reason)
- Extracting window focus/navigation (same reason)
- Changing the public API of Compositor
- Performance improvements
