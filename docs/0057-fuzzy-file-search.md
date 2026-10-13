# Fuzzy File Search — Implementation Spec

> Status: Implemented
> Date: 2026-04-07

## Problem

The file manager's `/` filter only matches against filenames in the current directory. Users need a way to fuzzy-search across the entire project tree (like `Ctrl+P` in VS Code or `fzf`) to quickly jump to any file, with `.gitignore` rules automatically respected.

## Solution

Add a recursive fuzzy file search mode to the file manager, triggered by `Ctrl+F`. A new Rust backend command walks the directory tree using the `ignore` crate (which natively respects `.gitignore`, `.git/info/exclude`, and global gitignore). The frontend collects the file list once on activation, then performs client-side fuzzy matching as the user types, displaying results as relative paths. Selecting a result navigates the file manager to that file's directory with the file highlighted, or opens a preview.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `ignore` crate dependency |
| `src-tauri/src/commands.rs` | Add `search_files` command |
| `src-tauri/src/lib.rs` | Register `search_files` in invoke handler |
| `src/file-manager.ts` | Add search mode UI, key handling, fuzzy scoring |

## Design

### Data Structures

```rust
// No new struct needed — returns Vec<String> of relative paths
```

```typescript
// New state on FileManagerView
private searchMode: boolean;       // true when Ctrl+F search is active
private searchText: string;        // current query
private searchResults: string[];   // matched relative paths (scored + sorted)
private searchPool: string[];      // all files from backend (cached)
private searchCursor: number;      // selected result index
```

### API / Commands

```rust
#[tauri::command]
pub fn search_files(root: String, show_hidden: bool) -> Result<Vec<String>, String>
```

- Walks `root` recursively using `ignore::WalkBuilder`
- Respects `.gitignore` at all levels, `.git/info/exclude`, global gitignore
- Returns relative paths (relative to `root`) for files only (no directories)
- `show_hidden` controls whether hidden files are included (maps to `WalkBuilder::hidden()`)
- Skips `.git` directory itself
- Caps results at 50,000 files to prevent memory issues on huge repos

### Data Flow

```
1. User presses Ctrl+F in file manager
2. searchMode = true, invoke('search_files', { root: initialCwd })
3. Backend walks tree with ignore crate, returns Vec<String> of relative paths
4. Frontend stores searchPool, shows search input in breadcrumb area
5. User types characters → fuzzy match against searchPool → render top matches
6. User presses Enter on a result → navigate to that file's parent dir, highlight file
7. User presses Escape → exit search mode, return to normal browsing
```

### Fuzzy Scoring

Client-side fuzzy scoring algorithm (no external dependency):
- Subsequence match: all query chars must appear in order (case-insensitive)
- Score bonuses: consecutive matches, match after `/` or `.` or `_`/`-` (word boundary), match at start
- Results sorted by score descending, then path length ascending (shorter paths preferred)
- Display: highlight matched characters in the result path

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+F` | Normal mode | Enter search mode (fetch file list + show input) |
| typing | Search mode | Update query, re-score and re-render |
| `j` / `↓` | Search mode | Move cursor down in results |
| `k` / `↑` | Search mode | Move cursor up in results |
| `Enter` | Search mode | Navigate to selected file (cd to parent, highlight file) |
| `Escape` | Search mode | Exit search mode |
| `Backspace` | Search mode | Delete last query character |
| `Ctrl+U` | Search mode | Clear query |

### UI Changes

When search mode is active:
- Breadcrumb shows: `SEARCH // {query}█` (replacing the path)
- List shows matched file paths (relative to search root) instead of directory entries
- Each row shows the relative path with matched characters highlighted (bold/colored)
- Status bar shows: `{N} matches — search from {root}`
- Preview panel works normally (shows preview of cursor file using absolute path)

## Edge Cases

- **No `.gitignore` present**: All files returned (except `.git/` dir which is always skipped)
- **Empty query**: Show all files from pool (up to visible rows), sorted alphabetically
- **No matches**: Show "No matches" empty state
- **Very large repo (50k+ files)**: Pool capped at 50,000; status bar shows "(capped)" indicator
- **Symlink loops**: `ignore` crate handles this by default (no infinite loops)
- **Permission errors**: Silently skipped (matching `ignore` crate default behavior)
- **Search root**: Always uses the file manager's initial directory (project root), regardless of current browsing location
- **Enter on result**: Navigates to parent dir, sets cursor to the file. If dir loading changes entries, find by name.

## Out of Scope

- Content/grep search (searching inside files) — this is filename-only fuzzy search
- Persistent search index or caching across file manager sessions
- Custom ignore patterns beyond `.gitignore`
