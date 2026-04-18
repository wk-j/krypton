# Obsidian Vault Window — Implementation Spec

> Status: Approved
> Date: 2026-04-13
> Milestone: N/A — New feature

## Problem

Krypton has no way to browse an Obsidian vault (or any markdown knowledge base with `[[wikilinks]]`). The existing markdown viewer (`MarkdownContentView`) renders single files but lacks vault-aware features: wikilink resolution, backlinks, folder navigation, frontmatter parsing, and graph awareness. Users who work with Obsidian vaults alongside their terminal need a dedicated vault viewer.

## Solution

Create a new `VaultContentView` implementing the existing `ContentView` interface. It gets its own retro-futurism CSS (NASA Mission Control aesthetic) — a self-contained style file scoped to `.krypton-vault`, completely independent from the cyberpunk terminal chrome. No changes to existing CSS. The vault window is spawned via `compositor.createContentWindow()` like other content views.

## Affected Files

| File | Change |
|------|--------|
| `src/vault-view.ts` | **New** — `VaultContentView` class |
| `src/vault-parser.ts` | **New** — wikilink resolver, frontmatter parser, backlink indexer |
| `src/styles/vault-view.css` | **New** — retro-futurism NASA aesthetic, fully self-contained |
| `src/styles/index.css` | Import `vault-view.css` |
| `src/compositor.ts` | Add `openVault(path)` method, register command palette action |
| `src/types.ts` | Add `'vault'` to `PaneContentType` union |
| `src/input-router.ts` | No change — already delegates to `contentView.onKeyDown()` |

## Design

### Data Structures

```typescript
// types.ts — extend union
export type PaneContentType = 'terminal' | 'diff' | 'markdown' | 'agent' | 'context' | 'file_manager' | 'vault';

// vault-parser.ts
interface VaultIndex {
  files: Map<string, VaultFile>;       // path → parsed file
  backlinks: Map<string, string[]>;    // target → [source paths]
  tags: Map<string, string[]>;         // tag → [file paths]
}

interface VaultFile {
  path: string;
  title: string;                       // from frontmatter or filename
  frontmatter: Record<string, unknown>;
  wikilinks: WikiLink[];               // outgoing links
  tags: string[];
  headings: Heading[];
}

interface WikiLink {
  raw: string;          // "[[Page Name]]" or "[[Page Name|Display]]"
  target: string;       // resolved file path
  display: string;      // display text
  lineNumber: number;
}

interface Heading {
  level: number;        // 1-6
  text: string;
  id: string;           // slugified anchor
}
```

```typescript
// vault-view.ts
export class VaultContentView implements ContentView {
  readonly type: PaneContentType = 'vault';
  readonly element: HTMLElement;

  private vaultRoot: string;
  private index: VaultIndex;
  private currentFile: string | null;
  private jumpHistory: string[];
  private sidebarMode: 'files' | 'backlinks' | 'outline';
  private filterText: string;
  private selectedIndex: number;

  constructor(vaultRoot: string);
  onKeyDown(e: KeyboardEvent): boolean;
  dispose(): void;
  onResize(width: number, height: number): void;
  getWorkingDirectory(): string;
}
```

### DOM Structure

```
.krypton-vault (root — retro-futurism scoped)
├── .krypton-vault__sidebar
│   ├── .krypton-vault__sidebar-header
│   │   ├── .krypton-vault__sidebar-title ("VAULT INDEX")
│   │   └── .krypton-vault__sidebar-tabs
│   │       ├── [FILES] [BACKLINKS] [OUTLINE]
│   ├── .krypton-vault__filter
│   │   └── input.krypton-vault__filter-input
│   └── .krypton-vault__sidebar-list
│       └── .krypton-vault__sidebar-item (repeated)
├── .krypton-vault__main
│   ├── .krypton-vault__breadcrumb
│   │   └── vault / folder / filename.md
│   ├── .krypton-vault__content (rendered markdown)
│   └── .krypton-vault__status-bar
│       ├── links: N  backlinks: N  words: N
│       └── .krypton-vault__status-gauge (optional SVG arc)
└── .krypton-vault__ai-overlay (optional, reuse pattern from markdown-view-ai)
```

