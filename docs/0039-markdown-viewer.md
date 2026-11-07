# Markdown Viewer Window — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: M8 — Polish
>
> Enhancements (in-doc search, heading hints, image fix, focus indicator, re-select guard): see `docs/0137-markdown-viewer-search-hints-images.md`.
> Styling superseded by [spec 0366](./0366-console-faceplate-ui.md) and DESIGN.md 2.0.0 (Krypton Console): path line, file list and status bar become plate, well and readout.

## Problem

No way to preview markdown files from within Krypton. Users must switch to a browser or external app to read READMEs, docs, or notes.

## Solution

Add a dedicated markdown viewer window with a two-panel layout: a **file browser** on the left listing all `.md` files in the CWD (recursively), and a **rendered preview** on the right. Fully keyboard-driven — navigate files with arrow keys, preview updates instantly on selection. Uses `marked` for markdown parsing.

## Affected Files

| File | Change |
|------|--------|
| `package.json` | Add `marked` dependency |
| `src/markdown-view.ts` | **New** — `MarkdownContentView` with file browser + preview |
| `src/types.ts` | Add `'markdown'` to `PaneContentType` union |
| `src/compositor.ts` | Add `openMarkdownView()` method |
| `src/input-router.ts` | Add `Leader o` keybinding |
| `src/command-palette.ts` | Add "Open Markdown Viewer" action |
| `src/styles.css` | Two-panel layout, file list, markdown rendering styles |

## Design

### Data Flow

```
1. User presses Leader o (or command palette "Open Markdown Viewer")
2. Compositor gets CWD via getFocusedCwd()
3. Compositor runs `find . -name '*.md' -type f` via run_command to list .md files
4. Compositor creates MarkdownContentView with the file list and CWD
5. File browser panel renders the list; first file is auto-selected
6. On selection, reads file via run_command('cat', [path]) and renders via marked()
7. Window enters tiling layout with title "MD // <cwd-basename>"
8. Navigation history (jumplist) tracks each file visited
9. Ctrl+O / Ctrl+I move back/forward through jumplist
10. Link hint mode (o) overlays labels on links; typing a label follows the link
    - Local .md links resolve relative to current file and navigate in-viewer
    - External URLs open in browser via open_url
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader o` | Compositor mode | Open markdown viewer for CWD |
| `j` / `k` | File browser focused | Move selection down / up |
| `Enter` / `l` | File browser focused | Open selected file (switch focus to preview) |
| `h` | Preview focused | Switch focus back to file browser |
| `/` | File browser focused | Filter files by typing |
| `Escape` | Filter active | Clear filter |
| `j` / `k` | Preview focused | Scroll down / up |
| `f` / `b` | Preview focused | Page down / page up |
| `g` / `G` | Preview focused | Jump to top / bottom |
| `]` / `[` | Preview focused | Next / previous heading |
| `/` | Preview focused | Open in-doc search HUD (highlights matches) |
| `n` / `N` | Search results active | Next / previous match |
| `Enter` / `Shift+Enter` | Search HUD input | Next / previous match |
| `Escape` / `q` | Search results active | Clear search, close HUD |
| `o` | Preview focused | Enter link hint mode (type label to follow link) |
| `H` | Preview focused | Enter heading hint mode (type label to jump to heading) |
| `Escape` | Link / heading hint active | Cancel hints |
| `Ctrl+o` | Any panel | Jump back in navigation history |
| `Ctrl+i` | Any panel | Jump forward in navigation history |
| `r` | Either panel | Reload current file from disk |
| `R` | Either panel | Refresh file tree (re-scan for new/removed .md files) |
| `v` | Preview focused | Enter Select mode (block selection) |
| `j` / `k` | Select mode | Move selection to next / previous block |
| `J` / `K` | Select mode | Extend selection down / up (visual-line expand) |
| `Shift+j/k` | Select mode | Also extends selection (alternative to J/K) |
| `g` / `G` | Select mode | Extend selection to first / last block |
| `y` | Select mode | Copy selected blocks as raw markdown, exit Select mode |
| `Y` | Select mode | Copy selected blocks as AI context (with file path + line range), exit Select mode |
| `Escape` / `q` | Select mode | Cancel selection, return to preview |
| `q` / `Escape` | Either panel | Close viewer (Escape clears filter first if active) |

### UI Changes

