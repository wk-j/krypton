# Loopback App on React — Implementation Spec

> Status: Implemented (2026-11-05)
> Date: 2026-11-05
> Milestone: ACP Harness
> Amends spec 341 (kit and surface implementation only; hosting, URLs, session capability and look unchanged)

## Problem

The loopback app (`src/loopback/`, spec 341) builds every page by hand on the spec-301 kernel (`src/ui/`: `Component`, `el()`, `reconcile()`). Ten thousand lines of page code (46 files) manage their own DOM updates, list diffing and teardown. The user wants the loopback app written in React instead.

## Solution

Port the loopback kit and every surface to React 19 function components. Keep everything a browser or Rust can observe: the document shape Rust builds, every URL, every BEM class and stylesheet, every key binding, every JSON/SSE/POST contract. The framework-free libraries (`Keymap`, `poll()`, `fetchJson`, `format`, `session`, `nav`) stay and get thin hooks. Rust-rendered reader bodies stay non-React markup; React attaches to them through portals and effects. Code that must render exactly like the harness (GenUI catalog, cell grid, Mermaid/SVG fences) or that draws on a canvas is mounted through one `Island` component. The rule "no frontend frameworks" stays for the Tauri app frontend. This spec, ADR 0028 and `AGENTS.md` record that the loopback app is now the second exception, after the Raycast extension.

## Research

- **Scale** (measured): `src/loopback/` holds 11,745 lines of TS outside tests: 46 DOM-building files (10,104 lines) and 27 pure files (1,641 lines: entries, `surfaces.ts`, `kit/lib/{fetch-json,nav,session}`, `acp-wire/model.ts`, `e2e/{map,checks}.ts`, `termctrl/ansi-text.ts`, `dashboard/format.ts`). There are also 3,045 lines of tests in 24 files and 2,349 lines of CSS. The largest ports are `e2e` (1,234), `acp-wire` (1,060), `hurl` (771), `timeline` (723), `termctrl` (708) and `feedback-overlay` (614). Pure files move unchanged.
- **React is already a dependency.** `react`/`react-dom` `^19.2.6` and their `@types` are in `package.json`. `src/pencil-view.ts` lazy-loads them for Excalidraw with `React.createElement` (no JSX). No new runtime dependency is needed.
- **JSX without a plugin.** Vite 7 passes the tsconfig `jsx` option to esbuild. Setting `"jsx": "react-jsx"` compiles `.tsx` in `vite build`, the dev server and Vitest. No `.tsx` file exists today, so the main app is unaffected. `@vitejs/plugin-react` would add Fast Refresh, but Rust builds the document, so Vite's backend-integration guide requires a hand-written `@react-refresh` preamble in that HTML. Rejected: dev edits do a full page reload, which takes milliseconds on loopback.
- **No Rust change.** Debug redirects `/app/assets/<entry>.js` → `localhost:1420/src/loopback/entries/<entry>.ts` (`loopback_app.rs:194`), and `vite.loopback.config.ts` collects `entries/*.ts`. Entries stay `.ts` and pass a component to `bootPage` without JSX, so both lists are untouched.
- **Readers are server markup.** `/docs`, `/journal`, `/doc`, `/analyses`, `/reviews` arrive with a Rust-rendered `<main>` body that the entry wires up (`surfaces/docs/index.ts:1-13`). `/doc` executes raw HTML/JS from repo markdown (ADR-0010 rev 2). `createRoot` takes over and clears its container, so it can never target `#lb-main` on a reader. react.dev documents portals as the way to put React into non-React server markup and into DOM owned by another library.
- **One raw-HTML sink.** `hurl/index.ts:694` assigns `highlightHurl()` output to `innerHTML`; the highlighter escapes every source character. Everything else builds nodes, so React's default escaping is no regression.
- **Keymap ordering.** `Keymap.bind` throws on a duplicate unconditioned chord (`keymap.ts:99-106`), and `help()` lists bindings oldest first (shell before page). Rebinding on every render would both throw transiently and reorder `?` help, so hooks bind once and read the latest handler through a ref.
- **Testing.** `act()` needs `globalThis.IS_REACT_ACT_ENVIRONMENT = true`; Testing Library sets it, plain `react-dom/client` does not. The `dom` Vitest project (happy-dom) already runs `src/loopback/**`.
- **Alternatives rejected.** *React only for new pages*: leaves two kits and two conventions in one app indefinitely. *Preact/Solid/Lit*: the request names React, React is already installed, and bundle size does not matter on a loopback origin. *Move readers to JSON APIs and render them in React*: changes Rust renderers and endpoints (out of scope for spec 341 too) and cannot run `/doc`'s raw scripts. *`createRoot` per widget*: many roots lose shared context (shell title, nav context); one root plus portals keeps one tree.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Grafana | Whole app is React; panels are plugin components | Full-React model; no server-rendered readers |
| JupyterLab | Lumino widget tree; `ReactWidget` wraps React components inside it | Mixed ownership like our readers and islands, with an explicit adapter at the boundary |
| react.dev | `createPortal` for "React components into non-React server markup" (Rails sidebars) and into DOM a third-party widget owns | The reader and slot pattern below |
| Storybook | Manager UI in React; story previews in an iframe in any framework | Content that must render like another runtime stays outside the React tree, like GenUI |

