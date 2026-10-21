# 317. File Manager Components

> Status: Implemented (D1 approved)
> Date: 2026-10-20
> Scope: frontend only — `src/file-manager.ts` → `src/file-manager/` on the `src/ui/` kernel. No Rust, no Tauri command, no CSS selector, no visual change (one approved-on-review exception, §Parity D1).
> Builds on: [052 — File Manager](./0052-file-manager.md), [301 — Harness UI Components](./0301-harness-ui-components.md) (kernel), [302 — Component Catalog](./0302-harness-component-catalog.md) (directory convention).

## Problem

`src/file-manager.ts` is 1,924 lines. `FileManagerView` mixes nine jobs: DOM construction, key dispatch
across six modes, a ~200-line `handleNormalKey` switch (`:403-612`), a virtualised list, fuzzy search, two
separate preview pipelines, file operations through `invoke`, status-bar text, and AI-overlay delegation.
Adding anything means editing the middle of the class:

- **A new key** means a new `case` in the switch. The `gg` chord, the "reset `lastKey` only for keys with no
  `case` label" rule (`:606-609`), and the `ctrl`-gated `d`/`u` cases that `return false` before that reset
  are all implicit in the switch's fall-through shape.
- **A new preview type** (images, CSV, PDFs) means editing `loadPreviewNow()` (`:964-1035`) *and*
  `loadPreviewForPath()` (`:1782-1821`), which already disagree on binary text, size limits, truncation and
  highlighting — a copy that drifted.
- **A new row decoration** means editing `renderList()` (`:1259-1361`), which wipes `listEl.innerHTML`
  and rebuilds the whole window on every scroll, sort, mark or filter keystroke, while `patchCursor()`
  (`:691-717`) hand-patches two rows for plain cursor moves. The hand patch already disagrees with the
  full render: it rewrites the mark glyph but never adds `krypton-file-manager__item--marked`, so a row
  marked with `Space` keeps `__mark { color: transparent }` (`file-manager.css:491-494`) and the dot is
  invisible until the next full render (§Parity D1).
- **Nothing is unit-tested.** `fuzzyScore`, sort, filter, frontmatter parsing and status text are private
  methods, so there is no test file for any of them.

## Solution

Split the class into a `src/file-manager/` package:

1. **Pure modules** (no DOM, no `invoke`): `sort.ts`, `filter.ts`, `fuzzy.ts`, `skill.ts`, `file-type.ts`,
   `decorations.ts`, `state.ts` (the state shape plus pure helpers and selectors).
2. **Three extension points**: an ordered **preview renderer registry** (`preview/registry.ts`), a
   declarative **normal-mode keymap** (`keymap.ts`), and a **row decorator list** (`decorations.ts`).
   Each new preview type, key, or row decoration is one file or one table entry.
3. **Kernel components** under `components/<name>/{index.ts,<name>.test.ts}`: `Breadcrumb`, `FileList` +
   `FileRow`, `SearchList` + `SearchRow`, `PreviewPane`, `StatusBar`. The lists use `reconcile()` keyed by
   path over the virtual window. This deletes the `innerHTML` wipe and `patchCursor()`.
4. **A thin orchestrator** `view.ts` holds state, timers and components, calls `ops.ts` for every Tauri
   call, and keeps the `ContentView` surface byte-for-byte the same.
5. **Phase 0 characterisation test** pins today's DOM and `invoke` traffic *before* any code moves, and must
   still pass after the refactor (the parity proof).

## Research

- **The kernel already covers the list case.** `reconcile()` (`src/ui/list.ts:52-83`) reuses nodes by key,
  pointer-compares before `insertBefore`, and disposes keys that leave the window. A virtual window is just
  `items = filtered.slice(offset, offset + rows)`. Rows that scroll out are disposed and new ones created;
  rows that stay are `update()`d and only repaint when their deps moved. A plain `j`/`k` repaints exactly
  the two rows whose `isCursor` flipped. That is what `patchCursor()` does by hand, now with no second code
  path.
- **`Component.syncClasses()` makes D1 unrepresentable.** A row derives its whole `className` from props, so
  "the mark glyph changed but the class didn't" cannot happen. Faithfully reproducing that bug would take a
  deliberate hack in `FileRow`. We fix it and flag it instead (§Parity D1).
- **Why not `LayoutHost`.** The shell has three fixed regions (breadcrumb / body{list, preview} / status) and
  nothing moves at runtime. The flex split (`H`/`L`) is inline `style.flex` on the list and preview, not
  placement. `LayoutHost` would add nothing and risks slot wrapper nodes in the DOM. The root is built once
  with `el()`.
- **Why the CSS stays as is** — see §Styles.
- **Test environment.** `vite.config.ts:25-45` gives a DOM (`happy-dom`, not jsdom) only to `src/ui/**` and
  `src/acp/components/**`. Every other `*.test.ts` runs in `node`. `src/file-manager/**` has to move into the
  `dom` project (one config line each side).
- **Import resolution.** `compositor.ts:3798` does `await import('./file-manager')`. With
  `moduleResolution: "bundler"` (tsconfig) and Vite, `./file-manager` resolves to `file-manager.ts` when
  that file exists, otherwise to `file-manager/index.ts`. So: (a) the compositor line needs no change once
  the old file is deleted, and (b) a test inside `src/file-manager/` importing `'../file-manager'` hits the
  **old** class during phase 0 and the **new** one afterwards, with no edit. That is what makes the phase 0
  parity test a real before/after proof.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | Keybindings are a contribution table `{ key, command, when }`. Commands are registered separately. | Adopted as a table of `{ id, keys, when?, run }`. No `when`-clause language: the mode cascade stays in code. |
| yazi | Previewers are an ordered rule list `{ name/mime glob → previewer }`; first match wins. | Adopted. `matches()` is the glob, and `render()` may decline (`null`) so content-sniffing renderers (skill) can chain. |
| ranger | `scope.sh` is a fixed if-chain of file kinds. | What we have today; rejected for the reason in §Problem. |
| Krypton spec 301 | `Component` + `reconcile()` + per-directory components. | Reused verbatim; no kernel change. |

## Affected Files

