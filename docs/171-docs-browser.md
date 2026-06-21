# Docs Browser (Loopback Markdown Renderer) — Implementation Spec

> Status: Implemented (rev 3)
> Date: 2026-06-21

## As-built (rev 3)

Index `/docs` reworked from a single full-tree sidebar into a **Finder-style
two-pane file browser**, and per-file pages stripped to a clean reader — all at
explicit user direction:

- **Single-file reader has no sidebar** — `/doc` now renders content only (no
  tree pane); `render_docs_page` takes `tree: Option<&str>` and `handle_doc`
  passes `None`. Content is centred (`article.doc { margin-inline: auto }`).
- **Sidebar shows folders only** — `render_folder_nav` emits the directory
  hierarchy (no files); each folder is a link to `/docs?harness=&dir=<rel>` and
  the harness root is the group label link. The active folder gets `is-active`.
- **Files render as items on the right** — `render_folder_listing` lists the
  *selected* folder's immediate subfolders (navigate in-page) and `.md` files
  (open `/doc` in a new tab), with breadcrumbs and an `..` up entry. New query
  params `harness`/`dir` on `/docs` (`DocsQuery`); default = first harness, root.
- **Each file shows its modified date** — `DocFile` now carries the fs mtime
  (captured in `build_docs_tree`). The server renders a `<time data-ts=ms>` with
  a UTC `YYYY-MM-DD HH:MM` no-JS fallback (`format_doc_mtime` + `civil_from_days`,
  no chrono dependency); a tiny page script localises the label to the viewer's
  locale. Locked by `format_doc_mtime_renders_utc_label`.
- **UI centred on screen** — `.layout` gets `max-width: 1180px; margin: 0 auto`.

This supersedes rev-1 decisions #8 (single left tree + right content pane) and #9
(file links live in the sidebar). Path validation / rendering (`/doc`,
`/doc-asset`) are unchanged. New helpers: `build_docs_tree`, `node_at`,
`render_folder_nav`, `render_folder_listing`; `docs_index_page` replaces
`render_docs_tree`; `render_docs_tree_node` removed.

## As-built (rev 2)

Two changes on top of rev 1, both at explicit user direction (security concern
waived):

- **Raw HTML now renders live** — `docs_options()` flips to `render.unsafe = true`
  + `render.escape = false`, so HTML embedded in a repo's `.md` (e.g. `<div>`,
  `<details>`, even `<script>`) renders/executes instead of showing as escaped
  text. Reverses the rev-1 sanitize-at-the-boundary stance and **ADR-0010**
  (amended). The rev-1 `render_markdown_doc_escapes_raw_html` test is replaced by
  `render_markdown_doc_renders_raw_html`. Path validation (the containment
  boundary) is unchanged; only content sanitization changed.
- **File links open in a new tab** — tree file `<a>`s carry
  `target="_blank" rel="noopener"`, so clicking a doc opens a fresh standalone
  tab instead of replacing the current one.
> Milestone: ACP Harness — observability
> Builds on: `docs/168-harness-lane-monitor.md` (the loopback dashboard pattern), `docs/170-artifact-gallery-endpoint.md` (the harness-grouped read-only sibling page), `docs/137-markdown-viewer-search-hints-images.md` (the in-app Vault Viewer this mirrors externally)
> Decision record: `docs/adr/0010-docs-browser-serves-repo-markdown-over-tokenless-loopback.md`
> Glossary: **Docs browser** in `CONTEXT.md`

## As-built (rev 1)

Built `#polly`-style: design grilled into this spec + ADR-0010, then two cross-reviewed slices — backend (Codex-1: `hook_server.rs` + `Cargo.toml`) and page+wiring (Cursor-1: `artifact-docs.html` + `compositor.ts`/`command-palette.ts`/`acp-harness-view.ts`). Cross-review found 2 blockers + 5 warnings, all resolved. Deltas from the plan above:

- **comrak `default-features = false`** — we only call `parse_document` + `format_html` with runtime GFM `Options` (table/tasklist/strikethrough/autolink are options, not cargo features), so the default feature set (syntect → onig/onig_sys C lib, clap, xdg) is dropped. Confirmed via `Cargo.lock` (only comrak + 6 light pure-Rust crates added).
- **Raw HTML is escaped, not omitted** — `render.unsafe_ = false` **and** `render.escape = true`, so a `.md` containing `<script>` renders as visible `&lt;script&gt;` text rather than comrak's default "raw HTML omitted" comment. Locked by the `render_markdown_doc_escapes_raw_html` unit test.
- **YAML front matter renders as a readable metadata card** — `extension.front_matter_delimiter = Some("---")` captures a leading `---`…`---` block as a `FrontMatter` node (so it is no longer mis-parsed into a stray `<hr>` + setext heading, which is what an undelimited front matter produced). `format_html` emits nothing for that node; `render_markdown_doc` instead extracts its raw text (`extract_front_matter`) and prepends a flat key/value card (`render_front_matter` → `<dl class="frontmatter">`, styled in `artifact-docs.html`) ahead of the body. Flat `key: value` scalars become `<dt>/<dd>` pairs; delimiter-less or non-scalar lines fall back to a full-width row so nothing is dropped. Locked by the `render_markdown_doc_renders_front_matter_as_card` unit test.
- **TITLE filled by a global bare-token replace** (`<!--DOCS_TITLE-->`), so both the `<title>` and the header subtitle are substituted; the page's head explanatory comment must therefore contain **no literal placeholder tokens** (it references them by bare name).
- **`/doc` query path normalized** (`normalize_relative_link`) before validation/render/active-match, so `docs/./guide.md` resolves to `docs/guide.md` for the tree `is-active` highlight and link rewriting.
- **`WalkBuilder.standard_filters(true)`** is set explicitly (defensive against the `ignore` crate's default changing).
- Endpoints landed exactly as specced: `GET /docs`, `GET /doc`, `GET /doc-asset`, sharing an `html_response` header helper with `/dashboard` + `/gallery`.
- Not yet exercised end-to-end in a live browser (verified by `cargo clippy`/`cargo test` + `tsc`); a manual smoke test in the OS browser is the remaining check.

## Summary

The **Docs browser** is a read-only loopback web surface — a sibling of the
artifact gallery and lane-monitor dashboard — that renders the markdown files
**already present in a harness's working directory** (`<cwd>`) in the OS browser.
It is a *renderer*, not a store: it owns no files and generates nothing; it
reflects whatever markdown is committed/present under `<cwd>`. It is the
browser-facing counterpart to the in-app Vault Viewer, and the natural reader
for a repo's `docs/`, ADRs, README, and [[Code wiki]].

## Decisions (resolved during grilling)

1. **Source = active harness's `<cwd>`** — the same directory the harness view
   operates on (`HarnessArtifactStore.project_dir`, already known to the backend).
2. **File discovery = recursive under `<cwd>`, respecting `.gitignore`, `.git/`
   excluded** (crate `ignore`, ripgrep-style). Only `*.md` files. This auto-drops
   `node_modules/`, `target/`, build output without a hardcoded denylist.
3. **Addressing = repo-relative path, no token.** Consistent with the token-free
   `/telemetry` and `/gallery`. Safety is strict path validation, not a
   capability token (see ADR-0010). Keeps per-file URLs bookmarkable.
4. **Rendering = server-side comrak (GFM), raw HTML escaped** (`unsafe_ = false`).
   No client-side markdown library — keeps the standalone page dependency-free,
   sanitizes once at the boundary.
5. **Scope = all harnesses, grouped** (like `/gallery`), but the filesystem is
   **scanned on request only** — no periodic tick, no background cache. (The
   one deviation noted: full-page mode means no polling at all; see #9.)
6. **Intra-doc links + images:**
   - relative `.md` links are **rewritten** at render time to
     `/doc?harness=<id>&path=<resolved-rel>` so clicking navigates within the
     browser; `http(s)://` links and non-`.md` links pass through untouched.
   - images are served by a sibling **`/doc-asset`** endpoint (whitelisted
     extensions: `.png .jpg .jpeg .gif .svg .webp`) under the same path
     validation. Not inlined as data URIs.
7. **Wiring** mirrors the gallery exactly: command palette `docs.open`
   ("Open Docs Browser") → `compositor.openDocs()`; harness composer command
   `#docs`. **No keybinding** (`Leader Shift+L` is taken by the dashboard).
8. **Name + layout:** "Docs browser". Listing is a **file tree** (folder
   hierarchy under `<cwd>`), not a flat card grid — a left tree + right content
   pane. Rendered as a **flat single surface** (no nested container / panel-in-
   panel, no left-bar accent rail — per standing UI feedback); separation by
   background tint / typography only.
9. **Page architecture = full standalone HTML page per file.**
   `/doc?harness=<id>&path=<rel>` returns a complete page (scaffold + tree
   sidebar + comrak-rendered content). Links are plain `<a href>` → full page
   reload; the tree is rebuilt server-side each request (the scan-on-request from
   #5). Near-zero client JS. **No polling / auto-refresh** — reload or click to
   rescan.

## Endpoints (axum, `hook_server.rs`)

| Route | Returns |
|-------|---------|
| `GET /docs` | Standalone HTML index: the file tree across all harnesses (harness-grouped roots), no file selected. Served with the same headers as `/dashboard` / `/gallery` (`text/html`, `nosniff`, `no-referrer`, `no-store`). |
| `GET /doc?harness=<id>&path=<rel>` | Standalone HTML page: tree sidebar + the one file at `<rel>` under that harness's `<cwd>`, comrak-rendered, raw HTML escaped, relative `.md` links rewritten. 404 if not found / not `.md`; 400 if path validation fails. |
| `GET /doc-asset?harness=<id>&path=<rel>` | Raw image bytes for a whitelisted image extension under `<cwd>`, with the correct `Content-Type`. Same path validation as `/doc`. |

`harness=<id>` disambiguates which harness's `<cwd>` a relative path resolves
against (two harnesses may share a relative path but different roots).

### Path validation (the security boundary — ADR-0010)

For every `/doc` and `/doc-asset` request, mirroring `validate_artifact_file`:

- resolve `<rel>` against the harness's canonical `<cwd>`;
- canonicalize the result and assert it is still under canonical `<cwd>`
  (component-level containment, not string prefix);
- reject any symlink component that escapes `<cwd>`;
- `/doc`: basename must end in `.md`; `/doc-asset`: extension must be in the
  image whitelist;
- reject non-regular files.

This validation is the containment guarantee and must carry unit tests for the
traversal / symlink-escape / wrong-extension cases.

## Page (`src/acp/artifact-docs.html`)

Reuses the dashboard/gallery Binance-dark shell (`:root` vars, brand bar, mono
fonts, light/auto toggle, `@media` responsive rules). Adds:

- a **file-tree sidebar** (folders expandable, files as leaves; harness roots as
  top-level groups when more than one harness is open) — flat surface, tinted,
  no nested frame, no left accent rail;
- a **content pane** holding the comrak output, styled for headings / code
  blocks / tables / task lists. No `border-left` color rails on blocks (scaffold
  strips them at runtime anyway).

Because each navigation is a full page load, the page needs almost no JS — only
the existing theme toggle and tree expand/collapse state (which may even be
pure CSS `<details>`).

## Backend support

- `HookServer::list_docs_tree()` — for each harness in the artifacts registry
  with a known `project_dir`, walk `<cwd>` via `ignore::WalkBuilder` collecting
  `*.md`, prune empty directories, return a harness-grouped tree. Scan-on-request.
- `HookServer::render_doc(harness, rel) -> Result<String, _>` — validate path,
  read file, render with comrak (GFM extensions on, `unsafe_ = false`), rewrite
  relative `.md` links to `/doc?...` hrefs while walking the AST.
- `comrak` added to `src-tauri/Cargo.toml`.

No new Tauri commands beyond reuse of `get_hook_server_port` + `open_url`.

## Relationship to neighbours (what this is NOT)

- **NOT the Vault Viewer** — that renders markdown *in-app* (`.krypton-vault`);
  the Docs browser is the *external-browser* counterpart.
- **NOT the Code wiki** — it *renders* a code wiki when `docs/wiki/` exists, but
  it serves all repo markdown, not only the wiki.
- **NOT the artifact gallery** — that lists lane-authored registered HTML under
  `.krypton/artifacts/`; the Docs browser reads pre-existing repo markdown the
  harness never created.
- **NOT a docs-site generator** — no build, no output; render-on-read only.

## Caveats / trade-offs (accepted)

- The loopback read-only surface now exposes **user repo markdown + referenced
  images** to any local process (ADR-0010). Containment rests entirely on path
  validation.
- A repo with thousands of tracked `.md` files makes a larger tree; `.gitignore`
  filtering keeps the common case small, and scan-on-request bounds the cost to
  page loads, not a background tick.
- No live reload: edits appear on the next navigation / reload, not instantly.
