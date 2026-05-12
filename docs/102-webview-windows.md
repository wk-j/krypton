# Webview Windows — Implementation Spec

> Status: Implemented
> Date: 2026-05-11
> Milestone: M3 — Compositor & Windows (extension)

## Problem

Krypton has no way to view a web page inside the app. URLs in vault notes, terminal output, and markdown views currently shell out to the system browser via `open_url`, which breaks the keyboard-driven workflow: the user loses focus, has to manage windows in another app, and cannot tile a page next to a terminal or note. The vault view drops external links entirely. We want web pages as a first-class content type — openable in any pane, tiled with terminals/agents/notes, and controlled by the same keyboard model as the rest of the app.

## Solution

Add a `webview` content type alongside the existing `terminal | diff | markdown | agent | acp | acp_harness | context | file_manager | vault | hurl | pencil` set, implemented as a new `WebviewContentView` that hosts a Tauri v2 child `Webview` (the `add_child` API, behind the `unstable` feature flag). The child webview is positioned to match the pane's content rect, with Krypton's cyberpunk chrome rendered in DOM *around* it (titlebar, corner accents, glow). An injected bridge script forwards leader chords (`Cmd+P`, `Cmd+1..9`, `Cmd+W`) back to the host so the compositor stays reachable while the webview has focus. Webviews are hidden whenever their pane is not visible (other workspace, other tab, command palette / dashboard / hint overlays open) — required because native child views always render above DOM on macOS.

## Research

**Krypton architecture (verified by code reading):**
- Window kind is NOT a compositor concern — `KryptonWindow` is structurally uniform (`src/types.ts:187`); discrimination lives in `Pane.contentView: ContentView` (`src/types.ts:156`) and the `PaneContentType` string union (`src/types.ts:110`).
- Adding a new content type is a frontend-only change to the compositor pattern: write a class implementing the `ContentView` interface (`src/types.ts:138–153`), and call `compositor.createContentTab(title, view)` (`src/compositor.ts:3340`).
- `open_url` Rust handler is at `src-tauri/src/commands.rs:128–130`, uses the `open` crate. We keep it as a fallback / Shift-modifier path.
- Layout engine (`src/compositor.ts:4347`) is uniform across kinds — webview panes are laid out by the same code, no branches needed.
- Input router delegates to `pane.contentView.onKeyDown(e)` (`src/input-router.ts:557`) — no per-kind branching needed in the router.

**Tauri v2 child webviews (verified against docs.rs/tauri and GitHub):**
- API: `Window::add_child(WebviewBuilder, LogicalPosition, LogicalSize) -> Result<Webview>` — requires `tauri = { features = ["unstable"] }`.
- Z-order: child webviews are native subviews (NSView on macOS) — they render **above all host DOM** unconditionally. DOM chrome must inset around the webview rect; overlays that need to cover the webview must call `webview.hide()`.
- Transparency on macOS: `WebviewBuilder::transparent` and `background_color` are **documented as "Not implemented" on macOS/iOS** — webview rects will be opaque. Acceptable since chrome surrounds rather than overlays.
- Bounds updates: `set_bounds(Rect)` is atomic (one IPC hop) and usable per-frame for resize tracking via `ResizeObserver`.
- Keyboard focus: when the webview has focus, key events go to the webview's JS, not the host. No native `customKeyHandler`. Forward chords via `WebviewBuilder::initialization_script` that listens for specific modifiers and calls `__TAURI_INTERNALS__.invoke('forward_chord', {...})`.
- Events available: `on_navigation`, `on_page_load(Started|Finished)`. No native `on_title_changed` — implement via injected `MutationObserver` on `document.title`.
- No native `go_back` / `go_forward` on the Rust `Webview` — use `webview.eval("history.back()")`.
- Known macOS gotcha: `accept_first_mouse(true)` lets unfocused Krypton windows receive clicks on the webview without a focus-then-click cycle.