| File | Change |
|------|--------|
| `src/file-manager.ts` | **Deleted** in phase 5 (after every piece has moved). |
| `src/file-manager/index.ts` *(new)* | `export { FileManagerView } from './view';` plus `export type { FileEntry } from './types';`. Keeps `compositor.ts:3798` working unchanged. |
| `src/file-manager/types.ts` *(new)* | `FileEntry`, `SortField`, `SortOrder`, `PromptState`, `ClipboardState`, `PreviewOutput`, `StatusTone`. |
| `src/file-manager/state.ts` *(new)* | `FileManagerState`, `createState()`, pure helpers and selectors (below). |
| `src/file-manager/sort.ts` *(new)* | `sortEntries()`. |
| `src/file-manager/filter.ts` *(new)* | `filterEntries()` (the `/` subsequence filter). |
| `src/file-manager/fuzzy.ts` *(new)* | `fuzzyScore()`, `rankSearch()`, `matchRuns()`. |
| `src/file-manager/skill.ts` *(new)* | `parseSkillFrontmatter`, `isSkillPath`, `isSkillFrontmatter`, `parseAllowedTools`, `renderSkillSpec`, `renderFrontmatterCard`, `escapeHtml`, moved verbatim. |
| `src/file-manager/file-type.ts` *(new)* | `fileTypeClass()`, moved verbatim (extension tables unchanged). |
| `src/file-manager/decorations.ts` *(new)* | `ROW_CLASS_DECORATORS`, `sizeClass()`, `recencyByPath()`, `ageFillStyle()`. |
| `src/file-manager/keymap.ts` *(new)* | `KeyBinding`, `KeyCtx`, `ChordTracker`, `NORMAL_KEYMAP`, `dispatchNormalKey()`. |
| `src/file-manager/modes.ts` *(new)* | `handleConfirmKey`, `handlePromptKey`, `handleFilterKey`, `handleSearchKey` against a `ModeCtx`. |
| `src/file-manager/ops.ts` *(new)* | Every `invoke` call, same command names and argument shapes. |
| `src/file-manager/preview/registry.ts` *(new)* | `PreviewRenderer`, `PreviewTarget`, `PREVIEW_RENDERERS`, `renderPreview()`. |
| `src/file-manager/preview/renderers/*.ts` *(new)* | `directory`, `too-large`, `binary`, `search-binary`, `skill`, `frontmatter`, `markdown`, `code`, `search-code`. |
| `src/file-manager/preview/controller.ts` *(new)* | `PreviewController`: 80 ms debounce, generation guard, `lastPreviewPath` skip. |
| `src/file-manager/view.ts` *(new)* | `FileManagerView implements ContentView`, the orchestrator. |
| `src/file-manager/components/{breadcrumb,file-list,file-row,search-list,search-row,preview-pane,status-bar}/index.ts` *(new)* | The seven components. |
| `src/file-manager/**/*.test.ts` *(new)* | See §Testing. |
| `vite.config.ts` | *Planned:* `dom` project `include` += `'src/file-manager/**/*.test.ts'`; `node` project `exclude` += `'src/file-manager/**'`. **Not applied** — outside the implementation's file scope; tests use per-file `// @vitest-environment happy-dom` docblocks instead (see §Implementation Notes). |
| `src/styles/file-manager.css` | **Unchanged** (§Styles). |
| `src/compositor.ts` | **Unchanged** (`import('./file-manager')` resolves to the directory index). |
| `src/file-manager-ai.ts`, `src/file-preview.ts` | **Unchanged**. Imported as `'../file-manager-ai'` / `'../file-preview'`. |
| `docs/0052-file-manager.md` | Note at the top pointing here; "Affected Files" gains the new package; keybinding table corrected (§Docs). |
| `docs/0004-architecture.md` | Add a "File Manager (`src/file-manager/`)" entry under §5.4 Compositor Layer with the module map below. |
| `docs/README.md` | Row 317 (added with this spec). |
| `CLAUDE.md` | No change. The `src/ui/` bullet already describes the kernel. |

No Rust or `src-tauri/` file changes.

## Design

### Target layout

```
src/file-manager/
  index.ts                  re-export (public surface: FileManagerView, FileEntry type)
  types.ts                  shared types
  state.ts                  FileManagerState + pure helpers/selectors
  sort.ts  filter.ts  fuzzy.ts  skill.ts  file-type.ts  decorations.ts      pure logic
  keymap.ts                 normal-mode key table + dispatcher
  modes.ts                  confirm / prompt / filter / search key handlers
  ops.ts                    Tauri invoke wrappers
  preview/
    registry.ts             PreviewRenderer, PREVIEW_RENDERERS, renderPreview()
    controller.ts           debounce + generation guard
    renderers/<id>.ts       one file per renderer
  view.ts                   FileManagerView (orchestrator, ~450 lines)
  view.parity.test.ts       phase-0 characterisation test
  components/
    breadcrumb/   file-list/   file-row/   search-list/   search-row/   preview-pane/   status-bar/
      index.ts  <name>.test.ts
```

Dependency direction: `view.ts` → {`components/*`, `keymap`, `modes`, `preview/*`, `ops`, `state`}. Components
import only pure modules and `src/ui/`. Pure modules import nothing from this package except `types.ts`
(`preview/renderers` may import `ops.ts` for reads, `skill.ts`, `../file-preview`, `highlight.js`). No
component imports `view.ts` or `ops.ts`.

### Data structures

```ts
// types.ts
export interface FileEntry {            // unchanged shape (list_directory payload)
  name: string; path: string; is_dir: boolean; is_symlink: boolean;
  size: number; modified: number; permissions: string; symlink_target: string | null;
}
export type SortField = 'name' | 'size' | 'modified';
export type SortOrder = 'asc' | 'desc';
export interface PromptState { label: string; value: string; onSubmit: (value: string) => void }
export interface ClipboardState { paths: string[]; op: 'copy' | 'cut' }
export type PreviewOutput =
  | { kind: 'text'; text: string }        // <pre>.textContent, markdown div hidden
  | { kind: 'html'; html: string }        // <pre>.innerHTML (hljs output)
  | { kind: 'markdown'; html: string };   // markdown div innerHTML, <pre> hidden, img max-width 100%
/** null = leave className as it is (the `Y` "Copied:" flash, see Parity P7). */
export type StatusTone = 'normal' | 'prompt' | 'filter' | 'error' | 'confirm' | null;

// state.ts — one mutable plain object owned by the view. No DOM, no timers.
export interface FileManagerState {
  readonly initialCwd: string;
  cwd: string;
  homeDir: string;                        // '/' until getHome() resolves (no re-render on resolve, as today)
  entries: FileEntry[];                   // sorted listing
  filtered: FileEntry[];                  // fresh array per applyFilter (identity = memo key)
  cursor: number; scrollOffset: number; visibleRows: number; cellHeight: number;
  sortField: SortField; sortOrder: SortOrder;
  filterMode: boolean; filterText: string;
  marked: Set<string>;
  tracked: Map<string, string>;
  clipboard: ClipboardState | null;
  showHidden: boolean;
  history: string[];
  prompt: PromptState | null;
  confirmAction: (() => void) | null;
  previewHidden: boolean;                 // replaces classList.toggle('…__preview--hidden')
  listWidthPx: number;                    // 333
  search: {
    active: boolean; text: string; root: string; capped: boolean;
    pool: string[]; poolLower: string[]; results: string[];
    cursor: number; scrollOffset: number;
  };
}

export function createState(initialCwd: string): FileManagerState;
// pure helpers — every one is today's arithmetic, extracted
export function wrapCursor(cursor: number, delta: number, len: number): number;          // ((c+d)%len+len)%len
export function clampScroll(cursor: number, offset: number, rows: number): number;       // clampScroll/clampSearchScroll
export function windowRange(offset: number, rows: number, len: number): [number, number];
export function parentDir(cwd: string): string;                                          // replace(/\/[^/]+\/?$/,'')||'/'
export function uniqueCopyPath(cwd: string, name: string, existing: ReadonlySet<string>): string; // findUniqueName
export function marksOrCurrent(s: FileManagerState): string[];
export function markedOrCurrentFiles(s: FileManagerState): FileEntry[];
export function restoreSelection(prevName: string | null, prevCursor: number, prevMarked: ReadonlySet<string>,
  filtered: readonly FileEntry[]): { cursor: number; marked: Set<string> };                // refreshDirectory
// selectors → component props
export function selectBreadcrumb(s: FileManagerState): BreadcrumbProps;
export function selectStatus(s: FileManagerState): StatusBarProps | null;   // null while confirmAction is set
export function selectFileList(s: FileManagerState): FileListProps;
export function selectSearchList(s: FileManagerState): SearchListProps;
export function aiContext(s: FileManagerState): FileManagerContext;          // getAIContext
```

