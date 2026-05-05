# Global Hint Mode for DOM Views — Implementation Spec

> Status: Implemented
> Date: 2026-05-05
> Milestone: M8 — Polish

## Problem

Hint mode (`Leader Shift+H`, also `Cmd+Shift+H` global) only works inside terminal panes today (`InputRouter.enterHintMode`, `src/input-router.ts:1094`). When the focused pane hosts a content view — markdown, hurl, vault, diff, pencil, file manager, ACP harness, agent — pressing the binding does nothing useful: `compositor.getActiveTerminal()` returns the underlying focused terminal (or null), so hints either scan the wrong surface or no-op. The user wants the same regex-driven label overlay (`URL` → Open, `path`/`email` → Copy) on every DOM view as well.

## Solution

Split `HintController` into two scanners that share one overlay/keyboard-input lifecycle: the existing **terminal scanner** (xterm buffer + cell-grid positioning) and a new **DOM scanner** (text nodes inside a scan-root + Range-API bounding rects). `InputRouter.enterHintMode` consults `Compositor.getFocusedPane()`: if the pane is a terminal pane, run the terminal scanner; if it has a `contentView`, run the DOM scanner against `contentView.element`. The same `[hints]` regex rules and alphabet apply to both. Activation is `Leader Shift+H` only — the `Cmd+Shift+H` global binding stays terminal-only to avoid colliding with text-input fields inside DOM views (notably the ACP harness composer).

## Research

- `Compositor.getFocusedPane()` returns a `Pane` with `terminal: Terminal | null` and `contentView: ContentView | null` (`src/types.ts:136`). Every non-terminal view mounts as `pane.contentView` with `contentView.element` as the root DOM container. Roots are well-known classes — `.krypton-md`, `.krypton-hurl`, `.krypton-vault`, `.krypton-diff`, `.krypton-pencil`, `.krypton-file-manager`, `.acp-harness`, `.agent-view`. The DOM scanner therefore needs no per-view wiring: a generic `scanDom(rootEl)` covers all of them.
- Dashboards (`src/dashboard.ts:273`) are body-level overlays, not panes. v1 deliberately excludes dashboards from hint mode (out of scope below) — they have their own keyboard model and few inline targets.
- DOM Range API: `document.createRange()` + `range.getClientRects()` returns one rect per visual line for a wrapped match, exactly what we need to position a single label at the start of the match.
- `IntersectionObserver` is overkill for this one-shot scan; a viewport check (`rect.top >= containerRect.top && rect.bottom <= containerRect.bottom + slack`) is simpler and matches the "only visible" requirement.
- `TreeWalker` with `NodeFilter.SHOW_TEXT` is the standard way to enumerate text nodes; we skip text whose parent is `<script>`, `<style>`, an editable element (`input`, `textarea`, `[contenteditable]`), or any element with `aria-hidden="true"`. Editable skip is consistent with the copy-on-select guard from spec 81.
- Krypton's existing terminal hint actions are `Open` (invoke `open_url`), `Copy` (`navigator.clipboard.writeText`), `Paste` (`terminal.paste`). For DOM scans, `Paste` has no terminal target — fall back to `Copy` so configured rules don't crash.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Vimium (browser ext) | `f` / `F` overlays single/multi-char labels on visible interactive elements | Element-based, not regex; Krypton uses regex for parity with terminal hints |
| Surfingkeys | `f` element hints + custom regex hints (`[[`) for arbitrary text | Confirms the regex-over-text pattern is workable in DOM |
| Tridactyl / qutebrowser | Element-based hints with type filters (links, inputs, images) | Same element-based model |
| Rio Terminal | Regex hints over terminal buffer | Direct inspiration for Krypton's existing terminal hint mode |
| WezTerm | `quick-select-args` action over terminal buffer | Terminal-only |
| Hyper | No built-in hint mode | N/A |

**Krypton delta** — Krypton already differs from Vimium by being regex-driven (matches terminal rio-style behavior). Extending the same regex model to DOM views unifies the user mental model: "Leader Shift+H finds the configured patterns wherever I'm looking." No popular app does this app-wide regex hinting because their viewing surfaces are dominated by interactive elements; Krypton's content views are largely read-only render outputs (markdown, vault, diff) where regex-over-text fits well.

## Affected Files

| File | Change |
|------|--------|
| `src/hints.ts` | Add `enterDom(rootEl)`, extract overlay/keyboard logic to be source-agnostic, keep `enter(terminal)` as a thin wrapper |
| `src/input-router.ts` | `enterHintMode` branches on focused pane: terminal path or DOM path; `Cmd+Shift+H` stays terminal-only |
| `src/compositor.ts` | Expose `getFocusedPane()` publicly if it isn't already, so InputRouter can consult `pane.contentView` |
| `src/styles/*.css` | Re-use existing `.krypton-hint-overlay` / `.krypton-hint` styles; verify they're not scoped to terminal containers |
| `docs/PROGRESS.md` | Recent Landing entry after implementation |
| `docs/82-global-hint-mode.md` | This spec |