**Krypton delta:** the port changes no URL, keyboard binding or visual: same `DESIGN.binance.md` look, same keys, same `?` help. Server-rendered readers stay server-rendered.

## Affected Files

| File | Change |
|------|--------|
| `tsconfig.json` | `"jsx": "react-jsx"` |
| `vite.config.ts` | `dom` project include `src/loopback/**/*.test.{ts,tsx}` |
| `src/loopback/app.ts` | `bootPage(surface, Page, options)` creates the single root (below) |
| `src/loopback/kit/<component>/index.tsx` | Every kit component becomes a function component with the same BEM classes; `.css` files unchanged |
| `src/loopback/kit/hooks.ts` | New: `useKeymap`, `useKeyFallback`, `useModal`, `usePoll`, `useShell` |
| `src/loopback/kit/island/index.tsx` | New: `Island` for non-React DOM (below) |
| `src/loopback/kit/test-utils.tsx` | New: sets `IS_REACT_ACT_ENVIRONMENT` on import; `render(node)` / `unmount()` around `act` |
| `src/loopback/kit/lib/*` | Unchanged (`keymap`, `poll`, `fetch-json`, `format`, `nav`, `session`) |
| `src/loopback/surfaces/<surface>/*.tsx` | Every surface ported; pure modules (`model.ts`, `map.ts`, `checks.ts`, `ansi-text.ts`, `format.ts`, `examples.ts`) unchanged |
| `src/loopback/entries/*.ts` | `bootPage('x', XPage)`; stay `.ts` |
| `src/loopback/**/*.test.ts` | Mounting moves to `render(<XPage/>)`; behaviour assertions kept; tests that pin class/method shape deleted |
| Unchanged | `src-tauri/**`, `vite.loopback.config.ts`, `src/ui/**`, `src/acp/**`, all CSS, `src-tauri/resources/artifact-scaffold.html` |
| Docs | `AGENTS.md` (constraint 6, Loopback App bullet), new `docs/adr/0028-loopback-app-uses-react.md`, `DESIGN.binance.md` (kit section), `docs/0004-architecture.md` (loopback paragraph), spec 341 amend note, `docs/README.md` |

## Design

### Boot and root

