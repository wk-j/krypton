# Markdown Viewer Window — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: M8 — Polish
>
> Enhancements (in-doc search, heading hints, image fix, focus indicator, re-select guard): see `docs/0137-markdown-viewer-search-hints-images.md`.

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

The surface follows the ACP Harness look, as the File Manager does (restyle 2026-11-05):

- **Lines and text.** Hairline rules at accent@0.18. Ink tiers are the foreground at 0.86 / 0.56 / 0.4 (`--md-ink*`, via `--krypton-ink-2/3/4` on light themes). No text glow, no edge rails (ADR 0027), no hard-coded colours.
- **Headers.** The sidebar header (`DOCS`) is an uppercase panel label; the preview header is the file path in natural case. The focused panel's header is the window accent and the other drops to the faint tier.
- **File list.** Rounded rows in the foreground ink. The selected file is the harness picker's active row — accent@0.12 tint plus a 1px accent@0.5 inset outline — while the sidebar has focus; with the preview focused only the tint stays.
- **Filter input.** A rounded field on a faint foreground wash, hairline border that steps to accent@0.5 on focus; it appears when `/` is pressed in the sidebar.

Preview styling — the harness markdown (`harness-shared.css` `.acp-harness__msg-body--markdown`), in theme tokens:
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
