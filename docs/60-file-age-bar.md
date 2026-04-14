# File Age Bar — Implementation Spec

> Status: Implemented
> Date: 2026-04-14
> Milestone: M8 — Polish

## Problem

In the file manager, all files look the same age. There's no visual signal for which files were recently modified vs. stale. Users scanning a directory can't quickly spot active files without sorting by date and reading timestamps.

## Solution

Add a small inline heat-bar to each row in the file list. The bar's **fill width** and **color** encode how recently the file was modified relative to the other entries in the current directory. Recent files glow hot (amber/bright), old files fade cool (dim). No extra columns or toggles — the bar is always visible, compact, and ambient.

## Research

- `FileEntry.modified` is already a Unix timestamp (seconds) returned by the Rust `list_directory` command — no backend changes needed.
- The file list row is flexbox: `mark | icon | name (flex:1) | size`. The age bar slots between name and size as a fixed-width element.
- `eza` has `--color-scale age` which tints the entire line. VS Code Heatmap extension uses scrollbar color bands. Git-heatmap tools use rectangle intensity. None use a discrete inline bar per row — this is a novel UI element.
- The amber phosphor palette (`--fm-amber`, `--fm-amber-dim`, `--fm-amber-bright`) already exists in the file manager CSS.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| eza | `--color-scale age` tints entire row by modification recency | Subtle, but loses specificity when many files cluster |
| VS Code Heatmap | Scrollbar lane colored by line age | Not per-file, more for code editing |
| GitHub | "3 days ago" text label per file row | Text-only, no visual encoding |
| ranger/nnn/yazi | mtime in status bar or optional column | Date text, no heat visualization |

**Krypton delta** — No existing tool uses an inline heat bar per row. This gives instant visual scanning without reading text. Matches the cyberpunk aesthetic (glowing bars) and keyboard-first ethos (ambient info, no interaction needed).

## Affected Files

| File | Change |
|------|--------|
| `src/file-manager.ts` | Add age bar DOM element in `renderList()`, compute min/max mtime range |
| `src/styles/file-manager.css` | Add `.krypton-file-manager__age-bar` and `__age-fill` styles |

## Design

### Age Calculation

Compare each file's `modified` timestamp against the min and max in the current directory listing. This gives a 0–1 **recency score** where 1 = newest file, 0 = oldest file.

```typescript
// In renderList(), before the row loop:
let minMod = Infinity, maxMod = -Infinity;
for (const e of this.filteredEntries) {
  if (e.modified > 0) {
    if (e.modified < minMod) minMod = e.modified;
    if (e.modified > maxMod) maxMod = e.modified;
  }
}
const ageRange = maxMod - minMod;

// Per row:
const recency = ageRange > 0 ? (entry.modified - minMod) / ageRange : 0.5;
```

### DOM Structure (per row)

```
mark | icon | name | age-bar | size
                      └── age-fill (inner bar, width = f(recency))
```

The `age-bar` is a fixed-width container (40px). The `age-fill` is an inner element whose width (10%–100%) and opacity (0.25–1.0) scale with recency.

### CSS

```css
.krypton-file-manager__age-bar {
  flex-shrink: 0;
  width: 40px;
  height: 4px;
  margin: 0 8px;
  background: rgba(var(--fm-amber-rgb), 0.06);
  border-radius: 1px;
  overflow: hidden;
  align-self: center;
}

.krypton-file-manager__age-fill {
  height: 100%;
  background: var(--fm-amber);
  border-radius: 1px;
  transition: width 0.2s ease;
}
```

Cursor row gets a brighter fill via existing `__item--cursor` nesting.

### Visual Encoding

| Recency | Fill Width | Opacity | Visual |
|---------|-----------|---------|--------|
| Newest (1.0) | 100% | 1.0 | Full bright amber bar |
| Recent (0.7) | 73% | 0.78 | Most of the bar, warm |
| Middle (0.5) | 55% | 0.63 | Half bar, moderate |
| Old (0.2) | 28% | 0.40 | Short dim bar |
| Oldest (0.0) | 10% | 0.25 | Tiny ghost bar |

Formula: `width = 10 + recency * 90` (percent), `opacity = 0.25 + recency * 0.75`.

### Edge Cases

- **All files same mtime** (`ageRange === 0`): Show uniform 50% bar for all entries.
- **Single file**: Same as above — 50% bar.
- **`modified === 0`** (stat failed): Show empty bar container (no fill).
- **Directories**: Show age bar for directories too — they have valid mtimes and it's useful to see which dirs were recently touched.

## Out of Scope

- Absolute date display or "3 days ago" text labels (could be added to status bar later).
- Git-aware age (last commit vs. filesystem mtime).
- Keybinding to toggle the age bar on/off.
- Color gradient (e.g., green→yellow→red). Keeping single-color amber to match the phosphor theme.

## Resources

- [eza `--color-scale` docs](https://github.com/eza-community/eza) — color-scale age feature reference
- [VS Code Heatmap extension](https://github.com/chrisjdavies/vscode-heatmap) — scrollbar age coloring approach
- Krypton `src/file-manager.ts` lines 26-35 (FileEntry), 985-1063 (renderList)
- Krypton `src-tauri/src/commands.rs` lines 670-675 (mtime extraction)
