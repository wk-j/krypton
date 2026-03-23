# Diff View Window — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: M8 — Polish

## Problem

Krypton only supports terminal windows — every pane requires an xterm.js instance and PTY session. There's no way to display rich non-terminal content in the tiling layout. Users viewing diffs must shell out to CLI tools (`git diff`, `delta`) with no side-by-side view or syntax highlighting.

## Solution

Introduce a **content pane abstraction** that lets panes hold either a terminal or a custom content view. The first content view is a **Diff View** powered by `@pierre/diffs` — a vanilla TypeScript diff rendering library with Shiki-based syntax highlighting, split/unified views, and built-in virtualization. The diff view participates in the normal tiling layout, focus system, and keyboard routing.

## Affected Files

| File | Change |
|------|--------|
| `package.json` | Add `@pierre/diffs` dependency |
| `src/types.ts` | Add `ContentView` interface, extend `Pane` with optional content view |
| `src/diff-view.ts` | **New** — wraps `@pierre/diffs` `FileDiff` + `processPatch()` into a `ContentView`, adds keyboard navigation |
| `src/compositor.ts` | Add `createContentWindow()`, null-guards for content panes in `fitAll`/`showActiveTab`/`closeWindow`/PTY listeners |
| `src/input-router.ts` | Route keys to `contentView.onKeyDown()` when focused pane is non-terminal |
| `src/styles.css` | Diff view container styles, Shiki theme CSS variable bridge |
| `src/command-palette.ts` | Add "Open Diff View" / "Open Diff View (Staged)" actions |

## Design

### Data Structures

```typescript
// types.ts — content pane abstraction

/** Content types that can live inside a pane */
type PaneContentType = 'terminal' | 'diff';

/** Interface for non-terminal content views */
interface ContentView {
  type: PaneContentType;
  element: HTMLElement;
  /** Handle keyboard input when this pane is focused. Return true if handled. */
  onKeyDown(e: KeyboardEvent): boolean;
  /** Clean up resources */
  dispose(): void;
  /** Called when pane is resized */
  onResize?(width: number, height: number): void;
}

/** Extended Pane — terminal is optional when contentView is set */
interface Pane {
  id: PaneId;
  sessionId: SessionId | null;       // null for content panes
  terminal: Terminal | null;          // null for content panes
  fitAddon: FitAddon | null;         // null for content panes
  element: HTMLElement;
  shaderInstance: ShaderInstance | null;
  contentView: ContentView | null;   // null for terminal panes
}
```

### @pierre/diffs Integration

```typescript
// diff-view.ts — wraps @pierre/diffs into a ContentView

import { FileDiff, processPatch, VirtualizedFileDiff } from '@pierre/diffs';
import '@pierre/diffs/web-components';  // registers <diffs-file> custom element

class DiffContentView implements ContentView {
  type: PaneContentType = 'diff';
  element: HTMLElement;

  private instances: FileDiff[] = [];
  private currentFileIndex = 0;
  private files: FileDiffMetadata[] = [];

  constructor(unifiedDiff: string, private container: HTMLElement) {
    // Parse git diff output → array of per-file diff metadata
    const parsed = processPatch(unifiedDiff);
    this.files = parsed.files;

    // Create wrapper element
    this.element = document.createElement('div');
    this.element.className = 'krypton-diff';
    container.appendChild(this.element);

    // Render file navigation header + first file
    this.renderFileNav();
    this.renderCurrentFile();
  }

  private renderCurrentFile(): void {
    // Create or reuse FileDiff instance for current file
    const file = this.files[this.currentFileIndex];
    const fileContainer = document.createElement('div');
    // ... clear previous, append new

    const diff = new FileDiff({
      theme: { dark: 'github-dark' },  // or bridge to Krypton theme
      diffStyle: 'split',              // side-by-side
      wordDiff: true,                  // inline word-level highlights
    });

    diff.render({
      fileDiff: file,
      fileContainer,
    });
  }

  onKeyDown(e: KeyboardEvent): boolean { /* j/k/n/N/g/G/q/1-9 */ }
  onResize(): void { /* trigger FileDiff reflow */ }
  dispose(): void { /* destroy all FileDiff instances */ }
}
```

Key `@pierre/diffs` features used:
- **`processPatch(gitDiffString)`** — parses raw `git diff` output into `ParsedPatch` with per-file `FileDiffMetadata`
- **`FileDiff` class** — vanilla TS, renders into any `HTMLElement`, no React needed
- **`diffStyle: 'split'`** — side-by-side view (also supports `'unified'`)
- **`wordDiff: true`** — inline word-level change highlighting
- **Shiki syntax highlighting** — automatic language detection from file extension
- **Web Components** — `<diffs-file>` custom element with Shadow DOM for style isolation
- **`VirtualizedFileDiff`** — for large files, only renders visible viewport

### Shiki Theme Bridge

`@pierre/diffs` uses Shiki themes. We bridge Krypton's `--krypton-*` CSS variables to Shiki's CSS variable theme:

```typescript
import { createCSSVariablesTheme } from '@pierre/diffs';

const kryptonShikiTheme = createCSSVariablesTheme({
  name: 'krypton',
  variablePrefix: '--shiki-',
});
```

