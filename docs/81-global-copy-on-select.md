# Global Copy-on-Select — Implementation Spec

> Status: Implemented
> Date: 2026-05-05
> Milestone: M8 — Polish

## Problem

Terminal panes auto-copy selected text to the clipboard (`Compositor.wireCopyOnSelect`, `src/compositor.ts:619`), but every other view in Krypton (markdown viewer, hurl client, diff view, vault view, ACP harness, agent view, file manager, dashboards, pencil, command palette previews, etc.) requires the user to press `Cmd+C` after selecting. The user wants the terminal's auto-copy behavior to apply uniformly across all DOM views.

## Solution

Install a single document-level handler that, after a mouse selection ends or a keyboard selection settles, reads `window.getSelection()` and writes its text to the clipboard via `navigator.clipboard.writeText`. Skip selections that originate inside editable elements (`<input>`, `<textarea>`, `[contenteditable]`) so editing operations are not hijacked. Terminal panes are unaffected because xterm.js renders text into a canvas — its selection is not part of the DOM `Selection` API — so the existing `wireCopyOnSelect` stays as-is.

## Research

- xterm.js exposes `terminal.onSelectionChange()` and `terminal.getSelection()` (already used at `src/compositor.ts:619`). These do **not** populate `window.getSelection()` — verified by the fact that selecting text inside an xterm pane returns an empty string from `document.getSelection().toString()`. Therefore a global DOM handler will not double-fire on terminal selections.
- DOM `selectionchange` fires very frequently during a drag. The accepted pattern is to listen on `mouseup` (and `keyup` for Shift+arrow keyboard selection) and read the current selection at that moment, rather than reacting to every `selectionchange`.
- `navigator.clipboard.writeText` is available in Tauri's WKWebView and is already used at `src/compositor.ts:623`.
- Krypton already has a vim-style yank in Selection mode (`src/selection.ts:351`, `docs/11-selection-mode.md`) and several view-specific copy commands (`markdown-view.ts:794`, hurl path copy). These continue to work; the global handler is additive.
- Existing input fields in the codebase use real `<input>` / `<textarea>` (e.g. ACP harness composer, command palette, prompt dialog, quick file search). No view stores user-edited text inside a `[contenteditable]` div.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| iTerm2 | "Copy to pasteboard on selection" preference (off by default) | Applies only to terminal area |
| WezTerm | `selection_word_boundary` + auto-copy on mouse release (default on) | Terminal area only |
| Linux X11 PRIMARY | Auto-copies any selection in any app to PRIMARY buffer | OS-level, not app-level |
| VS Code / Zed | No auto-copy — selection is treated as an editing target | Different model: editor, not viewer |
| tmux | Copy mode + `copy-pipe` on mouse release | Keyboard-first like Krypton |
| Browser default | No auto-copy | Selection is for reading/manual copy |

**Krypton delta** — Krypton's terminal pane already auto-copies (matches iTerm2/WezTerm behavior with auto-copy on). This spec extends that *terminal-area* convention to *all DOM views*, treating the entire app as a "viewer" rather than an "editor". Where the user is genuinely editing (composer textareas, prompt inputs), we deliberately suppress auto-copy to preserve normal editing semantics. No popular app does this app-wide because most apps mix editing and viewing freely; Krypton can because its editable surfaces are well-bounded (`<input>` / `<textarea>` only).

## Affected Files

| File | Change |
|------|--------|
| `src/copy-on-select.ts` | New module: `installGlobalCopyOnSelect()` registers the document handlers |
| `src/main.ts` | Call `installGlobalCopyOnSelect()` once during startup |
| `docs/PROGRESS.md` | Recent Landing entry after implementation |
| `docs/04-architecture.md` | One-line mention under frontend module list |

## Design

### Module API

```ts
// src/copy-on-select.ts
export interface CopyOnSelectOptions {
  /** Min selection length in chars to copy. Default 1. */
  minLength?: number;
  /** Optional callback invoked after a successful copy (for sound/feedback). */
  onCopy?: (text: string) => void;
}

export function installGlobalCopyOnSelect(opts?: CopyOnSelectOptions): () => void;
// Returns a disposer that removes the listeners.
```

### Behavior