```html
<div class="krypton-md">
  <!-- Top: path line — the shown document -->
  <div class="krypton-md__breadcrumb">~/proj/docs/architecture.md</div>
  <div class="krypton-md__body">
    <!-- Left: file list -->
    <div class="krypton-md__sidebar">
      <div class="krypton-md__file-list">
        <div class="krypton-md__file krypton-md__file--selected">
          <span class="krypton-md__file-icon"></span>
          <span class="krypton-md__file-name">README.md</span>
        </div>
        <div class="krypton-md__file">…docs/architecture.md…</div>
      </div>
    </div>
    <!-- Right: rendered preview -->
    <div class="krypton-md__preview">
      <div class="krypton-md__preview-content">
        <!-- rendered markdown HTML -->
      </div>
    </div>
  </div>
  <!-- Bottom: status readout; hosts the `/` filter prompt -->
  <div class="krypton-md__status">
    <span class="krypton-md__status-text">12 docs │ 3/12</span>
    <input class="krypton-md__filter-input" style="display: none" />
    <span class="krypton-md__filter-count" style="display: none"></span>
  </div>
</div>
```

Layout: the File Manager's (`docs/0052-file-manager.md`) — a path line on top, the file list (333px) beside the preview (fills the rest), a status bar at the bottom.

The surface follows the File Manager design (restyle 2026-11-06; it took the ACP Harness look on 2026-11-05):

- **Lines and text.** Hairline rules at accent@0.18. Ink tiers are the foreground at 0.86 / 0.56 / 0.4 (`--md-ink*`, via `--krypton-ink-2/3/4` on light themes). No text glow, no edge rails (ADR 0027), no hard-coded colours.
- **Path line.** The File Manager breadcrumb: 12px, ink-dim, the shown document's path with the home directory as `~` (the cwd before a document loads). It takes the window accent while the preview has focus.
- **File list.** The File Manager's search rows: terminal cell height and font size, an icon column, then the repo-relative path in the File Manager's document hue. The selected file is the full-row `--mat-select` tint with no outline, whichever panel has focus; the path line's accent shows when the preview has focus. Select mode marks its selected blocks the same way: tint only. A filter with no hits shows `No matches`.
- **Status bar.** The File Manager status readout: 11px uppercase, tracked, ink-dim — `N docs │ filter: <query> │ i/N` (the filter part only while a kept filter is applied).
- **Filter.** `/` in the list turns the status bar into the File Manager's filter prompt: the line takes the accent and reads `/<query>  (N matches)`; the query field has no box and the line's own type. `Enter` keeps the filtered list, `Escape` clears it.

Preview styling — the File Manager preview prose (`file-manager.css` `__preview-markdown`, itself after the harness markdown `.acp-harness__msg-body--markdown`) by value, in theme tokens:
- Headings: monospace, graded h1 (`--agent-cyan`, rule underneath) → h2 (`--agent-user`) → h3 (`--agent-accent`) → h4–h6 small uppercase ink
- Code blocks: a borderless rounded well (dark wash; foreground wash on light themes). Syntax tokens map to the theme's ANSI colours, so light themes stay legible
- Inline code: borderless chip on a faint foreground wash, `--agent-accent` text
- Links: `--agent-user` text with an accent underline, clickable — local `.md` links navigate within the viewer, external URLs open in browser via `open_url`. Keyboard-accessible via link hint mode (`o`), whose labels are the global hint-mode labels
- Lists: `--agent-accent` bullets/numbers
- Blockquotes: a tinted, rounded block in the foreground ink — no left border
- Tables: one rounded hairline frame, accent-tinted header row
- Images: rendered inline — relative `src` is resolved against the current file's directory and loaded via Tauri's `convertFileSrc()` (asset protocol; raw `file://` is blocked cross-origin in the webview). A failed load is replaced with an `IMG BREACH // <path>` notice. See `docs/0137-markdown-viewer-search-hints-images.md`.
- Horizontal rules: a neutral foreground hairline
- Reveal: on load the first 40 blocks fade and rise in a 30ms stagger, headings included. No glow or blur.

## Edge Cases

- **No .md files**: Show "No markdown files found" in the preview
- **File read error**: Show error message in preview area
- **Very large files**: Cap at 200KB, show "File truncated" notice
- **Deep directories**: List files recursively, show relative paths, max depth 5
- **Binary .md files**: Unlikely, but show raw content if marked() fails
- **Empty CWD**: Falls back to home directory

## Out of Scope

- Live file watching / auto-reload on change (manual reload via `r` / `R` is supported)
- Editing markdown
- Mermaid / diagram rendering
- Tree view (files are a flat sorted list with relative paths)
- Creating new markdown files
