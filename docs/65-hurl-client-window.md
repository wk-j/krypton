# Hurl Client Window — Implementation Spec

> Status: Implemented
> Date: 2026-04-19
> Milestone: N/A — New feature

## Decision Log (from design review)

| # | Decision |
|---|----------|
| Q1 | cwd from focused terminal via `getFocusedCwd() ?? '/'` (matches `openFileManager`) |
| Q2 | No filesystem watcher; manual refresh only via `.` key |
| Q3 | Respect `.gitignore` by default (consistent with `list_directory`) |
| Q4 | Always invoke hurl with `--color` |
| Q5 | Persist cached output as raw ANSI; convert to HTML on load |
| Q6 | `e` spawns a new Krypton terminal running `$EDITOR ?? vi <file>`; refresh sidebar on close |
| Q7 | Resolve `hurl` binary via login-shell `which hurl`, cache in `OnceLock`; `[hurl] binary_path` override |
| Q8 | Pressing Enter during a run auto-cancels active run and restarts; `x` still explicit-cancels |
| Q9 | Source pane uses a minimal hand-rolled highlighter (HTTP methods, status codes, JSON, `{{vars}}`) |
| Q10 | Canonicalize paths with `fs::canonicalize()` before hashing for cache key; use canonical paths throughout |
| Q11 | No virtualization; render every visible tree row as DOM; `scrollIntoView({block:'nearest'})` on j/k |
| Q13a | Scan `*.env` files (NOT dotfiles like `.env` / `.env.local`) |
| Q13b | Status-bar badge `env: dev.env ▾`; `E` opens modal picker listing discovered env files + "(none)" |
| Q13c | Pass env file to hurl via `--variables-file` only — no `--variable` flags, no parsing |
| Q12 / Q13d | Dropped. No `[hurl] variables`, no `[hurl] secrets`, no `{{env.*}}` expansion. `--variables-file` is the sole variable source |
| Q13e | Active env file persists per cwd in sidebar-state |

## Problem

Krypton has no first-class way to author and run HTTP requests. Users who keep `.hurl` files in their projects currently have to `cd` into the directory and invoke `hurl` manually, losing the keyboard-driven, modal, multi-file workflow that the rest of Krypton provides. We need a dedicated, keyboard-first window that indexes every `.hurl` file under the working directory, lets the user pick one, runs it via the bundled `hurl` CLI, and streams the response into a panel.

## Solution

Add a new `HurlContentView` implementing the existing `ContentView` interface. It follows the two-pane layout pioneered by the Vault and File Manager views: a left sidebar rendering every `.hurl` file under the cwd as a **collapsible folder tree** (recursive, gitignore-aware), with `/`-filter and `j/k` navigation, and a right pane that shows either the source of the selected file or the output of the last run. Execution is done by spawning `hurl` as a short-lived child process on the Rust side (not a PTY) and streaming stdout/stderr to the frontend via a dedicated event channel. On every successful run the captured output is persisted to an on-disk cache keyed by the `.hurl` file path so that re-selecting that file — even after a Krypton restart — immediately re-renders the last response without re-running. All interaction is keyboard-driven — `Enter`/`r` runs the current file, `o` toggles source/response view, `v` toggles verbose, `e` edits the file in `$EDITOR`.

## Research