## Design

### Data Structures

```ts
// src/hints.ts (new internal type)
interface HintTarget {
  /** Container the overlay is appended to and that defines the visible viewport. */
  container: HTMLElement;
  /** The matches found in the current scan, with assigned labels. */
  matches: DomHintMatch[];
}

interface DomHintMatch {
  /** Where to place the label — top-left of the first client rect of the range. */
  x: number; // relative to container
  y: number; // relative to container
  /** The matched text */
  text: string;
  rule: HintRule;
  label: string;
}
```

The existing terminal `HintMatch` keeps row/col semantics for the terminal scanner. Internally the controller holds a discriminated union (`{ kind: 'terminal', matches: HintMatch[] } | { kind: 'dom', matches: DomHintMatch[] }`) and dispatches positioning per kind.

### Public API

```ts
class HintController {
  // Existing — unchanged
  enter(terminal: Terminal): boolean;

  // New — scan a DOM subtree and overlay labels
  enterDom(rootEl: HTMLElement): boolean;

  // Existing — unchanged
  exit(): void;
  handleKey(e: KeyboardEvent): 'continue' | 'exit' | 'selected';
  applyConfig(config: HintsConfig): void;
  onExit(cb: () => void): void;
  get isActive(): boolean;
}
```

### DOM Scanner Algorithm

1. **Resolve container**: take `rootEl`. Compute `containerRect = rootEl.getBoundingClientRect()`.
2. **Walk text nodes**: `document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)`. For each text node:
   - Skip if `parentElement.closest('input, textarea, [contenteditable=""], [contenteditable="true"], script, style, [aria-hidden="true"], .krypton-hint-overlay')` is non-null.
   - Skip if the text node's parent is not visible (`offsetParent === null`).
3. **For each text node + each enabled rule**:
   - Run regex against the node's `textContent`.
   - For every match, build a `Range` over the matched substring via `range.setStart(node, match.index)` / `range.setEnd(node, match.index + match[0].length)`.
   - `range.getClientRects()` — take the first rect (top-left). Skip if rect has zero area.
   - **Visibility filter**: if rect's top is below `containerRect.bottom` or bottom is above `containerRect.top` (clipped out), skip the match.
   - Record `{ x: rect.left - containerRect.left + rootEl.scrollLeft, y: rect.top - containerRect.top + rootEl.scrollTop, ... }`. (Overlay is positioned `absolute` relative to a positioned container; if `rootEl` is not `position: relative`, wrap an overlay sibling with `position: absolute` that uses `viewport`-anchored coordinates instead.)
4. **Apply `stripTrailingPunctuation` and dedup** (reuse existing helpers).
5. **Generate labels** (reuse existing `generateLabels`).
6. **Render overlay**: append `.krypton-hint-overlay` to `rootEl` (or a sibling if positioning gets tricky).

### Positioning details

- The overlay uses `position: absolute`; the parent must be a containing block. Most view roots (`.krypton-md`, `.krypton-hurl`, etc.) already have `position: relative` because the existing CSS uses absolute scrollbars / fixed sub-headers. If a particular root is not positioned, the implementation wraps the scan in:
  ```
  overlay.style.position = 'fixed';
  overlay.style.left = `${containerRect.left}px`;
  overlay.style.top = `${containerRect.top}px`;
  overlay.style.width = `${containerRect.width}px`;
  overlay.style.height = `${containerRect.height}px`;
  ```
  and then label coordinates are viewport-relative. Using `position: fixed` avoids any per-view CSS audit. Initial implementation uses `position: fixed` uniformly.

### Actions in DOM context

| Rule action | Terminal | DOM (new) |
|-------------|----------|-----------|
| Open        | `invoke('open_url', { url })` | identical |
| Copy        | `navigator.clipboard.writeText(text)` | identical |
| Paste       | `terminal.paste(text)` | fallback to Copy + console warning (no terminal target) |

### Input Router Changes

```ts
private enterHintMode(): void {
  const pane = this.compositor.getFocusedPane();
  if (!pane) { this.toNormal(); return; }

  this.compositor.soundEngine.play('hint.activate');

  let found = false;
  if (pane.terminal) {
    found = this.hints.enter(pane.terminal);
  } else if (pane.contentView?.element) {
    found = this.hints.enterDom(pane.contentView.element);
  }

  if (found) this.setMode(Mode.Hint);
  else this.toNormal();
}
```

The global `Cmd+Shift+H` handler (`input-router.ts:515`) stays as-is — it's already gated to focused-terminal context, so DOM views don't accidentally activate it via stray keypresses while their composers/inputs have focus.

### Data Flow

