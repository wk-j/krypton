# GitHub Issue Analysis Viewer — Implementation Spec

> Status: Implemented
> Date: 2026-07-08
> Milestone: M — ACP Harness / GitHub issue-fixing (extends spec 191)

## Problem

`#analyze-github-issue` writes a lane's findings as Thai-language markdown
(`root-cause.md`, `fix-plan.md`, …) plus downloaded issue resources into a
**gitignored** per-issue bundle at `.krypton/analyses/<owner>/<repo>/<number>/`
(spec 191). That bundle is meant to be read by a human before approving a fix — but
today there is **no way to read it in place**. The Docs browser deliberately walks
the repo through `.gitignore` (`build_docs_tree`, `hook_server.rs:3805`), so it hides
`.krypton/analyses` entirely. The only way to view an analysis is to open the raw
`.md` files in an external editor, which loses the rendered Thai prose, the footer,
and the attached images.

## Solution

Add a dedicated read-only **loopback browser surface** — the "Issue Analysis Viewer"
— that mirrors the Docs browser but is rooted at `.krypton/analyses/` and is
issue-centric rather than a raw folder tree. An index page (`/analyses`) lists every
issue that has an analysis bundle, grouped `owner/repo → #number`, with a link out to
the GitHub issue; a per-issue page (`/analysis`) renders all `.md` files in that
bundle stacked as one reader, with a resource strip for downloaded images/logs. It is
opened from the harness with a new `#analyses` hash command, consistent with
`#docs`/`#gallery`/`#dashboard`. Chosen over folding into the Docs browser because
(a) the bundles are gitignored working knowledge the Docs browser intentionally
excludes, and (b) analyses want issue grouping + attachments, not a raw tree.

## Research

- **Only producer, only location.** `analyzeGithubIssuePrompt`
  (`harness-prompts.ts:210`) is the sole writer, and it is pure prompt text — the lane
  writes the files with its own tools. Bundle path is `.krypton/analyses/<owner>/
  <repo>/<number>/` (owner and repo are **separate** path segments — `input.repo` is
  `owner/repo`). No filename convention beyond the `root-cause.md`/`fix-plan.md`
  examples; the viewer lists whatever `.md` files exist. Confirmed no Rust/TS code
  currently reads or serves `.krypton/analyses` — this viewer is its first consumer.
- **Docs browser is the near-exact template**, minus the gitignore filter.
  `render_docs_page(title, tree, content)` (`hook_server.rs:4049`) injects into
  `DOCS_HTML` (`artifact-docs.html`) via `.replace()` of `<!--DOCS_TITLE-->` /
  `<!--DOCS_TREE-->` / `<!--DOCS_CONTENT-->`. `render_markdown_doc(source, harness,
  rel)` (`:4077`) runs comrak with the front-matter card + relative-link rewriting.
  `validate_doc_path(cwd, rel, exts)` (`:1757` call site) guards traversal/symlink/
  extension. `html_response()` (`:4066`) sets the standard `text/html` + `nosniff` +
  `no-store` headers. All reusable as-is.
- **Why not reuse `build_docs_tree`.** It walks with `WalkBuilder.standard_filters
  (true)` which honors `.gitignore`, so it would return nothing under
  `.krypton/analyses`. The viewer needs a fresh, unfiltered directory walk rooted at
  the sibling of `artifacts_root` (`hook_server.rs:3610`).
- **Project root resolution.** `docs_project_dir(harness_id)` (`:840`) already returns
  the harness working directory from the artifact store; reuse it, then join
  `.krypton/analyses`.
- **issue_progress phase is frontend-only.** `issue_progress` (`:2745`) relays to the
  frontend, which owns binding/phase state (ADR-0007). The Rust hook_server does not
  hold live phase, so the browser surface derives issue identity from the folder path
  and links to GitHub; it does not show live phase (see Out of Scope).

## Prior Art