Then map `--krypton-foreground` → `--shiki-foreground`, etc. in CSS. This ensures diffs follow the active Krypton theme.

### API / Commands

No new Tauri commands — reuses existing `run_command` for `git diff` and `git show` (to get old/new file contents when needed).

```typescript
// Compositor public method
openDiffView(options?: { staged?: boolean; path?: string }): Promise<void>
```

### Data Flow

```
1. User triggers "Open Diff View" (Leader d, or command palette)
2. Compositor gets CWD from focused terminal via `invoke('get_pty_cwd', { sessionId })`
3. Compositor calls `invoke('run_command', { program: 'git', args: ['diff'], cwd })`
   (or ['diff', '--staged'] for Leader D)
4. Compositor creates window via `createContentWindow('diff', diffOutput)`
5. createContentWindow builds same window chrome (titlebar, corners, accents)
   but creates DiffContentView instead of xterm.js pane
6. DiffContentView calls `processPatch(diffOutput)` → FileDiffMetadata[]
7. DiffContentView creates `FileDiff` instance per file, renders into container
8. Shiki highlights syntax; split panels show old/new side-by-side
9. Window enters tiling layout (grid/focus) like any other window
10. Input router delegates to contentView.onKeyDown() for navigation
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader d` | Compositor mode | Open diff view (unstaged changes) |
| `Leader D` | Compositor mode | Open diff view (staged changes) |
| `j` / `k` | Diff view focused | Scroll down / up |
| `n` / `N` | Diff view focused | Next / previous hunk |
| `f` / `b` | Diff view focused | Page down / page up |
| `g` / `G` | Diff view focused | Jump to top / bottom |
| `]` / `[` | Diff view focused | Next / previous file |
| `s` | Diff view focused | Toggle split ↔ unified view |
| `q` | Diff view focused | Close diff view window |

### UI Changes

DOM structure inside `.krypton-window__content` for a diff window:

```html
<div class="krypton-diff">
  <!-- File navigation bar -->
  <div class="krypton-diff__nav">
    <span class="krypton-diff__file-index">1/3</span>
    <span class="krypton-diff__file-path">src/compositor.ts</span>
    <span class="krypton-diff__stats">
      <span class="krypton-diff__adds">+42</span>
      <span class="krypton-diff__dels">-17</span>
    </span>
    <span class="krypton-diff__mode">SPLIT</span>
  </div>
  <!-- @pierre/diffs renders here via web component -->
  <div class="krypton-diff__content">
    <diffs-file>
      #shadow-root
        <!-- FileDiff rendered content (side-by-side panels) -->
    </diffs-file>
  </div>
</div>
```

The file nav bar uses Krypton's chrome style. The diff content below is rendered by `@pierre/diffs` inside its Shadow DOM, styled via the Shiki theme bridge.

Window titlebar shows: `DIFF // 3 files · +42 -17`

### Compositor Changes

New method `createContentWindow(type, data)`:

1. Builds same window chrome (titlebar, corners, accents) as `createWindow()`
2. Creates pane with `terminal: null`, `sessionId: null`, `contentView: new DiffContentView(data, container)`
3. Skips `spawnPaneSession()` and `wirePaneInput()`
4. Assigns accent color, adds to layout, animates entrance

Null-guards needed in existing methods:
- `setupPtyListeners()` — `sessionMap` only has terminal panes, already safe
- `fitAll()` — call `contentView.onResize()` instead of `fitAddon.fit()` when `pane.terminal === null`
- `showActiveTab()` — skip `terminal.focus()` for content panes, focus the content element instead
- `closeWindow()` / `closeTab()` — call `contentView.dispose()` if present
- `wireCopyOnSelect()` — skip for content panes (no terminal)

### Input Router Changes

In Normal mode, when the focused pane has a `contentView`:
- Don't forward keystrokes to xterm.js (there is none)
- Call `pane.contentView.onKeyDown(e)` instead
- If `onKeyDown` returns `false` (unhandled), let the event propagate normally
- Global hotkeys (Leader, Quick Terminal, Cmd+Shift+P, etc.) still intercept first

## Edge Cases

- **Empty diff**: Show "No changes" message centered in the pane, styled with accent color
- **Binary files**: `@pierre/diffs` handles this — shows binary file indicator
- **Very large diffs**: Use `VirtualizedFileDiff` instead of `FileDiff` when file line count > 5000
- **Window close during diff load**: Guard async `run_command` with window existence check
- **No git repo**: Show error message if `git diff` fails
- **Content pane splits**: Disabled — split keybindings are no-ops for content panes
- **Tabs**: A window can mix terminal tabs and diff tabs — tab switching works normally
- **Theme changes**: Re-render diffs when `theme-changed` event fires (update Shiki theme bridge)
- **React peer dep**: Not needed — we only import from `@pierre/diffs` (main export), not `@pierre/diffs/react`

## Out of Scope

- Inline editing of diffs
- Staging individual hunks (future: integrate with git add -p)
- Non-git diff sources (arbitrary file comparison)
- Generic content window plugin API — we build the abstraction but only ship diff view
- Merge conflict resolution UI
