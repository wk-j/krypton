# Agent Context Window — Implementation Spec

> Status: Implemented
> Date: 2026-03-30
> Milestone: M8 — Polish

## Problem

The agent's context inspector is an overlay panel inside `AgentView` — pressing `c` in scroll mode hides the message list and replaces it with a static snapshot of the LLM context. This is limiting: it can't be viewed alongside the agent conversation, it's a one-shot render (not real-time), and adding rich features (token visualization, message editing, context pruning) is constrained by sharing DOM real estate with the chat UI.

## Solution

Extract the context inspector into a standalone `ContextView` ContentView that opens as its own compositor tab/window. It subscribes to the same `AgentController` instance as the originating `AgentView`, polls on `requestAnimationFrame` during streaming for real-time updates, and re-renders on `agent_end`. Because it's a full `ContentView`, it participates in grid layout, focus cycling, split panes, and all standard window operations — providing a foundation for rich future features (token budget bars, message editing, context surgery).

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `'context'` to `PaneContentType` union |
| `src/agent/context-view.ts` | **New** — `ContextView` implementing `ContentView` |
| `src/agent/agent.ts` | Add `onChange` event emitter so ContextView can subscribe to state changes |
| `src/agent/agent-view.ts` | Remove inline context panel DOM/state/keybindings; `c` key now opens ContextView via compositor |
| `src/agent/index.ts` | Re-export `ContextView` |
| `src/compositor.ts` | Add `openContextView(controller)` method |
| `src/styles/agent.css` | Move context panel styles to dedicated section; add ContextView-specific styles |

## Design

### Shared Controller Pattern

`AgentView` and `ContextView` share the same `AgentController` instance. When the user presses `c` (scroll mode) or runs `/context` (input mode) in the agent view, the compositor opens a `ContextView` tab and passes the controller reference:

```typescript
// AgentView exposes its controller for the context window
getController(): AgentController { return this.controller; }
```

### AgentController Event Emitter

Add a simple listener mechanism to `AgentController` so `ContextView` can react to state changes without polling:

```typescript
// In AgentController
private changeListeners: Set<() => void> = new Set();

onChange(cb: () => void): () => void {
  this.changeListeners.add(cb);
  return () => this.changeListeners.delete(cb);
}

private notifyChange(): void {
  for (const cb of this.changeListeners) cb();
}
```

`notifyChange()` is called from the existing event callback (on `agent_start`, `message_update`, `tool_start`, `tool_end`, `agent_end`).

### ContextView Class

```typescript
export class ContextView implements ContentView {
  readonly type: PaneContentType = 'context';
  readonly element: HTMLElement;

  constructor(controller: AgentController);
  onKeyDown(e: KeyboardEvent): boolean;
  dispose(): void;
  onResize?(width: number, height: number): void;
}
```

Internal state: `'browse'` (default — navigate messages) or `'detail'` (expanded single message view).

### Data Flow

```
1. User focuses agent window, presses c (scroll) or types /context (input)
2. AgentView calls compositor.openContextView(this.controller)
3. compositor.openContextView():
   a. Creates new ContextView(controller)
   b. Registers onClose callback
   c. Calls createContentTab('CTX  agent', contextView)
4. ContextView constructor:
   a. Builds DOM (header bar + message list + detail panel)
   b. Subscribes to controller.onChange() for live updates
   c. Calls render() for initial snapshot
5. During agent streaming:
   a. controller.notifyChange() fires on each event
   b. ContextView.render() updates header stats + message rows
   c. New messages appear, streaming indicator updates in real-time
6. User navigates with j/k, expands with Enter, yanks with y
7. Tab closed → dispose() unsubscribes from controller
```

### Keybindings

**Browse state (default)**

| Key | Action |
|-----|--------|
| `j` / `Down` | Select next message |
| `k` / `Up` | Select previous message |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `Enter` | Expand selected message (enter detail state) |
| `y` | Yank selected message JSON to clipboard |
| `Y` | Yank full context snapshot to clipboard |
| `Ctrl+D` / `Page Down` | Scroll down half-page |
| `Ctrl+U` / `Page Up` | Scroll up half-page |
| `q` | Close context tab |
| `Escape` | Close context tab |

**Detail state (viewing expanded message)**

| Key | Action |
|-----|--------|
| `Escape` | Return to browse |
| `j` / `Down` | Scroll detail content down |
| `k` / `Up` | Scroll detail content up |
| `y` | Yank expanded content to clipboard |
| `q` | Close context tab |

### UI Structure

```
.context-view                              -- fills pane, flex column
  .context-view__header                    -- sticky top bar
    .context-view__stat                    -- MODEL / THINKING / MSGS / STREAMING badges
    .context-view__live-dot                -- pulsing dot when streaming
  .context-view__list                      -- scrollable message rows, flex: 1
    .context-view__row                     -- one per context entry
      .context-view__row-idx              -- message index
      .context-view__row-role             -- role badge (system/user/assistant/toolResult)
      .context-view__row-types            -- content type tags
      .context-view__row-len              -- character count
      .context-view__row-summary          -- truncated preview
      .context-view__row-badge            -- stop_reason / error badge
    .context-view__row--selected           -- highlighted row
  .context-view__detail                    -- expanded view (hidden by default)
    pre.context-view__detail-content       -- JSON or text content
  .context-view__hint                      -- bottom status line with keybinding hints
```

### Removing Overlay from AgentView

The `c` key in scroll mode and `/context` slash command currently toggle the inline context panel. After this change:

- `c` in scroll mode → calls `this.closeCallback` composition to open context view via compositor
- `/context` in input mode → same
- Remove: `contextPanelEl`, `contextSelectedIdx`, `preContextState`, `enterContextState()`, `exitContextState()`, `handleContextKey()`, `contextNavigate()`, `renderContextPanel()`, `createContextRow()`, `summarizeMessage()`, `contextExpandSelected()`, `contextYankSelected()`
- Remove the `'context'` value from AgentView's internal `state` union (keep `'input' | 'scroll'`)
- Remove associated CSS (`.agent-view__context-panel`, `.agent-view__ctx-*`)

### Communication: AgentView → Compositor

AgentView needs to tell the compositor to open the context window. Use the existing `onClose` callback pattern — add a second callback:

```typescript
// In AgentView
private contextCallback: ((controller: AgentController) => void) | null = null;

onOpenContext(cb: (controller: AgentController) => void): void {
  this.contextCallback = cb;
}
```

Compositor registers this in `openAgentView()`:

```typescript
agentView.onOpenContext((ctrl) => this.openContextView(ctrl));
```

## Edge Cases

| Case | Handling |
|------|----------|
| Agent not initialized (no prompts sent yet) | Show "Agent not initialized" placeholder |
| Context window opened while agent streaming | Live updates via onChange subscription |
| Agent tab closed while context window open | ContextView keeps controller ref; shows last snapshot (stale but not crashed) |
| Multiple context windows for same agent | Each subscribes independently; all update live |
| Context window opened, then different agent tab focused | Context window still shows original agent's context |
| `c` pressed when context tab already open for this agent | Focus existing context tab (don't create duplicate) |

## Out of Scope

- Token budget visualization (bar chart showing usage vs limit)
- Message editing / deletion from context window
- Context pruning / surgery tools
- Drag-and-drop message reordering
- Multi-agent context comparison view

These are future features enabled by having a dedicated window — not part of this initial extraction.
