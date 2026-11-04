# Unified Search Palette with Scope Tabs — Implementation Spec

> Status: Implemented (2026-10-31; approved the same day)
> Date: 2026-10-31
> Milestone: M8 — Polish
> Amends: [0015](./0015-command-palette.md), [0068](./0068-quick-file-search.md), [0110](./0110-context-aware-command-palette.md)
> Amended by: [0358](./0358-command-palette-icons.md) — a Commands row now starts with the action's icon (`svg.krypton-search-palette__icon`).

## Problem

Krypton has two separate pickers that look and behave differently:
- the Command Palette (`Cmd+Shift+P`), which runs actions;
- Quick File Search (`Cmd+O`), which finds files and greps.

They differ in width, scrim, hint bar and mode, and `Tab` means "next row" in one and
"file ↔ grep" in the other. The user wants one search UI where commands and files are tabs
of the same overlay.

## Solution

Replace both overlays with one **Search Palette** that has three scope tabs: **Commands |
Files | Grep**.
- `Cmd+Shift+P` opens it on Commands and `Cmd+O` opens it on Files.
- `Tab` / `Shift+Tab` move between tabs, and the typed query carries over.
- Each tab keeps its current engine and actions. Commands use the in-memory fuzzy action list
  (with the focused view's Context section). Files and Grep use `fff-search` through the
  existing Tauri commands.
- There is no "All" tab. Results from two different scorers can't be ranked in one list, and
  searching commands should not start a file query on every keystroke.

**Behavior changes users will notice:**
- In Commands, `Tab` now switches tabs. `↑`/`↓` and `Ctrl+N/P` still move the selection.
- Clicking a file row opens it in Helix. Before this, a click copied the path.
- The command list uses the Files look: 600px wide with a scrim. It was 500px with no scrim.
- Every way of closing the palette returns the router to Normal: row click, backdrop click,
  and Leader. Before this, those paths left the router in `Mode.CommandPalette`.
- `Cmd+Shift+P` force-exits the same modes as `Cmd+O`: Selection, Hint, PromptDialog,
  InlineAI and QuickOverview. Before this, it force-exited only Selection, Hint and
  QuickOverview.

## Research

- **Today** (code map, `command-palette.ts`, `quick-file-search.ts`, `input-router.ts`):
  - Two classes with their own DOM, both fixed at `z-index: 10002` and appended to `<body>`
    (`command-palette.ts:97-127`; `quick-file-search.ts:484`).
  - Two modes, `Mode.CommandPalette` and `Mode.QuickFileSearch` (`types.ts:34, 39`).
  - Two style blocks: `overlays.css:196-355` (500px, no scrim) and `quick-file-search.css`
    (600px, scrim `rgba(0,0,0,.35)`, purple border in grep mode).
  - Only QFS reports its own close back to the router (`exitQuickFileSearch`,
    `input-router.ts:269-274`). A palette row click or backdrop click leaves the router in
    `Mode.CommandPalette`.
- **Key conflict:**

  | Key | Palette | QFS |
  |---|---|---|
  | `Tab` / `Shift+Tab` | next / previous row (`command-palette.ts:258-266`) | file ↔ grep (`quick-file-search.ts:126-130`) |
  | `Enter` | execute | open in Helix |
  | `Ctrl+E`, `Cmd+Enter` | — | copy the path |
  | `Ctrl+U` | — | clear the query |
  | `Alt+1..9` | quickselect | — |

  Arrows and `Ctrl+N/P` move the selection in both.
- **No external API callers to preserve:**
  - `openWithQuery`, `onOpen`, `onClose` and `toggle` have no callers (only Draft spec 0248
    mentions `openWithQuery`).
  - The palette has no nested pickers. Themes, accents, sound themes and dashboards are flat
    actions.
  - The mode names are not used outside `src/` (no matches in `src-tauri`, `raycast`,
    `src/loopback` or `e2e`).
- **Tests:** there is no `command-palette.test.ts` and no `quick-file-search.test.ts`. The only
  related assertion is `workspace-footer-format.test.ts:97` (`hintFor(Mode.CommandPalette)`).
- **Theme hook:** `theme.ts:491-497` sets `--krypton-palette-*` from `theme.ui.command_palette`.
  The unified overlay keeps these variables, so theme files need no change. No `backdrop-filter`
  is used.
- **Alternatives ruled out:**
  - *VS Code-style prefixes* (`>` commands, `%` grep): proposed earlier, but the user chose tabs.
    Tabs are easier to discover.
  - *Mixed "All" list* (Raycast): needs cross-scorer ranking and an `fff-search` call on every
    command keystroke.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| JetBrains Search Everywhere | One popup with tabs (All, Classes, Files, Symbols, Actions, Text). `Tab` switches scope. Per-scope shortcuts (`Ctrl+Shift+N` files, `Ctrl+Shift+A` actions) open the popup on that tab | Closest match. Adopted `Tab` = next scope and shortcuts that pick the tab |
| VS Code Quick Open | One input. No prefix = files, `>` = commands. `Cmd+Shift+P` = `Cmd+P` with `>` filled in | Same idea of "two shortcuts, one UI", but with prefixes instead of tabs |
| Obsidian | Separate Command Palette and Quick Switcher. The popular Better Command Palette plugin unifies them with prefixes | Users want one palette |
| Raycast | One list ranked across categories | Not adopted: no shared score |

**Krypton delta:**
- Follows JetBrains for tabs and `Tab` switching.
- Has no All tab.
- Keeps Krypton's existing shortcuts and per-row actions (open in Helix, copy path).
- Everything is keyboard-reachable. The mouse can click a tab or a row.

## Affected Files

| File | Change |
|------|--------|
| `src/search-palette.ts` (new) | `SearchPalette` overlay: DOM, tab strip, input, results, status + hint bar, selection, keys, one close callback |
| `src/command-palette.ts` | Becomes `CommandScope`: action registry (`registerActions`, `rebuildActions`, `refreshColorThemes`), `fuzzyMatch`, rows, execute. DOM, `open`/`close`/`toggle`/`openWithQuery`/`onOpen`/`onClose` removed |
| `src/quick-file-search.ts` | Becomes `FileScope` and `GrepScope`: warm root, queries with the stale-token guard, rows, open in Helix, copy, `record_pick`. DOM and mode toggle removed |
| `src/palette-types.ts` | Adds `ScopeId`, `SearchScope`, `ScopeRow`, `ScopeQueryResult` |
| `src/types.ts` | `Mode.SearchPalette` replaces `Mode.CommandPalette` and `Mode.QuickFileSearch` |
| `src/input-router.ts` | One setter and one key path. `Cmd+Shift+P`/`Cmd+O` open, switch or close. One force-exit list. `exitSearchPalette()` |
| `src/main.ts` | Builds the scopes and the palette, and wires the close callback |
| `src/workspace-footer-format.ts` (+ tests in `workspace-footer-format.test.ts`, `workspace-footer.test.ts`) | `hintFor(Mode.SearchPalette)` returns `'Tab scope · Esc close'`; `Tab` joins the footer's key-chip pattern so it renders as a key |
| `src/styles/search-palette.css` (new), `overlays.css`, `quick-file-search.css`, `index.css` | One block `.krypton-search-palette*`. Delete `overlays.css:196-355` and `quick-file-search.css`. Import the new sheet the same unlayered way |
| `docs/0015`, `0068`, `0110`, `0304`; note in Draft `0248` | "Amended by 0349" notes. Fix the Tab, mode, class-name and separate-overlay statements |
| `docs/0004-architecture.md`, `0005-data-flow.md`, `README.md`, `CLAUDE.md` | Overlay list, mode table and mode list, flows, index |

## Design

### Data Structures

```ts
// src/palette-types.ts
export type ScopeId = 'commands' | 'files' | 'grep';
export type AcceptHow = 'primary' | 'copy-relative' | 'copy-absolute';
export interface ScopeRow {
  readonly section?: PaletteSection;   // 'context' rows get the Context header (zero query)
  render(el: HTMLElement): void;       // scope-specific markup inside the palette-owned row
}
export interface ScopeQueryResult { rows: ScopeRow[]; status: string; pending: boolean }
export interface ScopeHint { text: string; kind?: string } // kind lets flash() light it up
export interface AcceptControl {       // what a scope may do to the palette while accepting
  close(): void;                       // silent close (the scope plays `execute`)
  setStatus(text: string): void;
  flash(kind: string): Promise<void>;  // 80 ms row + hint pulse
  playExecute(): void;
}
export interface SearchScope {
  readonly id: ScopeId;
  readonly label: string;              // 'Commands' | 'Files' | 'Grep'
  readonly shortcut: string;           // '⇧⌘P' | '⌘O' | ''
  readonly prompt: string;
  readonly placeholder: string;
  readonly hints: readonly ScopeHint[];
  aside(): string;                     // right of the input: the project root on Files / Grep
  reset(): void;                       // every scope, on every palette open
  activate(): Promise<void>;           // commands: rebuildActions(); files/grep: warm the root
  query(q: string): Promise<ScopeQueryResult>;
  accept(row: ScopeRow, how: AcceptHow, ctl: AcceptControl): Promise<void>;
  setInvalidate?(cb: () => void): void; // commands: re-query when the theme list changes
}
```

Rows are built per query, so a row captures the query it highlights. Files and Grep
share one `ProjectRoot` (`src/quick-file-search.ts`) that warms the root once per
palette open; a generation counter stops a warm-up from an earlier open writing back.

`SearchPalette` keeps `active: ScopeId`, `rows`, `selectedIndex`, an `epoch` bumped on
every tab entry and close (drops late activations), and a single `queryToken` shared by
all scopes (any response for an older token or another tab is dropped). A query that
returns `pending: true` (backend still indexing) is polled again after 250 ms.

**Deviation from the approved draft:** `accept` takes an `AcceptControl` instead of
returning `'closed' | 'stay'`. Commands must close the palette *before* running the action
(an action may open another overlay and set its own mode), while a copy must flash first
and close afterwards; a return value cannot express both orders.

### API

```ts
class SearchPalette {
  constructor(scopes: Readonly<Record<ScopeId, SearchScope>>, sound: SoundEngine, onClose: () => void);
  get isVisible(): boolean;
  get activeScope(): ScopeId;
  open(scope: ScopeId): void;          // clears the query, resets every scope, activates, queries, focuses
  switchTo(scope: ScopeId): void;      // keeps the query, re-activates and re-queries
  close(options?: { silent?: boolean; notify?: boolean }): void;
  // every close path ends here; notify (default true) calls onClose. The InputRouter
  // passes notify: false when it is itself switching to another mode (Leader, Cmd+Shift+K).
  handleKey(e: KeyboardEvent): boolean;
}
```

No Rust or Tauri command changes: `quick_search_warm_root`, `quick_search_query`,
`quick_grep_query` and `quick_search_record_pick` are reused as they are.

### Data Flow

```
1. Cmd+O → router: palette hidden → force-exit Selection/Hint/PromptDialog/InlineAI/QuickOverview
   → palette.open('files') → setMode(SearchPalette).
2. open: clear input → play command_palette.open → scope.activate() → query('') → render
   (files: frecency list; commands: Context section + all actions; grep: "type a query").
3. Typing: 16 ms debounce → ++queryToken → active scope.query(q) → drop stale → render rows + status.
4. Tab → switchTo(next) → same query text → activate + query. Selection resets to row 0.
5. Enter → scope.accept(row, 'primary', ctl): action → play execute, close, flashAck, run the
   action; file/grep → play execute, close, openInHelixTab, record_pick. Ctrl+E / Cmd+Enter →
   copy, play execute, flash 80 ms, close (files/grep only).
6. Every close (Esc, accept, row click, backdrop click, toggle shortcut) → close() → onClose
   → router.exitSearchPalette() → toNormal().
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+Shift+P` | Anywhere | Open on Commands. While open: close if Commands is active, otherwise switch to Commands |
| `Cmd+O` | Anywhere | Open on Files. While open: close if Files is active, otherwise switch to Files |
| `Tab` / `Shift+Tab` | Palette | Next / previous tab, wrapping around (Commands → Files → Grep) |
| `↑` `↓`, `Ctrl+N` / `Ctrl+P` | Palette | Move the selection |
| `Enter` | Palette | Primary action: run the command / open in Helix |
| `Ctrl+E` / `Cmd+Enter` | Files, Grep | Copy the relative / absolute path (`path:line:col` for grep) |
| `Alt+1..9` | Palette | Primary action on row *n* |
| `Ctrl+U` | Palette | Clear the query |
| `Esc` | Palette | Close |

`Tab` no longer moves the selection in Commands (see Behavior changes).

### UI Changes

```
.krypton-search-palette (fixed, inset 0, z-index 10002, scrim rgba(0,0,0,.35))
└ __container (600px, max 92vw)
  ├ __tabs   [Commands ⇧⌘P] [Files ⌘O] [Grep]  — active tab: filled background + bottom border
  ├ __input-row  __prompt + input.__input (placeholder from the scope)
  ├ __results (max-height 50vh) — li.__row[.--selected][.--context]; Context header on zero query
  └ __footer  __status (scope status) · __hint (scope hint; flash on copy)
```
- Rows keep today's content per kind:
  - action: icon (spec 0358), category, swatch, highlighted label, key
  - file: highlighted name and parent directory
  - grep: `path:line` and the snippet
- Hovering a row selects it, and clicking it runs the primary action. Before this, a QFS click
  copied the path.
- Colours come from the `--krypton-palette-*` variables.
- The active tab is shown without a left-edge rail (ADR 0027) and without corner brackets.

## Edge Cases

- **Switching tabs while a query is in flight**: the shared token drops the late response, so
  a slow grep never paints over Commands.
- **Files/Grep with no project root, or warm-up fails**: the status shows `error: …`, other
  tabs keep working, and `Tab` still switches.
- **Open in Helix with no focused window**: the status shows `open failed: no focused window`
  and the palette stays open, as today.
- **The focused view changes while the palette is open**: the Context section is rebuilt on
  every Commands `activate()`, so switching back to Commands refreshes it.
- **Leader (`Cmd+P`) or `Cmd+Shift+K` while open**: both close the palette through `close()`
  before changing mode. Leader already does this for QuickOverview (`input-router.ts:463`).
- **Quick Terminal visible**: Files/Grep resolve the root from the Quick Terminal cwd
  (`getFocusedWorkingDirectory`), as today.

## Out of Scope

- An "All" tab, prefix modes, new scopes (symbols, tabs or windows, Git), and a dedicated
  shortcut for Grep.
- Fixing the grep byte-offset highlight on non-ASCII lines (fixed right after, as a
  separate bug fix recorded in spec 0068's Grep mode section), and the unparsed
  `[keybindings] command_palette` config key.
- Changes to `fff-search` ranking, the Rust commands, or theme schema.

## Resources

- [IntelliJ IDEA — Search everywhere](https://www.jetbrains.com/help/idea/2024.1/searching-everywhere.html):
  tabs, `Tab` to switch scope, per-scope shortcuts.
- [Command palette & search patterns in desktop apps](https://github.com/PeterBlenessy/notesage/blob/main/docs/research/command-palette-patterns.md):
  VS Code prefix modes, the Obsidian Better Command Palette plugin, Raycast mixed ranking.
- [VS Code command palette notes](http://www.iwantcoding.com/vscode/palette):
  `Ctrl+Shift+P` opens Quick Open with `>`.
