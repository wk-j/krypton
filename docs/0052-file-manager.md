# File Manager Window — Implementation Spec

> Status: Implemented
> Superseded in structure by [317](./0317-file-manager-components.md) — the view now lives in `src/file-manager/` (components, keymap, preview registry). Behaviour below is unchanged.
> Date: 2026-04-04
> Milestone: M8 — Polish

## Problem

Navigating the filesystem requires dropping into a shell and running `ls`, `cd`, `cat`, etc. A keyboard-driven file manager as a native content view would let users browse, preview, and manipulate files without leaving the compositor — matching the keyboard-first, cyberpunk design language.

## Solution

Implement a `FileManagerView` as a new `ContentView` type that renders inside existing pane/tab infrastructure. Two-column Miller-style layout: file list on the left, preview panel on the right. All navigation is vim-style (`hjkl`). File operations use single-key commands with confirmation. A dedicated `list_directory` Tauri command provides fast, structured directory listings from the backend.

## Affected Files

| File | Change |
|------|--------|
| `src/file-manager.ts` | **New** — `FileManagerView` class implementing `ContentView` (spec 317: replaced by the `src/file-manager/` package) |
| `src/file-manager/` | Spec 317 — `index.ts` re-export, `view.ts` orchestrator, `state.ts`, pure modules, `keymap.ts`, `modes.ts`, `ops.ts`, `preview/`, `components/` |
| `src/types.ts` | Add `'file_manager'` to `PaneContentType` union |
| `src/compositor.ts` | Add `openFileManager()` method |
| `src/input-router.ts` | Add `b` key in Compositor mode to open file manager |
| `src/styles.css` | Add `.krypton-file-manager*` styles |
| `src-tauri/src/commands.rs` | Add `list_directory` command |
| `src-tauri/src/lib.rs` | Register `list_directory` in invoke handler |

## Design

### Data Structures

```rust
// Backend — commands.rs
#[derive(serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: u64,       // Unix timestamp
    pub permissions: String, // e.g. "rwxr-xr-x"
}
```

```typescript
// Frontend — file-manager.ts
interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: number;
  permissions: string;
}

type SortField = 'name' | 'size' | 'modified';
type SortOrder = 'asc' | 'desc';

interface FileManagerState {
  cwd: string;
  entries: FileEntry[];
  cursor: number;          // Index of highlighted entry
  scrollOffset: number;    // First visible row
  sortField: SortField;
  sortOrder: SortOrder;
  filter: string | null;   // Active fuzzy filter text
  filterMode: boolean;     // Whether filter input is active
  marked: Set<string>;     // Paths of marked/selected files
  preview: string | null;  // Text content of previewed file
  showHidden: boolean;     // Toggle dotfiles
  history: string[];       // Directory history for backtrack
}
```

### API / Commands

```rust
#[tauri::command]
pub fn list_directory(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String>
```

No new IPC events needed — directory listing is request/response. File preview uses the existing `read_file` command. File operations (copy, move, delete, rename) use the existing `run_command` command.

### Data Flow

**Directory navigation:**
```
1. User presses `l` (or Enter) on a directory entry
2. FileManagerView calls invoke('list_directory', { path, showHidden })
3. Rust reads directory via std::fs::read_dir, returns Vec<FileEntry>
4. FileManagerView updates state.entries, resets cursor to 0, re-renders list
5. Preview panel clears (no file selected yet)
```

**File preview:**
```
1. User moves cursor with j/k onto a file
2. FileManagerView calls invoke('read_file', { path }) (max 64KB)
3. Preview panel renders text content with syntax class based on extension
4. If file is binary or too large, shows metadata summary instead
```

**File operation (e.g. delete):**
```
1. User presses `D` on a file (or on marked selection)
2. Confirmation prompt appears in status bar: "Delete <name>? [y/N]"
3. User presses `y` — FileManagerView calls invoke('run_command', { program: 'rm', args: ['-rf', path] })
4. On success, re-lists directory
```

### Keybindings

**Compositor mode (Leader → key):**

| Key | Action |
|-----|--------|
| `b` | Open file manager in new tab (CWD from focused terminal) |

**File manager internal (Normal mode, when file manager pane is focused):**

Generated from `NORMAL_KEYMAP` (`src/file-manager/keymap.ts`, spec 317), in table order. Moving the cursor does **not** load a preview; `o`, `l`/`Enter` on a file and a search select do.

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `l` / `Enter` | Enter directory / preview file |
| `h` / `Backspace` | Go to parent directory |
| `gg` | Jump to top (second `g` within 500 ms) |
| `J` | Scroll preview down |
| `K` | Scroll preview up |
| `H` | Narrow the list column |
| `L` | Widen the list column |
| `G` | Jump to bottom |
| `Ctrl+d` | Half page down |
| `Ctrl+u` | Half page up |
| `/` | Filter by name (in-order subsequence; `Enter` keeps, `Escape` clears) |
| `q` | Close the file manager |
| `Escape` | Clear marks |
| `.` | Toggle hidden files |
| `s` / `Shift+s` | `s`: cycle sort field (name → size → modified); `Shift+s` (`e.key === 's'` with shift held): reverse order. `S` as delivered by most layouts is unbound. |
| `Space` | Toggle mark and move down |
| `v` | Mark / unmark all |
| `y` | Yank (copy) marked or current |
| `x` | Cut marked or current |
| `D` | Delete marked or current (confirm `y`/N; any other key cancels) |
| `r` | Rename current (inline prompt in status bar) |
| `A` | Create file (prompt) |
| `M` | Create directory (prompt) |
| `~` | Go to home directory (only if it is under the start directory) |
| `-` | Go back in history |
| `p` | Paste clipboard into the current directory (same-dir copy gets `name 2.ext`) |
| `o` | Open preview for the current file |
| `w` | Show / hide the preview pane |
| `Y` | Copy the absolute path to the clipboard |
| `i` | Open the AI assistant (spec 055) |
| `t` | Track marked or current file as a diff baseline |
| `T` | Open the diff against tracked baselines |
| `f` | Fuzzy-search files under the start directory (`Ctrl+j`/`Ctrl+k`/arrows move, `Ctrl+u` clears, `Enter` selects, `Escape` exits) |

