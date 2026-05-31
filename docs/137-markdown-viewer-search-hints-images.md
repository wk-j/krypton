# Markdown Viewer — In-Doc Search, Heading Hints, Image Fix, Focus Indicator, Re-select Guard — Implementation Spec

> Status: Implemented
> Date: 2026-05-31
> Milestone: M8 — Polish

## Problem

The markdown viewer (`docs/39-markdown-viewer.md`) has three gaps for docs-heavy users:

1. **No in-document search.** `/` filters the *file list*, not the rendered content. Long docs can't be searched for a word.
2. **No fast heading jump.** Navigating headings is one-at-a-time (`]` / `[`); jumping to an arbitrary section in a long doc means many keypresses.
3. **Relative images are broken.** `loadFile` injects rendered HTML via `innerHTML` with no `img[src]` rewriting, so `![](./diagram.png)` resolves against the webview origin (not the file's directory) and never loads — despite the spec claiming "file:// URLs for local images".
4. **Focused-panel indicator is invisible.** The active panel (sidebar vs. preview) is only marked by a border-color bump (`0.15`→`0.4`) / a `1px` inset line — too subtle to read at a glance, so the user can't tell whether keystrokes hit the file list or the content.
5. **Re-selecting the current file re-renders it.** `Enter`/`l`/click on the file already shown calls `loadFile` unconditionally — re-fetching, re-rendering, replaying the reveal animation, and resetting scroll to top — even though nothing changed. Jarring; loses the user's scroll position.

## Solution

Three independent, keyboard-first additions that reuse existing viewer subsystems (link-hint engine, mode dispatch in `onKeyDown`, `run_command`):

1. **In-doc search HUD** — `/` while focus=preview opens a transient bottom HUD (vim-style). Live neon-glow highlight on matches, `n`/`N` cycle with a brief flash, `Esc` clears.
2. **`H` heading-hint overlay** — reuses `enterLinkHintMode`'s label engine over `h1`–`h6`; type a label to jump+scroll. Transient overlay only (no persistent TOC panel — respects spec 39's out-of-scope).
3. **Image src rewrite + onerror** — after render, walk `img[src]`, resolve relative paths against the current file's directory, convert to a webview-loadable URL via `convertFileSrc()`, and attach an `onerror` that swaps in a styled `IMG BREACH // <path>` notice.
4. **Strong focused-panel indicator** — a glowing accent bar on the focused panel's inner edge plus a brightened, glowing panel header; the unfocused panel's header dims. Pure CSS on the existing `krypton-md__panel--focused` class (no TS change).
5. **No-op re-selection guard** — `loadFile` early-returns when the requested file is already loaded (unless `force`), so re-selecting the current file just moves focus to the preview without re-fetch/re-animate/scroll-reset. `r` (reload) passes `force: true`.

## Research

- **`onKeyDown` dispatch** (`markdown-view.ts:533`) already routes by `focusPanel` and `linkHintActive`. Search needs a new `searchActive` guard mirroring `linkHintActive`; heading hints reuse the existing `linkHintActive` machinery with a different label→target map.
- **Link-hint engine reuse** — `generateHintLabels(count)` (`:896`) and the `.krypton-md__link-hint` badge CSS (`markdown-view.css:363`) are target-agnostic. Heading hints differ only in (a) the target set (`querySelectorAll('h1..h6')`) and (b) the action (scroll into view vs. follow href). Plan: generalize the hint state to hold a `Map<string, HTMLElement>` + an `onPick(el)` callback, so links and headings share one code path.
- **Block annotation** — `annotateBlocksWithRaw` already tags blocks with `data-startLine`. Search highlights operate on rendered text nodes, independent of this.
- **Image loading constraint (important)** — Inside the Tauri v2 WKWebView, raw `file://` URLs are blocked (the document origin is the custom app protocol, not `file:`). `hints.ts:702` builds a `file://` URL but hands it to `openExternalUrl(..., {external:true})` — that opens the **OS browser**, so it is *not* precedent for in-webview rendering. Two viable in-webview paths:
  - `convertFileSrc(absPath)` from `@tauri-apps/api/core` → returns an `asset://`/`http://asset.localhost` URL the webview can load. Requires enabling `app.security.assetProtocol` with a scope in `tauri.conf.json`. Streams from disk, no memory blow-up. **Chosen.**
  - Rust command returning base64 → `data:` URL (as `prompt-dialog.ts:842` does for screen captures). Rejected: needs a new Rust command and loads full image bytes into the DOM.
