# File Manager Window — Implementation Spec

> Status: Implemented
> Date: 2026-04-04
> Milestone: M8 — Polish

## Problem

Navigating the filesystem requires dropping into a shell and running `ls`, `cd`, `cat`, etc. A keyboard-driven file manager as a native content view would let users browse, preview, and manipulate files without leaving the compositor — matching the keyboard-first, cyberpunk design language.

## Solution

Implement a `FileManagerView` as a new `ContentView` type that renders inside existing pane/tab infrastructure. Two-column Miller-style layout: file list on the left, preview panel on the right. All navigation is vim-style (`hjkl`). File operations use single-key commands with confirmation. A dedicated `list_directory` Tauri command provides fast, structured directory listings from the backend.

## Affected Files

| File | Change |
|------|--------|
| `src/file-manager.ts` | **New** — `FileManagerView` class implementing `ContentView` |
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

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `l` / `Enter` | Enter directory / open file in `$EDITOR` via terminal |
| `h` / `Backspace` | Go to parent directory |
| `gg` | Jump to first entry |
| `G` | Jump to last entry |
| `Ctrl+d` | Page down (half screen) |
| `Ctrl+u` | Page up (half screen) |
| `/` | Enter filter mode (fuzzy search) |
| `Escape` | Exit filter mode / clear marks |
| `q` | Close file manager tab |
| `.` | Toggle hidden files |
| `s` | Cycle sort: name → size → modified |
| `S` | Reverse sort order |
| `Space` | Toggle mark on current entry, move down |
| `v` | Toggle mark on all entries |
| `y` | Yank (copy) marked files — prompts for destination |
| `m` | Move marked files — prompts for destination |
| `D` | Delete marked files (with confirmation) |
| `r` | Rename current file (inline edit in status bar) |
| `A` | Create new file (prompts name in status bar) |
| `M` | Create new directory (mkdir, prompts name) |
| `p` | Open preview panel toggle (show/hide right pane) |
| `~` | Jump to home directory |
| `-` | Jump back in directory history |
| `o` | Open file in a new terminal tab (runs `$EDITOR <file>`) |

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
│  ● package.json ◄    │  {                           │
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
- `◄` cursor indicator on focused row
- Left panel: 60% width, right panel: 40% width (preview)
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

All colors via `--krypton-*` CSS custom properties. BEM naming with `.krypton-file-manager` block. Monospace font matching terminal. Cursor row highlighted with accent-colored left border and subtle background. Directories rendered in accent color. Marked files get a distinct marker glyph. No scroll bars — virtual scrolling with visible row count calculated from container height and line height.

## Edge Cases

- **Empty directory:** Show only `..` entry, preview panel says "Empty directory"
- **Permission denied:** Show error in status bar, don't crash. Entry rendered dimmed
- **Binary files:** Preview shows "Binary file — N bytes" with hex dump of first 256 bytes
- **Very large directories (10k+ entries):** Virtual scrolling — only render visible rows. `list_directory` returns all entries but DOM is windowed
- **Symlinks:** Show with `→ target` suffix, follow on enter. Broken symlinks shown in error color
- **Long filenames:** Truncate with `…` in list, show full name in status bar when cursor is on it
- **File deleted externally:** Re-list on focus returns to the directory. If current file disappears, cursor moves to nearest valid entry

## Out of Scope

- Image/media preview (text-only for now)
- Git status integration (file colors based on git status) — possible future enhancement
- Drag-and-drop (keyboard-only)
- Multi-pane file manager (e.g. dual-pane commander style) — single list + preview only
- Custom file associations / opener configuration
- Tree view (flat list per directory, not recursive tree)
