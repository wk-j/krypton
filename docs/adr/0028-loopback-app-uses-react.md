# The loopback app is written in React; the Tauri app frontend stays framework-free

> Status: accepted
> Date: 2026-11-05

## Context

Krypton's architecture rule is "no frontend frameworks": the terminal app is vanilla TypeScript with direct DOM manipulation, and since spec 301 its harness surfaces run on the small `src/ui/` kernel. The reason is the app itself. It is one transparent WKWebView that must keep keypress-to-render under 16 ms, animate at 60 FPS and idle under 1% CPU, and the transcript must never repaint a sealed row.

The loopback app (`src/loopback/`, spec 341) does not run in that webview. Each page is a document the OS browser loads from `127.0.0.1:<hookPort>`: status walls, reference pages, readers and capability tools. It was built on the same `src/ui/` kernel. Its page code (about 10,000 lines) hand-writes DOM updates, list diffing and teardown that a component framework provides. React 19 was already a dependency, lazy-loaded by the Pencil window for Excalidraw.

## Decision

Spec 361 ports the loopback app to React 19 function components: the kit (`src/loopback/kit/`) and every surface. One React root on `#lb-shell` renders the shell and portals the page.

What a browser or Rust can observe does not change:
- the document Rust builds;
- every URL, endpoint and payload;
- every BEM class and stylesheet;
- every key binding.

What stays as it was:
- **Readers stay Rust-rendered.** React never owns `#lb-main` on a reader. It attaches behaviour in effects and portals widgets into the empty slots Rust leaves.
- **Harness renderers stay imperative.** Code that must render exactly as in the app (GenUI catalog, cell grid, Mermaid/SVG fences) or draws on a canvas is never re-implemented in React. It mounts through the kit's `Island` component, or through a ref and a layout effect on an element React renders.
- **The libraries stay framework-free.** `Keymap`, `poll()`, `fetchJson` and `format` keep their code and gain thin hooks.

The "no frontend frameworks" rule now covers the Tauri app frontend only. That is `src/` outside `src/loopback/`, including `src/ui/` and the harness components. It names two exceptions: the Raycast extension and the loopback app.

## Considered Options

- **Keep the loopback app on `src/ui/`.** It works and was rebuilt a week earlier. Rejected by the user in favour of React.
- **React only for new pages.** Rejected: it leaves two kits and two conventions in one app with no end date.
- **Preact, Solid or Lit.** Rejected: the request was React, React is already installed, and bundle size does not matter on a loopback origin.
- **Move readers to JSON APIs and render them in React.** Rejected:
  - it changes the Rust renderers and endpoints;
  - it cannot run the raw scripts in `/doc` markdown (ADR-0010);
  - loopback document loads are milliseconds.
- **Fast Refresh (`@vitejs/plugin-react`).** Rejected: Rust builds the document, so Rust would have to emit the `@react-refresh` preamble. A debug edit reloads the page instead.

## Consequences

- Loopback pages load one shared React chunk from `dist/app/chunks/`, embedded in the app bundle with the rest of `dist/app/`.
- `tsconfig.json` sets `"jsx": "react-jsx"`. This changes nothing for files that contain no JSX, so the Tauri frontend is unaffected. Nothing enforces the boundary automatically: a reviewer rejects `react` imports outside `src/loopback/` and `src/pencil-view.ts`.
- Reader pages and islands still contain DOM that React does not own. Their effects must clean up what they attach, and StrictMode in dev double-mounts them to prove it.
- Page tests mount React through `src/loopback/kit/test-utils.tsx` (`act`, no testing library).

## Rails

Applies to: `src/loopback/**`, `tsconfig.json`, `AGENTS.md`

- `react` and `react-dom` are imported only under `src/loopback/` and by `src/pencil-view.ts` (lazy Excalidraw); `src/ui/`, `src/acp/` and the rest of the Tauri frontend stay framework-free.
- On reader pages React renders nothing into `#lb-main`; the page portals into `#lb-page-root` and only attaches listeners, `hidden`/class toggles and portals into empty slots of the Rust markup.
- No `dangerouslySetInnerHTML` under `src/loopback/` except Hurl's source view, whose `highlightHurl()` output escapes every source character.