1. On `mouseup` (capture phase, on `document`) and on `keyup` (only when `event.shiftKey` was involved or `event.key` is an arrow / `Home` / `End` / `a` with `Cmd`/`Ctrl`):
   - Read `window.getSelection()`.
   - If selection is `null`, collapsed, or `toString().length < minLength`, do nothing.
   - If `selection.anchorNode` (or its closest element) is inside an editable element — `<input>`, `<textarea>`, or any element with `isContentEditable === true` — do nothing. Use `Element.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')` walking up from the anchor node.
   - Otherwise, `navigator.clipboard.writeText(text).catch(...)` and call `onCopy(text)`.

2. The listeners are attached at the capture phase on `document` so they run regardless of which view owns the event, but they only **read** state — they never call `preventDefault` or `stopPropagation`. Existing keybindings, xterm input, and view handlers are unaffected.

3. No visual feedback is added in v1. The optional `onCopy` callback is wired in `main.ts` to log at debug level only; sound/toast can be added later without spec change.

### Data Flow

```
1. User drags mouse across rendered text in a DOM view (e.g., markdown viewer)
2. Browser sets window.getSelection() as drag progresses
3. User releases mouse → 'mouseup' fires on document
4. Global handler reads selection, checks editable-ancestor guard
5. Handler awaits navigator.clipboard.writeText(selection.toString())
6. (Optional) onCopy callback fires
```

### Keybindings

None. This is a passive listener.

### UI Changes

None.

### Configuration

None in v1. Could be made opt-out via `[ui] copy_on_select = false` in a follow-up if anyone complains, but defaulting on matches the existing terminal-pane behavior.

## Edge Cases

- **xterm.js terminal selection** — not in DOM `Selection`, so global handler is silent. Existing `wireCopyOnSelect` continues to handle it.
- **Selection inside composer/textarea** — guarded by editable-ancestor check; not copied.
- **Selection spanning a textarea and surrounding content** — `Selection.anchorNode` will be in one or the other; if it lands in the textarea we suppress. Acceptable because cross-element drags from inside a textarea are rare and the user can always `Cmd+C`.
- **Triple-click / double-click word selection** — fires `mouseup`; copies the word/line. Desired.
- **Selection cleared by clicking elsewhere** — collapsed selection, no copy. Correct.
- **Programmatic selections** (e.g. quick-file-search `.is-flashing` row) — these don't go through `mouseup`/`keyup`, so won't trigger. Correct.
- **`Cmd+A` Select All** — `keyup` with `metaKey` + `a` triggers; copies the entire visible document text. This may be surprising; mitigation: only trigger on `keyup` when the released key is in the navigation set (`Shift`, `ArrowUp/Down/Left/Right`, `Home`, `End`). Skip `Cmd+A` to avoid copying mountains of unintended text.
- **Clipboard permission denied** — `.catch()` logs a warning; no user-visible failure.
- **IME composition in a textarea** — guarded by editable-ancestor check anyway.

## Open Questions

None.

## Out of Scope

- Per-view opt-out config knob (can add later if a view objects)
- Toast / sound feedback on copy
- Rich-text / HTML clipboard payload (text only)
- Linux PRIMARY selection emulation
- Replacing or modifying the existing `wireCopyOnSelect` for terminal panes
- Replacing existing view-specific copy commands (markdown `y` / `Y`, hurl `p`, Selection mode `y`) — those keep semantic copy (with surrounding context like file:line) and remain useful

## Resources

- [xterm.js Terminal API — onSelectionChange](https://xtermjs.org/docs/api/terminal/classes/terminal/#onselectionchange) — confirmed terminal selection is canvas-based and not part of DOM Selection
- [MDN — Selection API](https://developer.mozilla.org/en-US/docs/Web/API/Selection) — `anchorNode`, `toString()`, collapsed-state semantics
- [MDN — selectionchange event](https://developer.mozilla.org/en-US/docs/Web/API/Document/selectionchange_event) — frequency rationale for using `mouseup`/`keyup` instead
- [MDN — Clipboard.writeText](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText) — promise-based, requires secure context (Tauri WKWebView qualifies)
- Internal: `src/compositor.ts:619` `wireCopyOnSelect` — pattern reference
- Internal: `src/selection.ts:351` `yank()` — keyboard-first copy precedent
- Internal: `docs/11-selection-mode.md` — Selection mode design (unchanged by this spec)
