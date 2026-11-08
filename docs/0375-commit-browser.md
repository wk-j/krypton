# Commit Browser — Implementation Spec

> Status: Implemented
> Date: 2026-11-08
> Milestone: Git — learning from history
> Builds on: 0038 (Diff View, `openDiffFromString`) · 0039 (Markdown Viewer) · 0144 (`#wiki` one-shot prompt injection) · 0372 (in-process `lane.send` caller) · ADR 0003 (lanes write the document with their own tools)
> Updated: 2026-11-08 — the explainer is a blog post with inline SVG figures, replacing the Terms / Story / cards sections
> Updated: 2026-11-08 — the explainer runs as a background job, spec 0376

## Problem

Krypton has no way to look through a repository's commit history, and nothing that turns a commit
into knowledge someone can learn from. The user wants to pick a commit and get an explainer that a
reader with no systems background can follow: a blog post that tells one connected story, with
pictures, written as general technical knowledge that does not depend on the project's own details.

## Solution

Two parts:

- **Commit Browser** is a new keyboard-driven content view (`Leader E`). It lists the focused repo's
  commits with a preview pane. `d` opens a commit's diff in the existing Diff View. `e` queues a
  background job that explains the commit; no Harness is needed ([spec 0376](0376-commit-explainer-background-job.md)).
- **`#learn <sha>`** is a new Harness composer command, following the same one-shot injection
  pattern as `#wiki`, `#lesson` and `#daily`. The lane reads the commit with its own tools, checks
  the claims outside the project (a small repro or a documentation check), and writes one markdown
  explainer to a path that Rust resolves. The explainer is a blog post: an opening that tells the
  whole story, the story itself with each concept explained where it first matters, inline SVG
  figures, general lessons, then how the claims were checked and the source.

Originally the work ran on a Harness lane, because the headless fence (`headless-fence.ts`) refuses
tool permissions and file writes. *Superseded by spec 0376:* the browser's `e` now runs an
app-level background job with its own ACP process and scratch dir; only `#learn` still uses a lane.

## Research

- **No history UI exists.** The only `git log` in the app is `journal.rs:626 collect_commits` (daily
  digest). `git.rs` has `run_git` / `run_git_capped` (5 s kill, 2 MiB cap, `GIT_OPTIONAL_LOCKS=0`).
  The native-output gate (`git_rerun_tokens`) refuses `git show` and `git log`, so we need new
  commands rather than a widened gate.
- **The Diff View already renders any diff.** `compositor.openDiffFromString(diff, title)`
  (`compositor.ts:5440`) shows a static unified diff with diff2html, the full key set and `?` help.
- **One-shot lane prompts are established.** `#wiki`, `#lesson` and `#daily` call
  `enqueueSystemPrompt(lane, prompt, undefined, label)` on an idle lane. `#daily` has Rust resolve
  the output path (`daily_write_path`) and names it in the prompt. The lane writes the file. ADR 0003:
  the harness supplies discipline, not storage.
- **Cross-view in-process calls go through the directory.** The prompt dialog calls
  `harnessEntry(id).control('lane.send', …, {source:'prompt_dialog'})` (spec 372). `lane.send` sends
  the text as a literal user prompt and does not dispatch `#` commands, so this spec first added a
  dedicated op instead of sending `#learn` through it (superseded by spec 0376: the op is removed and
  the browser no longer calls the Harness).
- **Showing a runtime file.** `openMarkdownView(absPath)` already opens files produced at runtime
  (lessons index, daily note). Its file list always comes from the focused cwd, so the library view
  needs a root override.
- **Rejected alternatives** (at the time; superseded by spec 0376, which runs a dedicated ACP
  process per job):
  - *Headless `InlineAcpSession`* streams and needs no Harness, but the fence blocks verification.
  - *`AcpAssistSession`* keeps one session forever, so context leaks across commits, and caps a run
    at 20 s.
  - *Storing in the target repo (`docs/wiki/`)* would commit personal learning notes into every
    project the user browses.
