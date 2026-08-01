# Assistant Reference Git State — Implementation Spec

> Status: Draft
> Date: 2026-08-01
> Milestone: M-ACP — Harness convergence

## Problem

The assistant-response reference rail identifies files and opens them in Helix,
but it does not show whether a referenced file differs from the repository
baseline or how large that change is. Users must leave the response context and
open the Git Dashboard or run Git commands to learn whether a referenced file is
modified, added, deleted, renamed, untracked, or conflicted.

## Solution

Decorate each changed file reference with its live working-tree state and a
per-file line summary such as `M +12 −3`. Counts compare the combined staged and
unstaged working tree against `HEAD`; an unborn repository compares against the
empty tree. A lightweight Tauri command collects only status and numstat data,
plus bounded line counts for referenced untracked text files, without building
or returning a unified diff.

The harness refreshes metadata when references seal, after successful file
writes, when a lane becomes idle, and when the user presses `r` in transcript
command mode. Git metadata is additive: URL references, clean files, files
outside the active repository, and collection failures retain the existing
reference-row behavior.

## Research

- `git status --porcelain=v1 -z --untracked-files=all` is stable for scripts,
  repository-root-relative, immune to user color/path configuration, and
  NUL-delimited for unusual filenames. Rename records put the destination path
  before the source path in `-z` mode.
- `git diff -M --numstat -z <base>` returns machine-readable additions and
  deletions. Binary records use `-` for both counts, which must not be rendered
  as a misleading `+0 −0`.
- `git diff <base>` compares both the index and working tree to the base. It is
  therefore the right single total for Krypton's compact reference row. A
  staged-then-edited file remains fully represented.
- Krypton already has three related paths, but none is suitable unchanged:
  `src/dashboards/git.ts` parses status without line counts;
  `acp_collect_review_git_state` also builds a capped unified diff and untracked
  excerpts; `collect_working_diff` synthesizes complete untracked diffs. Running
  either diff-producing collector at every lane quiet point would do unnecessary
  I/O and IPC work.
- `AcpHarnessView.setLaneStatus()` already publishes a quiet-point signal on
  transitions to `idle`. The same transition can schedule a local metadata
  refresh without adding a timer or filesystem watcher.
- The spec-206 reference row already has a stable `MessageResource.target`, a
  render signature, responsive grid states, delegated open actions, and a
  unified `f` hint mode. Git metadata should extend that row instead of creating
  a second panel or another interaction mode.

### Alternatives rejected

- **Call `acp_collect_review_git_state`:** reuses the current diffstat but also
  generates and transfers a unified diff plus untracked excerpts. That is too
  heavy for routine UI refresh and reports untracked line counts as zero.
- **Call `collect_working_diff` and parse patches in TypeScript:** duplicates Git
  parsing in the frontend and transfers file contents when the UI needs only a
  few integers.
- **Run Git once per reference row:** simple locally, but scales with transcript
  length and can launch dozens of processes after one response.
- **Poll continuously:** notices external edits quickly but spends CPU while the
  harness is idle. Event-driven refresh plus a manual key matches Krypton's
  latency and idle-CPU constraints.
- **Separate staged and unstaged counts:** more detailed, but four numbers per
  row make the rail harder to scan. The state badge retains change identity while
  one combined total answers the requested blast-radius question.
- **Snapshot state when the message seals:** historically precise but becomes
  stale as the agent continues working. The rail is an action surface, so current
  state is more useful than historical state.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| VS Code | Explorer, tabs, and Source Control rows carry `U`, `M`, and `D` decorations; staged and unstaged files are grouped separately | Establishes compact text status as a familiar file-row convention |
| Zed | Project Panel tints changed names and optionally adds `M`, `A`, `D`, `U`, or `!`; Git Panel reflects working-tree and staging state | Closest keyboard-first editor precedent for a status badge beside a path |
| GitHub | Changed-file data exposes status, additions, and deletions per file; diff views pair green `+` and red `-` semantics | Establishes per-file `+N / -N` as a compact change-size summary |
| Krypton Git Dashboard | Shows branch and status badges from porcelain output, but no per-file numstat | Existing local vocabulary to preserve |

