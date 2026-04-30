# Pencil Window (Excalidraw Editor) — Implementation Spec

> Status: Implemented
> Date: 2026-04-30
> Milestone: N/A — New feature

## Problem

Krypton has no way to view or edit hand-drawn diagrams. Users who keep architecture sketches, flowcharts, or whiteboard notes alongside their code (commonly as `.excalidraw` files) currently have to leave the terminal and open VS Code, the web app at excalidraw.com, or Obsidian's Excalidraw plugin. We want a first-class **Pencil window** that opens and edits `.excalidraw` files directly inside Krypton's compositor — modeled on the same content-view pattern as the Vault window.

## Solution

Add a new `PencilContentView` implementing the existing `ContentView` interface and registered as a new `PaneContentType` (`'pencil'`). The view embeds the official `@excalidraw/excalidraw` React component inside a `ReactDOM` root that lives in the view's container element. React, ReactDOM, and Excalidraw are **lazy-loaded** via dynamic `import()` so they are absent from Krypton's main bundle.

The compositor exposes `openPencil(filePath?)`. With no path it reads `[pencil] dir` from `krypton.toml`, scans recursively for `.excalidraw` files, and shows a fuzzy picker (mtime-sorted) with a synthetic "New drawing" row at the top. With a path it opens the file directly (used by future quick-file-search routing). If the file is already open in another Pencil tab, that tab is refocused instead of creating a new one.

File IO uses two new Tauri commands `read_pencil_file` / `write_pencil_file` (atomic temp+rename). Save is autosave-on-change (800 ms debounced) plus `Cmd+S` to flush immediately. Theme follows Krypton's background luminance (light/dark switch) — no separate config option.

## Research

**Excalidraw library API (`@excalidraw/excalidraw`):**
- Ships only as a React component. There is no official vanilla-JS build.
- Requires React 18+ (React 19 supported as of v0.18).
- Two key props: `initialData` (loaded scene) and `onChange(elements, appState, files)`.
- `excalidrawAPI` callback exposes `updateScene`, `getSceneElements`, `getAppState`, `getFiles`, `history.clear()` for imperative use.
- Stylesheet must be imported separately: `import '@excalidraw/excalidraw/index.css'`.
- Bundle is ~2.5 MB minified; with dynamic `import()` it splits into its own chunk.
- `serializeAsJSON(elements, appState, files, "local")` returns the canonical persisted JSON, automatically stripping runtime-only fields (selectedIds, active tool, viewport, collaborators).

**`.excalidraw` file format:**
- Plain JSON: `{ type: "excalidraw", version: 2, source, elements: [...], appState: {...}, files: {...} }`.

**Krypton ContentView pattern (`src/types.ts:113-124`, `src/vault-view.ts`):**
- Implementations expose `element: HTMLElement`, `onKeyDown`, `dispose`, optional `onResize`, `getWorkingDirectory`.
- Keys flow: input-router → `contentView.onKeyDown(e)`. Returning `false` lets the event propagate to the React subtree (Excalidraw can capture). Krypton's global shortcuts (Leader, `Cmd+I`, `Cmd+Shift+P`, `Cmd+O`, etc.) are intercepted by input-router *before* delegation, so the content view doesn't have to forward them.

**Alternatives considered:**
1. *Build our own Excalidraw-like canvas.* Months of work; ruled out.
2. *Embed Excalidraw via `<iframe>` to excalidraw.com.* No filesystem access, no offline, no theme sync, no keyboard event flow into Krypton. Ruled out.
3. *Use `tldraw` instead.* Also React-only, different format. User explicitly asked for Excalidraw.
4. *Add React app-wide.* Rejected — Krypton's "no frontend frameworks" rule. We scope React strictly to this one lazy-loaded view.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code (`pomdaw.excalidraw-editor`) | Custom editor binding for `.excalidraw`; webview hosts the Excalidraw React component; messages between extension host and webview for read/write. | Closest analog. We replicate the experience but skip the webview boundary since Krypton already runs in a web context. |
| Obsidian (Excalidraw plugin) | Embeds inside an Obsidian view; compresses scene JSON into markdown with embedded SVG. | More complex format; out of scope for v1. |
| Excalidraw desktop app (Electron) | Wraps the same React component with a thin Electron shell; Cmd+S writes via Node `fs`. | Same shape as Pencil window. |

