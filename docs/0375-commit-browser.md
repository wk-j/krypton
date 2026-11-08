# Commit Browser — Implementation Spec

> Status: Draft
> Date: 2026-11-08
> Milestone: Git — learning from history
> Builds on: 0038 (Diff View, `openDiffFromString`) · 0039 (Markdown Viewer) · 0144 (`#wiki` one-shot prompt injection) · 0372 (in-process `lane.send` caller) · ADR 0003 (lanes write the document with their own tools)

## Problem

Krypton has no way to look through a repository's commit history, and nothing that turns a commit
into knowledge someone can learn from. The user wants to pick a commit and get an explainer that a
reader with no systems background can follow (terms first, then the story), written as general
technical knowledge that does not depend on the project's own details.

## Solution

Two parts:

- **Commit Browser** is a new keyboard-driven content view (`Leader E`). It lists the focused repo's
  commits with a preview pane. `d` opens a commit's diff in the existing Diff View. `e` asks an ACP
  Harness lane to explain the commit.
- **`#learn <sha>`** is a new Harness composer command, following the same one-shot injection
  pattern as `#wiki`, `#lesson` and `#daily`. The lane reads the commit with its own tools, checks
  the claims outside the project (a small repro or a documentation check), and writes one markdown
  explainer to a path that Rust resolves. The explainer follows a fixed shape: Terms → Story →
  General knowledge cards → Verification → Source.

The work runs on a lane, not a headless one-shot session. The verification step has to run code,
and the headless fence (`headless-fence.ts`) refuses tool permissions and file writes. The user also
watches the lane work and can approve its repro commands.

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
  the text as a literal user prompt and does not dispatch `#` commands, so this spec adds a dedicated
  op instead of sending `#learn` through it.
- **Showing a runtime file.** `openMarkdownView(absPath)` already opens files produced at runtime
  (lessons index, daily note). Its file list always comes from the focused cwd, so the library view
  needs a root override.
- **Rejected alternatives:**
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
  that disappears. Krypton writes a **stored, project-independent learning document**: terms defined
  with analogies, the general principle with its limits, and claims checked outside the repo. No
  market tool verifies a commit's claims or strips project detail. That part is novel.

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
| `src/compositor.ts` | `openCommitBrowser()`. `buildMarkdownView` gains a `root` option for the library. |
| `src/input-router.ts`, `src/which-key.ts`, `src/command-palette.ts` | `Leader E`, which-key row, palette `git.commit-browser` |
| `src/acp/harness-prompts.ts` | `learnCommitPrompt()` |
| `src/acp/acp-harness-view.ts` | `#learn` command; `lane.learn` control op |
| `src/acp/control-types.ts` | `ControlCaller.source` += `'commit_browser'` |
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
| `git_log_page` | `(cwd, skip: u32, limit: u32) -> GitLogPage` | `log --numstat --format=%x1e%H%x1f%P%x1f%an%x1f%ct%x1f%s%x1f%b%x1d --skip --max-count`, via `run_git_capped`. `limit` clamped to 1..=500. |
| `git_commit_diff` | `(cwd, sha) -> String` | `show --format= -M --no-ext-diff --no-color --diff-merges=first-parent <sha>`. Over the 2 MiB cap → `Err("commit diff too large")`. |
| `knowledge_write_path` | `(cwd, sha) -> String` | Verifies `<sha>^{commit}` and returns `<dir>/<repo_name>-<sha7>.md`, creating `dir`. |
| `knowledge_list` | `() -> KnowledgeIndex` | Scans `dir` for `*-<7 hex>.md`. A missing dir gives an empty list. |

**Control op `lane.learn`** `{lane, sha}` → `{status:'started', path}`. Accepted only from the
in-process caller `{source:'commit_browser'}`; the `/control/v1` API, Telegram and Live Assist get
`invalid_request`. A lane that is not idle gets `lane_busy`. The op runs the same code path as
typing `#learn <sha>`.

### Data Flow

```
1. Leader E → compositor.openCommitBrowser(): local workspace only, focused cwd must be a repo;
   an existing browser for the same repo root is focused instead of opened again
2. view → invoke git_log_page(cwd, 0, 200) ‖ invoke knowledge_list() → rows; lamp 'ready' when a doc
   matches (repo_name, short_sha); preview = selected row's message + stat (no IPC)
3. d / Enter → invoke git_commit_diff → compositor.openDiffFromString(diff, `COMMIT // <sha7>`)
4. e → candidate lanes = listHarnessEntries() whose cwd is inside repo_root → listLanes() idle
   0 → notify "Open an ACP Harness in this repo (Leader Y), then press e"
   1 → send · >1 → lane picker overlay (j/k, Enter, Esc)
5. entry.control('lane.learn', {lane, sha}, {source:'commit_browser'})
   → harness: knowledge_write_path(projectDir, sha)
   → enqueueSystemPrompt(lane, learnCommitPrompt({sha, path, language}), undefined, `learning <sha7>`)
6. row lamp → 'pending'. On every `harness:lane-idle` signal the view re-runs knowledge_list:
   doc present → 'ready' + notification "Explainer ready — o to open";
   still absent after that lane went idle → 'none' + notice "lane finished without writing <file>"
7. o → compositor.openMarkdownView(path) · L → Markdown Viewer rooted at the knowledge dir
```

### The explainer contract (`learnCommitPrompt`)

The prompt is the schema, the same way `#wiki`'s prompt is. It tells the lane:

1. Read the commit with `git show --stat <sha>`, then only the hunks it needs. Read a referenced
   spec or doc only when the message points to it.
2. Keep the hunks that carry transferable knowledge (a workaround, defensive code, a "why"
   comment, a negative test). Skip wiring, renames, styling and docs.
3. Write in `[knowledge] language` (code, identifiers and commands stay English) for a reader with
   **no systems background**. Use exactly these sections:
   - Front matter: `title` (one general principle, no project names), `source: <repo>@<sha7>`,
     `subject`, `created`, `tags`.
   - **Terms**: every technical term used anywhere in the document, as `term — plain meaning —
     everyday analogy`, ordered so each term builds on the previous one. No term may appear before
     it is defined.
   - **Story**: numbered steps of what went wrong or what changed, with one ASCII before/after
     diagram. Project parts are called by their role ("the terminal app"), not their name.
   - **General knowledge**: 2–5 cards, each with Principle · Problem it solves · Where it does not
     apply · Generic example (≤ 8 lines, no project identifiers) · Verified by · Review question.
   - **Verification**: a table of claim → how it was checked → result. Repros run only under
     `$TMPDIR/krypton-learn/<sha7>/`. List every commit claim that could not be confirmed or was
     contradicted.
   - **Source**: sha, subject, files touched.
4. Never modify the repository, commit, or write anywhere except `<path>` and the scratch dir.
5. If the commit carries no transferable knowledge, write a short document that says so and has
   zero cards. Never invent knowledge to fill the template.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader E` | Compositor mode | Open Commit Browser (today `Leader E` does nothing) |
| `j` / `k`, `g` / `G` | Commit Browser | Move; `G` at the end loads the next 200 (`skip`) |
| `/` | Commit Browser | Filter by subject, author or sha (client-side on loaded rows). `Esc` clears. |
| `c` | Commit Browser | Show only candidates |
| `d` / `Enter` | Commit Browser | Open the commit's diff in a Diff View tab |
| `e` | Commit Browser | Explain. On a `ready` row it flashes "already explained — o open · E regenerate". |
| `E` | Commit Browser | Regenerate (overwrites the doc) |
| `o` / `L` | Commit Browser | Open this commit's explainer / open the knowledge library |
| `y` / `r` / `?` / `q` `Esc` | Commit Browser | Copy sha / reload / help / close |
| `#learn <sha>` | Harness composer | Explain a commit from the lane directly (idle lane, project dir required) |

A **candidate** is a commit with a `fix` or `perf` subject type, at least 2 body lines that are not
trailers, `added + removed ≤ 200`, and not a merge. This is a hint lamp, not a judgement.

### UI Changes

One plate, split into list and preview (no nested panels):
`.commit-browser` › `__head` (repo · branch · count · filter readout) · `__list` › `__row`
(`__lamp`, `__sha`, `__age`, `__type` chip, `__subject`, `__stat`) · `__preview` (message, file stat,
key legend) · `__picker` (lane overlay).
- The selection is the row background. The `pending` / `ready` / candidate states light only the
  row's lamp, never the whole row.
- `pending` is a steady amber lamp and `ready` is a steady green lamp. No `infinite` animation.
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
- **Diff over 2 MiB:** `d` notifies "commit diff too large". `e` still works because the lane reads
  the commit itself.
- **Lane becomes busy between pick and send:** `lane_busy` flash; lamp stays `none`.
- **Harness closes while pending:** the lamp stays `pending` until `r` re-reads the index.
- **Knowledge dir unwritable:** `knowledge_write_path` error is shown in the flash.
- **Same repo name in two places:** docs share the `<repo>-<sha7>` namespace. A collision needs the
  same name and the same sha7, which is accepted as negligible.
- **WebContent reload:** the browser is not restored (absent from `workspace-recovery.ts`
  `CONTENT_TYPES`). Reopen it with `Leader E`.

## Open Questions

None. Decisions taken: the work runs on a lane (needs an open Harness), explainers are stored in a
global dir, prose language is Thai by config, and the view opens with `Leader E`.

## Out of Scope

Explaining several commits at once, a branch graph, file/author history, any write to git
(checkout, revert, rebase), a headless no-Harness mode, exposing `lane.learn` on `/control/v1` or
Raycast, spaced-repetition export, SSH/remote repos.

## Resources

- [GitLens 17.1 — visual history](https://gitkraken.com/blog/gitlens-17-1-visual-history-reimagined) — Explain Commit placement and markdown output
- [GitLens docs — Home view / Commit Graph](https://help.gitkraken.com/gitlens/home-view/) — Commit Graph as the main entry point, Explain as a Pro AI feature
- [JetBrains AI Assistant — AI in VCS integration](https://jetbrains.com/help/ai-assistant/ai-in-vcs-integration.html) — multi-select → Explain Commit → chat summary
- [JetBrains tip — Explain selected commits](https://jb.gg/guide/ai/tips/explain-commits/) — the same flow from the log
- [GitHub changelog 2024-05-31 — Copilot knows commits](https://github.blog/changelog/2024-05-31-github-copilot-enterprise-copilot-knows-about-repositories-releases-commits-more-may-2024-updates/) — chat-based commit explanation
- [lazygit keybindings](https://sources.debian.org/src/lazygit/0.57.0%2Bds1-1/docs/keybindings/Keybindings_en.md) — commits panel key model
- [tig manual](https://manpages.debian.org/jessie/tig/tigmanual.7.en.html) — main view → diff view model