### UI Structure

```
┌─────────────────────────────────────────────────────┐
│ [tab: FILE // ~/Source/krypton]                     │  ← standard window chrome/tab bar
├──────────────────────┬──────────────────────────────┤
│  ..                  │                              │
│  ▸ src/              │  // Preview of selected file │
│  ▸ src-tauri/        │  or directory summary        │
│  ▸ docs/             │                              │
│  ▸ node_modules/     │  package.json                │
│  ● package.json      │  {                           │
│    tsconfig.json     │    "name": "krypton",        │
│    vite.config.ts    │    "version": "0.1.0",       │
│    Makefile          │    ...                       │
│                      │  }                           │
├──────────────────────┴──────────────────────────────┤
│ 12 items | 2 marked | sort: name ↑ | rwxr-xr-x 4KB│  ← status bar
└─────────────────────────────────────────────────────┘
```

- `▸` prefix for directories, no prefix for files
- `●` marker for marked/selected files
- Keyboard navigation highlights the selected row with a plain background, without cursor glyphs or pipe chrome
- Left panel: 333px initial width, right panel fills the remaining space (preview)
- `H` / `L` resize the left panel in roughly 5% viewport-width increments, clamped between 15% and 85% of the file manager body
- Status bar: item count, marked count, sort info, permissions + size of cursor item

**DOM structure:**

```html
<div class="krypton-file-manager">
  <div class="krypton-file-manager__breadcrumb">~/Source/krypton</div>
  <div class="krypton-file-manager__body">
    <div class="krypton-file-manager__list">
      <div class="krypton-file-manager__item krypton-file-manager__item--dir">..</div>
      <div class="krypton-file-manager__item krypton-file-manager__item--dir krypton-file-manager__item--cursor">src/</div>
      <div class="krypton-file-manager__item krypton-file-manager__item--marked">package.json</div>
    </div>
    <div class="krypton-file-manager__preview">
      <pre class="krypton-file-manager__preview-content">...</pre>
    </div>
  </div>
  <div class="krypton-file-manager__status">...</div>
</div>
```

### CSS Approach

All colors via `--krypton-*` CSS custom properties. BEM naming with `.krypton-file-manager` block. Monospace font matching terminal. The selected row uses a plain subtle background only; cursor glyphs, pipe chrome, pulse animations, and cursor-specific type-color overrides are omitted. Directories render in accent color. Marked files get a distinct marker glyph. No scroll bars — virtual scrolling with visible row count calculated from container height and line height.

The file manager surface allows native text selection across the breadcrumb, file list, status line, and preview content so global copy-on-select can copy visible paths, names, and preview text. Decorative columns such as mark glyphs, file icons, and age bars remain non-selectable to keep copied list text focused on content.

## Edge Cases

- **Empty directory:** Show only `..` entry, preview panel says "Empty directory"
- **Permission denied:** Show error in status bar, don't crash. Entry rendered dimmed
- **Binary files:** Preview shows "Binary file — N bytes" with hex dump of first 256 bytes
- **Very large directories (10k+ entries):** Virtual scrolling — only render visible rows. `list_directory` returns all entries but DOM is windowed
- **Symlinks:** Show with `→ target` suffix, follow on enter. Broken symlinks shown in error color
- **Long filenames:** Truncate with `…` in list, show full name in status bar when cursor is on it
- **File deleted externally:** Re-list on focus returns to the directory. If current file disappears, cursor moves to nearest valid entry

## Smooth scrolling

Since spec 317 the preview and the list glide instead of jumping. The code is in
`src/file-manager/smooth-scroll.ts`, and docs/0317-file-manager-components.md § Smooth scrolling has the details.

- **Preview `J` / `K`** animates `scrollTop` with the diff view's easing (`SCROLL_LERP = 0.24`,
  `SCROLL_SNAP_PX = 0.5`). Holding a key moves the target further instead of restarting the animation.
- **List** (directory and fuzzy search): the window is still virtual, but it now renders
  `LIST_OVERSCAN = 3` extra rows on each side and is moved with a `translateY` toward
  `scrollOffset × cellHeight`. Cursor moves that cross the edge, and ctrl+d / ctrl+u, glide. Jumps
  larger than one viewport (G, gg) snap, as do directory changes, filter or sort changes, and switching
  between file and search mode. The cursor highlight is always instant.
- `prefers-reduced-motion: reduce` turns off both animations: every scroll lands immediately.

## Out of Scope

- Image/media preview (text-only for now)
- Git status integration (file colors based on git status) — possible future enhancement
- Drag-and-drop (keyboard-only)
- Multi-pane file manager (e.g. dual-pane commander style) — single list + preview only
- Custom file associations / opener configuration
- Tree view (flat list per directory, not recursive tree)