`selectStatus` reproduces `renderStatus()` (`:1436-1496`) exactly: prompt → `` `${label} ${value}█` `` tone
`prompt`. Search → `` `${n} matches[ (capped)] │ ${pool} files indexed` `` tone `filter`. Filter →
`` `/${text}█  (${n} matches)` `` tone `filter`. Otherwise the `│`-joined parts (items, marked, tracked,
`sort: <field> ↑/↓`, `⎘|✂ n`, `hidden: on`, permissions, size) with tone `normal`.

### Pure modules

| Module | Exports | Source today |
|---|---|---|
| `sort.ts` | `sortEntries(entries, field, order): FileEntry[]`. Returns `[...entries].sort(cmp)`; the view stores the result back into `state.entries`, so ties resolve against the previous order exactly as the in-place sort did. | `applySort` `:861-878` |
| `filter.ts` | `filterEntries(entries, text): FileEntry[]`. Always returns a new array (`[...entries]` when `text` is empty). | `applyFilter` `:880-895` |
| `fuzzy.ts` | `fuzzyScore(target, query)`; `rankSearch(pool, poolLower, query, limit = 500): string[]` (empty query → `pool.slice(0, limit)`, otherwise score > 0, sort by score desc then length asc); `matchRuns(text, queryLower): { text: string; matched: boolean }[]` (the run-splitting walk of `renderSearchList` `:1397-1413`, including its first-character special case). | `:1603-1694`, `:1397-1434` |
| `skill.ts` | Moved verbatim; still returns HTML strings, because they are concatenated with `previewMarked.parse()` output into one `innerHTML`. | `:56-201` |
| `file-type.ts` | `fileTypeClass(entry): string`. Moved verbatim. | `:1903-1923` |
| `decorations.ts` | see §Extension point C | `:1283-1357` |
| `ops.ts` | `getHome()` (module cache, same `get_env_var` fallback), `listDirectory(path, showHidden)`, `readFile(path)`, `writeFile(path, content)`, `searchFiles(root, showHidden)`, `runCommand(program, args)` (always `cwd: null`), plus named wrappers `removePath`, `movePath`, `copyPath`, `makeDir`, which compose `runCommand` with today's exact argv (`rm -rf p`, `mv a b`, `cp -r a b`, `mkdir -p p`). | scattered |

### Extension point A — preview renderer registry

```ts
// preview/registry.ts
export type PreviewSource = 'cursor' | 'search';
export interface PreviewTarget {
  readonly source: PreviewSource;
  readonly path: string;                 // absolute
  readonly name: string;                 // basename used for ext/lang checks
  readonly entry: FileEntry | null;      // cursor source only (size, is_dir)
  readonly showHidden: boolean;
}
export interface PreviewIO {
  /** Memoised per request: several renderers may ask, `read_file` runs at most once. */
  readText(): Promise<string>;
  listDirectory(path: string): Promise<FileEntry[]>;
}
export interface PreviewRenderer {
  readonly id: string;
  readonly sources: readonly PreviewSource[];
  /** Cheap, metadata-only gate. */
  matches(t: PreviewTarget): boolean;
  /** Produce output, or `null` to decline and let the next renderer try (content sniffing). */
  render(t: PreviewTarget, io: PreviewIO): PreviewOutput | null | Promise<PreviewOutput | null>;
}
export const PREVIEW_RENDERERS: readonly PreviewRenderer[] = [
  directory,      // cursor: is_dir → "Directory: name/\n\nD directories, F files" | "(cannot read)"
  tooLarge,       // cursor: size > PREVIEW_MAX_BYTES → "File too large for preview\n<size>"
  binary,         // cursor: isBinaryExtension → "Binary file\n<size>"
  searchBinary,   // search: isBinaryExtension → "[binary file]"
  skill,          // both: isMarkdownFile && (isSkillPath || isSkillFrontmatter) && frontmatter → renderSkillSpec + marked(body); else null
  frontmatter,    // both: isMarkdownFile && non-empty frontmatter → renderFrontmatterCard + marked(body); else null
  markdown,       // both: isMarkdownFile → marked(content)
  code,           // cursor: hljs.highlight if extToLang && hljs.getLanguage, else highlightAuto → kind 'html'
  searchCode,     // search: first 200 lines + "\n\n... (truncated)"; extToLang → hljs.highlight (no getLanguage guard, as today); else text
];
/** Walk the list; the first non-null output wins. A throw from readText() or a renderer → readError(t). */
export async function renderPreview(t: PreviewTarget, io: PreviewIO,
  renderers: readonly PreviewRenderer[] = PREVIEW_RENDERERS): Promise<PreviewOutput>;
export function readError(t: PreviewTarget): PreviewOutput;
// cursor → "Cannot read file\n<size>", search → "[cannot read file]"
```

Today, markdown errors and an unknown-language `hljs.highlight` throw both land in the surrounding
`try/catch`, which shows the read-error text. Wrapping the whole walk keeps that. Splitting skill, frontmatter
and plain markdown into three renderers reproduces `renderMarkdownPreview()` (`:932-952`) branch for branch,
since all three call `previewMarked.parse(…, { gfm: true, breaks: true })` the same way.