**Krypton delta:** keep the existing flat `REFERENCES` rail and add only the
metadata needed at the moment a user chooses a file. Unlike full source-control
panels, the rail does not stage, revert, filter, or open a diff. It stays
keyboard-addressable through the existing `f` hints, while `r` refreshes its Git
metadata explicitly.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/git.rs` | Add the lightweight reference-file Git collector, NUL-safe parsers, bounded untracked line counting, and Rust tests |
| `src-tauri/src/commands.rs` | Expose `collect_reference_git_state` as a Tauri command |
| `src-tauri/src/lib.rs` | Register the new command |
| `src/acp/types.ts` | Add the reference Git snapshot/state types |
| `src/acp/harness-view-types.ts` | Attach optional live Git metadata to file resources |
| `src/acp/acp-harness-view.ts` | Schedule/tokenize refreshes, apply snapshots, handle manual `r`, and clean up timers |
| `src/acp/harness-transcript-render.ts` | Include Git metadata in signatures, row DOM, title, and accessible label |
| `src/acp/acp-harness-view.test.ts` | Test metadata formatting, signature invalidation, and key routing |
| `src/styles/acp-harness.css` | Add compact state/count styles and responsive grid behavior |
| `docs/02-functional-requirements.md` | Add the reference Git-state requirement |
| `docs/04-architecture.md` | Record the lightweight collector and volatile row metadata |
| `docs/05-data-flow.md` | Document collection, refresh, and stale-response handling |
| `docs/72-acp-harness-view.md` | Document badges, counts, refresh semantics, and `r` |
| `docs/PROGRESS.md` | Record completion after implementation and validation |

## Design

### Data Structures

Rust returns one entry only for requested file references that currently have a
Git change:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceGitSnapshot {
    pub repo_root: String,
    pub changes: Vec<ReferenceGitChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceGitChange {
    pub target: String,          // original absolute MessageResource target
    pub status: String,          // M | A | D | R | ? | !
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub count_kind: String,      // lines | binary | unavailable
}
```

The frontend mirrors that payload and keeps the metadata on the resource so the
existing transcript render signature can invalidate exactly the affected row:

```ts
export type ReferenceGitStatus = 'M' | 'A' | 'D' | 'R' | '?' | '!';
export type ReferenceGitCountKind = 'lines' | 'binary' | 'unavailable';

export interface MessageResourceGitState {
  status: ReferenceGitStatus;
  added: number | null;
  removed: number | null;
  countKind: ReferenceGitCountKind;
}

export interface ReferenceGitSnapshot {
  repoRoot: string;
  changes: Array<MessageResourceGitState & { target: string }>;
}

// Added to MessageResource:
git?: MessageResourceGitState;
```

`MessageResource.key`, target normalization, deduplication, opening, and hinting
remain unchanged. Git metadata is volatile and is never added to cached Markdown
HTML.

### API / Commands

```rust
#[tauri::command]
pub fn collect_reference_git_state(
    cwd: String,
    paths: Vec<String>,
) -> Result<ReferenceGitSnapshot, String>;
```

Command behavior:

1. Reject an empty cwd and resolve the repository root with the existing
   `git::repo_root` helper.
2. Normalize and deduplicate requested absolute paths. Ignore paths that are not
   lexically below the repository root; do not canonicalize because deleted
   references no longer exist on disk.
3. Resolve `HEAD`, or derive the empty-tree object for an unborn repository.
4. Run `git status --porcelain=v1 -z --untracked-files=all` and
   `git --no-pager diff --no-ext-diff --no-textconv -M --numstat -z <base>`.
5. Parse NUL-delimited status and numstat records, including rename destination
   paths and binary `-` counts. Filter the result to requested paths.
6. For requested untracked files up to the existing 1 MiB untracked cap, read
   bytes once, use the existing null-byte binary sniff, and count newline bytes
   plus a final unterminated line. Empty files report `+0 −0`. Larger or
   unreadable files report `countKind: unavailable` without reading contents.
7. Return no entry for clean files. Git failure returns `Err`; the frontend
   removes stale metadata and keeps the reference row usable.

Status precedence is `!` conflict, `?` untracked, `R` renamed, `D` deleted, `A`
added relative to the base, then `M` modified. This intentionally collapses the
porcelain XY pair into one compact state while numstat remains the combined
working-tree total against the base.

### Data Flow

1. A typed resource or explicit Markdown file anchor seals into a
   `MessageResource` as specified by spec 206.
2. `AcpHarnessView` schedules a 150 ms debounced Git refresh when a sealed row
   contains file resources. Successful `fs_activity` writes and lane transitions
   to `idle` schedule the same refresh.
3. The refresh gathers unique file targets across live lane transcripts and
   calls `collect_reference_git_state` once for the project.
4. A monotonically increasing request token discards responses older than the
   most recently started refresh. `dispose()` clears the timer and invalidates
   pending responses.
5. The view clears old metadata for the requested targets, applies returned
   changes by exact absolute target, and calls `render()` only if a resource's
   visible metadata changed.
6. `transcriptRenderSignature()` includes status, counts, and count kind. The
   normal transcript renderer rebuilds the affected sealed row without touching
   cached Markdown.
7. Pressing `r` in transcript command mode runs an immediate refresh. Success
   flashes `reference status refreshed`; no file references flashes
   `no file references`; failure flashes `reference status unavailable`.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `r` | ACP Harness transcript command mode | Refresh Git state and line counts for all file references |

The existing `f` open-hint mode and all open actions are unchanged.

### UI Changes

Changed file rows gain one compact metadata group before the existing action:

