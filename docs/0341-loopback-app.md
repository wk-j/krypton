# Loopback App — One Browser Application with a Home Page and a Shared Kit — Implementation Spec

> Status: Implemented (2026-10-29)
> Date: 2026-10-29
> Milestone: ACP Harness
> Supersedes the per-page shells of specs 168, 170, 171, 185, 186, 192, 198, 211, 223, 227, 253, 288, 313, 329 and 330 (their endpoints and behaviour stay; only the page shell, styling and opening path change)

## Problem

Krypton serves fourteen browser surfaces over loopback, and each one is a separate product: twelve self-contained `src/acp/artifact-*.html` files (7,843 lines) plus a separate Vite app for the GenUI gallery. Each page copies its own token block, header, pills, poll loop and key handler, and the copies have drifted (`.chip` means five different things, three `beacon` variants, `/tools` adds a blue and a purple hue next to the single yellow accent). No page has a way back to the others: only `/commands` and `/tools` carry a nav bar, nothing links to `/timeline`, `/analyses`, `/reviews`, `/journal` or `/genui-gallery`, and the four capability pages cannot be linked at all.

## Solution

Rebuild every loopback page as one application: a single Vite build (`src/loopback/`) with one design-token sheet, one component kit, one app shell present on every page, and a new **Home** page at `/` that lists every surface and is reachable from every page (brand link, switcher). The application stays a set of documents (one per URL) rather than a single-page app, so every existing page URL, bookmark, Krypton opener, server-rendered reader and capability token keeps working (only the two internal asset routes move to `/app/assets/`). Krypton opens pages through a session landing that gives the shell a process-wide **session capability**, so Home and the switcher can also link to Terminal Control, ACP wire, Hurl and E2E.

## Research

- **Every page shares one origin** (`127.0.0.1:<hookPort>`, `hook_server.rs:10210`), so navigation between surfaces is plain same-origin links. The GenUI gallery already proves a Vite browser bundle served from Tauri's embedded `frontendDist` (`frontend_dist_asset`, `hook_server.rs:3758`, exact-key check before `get()`), and Terminal Control already loads a Vite module from a Rust-served page, redirecting to the Vite dev server in debug (`handle_termctrl_asset`, `:3248`).
- **`src/ui` is browser-safe**: no `@tauri-apps` import, already bundled by the GenUI gallery (`main.ts:16`). It is a lifecycle/diff kernel (`Component`, `el`, `reconcile`, `RenderScheduler`, `LayoutHost`), not a widget set — the kit is the missing widget layer on top of it.
- **Three page families need different hosting.** Status walls and tools (dashboard, gallery, commands, tools, timeline, termctrl, acp-wire, hurl, e2e, genui) are static HTML that fetch JSON. Readers (docs, journal, doc, analyses, analysis, reviews, review) are Rust-rendered by string-replacing comment slots in an `include_str!` shell; `/doc` deliberately executes raw HTML/JS from repo markdown (ADR-0010 rev 2). The artifact scaffold is lane-owned file content, not app chrome.
- **Capability tokens** (`termctrl`, `acp-wire`: one per process; `hurl`: per canonical cwd; `e2e`: per project root) are reachable only through Tauri commands. A tokenless Home cannot link them without a new capability.
- **No tokenless listing of projects exists.** `docs_project_dirs()` (`:1582`, in-memory) plus `gallery_project_identity()` (`:7440`, stable `project-<16hex>`) give one; harness ids `hm-N` are per-run.
- **Cookies are not port-isolated** (RFC 6265 §8.5): a cookie for `127.0.0.1` is sent to every local port the browser visits. `localStorage` is origin-scoped including the port, so the session capability lives there.
- **Tests read HTML as text**: `artifact-e2e.test.ts`, `artifact-termctrl.test.ts` and `hash-commands.test.ts` regex out inline scripts; Rust `timeline_page_is_read_only_and_uses_safe_text_rendering` pins ~20 literals. They are replaced by DOM tests of the modules (behaviour) or deleted (source text).
- **Incidental bugs fixed by construction**: `/tools` drops the `timeline` and `e2e` categories (hardcoded `SECTIONS`, `artifact-tools.html:~160`); the `/journal` filter box is dead (script gated on `/docs`, `artifact-docs.html:248`); the debug GenUI page cannot reach `theme.json` (it is redirected to Vite's origin).
- **Alternatives rejected.** *Single-page app*: needs JSON APIs for seven Rust-rendered readers, would stop `/doc`'s raw markdown scripts from running (or run them inside the shell's realm), and moves polling/SSE teardown into a router; loopback document loads are milliseconds, so it buys little. *Iframe dock* (Nuxt DevTools style): keeps fifteen styles, adds focus and URL problems. *Session cookie*: leaks to other local ports (above). *Tokenless Home only*: four surfaces stay unreachable from Home.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Nuxt / Vite DevTools | One dock; each tool registers an entry (`id`, `title`, `icon`, `category`) whose view is an iframe, a launcher, or JSON-rendered | Registry-of-surfaces model adopted; iframe hosting rejected |
| Grafana | Megamenu for levels 1–3, landing page per category, breadcrumbs reflect hierarchy (not history), sentence case | Home is the landing page; shell title shows `Krypton / project / surface`; sentence case |
| JupyterLab | Launcher tab lists every activity as grouped tiles; modal command palette by shortcut | Home groups tiles; the switcher is the palette |
| GitHub | `?` shows shortcuts; `g` + letter jumps to a tab | `?` adopted; `g` is not (Terminal Control and ACP wire bind `g`) |

