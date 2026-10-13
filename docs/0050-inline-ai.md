# Inline AI — Implementation Spec

> Status: Approved
> Date: 2026-04-01
> Milestone: M8 — Polish

## Problem

Users want to ask AI questions directly in the terminal pane — like Warp terminal — without switching to the dedicated agent window. Currently the only way to use AI is `Cmd+P → a` which opens a full agent pane. Quick command lookups ("how do I find large files?") should be instant and inline.

## Solution

Add an inline AI overlay that floats inside the focused terminal window. Triggered by `Cmd+K`, it shows a single-line input field. The user types a natural language query, presses Enter, and gets a streamed command suggestion displayed below the input. They can accept it (Enter inserts the command into the terminal), dismiss it (Escape), or copy it (Cmd+C). The overlay reuses the existing `AgentController` with a specialized system prompt that returns concise command suggestions.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `Mode.InlineAI` to enum |
| `src/inline-ai.ts` | **New** — `InlineAIOverlay` class |
| `src/input-router.ts` | Add `Cmd+K` intercept, `handleInlineAIKey()` |
| `src/compositor.ts` | Add `openInlineAI()` / `closeInlineAI()` methods |
| `src/styles/inline-ai.css` | **New** — overlay styling |
| `src/styles/main.css` | Import inline-ai.css |

## Design

### Data Structures

```typescript
// src/types.ts — add to Mode enum
export enum Mode {
  // ...existing...
  InlineAI = 'InlineAI',
}

// src/inline-ai.ts
interface InlineAIState {
  phase: 'input' | 'loading' | 'result';
  query: string;
  result: string;       // streamed command suggestion
  explanation: string;  // optional one-line explanation
}
```

### InlineAIOverlay class

```typescript
class InlineAIOverlay {
  private el: HTMLElement;          // root overlay container
  private inputEl: HTMLInputElement; // query input
  private resultEl: HTMLElement;    // command suggestion display
  private explainEl: HTMLElement;   // explanation line
  private spinnerEl: HTMLElement;   // loading indicator
  private state: InlineAIState;
  private controller: AgentController;
  private abortFn: (() => void) | null;

  constructor(controller: AgentController);

  /** Attach overlay to focused window and focus input */
  open(windowEl: HTMLElement): void;

  /** Remove overlay from DOM, return focus to terminal */
  close(): void;

  /** Submit the current query to the agent */
  private submit(): Promise<void>;

  /** Accept the suggestion — write command to PTY */
  accept(): string;  // returns the command text

  /** Handle keyboard events while overlay is open */
  onKeyDown(e: KeyboardEvent): boolean;
}
```

### Data Flow

```
1. User presses Cmd+K in Normal mode
2. InputRouter.setupKeyHandler intercepts (metaKey + key === 'k')
3. InputRouter calls compositor.openInlineAI()
4. Compositor creates InlineAIOverlay, attaches to focused window element
5. InputRouter.setMode(Mode.InlineAI)
6. User types query, presses Enter
7. InlineAIOverlay.submit() builds prompt with context:
   - User query text
   - Current working directory (from PTY)
   - Last ~5 lines of terminal output (from xterm buffer)
   - Shell type (from env)
8. Calls AgentController.prompt(contextualPrompt, onEvent)
   - System prompt override: "You are a terminal command assistant.
     Return ONLY the command on the first line. Optionally a one-line
     explanation on the second line prefixed with #. Nothing else."
9. onEvent('message_update') streams into resultEl
10. onEvent('agent_end') → phase = 'result'
11. User presses Enter → accept():
    - compositor.writeToFocusedPty(command + '\n') if auto-execute
    - compositor.writeToFocusedPty(command) if preview-only (no newline)
12. InlineAIOverlay.close(), InputRouter.toNormal()
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+K` | Normal mode | Open inline AI overlay |
| `Enter` | InlineAI — input phase | Submit query |
| `Enter` | InlineAI — result phase | Accept command (insert into terminal, no execute) |
| `Shift+Enter` | InlineAI — result phase | Accept and execute (insert + newline) |
| `Escape` | InlineAI — any phase | Close overlay, cancel any in-flight request |
| `Cmd+C` | InlineAI — result phase | Copy command to clipboard |
| `Tab` | InlineAI — result phase | Edit the suggested command in the input field |

### UI Changes

DOM structure appended inside the focused `.krypton-window__content`:

```html
<div class="krypton-inline-ai">
  <div class="krypton-inline-ai__input-row">
    <span class="krypton-inline-ai__prompt">AI ▸</span>
    <input class="krypton-inline-ai__input" placeholder="Ask anything..." />
  </div>
  <div class="krypton-inline-ai__result" hidden>
    <pre class="krypton-inline-ai__command"></pre>
    <span class="krypton-inline-ai__explain"></span>
  </div>
  <div class="krypton-inline-ai__spinner" hidden>
    <span class="krypton-inline-ai__dots"></span>
  </div>
  <div class="krypton-inline-ai__hint">
    ↵ accept · ⇧↵ run · ⎋ dismiss · ⌘C copy
  </div>
</div>
```

Positioning: absolute, bottom of the window content area (above the footer/notification bar). Full width of the window with padding. Semi-transparent background matching the terminal theme (`var(--krypton-background)` with opacity).

Visual style: Cyberpunk aesthetic consistent with the rest of Krypton — monospace font, accent color borders, subtle glow on the command result. The input prompt uses the theme accent color. Glitch-decode reveal on the result text (reuse pattern from `NotificationController.decodeReveal`).

### Configuration

No new TOML config keys in this phase. The keybinding is hardcoded to `Cmd+K`. Future: make configurable via keybindings config.

## Edge Cases

- **No focused terminal pane**: If the focused pane is an agent/markdown/diff content view (not a terminal), show notification "Inline AI requires a terminal pane" and don't open.
- **Agent already running**: If the AgentController is mid-query (from the agent pane), queue or reject with notification "AI is busy".
- **Empty query**: Ignore Enter on empty input.
- **Overlay already open**: `Cmd+K` while overlay is open focuses the input field (no-op if already focused).
- **Window resize during overlay**: Overlay uses CSS relative to parent, auto-adjusts.
- **Escape during loading**: Abort the agent request, close overlay.
- **Very long command result**: Truncate display at 3 lines, show full on hover/expand.
- **No API key**: Show error in overlay "Set ZAI_API_KEY to use inline AI".

## Out of Scope

- Command history / recent inline AI queries
- Multiple suggestion alternatives
- Custom system prompt configuration
- Integration with shell completion
- Inline AI in non-terminal panes (agent view, etc.)