```text
FILE  M   message-resources.ts       +267  −12   OPEN TAB ↗
FILE  ?   message-resources.test.ts  +144   −0   OPEN TAB ↗
FILE  D   obsolete.ts                   +0  −86   OPEN TAB ↗
FILE  M   image.dat                         BIN   OPEN TAB ↗
```

- Status is a short, bordered text badge. Color supports but never replaces the
  character: warning for `M`, success for `A`, cyan for `?`, danger for `D`/`!`,
  and special for `R`.
- Additions use the success color and deletions use the danger color. Both use
  `font-variant-numeric: tabular-nums` and always retain their sign.
- Binary files render `BIN`; oversized or unreadable untracked files render
  `N/A`. Their title and accessible label explain why line counts are absent.
- Clean, out-of-repository, and URL rows render an empty metadata cell so the
  existing right-aligned action stays aligned across the rail.
- Normal rows use `auto minmax(0, 1fr) auto auto`; hinted rows prepend the hint
  column. At the existing 680 px breakpoint the action remains hidden while Git
  metadata stays visible.
- The button title and `aria-label` include the expanded status name and count
  summary, for example `Modified, 12 lines added, 3 lines removed`.
- No new animation, nested surface, side accent rail, or mouse-only affordance
  is introduced.

## Edge Cases

- **No repository / file outside root:** omit Git metadata; opening still works.
- **Clean after commit or revert:** the next refresh removes the previous badge
  and counts.
- **Staged plus unstaged edits:** one total against `HEAD`; the compact badge does
  not claim which portion is staged.
- **Unborn repository:** staged files compare to the derived empty tree;
  untracked references use bounded direct line counting.
- **Untracked empty file:** show `? +0 −0`.
- **Tracked or untracked binary:** show the state badge plus `BIN`.
- **Oversized or unreadable untracked file:** show the badge plus `N/A`.
- **Mode-only change:** show the state badge and `+0 −0`.
- **Rename:** associate numstat with the destination path. A reference to the old
  path receives no metadata and may fail the existing file-open action.
- **Conflict:** show `! N/A` unless Git provides usable numstat counts.
- **Filename with whitespace, tabs, newlines, or ` -> `:** NUL-safe parsing keeps
  the exact path; no line-oriented status parser is used.
- **Rapid lane events:** debounce coalesces work; request tokens prevent an older
  snapshot overwriting a newer one.
- **Collector failure:** clear volatile metadata, preserve references, and avoid
  an automatic toast. Manual `r` reports the failure in the existing status chip.
- **External edits while the harness is completely idle:** metadata updates on
  manual `r` or the next harness reference/write/quiet-point event. Continuous
  filesystem watching is out of scope.

## Validation

- Rust unit tests cover modified, added, deleted, renamed, conflicted, untracked,
  binary, empty, missing-final-newline, oversized, unborn-HEAD, unusual-filename,
  outside-root, and clean-transition cases.
- TypeScript tests cover display text, accessible labels, render-signature
  invalidation, stale-response rejection, clearing after a clean snapshot, and
  `r` routing without disturbing `f` hint mode.
- Run `cargo fmt -- --check`, `cargo test`, `cargo clippy -- -D warnings`,
  `npm run check`, focused ACP tests, full Vitest, `npm run build`,
  `git diff --check`, and `/perf-checklist acp-harness-view`.
- Visually verify wide, hinted, narrow, clean, binary, and unavailable rows in
  the running ACP Harness. Confirm action-column alignment and keyboard focus.

## Open Questions

None. The combined working-tree count, live refresh behavior, status vocabulary,
and unavailable-count fallback are resolved for approval.

## Out of Scope

- Separate staged and unstaged line totals
- Inline diff preview, opening the Diff Window, staging, reverting, or committing
- Git state for URL references or files outside the active project repository
- Nested-repository or submodule traversal beyond the active repository root
- Persistent Git metadata in transcripts or session storage
- Continuous Git polling or a new filesystem watcher
- Changing the existing Git Dashboard's parser or presentation

## Resources

- [Git status porcelain format](https://git-scm.com/docs/git-status) — stable
  XY semantics, root-relative paths, NUL mode, and rename field ordering.
- [Git diff options](https://git-scm.com/docs/diff-options) — machine-readable
  `--numstat` counts and binary `-` records.
- [Git diff output formats](https://git-scm.com/docs/diff-format) — NUL-delimited
  single-path and rename/copy numstat record shapes.
- [VS Code: Staging and committing changes](https://code.visualstudio.com/docs/sourcecontrol/staging-commits) — file status letters, staged/unstaged grouping, and source-control decoration conventions.
- [Zed Project Panel: Git Integration](https://zed.dev/docs/project-panel#git-integration) — optional letter badges for modified, added, deleted, untracked, and conflicted files.
- [Zed Git documentation](https://zed.dev/docs/git) — live working-tree and staging-state behavior in a keyboard-first editor.
- [GitHub pull-request files API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files) — per-file status, additions, deletions, and total changes as a familiar review data shape.