- CSP is `null` in `tauri.conf.json` (disabled), so the only gate is the asset-protocol scope.

## Prior Art

| App | In-doc search | Heading jump |
|-----|--------------|-------------|
| Browsers | `Ctrl+F` find-in-page, `Enter`/`Shift+Enter` = n/N, match count | — |
| Vim / less | `/pattern`, `n`/`N`, `?` reverse | — |
| qutebrowser / Vimium | `/` find + `n`/`N`; `f` link hints | `f` over links (no heading-specific) |
| Obsidian | `Ctrl+F` in-note, match count, `Ctrl+G` next | Persistent Outline panel |
| VS Code MD preview | `Ctrl+F` | Persistent outline |

**Krypton delta** — Search matches the universal `/` + `n`/`N` + `Esc` muscle memory, but rendered as a transient bottom HUD with neon match-glow + scanline flash rather than a docked find-bar (cyberpunk, no persistent chrome). Heading jump deliberately diverges from the Obsidian/VS Code *persistent outline panel* (out-of-scope per spec 39) in favor of a transient `H` hint overlay — reusing the link-hint pattern Krypton users already know, zero added panels, zero mouse.

## Affected Files

| File | Change |
|------|--------|
| `src/markdown-view.ts` | Add search HUD state + handlers; generalize hint engine for headings + `H` key; rewrite `img[src]` + `onerror` in `loadFile` |
| `src/styles/markdown-view.css` | Search HUD styles, match-highlight glow, broken-image notice; stronger `--panel--focused` accent bar + header glow; (heading hints reuse `.krypton-md__link-hint`) |
| `src-tauri/tauri.conf.json` | Enable `app.security.assetProtocol` (`enable: true` + scope for the home dir) so `convertFileSrc` URLs load |
| `docs/39-markdown-viewer.md` | Update keybinding table + remove the inaccurate "file:// URLs" image claim; move search/heading-jump out of implicit gaps |

## Design

### Data Structures (in `MarkdownContentView`)

```ts
// Generalized hint engine (replaces link-only fields)
private hintActive = false;
private hintMap: Map<string, HTMLElement> = new Map();   // label → target (link or heading)
private hintBadges: HTMLElement[] = [];
private hintInput = '';
private hintOnPick: ((el: HTMLElement) => void) | null = null;

// In-doc search
private searchActive = false;
private searchHud: HTMLElement | null = null;
private searchInput: HTMLInputElement | null = null;
private searchMatches: HTMLElement[] = [];   // <mark> wrappers
private searchIndex = -1;
```

### Search: approach

- On `/` (preview focus): build/show the HUD, focus its input.
- On input: clear prior marks, walk text nodes under `previewContent` (skip `<pre>`/`<code>`), wrap case-insensitive matches in `<mark class="krypton-md__match">`. Cap at 500 matches (perf). Update `count` label `N matches`.
- `Enter`/`n` → next, `Shift+Enter`/`N` → prev: move `searchIndex`, add `--current` to active mark, `scrollIntoView({block:'center'})`, trigger one-shot scanline flash class.
- `Esc`: unwrap all marks (normalize text), hide HUD, return focus to preview.
- Highlighting uses real DOM `<mark>` wrapping (not CSS) so `n`/`N` can target elements; unwrap restores original text nodes on close/reload.

### Heading hints: approach