### Vault Selection

| Key | Context | Action |
|-----|---------|--------|
| `u` | Compositor mode | Open vault (direct if configured, else shows notification) |

**Flow:**

```
1. User presses Cmd+P (leader) → enters Compositor mode
2. User presses u
3. If [vault] paths has 1 entry → open it directly
4. If [vault] paths has 2+ entries → show command palette picker with vault names
5. If no vaults configured → fall back to native folder picker
6. Compositor calls openVault(selectedPath)
7. Auto-returns to Normal mode
```

**Config:**

```toml
# Simple — single default vault (just press v, done)
[vault]
path = "~/notes"

# Multiple vaults — v shows picker
[vault]
paths = [
  { name = "Notes", path = "~/notes" },
  { name = "Work", path = "~/work/docs" },
]
```

Resolution order: if `path` is set, use it directly. If `paths` is set, show picker (or direct if only one). If both, `path` is the default and `paths` populates the picker.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `u` | Compositor mode | Open vault |
| `j/k` | Sidebar focused | Navigate file/backlink/heading list |
| `Enter` or `l` | Sidebar focused | Open selected item |
| `h` | Sidebar focused | Go to parent folder |
| `/` | Any | Open filter |
| `Escape` | Filter active | Close filter |
| `f` | Content focused | Link hint mode (follow wikilinks) |
| `Backspace` or `'` | Content focused | Jump back in history |
| `1` | Any | Switch sidebar to FILES |
| `2` | Any | Switch sidebar to BACKLINKS |
| `3` | Any | Switch sidebar to OUTLINE |
| `g/G` | Content focused | Jump to top/bottom |
| `J/K` | Content focused | Scroll content |
| `Cmd+I` | Any | Toggle AI overlay |
| `V` | Vault focused | Open vault picker to switch to another configured vault in-place |

### Wikilink Resolution

```
1. User opens vault at ~/notes
2. vault-parser scans all .md files (via Tauri readdir + read_file)
3. For each file: extract frontmatter (YAML), wikilinks ([[...]]), tags (#tag), headings
4. Build backlink index: for each wikilink target, record the source file
5. Wikilink resolution: [[Page Name]] → find file matching "page-name.md" (case-insensitive, slug-matched)
6. On click/hint: navigate to resolved file, push current to jumpHistory
```

### Vault Indexing Data Flow

```
1. User triggers "Open Vault" from command palette (or compositor keybind)
2. Compositor calls vault-view.ts constructor with vault root path
3. VaultContentView calls vault-parser.ts buildIndex(vaultRoot)
4. vault-parser invokes Tauri commands to list/read .md files
5. Parser returns VaultIndex (files, backlinks, tags maps)
6. VaultContentView renders sidebar (file tree) and opens README.md or index.md
7. On file select: render markdown, highlight wikilinks, show backlink count in status bar
```

### Retro-Futurism Styling (NASA Mission Control)

The vault window CSS is **fully self-contained** in `vault-view.css`, scoped under `.krypton-vault`. It does NOT modify or depend on cyberpunk CSS. Key visual differences:

| Element | Style |
|---------|-------|
| Background | `rgba(6, 10, 20, 0.65)` deep navy |
| Primary color | `#4fc3f7` sky blue |
| Borders | 1px solid, 2px border-radius, corner bracket decorations |
| Sidebar header | `Orbitron` or monospace, uppercase, 0.2em letter-spacing |
| Content typography | Monospace for code, readable sans-serif for prose |
| Scanlines | Horizontal CRT lines at 0.08 opacity over content |
| Glow | Single-layer subtle phosphor (not multi-layer neon) |
| Status bar | Fixed-width data readouts with unit labels (`LINKS: 12  WORDS: 847`) |
| Active item | Backlit highlight with stepped border, no clip-path |
| Animations | Mechanical stepped transitions, cursor blink, no breathing pulse |
| Scrollbar | Custom thin scrollbar matching sky blue |
| Wikilinks | Underlined with phosphor glow on hover |

### Tauri Commands Needed