**Krypton delta:** matches the VS Code/desktop convention — in-app editor, native save, no iframe. Diverges by being keyboard-first (Leader-key entry, single-window picker), config-driven directory scoping (no built-in file dialog), and theme-synced with Krypton's bg luminance. Auto-save is on-by-default (matches VS Code plugin) — no manual-save mode.

## Affected Files

| File | Change |
|------|--------|
| `src/pencil-view.ts` | **New** — `PencilContentView` class, lazy React mount, IO, dirty tracking, autosave |
| `src/styles/pencil-view.css` | **New** — `.krypton-pencil` chrome (statusbar + canvas container) |
| `src/styles/index.css` | Import `pencil-view.css` and `@excalidraw/excalidraw/index.css` |
| `src/types.ts` | Add `'pencil'` to `PaneContentType` |
| `src/compositor.ts` | Add `openPencil(filePath?: string)` with picker + refocus logic |
| `src/command-palette.ts` | Register `pencil.open` action with `Leader e` |
| `src-tauri/src/pencil.rs` | **New** — `read_pencil_file`, `write_pencil_file`, `scan_pencil_dir` |
| `src-tauri/src/lib.rs` | Register the three commands in `invoke_handler!` |
| `src-tauri/src/config.rs` | Add `[pencil]` section: `dir: Option<PathBuf>` |
| `package.json` | Add `react@^19`, `react-dom@^19`, `@excalidraw/excalidraw`; devDeps `@types/react`, `@types/react-dom` |
| `docs/PROGRESS.md` | Note Pencil window milestone |
| `docs/04-architecture.md` | Add Pencil view to module list |
| `docs/06-configuration.md` | Document `[pencil] dir` |

## Design

### Data Structures

```typescript
// types.ts — extend union
export type PaneContentType =
  | 'terminal' | 'diff' | 'markdown' | 'agent' | 'acp'
  | 'context' | 'file_manager' | 'vault' | 'hurl' | 'pencil';

// pencil-view.ts
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export class PencilContentView implements ContentView {
  readonly type = 'pencil';
  readonly element: HTMLElement;
  readonly filePath: string;          // absolute, always set at construction
  private dirty = false;
  private lastSerialized = '';        // last successfully saved JSON for noise filtering
  private saveStatus: SaveStatus = 'idle';
  private lastError: string | null = null;
  private excalidrawAPI: ExcalidrawImperativeAPI | null = null;
  private reactRoot: Root | null = null;
  private saveTimer: number | null = null;

  // ContentView API
  onKeyDown(e: KeyboardEvent): boolean;   // intercept Cmd+S only
  dispose(): void;                         // flushes sync if dirty, unmounts React
  onResize(w: number, h: number): void;    // Excalidraw uses its own ResizeObserver; no-op fine
  getWorkingDirectory(): string | null;    // dirname(filePath)

  // Internal
  private async loadFile(): Promise<void>;
  private async saveFile(): Promise<void>; // serialize → atomic write; updates lastSerialized
  private scheduleAutosave(): void;        // 800 ms debounce
  private async flushSync(): Promise<void>; // for dispose / beforeunload

  onClose(cb: () => void): void;
  onTitleChange(cb: (title: string) => void): void;
}
```

### Tauri Commands