`preview/controller.ts` keeps the timing contract:

```ts
export class PreviewController {
  constructor(private readonly pane: PreviewPane, private readonly io: (path: string) => PreviewIO) {}
  /** loadPreview(): debounce 80 ms → requestNow(cursor target); skip if path === lastPreviewPath. Also pane.resetScroll(). */
  requestCursor(target: PreviewTarget | null): void;
  /** loadSearchPreview(): lastPreviewPath = null; debounce 80 ms; no lastPreviewPath skip, no scroll reset. */
  requestSearch(target: PreviewTarget): void;
  /** clearPreview(): lastPreviewPath = null, paint {text:''}. Does NOT bump the generation (P9). */
  clear(): void;
  dispose(): void;              // clears the debounce timer
}
```

The generation counter is bumped as today: cursor requests bump it **after** the `lastPreviewPath` check, and
search requests bump it inside the debounced callback. The output is painted only if
`gen === this.generation` once `renderPreview` resolves. When no entry is under the cursor, the controller
paints `{ text: '' }` and nulls `lastPreviewPath`, with no bump (as `:965-970`).

**Recipe — add a preview type** (e.g. images):
1. Create `preview/renderers/image.ts` exporting `export const image: PreviewRenderer = { id: 'image', sources: ['cursor'], matches: (t) => /\.(png|jpe?g|webp)$/i.test(t.name), render: … }`. If it needs a new `PreviewOutput` kind, add it in `types.ts` and one `case` in `PreviewPane.paint()`.
2. Add `image` to `PREVIEW_RENDERERS` **before** `binary` (order is priority).
3. Add one case to `preview/registry.test.ts` (`renderPreview` picks `image` for `a.png`).

### Extension point B — normal-mode keymap

```ts
// keymap.ts
export interface ChordTracker {
  /** True if `key` was armed less than `withinMs` ago. */
  pending(key: string, withinMs: number): boolean;
  arm(key: string): void;
  clear(): void;
}
/** Everything a normal-mode command may do. Implemented by FileManagerView; faked in tests. */
export interface KeyCtx {
  readonly state: Readonly<FileManagerState>;
  readonly chord: ChordTracker;
  moveCursor(delta: number): void;
  jumpTo(index: number, mode: 'reset-scroll' | 'clamp'): void;   // gg: offset = 0; G: clampScroll
  enterSelected(): void; goParent(): void; goHome(): void; goBack(): void;
  scrollPreview(delta: number): void; resizeSplit(delta: number): void;
  openPreview(): void; togglePreview(): void;
  startFilter(): void; startSearch(): void; close(): void;
  clearMarks(): void; toggleMark(): void; toggleMarkAll(): void;
  toggleHidden(): void; cycleSort(): void; reverseSort(): void;
  yank(op: 'copy' | 'cut'): void; paste(): void; deleteSelection(): void; rename(): void;
  promptCreateFile(): void; promptCreateDir(): void; copyPath(): void;
  track(): void; openTrackedDiff(): void; openAI(): void;
}
export interface KeyBinding {
  readonly id: string;                       // 'cursor.down' — also the test/docs handle
  readonly keys: readonly string[];          // KeyboardEvent.key values
  readonly help: string;                     // one line, for docs/0052 and a future help overlay
  /** Return `false` to report "unhandled" (today's `return false` inside a case). */
  run(ctx: KeyCtx, e: KeyboardEvent): boolean | void;
}
export const NORMAL_KEYMAP: readonly KeyBinding[];
export function dispatchNormalKey(map: readonly KeyBinding[], ctx: KeyCtx, e: KeyboardEvent): boolean;
```

`dispatchNormalKey` mirrors the switch's semantics exactly. It finds the binding whose `keys` contains `e.key`
(a test enforces that no key appears twice). If one is found, it returns `run(…) !== false` and **does not**
touch the chord, just as a matched `case` never reaches the `lastKey` reset. If none is found, it calls
`ctx.chord.clear()` (unless `e.key === 'g'`) and returns `false`.

The table (one row per `case` today; `when`-style gating stays inside `run`):

| id | keys | run |
|---|---|---|
| `cursor.down` / `cursor.up` | `j ArrowDown` / `k ArrowUp` | `moveCursor(±1)` |
| `enter` / `parent` | `l Enter` / `h Backspace` | `enterSelected()` / `goParent()` |
| `cursor.top` | `g` | chord pending `g` within 500 ms → `jumpTo(0,'reset-scroll')`, `chord.clear()`; else `chord.arm('g')` |
| `cursor.bottom` | `G` | `jumpTo(len-1,'clamp')` |
| `preview.scroll-down/up` | `J` / `K` | `scrollPreview(±80)` |
| `split.narrow/widen` | `H` / `L` | `resizeSplit(∓5)` |
| `page.down` / `page.up` | `d` / `u` | `e.ctrlKey ? moveCursor(±floor(rows/2)) : return false` |
| `filter` / `search` | `/` / `f` | `startFilter()` / `startSearch()` |
| `close` | `q` | `close()` |
| `marks.clear` | `Escape` | `clearMarks()` (renders only when marks existed) |
| `hidden.toggle` | `.` | `toggleHidden()` |
| `sort` | `s` | `e.shiftKey ? reverseSort() : cycleSort()` (P4: `S` stays unbound) |
| `mark.toggle` / `mark.all` | ` ` / `v` | `toggleMark()` / `toggleMarkAll()` |
| `yank` / `cut` / `paste` | `y` / `x` / `p` | `yank('copy')` / `yank('cut')` / `paste()` |
| `delete` / `rename` | `D` / `r` | `deleteSelection()` / `rename()` |
| `new.file` / `new.dir` | `A` / `M` | `promptCreateFile()` / `promptCreateDir()` |
| `home` / `back` | `~` / `-` | `goHome()` / `goBack()` |
| `preview.open` / `preview.toggle` | `o` / `w` | `openPreview()` (files only) / `togglePreview()` |
| `path.copy` | `Y` | `copyPath()` |
| `track` / `track.diff` | `t` / `T` | `track()` / `openTrackedDiff()` |
| `ai` | `i` | `openAI()` |

`modes.ts` holds the other four handlers. They are small enough that a table would add indirection, not
extensibility. `FileManagerView.onKeyDown` keeps the cascade verbatim: `aiOverlay` → confirm → prompt → search
→ filter → `dispatchNormalKey(NORMAL_KEYMAP, this, e)`.

**Recipe — add a key** (e.g. `e` = open in `$EDITOR`):
1. If the action is new, add a method to `KeyCtx` and implement it in `view.ts`.
2. Append `{ id: 'open.editor', keys: ['e'], help: 'Open file in $EDITOR', run: (ctx) => ctx.openInEditor() }` to `NORMAL_KEYMAP`.
3. Add the row to the `docs/0052` key table. `keymap.test.ts`'s uniqueness test catches a clash with an existing key.