- Krypton already has the building blocks: `list_directory` (gitignore-aware) in `commands.rs:667`, the generic `ContentView` interface (used by `VaultContentView`, `FileManagerContentView`, `DiffContentView`), and `compositor.createContentWindow()` for opening non-terminal windows.
- `hurl` 7.1.0 is installed at `/opt/homebrew/bin/hurl`. Relevant flags: `--json`, `--verbose`, `--very-verbose`, `--color`, `--variable NAME=VAL`, `--variables-file FILE`, `--no-output`, `--include`. Exit code is 0 on success, non-zero on assertion/connection failure. Hurl writes HTTP body to stdout and the transcript (`* `, `> `, `< ` lines, like curl) to stderr when `--verbose` is on.
- We need a **new IPC pattern**: unlike PTYs (long-lived, bidirectional), a hurl run is a short-lived process with line-oriented stdout/stderr and an exit code. The existing `spawn_pty` command is the wrong shape. We add `hurl_run` / `hurl-output` / `hurl-finished` mirroring the diff/sound command pattern (command kicks off work, events stream results).
- Gitignore handling is already solved by the `ignore` crate used in `list_directory`. We reuse it — walking the tree with a `.hurl` extension filter — via a new `list_hurl_files` command rather than client-side recursion, to keep symlink/permission handling uniform.
- No frontend HTTP response pretty-printer needed for MVP: hurl's `--color --pretty` output already formats JSON and colorizes HTTP lines. We render it in a `<pre>` with ANSI-to-HTML conversion. Krypton does not currently ship an ANSI-to-HTML helper, but xterm.js is overkill for a static transcript — we write a ~60-line minimal SGR-to-span converter (8/16/256/truecolor + bold/dim). This keeps the Hurl view self-contained.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code REST Client (Huachao Mao) | `.http`/`.rest` files. "Send Request" codelens above each request block. Response opens in a side-by-side editor tab. | Mouse-centric but the file-as-spec pattern is identical. |
| IntelliJ HTTP Client | `.http` files; `Alt+Enter` on a request runs it. Response shown in a tool window with response history. | Keyboard-friendly; environment/variable file picker is a dropdown. |
| Insomnia / Bruno / Postman | Request collections in a sidebar, "Send" button/hotkey, response pane below. Bruno stores requests as plain text files; Insomnia/Postman use proprietary stores. | Bruno is closest philosophically — requests-as-files, git-friendly. |
| `curlie` / `xh` CLI | No UI — just nicer curl wrappers. | Not comparable but worth noting that the terminal ecosystem typically has no TUI HTTP client. |
| `posting` (TUI) | Textual-based TUI, collection tree left, request editor middle, response right. Keyboard-first. | Closest analogue to what we're building, but standalone app. |

**Krypton delta** — We deliberately do not build a request editor or a custom data model. `.hurl` files are the source of truth, edited in the user's `$EDITOR`; Krypton is a runner/browser. The sidebar renders a collapsible folder tree (matching Bruno / posting / IntelliJ) so project structure is preserved; a `/` filter flattens the tree to fuzzy-matched leaves while active. Output is raw hurl stdout/stderr, colorized, not a re-parsed request/response inspector. This keeps the feature ~500 LOC of frontend plus a thin Rust runner.

## Affected Files

| File | Change |
|------|--------|
| `src/hurl-view.ts` | **New** — `HurlContentView` class, sidebar list, output pane, key routing |
| `src/hurl-ansi.ts` | **New** — minimal SGR-to-HTML converter for hurl output |
| `src/styles/hurl-view.css` | **New** — cyberpunk-styled two-pane layout, scoped `.krypton-hurl` |
| `src/styles/index.css` | Import `hurl-view.css` |
| `src/compositor.ts` | Add `openHurlClient(cwd?)` method; register a default keybind |
| `src/input-router.ts` | Route compositor key (`H`) to `openHurlClient` |
| `src/command-palette.ts` | Add "Open Hurl Client" action |
| `src/types.ts` | Add `'hurl'` to `PaneContentType` union |
| `src-tauri/src/commands.rs` | New commands `list_hurl_files`, `hurl_run`, `hurl_cancel`; emit `hurl-output` / `hurl-finished` events |
| `src-tauri/src/lib.rs` | Register new commands in `invoke_handler!` |
| `src-tauri/Cargo.toml` | No new deps — reuse `ignore`, `tokio`, `serde` already present |
| `docs/PROGRESS.md` | Append milestone row |
| `docs/06-configuration.md` | Document `[hurl]` config section |

## Design

### Data Structures