- **Commit sizes in this repo** (last 300): p50 295, p90 2,833 changed lines. Whole diffs are too
  big to inline into a prompt, so the lane fetches only the parts it needs itself.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| GitLens (VS Code) | Commit Graph is the main entry point. ✨ *Explain Commit* sits next to the commit message and renders "intent and impact" as markdown. Providers: Copilot, GitKraken AI, Ollama, OpenRouter. | Pro feature. One-off summary, not stored, project-specific. |
| JetBrains AI Assistant | Git log → select one or more commits → right-click *Explain Commit with AI Assistant* → summary appears in the AI chat window. | Mouse-first. No stored output, no options. |
| GitHub Copilot (github.com) | Open a commit page and ask Copilot Chat "what does this commit do?". Follow-up questions are allowed. | Chat answer, not saved. |
| lazygit | Commits panel: `j`/`k` move, `Enter` drills into the commit's files, `/` searches, `<c-o>` copies the hash. | Keyboard model for the list. No AI. |
| tig | Main view lists commits, `Enter` opens the diff view, `m`/`d` switch views. | Same list → diff split. No AI. |

**Krypton delta:**
- *Matches convention:* the list/preview layout and keys (`j`/`k`, `/`, `Enter` → diff) follow
  lazygit and tig.
- *Diverges:* the existing tools all **summarize the commit for this project** in a chat answer
  that disappears. Krypton writes a **stored, project-independent blog post**: concepts explained
  with everyday analogies where the story needs them, SVG figures, the general lessons with their
  limits, and claims checked outside the repo. No market tool verifies a commit's claims or strips
  project detail. That part is novel.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/git.rs` | `git_log_page`, `git_commit_diff` helpers (parse, cap) + unit tests |
| `src-tauri/src/knowledge.rs` (new) | knowledge dir resolution, `knowledge_write_path`, `knowledge_list` + tests |
| `src-tauri/src/commands.rs`, `lib.rs` | four commands (`spawn_blocking`), registration |
| `src-tauri/src/config.rs` | `[knowledge]` section (`dir`, `language`) |
| `src/commit-browser-view.ts` (new) + `.test.ts` | the view |
| `src/styles/commit-browser.css` (new), `src/styles/index.css` | view sheet (BEM, `--mat-*` tokens) |
| `src/types.ts` | `'commit_browser'` in `PaneContentType` |
| `src/compositor.ts` | `openCommitBrowser()`, `openMarkdownAt(root, file?)`. `buildMarkdownView` gains a `root` option for the library. |
| `src/input-router.ts`, `src/which-key.ts`, `src/command-palette.ts` | `Leader E`, which-key row, palette `git.commit-browser` |
| `src/config.ts` | `knowledge?: { dir, language }` on the TS `KryptonConfig` |
| `src/acp/harness-prompts.ts` | `learnCommitPrompt()` |
| `src/acp/acp-harness-view.ts` | `#learn` command |
| `src/acp/hash-commands.ts` | `learn` row and its command metadata (the composer palette's source of truth) |
| `src/acp/components/help-overlay/index.ts` | `#learn <sha>` row |
| `docs/0004-architecture.md`, `docs/0006-configuration.md`, `docs/0072-acp-harness-view.md`, `docs/README.md` | view, commands, config, command, index |

## Design

### Data Structures

```rust
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: String, pub short_sha: String, pub author: String, pub at: i64, // unix secs
    pub subject: String, pub body: String,   // body without trailers (Co-Authored-By etc.)
    pub is_merge: bool, pub files: u32, pub added: u32, pub removed: u32,
}
pub struct GitLogPage { pub repo_root: String, pub repo_name: String,
    pub branch: Option<String>, pub commits: Vec<CommitSummary>, pub has_more: bool }
pub struct KnowledgeDoc { pub repo: String, pub short_sha: String, pub path: String }
pub struct KnowledgeIndex { pub dir: String, pub docs: Vec<KnowledgeDoc> }
```

```ts
type RowLamp = 'none' | 'pending' | 'ready';   // explainer state per commit
interface CommitRow { summary: CommitSummary; candidate: boolean; lamp: RowLamp }
```

### API / Commands

| Command | Signature | Notes |
|---|---|---|
| `git_log_page` | `(cwd, skip: u32, limit: u32) -> GitLogPage` | `log --numstat --diff-merges=first-parent --format=%x1e%H%x1f%P%x1f%an%x1f%ct%x1f%s%x1f%b%x1d --skip --max-count`, via `run_git_capped`. `limit` clamped to 1..=500; git is asked for `limit + 1` rows so `has_more` needs no second call. A merge's stat is against its first parent. An unborn `HEAD` is an error, so an empty repo never opens. |
| `git_commit_diff` | `(cwd, sha) -> String` | `show --format= -M --no-ext-diff --no-color --diff-merges=first-parent <sha>`. Over the 2 MiB cap → `Err("commit diff too large")`. `sha` must be 4–40 hex characters, so it can never be read as a git option. |
| `knowledge_write_path` | `(cwd, sha) -> String` | Verifies `<sha>^{commit}` and returns `<dir>/<repo_name>-<sha7>.md`, creating `dir`. |
| `knowledge_list` | `() -> KnowledgeIndex` | Scans `dir` for `*-<7 hex>.md`. A missing dir gives an empty list. |

`#learn <sha>` reserves the lane (`lane_busy`, a control error code, when it is not free).
The Commit Browser no longer reaches the Harness; see spec 0376 for the background job
(`knowledge_job_prepare`, `knowledge_store`).

### Data Flow

```
1. Leader E → compositor.openCommitBrowser(): local workspace only, focused cwd must be a repo;
   an existing browser for the same repo root is focused instead of opened again; the compositor
   fetches git_log_page(root, 0, 200) first, so a non-repo or an empty repo never opens a view
2. view → invoke knowledge_list() → lamp 'ready' when a doc matches (repo_name, first 7 of the
   sha); preview = selected row's message + stat (no IPC)
3. d / Enter → invoke git_commit_diff → compositor.openDiffFromString(diff, `COMMIT // <sha7>`)
4. e / E → CommitExplainer.enqueue (spec 0376): the job runs in its own ACP process, outlives the
   browser, and stores `<dir>/<repo>-<sha7>.md` via knowledge_store
5. row lamp → 'pending' while queued or running; x cancels it
6. job done → lamp 'ready' + toast "Explainer ready — <repo>@<sha7>"; failure → lamp 'none' +
   toast "Explain <repo>@<sha7> failed — <message>"
7. o → Markdown Viewer rooted at the knowledge dir, on this commit's file
   L → the same viewer with no file selected
   o on a row without an explainer → notify "No explainer for <sha7> yet — e explain"
```

### The explainer contract (`learnCommitPrompt`)

The prompt is the schema, the same way `#wiki`'s prompt is. It tells the agent (a `#learn` lane, or
the background job's own process — spec 0376):

1. Read the commit with `git show --stat <sha>`, then only the hunks it needs. Read a referenced
   spec or doc only when the message points to it.
2. Keep the hunks that carry transferable knowledge (a workaround, defensive code, a "why"
   comment, a negative test). Skip wiring, renames, styling and docs.
3. Write in `[knowledge] language` (code, identifiers and commands stay English) for a reader who
   uses a computer every day (files, folders, apps, a terminal, git) but has **no systems
   background**, as a **blog post**: connected prose where each paragraph follows from the one
   before. The lane composes in that language from the start, like a native technical writer, not
   by translating English sentences: native rhythm, no carried-over English idioms or sentence
   shapes, and technical terms left in English rather than invented local words or parenthetical
   glosses. Paragraphs, not bullet lists, except in the last two sections. Earlier parts are
   referred to by what happened, never by number, and no sentence exists only to point at other
   parts. In this order:
   - Front matter: `title` (a headline stating one general principle, no project names),
     `source: <repo>@<sha7>`, `subject`, `created`, `tags`.
   - **Opening**: one paragraph with the whole story in brief (what the software needed, what went
     wrong or changed, how the commit dealt with it).
   - **The story** in the order it happened, under headings the lane chooses. Each concept the
     reader needs (3–7 at most) is explained in plain words with an everyday analogy where the story
     first needs it, not in a glossary up front. Everyday computing words (file, folder, path, code,
     function, program, git, commit, sha, diff, build) are never explained. Project parts are called
     by their role ("the terminal app"), not their name.
   - **Lessons**: 2–5 general lessons, each a short headed section of prose: the principle, the
     moment in the story that shows it, the evidence checked, where it does not apply, a generic
     example (≤ 8 lines, no project identifiers) and one closing self-check question.
   - **How this was checked**: a table of claim → how it was checked → result. Repros run only under
     `$TMPDIR/krypton-learn/<sha7>/`. Every commit claim that could not be confirmed or was
     contradicted is listed.
   - **Source**: sha, subject, files touched.
4. Explain with pictures: at least one SVG figure (the before/after of the problem and the fix), at
   most 3, each placed where the story reaches it after a sentence saying what to compare. A figure
   is raw HTML in the markdown, not a code fence: `<p><svg viewBox width style="max-width:100%;
   height:auto" role="img" aria-label>…</svg></p>` with no blank line inside, since a blank line
   ends a markdown HTML block. `<p>` is a CommonMark block tag, so marked passes the whole figure
   through as one raw HTML block that renders as a `<p>`. A bare `<svg>` breaks the Markdown Viewer
   one of two ways: alone on its first line it is an HTML token with no `p, pre, h1…` element, so
   `annotateBlocksWithRaw` pairs every later block with the wrong source; with content after the
   open tag it is a paragraph, and `breaks: true` inserts `<br>` tags that end the SVG early. The
   figure is self-contained and inert: no `<script>`, `on*` attribute, `<foreignObject>`, or
   external link, image or font. Text and lines use `currentColor`, plus at most two accent colours
   as strokes or fills at opacity ≤ 0.25, so it reads on dark and light themes. Every id carries a
   per-figure prefix (`f1-arrow`), because all figures of a post share one page and a repeated id
   resolves to the first figure's.
5. Never modify the repository, commit, or write anywhere except `<path>` and the scratch dir.
6. If the commit carries no transferable knowledge, write a short post that says so, with no
   Lessons section. Never invent knowledge to fill the template.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader E` | Compositor mode | Open Commit Browser (today `Leader E` does nothing) |
| `j` / `k`, `g` / `G` | Commit Browser | Move; `G` at the end loads the next 200 (`skip`) |
| `/` | Commit Browser | Filter by subject, author or sha (client-side on loaded rows). `Esc` clears. |
| `c` | Commit Browser | Show only candidates |
| `d` / `Enter` | Commit Browser | Open the commit's diff in a Diff View tab |
| `e` | Commit Browser | Explain in the background (spec 0376). On a `ready` row it flashes "already explained — o open · E regenerate". |
| `E` | Commit Browser | Regenerate (overwrites the doc) |
| `x` | Commit Browser | Cancel a queued or running explainer |
| `o` / `L` | Commit Browser | Open this commit's explainer / open the knowledge library (both in a Markdown Viewer rooted at the knowledge dir) |
| `y` / `r` / `?` / `q` `Esc` | Commit Browser | Copy sha / reload / help / close |
| `#learn <sha>` | Harness composer | Explain a commit from the lane directly (idle lane, project dir required) |

A **candidate** is a commit with a `fix` or `perf` subject type, at least 2 body lines that are not
trailers, `added + removed ≤ 200`, and not a merge. This is a hint lamp, not a judgement.

### UI Changes

One plate, split into list and preview (no nested panels):
`.commit-browser` › `__head` (repo · branch · count · filter readout) · `__list` › `__row`
(`__lamp`, `__sha`, `__age`, `__type` chip, `__subject`, `__stat`) · `__preview` (message, file stat,
key legend).
- The selection is the row background. The `pending` / `ready` / candidate states light only the
  row's lamp, never the whole row.
- `pending` is a steady amber lamp (`--mat-lens-on`), `ready` a steady green lamp
  (`--krypton-success-rgb`) and a candidate a steady blue lamp (`--krypton-info-rgb`). A row shows
  one lamp: pending, then ready, then candidate. No `infinite` animation.
- Paths and subjects keep their case. Chrome labels use the label typography.
- Rows are rendered once per page with `reconcile()`. Filtering toggles row `hidden`, so rows are
  not rebuilt.

### Configuration

```toml
[knowledge]
dir = "~/.config/krypton/knowledge"  # absolute or ~/ path; may point into an Obsidian vault
language = "Thai"                    # prose language of explainers; code stays English
```

Read at startup; **Reload Config** applies.

## Edge Cases

- **Not a repo, empty repo, or SSH workspace:** notify and do not open (`blockLocalViewForRemote`).
- **Merge commit:** diff against the first parent, `merge` chip, never a candidate.
- **Diff over 2 MiB:** `d` notifies "commit diff too large". `e` still works because the agent reads
  the commit itself.
- **Explain while one is already queued or running:** notice "`<sha7>` is already explaining — x cancel".
- **Browser closes while pending:** the job keeps running; the toast still fires.
- **Knowledge dir unwritable:** the `knowledge_job_prepare` / `knowledge_store` (or, for `#learn`,
  `knowledge_write_path`) error is shown (job failure toast or flash).
- **Same repo name in two places:** docs share the `<repo>-<sha7>` namespace. A collision needs the
  same name and the same sha7, which is accepted as negligible.
- **WebContent reload:** the browser is not restored (absent from `workspace-recovery.ts`
  `CONTENT_TYPES`). Reopen it with `Leader E`.
- **Figures outside the Markdown Viewer:** the figures are raw HTML, so a renderer that drops raw
  HTML shows none and a plain-text reader sees SVG source.

## Open Questions

None. Decisions taken: the explainer runs as a background job (spec 0376; originally a lane, which
needed an open Harness), explainers are stored in a global dir, prose language is Thai by config,
and the view opens with `Leader E`.

## Out of Scope

Explaining several commits at once, a branch graph, file/author history, any write to git
(checkout, revert, rebase), spaced-repetition export, SSH/remote repos.

## Resources

- [GitLens 17.1 — visual history](https://gitkraken.com/blog/gitlens-17-1-visual-history-reimagined) — Explain Commit placement and markdown output
- [GitLens docs — Home view / Commit Graph](https://help.gitkraken.com/gitlens/home-view/) — Commit Graph as the main entry point, Explain as a Pro AI feature
- [JetBrains AI Assistant — AI in VCS integration](https://jetbrains.com/help/ai-assistant/ai-in-vcs-integration.html) — multi-select → Explain Commit → chat summary
- [JetBrains tip — Explain selected commits](https://jb.gg/guide/ai/tips/explain-commits/) — the same flow from the log
- [GitHub changelog 2024-05-31 — Copilot knows commits](https://github.blog/changelog/2024-05-31-github-copilot-enterprise-copilot-knows-about-repositories-releases-commits-more-may-2024-updates/) — chat-based commit explanation
- [lazygit keybindings](https://sources.debian.org/src/lazygit/0.57.0%2Bds1-1/docs/keybindings/Keybindings_en.md) — commits panel key model
- [tig manual](https://manpages.debian.org/jessie/tig/tigmanual.7.en.html) — main view → diff view model