`enterHintMode(targets, onPick)` is the shared core (refactored from `enterLinkHintMode`):
- `enterLinkHintMode()` → `enterHintMode(links, el => followLink(el))`
- `enterHeadingHintMode()` → `enterHintMode(headings, el => el.scrollIntoView({block:'start'}))`

`handleHintKey` (renamed from `handleLinkHintKey`) is unchanged except it calls `hintOnPick` on match instead of branching on href.

### Image rewrite (in `loadFile`, after `innerHTML` set, before annotate)

```
1. const dir = dirname(relativePath)            // current file's dir within cwd
2. for each img in previewContent.querySelectorAll('img[src]'):
3.   src = img.getAttribute('src')
4.   skip if src starts with http:// https:// data:
5.   abs = normalize(join(cwd, dir, src))        // reuse navigateToLocalMd's ../ collapse
6.   img.src = convertFileSrc(abs)
7.   img.onerror = () => replace with <span class="krypton-md__img-breach">IMG BREACH // {src}</span>
```

### Keybindings (preview focus)

| Key | Context | Action |
|-----|---------|--------|
| `/` | Preview focused | Open in-doc search HUD |
| `n` / `N` | Search active | Next / previous match |
| `Enter` / `Shift+Enter` | Search HUD input | Next / previous match |
| `Esc` | Search active | Clear search, close HUD |
| `H` | Preview focused | Enter heading-hint overlay |
| `o` / `;` | Preview focused | Link hints (unchanged) |

`n`/`N` only act as search-nav while `searchActive`; otherwise pass through (they are unused in preview today).

### UI Changes

- `.krypton-md__search` — absolute-positioned bottom HUD inside `.krypton-md__preview` (mirrors `.krypton-md__select-indicator` placement): prompt glyph `/`, input, `N matches` counter. Slide-up + fade in (matches AI overlay transition).
- `.krypton-md__match` — match highlight: subtle accent bg + text-shadow glow.
- `.krypton-md__match--current` — stronger glow + brief scanline flash keyframe.
- `.krypton-md__img-breach` — broken-image notice: warning-amber dashed border, monospace label (reuses `--krypton` warning tone from `.krypton-md__truncated`).

### Focused-panel indicator (pure CSS)

`setFocus` already toggles `.krypton-md__panel--focused` on both the sidebar and the preview, so this is CSS-only. Replace the current subtle treatment with:

- **Inner-edge accent bar** — a 3px solid accent bar on the focused panel's inner edge (sidebar: `border-right`; preview: `box-shadow: inset 3px 0 0`), full accent color + a soft outer glow (`box-shadow` accent at ~0.25). Unfocused panel keeps a faint `0.12` hairline.
- **Header brighten** — focused panel's header (`.krypton-md__sidebar-header` / `.krypton-md__preview-header`) goes to full accent color with a `text-shadow` glow; unfocused header dims to ~`0.4` opacity. This gives a second, larger-area cue beyond the edge bar.
- A `0.12s` transition on the bar/header so focus changes feel like a deliberate handoff, not a flicker. (No `backdrop-filter` — platform gotcha.)

### No-op re-selection guard (in `loadFile`)

Add a `force = false` param: `loadFile(relativePath, recordJump = true, force = false)`.

```
at top of loadFile:
  if (!force && relativePath === this.currentLoadedFile) {
    return;   // already shown — caller still moves focus to preview
  }
  ...existing load...
  this.currentLoadedFile = relativePath;
```

