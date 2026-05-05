# Quick File Search Dialog — Implementation Spec

> Status: Implemented
> Date: 2026-04-25
> Milestone: Tooling / productivity

## Implementation Notes (post-spec)

A few `fff-search` API details differed from the spec assumptions; resolved during implementation:

- `FilePickerOptions` does **not** expose `respect_gitignore` / `include_hidden` / `include_binaries` / `follow_symlinks` flags. The crate uses `ignore` internally with sensible defaults; we accept those defaults rather than post-filtering.
- `SearchResult` carries no per-character match indices. Highlighting is computed in the frontend (`quick-file-search.ts`'s `highlight()`), mirroring the same case-insensitive subsequence walk used by `command-palette.ts`. Hits without matched indices in the score struct mean we trust fff-search's score order verbatim.
- `SharedFrecency` is initialized via `init(FrecencyTracker::new(path, false))` rather than the spec's hypothetical `open()`. A second LMDB at `…/krypton/queries/` backs `SharedQueryTracker` for combo-boost scoring across calls.
- Frecency-only sort for empty queries falls out for free: `fuzzy_search("")` ranks by `Score.total`, which already includes `frecency_boost`, so MRU files surface naturally.
- Backend module lives at `src-tauri/src/quick_search.rs` (cleaner than stuffing into `commands.rs`).
- The `record_pick` command takes only `absolute` (no `root`/`query`) — frecency keys on absolute path; the optional `query_tracker` combo-boost is handled inside `fuzzy_search` and doesn't need an explicit record-on-pick call.

## Problem

There is no global, fast way to jump to a file from anywhere in Krypton. The
file manager's `Ctrl+F` mode (doc 57) requires opening the file manager first,
scopes to that window's initial root, rebuilds the file list on every
activation, and has no notion of frecency or query history. Users working in
any window — terminal, agent, hurl-view — want a one-shot "find a file in this
project" overlay (à la VS Code `Cmd+P`, fzf, Telescope) that appears instantly,
ranks by frecency, and **puts the chosen path on the system clipboard** so they
can paste it wherever they want without surprises.

## Solution

Add a global modal **Quick File Search** overlay triggered by `Cmd+O`. The Rust
backend integrates [`fff-search`](https://docs.rs/fff-search), which provides
long-lived `SharedPicker`s with background indexing, filesystem watching,
LMDB-backed frecency, and a query parser. Pickers are cached in an LRU keyed by
the resolved project root (walk-up from CWD to nearest `.git/`, capped at
`$HOME`, fallback to literal CWD). The frontend renders a centered overlay; on
`Enter` the highlighted file opens in **Helix** in a new tab. `Ctrl+E` copies
the **relative** path to the clipboard and `Cmd+Enter` copies the **absolute**
path. Clipboard picks are never auto-pasted — no PTY paste, no command
execution — so behavior is identical regardless of which window is focused. Each pick records frecency, so an empty query in a
known root immediately surfaces the user's most-used files.

## Research

- **`fff-search` API** (docs.rs): the consumer flow is `SharedPicker::default()`
  → `FilePicker::new_with_shared_state(shared, frecency, FilePickerOptions { base_path, .. })`
  (spawns a background scanner + fs watcher) → optional `shared.wait_for_scan(timeout)`
  → `picker.fuzzy_search(&QueryParser::default().parse(q), None, FuzzySearchOptions { pagination, .. })`.
  `SharedFrecency` is LMDB-backed and persists; `SharedQueryTracker` records
  recent queries for combo-boost scoring. The picker keeps the index live, so
  rebuilds on activation are unnecessary.
- **Existing `search_files` command** (`src-tauri/src/commands.rs:825`,
  consumed by file-manager `Ctrl+F`): synchronous `ignore`-crate walk. Kept
  unchanged — it serves a different surface.
- **CWD discovery**: frontend asks the compositor for the focused working
  directory. Terminal panes resolve through `get_pty_cwd(session_id)`;
  content views resolve through `ContentView.getWorkingDirectory()`, so
  surfaces like the ACP harness search the project they were opened for.
- **Dialog patterns in repo**: `command-palette.ts` (Cmd+Shift+P) and
  `prompt-dialog.ts` are the established overlay patterns; both wire into
  `InputRouter` via `setX()` + a dedicated `Mode.X`. We follow the same shape:
  `Mode.QuickFileSearch`, `isQuickFileSearchKey`, `setQuickFileSearch`,
  `enterQuickFileSearch`, `exitQuickFileSearch`.
- **Why a new dialog (not extending file-manager `Ctrl+F` or the palette)**:
  the palette is a finite action registry; file-manager `Ctrl+F` is one-shot
  per-session per-window using `ignore`. `fff-search` brings persistent
  frecency + a live-watched index, which only pays off as a long-lived global
  service.
- **Cmd+T conflict (corrected from earlier draft)**: `input-router.ts:411`
  binds `Cmd+T` to `compositor.createTab()`. We use **`Cmd+O`** instead —
  free, and matches the universal "open file" convention.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | `Cmd+P` overlay; recent files surfaced when query is empty; Enter opens in editor. | Closest UX analogue. We diverge on action: clipboard, not editor open. |
| Sublime Text | `Cmd+P` "Goto Anything"; supports `@`/`#`/`:` modifiers. | — |
| Neovim Telescope `find_files` | `<leader>ff` floating window; `nucleo` matcher; frecency via plugin. | — |
| Helix | `<space>f`; `nucleo` matcher. | — |
| `fzf` (CLI) | `Ctrl+T` shell widget inserts path into the active prompt. | Inspired the original "paste" idea; we deliberately moved to clipboard for safety. |
| Warp | `Cmd+P` palette mixing files + actions. | We keep these separate. |

**Krypton delta** — `Cmd+O` matches the "open file" convention instead of the
`Cmd+P` convention because Cmd+P is already the compositor leader. The
**primary action is clipboard copy, never an automatic paste or execute** —
there is no risk of an accidental newline triggering a command in a terminal,
and behavior is uniform across all window types (terminal, agent, hurl,
markdown, vault). Like VS Code, an empty query surfaces frecency-ranked recent
files; unlike VS Code, frecency persists across app restarts via LMDB and is
keyed by absolute path so it follows the user across project roots.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `fff-search` and `dirs` (if not already present) |
| `src-tauri/src/lib.rs` | Construct `QuickSearchState`, `.manage(...)` it, register 3 commands |
| `src-tauri/src/commands.rs` | Add `QuickSearchState`, `resolve_search_root`, `quick_search_warm_root`, `quick_search_query`, `quick_search_record_pick` |
| `src/quick-file-search.ts` | **New** — overlay (DOM, input, results, key handling, clipboard) |
| `src/input-router.ts` | Add `Mode.QuickFileSearch`, `isQuickFileSearchKey` (Cmd+O), wire-up methods, mode routing |
| `src/main.ts` | Construct `QuickFileSearch`, wire to input router |
| `src/styles/quick-file-search.css` | **New** — overlay styles (mirror command-palette aesthetics + flash animation) |
| `src/styles/main.css` | `@import` the new stylesheet |
| `src/types.ts` | Add `QuickSearchHit` interface |
| `docs/PROGRESS.md` | Mark feature implemented when done |

## Design

### Search root resolution

```rust
fn resolve_search_root(cwd: PathBuf) -> PathBuf {
    let cwd = cwd.canonicalize().unwrap_or(cwd);
    let home = dirs::home_dir();
    let mut cur = cwd.as_path();
    loop {
        if cur.join(".git").exists() { return cur.to_path_buf(); }
        if Some(cur) == home.as_deref() { break; }   // never escape $HOME
        match cur.parent() {
            Some(p) if p != cur => cur = p,
            _ => break,
        }
    }
    cwd  // no .git found → literal CWD
}
```

Frontend resolves CWD through the compositor (fallback `$HOME`), then sends raw
CWD to the backend, which canonicalizes and walks up.

### Picker cache (LRU, cap = 8)

```rust
pub struct QuickSearchState {
    // VecDeque<PathBuf> tracks LRU order; HashMap holds the pickers
    pickers: Mutex<(VecDeque<PathBuf>, HashMap<PathBuf, SharedPicker>)>,
    frecency: SharedFrecency,
    queries:  SharedQueryTracker,
    parser:   QueryParser,
}
const PICKER_CAP: usize = 8;
```

`picker_for(root)` looks up; on hit, moves root to head; on miss, constructs
`FilePicker::new_with_shared_state` with the shared frecency + queries, evicts
tail if `len > PICKER_CAP` (drops scanner thread + fs watcher of the evicted
root). **Frecency is shared across all pickers** — eviction never loses ranking
history because LMDB is keyed by absolute path.

### `FilePickerOptions`

```
respect_gitignore: true
include_hidden:    true     (.env, .github/, etc. ARE searchable)
include_binaries:  true     (filename match only; never opens contents)
follow_symlinks:   false
skip_git_dir:      true     (default)
result_cap:        none     (limit applied per query, not at scan time)
```

Field names verified during implementation against the actual `fff-search`
API; if a flag isn't exposed, replicate via post-scan filter.

### Frecency DB

```rust
let dir = dirs::data_local_dir()
    .ok_or("no data_local_dir")?
    .join("krypton/frecency");
fs::create_dir_all(&dir)?;
let frecency = SharedFrecency::open(&dir)?;
```

Single global DB. macOS: `~/Library/Application Support/krypton/frecency/`,
Linux: `~/.local/share/krypton/frecency/`.

### Tauri Commands

```rust
#[tauri::command]
pub async fn quick_search_warm_root(
    cwd: String,
    state: tauri::State<'_, QuickSearchState>,
) -> Result<String, String>;
// Resolves root, ensures picker exists, returns the resolved root
// for the frontend to display in the dialog header.

#[tauri::command]
pub async fn quick_search_query(
    root: String,
    query: String,
    limit: usize,
    state: tauri::State<'_, QuickSearchState>,
) -> Result<QuickSearchResponse, String>;

#[derive(serde::Serialize)]
pub struct QuickSearchResponse {
    pub hits: Vec<QuickSearchHit>,
    pub indexing: bool,        // true while initial scan is in progress
    pub indexed_count: usize,  // for "indexing… (N files)" status
}

#[derive(serde::Serialize)]
pub struct QuickSearchHit {
    pub path: String,            // relative to root
    pub absolute: String,
    pub score: f32,
    pub match_indices: Vec<usize>,
}

#[tauri::command]
pub fn quick_search_record_pick(
    root: String,
    absolute: String,
    query: String,
    state: tauri::State<'_, QuickSearchState>,
) -> Result<(), String>;
```

**Empty query** → backend returns frecency-ranked top-N. If `fff-search`
exposes a frecency-only sort, use it; else `fuzzy_search("")` and re-sort by
`frecency.score(absolute)`.

### Frontend module (`src/quick-file-search.ts`)

```typescript
export class QuickFileSearch {
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private resultsList: HTMLElement;
  private statusBar: HTMLElement;
  private hintBar: HTMLElement;
  private results: QuickSearchHit[] = [];
  private selectedIndex = 0;
  private visible = false;
  private currentRoot: string | null = null;
  private queryToken = 0;       // discards stale async responses
  private debounceTimer = 0;

  open(cwd: string): Promise<void>;   // calls warm_root, opens overlay
  close(): void;
  isVisible(): boolean;
  handleKey(e: KeyboardEvent): boolean;
}
```

Query is debounced 16 ms; each query bumps `queryToken` and the response
handler discards mismatched tokens.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+O` | All modes except CommandPalette / PromptDialog / QuickFileSearch | Open dialog |
| typing | QuickFileSearch | Update query |
| `↑` / `Ctrl+P` | QuickFileSearch | Cursor up |
| `↓` / `Ctrl+N` | QuickFileSearch | Cursor down |
| `Enter` | QuickFileSearch | Open file in Helix in a new tab (see "Open in editor" below) |
| `Ctrl+E` | QuickFileSearch | Copy **relative** path → flash row + sound → close, return to Normal |
| `Cmd+Enter` | QuickFileSearch | Copy **absolute** path → flash row + sound → close, return to Normal |
| `Esc` | QuickFileSearch | Close, return to Normal (no record) |
| `Ctrl+U` | QuickFileSearch | Clear query |

Opening from a transient mode (Resize/Move/Swap/Selection/Hint/TabMove)
cancels that mode immediately. Closing always returns to Normal — no mode
restoration.

### UI

```
.krypton-quicksearch                          (full-screen scrim)
  .krypton-quicksearch__container             (centered card)
    .krypton-quicksearch__input-row
      .krypton-quicksearch__prompt            ("⟶")
      input.krypton-quicksearch__input
      .krypton-quicksearch__root              (right-aligned, dim, shows resolved root)
    ul.krypton-quicksearch__results
      li.krypton-quicksearch__result[.is-selected][.is-flashing]
        .krypton-quicksearch__filename        (filename, match chars highlighted)
        .krypton-quicksearch__parent          (right-aligned, dim)
    .krypton-quicksearch__statusbar           ("50 matches" | "indexing… (1,234 files)" | "no matches")
    .krypton-quicksearch__hint                ("↵ copy · ⌘↵ copy absolute · ⎋ close")
```

**Visual feedback on copy** — selected row gets `.is-flashing` (CSS
`@keyframes` 80 ms colored pulse), the corresponding hint segment also
pulses (so user knows whether relative or absolute was copied), sound engine
plays the existing `select`/`confirm` event, then `close()` runs.

Highlight: render filename and parent dir as character spans, wrapping
matched indices in `<span class="match">…</span>`. Reuse existing
`--krypton-*` theme variables (border, accent, dim foreground).

Result list = top 50 hits, plain DOM (no virtualization).

### Query syntax

Pass user input straight into `QueryParser::default().parse(query)` — power
users get advanced syntax (negation, path filters, etc. as supported by the
crate) for free; plain text behaves as fuzzy match. No help overlay in v1
(follow-up if requested).

## Edge Cases

- **No focused window / no resolvable CWD** → `$HOME`. Header shows resolved
  root so user can confirm.
- **Root has no `.git`** → literal CWD (e.g. `/tmp/scratch`).
- **Walk-up tries to escape `$HOME`** → stops; uses CWD.
- **Symlinked CWD** (e.g. `/var` vs `/private/var` on macOS) → canonicalized
  before walk-up so cache key is stable.
- **Root scan still in progress** → response carries `indexing: true`; status
  bar shows `"indexing… (N files)"`; results stream as scan progresses.
- **Stale async results** → frontend `queryToken` discards mismatches.
- **Picker evicted by LRU then root revisited** → new picker constructed; LMDB
  frecency for those paths is intact, so ranking returns instantly.
- **Clipboard write fails** (rare; permission revoked) → notification toast
  via existing `notification.ts`, dialog stays open.
- **Empty query in brand-new root** → empty list + placeholder
  `"Type to search this project (no history yet)"`.
- **Window closes while dialog open** → compositor close-callback closes
  dialog, restores Normal mode.

## Open Questions

None — all design decisions resolved during the grilling pass:

- Trigger → `Cmd+O`
- Root → walk-up to `.git`, fallback CWD, capped at `$HOME`, canonicalized
- Picker cache → LRU 8, frecency global
- Empty query → top frecency
- Mode availability → all non-overlay modes; close → Normal
- Primary action → open in Helix on Enter; clipboard copy on Ctrl+E (relative)
  / Cmd+Enter (absolute), never paste/execute
- Filters → respect gitignore, show hidden, show binaries, no symlinks
- Feedback → row flash 80 ms + sound + hint pulse, then close
- Display → two-column (filename + dim parent), highlight all matched chars,
  50 results no virtualization, "indexing…" in statusbar
- Query syntax → pass-through to `QueryParser`
- Frecency DB → `dirs::data_local_dir() / "krypton/frecency/"`, single global

## Grep mode (added post-spec)

The same overlay now toggles between **file mode** (default, fuzzy filename
match — `Cmd+O`) and **grep mode** (`Tab` inside the dialog, content search
via `picker.grep()` with `GrepConfig`-parsed query). Sharing the picker means
no extra scan/cache cost for grep — the on-disk index is reused.

- **Hit format**: `path:line | snippet` with the matched substring spans
  highlighted via `match_byte_offsets` from `GrepResult` (no JS heuristic
  required — fff-search reports byte ranges directly).
- **Ctrl+E** copies `path:line:col`, **Cmd+Enter** copies `absolute:line:col`
  (so `vim`/`hx` can jump straight from clipboard).
- **Empty query in grep mode**: shows nothing (grep without a pattern is
  meaningless); status reads "grep — type a query".
- **Regex fallback**: if a regex query fails to compile, fff-search falls back
  to literal matching and reports the error in `regex_fallback_error`. The
  status bar surfaces the error so the user sees their pattern was treated
  as plaintext.
- **Frecency**: grep picks call `quick_search_record_pick` with the absolute
  path, so heavily-greppped files also get bumped in file-mode rankings.

## Open in editor (added post-spec)

`Enter` inside the dialog opens the highlighted hit in **Helix** in a new
terminal tab on the focused window. The original "clipboard is the sole sink"
constraint stays in place for `Ctrl+E` / `Cmd+Enter` — opening in Helix is the
only PTY-side action; no path is auto-pasted or auto-executed in any other
window.

Behavior:

- Calls the shared Helix opener, which creates a terminal tab whose PTY
  process is `hx`, inheriting cwd from the focused pane or content view.
- Path is passed as an argv entry, not typed into a shell. This avoids shell
  quoting concerns and means Helix exit is also PTY exit.
- In **grep mode** the hit's `:line:col` is appended to the file argument so
  Helix jumps to the matching position (`hx /path/file.ts:123:5`).
- When Helix exits, Krypton's normal `pty-exit` cleanup closes the editor tab
  automatically instead of leaving a shell behind. `pty-exit` is driven by a
  direct backend child-process wait, not only PTY EOF, so Quick File Search
  editor tabs close reliably when `hx` exits.
- `quick_search_record_pick` is fired (frecency boost), the row flashes and
  the same `select`/`execute` sound plays as the clipboard actions, then
  the dialog closes and returns to Normal.
- The editor command is currently hardcoded to `hx`. Making it configurable
  in `krypton.toml` is a follow-up if other editors are requested.

## Out of Scope

- Symbol mode (`@symbol` modifier — fff-search doesn't expose ctags-style
  symbols).
- Symbol / `@symbol` / `:line` modifiers
- Multi-root or workspace-wide search
- Pre-indexing on app startup (cold start handled by background scan + status
  bar feedback)
- Replacing or modifying file-manager `Ctrl+F` (doc 57 stays as-is)
- Auto-paste in arbitrary windows / shell injection across PTYs — opening in
  Helix spawns `hx` directly as the new tab's PTY process. Clipboard remains
  the sink for `Ctrl+E` / `Cmd+Enter`.

## Resources

- [fff-search docs.rs](https://docs.rs/fff-search/latest/fff_search/) — `SharedPicker`, `FilePicker::new_with_shared_state`, `SharedFrecency`, `QueryParser`, `FuzzySearchOptions`
- `src/command-palette.ts` (in-repo) — overlay + input-router pattern
- `src/prompt-dialog.ts` (in-repo) — modal lifecycle
- `src-tauri/src/commands.rs:825` `search_files` (in-repo) — pre-existing file-manager fuzzy command, kept as-is
- `docs/57-fuzzy-file-search.md` (in-repo) — sibling feature this complements
- `dirs` crate — cross-platform `data_local_dir()`
- VS Code `Cmd+P` — empty-query frecency convention
- `fzf` `Ctrl+T` — original inspiration for paste-into-shell, ultimately rejected in favor of clipboard