```
1. User presses Leader (Cmd+P) → Compositor mode
2. User presses Shift+H
3. InputRouter.enterHintMode() → Compositor.getFocusedPane()
4. Branch:
   a. Terminal pane → HintController.enter(terminal) → existing flow
   b. Content pane → HintController.enterDom(contentView.element)
      → TreeWalker enumerates text nodes
      → regex per rule; build Ranges; filter visible
      → assign labels; render overlay (position: fixed)
5. Mode = Hint; subsequent keys go to handleHintKey → HintController.handleKey
6. On selection: action fires (Open/Copy/Paste→Copy), exit
```

### Keybindings

No new bindings. The existing `Leader Shift+H` chord is repurposed to dispatch on view kind.

| Key | Context | Action |
|-----|---------|--------|
| `Leader Shift+H` | Any focused pane (terminal or content view) | Enter hint mode against that pane |
| `Cmd+Shift+H` | Focused terminal | Enter hint mode (terminal only — unchanged) |
| `Escape` | Hint mode | Cancel |
| `Backspace` | Hint mode | Erase one typed char |
| Alphabet key | Hint mode | Append to label match |

### UI Changes

- Reuse `.krypton-hint-overlay` and `.krypton-hint` styles. The DOM scanner uses `position: fixed` for the overlay, so it stacks above the view. CSS may need a higher `z-index` on the overlay — verify against ACP harness drawer (`z-index` ~50) and dashboards (~100). Set overlay z-index to `999` to win against in-view layers but stay below modal dialogs.
- No new CSS classes.

### Configuration

None — uses existing `[hints]` config (`alphabet`, `rules`).

## Edge Cases

- **Empty view / no matches** — same `showToast('No hints found')` flow; return to Normal.
- **Match spans multiple text nodes** (e.g., URL split by `<wbr>` or syntax-highlight `<span>`s) — the TreeWalker yields each text node separately, so a single conceptual URL split into spans will not be matched as one unit. v1 accepts this limitation — it matches per-text-node only. Most rendered URLs in markdown/hurl/vault are single text nodes inside an `<a>` or syntax-highlight span.
- **Match inside an `<a>` element** — the action still fires from the rule (`Open` opens the URL); we don't auto-prefer `<a href>` over the regex text in v1.
- **Scroll during hint mode** — overlay uses `position: fixed`; user-scrolling shifts the underlying text but labels stay anchored. The user is expected to either pick a label immediately or `Escape` then re-enter. This matches the existing terminal hint behavior (terminal scrolling also de-syncs hints).
- **View hidden / window resized while in hint mode** — `exit()` clears overlay; the InputRouter already exits hint mode on window/pane focus changes. Verify no leak.
- **Editable surface inside the view** (e.g., ACP harness composer textarea) — `<textarea>` text content is not in the DOM tree, so the scanner skips it naturally. `[contenteditable]` is filtered explicitly.
- **Very large views** (vault with thousands of nodes) — TreeWalker is fast, but regex over every text node may add up. v1 has no cap; if perf becomes an issue, add a `maxMatches` cutoff (e.g. 500).
- **Quick Terminal overlay open** — Quick Terminal is a terminal pane that wins focus; existing `getActiveTerminal()` already handles it. The new `getFocusedPane()` path needs to consider Quick Terminal too — implementation detail: route Quick Terminal through the existing `enter(terminal)` branch first.

## Open Questions

None.

## Out of Scope

- Dashboards (git/opencode dashboards have their own keyboard models)
- Non-pane overlays (command palette, prompt dialog, quick file search) — these are short-lived modals
- Element-based hinting (`<a>`, `<button>`) — regex-only in v1
- Cross-text-node match unification (split-span URLs)
- Per-view rule subsets (e.g., a "Copy block" rule only in markdown)
- Smooth scroll-to-hint when the chosen match is partially clipped — v1 only matches fully-visible

## Resources

- [MDN — TreeWalker](https://developer.mozilla.org/en-US/docs/Web/API/TreeWalker) — text-node enumeration pattern
- [MDN — Range.getClientRects](https://developer.mozilla.org/en-US/docs/Web/API/Range/getClientRects) — per-line bounding rects for matched substrings
- [MDN — Range.setStart / setEnd](https://developer.mozilla.org/en-US/docs/Web/API/Range/setStart) — building a range from text-node offsets
- [Vimium source — vimium_frontend.js link hints](https://github.com/philc/vimium) — element-hinting reference (we deliberately diverge to regex-text)
- [Surfingkeys — hints.js](https://github.com/brookhong/Surfingkeys) — confirms regex-over-text feasibility in modern browsers
- Internal: `src/hints.ts` — terminal scanner reference
- Internal: `src/types.ts:136` — `Pane` type with `terminal` and `contentView` fields
- Internal: `src/copy-on-select.ts` — same editable-element guard pattern