**Alternatives considered:**
- *Iframe instead of Tauri child webview.* Rejected — most external sites set `X-Frame-Options: DENY` or CSP `frame-ancestors`, so iframe-based browsing is useless for arbitrary URLs. The DOM-z-order and transparency wins don't compensate for being unable to load most pages.
- *Tauri `WebviewWindow` (separate OS window).* Rejected — violates the architecture constraint "single native window: all windows are DOM elements; never create additional OS/Tauri windows" (CLAUDE.md).
- *Headless render to texture (`evaluate` + screenshot).* Rejected — no interaction.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| iTerm2 3.5 | Built-in Web Browser tab type via WKWebView. `Cmd+T` opens a browser tab, `Cmd+L` focuses address bar. Tab nav (`Cmd+Shift+[`/`]`, `Cmd+1..9`) intercepted at NSView layer so keys reach iTerm above WKWebView. |
| VS Code Simple Browser | Webview panel (Electron iframe). Lives alongside editors in groups/splits. Cmd palette, `Cmd+W`, group switches always reach VS Code because the iframe is a separate origin. |
| Nova (Panic) | WKWebView Preview sidebar, toggled with `Ctrl+Cmd+P`. Standard macOS focus chord nav escapes. |
| Obsidian | Electron `<webview>` via community plugins; host re-injects keymap listener so `Cmd+P` (palette) and `Esc → Cmd+E` work. |
| WezTerm / Kitty | No embedded webview — URL hints open in system browser only. |
| Warp | No general browser; URLs cmd+click out to system. |
| tmux / Zellij / Helix | Pure TTY — URLs are text; users pipe to `pbcopy` / `xdg-open` or use `gx`-style external preview plugins. |