No terminal emulator ships a companion browser application; this is novel for the category. **Krypton delta:** everything is keyboard-reachable (switcher, `?` help, existing per-page keys), the look stays `DESIGN.binance.md`, and capability surfaces are linked only for a browser Krypton itself opened.

## Affected Files

| File | Change |
|------|--------|
| `src/loopback/entries.json` | New: entry id → TS source path; read by Vite and by Rust (`include_str!`) |
| `src/loopback/styles/{tokens,reset,app}.css` | New: Binance tokens (dark + `auto` light), layer order `lb.reset, lb.base, lb.kit, lb.surface`, one `app.css` that `@import`s every kit/surface sheet |
| `src/loopback/kit/<component>/` | New: kit components (below), each `index.ts` + `.css` (+ `.test.ts` where behaviour is non-trivial) |
| `src/loopback/kit/lib/*.ts` | New: `keymap`, `poller`, `fetch-json`, `format`, `clipboard`, `session`, `nav-context` |
| `src/loopback/surfaces.ts` | New: surface registry (single source for Home tiles, switcher, shell title) |
| `src/loopback/entries/*.ts`, `src/loopback/surfaces/<surface>/` | New: one entry per page; surface views ported from the HTML pages |
| `src-tauri/src/loopback_app.rs` | New: `AppPage` document builder, `/app/assets/*`, session landing, `/app/api/directory`, `/app/api/{token}/capabilities`, `LoopbackSession` |
| `src-tauri/src/hook_server.rs` | Page handlers return `AppPage`; reader renderers return `<main>` bodies; remove 11 HTML consts, `/genui-gallery/assets/*`, `/termctrl/assets/*`; add `/`; update `artifact_routes_do_not_conflict` |
| `src-tauri/src/e2e_web.rs` | `page` returns `AppPage`; remove `E2E_HTML` |
| `src-tauri/src/commands.rs`, `lib.rs` | New command `loopback_url(path)` |
| `src/loopback-open.ts` | New `openLoopback(path)`; replaces ~20 `get_hook_server_port` + `open_url` blocks |
| `src/compositor.ts`, `src/command-palette.ts`, `src/acp/acp-harness-view.ts`, `src/acp/acp-wire.ts`, `src/acp/harness-{timeline,e2e,ticket}-controller.ts`, `src/acp/hash-commands.ts`, `src/acp/components/help-overlay/index.ts` | Openers → `openLoopback`; palette `loopback.home` and `#home` |
| `vite.loopback.config.ts`, `vite.config.ts`, `package.json` | App build of all entries to `dist/app/`; DOM test project includes `src/loopback/**`; drop the GenUI build step |
| Deleted | 12 `src/acp/artifact-*.html`, `genui-gallery/index.html`, `vite.genui-gallery.config.ts`, `src/acp/loopback-cell-grid.ts`, source-text tests |
| Unchanged | `src-tauri/resources/artifact-scaffold.html` (lane-owned), every JSON/SSE/POST endpoint and capability route |
| Docs | `DESIGN.binance.md` (kit catalog, surface table incl. Home/analyses/reviews/journal), `docs/0004`, `docs/0005`, `docs/README.md`, new ADR 0026 (session capability), supersede notes in the specs listed above |

## Design

### Hosting model

Every page is one HTML document that Rust builds; JS and CSS come from the Vite build.