### Extension point C — row decorations

```ts
// decorations.ts
/** Pure on the entry: FileRow's deps include the entry, so a decorator may read nothing else. */
export type RowClassDecorator = (entry: FileEntry) => string | null;
export const ROW_CLASS_DECORATORS: readonly RowClassDecorator[] = [
  (e) => fileTypeClass(e) || null,                 // krypton-file-manager__item--ft-*
];
/** 'krypton-file-manager__size--mega' (≥ 1 MiB) | '…--large' (≥ 100 KiB) | null; dirs → null. */
export function sizeClass(entry: FileEntry): string | null;
/** Rank by `modified` (> 0 only) → 0..1; n === 1 → 0.5. Memoised on the `filtered` array identity. */
export function recencyByPath(entries: readonly FileEntry[]): ReadonlyMap<string, number>;
/** width 15+85r %, hsl(50-(1-r)*40, 85+15r %, 35+25r %), opacity 0.4+0.6r — today's ramp, verbatim. */
export function ageFillStyle(recency: number): { width: string; background: string; opacity: string };
```

`FileRow.syncClasses` emits, in today's order: `__item`, `--cursor`, `--dir`, `--symlink`, `--marked`, then
each decorator's class. Order matters only for `className` string equality in the parity test.

**Recipe — add a row decoration** (e.g. `--gitignored`):
1. If it is a pure function of the entry: write `export const gitignoredClass: RowClassDecorator = …` and append it to `ROW_CLASS_DECORATORS`. If it needs outside data (a git status map), add a field to `FileRowProps`, include it in `FileRow.readDeps`, and compute it in `selectFileList` instead.
2. Add the `.krypton-file-manager__item--gitignored` rule to `src/styles/file-manager.css`.
3. Add one case to `decorations.test.ts`.

### Components

All of them extend `Component<P>` from `src/ui/component.ts`, build their nodes with `el()`, and emit the
existing `krypton-file-manager__*` classes. None ships a stylesheet (§Styles).

| Component | Owns | Props | `readDeps` | Paint |
|---|---|---|---|---|
| `Breadcrumb` | `div.__breadcrumb` | `{ search: boolean; text: string }` | `[search, text]` | toggles `__breadcrumb--search`, sets `textContent`. `selectBreadcrumb` → `SEARCH // ${text}█` or cwd with `~` substitution. |
| `FileRow` | `div.__item` > `span.__mark`, `span.__icon`, `span.__name`, `span.__age-bar` [> `span.__age-fill`], `span.__size` | `{ entry: FileEntry; isCursor: boolean; marked: boolean; recency: number \| undefined }` | `[entry, isCursor, marked, recency]` | Children created once in the constructor and updated in place. Text: mark `'● '`/`'  '`, icon `'▸ '`/`'  '`, name `name[/][ → target]`, size `formatSize` (files only) + `sizeClass`. The age fill is appended or removed as `recency` toggles defined. |
| `FileList` | the shared `div.__list` | `{ rows: FileRowProps[]; empty: string \| null }` | `[rows-signature]`: see below | `empty !== null` → `disposeList(el)` + `setChildren(el, [div.__empty])`; otherwise `reconcile(el, rows, FILE_ROW_SPEC)` with key `'f:' + entry.path`. |
| `SearchRow` | `div.__item` > `span.__icon` (`'  '`), `span.__name` (text nodes + `span.__match` runs) | `{ relPath: string; query: string; isCursor: boolean }` | `[relPath, query, isCursor]` | `matchRuns(relPath, query)`; plain text when the query is empty. |
| `SearchList` | the same `div.__list` | `{ rows: SearchRowProps[]; empty: string \| null }` | as `FileList` | key `'s:' + relPath`; empty text `'No matches'`/`'Loading...'`. |
| `PreviewPane` | `div.__preview` > `pre.__preview-content`, `div.__preview-markdown` (`display:none` initially) | `{ hidden: boolean; output: PreviewOutput }` | `[hidden, output]` (identity, fresh object per render) | toggles `__preview--hidden`. Applies `output` exactly as `showPreText`/`renderMarkdownPreview`/hljs did, and leaves the hidden node's content untouched (P10). Imperative methods: `scrollBy(delta)` (smooth, on whichever child is visible), `resetScroll()` (`el.scrollTop = 0`), `setFlex(value)`. |
| `StatusBar` | `div.__status` | `{ text: string; tone: StatusTone }` | `[text, tone]` | `textContent = text`; `tone === null` leaves `className`, otherwise `__status` + `__status--${tone}` (not for `normal`). |

**List windowing and the shared node.** `FileList` and `SearchList` are both constructed over the one
`div.krypton-file-manager__list` that today's DOM has, so no wrapper node is added. Only one is active at a
time. On a mode switch the view calls `outgoing.release()`, which is `disposeList(el)` plus
`invalidateDeps()`, before the incoming list's first `update()`. The `'f:'`/`'s:'` key prefixes are a second
guard against reusing a row across kinds. `FileList.readDeps` returns
`[empty, rows.length, ...rows.flatMap(r => [r.entry, r.isCursor, r.marked, r.recency])]`, which is at most
`visibleRows × 4` `Object.is` checks. So a re-render with an unchanged window is a no-op. A `j`/`k` repaints
two rows. Scrolling one line disposes one row, creates one, and moves none, because `syncOrder` keeps the rest.

`selectFileList` builds the window with `windowRange(scrollOffset, visibleRows, filtered.length)` and keeps
today's `visibleRows <= 0` fallback (`listEl.clientHeight || bodyEl.clientHeight || 600`, which the view
passes in). `recencyByPath` is computed over the whole `filtered` list, as today, memoised on its identity so
cursor moves stay O(window).

### View (orchestrator)

```ts
export class FileManagerView implements ContentView, KeyCtx {
  readonly type: PaneContentType = 'file_manager';
  readonly element: HTMLElement;                 // div.krypton-file-manager
  constructor(initialCwd: string, container: HTMLElement);
  onClose(cb: () => void): void;
  onOpenDiff(cb: (diff: string, title: string) => void): void;
  onKeyDown(e: KeyboardEvent): boolean;
  onResize(width: number, height: number): void;
  getWorkingDirectory(): string | null;
  dispose(): void;
  // + the KeyCtx / ModeCtx methods; private render hooks:
  private renderBreadcrumb(): void;   // breadcrumb.update(selectBreadcrumb(state))
  private renderList(): void;         // active list .update(select…List(state))
  private renderStatus(): void;       // const p = selectStatus(state); if (p) status.update(p)
  private flashStatus(text: string, tone: StatusTone, resetMs?: number): void; // error/confirm/yank/copy/track
}
```