**Krypton delta:** Matches iTerm2/VS Code/Nova in offering an in-app webview pane reachable by keyboard, and follows the universal escape-hatch convention (`Cmd+P` returns to compositor mode — already Krypton's leader). Deliberately diverges by treating webview panes as **first-class compositor panes** with the same tile/swap/move/resize bindings as terminals and agents — no app on the list (including iTerm2) does this. Also adopts the kitty-style hint convention (`f` to open URL hints) with a modifier (`Shift`) toggling system browser vs in-app webview.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `"unstable"` to the `tauri` features list. |
| `src-tauri/src/lib.rs` | Register new commands; install global event subscriptions for webview events. |
| `src-tauri/src/webview.rs` *(new)* | Webview registry (`HashMap<WebviewId, Webview>`), spawn/navigate/resize/close/hide/show/back/forward/reload commands, bridge-script generation, MutationObserver injection for title. |
| `src-tauri/src/commands.rs` | Optional helper `open_url_with_choice(url, in_app: bool)` — if `in_app`, route to webview spawn instead of `open::that`. |
| `src/types.ts` | Add `'webview'` to `PaneContentType`; export `WebviewState` interface. |
| `src/webview-view.ts` *(new)* | `WebviewContentView implements ContentView`. Owns address bar DOM, manages backend webview lifecycle, syncs bounds via `ResizeObserver`, handles loading/title/nav events, implements `onKeyDown` for `Cmd+L` (focus address bar), `Cmd+R` (reload), `Cmd+[`/`Cmd+]` (back/forward). |
| `src/compositor.ts` | Add `openWebview(url, opts)` method; hide all visible webviews on workspace switch, command palette open, dashboard open, hint mode open (call `compositor.suspendWebviews()` / `resumeWebviews()`). |
| `src/vault-view.ts` | `vault-view.ts:485` — handle `href.includes('://')` branch: call `compositor.openWebview(href)` instead of dropping the click. |
| `src/markdown-view.ts` | `markdown-view.ts:187` and `:952` — replace `invoke('open_url')` with `compositor.openWebview(href)` when in-app default; keep `open_url` for Shift-modifier path. |
| `src/hints.ts` | `hints.ts:657` — same change as markdown-view; `Shift+<hint>` keeps system-browser behavior. |
| `src/command-palette.ts` | Add `:open <url>` (and alias `:webview <url>`) command that calls `compositor.openWebview`. |
| `src/krypton.css` | `.krypton-webview-view` chrome (address bar, loading bar, favicon area), inset-aware styling so chrome surrounds the native webview rect. |
| `docs/PROGRESS.md` | Add "Webview windows" line under M3. |
| `docs/04-architecture.md` | Note `webview` content type and the "native child renders above DOM" constraint. |
| `docs/06-configuration.md` | Document new `[webview]` config table. |

## Design

### Data Structures

```ts
// src/types.ts — added to PaneContentType union
export type PaneContentType = '…' | 'webview';

export interface WebviewState {
  id: WebviewId;            // unique within the session
  url: string;              // current URL (post-navigation)
  pendingUrl: string | null;// what we asked for, before page commits
  title: string;            // last title from MutationObserver
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type WebviewId = number;
```

```rust
// src-tauri/src/webview.rs
pub struct WebviewRegistry {
    next_id: AtomicU32,
    entries: RwLock<HashMap<u32, WebviewEntry>>,
}
struct WebviewEntry {
    webview: tauri::Webview,
    label: String,
    visible: bool,
}
```

### API / Commands

**Tauri commands:**
- `spawn_webview(url: String, x: f64, y: f64, w: f64, h: f64) -> Result<u32, String>` — async, returns `webview_id`.
- `navigate_webview(id: u32, url: String) -> Result<(), String>`
- `resize_webview(id: u32, x: f64, y: f64, w: f64, h: f64) -> Result<(), String>`
- `close_webview(id: u32) -> Result<(), String>`
- `set_webview_visible(id: u32, visible: bool) -> Result<(), String>` — toggles `webview.hide()` / `webview.show()`.
- `webview_back(id: u32) -> Result<(), String>` — uses `webview.eval("history.back()")`.
- `webview_forward(id: u32) -> Result<(), String>`
- `webview_reload(id: u32) -> Result<(), String>`
- `forward_chord(key: String, mods: u32)` — invoked BY the injected bridge script from inside the child webview; the host re-dispatches the chord into the input router.

**Events (Rust → frontend):**
- `webview-loading` `{ id, started: bool }` — from `on_page_load`.
- `webview-navigated` `{ id, url, can_go_back, can_go_forward }` — from `on_navigation` + post-load `eval` reading `history.length`.
- `webview-title` `{ id, title }` — posted by the injected MutationObserver via IPC.

### Bridge / initialization script

Injected via `WebviewBuilder::initialization_script`:

```js
(function () {
  const tauri = window.__TAURI_INTERNALS__;

  // Forward leader and host chords back to the compositor.
  const HOST_CHORDS = new Set(['p', 'l', 'w', '1','2','3','4','5','6','7','8','9']);
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && HOST_CHORDS.has(e.key.toLowerCase())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      tauri.invoke('forward_chord', {
        key: e.key.toLowerCase(),
        mods: (e.metaKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.ctrlKey ? 8 : 0),
      });
    }
  }, true);

  // Title change → host
  const titleObserver = new MutationObserver(() => {
    tauri.invoke('forward_title', { title: document.title });
  });
  // wait until <title> exists
  const start = () => {
    const titleEl = document.querySelector('title');
    if (titleEl) titleObserver.observe(titleEl, { childList: true });
    else setTimeout(start, 50);
  };
  start();
})();
```

The `forward_chord` Rust command resolves the originating webview by tag/label, looks up the owning pane, focuses that pane (un-focusing the webview by emitting a `host-take-focus` event), then dispatches the chord into the input router via a new `chord-from-webview` event.

### Data Flow

**Opening a URL from a vault external link:**
```
1. User Enter/clicks link in vault — vault-view.ts:485 sees `://` in href
2. vault-view.ts → compositor.openWebview(href, { whereTo: 'newTabInCurrentWindow' })
3. compositor creates a Pane with new WebviewContentView
4. WebviewContentView mounts:
   a. Renders DOM chrome (address bar, status row) into pane element
   b. Reads pane content rect via getBoundingClientRect
   c. Calls invoke('spawn_webview', { url, x, y, w, h })
   d. Stores returned webview_id
5. Backend: webview.rs creates child webview via Window::add_child with bridge script,
   on_navigation → emit 'webview-navigated', on_page_load → emit 'webview-loading'
6. WebviewContentView listens via Tauri event API, updates address bar + loading state
7. ResizeObserver on pane element → invoke('resize_webview') on each change (debounced 16ms)
```

**Workspace switch hides webview:**
```
1. User Cmd+1..9 → compositor.switchWorkspace(n)
2. compositor.suspendWebviews() iterates visible WebviewContentView instances,
   calls invoke('set_webview_visible', { id, visible: false })
3. After workspace switch settles, compositor.resumeWebviews() shows the ones
   whose panes are now visible
```

**Leader key from inside webview:**
```
1. User in focused webview pane presses Cmd+P
2. Bridge script catches it, preventDefault, invoke('forward_chord', { key: 'p', mods: 1 })
3. Rust handler emits 'host-take-focus' on main window; main window calls .set_focus()
4. Rust emits 'chord-from-webview' event with { key, mods }
5. Frontend input-router receives event, dispatches into normal chord handling pipeline
6. Compositor mode entered as if Cmd+P was pressed normally
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `f` | Hint mode (existing) | URL hints — `<hint>` opens in webview pane, `Shift+<hint>` opens in system browser |
| `Cmd+L` | Webview pane focused | Focus address bar in chrome |
| `Cmd+R` | Webview pane focused | Reload |
| `Cmd+[` / `Cmd+]` | Webview pane focused | Back / forward |
| `Cmd+P` | Webview pane focused | Compositor mode (via bridge script) |
| `Cmd+1..9` | Webview pane focused | Switch workspace (via bridge script) |
| `Esc` | Address bar editing | Cancel address-bar edit, return focus to webview |
| `Enter` | Address bar editing | Navigate to typed URL |

Command palette (`:open <url>` or `:webview <url>`) spawns a webview pane in the current window.

### In-Page Keyboard Navigation (Vimium-style)

Status: Implemented. The bridge script lives in `src-tauri/src/webview_bridge.js` (loaded into `bridge_script` via `include_str!` with a `__KRYPTON_ID__` placeholder for the runtime id) and contains a self-contained Vimium-lite layer that runs entirely inside each child webview, so no extra IPC round-trip is needed for the common case (scroll, hint).

| Key | Context | Action |
|-----|---------|--------|
| `j` / `k` | Webview body focused, not editable | Scroll down / up (60px step) |
| `d` / `u` | Webview body focused, not editable | Half-page down / up |
| `g g` | Webview body focused, not editable | Scroll to top |
| `Shift+G` | Webview body focused, not editable | Scroll to bottom |
| `h` / `l` | Webview body focused, not editable | Scroll left / right (rarely needed but cheap) |
| `f` | Webview body focused, not editable | Enter in-page hint mode: overlay labels on every clickable target in the viewport |
| `Shift+F` | In-page hint mode | Open the chosen link in a new webview pane (forwards URL to host) |
| `/` | Webview body focused, not editable | Find-in-page (uses `window.find()`); `n`/`Shift+N` jump between matches |
| `Esc` | In-page hint or find mode | Cancel |
| `i` | Webview body focused | "Insert mode" — temporarily disable Vimium-lite until next click outside an input or `Esc` |

**Targets discovered for hint mode:** `a[href]`, `button`, `[role=button]`, `input:not([type=hidden])`, `select`, `textarea`, `[contenteditable]`, `[onclick]`, plus any element with a non-default `cursor: pointer` computed style. Filter to elements that intersect the viewport and have non-zero size (rejects `display: none` and 0×0 anchors).

**Label generation:** sequence `a, s, d, f, j, k, l, w, e, r, c, m, v, t, ...`, switching to two-letter combinations after the home row is exhausted. Bias single-letter labels toward the most prominent elements (largest area inside the viewport) so the common case stays single-key.

**Editable detection (gates all bindings above except Esc):** active element is `<input>`, `<textarea>`, `[contenteditable]`, or inside an iframe whose origin we can't introspect. When detection is ambiguous, default to "editable" so we never swallow text input.

**Why not reuse Krypton's host hint mode (`Cmd+Shift+H`):** the host hint mode scans the host DOM, which has zero knowledge of the child webview's content. Doing it inside the webview's JS context is the only way to label arbitrary page elements. The host hint mode and `Cmd+Shift+H` still work from outside the webview for navigating across panes.

**Forwarding hint actions back to the host:** when the user presses `Shift+F` on a hint, the bridge script extracts `target.href` and invokes a new `forward_action` command with `{ kind: "open_url", url, where: "new_pane" }`. The Rust handler emits a `webview-action` event that `WebviewContentView` (or the compositor, for `where: "new_pane"`) handles. Default click (`f`-mode without Shift) stays inside the webview by calling `target.click()`.

**Iframes / cross-origin content:** the bridge script can't reach inside cross-origin iframes (same-origin iframes are fine via recursive descent). Sites that render heavy iframe content (e.g., embedded comment widgets) won't have those targets hinted. Documented limitation; user can `Cmd+L` and edit the URL manually, or use the address bar.

**Current defaults (hardcoded; config block is future work):**

| Constant | Value |
|----------|-------|
| `SCROLL_STEP` | `60` px |
| `HALF_PAGE` | `0.5` × `innerHeight` |
| `HINT_CHARS` | `asdfgjklqweruiopzxcvbnm` |

The host receives no events for the keys above unless the action explicitly invokes one (`Shift+F` → `forward_action` IPC → `webview-action` event → `compositor.openWebview(url)`). Steady-state cost is one capture-phase `keydown` listener and one `MutationObserver` per webview.

### UI Changes

New DOM under each webview pane:
```
.krypton-pane[data-content="webview"]
  .krypton-webview-view
    .krypton-webview-chrome
      .krypton-webview-nav (back / forward / reload buttons — keyboard hints)
      .krypton-webview-url (address bar input, glowing border)
      .krypton-webview-status (loading dot, security indicator)
    .krypton-webview-host  ← native webview is sized over this rect; element stays empty
    .krypton-webview-loading-bar  ← thin animated bar above host while loading
```

The chrome occupies the top ~28px of the pane content area; `.krypton-webview-host` fills the remaining rect and is what we measure with `ResizeObserver`. Cyberpunk styling matches existing panes (`/cyberpunk-aesthetic` skill conventions): corner accents on the outer pane, neon green/cyan border per theme accent, scanline overlay omitted inside the host area (no DOM there).

### Configuration

```toml
[webview]
# What happens when an external URL is opened by the user
# Values: "in_app" (default) | "system" | "ask"
default_target = "in_app"

# Where new webview panes go when triggered from another window
# Values: "new_tab" (default — same window) | "new_window" (new compositor window)
new_pane_target = "new_tab"

# Default search engine used when user types non-URL into address bar
search_url = "https://duckduckgo.com/?q=%s"

# Per-host blocklist (e.g. for sites that misbehave when embedded) — fall back to system browser
deny_in_app = ["accounts.google.com"]
```

## Edge Cases

- **Page denies embedding via `X-Frame-Options`/CSP:** child Tauri webviews are not iframes, so these headers do NOT block loading. Confirmed by Tauri docs (it's a top-level browsing context).
- **Webview pane not currently visible** (other workspace / other tab / behind command palette): `set_webview_visible(false)` — required because native child views render above DOM.
- **Animations / window drag / layout transitions:** during a transition, mark webviews as hidden; show again on completion (per memory `feedback_no_layered_ui.md` and the existing animation suspension pattern). Bounds are NOT updated per-animation-frame.
- **Multiple workspaces with webviews:** each child webview persists on the single main window; `set_webview_visible` is the only thing that changes per workspace. Memory cost is per-page, not per-workspace.
- **Page that focuses an `<input>` on load:** doesn't matter — host bridge script captures the leader chord in the bubble path with `capture: true` and `stopImmediatePropagation`.
- **Process crash inside a child webview:** Tauri emits an error; webview-view.ts shows an error state with `[r] reload` hint.
- **Closing the pane:** must `invoke('close_webview', { id })` in `WebviewContentView.dispose()`, otherwise the native subview leaks.
- **Theme reload:** child webviews don't inherit `:root` CSS vars from the host. Chrome around the webview re-themes via the existing theme system; the webview content itself is not themed. Documented limitation.
- **Address bar input that isn't a URL:** treat as query, navigate to `config.webview.search_url` with `%s` replaced.
- **Reentry to vault link clicks:** existing `event.preventDefault()` on internal-link handling stays; the external-link branch adds its own `preventDefault`.

## Open Questions

None — all design decisions resolved. Defaults are config-overridable, so user can revisit per preference.

## Out of Scope

- **Browser extensions / ad-blocking / userscripts.** Future work.
- **Persistent cookie store / login session sync across webviews.** Each child webview uses Tauri's default per-app cookie store; per-site profiles are out of scope.
- **Devtools shortcut.** May be added later once we know which webviews should permit it.
- **Reader mode / "save page as markdown to vault".** Tempting integration but a separate feature.
- **Web inspector / network panel inside Krypton chrome.** Use system devtools instead.
- **PDF rendering** beyond what WKWebView natively supports.
- **Drag-and-drop of URLs across panes.** Mouse-first; defer.

## Resources

- [Tauri `WebviewBuilder` (docs.rs)](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html) — `add_child`, `initialization_script`, `on_navigation`, `on_page_load` signatures.
- [Tauri `Webview` (docs.rs)](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html) — `set_bounds`, `navigate`, `eval`, `hide`, `show`.
- [Tauri `Window` (docs.rs)](https://docs.rs/tauri/latest/tauri/window/struct.Window.html) — `add_child`, focus management.
- [tauri#10079 — child webview feature](https://github.com/tauri-apps/tauri/issues/10079) — original feature request + example code.
- [tauri#9798 — z-order on Windows](https://github.com/tauri-apps/tauri/issues/9798) — confirms native subview z-order above DOM.
- [tauri-apps#10264 (discussion) — managing multi webviews](https://github.com/orgs/tauri-apps/discussions/10264) — close/resize patterns.
- [iTerm2 documentation browser](https://iterm2.com/documentation-browser.html) — escape-hatch UX (`Cmd+L`, tab chord intercept at NSView layer).
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview) — Simple Browser pattern, why command palette always works.
- [kitty hints](https://sw.kovidgoyal.net/kitty/kittens/hints/) — hint-mode + `open_url_with` convention.
- Krypton internal: `CLAUDE.md` (single-native-window constraint, platform gotchas: no `backdrop-filter`, transparent body), `docs/04-architecture.md`, `docs/05-data-flow.md`, `src/compositor.ts:3340` (createContentTab), `src/types.ts:138` (ContentView interface), `src-tauri/src/commands.rs:128` (existing `open_url`).