```rust
// src-tauri/src/pencil.rs
#[tauri::command]
pub async fn read_pencil_file(path: String) -> Result<String, String>;
// Reads UTF-8 file. Errors if missing or unreadable.

#[tauri::command]
pub async fn write_pencil_file(path: String, contents: String) -> Result<(), String>;
// Validates `contents` parses as JSON with `type == "excalidraw"`,
// writes to `<path>.tmp` then renames atomically.

#[tauri::command]
pub async fn scan_pencil_dir(dir: String) -> Result<Vec<PencilEntry>, String>;
#[derive(serde::Serialize)]
pub struct PencilEntry { pub path: String, pub modified_ms: u64 }
// Recursive walk under `dir`, filter `*.excalidraw`, return absolute paths + mtime.
// Errors if `dir` doesn't exist.
```

### Config

```toml
[pencil]
# Default directory scanned for the picker. Required for the picker to open;
# absolute paths can still be opened via openPencil(path) without this set.
dir = "~/Documents/excalidraw"
```

If unset and user invokes `Leader e`: `showNotification('No pencil dir configured — set [pencil] dir in krypton.toml')` and abort. (Mirrors Vault behavior at `compositor.ts:1712`.)

### Data Flow

**Open via Leader e (no path):**
```
1. User triggers `pencil.open` (Leader e)
2. compositor.openPencil() reads [pencil] dir from config
3. If unset → notification + abort
4. invoke('scan_pencil_dir', { dir }) → Vec<PencilEntry>
5. Sort entries by modified_ms desc; prepend synthetic "+ New drawing" row
6. Show picker (reuse vault picker pattern from compositor.ts:1870)
7. User selects:
   - Existing file → openPencil(absolutePath)
   - "New drawing" → promptDialog for name → resolve to <dir>/<name>.excalidraw
     → openPencil(resolvedPath)  (will open existing content if file already exists — Q11)
```

**openPencil(absolutePath) — direct entry:**
```
1. Search compositor's tabs for any PencilContentView with matching filePath
   - If found → focus that tab (no new tab) and return
2. Construct PencilContentView(absolutePath, container)
3. createContentTab('PENCIL // <basename>', view)
4. view loads file:
   - invoke('read_pencil_file', { path }) → JSON string
   - If file doesn't exist (Err) → start with empty scene, mark dirty (first save creates file)
   - Else parse, save to lastSerialized, set up Excalidraw initialData
5. Lazy import: react, react-dom/client, @excalidraw/excalidraw
6. ReactDOM.createRoot(canvasEl).render(<Excalidraw .../>)
7. Subscribe to theme-changed event → recompute luminance → updateScene({appState: {theme}})
```

**onChange handler:**
```
1. Excalidraw fires onChange(elements, appState, files)
2. Compute serialized = serializeAsJSON(elements, appState, files, "local")
3. If serialized === lastSerialized → no-op (filters out cursor / selection / viewport churn)
4. Else: dirty = true, scheduleAutosave()
```

**scheduleAutosave():**
```
1. Clear existing saveTimer
2. saveTimer = setTimeout(saveFile, 800)
```

**saveFile():**
```
1. saveStatus = 'saving'; updateStatusBar()
2. try invoke('write_pencil_file', { path, contents: serialized })
3. Success → lastSerialized = serialized, dirty = false, saveStatus = 'saved'
4. Failure → saveStatus = 'error', lastError = err, showNotification('Pencil save failed: <err>')
   dirty stays true → next onChange triggers a new debounce → automatic retry
5. updateStatusBar() and updateTitle()
```

**Cmd+S in onKeyDown:**
```
1. clear saveTimer
2. await saveFile()  (immediate flush)
3. return true (consume event)
```

**dispose() (called on tab close, including Cmd+W):**
```
1. clear saveTimer
2. if dirty → await flushSync()  (synchronous-await the final write)
3. if final save fails → showNotification('Pencil closed without save: <reason>') (Q18)
4. reactRoot.unmount()
5. fire onClose callbacks
```

**beforeunload (app/window quit):**
```
1. window.addEventListener('beforeunload', handler)
2. handler: if dirty → invoke('write_pencil_file', ...) (fire-and-forget; Rust process completes the write even after frontend tears down)
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader e` | Compositor mode | Open Pencil picker (or notification if no dir) |
| `Cmd+S` | Pencil view focused | Force immediate save |