The constructor builds `element` > `breadcrumb.el`, `body` > (`list`, `preview.el`), `status.el` with `el()`, in
today's order and with today's classes. It appends `element` to `container`, starts `getHome()`, and calls
`loadDirectory(cwd)`. **The `render*()` hooks are called from exactly the same sites as today** (see P1). The
view does not re-render reactively on every state change; it only swaps *how* a region paints.
`loadDirectory`, `loadDirectoryNoHistory` and `loadDirectoryAndSelect` collapse into one
`load(path, { pushHistory?: never; select?: string; guardInitialCwd: boolean })`, keeping the existing
differences. Only the first two have the `startsWith(initialCwd)` guard. `loadDirectoryAndSelect` skips it,
keeps `scrollOffset = 0` + `clampScroll`, and opens the preview when the selected item is a file.

`dispose()` keeps today's order and effects: clear the preview debounce and status reset timers, `closeAI()`,
empty the arrays/sets, cancel the search rAF, null `clipboard`/`prompt`/`confirmAction`. It also disposes the
components, which only frees listeners and row maps. It does not remove `element` from the DOM: today's
`dispose` doesn't, and the compositor owns the container.

### Styles

**Decision: keep `src/styles/file-manager.css` byte-for-byte. Components ship no `<name>.css`.** Reasons:

1. The sheet is **unlayered** (imported plainly from `src/styles/index.css:23`). Moving its rules into
   `@layer krypton.component` would rank them below **every** unlayered rule in the app (CSS Cascade 5),
   including `theme-scheme.css`, which stays unlayered and last on purpose (`layers.css` header). That changes
   which rule wins every cross-sheet contest. Proving no visual change would take a per-selector audit of 893
   lines, and the no-visual-change goal can't absorb that risk.
2. Every selector belongs to **one BEM block** (`krypton-file-manager`), plus `krypton-skill-spec` and the
   AI overlay's `krypton-file-manager-ai` (a non-goal). Per-component sheets would all claim the same block,
   so the 301 ownership rule ("a directory owns its blocks") would give no isolation. Real ownership would
   mean renaming classes, which is a visual-risk change.
3. `src/acp/components/styles-ownership.test.ts` only scans `src/acp/components/`, and its registry is
   `HARNESS_COMPONENTS`. Enforcing layers here would need a second registry for no gain at this size.

A follow-up spec can carve the sheet once someone audits the layer move. This spec does not depend on it.

### Parity contract

Identical before and after, all enforced by `view.parity.test.ts` (phase 0):

- **`ContentView` surface**: `type === 'file_manager'`, `element`, `onKeyDown`, `onResize`, `dispose`,
  `getWorkingDirectory`, `onClose`, `onOpenDiff`, constructor `(initialCwd, container)`. No `handlePaste`,
  `onShow` or `focusView` added.
- **DOM**: tag, class list order, text, child order and inline styles of the breadcrumb, every row, search
  row, empty state, preview children and status, for each scenario in §Testing.
- **Keys**: every binding in the table above, the mode cascade order, and the `gg` 500 ms chord.
- **`invoke` traffic**: command names, argument objects and call order (`list_directory`, `read_file`,
  `write_file`, `run_command`, `search_files`, `get_env_var`).
- **Timers**: 80 ms preview debounce (shared by both sources), 2000 ms status reset for yank/copy/track,
  3000 ms for errors, one rAF per search-input burst, 500 ms chord.
- **Async guards**: preview generation discard; the search rAF does nothing once search mode has exited.
- **AI overlay**: dynamic `import('../file-manager-ai')`, the same `FileManagerAI` options
  (`cwd`, `getContext`, `onDone → refreshDirectory`, `onClose → closeAI`), `open(this.element)`, and every
  key delegated while it is open.

**Preserved quirks.** These look like bugs, but changing them is a behaviour change, so they stay. Each one
is pinned by a parity case with a `// quirk Pn` comment:

| # | Quirk | Source |
|---|---|---|
| P1 | `j`/`k`/`Space`/`gg`/`G` do not re-render the status bar, so the permissions/size/marked count stay stale until the next status render. | `moveCursor` `:676-689` |
| P2 | Moving the cursor does not load a preview; only `o`, `l`/`Enter` on a file, and search select do. | `:572-579`, `:729-740` |
| P3 | A key with a `case` label (including `d`/`u` without ctrl) never resets the `g` chord. | `:606-609` |
| P4 | `S` (shift+s) is unbound, because `e.key` is `'S'`. Reverse sort only fires for `key === 's' && shiftKey`. | `:499-515` |
| P5 | The `/` filter is in-order subsequence matching on names; `f` search uses the scored `fuzzyScore`. They are different algorithms. | `:880-895` |
| P6 | Search preview: no size limit, no directory summary, 200-line truncation, `[binary file]`/`[cannot read file]` text, no `getLanguage` guard. | `:1782-1821` |
| P7 | `Y` writes `Copied: …` without touching `className` (so it keeps an error/confirm tone if one is showing); yank/track reset it to plain `__status`. | `:1039-1046`, `:1186-1194` |
| P8 | `getHome()` resolving does not re-render the breadcrumb. | `:306` |
| P9 | `clearPreview()` (directory change) does not bump the generation, so a preview already in flight can still paint after the listing changes. | `:917-922` |
| P10 | The hidden preview node keeps its old content (the markdown div is never cleared). | `:925-929` |
| P11 | The confirm prompt fires on any key; only `y` runs the action. | `:325-335` |

**Deviation D1 (needs explicit approval).** After `Space`, today's `patchCursor()` writes `● ` into the row
it leaves but does not add `krypton-file-manager__item--marked`. Because `__mark` is `color: transparent`
unless `--marked` is set (`file-manager.css:482-494`), the dot is **invisible** until something triggers a full
`renderList()`. `FileRow` derives its classes from props, so the dot shows immediately. This is the only
pixel difference. The parity test asserts the new behaviour for this one case, with a `// D1` comment.
Reproducing the bug would need a "stale marked class" prop whose only job is to be wrong. If the reviewer
rejects D1, that hack goes in `FileRow` and the case flips back.

### Data flow (example: `j`)

```
keydown → view.onKeyDown → (no overlay/confirm/prompt/search/filter) → dispatchNormalKey
  → binding 'cursor.down'.run(ctx) → view.moveCursor(1)
     state.cursor = wrapCursor(...); state.scrollOffset = clampScroll(...)
     view.renderList() → fileList.update(selectFileList(state))
        readDeps changed → reconcile(listEl, window, FILE_ROW_SPEC)
           row[old].update({isCursor:false}) → repaint; row[new].update({isCursor:true}) → repaint; others skip
     (no renderStatus — P1)
```