```ts
export interface PageProps {
  /** `#lb-main`. Readers: holds the Rust body; React never owns its children. */
  readonly main: HTMLElement;
}
export function bootPage(surface: SurfaceId, Page: ComponentType<PageProps>, options?: BootOptions): void;
```

1. `bootPage` removes `.lb-boot`, calls `createRoot(#lb-shell)` and renders `<StrictMode><ShellProvider surface title><AppShell/><PageBoundary>{createPortal(<Page main/>, target)}</PageBoundary></ShellProvider></StrictMode>`.
2. `target` is `#lb-main` for pages without a Rust body. Readers get a new empty `<div id="lb-page-root">` appended to `<body>`, so the server body is never React's child; their widgets portal into the server's empty slots (`#docs-filter`, …).
3. `PageBoundary` (the one class component) catches render errors and prepends today's `p.lb-boot` "This page failed to start: …" note to `#lb-main`. The shell stays mounted, as today.
4. `ShellProvider` holds `{ surface, title, setTitle, nav: NavContext }`; `useShell()` reads it. The `AppShell` class's `setTitle` becomes context state.

### Hooks over the kept libraries

```ts
useKeymap(bindings: readonly KeyBinding[]): void   // binds once on mount, handlers/`when` via ref
useKeyFallback(handler: (e: KeyboardEvent) => void | boolean): void
useModal(open: boolean): void                       // Keymap.addModal while open
usePoll<T>(opts: Omit<PollOptions<T>, 'apply' | 'onStatus'> & { deps?: unknown[] }):
  { value: T | undefined; status: PollStatus; refresh(): Promise<void> }
```

`usePoll` keeps `poll()`'s in-flight guard, signature dedupe and hidden-tab pause. An identical payload does not call `setState`, so a quiet poll causes no re-render. The bindings array's shape (keys, labels, order) is fixed per component; changing it requires remounting, which keeps `?` help order stable.

### Island

```ts
export function Island(props: { mount(host: HTMLElement): Disposer; deps: readonly unknown[]; className?: string }): JSX.Element;
```

Runs `mount` in a layout effect on its own `div`, disposes on unmount or when `deps` change. React never renders children into it. Used for exactly:
- GenUI preview: `src/acp/components/genui-catalog` renderer, which must stay pixel-identical to the harness.
- Terminal Control cell grid: `src/acp/cell-grid`.
- Mermaid and SVG fences: `src/acp/harness-mermaid-fence`, `harness-svg-fence` (e2e map, docs).
- Dashboard sparklines: `surfaces/dashboard/canvas.ts` (canvas drawing).

### Kit mapping

| Today | React |
|---|---|
| Factories `pill`, `dot`, `chip`, `card`, `button`, `emptyState`, `kbdHints`, `keyValue` | `<Pill>`, `<Dot>`, `<Chip>`, `<Card>`, `<Button>`, `<EmptyState>`, `<KbdHints>`, `<KeyValue>` with the same props |
| Classes `AppShell`, `Switcher`, `KeyHelp`, `Banner`, `StatBar` | Components; switcher/key help use `useModal` |
| `Tabs`, `SearchFilter`, `RosterList`, `DataTable` | Controlled components (`value`/`onChange`, `selected`/`onSelect`); keyed lists replace `reconcile()` |
| `FeedbackOverlay` | Component portalled to `<body>`; reads `/doc`'s article through a ref, never re-renders it |
| `TreeNav` (hydrates Rust markup) | `useTreeNav(root)` effect hook |
| `localizeTimes(root)` on Rust markup | Called from the reader page's effect |

Hurl source keeps its one raw sink as `dangerouslySetInnerHTML={{ __html: highlightHurl(...) }}` under the existing escaping comment. No other `dangerouslySetInnerHTML`. Large lists keep their caps (`acp-wire` `MAX_ROWS` 400, dashboard `FEED_CAP`, termctrl `LOG_LINE_CAP` with 2,000-line chunks rendered as memoized keyed chunk components, so appending to the last chunk re-renders only that chunk).

### Data flow (status page, e.g. dashboard)

```
1. Rust serves AppPage { entry: "dashboard" } — unchanged
2. entries/dashboard.ts → bootPage('dashboard', DashboardPage)
3. createRoot(#lb-shell) renders AppShell + portal(DashboardPage → #lb-main)
4. DashboardPage: usePoll(fetchJson(<existing telemetry endpoint>)) → value → keyed LaneCard list
5. Same payload signature → no setState → no render; tab hidden → poll paused
```

Reader flow: steps 1–3 the same, except the page portal is `#lb-page-root`. `DocsPage` effects query `#docs-list` rows, toggle `hidden` and selection classes, and portal `<SearchFilter>` into `#docs-filter`.

## Edge Cases

- **`/doc` raw scripts** mutate the article: React owns no node inside `#lb-main` on readers, so nothing is reconciled away.
- **StrictMode double effects (dev):** every hook disposes what it binds, so mount→unmount→mount leaves exactly one binding. The `Keymap` duplicate check catches leaks.
- **Page throws on first render:** `PageBoundary` shows the boot note and the shell keeps working (switcher, `?`).
- **Debug without the Vite server:** unchanged; reader bodies show, other pages keep `lb-boot`.
- **GenUI/cell-grid code that throws inside `Island.mount`:** the throw happens in a layout effect, so `PageBoundary` catches it and shows the same boot note as any page error (today's `bootPage` catch). No new error UI.
- **Key handlers reading stale state:** prevented by the ref pattern in `useKeymap`; a test presses a key after a state change.

## Verification

- Before porting, capture `#lb-shell` + `#lb-main` `outerHTML` and screenshots of all 16 pages with the existing headless-Chromium smoke (spec 341: built `dist/app/`, Rust document shape, reader bodies from the real renderers, directory JSON from `loopback_directory()`). After porting, the same run must show no page errors, the same class set per page, and screenshots matching on visual review.
- TS (DOM project): existing behaviour tests pass against the React pages; new tests only for `useKeymap` (bind once, latest handler, StrictMode leaves one binding) and `usePoll` (identical payload → no render).
- `npm run check`, `npm run build` (report the shared React chunk size in `dist/app/chunks/`), `npx vitest run`, `cargo test` (unchanged Rust, run to confirm the document tests).
- Browser smoke in `make dev`: `#home`, every surface from Home and the switcher, `?` on each page, `/doc` comment and artifact pill post, Terminal Control live log, Hurl run, e2e map render.
- Static checks: no value import from `src/ui/` left under `src/loopback/` (the `Disposer` type in `kit/lib` stays; islands import `src/acp/*` renderers, which use the kernel internally), no `react` import outside `src/loopback/` and `src/pencil-view.ts`.

## Implementation Notes (2026-11-05)

Deviations from the design above:

- **Files.** `src/loopback/app.ts` became `app.tsx` (the root render is JSX). `useShell()`/`ShellApi` live in `kit/shell/context.ts`, not `hooks.ts`; `ShellApi` is `{ surface, title, context, contextLoaded, setTitle, selectProject, refresh }`. `hooks.ts` also exports `useLatest`. There is no `useTreeNav`: `hydrateTreeNav` was already framework-free, so reader pages call it in an effect. `Island` always renders a `div` and passes it to `mount`.
- **Kit API.** `key(item)` is `itemKey(item)` (React reserves `key`). `RosterList` takes the selected item's key (controlled) and exposes only `RosterHandle.move` (Hurl binds its own row keys). `SearchFilter`'s value is owned by the parent, but its `<input>` is uncontrolled (value synced in a layout effect) so React writes no `value` attribute. `Banner` is a plain component plus `useBanner()` for the timed flash. `Button` props replace `setPressed()` and node mutation. `Card` and `Button` pass `data-*`; `Pill` takes `hidden`.
- **Surfaces.** Where `apply` has side effects (gallery, timeline, e2e, acp-wire, feedback overlay), the page calls `poll()` directly in an effect instead of `usePoll`. Terminal Control keeps a mutable model plus a render counter; Hurl moved its async logic into a DOM-free `HurlStore` read through `useSyncExternalStore`; the dashboard runs one animation-frame loop through a context (`frame.tsx`) and `FittedCanvas` wraps the React-rendered `<canvas>`. Only the GenUI preview needed `Island`: Terminal Control's grid is a ref + layout effect on a React `<pre>`, the e2e map is an `<img>` data URL, the acp-wire waterfall is painted into a React `<svg>` through a ref.
- **Behaviour differences (no visual change).** Terminal Control fills each log chunk to 2,000 lines before opening the next (the old page appended one text node per poll; the cap still drops whole chunks). Unmounting now also cleans up what the old pages leaked: in-flight acp-wire and Hurl requests are aborted, Hurl drag listeners are removed, e2e's late `/active` poll stops, and the docs index restores the rows it hid. Unrelated acp-wire re-renders keep the message tree's expanded nodes. A Hurl variables file that disappeared shows `env: (none)` instead of an empty select. The Commands list scrolls the selected row fully into view (4 px further than before).
- **Bundle.** React and the kit share one chunk (215 KB, 68 KB gzip); `dist/app/` went from 4.6 to 4.7 MB.

Verified:
- `npm run check` is clean, and `npx vitest run` passes (285 files, 3,421 tests). The new `kit/hooks.test.tsx` covers `useKeymap`: it binds once, calls the latest handler, leaves one binding under StrictMode and unbinds on unmount. It also covers `usePoll`: an unchanged signature causes no re-render.
- `npm run build` and `cargo test` (650 passed) succeed, with Rust untouched.
- **Browser smoke.** Headless Chromium loaded all 19 page URLs (the spec's 16 pages plus the journal, analysis and review detail pages) through a throwaway proxy. The proxy served the old bundle (HEAD) and the new `dist/app/`. It forwarded documents, reader bodies and JSON to the running Krypton (release) hook server, and gave the four capability pages a synthesized document with an invalid token.
  - No page errors on either bundle.
  - The class set of `#lb-shell`, `#lb-main` and the body overlays is identical on every page.
  - Interleaved screenshots differ by at most 0.94% of pixels: the Commands scroll offset above; everything else ≤ 0.024%, from live data such as the uptime clock.
  - Switcher (`` ` ``, filter, `Enter` navigates), `?` help, docs type-to-filter and `↓` selection, Commands `j`/`k`, GenUI `]`, and Timeline `j`/`Space` behave as on the old bundle.
  - In the dev path (Vite dev server, StrictMode double-mount), 18 of 19 pages boot without errors, with exactly one switcher and one key-help overlay. The `?` help lists the same keys in the same order as the old bundle on 10 pages.
- **Not exercised.** GenUI in the dev path: the release server's CSP blocks `localhost:1420`, which a debug build allows. Pages with a real capability token: no session token was available, so they were checked with fixtures in their unit tests and in the expired-link state in the browser. A real Hurl run, a live Terminal Control log, and posting `/doc` comments: the smoke proxy was read-only.

## Open Questions

None.

## Out of Scope

- The Tauri app frontend, `src/ui/`, harness components (`src/acp/components/`): stay framework-free. Constraint 6 is amended only for `src/loopback/`.
- Fast Refresh (`@vitejs/plugin-react` + Rust-emitted preamble).
- Any URL, endpoint, payload, capability, Rust renderer, CSS or visual change; a single-page app.
- The artifact scaffold and lane-authored artifacts.
- React Testing Library or any other new dependency.

## Resources

- [Vite 7 — Features: TypeScript compiler options](https://v7.vite.dev/guide/features) — `jsx`/`jsxImportSource` in tsconfig drive esbuild; no plugin needed for JSX.
- [Vite 7 — Backend Integration](https://v7.vite.dev/guide/backend-integration) — `@react-refresh` preamble required in server-built HTML; why Fast Refresh is out of scope.
- [React — createPortal](https://react.dev/reference/react-dom/createPortal) — portals into server-rendered non-React markup and into DOM owned by another library; the reader and slot pattern.
- [React — act](https://react.dev/reference/react/act) — `IS_REACT_ACT_ENVIRONMENT` must be set without Testing Library.
- [JupyterLab — React](https://jupyterlab.readthedocs.io/en/stable/extension/virtualdom.html) — `ReactWidget` as an explicit boundary between a non-React widget tree and React.
- Local: spec 341 (hosting, kit, verification harness), ADR-0010 rev 2 (`/doc` raw HTML), `src/pencil-view.ts` (existing React use).