```rust
pub(crate) enum Scheme { Dark, Auto }               // <html data-scheme>
pub(crate) struct AppPage<'a> {
    pub entry: &'a str,             // entries.json key → /app/assets/<entry>.js
    pub title: &'a str,             // html-escaped; "<title> · Krypton"
    pub lang: &'a str,              // "en"; the timeline keeps "th"
    pub scheme: Scheme,
    pub body: Option<String>,       // Rust-rendered <main> content (readers only)
    pub extra_styles: &'a [&'a str],// e.g. ["genui-gallery.css"]
    pub csp: Option<&'a str>,       // GenUI keeps its existing policy; others none, as today
}
pub(crate) fn app_page_response(page: AppPage) -> Response; // html_response headers
```

The document is `<header id="lb-shell"></header><main id="lb-main">{body}</main>` plus `<link href="/app/assets/app.css">` and `<script type="module" src="/app/assets/<entry>.js">`. Pages without a Rust body start with one `<p class="lb-boot">Loading…</p>` that the entry replaces on mount. Readers keep rendering in Rust (comrak, link rewriting, review blocks, path validation all unchanged); only the comment-slot shells go — their content becomes `body`, and the entry hydrates filter, tree scroll, date localisation and the feedback overlay on that markup. Raw HTML in `/doc` still executes, as ADR-0010 rev 2 decided.