## Phases

| Phase | Work | Gate |
|---|---|---|
| 0 | Add `src/file-manager/view.parity.test.ts` (importing `'../file-manager'`, which resolves to the **old** file) + the `vite.config.ts` project globs. Write every scenario in §Testing against the current class. | `npx vitest run src/file-manager` green against the old code. |
| 1 | Extract the pure modules (`types`, `sort`, `filter`, `fuzzy`, `skill`, `file-type`, `decorations`, `ops`, `state` helpers) with unit tests. The old class imports them from `./file-manager/…`. | Unit tests + parity green; `tsc` clean. |
| 2 | Components + component tests; `FileList`/`SearchList` replace `renderList`/`renderSearchList`/`patchCursor` in the old class. | Parity green (D1 case updated). |
| 3 | Preview registry + controller replace `loadPreviewNow`/`loadPreviewForPath`/`renderMarkdownPreview`. | Parity + registry tests green. |
| 4 | `keymap.ts` + `modes.ts` replace the four handlers. | Parity + keymap tests green. |
| 5 | Move the remaining class body into `view.ts`, add `index.ts`, delete `src/file-manager.ts`. | Parity now resolves to the directory index and is green with no test edit; `npm run build` and the full `npx vitest run` green. |
| 6 | Docs (§Docs). | — |

## Testing

All test files live under `src/file-manager/` and run in the `dom` (happy-dom) project. `@tauri-apps/api/core`
is replaced with `vi.mock` by an in-memory fake filesystem that records every `invoke(cmd, args)`. Timers
use `vi.useFakeTimers()`; `requestAnimationFrame` is stubbed with `vi.stubGlobal` and flushed by hand.

**Pure unit tests**

| File | Cases |
|---|---|
| `sort.test.ts` | Dirs first under every field/order; case-insensitive name; ties keep the input order (stability). |
| `filter.test.ts` | Empty text returns a new array; subsequence match; case-insensitive; no match → `[]`. |
| `fuzzy.test.ts` | `fuzzyScore` 0 on miss / `q > t`; consecutive, boundary (`/ . _ -`), basename and basename-prefix bonuses with exact numbers; `rankSearch` cap of 500, score then length order, empty query; `matchRuns` golden runs, including the first-character case. |
| `skill.test.ts` | Simple, folded (`>`) and literal (`|`) values; no frontmatter; `isSkillPath` for `.claude/skills/x.md` and `SKILL.md`; `isSkillFrontmatter` needs name + description + tools; `parseAllowedTools` keeps `Bash(git log:*)` whole; `escapeHtml` in both cards. |
| `decorations.test.ts` | `fileTypeClass` per family + `Makefile`/`.gitignore`; `sizeClass` thresholds (100 KiB, 1 MiB, dirs); `recencyByPath` 0..1, single entry 0.5, `modified = 0` excluded; `ageFillStyle` strings. |
| `state.test.ts` | `wrapCursor`, `clampScroll`, `windowRange`, `parentDir('/')`, `uniqueCopyPath` (`a 2.txt`, dotfile, 1000 fallback), `restoreSelection`, and `selectStatus` for every tone, including `null` under confirm. |
| `keymap.test.ts` | No key in two bindings; every id unique; `gg` within / after 500 ms (fake clock); an unbound key clears the chord but a bound one (`d` without ctrl) doesn't (P3); `d` without ctrl → `false`; `s` + shift → `reverseSort`, `S` → `false` (P4). Each binding calls its expected `KeyCtx` method (recording fake). |
| `modes.test.ts` | Prompt typing/Backspace/Enter/Escape; filter Enter keeps the text, Escape clears and resets the cursor; search `ctrl+j/k`, `ctrl+u`, Escape tears down the pool; confirm `y` vs other keys (P11). |
| `preview/registry.test.ts` | Renderer selection for dir / too-large / binary (both sources) / skill by path / skill by frontmatter / frontmatter card / plain md / code with a known lang / `highlightAuto` / search truncation; a `readText` throw → `readError` per source; `readText` runs at most once per request. |
| `preview/controller.test.ts` | Debounce coalescing; a stale generation is discarded; `lastPreviewPath` skip for cursor only; `clear()` does not bump the generation (P9). |

**Component tests** (`components/<name>/<name>.test.ts`)

| Component | Cases |
|---|---|
| `FileRow` | Golden `outerHTML` for file / dir / symlink → target / marked / cursor / ft class / `--large` / `--mega`; the age fill is added and removed as `recency` changes; `update()` with equal props doesn't repaint (node identity + spy). |
| `FileList` | Window of `visibleRows` from `scrollOffset`; a cursor move repaints exactly two rows and keeps every row node (`===`); a one-line scroll keeps `rows-1` nodes; empty states `Empty directory`/`No matches`; dispose on release. |
| `SearchList`/`SearchRow` | `__match` run markup for `src/main.ts` with `smt`; `Loading...` vs `No matches`; switching `FileList` → `SearchList` → `FileList` on the shared node leaves no stale rows. |
| `StatusBar` | Every tone's `className`; `tone: null` keeps the previous class (P7). |
| `PreviewPane` | `text`/`html`/`markdown` toggle the display of the right child; the markdown img max-width; the hidden node is left intact (P10); `--hidden` toggle; `scrollBy` targets the visible child. |
| `Breadcrumb` | `~` substitution, `homeDir === '/'` leaves the path alone, search variant class + `█`. |

**Parity test** (`view.parity.test.ts`): it builds a `FileManagerView` over a fixture tree (dirs, dotfiles,
symlink, `.md` with skill and generic frontmatter, `.ts`, `.png`, an over-limit file, a 1 MiB file) and, for
each scenario, asserts `element.outerHTML` and the recorded `invoke` log. Scenarios: initial render; `j`/`k`
and wrap; scrolling past the window; `gg`/`G`/`ctrl+d`/`ctrl+u`; `Space` (D1) and `v`; `/` filter type /
Enter / Escape; `s`, shift+`s`, `S`; `.`; `f` search, type, `ctrl+j`, Enter → select in the directory;
`o` on each preview kind; `w`; `H`/`L` flex styles; `A`/`M`/`r` prompts; `D` → `y` and `D` → `n`; `y`/`x`/`p`
(same dir → `name 2.ext`); `Y`; `t`/`T` with `onOpenDiff` spy; `i` with a mocked `../file-manager-ai`
receiving every key; `q` → `onClose`; `-`/`~`/`h`/`l`; `onResize` row count from a stubbed
`--krypton-terminal-cell-height`; `dispose()` leaves no pending timer (`vi.getTimerCount() === 0`).