All other keys flow through to Excalidraw (its tool shortcuts: V/R/A/D/T/E, Cmd+Z/Shift+Z, Cmd+A, Delete, arrows, +/-, Esc). Krypton globals (Leader, Cmd+I, Cmd+Shift+P, Cmd+O, Cmd+1..9, etc.) are handled by input-router before content view.

### Theme Sync

```
1. On mount: read getComputedStyle(document.documentElement).getPropertyValue('--krypton-bg')
2. Parse to RGB, compute relative luminance
3. theme = luminance < 0.5 ? 'dark' : 'light'
4. Pass as initialData.appState.theme
5. Listen for Tauri 'theme-changed' event → recompute → excalidrawAPI.updateScene({appState: {theme: newTheme}})
```

### UI

```
.krypton-pencil
├── .krypton-pencil__statusbar       ← 1 line: relative path + status pill
└── .krypton-pencil__canvas           ← flex: 1; React mount point
```

Status pill text:
- `idle` / `saved` → relative path only (no pill)
- `saving` → `[ saving... ]`
- `error` → `[ ! save failed: <reason> ]`

Tab title:
- Default: `PENCIL // <basename-without-ext>`
- Save error: `PENCIL // <basename> [!]`

CSS scope: `.krypton-pencil` only. Excalidraw's own stylesheet handles the canvas; we don't override it.

## Edge Cases

- **File missing on open** — `read_pencil_file` returns Err; view starts with empty scene marked dirty; first autosave creates the file.
- **File exists but invalid JSON** — start empty + dirty; first save overwrites cleanly. Log a warning.
- **"New drawing" with existing name** — open the existing file (Q11), no overwrite.
- **Same file opened twice** — second open refocuses the first tab (Q12), no duplicate state.
- **`[pencil] dir` not set** — picker mode shows notification and aborts; direct `openPencil(path)` still works for any absolute path (Q17).
- **Save fails** — notification + dirty stays + retry on next edit (Q15).
- **Close while save fails** — flush sync, also fails → warning notification, close anyway, data lost (Q18).
- **App quit during debounce** — `dispose` flushes sync; `beforeunload` fires fire-and-forget save before window tears down (Q16).
- **Concurrent external edit** — no file watcher; last writer wins. Out of scope.
- **`onChange` fires for cursor moves** — `serializeAsJSON` strips runtime fields, so `serialized === lastSerialized` short-circuits noise (Q14).
- **Excalidraw bundle load fails** — caught; render fallback "Failed to load Excalidraw: <err>" inside canvas div.

## Out of Scope

- Quick-file-search routing `.excalidraw` files into a Pencil window (follow-up — API supports it via `openPencil(absolutePath)`).
- `.excalidraw.svg` / `.excalidraw.png` round-trip formats.
- File watcher for external edits.
- Live collaboration / Excalidraw rooms.
- Custom Krypton color theming of the canvas (only light/dark sync).
- Export to PNG/SVG via Krypton commands (Excalidraw's built-in export menu still works).
- Multiple `[pencil]` directories or named collections (extensible later without breaking config).
- Recovery file on save-fail-during-close (would extend Q18 from notification-only to dump-then-notify).

## Resources

- [@excalidraw/excalidraw npm](https://www.npmjs.com/package/@excalidraw/excalidraw) — React-only distribution, peer deps.
- [Excalidraw docs — Integration](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration) — `excalidrawAPI`, `initialData`, `onChange` shape, `serializeAsJSON`.
- [Excalidraw JSON schema](https://docs.excalidraw.com/docs/codebase/json-schema) — `.excalidraw` file format.
- [`pomdaw.excalidraw-editor` source](https://github.com/pomdaw-com/excalidraw-vscode) — VS Code custom-editor reference for read/write/dirty wiring.
- `src/vault-view.ts`, `docs/59-obsidian-vault-window.md` — internal pattern reference.
- `src/types.ts:113-124` — `ContentView` interface contract.
- `src/input-router.ts:540-558` — content view key delegation flow.