```typescript
// types.ts
export type PaneContentType =
  | 'terminal' | 'diff' | 'markdown' | 'agent'
  | 'context' | 'file_manager' | 'vault' | 'hurl';

// hurl-view.ts
interface HurlFileEntry {
  path: string;          // absolute
  relPath: string;       // relative to cwd
  name: string;          // basename (file only)
}

/** Tree node rendered in the sidebar. Folders are synthesized from relPath segments. */
interface HurlTreeNode {
  kind: 'dir' | 'file';
  name: string;                    // segment name
  relPath: string;                 // full rel path of dir or file
  absPath?: string;                // files only
  children?: HurlTreeNode[];       // dirs only, sorted: dirs first, then files (alpha)
  depth: number;                   // indentation level (root children = 0)
  expanded?: boolean;              // dirs only; persisted in-view by relPath
}

/** Flattened visible rows for O(1) j/k navigation; rebuilt on expand/collapse/filter. */
interface HurlVisibleRow {
  node: HurlTreeNode;
  indent: number;
}

interface HurlRun {
  id: number;            // monotonic, returned from hurl_run command
  filePath: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  stdout: string;        // accumulated
  stderr: string;        // accumulated (verbose transcript)
  status: 'running' | 'ok' | 'failed' | 'cancelled';
}

/** Persisted cache entry — one per .hurl file path. */
interface HurlCachedRun {
  version: 1;
  filePath: string;      // absolute
  fileMtimeMs: number;   // for staleness detection
  startedAt: number;
  finishedAt: number;
  exitCode: number;
  durationMs: number;
  stdout: string;        // capped (see Edge Cases)
  stderr: string;        // capped
  verbose: boolean;
  veryVerbose: boolean;
  hurlVersion: string;   // from `hurl --version`, for diagnostics
}

class HurlContentView implements ContentView {
  readonly type: PaneContentType = 'hurl';
  readonly element: HTMLElement;

  private cwd: string;
  private files: HurlFileEntry[];       // flat, from list_hurl_files
  private tree: HurlTreeNode;           // synthesized root
  private expanded: Set<string>;        // relPaths of open folders (persisted per cwd, see Sidebar State)
  private visible: HurlVisibleRow[];    // flattened view; drives rendering + j/k
  private filterText: string;           // when non-empty, tree collapses to flat matches
  private selectedIndex: number;        // into `visible`
  private activeRun: HurlRun | null;
  private history: HurlRun[];          // last 20
  private viewMode: 'source' | 'response';
  private verbose: boolean;
  private variables: Record<string,string>;   // from config + session overrides

  constructor(cwd: string);
  onKeyDown(e: KeyboardEvent): boolean;
  onResize(w: number, h: number): void;
  dispose(): void;                      // abort active run, detach listeners
  getWorkingDirectory(): string;
}
```

```rust
// commands.rs
#[derive(Serialize)]
pub struct HurlFile { path: String, rel_path: String, name: String }

#[tauri::command]
pub fn list_hurl_files(cwd: String) -> Result<Vec<HurlFile>, String>;

#[derive(Deserialize)]
pub struct HurlRunArgs {
    file: String,
    cwd: String,
    verbose: bool,
    very_verbose: bool,
    variables: Vec<(String, String)>,
    variables_file: Option<String>,
    extra_args: Vec<String>,     // future-proof: insecure, http2, etc.
}

#[tauri::command]
pub async fn hurl_run(app: AppHandle, args: HurlRunArgs) -> Result<u64, String>;
// returns run_id; emits events keyed by run_id

#[tauri::command]
pub fn hurl_cancel(run_id: u64) -> Result<(), String>;

/// Returns the cached run for a .hurl file, or None. Reads
/// `<cache_dir>/hurl/<sha256(absPath)>.json`. Validates file mtime against
/// the cache entry; stale entries are returned with a `stale: true` flag
/// (frontend shows a "cache may be out of date" banner but still renders).
#[tauri::command]
pub fn hurl_load_cached(file_path: String) -> Result<Option<HurlCachedRun>, String>;

/// Clear a single entry or all entries under the hurl cache dir.
#[tauri::command]
pub fn hurl_clear_cache(file_path: Option<String>) -> Result<(), String>;
```

