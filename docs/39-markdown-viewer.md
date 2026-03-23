# Markdown Viewer Window — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: M8 — Polish

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
| `r` | Either panel | Reload current file from disk |
| `R` | Either panel | Refresh file tree (re-scan for new/removed .md files) |
| `v` | Preview focused | Enter Select mode (block selection) |
| `j` / `k` | Select mode | Move selection to next / previous block |
| `J` / `K` | Select mode | Extend selection down / up (visual-line expand) |
| `Shift+j/k` | Select mode | Also extends selection (alternative to J/K) |
| `g` / `G` | Select mode | Extend selection to first / last block |
| `y` | Select mode | Copy selected blocks to clipboard, exit Select mode |
| `Escape` / `q` | Select mode | Cancel selection, return to preview |
| `q` / `Escape` | Either panel | Close viewer (Escape clears filter first if active) |

### UI Changes

```html
<div class="krypton-md">
  <!-- Left: file browser -->
  <div class="krypton-md__sidebar">
    <div class="krypton-md__sidebar-header">DOCS</div>
    <div class="krypton-md__filter">
      <input class="krypton-md__filter-input" placeholder="filter..." />
    </div>
    <div class="krypton-md__file-list">
      <div class="krypton-md__file krypton-md__file--selected">README.md</div>
      <div class="krypton-md__file">docs/architecture.md</div>
      <div class="krypton-md__file">CHANGELOG.md</div>
    </div>
  </div>
  <!-- Right: rendered preview -->
  <div class="krypton-md__preview">
    <div class="krypton-md__preview-header">
      <span class="krypton-md__file-path">README.md</span>
    </div>
    <div class="krypton-md__preview-content">
      <!-- rendered markdown HTML -->
    </div>
  </div>
</div>
```

Layout: sidebar 250px fixed width, preview fills remaining space.

Sidebar styling:
- File list: monospace, one file per row, relative paths from CWD
- Selected file: accent-colored highlight bar
- Focused panel: subtle accent border on the active side
- Filter input: appears at top when `/` pressed, accent-colored underline

Preview styling (dark theme matching Krypton):
- Headings: accent-colored, monospace, sized h1→h6
- Code blocks: dark background with accent border, uses configured font
- Inline code: subtle background highlight
- Links: accent-colored, clickable (opens in browser via `open_url`)
- Lists: accent-colored bullets/numbers
- Blockquotes: left border accent, dimmed text
- Tables: bordered, alternating row tint
- Images: rendered inline (file:// URLs for local images)
- Horizontal rules: accent-colored line

## Edge Cases

- **No .md files**: Show "No markdown files found" in sidebar
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