The viewer's job — render a folder of markdown + attachments as one reviewable
document — has no terminal-emulator equivalent. Its closest analogues are the app's
own loopback surfaces and general doc viewers.

| Surface / App | Implementation | Notes |
|---------------|----------------|-------|
| Krypton Docs browser (`/docs`) | comrak-rendered repo `.md`, tree sidebar, `#docs` opener | Direct template; excludes gitignored dirs |
| Krypton Artifact gallery (`/gallery`) | lists per-harness artifacts, newest first, `#gallery` opener | Grouping/index precedent |
| GitHub issue "linked analysis" | markdown comment thread with inline images | Convention: analysis reads top-down as prose + images |
| VS Code Markdown preview | side-by-side rendered `.md` with resolved local images | Convention: local image paths resolve relative to the file |

**Krypton delta** — matches the Docs-browser look (Binance-dark loopback aesthetic,
`DESIGN.binance.md`) and the `#`-command opener convention for familiarity;
diverges by (1) being rooted at gitignored `.krypton/analyses`, (2) grouping by
`owner/repo#number` instead of a raw tree, (3) stacking every `.md` in a bundle into
one continuous reader (analyses are short, related, and read top-down) rather than
one-file-per-page, and (4) rendering the Thai prose exactly as written for a
non-technical reviewer.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Add `analyses_root()` helper + unfiltered bundle walk; `analyses_index_page()` and `render_analysis_bundle()`; handlers `handle_analyses`, `handle_analysis`, `handle_analysis_asset`; register `/analyses`, `/analysis`, `/analysis-asset` in **both** the live router (`:4456`) and the conflict test router (`:4955`); `include_str!` the shell HTML |
| `src/acp/artifact-analyses.html` | New Binance-dark page shell (clone of `artifact-docs.html` structure, own `<!--ANALYSES_*-->` slots) |
| `src/acp/hash-commands.ts` | Add `{ name: 'analyses', … }` to `HASH_COMMANDS`; `analyses: { category: 'surface', badges: [] }` in `commandMeta()` |
| `src/acp/acp-harness-view.ts` | Add `#analyses` branch in the hash-command dispatch (mirror `#docs`, `:8196`) → open `/analyses` |
| `src/compositor.ts` | Add `openAnalyses()` mirroring `openDocs()` (`:2380-2448`) |
| `src/command-palette.ts` | Add `analyses.open` entry mirroring `gallery.open` (`:813`) |
| `docs/191-composable-verbs-github-issue-toolset.md` | Note the bundle is now viewable via `/analyses` (was "not shown by any surface") |
| `docs/PROGRESS.md` | Index entry for this spec |

## Design

### Data Structures (Rust, internal only)

```rust
/// One issue's analysis bundle discovered on disk.
struct AnalysisBundle {
    issue_key: String,   // "owner/repo#123" for display + GitHub link
    owner: String,
    repo: String,
    number: String,
    rel_dir: String,     // ".krypton/analyses/owner/repo/123"
    md_files: Vec<String>,   // relative paths, sorted (root-cause.md first if present)
    assets: Vec<String>,     // non-md files (images/logs), relative paths
    modified: Option<SystemTime>,
}
```

No serde types cross IPC — the surface is HTML-over-HTTP like the Docs browser.

### API / Routes

```
GET /analyses                              → index: all bundles, grouped owner/repo → #number
GET /analysis?harness=<id>&issue=<owner/repo/number>
                                           → one bundle: every .md rendered, stacked; asset strip
GET /analysis-asset?harness=<id>&path=<rel-within-.krypton/analyses>
                                           → serve a downloaded image (png/jpg/jpeg/gif/svg/webp)
```

- All three take `harness` like `/docs` (defaults to first harness when omitted).
- `/analysis` orders `.md` files with `root-cause.md`, then `fix-plan.md`, then the
  rest alphabetically; each file rendered with `render_markdown_doc` under a heading
  showing its filename.
- Non-image assets (`.log`, `.txt`, …) are listed by name in the asset strip as plain
  text (name + size), not linked for download in MVP (see Out of Scope).