### Sidebar State Persistence

The tree's expand/collapse state and last-selected file are persisted so that closing the Hurl window — or quitting Krypton entirely — and reopening it for the same cwd restores the exact navigation view.

- **Scope**: keyed by absolute `cwd`. Two different cwds get independent state.
- **Shape**:
  ```typescript
  interface HurlSidebarState {
    version: 1;
    cwd: string;
    expanded: string[];        // relPaths of open folders
    selectedRelPath: string | null;
    viewMode: 'source' | 'response';
    verbose: boolean;
    veryVerbose: boolean;
    updatedAt: number;
  }
  ```
- **Location**: `<app_cache_dir>/hurl/state/<sha256(cwd)>.json`. Same parent directory as the output cache — co-located, same atomic write pattern. Chosen over `localStorage` so that (a) state survives webview profile resets and (b) it can be cleared with `hurl_clear_cache`.
- **Tauri commands**:
  ```rust
  #[tauri::command]
  pub fn hurl_load_sidebar_state(cwd: String) -> Result<Option<HurlSidebarState>, String>;

  #[tauri::command]
  pub fn hurl_save_sidebar_state(state: HurlSidebarState) -> Result<(), String>;
  ```
- **Save triggers** (debounced 300ms, last-write-wins):
  - folder expand/collapse (`h`, `l`, `Enter` on dir, `za`, `zR`, `zM`)
  - selection change (`j`, `k`, or programmatic via filter)
  - `viewMode`, `verbose`, `veryVerbose` toggles
  - view `dispose()` flushes any pending debounce synchronously
- **Load flow**:
  1. Constructor receives cwd, fires `hurl_load_sidebar_state(cwd)` in parallel with `list_hurl_files`.
  2. Once both resolve, apply `expanded` to the synthesized tree, then set `selectedIndex` to the row matching `selectedRelPath`.
  3. If the persisted selected file no longer exists (deleted, renamed), fall back to the first file in the tree and log once.
  4. If no state file exists, default to: root-level dirs collapsed, first file selected, source view, verbose off.
- **Filter interaction**: `filterText` is intentionally **not** persisted — filters are transient. The persisted `selectedRelPath` is the last file selected outside a filter; entering a filter does not overwrite it until the user commits (presses Enter on a match).
- **Cache clear**: `hurl_clear_cache(None)` also wipes the `state/` subdir; `hurl_clear_cache(Some(path))` only clears the output cache for that file, not sidebar state.

### Output Cache