Run: `npx vitest run src/file-manager` and `npm run build` (`tsc` + vite).

## Docs

- `docs/0052-file-manager.md`: add `> Superseded in structure by [317](./0317-file-manager-components.md)`
  under the status line, add `src/file-manager/` to Affected Files, and fix the key table to match the code
  (preview on `o` not cursor-move, `S` shown as shift+`s`, the `f`/`i`/`t`/`T`/`Y`/`w`/`H`/`L`/`J`/`K` keys
  that are missing). Generate it from `NORMAL_KEYMAP[].help` order.
- `docs/0004-architecture.md` §5.4: one "File Manager" paragraph with the module map from §Target layout and
  the three extension recipes in one line each.
- `docs/README.md`: row 317 (done with this spec).

## Edge Cases

- **Duplicate `reconcile` keys.** `list_directory` paths are unique within a directory, and search results
  are a slice of a de-duplicated walk. `reconcile` throws on a duplicate, which would surface a backend bug
  loudly. The `'f:'`/`'s:'` prefixes rule out cross-kind collisions.
- **Resize while searching.** `onResize` only clamps `scrollOffset` (not the search offset), then
  `renderList()` paints whichever list is active. Unchanged.
- **Dispose during an in-flight `list_directory`.** Today the late resolve still renders into the detached
  element. The components are disposed, but `update()` on a disposed component still paints into its own
  detached node and attaches no listeners, so the behaviour matches and nothing leaks.
- **Rows contain no listeners.** Rows are keyboard-only, so there is nothing to leak if a disposal is missed.

## Open Questions

1. Approve **D1** (the marked dot shows immediately)? Recommended: yes.
2. Should a follow-up fix P1 (status stale on cursor moves) and P4 (`S` unbound)? Both are one-line changes
   after this refactor (`renderStatus()` in `moveCursor`; add `'S'` to the `sort` binding). They are
   deliberately excluded here.

## Out of Scope

- `src/file-manager-ai.ts` internals and `src/file-preview.ts` (imported, not edited).
- Any Rust / `src-tauri` change, any new Tauri command.
- Carving `src/styles/file-manager.css` into layered per-component sheets (§Styles).
- A help overlay generated from `NORMAL_KEYMAP` (the `help` field makes it possible later).
- Moving from the fixed window to scroll-based virtualisation.

## Resources

- `src/ui/component.ts`, `src/ui/list.ts`, `src/ui/dom.ts` — kernel used as is.
- [301](./0301-harness-ui-components.md) / [302](./0302-harness-component-catalog.md) — directory convention and test style (`src/acp/components/chip/chip.test.ts`).
- `vite.config.ts:21-45` — node/dom test projects.
- CSS Cascade 5, unlayered vs layered precedence — <https://www.w3.org/TR/css-cascade-5/#layering>.
- yazi previewer rules — <https://yazi-rs.github.io/docs/configuration/yazi#plugin.previewers>.

## Implementation Notes

- **Test environment.** `vite.config.ts` is unchanged (it was outside the implementation's file scope). Every
  test under `src/file-manager/` opts into happy-dom with a `// @vitest-environment happy-dom` docblock, the
  pattern `src/connected-computers-view.test.ts` already uses. They run in the `node` project with a DOM.
- **Parity proof.** `view.parity.test.ts` was run against the old `src/file-manager.ts` first. Its 16
  `toMatchSnapshot()` records in `__snapshots__/view.parity.test.ts.snap` were written by the old class. The
  new package passes them unchanged, except one state in the `D → y` scenario: two rows marked with `Space`
  now carry `--marked` (D1). That snapshot was re-recorded, and the diff was checked to contain only that class.
  Class tokens are sorted before comparison, because the old `patchCursor()` appended `--cursor` with
  `classList.add`, so its class order depended on patch history.
- **`PreviewController.requestCursor(getTarget)`** takes a getter, not a target. The old `loadPreviewNow()`
  read the cursor entry when the 80 ms debounce fired, so `o` followed by `j` within 80 ms previews the new
  row. `forgetPath()` was added for the `lastPreviewPath = null` sites that do not blank the pane.
- **`readText()` memoisation** lives in `renderPreview()`, so it holds for any `PreviewIO`.
- **`KeyCtx` / `ModeCtx`** are private object literals built by the view, not public methods on
  `FileManagerView`, so the `ContentView` surface is unchanged.
- `dispose()` disposes the breadcrumb and status components but not the two lists. Disposing a list
  empties `__list`, and the old `dispose()` left the DOM as it was.

## Smooth scrolling

All motion goes through `src/file-manager/smooth-scroll.ts`, which uses the diff view's easing
(`SCROLL_LERP = 0.24`: each frame covers 24% of the remaining distance, at least 1px, and lands once
within `SCROLL_SNAP_PX = 0.5`). `SmoothScroller` runs one rAF loop, and it jumps straight to the
target when `prefers-reduced-motion: reduce` is set.

- **Preview (J/K):** `PreviewPane.scrollBy` drives one `SmoothScroller` on the visible child. When a
  key is held, the active target moves further instead of the animation restarting. New content,
  `resetScroll()` and `dispose()` cancel the animation.
- **Lists (directory and fuzzy search):** both lists stay virtualised.
  - `selectFileList(s, position)` / `selectSearchList(s, position)` render
    `overscanRange(position, visibleRows, len)`. That is `LIST_OVERSCAN = 3` rows above and below the
    viewport. The start is rounded down to an even row so `:nth-child(even)` stripes stay with their
    entry during a glide.
  - Rows go into `div.krypton-file-manager__rows`, managed by `components/list-frame.ts`, inside
    `__list`, which has `overflow: hidden`. The frame is moved with
    `transform: translateY(shiftPx)`, where `shiftPx = (start - position) * cellHeight`. This transform
    is applied on every `update()` and is not part of the row deps, so a frame never repaints a row.
  - The view owns one `ListGlide` per list. `renderList()` calls `sync(scrollOffset, visibleRows,
    cellHeight)`, and each animation frame calls `renderList()` again. Rows are therefore re-windowed
    around the *animated* position, so no blank rows show during a glide.
  - Only `scrollOffset` animates. The cursor highlight, marks and status update at once.
  - A move larger than `visibleRows` snaps (G, gg, a big ctrl+d/u on a short viewport). So do a
    cell-height change, a new row array (directory load or refresh, filter, sort, search pass) and a
    switch between file and search mode; these call `snapNext()`, which also cancels any running glide.
- **Parity:** the `view.parity` snapshots were re-recorded for the `__rows` wrapper, its transform and
  the overscan rows. Before re-recording, a temporary run with `LIST_OVERSCAN = 0`, no even-row
  alignment, and `__rows` unwrapped by `norm()` matched the old snapshots 24/24.