### Data Flow

```
1. User types #analyses in a harness lane composer.
2. acp-harness-view dispatch invokes get_hook_server_port, opens
   http://127.0.0.1:<port>/analyses via open_url, flashes the URL chip.
3. handle_analyses → analyses_index_page(): for each harness project_dir, walk
   <dir>/.krypton/analyses/*/*/*/ (unfiltered), build AnalysisBundle list.
4. Render index into ANALYSES_HTML shell (grouped list + link to each /analysis).
5. User clicks an issue → GET /analysis?harness=&issue=owner/repo/number.
6. render_analysis_bundle(): validate the dir under analyses_root, read each .md,
   render_markdown_doc, concatenate; build asset strip with <img src="/analysis-asset?…">.
7. Images load via handle_analysis_asset → validate_doc_path(analyses_root, path,
   IMAGE_EXTS) → bytes with nosniff/no-store headers.
```

### Keybindings

None new. `#analyses` is a composer hash command; it also appears in the command
palette (`analyses.open`) which is reachable via the existing palette keybinding.

### UI Changes

- New `src/acp/artifact-analyses.html`: same two-pane Binance-dark shell as
  `artifact-docs.html` (sidebar = grouped issue list, main = rendered bundle). Reuse
  the docs page CSS classes. **No left accent borders** — group headers use heading
  color / background tint per `DESIGN.binance.md` and user preference.
- Index rows show `owner/repo#number`, a relative "modified" time, the count of `.md`
  files, and a ↗ link to `https://github.com/<owner>/<repo>/issues/<number>`.
- Bundle page shows each `.md` under an `<h2>` with the filename, then its rendered
  body, then an "Attachments" strip of inline images.

### Configuration

None.

## Edge Cases

- **No harness working dir / no `.krypton/analyses`** → index renders the standard
  "No analyses yet." welcome panel (mirror docs empty state).
- **Bundle dir with zero `.md`** (only downloaded assets, analysis not written yet) →
  still listed on the index (shows "0 analyses — resources only"); bundle page shows
  just the asset strip.
- **Malformed folder depth** (not exactly `analyses/<owner>/<repo>/<number>`) → skip;
  only 3-level leaves under `analyses/` are treated as bundles.
- **Path traversal / symlinks / non-image asset requested via `/analysis-asset`** →
  `validate_doc_path` rejects (400/404), same guard as `/doc-asset`.
- **Very large logs among assets** → not rendered inline; only listed by name.
- **Multiple harnesses** → index groups by harness like `/docs` (harness selector in
  the query), so two repos' analyses don't collide.

## Open Questions

None. (Live issue_progress phase is intentionally excluded — see Out of Scope.)

## Out of Scope

- Showing the **live `issue_progress` phase / lane binding** on the viewer — that
  state is frontend-only; the surface stays a pure filesystem reader.
- **Live-reload polling** (`/doc-state`-style sha256) — analyses are read after the
  lane finishes; a manual browser refresh suffices for MVP. Can be added later.
- **Editing / feedback round-trip** (`/doc-feedback`-style) — read-only viewer.
- **Downloading non-image assets** — listed by name only in MVP.
- Any change to how `#analyze-github-issue` writes the bundle (spec 191 owns that).

## Resources

- Krypton `docs/191-composable-verbs-github-issue-toolset.md` — defines the verb and
  the `.krypton/analyses/<owner>/<repo>/<number>/` bundle location + gitignore rule.
- Krypton `docs/178-github-issue-fixing.md`, `docs/190-issue-progress-auto-bind.md` —
  issue↔lane binding + `issue_progress` (context for why phase is frontend-only).
- `src-tauri/src/hook_server.rs` Docs-browser handlers (`:852`, `:897`, `:1720`,
  `:4049`, `:4077`) — the serving/rendering template mirrored here.
- `DESIGN.binance.md` — shared visual identity for loopback browser surfaces.