- **Location**: `<app_cache_dir>/hurl/` — resolved via Tauri's `app.path().app_cache_dir()`. On macOS this is `~/Library/Caches/com.krypton.terminal/hurl/`. We choose the app cache dir (not config or data dir) because these artefacts are regenerable.
- **Filename**: `sha256(absolute_file_path).json` — flat layout avoids nested mkdir and path-length pitfalls. The `filePath` inside the JSON is the authoritative display value.
- **Format**: JSON matching `HurlCachedRun`. One file per `.hurl` source — latest run only; previous entries for the same source are overwritten. (In-memory `history[]` inside the view still holds the last 20 for the session.)
- **Write path**: on `hurl-finished` with a non-cancelled status, the Rust side writes the cache atomically (`tmp + rename`) before emitting the event so the frontend can rely on it. Writes are fire-and-forget from the frontend's perspective; failures log a warning but do not surface.
- **Read path**: when the sidebar selection changes to a file, the view calls `hurl_load_cached(filePath)`. If a cache entry exists and `activeRun` is null, it becomes the initial contents of the response pane with a small "cached · HH:MM:SS" badge in the status bar. Running the file replaces the cached view with the live stream.
- **Staleness**: the cache records the source file's `mtime`. On load, the view compares against the current file mtime; if it differs, the badge reads "cached · stale (file modified)".
- **Size cap**: `stdout + stderr` are capped at 1 MB combined per entry (stderr truncated first — hurl's `--very-verbose` can be large). A truncation marker is appended so the user knows output was trimmed.
- **Eviction**: no automatic eviction; `hurl_clear_cache(None)` clears everything, `hurl_clear_cache(Some(path))` clears one. Exposed via command palette "Hurl: Clear Cache".

### IPC Events

| Event | Payload | Emitted when |
|-------|---------|--------------|
| `hurl-output` | `{ run_id: u64, stream: "stdout"\|"stderr", chunk: String }` | Each line batch from the child |
| `hurl-finished` | `{ run_id: u64, exit_code: i32, duration_ms: u64 }` | Child exits or is cancelled |

Chunks are flushed line-by-line with a 16ms coalescing window to keep event volume bounded on verbose runs.

### Data Flow

```
1. User presses Cmd+P then q                     (input-router)
2. Compositor.openHurlClient(cwd) creates a content window with HurlContentView
3. HurlContentView invokes list_hurl_files(cwd) -> renders sidebar
4. User navigates j/k, presses Enter (or r)
5. View invokes hurl_run({ file, cwd, verbose, variables }) -> returns run_id
6. Rust spawns `hurl` with tokio::process::Command, captures stdout+stderr
7. Two tokio tasks read lines, emit `hurl-output` events tagged with run_id
8. On exit, Rust writes HurlCachedRun to `<cache_dir>/hurl/<sha>.json` atomically, then emits `hurl-finished` with exit_code
9. Frontend appends chunks to activeRun.stdout/stderr, re-renders output pane
10. Exit code colors the status bar (green ok / red failed), plays success/error sound
11. On next selection change to the same file (this session or a future one), the view calls `hurl_load_cached(filePath)` and renders the cached output immediately if no live run is in progress
```

### Keybindings

Global (while Hurl view is focused pane):

| Key | Context | Action |
|-----|---------|--------|
| `q` | Compositor mode | Open Hurl Client for current cwd (request) |
| `j` / `k` | Sidebar | Move selection down / up across visible rows |
| `h` | Sidebar (dir) | Collapse folder (or jump to parent if already collapsed) |
| `l` | Sidebar (dir) | Expand folder (or descend into first child if expanded) |
| `Enter` | Sidebar (dir) | Toggle folder expand/collapse |
| `Enter` or `r` | Sidebar (file) | Run selected file |
| `za` | Sidebar | Toggle current folder |
| `zR` / `zM` | Sidebar | Expand all / collapse all |
| `R` | Any | Re-run last |
| `x` | Running | Cancel active run |
| `o` | Any | Toggle source / response view |
| `v` | Any | Toggle `--verbose` |
| `V` | Any | Toggle `--very-verbose` |
| `e` | Any | Open selected file in `$EDITOR` in a new terminal window |
| `/` | Any | Focus filter input |
| `Escape` | Filter active | Clear + blur filter |
| `g` / `G` | Response pane | Scroll top / bottom |
| `J` / `K` | Response pane | Scroll down / up one page |
| `y` | Response pane | Copy full response to clipboard |
| `Tab` | Any | Toggle focus sidebar ↔ response |
| `1` / `2` | Any | Switch sidebar tab FILES / HISTORY |

`Escape` returns to Normal mode per existing contentView convention.

### DOM Structure

```
.krypton-hurl
├── .krypton-hurl__sidebar
│   ├── .krypton-hurl__sidebar-header
│   │   ├── title "HURL · <cwd-basename>"
│   │   └── tabs [FILES] [HISTORY]
│   ├── .krypton-hurl__filter
│   │   └── input.krypton-hurl__filter-input (placeholder: "/ filter")
│   └── .krypton-hurl__tree
│       ├── .krypton-hurl__tree-row--dir  (▸/▾ chevron + folder name, indent = depth * 12px)
│       └── .krypton-hurl__tree-row--file (filename, recent-run dot, indent = depth * 12px)
├── .krypton-hurl__main
│   ├── .krypton-hurl__breadcrumb   ("api/users/list.hurl")
│   ├── .krypton-hurl__toolbar       (flags: [v] [VV], run indicator, duration)
│   ├── .krypton-hurl__viewport      (<pre> for source OR response, scrollable)
│   └── .krypton-hurl__statusbar     (EXIT 0 · 214ms · 2 requests · 1.4KB · ring gauge)
```

Styling follows the existing cyberpunk aesthetic (cyan primary, pink accents for errors, scanline overlay on `viewport`). Reuse `.krypton-window__titlebar` chrome from the compositor wrapper.

### Configuration

```toml
[hurl]
# Default variables passed to every run via --variable
variables = { token = "{{env.API_TOKEN}}", host = "localhost:8080" }

# Optional variables file (hurl --variables-file)
variables_file = "~/.config/krypton/hurl.env"

# Extra CLI args always prepended
extra_args = ["--insecure"]

# Max rows kept in the in-memory history (default 20)
history_limit = 20
```

Env-var expansion follows the existing Krypton TOML convention (`{{env.FOO}}`).

### Rust Runner Details

- `tokio::process::Command::new("hurl")`, args built from `HurlRunArgs`.
- Working directory set to `args.cwd` so relative paths inside `.hurl` files (e.g., `file,./body.json;`) resolve correctly.
- Stdout and stderr captured with `Stdio::piped()`; two `tokio::spawn` tasks read `BufReader::lines()`, batching per 16ms tick.
- `run_id` allocated from an `AtomicU64` kept in a `tauri::State<HurlState>`.
- `hurl_cancel(run_id)` looks up the child in a `Mutex<HashMap<u64, Child>>` and calls `child.start_kill()`.
- On spawn failure (`hurl` not in PATH) return `Err("hurl binary not found — install from https://hurl.dev")`.
- No shell involvement — args passed directly, no injection surface.

## Edge Cases

- **`hurl` not installed**: command returns a typed error; view shows a banner with install URL in place of output.
- **No `.hurl` files found**: sidebar shows empty state "No .hurl files under <cwd>".
- **File deleted while selected**: re-run returns "file not found" error; refresh button (`F5` or `.`) re-lists.
- **Large output (> 5 MB)**: frontend caps in-memory stored stdout at 5 MB; cache entry capped at 1 MB combined (see Output Cache). Banner "output truncated — use `-o` flag".
- **Cached entry for deleted / moved file**: `hurl_load_cached` still returns it (keyed by path); the sidebar simply no longer lists the source, so the cache becomes unreachable until `hurl_clear_cache` runs.
- **Cancelled runs**: not written to the cache (would hide the previous successful response).
- **Corrupt cache file**: JSON parse failure returns `Ok(None)` with a warn log — never fatal.
- **Long-running request**: status bar shows elapsed timer; `x` cancels via `hurl_cancel`.
- **Concurrent runs**: one run at a time per view; pressing Enter while running is a no-op (or cancels + restarts if held with shift? — decided: ignore; user must `x` first).
- **Binary response body**: hurl usually filters; if bytes slip through, ANSI converter falls back to hex-dump of non-printable sequences.
- **Gitignored `.hurl` files**: included by default (developers often gitignore local scratch files); config flag `respect_gitignore = true` can opt into skipping them (default `false`).
- **Window cwd changes**: view stores cwd at creation; does not auto-refresh. User opens a new Hurl window from a different terminal to change cwd.

## Open questions

1. **Should running one file trigger the sound engine** (success/error cues)? → Proposed yes, using existing `sound.ts` `play('success')` / `play('error')` channels. Confirm.
2. **Variables UX**: For MVP, variables come from config only. Adding a `:set var=val` prompt-dialog command is follow-up. Confirm MVP scope.
3. **History persistence**: In-memory only, cleared on window close, or persisted to `~/.local/state/krypton/hurl-history.jsonl`? → Proposed in-memory for MVP.

## Out of Scope

- In-app `.hurl` file editor (use `$EDITOR`).
- Request/response diffing between runs.
- A visual request builder / form UI.
- Captures/asserts inspection pane (hurl `--json` parsing).
- Multi-file runs (hurl accepts globs; MVP runs one file at a time).
- Response body saving to disk (use `hurl -o` manually for now).
- A graph/chart of latency over time.

## Resources

- [hurl.dev documentation](https://hurl.dev/docs/manual.html) — flag semantics for `--variable`, `--verbose`, `--json`, exit codes.
- [Bruno (usebruno/bruno) on GitHub](https://github.com/usebruno/bruno) — "requests as plain text files" prior art; confirmed flat-file/file-tree UX.
- [posting TUI (darrenburns/posting)](https://github.com/darrenburns/posting) — closest TUI analogue; validated keyboard-first two-pane layout.
- [Tauri async command pattern](https://v2.tauri.app/develop/calling-rust/#async-commands) — used for `hurl_run` which must `await` the child without blocking the IPC thread.
- Krypton internal: `src/vault-view.ts`, `src/file-manager.ts`, `src-tauri/src/commands.rs::list_directory` — reused patterns for sidebar, filter, gitignore-aware listing.

## Migration Checklist

### Phase 1: Scaffolding
- [ ] Add `'hurl'` to `PaneContentType`
- [ ] New `hurl-view.ts` with minimal `HurlContentView`, empty element
- [ ] New `hurl-view.css` imported from `index.css`
- [ ] `compositor.openHurlClient(cwd)` spawns empty window
- [ ] Compositor keybind `H` → open
- [ ] **Verify**: window opens/closes, doesn't break terminals

### Phase 2: Sidebar tree
- [ ] Rust `list_hurl_files` command (gitignore-aware via `ignore` crate) — returns flat list with relPaths
- [ ] Frontend: synthesize tree from relPath segments; dirs-first alpha sort
- [ ] Render collapsible tree with chevrons + depth indent
- [ ] `j/k` across flattened visible rows; `h/l/Enter` expand/collapse; `za/zR/zM`
- [ ] `/` filter flattens tree to matched files; Escape restores tree state
- [ ] Persist expanded-folder set + selected file + viewMode/verbose toggles per cwd via `hurl_load_sidebar_state` / `hurl_save_sidebar_state` (300ms debounce, flush on dispose)
- [ ] Fallback when persisted selection no longer exists: pick first file, log once
- [ ] **Verify**: tree reflects project structure, expand state + selected item survive close-and-reopen AND full app restart, filter works

### Phase 3: Runner
- [ ] Rust `hurl_run` / `hurl_cancel` + `hurl-output` / `hurl-finished` events
- [ ] Frontend subscribes, appends chunks, shows exit status
- [ ] ANSI converter (`hurl-ansi.ts`)
- [ ] **Verify**: runs show colored output, exit codes propagate

### Phase 4: Output cache
- [ ] Rust `hurl_load_cached` / `hurl_clear_cache` commands; `<cache_dir>/hurl/<sha256>.json` atomic writes on successful finish
- [ ] Frontend: on selection change, load cached entry, render with "cached · HH:MM:SS" badge (or "stale" if mtime diverged)
- [ ] Command palette "Hurl: Clear Cache" entry
- [ ] **Verify**: select file → see last response; edit file → badge says stale; relaunch app → cache persists

### Phase 5: Polish
- [ ] Source / response toggle (`o`)
- [ ] Verbose toggles (`v` / `V`)
- [ ] History tab, `R` re-run last
- [ ] Config: variables, variables_file, extra_args
- [ ] Sound cues (pending open question 1)
- [ ] Command palette "Open Hurl Client"
- [ ] Docs: `PROGRESS.md`, `06-configuration.md`
- [ ] **Verify**: end-to-end flow against a real API