- New field `private currentLoadedFile: string | null = null` (don't rely on `previewHeader.textContent` for the comparison, though it stays in sync as today).
- `reloadCurrentFile()` calls `loadFile(file, true, /*force*/ true)` so `r` still re-reads from disk.
- `refreshFileList()` / `navigateJump` / `navigateToLocalMd` unaffected (jumplist has no top-dups; navigating to a *different* file passes the guard). Local-anchor jumps to the *same* file (future `#frag` work) would scroll, not reload — out of scope here.
- Callers (`handleSidebarKey`, click handler) keep their `setFocus('preview')` call, so re-selecting the current file still hands focus to the content pane (the user's intent) without the re-render.

### Configuration

`tauri.conf.json` → `app.security.assetProtocol`:
```json
"assetProtocol": { "enable": true, "scope": ["$HOME/**"] }
```
(Scope kept to home dir; markdown CWDs live under `$HOME`. No new TOML keys.)

## Edge Cases

- **Search in code blocks** — skip `<pre>`/`<code>` text nodes (avoids breaking hljs spans).
- **Search re-entrancy / reload** — unwrap existing marks before re-highlighting and on `loadFile`/`reloadCurrentFile`.
- **Zero matches** — HUD shows `0 matches`; `n`/`N` no-op.
- **Heading hints, 0 headings** — `H` no-ops (same as link hints with 0 links).
- **Image outside scope / missing file** — `onerror` fires → `IMG BREACH` notice; no crash.
- **Absolute-path images (`/foo.png`)** — treated as repo/cwd-absolute? No — only rewrite relative + bare paths; leave `http(s)`/`data:` untouched. A leading-`/` path is resolved against cwd root.
- **Large files** — match cap 500; image rewrite is O(images), negligible.
- **Re-select guard vs. reload** — guard keys off `currentLoadedFile`; `r` passes `force:true` so an on-disk edit is still picked up. Selecting a *different* file always loads.

## Open Questions

None — all resolved during research (image loading via `convertFileSrc` + asset scope; hint engine generalization confirmed reusable).

## Out of Scope

- Persistent TOC / outline panel or file tree (spec 39 out-of-scope, unchanged).
- z-fold headings, frontmatter metadata card, `#anchor` links, live reload, renderer-module dedupe, theme-reactive hljs — deferred to a follow-up batch (noted in this session's recommendations).
- Regex / fuzzy search (literal case-insensitive substring only).
- Search across files (current file only).

## Review (Grok-1, post-implementation)

Adversarial peer review by the Grok-1 lane. Adopted fixes:
- `loadFile` now tears down hint + select mode (not just search) before the `innerHTML` swap — previously pressing `H`/`v` then switching files orphaned badges and left stale mode state pointed at dead DOM.
- `enterHintMode` records each target's prior inline `position` and `exitHintMode` restores it (no permanent `position:relative` side-effect on headings/links).
- Image rewrite strips `?query` / `#fragment` before FS resolution (cache-busters like `diagram.png?v=3` no longer break the path).
- Live search re-highlight is debounced 120ms (`scheduleSearch`), flushed on `Enter` (`flushSearch`) so stepping always sees current matches; the timer is cleared on close/dispose.
- `dispose` cancels reveal animations + the search timer; `openAI` tears down search + hints first (select state is preserved — it feeds `getAIContext`).

Declined (with reason): manual path encoding before `convertFileSrc` (it already percent-encodes — would double-encode); `onerror` duplicate-listener worry (each load rebuilds `innerHTML` → fresh elements + `{once:true}`); re-select guard string fragility (mismatch only causes a harmless redundant reload). Edge cases logged & deferred: wrapped-heading badge offset, Esc→key focus race, selection-crossing-unwrap, symlink realpath.

Escalated to the user: `assetProtocol` scope `$HOME/**` is broad (kept — viewer opens in arbitrary dirs); flagged the scope vs. Rust read-bytes→`data:` tradeoff, plus the pre-existing unsanitized-HTML + null-CSP hole.

## Resources

- [Tauri v2 `convertFileSrc` + asset protocol](https://v2.tauri.app/reference/javascript/api/namespacecore/#convertfilesrc) — chosen mechanism for in-webview local images; requires `app.security.assetProtocol` scope.
- `src/hints.ts:687-703` — existing `file://` + per-segment `encodeURIComponent` path-building (OS-browser only; informed why it's not reusable in-webview).
- `src/prompt-dialog.ts:842` — `data:` URL precedent (the rejected alternative).
- `src/markdown-view.ts` — link-hint engine (`:896`, `:911`, `:946`) and `loadFile` (`:347`) being extended.