```rust
// New commands for vault file access
#[tauri::command]
fn list_vault_files(path: String) -> Result<Vec<VaultFileEntry>, String>;

#[tauri::command]
fn read_vault_file(path: String) -> Result<String, String>;
```

Or reuse existing filesystem access if available via the file manager's backend.

### Configuration

```toml
# Optional: default vault path
[vault]
path = "~/notes"
```

No new config required for MVP — vault path is provided when opening.

## Edge Cases

- **No .md files in directory**: Show empty state with message "No markdown files found"
- **Broken wikilinks**: Render as dim/strikethrough text, don't navigate
- **Circular links**: jumpHistory is a stack, not a graph — no infinite loop risk
- **Large vaults (1000+ files)**: Index lazily — scan directory tree immediately, parse file contents on first open
- **Binary files in vault**: Skip non-.md files in index, show in file tree but don't open in preview
- **Frontmatter parse error**: Skip frontmatter, render file as plain markdown
- **Vault path doesn't exist**: Show error in content area, keep sidebar empty
- **Hot-reload**: Watch vault directory for changes, re-index modified files only

## Migration Checklist

### Phase 1: Scaffolding
- [ ] Add `'vault'` to `PaneContentType` in `types.ts`
- [ ] Create `vault-view.ts` with minimal `VaultContentView` (empty element, stub methods)
- [ ] Create `vault-view.css` with root `.krypton-vault` container
- [ ] Import CSS in `index.css`
- [ ] Add `openVault()` to compositor — spawn window with stub view
- [ ] **Verify**: empty vault window opens, closes, doesn't break terminals

### Phase 2: File listing
- [ ] Implement vault directory scanning (list .md files recursively)
- [ ] Render sidebar file tree with folder grouping
- [ ] Keyboard navigation (j/k/Enter/h)
- [ ] Filter with `/`
- [ ] **Verify**: can browse vault file tree

### Phase 3: Markdown rendering
- [ ] Render selected .md file in content area
- [ ] Parse and render frontmatter as header metadata
- [ ] Scroll with J/K/g/G
- [ ] Jump history (Backspace to go back)
- [ ] **Verify**: can read markdown files with proper formatting

### Phase 4: Wikilink support
- [ ] Parse `[[wikilinks]]` and `[[target|display]]` syntax
- [ ] Resolve links to actual files (case-insensitive slug matching)
- [ ] Render wikilinks as clickable/hintable elements
- [ ] Link hint mode with `f` key
- [ ] **Verify**: can follow wikilinks between files

### Phase 5: Backlink index
- [ ] Build backlink map during indexing
- [ ] Sidebar BACKLINKS tab showing files that link to current file
- [ ] Navigate to backlink source on Enter
- [ ] **Verify**: backlinks are accurate and navigable

### Phase 6: Outline
- [ ] Parse headings from current file
- [ ] Sidebar OUTLINE tab with heading tree
- [ ] Jump to heading on Enter
- [ ] **Verify**: outline reflects current file's structure

### Phase 7: Retro-futurism styling
- [ ] Apply NASA Mission Control palette to `.krypton-vault`
- [ ] Corner bracket decorations on sidebar and content panels
- [ ] CRT scanline overlay on content area
- [ ] Status bar with fixed-width data readouts
- [ ] Phosphor glow on active elements
- [ ] Mechanical animations (stepped transitions)
- [ ] Custom scrollbar
- [ ] **Verify**: vault window looks distinctly retro-futurism while terminals stay cyberpunk

### Phase 8: Polish
- [ ] AI overlay (reuse markdown-view-ai pattern)
- [ ] Command palette integration ("Open Vault")
- [ ] Handle vault path from config `[vault] path`
- [ ] File watcher for vault changes
- [ ] **Verify**: full feature set works, no regressions on terminal windows

## Out of Scope

- Graph view (visual node graph of vault links) — follow-up feature
- Editing markdown files (read-only viewer for now)
- Obsidian plugin compatibility (`.obsidian/` config, community plugins)
- Transclusion (`![[embed]]` syntax) — follow-up
- Canvas files (`.canvas`) — follow-up
- Dataview queries — follow-up
- Tag pages (clicking a tag to see all tagged files) — follow-up but easy to add