`GET /app/assets/{name}` (tokenless, static code):
- **Release:** `frontend_dist_asset("app/<name>")` for `<entry>.js`, `app.css`, `genui-gallery.css` and `chunks/<hash>.js`; names match `[A-Za-z0-9._-]+` with one optional `chunks/` segment; exact-key check, else 404.
- **Debug:** `<entry>.js` → 307 to `http://localhost:1420/<source from entries.json>`; `app.css` and `genui-gallery.css` → 307 to their source sheets (`src/loopback/styles/app.css`, `src/acp/genui-gallery/gallery.css`). `localhost`, not `127.0.0.1` (spec 330's IPv6 finding). The document stays on the loopback origin, so same-origin fetches work in dev too.

Build: `vite.loopback.config.ts` becomes an app build with `rollupOptions.input` = every `entries.json` entry plus a styles entry, `entryFileNames: '[name].js'`, `chunkFileNames: 'chunks/[name]-[hash].js'`, `assetFileNames: '[name][extname]'`, `outDir: dist/app`. `npm run build` = `tsc --noEmit && vite build && vite build --config vite.loopback.config.ts`.

### Surface registry and navigation context

```ts
type SurfaceId = 'home' | 'dashboard' | 'gallery' | 'docs' | 'journal' | 'timeline' | 'analyses'
  | 'reviews' | 'commands' | 'tools' | 'genui' | 'termctrl' | 'acp-wire' | 'hurl' | 'e2e';
interface SurfaceDef {
  readonly id: SurfaceId;
  readonly title: string;                      // sentence case: 'Lane monitor'
  readonly summary: string;                    // one line on the Home tile
  readonly group: 'monitor' | 'project' | 'reference';
  readonly scope: 'global' | 'project';
  readonly access: 'open' | 'capability';
  href(ctx: NavContext): string | null;        // null → tile/entry disabled with a reason
}
interface NavContext {
  readonly directory: Directory;               // GET /app/api/directory
  readonly project: ProjectEntry | null;       // from ?harness=/?project= on this URL, else last pick, else first
  readonly capabilities: Capabilities | null;  // null without a valid session
}
```

Project-scoped surfaces keep their current URL contracts (`/docs?harness=`, `/analyses?project=`, …); the registry builds them from the selected project's `projectId` and first live `harnessId`.

`GET /app/api/directory` (tokenless, `secured_json_response`, in-memory only — no disk walk):

```json
{ "projects": [{ "projectId": "project-1a2b…", "name": "krypton", "dir": "/Users/…/krypton",
    "harnessIds": ["hm-2", "hm-10"], "lanes": { "total": 4, "busy": 1 },
    "artifacts": { "live": 3, "pending": 1 } }] }
```

Harness ids sort numerically. Data comes from `docs_project_dirs()`, `gallery_project_identity()`, telemetry snapshots and the artifact registry — all already tokenless.

### Session capability

```rust
pub(crate) struct LoopbackSession { token: String } // termctrl_monitor::capability_token(), once per process
```

1. Krypton calls `openLoopback(path)` → `invoke('loopback_url', { path })`. Rust validates `path` (starts with `/`, not `//`, no `\`, no scheme) and returns `http://127.0.0.1:<port>/app/session/<token>?next=<path>`; `open_url` opens it. Capability openers pass the path of the URL their existing command returns (`/termctrl/<t>`, `/hurl/<t>`, …), so they land on the same page as today.
2. `GET /app/session/{token}?next=` → constant-time compare (empty 404 on mismatch), `next` revalidated (400), `AppPage { entry: "session" }` with `no-referrer`/`no-store`.
3. `session.ts` writes `localStorage['krypton.loopback.session']`, then `location.replace(next)`.
4. Every shell fetches `/app/api/{token}/capabilities` (constant-time, empty 404, `secured_json_response`) when a token is stored; a 404 removes it.

```json
{ "termctrl": "/termctrl/<t>", "acpWire": "/acp-wire/<t>",
  "projects": [{ "projectId": "project-1a2b…", "hurl": "/hurl/<t>", "e2e": "/e2e/<t>" }] }
```

Hurl and E2E URLs come from the existing `HurlWebSessions::issue` / `E2eWebSessions::issue` (idempotent per root) for each directory project. Existing capability routes, their tokens and the openers' direct URLs are unchanged. ADR 0026 records the trade-off: any same-origin script — a lane artifact or raw HTML in repo markdown — can read the stored token and so reach the capability surfaces. That stays inside the envelope ADR-0002 already accepted (artifact script can call every lane's MCP tools on this origin) but widens what such script reaches directly; other local ports and other sites do not get it.

### Kit

Components extend `src/ui` `Component` and build nodes with `el()`; lists use `reconcile()`. Each component's BEM class set (`lb-<block>__<element>--<modifier>`) is also its contract for Rust-rendered markup, which a `hydrate…(root)` function wires up.

| Group | Components |
|---|---|
| Chrome | `AppShell` (top bar, mounts the page), `Switcher`, `KeyHelp`, `SplitLayout` (rail + content, 1140/1180/1400 caps), `TreeNav` (groups, counts, active, scroll restore), `Tabs` (`[`/`]`, `1`–`9`) |
| Data | `Card`, `StatBar`/`StatTile`, `Pill` (status → `st-*` table), `Dot` (the one `beacon`), `Chip`, `DataTable`, `KeyValue`, `Prose` (`article.doc`), `CodeBlock`, `JsonTree`, `Gauge`, `ResourceBar` |
| Input & feedback | `Button` (primary/secondary/toggle with `aria-pressed`), `SearchFilter` (`/`, `Esc`, match count), `RosterList` (`j`/`k`/`↑`/`↓`/`Enter`, `aria-selected`), `EmptyState`, `Banner` (flash), `KbdHints`, `FeedbackOverlay` (the `/doc` comment + artifact pill) |
| Lib | `Keymap` (one document dispatcher; skips editable targets and Ctrl/Meta/Alt; duplicate binding throws), `poll()` (in-flight guard, signature dedupe, hidden pause, focus refetch, reconnecting state), `fetchJson` (`no-store`, typed errors), `format` (bytes, durations, relative/absolute time, locale dates), `copyText` |

Surfaces own only what is theirs (dashboard sparklines, termctrl cell grid, hurl splits, acp-wire waterfall). Hurl imports `src/hurl-curl.ts`, `src/hurl-tree.ts` and the highlighter instead of its inline "keep in sync" copies; the dashboard imports `TELEMETRY_SCHEMA_VERSION` from a Tauri-free module instead of repeating `4`; Terminal Control imports the cell grid instead of `window.KryptonCellGrid`.

### Home (`GET /` → `AppPage { entry: "home", scheme: Dark }`)

A stat bar (projects, lanes busy/total, live artifacts), then three groups of tiles — **Monitor** (Lane monitor, Terminal Control, ACP wire), **Project** (Docs, Journal, Timeline, Analyses, Reviews, Artifacts, Hurl, E2E), **Reference** (Commands, MCP tools, GenUI components). A tile shows title, summary and, where the directory has it, a count chip. An unavailable tile stays in place, muted, with its reason: "no open project" or "open Krypton Home from Krypton (`#home`) to enable". Home refetches on focus and does not poll.

### Shell

`header.lb-shell` (44px, sticky, hairline bottom border, no nested card): brand `Krypton` → `/`, `/ project / surface` title, project button (project-scoped pages and Home), a `limited` marker when no session, and `KbdHints` for the two shell keys. The shell renders before the page's first data and never blocks it.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `` ` `` (matched on `KeyboardEvent.code === 'Backquote'`, so Thai and other layouts work) | Any page, outside inputs | Open/close the switcher |
| type, `↑`/`↓`, `Enter`, `Esc` | Switcher | Filter surfaces and projects, move, go, close |
| `?` | Any page, outside inputs | Keyboard help: shell keys plus the page's registered `Keymap` |
| `/`, `j`/`k`/arrows, `Enter` | Home | Filter tiles, move, open |
| Palette **Open Krypton Home** (`loopback.home`), `#home` | Krypton | Open Home |

Every existing per-page key keeps its meaning; pages register them through `Keymap`, which is how `?` lists them. Neither shell key is bound by any page today. The `/docs` "any printable key focuses the filter" fallback runs after `Keymap` and skips the two shell keys.

### Theming and visual normalisation

Per-surface policy from `DESIGN.binance.md` stays: Home, the status walls (dashboard, gallery), the references (commands, MCP tools, the GenUI shell) and the capability tools (Terminal Control, ACP wire, Hurl, E2E) are `Dark`; docs/journal/doc, analyses, reviews and timeline are `Auto`. The shell is token-driven, so it follows. Moving onto one token sheet applies the design file where pages drift from it: `--fg #eaecef` everywhere, `/tools` loses its blue and purple category hues (category is a text label), one `beacon` keyframe (termctrl/e2e/hurl `pulse`/`loading`/scale variants go), no uppercase data labels, 10px card radius, reviews capped at 1180px.

## Delivery Order

1. Foundation: `loopback_app.rs`, `entries.json`, build, tokens, kit chrome + lib, Home, session, `openLoopback` cut-over of every opener, palette/`#home`.
2. Status walls and references: dashboard, gallery, commands, tools, timeline, GenUI gallery.
3. Readers: docs, journal, doc (+ `FeedbackOverlay`), analyses/analysis, reviews/review.
4. Capability tools: Terminal Control, ACP wire, E2E, Hurl.
5. Docs: `DESIGN.binance.md`, 0004/0005, ADR 0026, supersede notes, README index.

Each step deletes the HTML it replaces and its text-pinning tests in the same change.

## Edge Cases

- **Krypton restarted:** the stored token no longer matches → capabilities 404 → token cleared, capability tiles show the reopen hint; open surfaces keep working.
- **No harness open:** directory is empty → project tiles disabled ("no open project"); global surfaces work.
- **Harness closed while a page is open:** the page behaves as today (readers 404 on next request); the shell refetches the directory on focus.
- **Ephemeral port fallback:** `loopback_url` builds from the bound port, like every opener today.
- **Debug without the Vite server:** the module redirect fails; reader bodies still show (Rust-rendered), other pages keep the `lb-boot` line, which names the Vite dev server as the missing piece.
- **Missing release asset:** 404, never the main `index.html` (exact-key check).
- **Open redirect:** `next` must be a same-origin path; `loopback_url` refuses anything else, and the landing answers 400 after the token check.
- **Key conflicts:** `Keymap` throws on a duplicate registration; a test registers every surface's keymap with the shell's.
- **ACP wire opened from Home** does not switch capture to `meta` (that is a Krypton-side action); the page shows its existing capture-off state.

## Verification

- Rust: session token compare + empty 404; `next` validation (`//x`, `http://x`, `\x`, `x`); directory shape and numeric harness order; capabilities 404/shape; asset name validation; route mirror.
- TS (DOM project): `Keymap` editable/modifier/`code` matching and duplicate rejection; `poll()` guard/pause/reconnect; `NavContext` project resolution and disabled entries; switcher filter + `Enter`; ported page behaviour tests (commands/tools render from fixtures incl. `timeline`/`e2e` categories, e2e explorer and Terminal Control cases).
- `npm run check`, `npm run build`, `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt -- --check`.
- OS-browser smoke in `make dev` and a release build: open Home via `#home`; reach every surface from Home and the switcher and return via the brand; `?` on each page; restart Krypton and confirm the capability tiles fall back; `/doc` feedback and artifact pill still post.

## Implementation Notes (2026-10-29)

Deviations from the design above, all simplifications:

- **No `entries.json`.** The entry set is the directory listing of `src/loopback/entries/*.ts`: `vite.loopback.config.ts` globs it and Rust redirects `/app/assets/<entry>.js` by name, so there is no second list to drift.
- **One stylesheet, no per-page extras.** `build.cssCodeSplit: false` merges every sheet into `app.css`; `AppPage` has no `extra_styles` (the GenUI fallback tokens are scoped to `html[data-surface='genui']`). In debug the document has no `<link>` at all — Vite injects the CSS the modules import — so only `<entry>.js` redirects.
- **Kit shape.** Stateful pieces are classes (`AppShell`, `Switcher`, `KeyHelp`, `StatBar`, `Tabs`, `SearchFilter`, `RosterList`, `DataTable`, `Banner`, `FeedbackOverlay`); stateless ones are element factories (`pill`, `dot`, `chip`, `card`, `button`, `emptyState`, `kbdHints`, `keyValue`). `Keymap` gained a modal layer (`addModal` + `modal` bindings) so the switcher and key help pause page keys; `Tabs.numberFrom`, `RosterList.wrap`, `SearchFilter.escape` (`clear-then-leave` / `clear-and-leave` / `leave`), `chip({ muted })`, `dot('add')` and `.lb-sr` were added to keep each page's old behaviour.
- **Directory row** also carries `attention` (open flags), which the Home dashboard tile shows.
- **Readers** keep their Rust row markup class names (`ai-row`, `rv-*`) scoped under `.lb-analyses` / `.lb-reviews`; tabs, trees and prose use kit classes.
- **Surface-level differences** each owning spec records: the dashboard now pauses while its tab is hidden (kit `poll()` default); e2e copy feedback hides after 4 s; commands/e2e/genui copy feedback is a `Banner`; termctrl's `k` from no selection picks the last row.

Verified: `npx tsc --noEmit` clean; `npx vitest run` 265 files / 3,231 tests; `npm run build` (main app + `dist/app/` with 15 entries and one `app.css` whose first rules declare `lb.*` then `krypton.*` layers); `cargo test` 608 passed; `cargo clippy -- -D warnings` clean (the `--all-targets` run stops on a pre-existing `bool_assert_comparison` in `timeline.rs` tests, untouched here); `cargo fmt`. Browser smoke in headless Chromium against the built `dist/app/` bundle served with the exact Rust document shape — reader bodies dumped from the real Rust renderers over this repo, directory JSON from `loopback_directory()`: all 16 pages boot with the shell and no page errors; session landing stores the token and capability tiles link; the switcher opens on `code === 'Backquote'` with a Thai-layout `key: '_'`; Home tile → dashboard, switcher → docs, `?` lists the page keys, brand → Home; a stale token shows the "Krypton restarted" reason. Not run: the Tauri app itself (`make dev` / a release bundle), so the debug Vite redirect, the release `asset_resolver` lookup under `app/` and the GenUI debug CSP are covered by unit tests and the spec 313/330 precedents only.

## Open Questions

None. The decisions a reviewer may want to revisit are the document-per-URL model (vs. a single-page app) and the stored session capability (vs. leaving the four capability surfaces off Home); both are argued above.

## Out of Scope

- The artifact scaffold and lane-authored artifacts (lane-owned content; it keeps its own inline styles and overlay).
- Changing any data endpoint, POST contract, capability token scope, or `harness=`/`project=` URL contract.
- Found while researching, left for separate tickets: Hurl `/events` and `/cancel` do not check that a run belongs to the token's session; no `Host` check (DNS rebinding) on tokenless routes; `/doc` and `/doc-asset` ignore `.gitignore`; a rehydrated artifact keeps the `feedbackBaseUrl` port it was minted with.
- A theme toggle, cross-document view transitions, a kit showcase page.

## Resources

- [Nuxt DevTools — Module Authors Guide](https://devtools.nuxt.com/module/guide) — dock-entry registry (id, title, category; iframe/launcher views); registry adopted, iframe hosting rejected.
- [Grafana Saga — Navigation](https://grafana.com/developers/saga/patterns/navigation) — landing page per category, breadcrumbs as hierarchy, sentence case.
- [JupyterLab — The JupyterLab Interface](https://jupyterlab.readthedocs.io/en/stable/user/interface.html) — launcher of grouped activities plus a modal command palette.
- [GitHub Docs — Keyboard shortcuts](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts) — `?` for help, `g` sequences (not adopted: clashes with existing `g`).
- [RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265.html) — cookies are shared across ports; why the session capability is not a cookie.
- [Vite — Build Options](https://vite.dev/config/build-options.html) — non-HTML `rollupOptions.input` entries and output naming.
- Local prior art: spec 313 (Vite bundle via `frontend_dist_asset`), spec 330 (Rust page + Vite module, `localhost` redirect), ADR-0002, ADR-0010.
