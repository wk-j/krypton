# Window Diff Stat — Implementation Spec

> Status: Implemented
> Date: 2026-08-14
> Milestone: M9 — harness observability

## Problem

A window's status bar now says *which* project it is working on (spec 219), but nothing says *how
much* has changed there. In the harness workflow the human's core question between turns is "how
big is what these lanes just did to my worktree?" — and answering it costs a Diff Window open, or
a shell and `git diff --stat`, for a number that is two integers wide.

## Solution

Render the repo's uncommitted line counts — `+added −removed` — into the window's own status bar,
immediately right of the project badge and **magnified by the same factor as the lane logo and the
project drop cap**, so project, volume-of-change and active lane form one oversized glance phrase
at the rail's right end (`krypton +214 -37 ⟨logo⟩`). The counts cover the
**whole working tree against `HEAD`** (staged +
unstaged + untracked additions), come from one `git diff --numstat` in the Rust backend, and are
kept current by a **per-repo polling store** (ref-counted, single-flight, paused while the app is
hidden) plus an **instant refresh on the `harness:lane-idle` signal**, so the number lands the
moment a lane finishes a turn rather than up to one poll later. The element is absent when the
focused pane has no repo or the tree is clean.

## Research

- **The backend primitive already exists — and its definition is already owned.** `src-tauri/src/git.rs`
  owns the [[Working diff]] definition and already has `repo_root()`, `run_git()`, `looks_binary()`,
  the untracked scan (`ls-files --others --exclude-standard -z`, `UNTRACKED_MAX_BYTES = 1 MiB`) and
  a `-z` numstat parser (`parse_numstat_z`, used by spec 207's reference snapshot). This spec adds a
  fourth consumer of those primitives, not a second git integration.
- **`collect_working_diff` cannot be reused as-is.** It returns the full unified diff text
  (megabytes on a large change) and its unstaged mode is `git diff -M` — i.e. **excluding staged
  changes**, because the Diff Window offers staged as a separate view. A rail readout has no
  second view to switch to, so staged work must not silently vanish from the count: the badge diffs
  against `HEAD` instead. This is a deliberate, documented divergence from the Diff Window's split.
- **Rail plumbing exists.** `syncWindowFooter(win)` (`compositor.ts:1287`) already re-derives the
  three current readouts from the active tab's focused pane at four sync points, and
  `resolveRepoRoot(cwd)` (`compositor.ts:2559`) already exists with a `cwd → toplevel` cache built
  for exactly this matching job.
- **The polling-store shape exists.** `UsageStore` (`usage-store.ts:220`) is the established
  pattern: ref-counted `subscribe(keys, cb) → unsubscribe`, one `setInterval` per key started on
  the first subscriber and cleared on the last, singleton export. Keying by **repo root** rather
  than by window means four windows on one repo cost one git call, not four.
- **Cost measured, not guessed.** On this repo (733 tracked files) `git diff --numstat -z -M HEAD`
  plus the untracked scan is **≈30 ms wall per round**, dominated by two process spawns. At the
  chosen 4 s cadence that is ~0.7% of one core per *distinct repo with a visible window* — inside
  the idle-CPU budget only because it is deduped per repo and stopped when `document.hidden`.
  This measurement is why the cadence is 4 s and not 1 s.
- **In-repo visual precedent.** `src/dashboards/opencode.ts:302` already renders session line
  counts as `+N` in `--krypton-ansi-green` / `-N` in `--krypton-ansi-red`, and renders nothing
  when both are zero. The rail reuses that vocabulary rather than inventing a second one.
- **Alternative considered — a filesystem watcher.** Rejected for the same reason ADR-0008
  rejected it for the Diff Window, plus a new one: a watcher on a repo root means recursive
  watches over `node_modules`/`target` unless gitignore is reimplemented, which is a
  disproportionate amount of machinery for two integers. Polling a bounded, measured git call is
  cheaper to reason about and degrades gracefully.
- **Alternative considered — count only unstaged tracked changes** (`git diff --numstat`, matching
  the Diff Window's default mode exactly). Rejected: `git add` would then *reduce* the badge to
  zero, which reads as "nothing changed" at exactly the moment the most work exists.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Starship prompt (`git_metrics`) | Repo-wide added/deleted line counts in the prompt: `format = '([+$added]($added_style) )([-$deleted]($deleted_style) )'`, `added_style` bold green, `deleted_style` bold red, `only_nonzero_diffs = true` | The closest precedent — same two numbers, same colours, and its `only_nonzero_diffs` default is the "hide when clean" rule adopted below. Notably `disabled = true` **by default**, i.e. the cost of computing this per prompt is real and the project made it opt-in |
| Zed (`ui::DiffStat`) | `+ 1,234` in `Color::Success` and `‒ 56` in `Color::Error` (figure dash + thin space), small label, optional tooltip; used in the git panel header, the commit view and the project-diff header | Confirms the two-token, success/error-coloured form as the modern convention. Krypton follows the pairing but uses ASCII `-` and no digit grouping — the in-repo convention and a 28 px rail |
| vim-airline + vim-gitgutter | Hunk summary `+N ~N -N` in the statusline, from `GitGutterGetSummary()` | Three-token form including *modified*. Rejected here: git's own numstat has no "modified" class — a changed line is one `+` and one `-` — so a `~` column would have to be invented and would not match `git diff --stat` |
| Powerlevel10k / oh-my-posh vcs segments | File-level counts (staged/unstaged/untracked) plus ahead/behind arrows, not line counts | The other common answer to "how much changed"; line counts were chosen because they answer *volume of work*, which is the harness question |
| Krypton — project badge (spec 219) | Drop-capped project name at the rail's right end | The immediate neighbour and the reason this is one phrase, not a second readout |

**Krypton delta** — matches Starship's exact metric (repo-wide `+added −deleted`, hidden when
zero) but makes it **always on and free of a prompt**: Starship must ship it disabled because it
runs per prompt render in the shell's critical path, while here the cost is a background poll
deduped per repo and paused when the app is hidden. It diverges from every prompt-based precedent
by being **attached to a project name in window chrome** rather than to a shell line, so it keeps
answering while the pane shows a harness transcript, an editor, or nothing at all — and unlike
airline/gitgutter it is **repo-wide, not buffer-scoped**, because a Krypton window's subject is a
project, not a file.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/git.rs` | **New** `WorkingDiffStat` + `working_diff_stat(cwd)`; extract the untracked walk's caps so the stat and the diff agree on what counts |
| `src-tauri/src/commands.rs` | **New** `working_diff_stat` command wrapping the above |
| `src-tauri/src/lib.rs` | Register the command in `generate_handler!` |
| `src/window-footer-diff-stat.ts` | **New.** Pure formatting: counts → `{ added, removed, title } \| null` |
| `src/window-footer-diff-stat.test.ts` | **New.** Unit tests for the formatter |
| `src/diff-stat-store.ts` | **New.** Ref-counted per-repo-root polling store (mirrors `UsageStore`) |
| `src/diff-stat-store.test.ts` | **New.** Subscribe/refcount/single-flight/visibility tests |
| `src/compositor.ts` | `syncWindowDiffStat()` + `renderWindowDiffStat()` from `syncWindowFooter()`; one process-wide `harness:lane-idle` subscription driving `diffStatStore.refresh(root)`; per-window unsubscribe + cache dropped in `closeWindow()` |
| `src/styles/window.css` | `__diff-stat` / `__diff-add` / `__diff-del`, the `--krypton-window-diff-zoom` var, `order: 2`, lane strip → `order: 3`, and the un-zoom inside the existing `@container (max-width: 620px)` block |
| `docs/adr/0020-diff-stat-polls-diff-window-does-not.md` | **New.** Why this readout polls while ADR-0008 still holds for the Diff Window |
| `docs/219-window-project-badge.md`, `docs/218-window-lane-strip.md`, `docs/153-window-ai-credit-status.md` | Note the rail's fourth occupant and the new order |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | The readout and its refresh flow |
| `docs/02-functional-requirements.md` | New FR for per-window change volume |
| `docs/README.md` | Index entry 220 + ADR 0020 |

## Design

### Data Structures

```rust
// src-tauri/src/git.rs

/// Uncommitted line volume for the repo containing a cwd — the rail readout
/// behind spec 220. Deliberately carries no diff text.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiffStat {
    pub repo_root: String,
    /// Files with any change vs HEAD, including untracked and binary ones.
    pub files: u64,
    pub added: u64,
    pub removed: u64,
    /// A file's lines could not be counted (a binary tracked change, or an
    /// untracked file that is binary / >1 MiB / unreadable), or the untracked
    /// walk hit its cap — so the counts are a lower bound.
    pub truncated: bool,
}

/// `Err` when `cwd` is empty or outside a work tree — the caller drops the readout.
pub fn working_diff_stat(cwd: &str) -> Result<WorkingDiffStat, String>;
```

```ts
// src/window-footer-diff-stat.ts

/** What the rail renders. `null` for a clean tree — nothing to say, no element. */
export interface DiffStatBadge {
  added: string;    // "+214", "+1.2k", "+12k"
  removed: string;  // "-37"
  title: string;    // "working tree vs HEAD: +214 -37 across 9 files"
}

/** Counts above which the number is abbreviated (`1.2k`, then `12k` past 10k).
 *  Low, because at 2.9× every extra digit costs ~19px of rail: it caps each
 *  token at five characters, so the pair can never exceed eleven. */
export const DIFF_STAT_COMPACT_FROM = 1_000;

export function diffStatBadge(stat: WorkingDiffStat | null): DiffStatBadge | null;
```

```ts
// src/diff-stat-store.ts

/** Cadence per repo root. Measured: ≈30 ms per round on a 733-file repo, so
 *  4 s is ~0.7% of one core for a repo with at least one visible window. */
export const DIFF_STAT_POLL_MS = 4_000;

export class DiffStatStore {
  /** Ref-counted: the first subscriber for a root starts its timer and fires an
   *  immediate fetch; the last one clears it. Returns the unsubscribe. */
  subscribe(repoRoot: string, callback: () => void): () => void;
  /** Last known counts for a root, or `null` before the first fetch lands. */
  snapshot(repoRoot: string): WorkingDiffStat | null;
  /** Out-of-band refresh (lane quiet point). No-op without subscribers; coalesced
   *  against an in-flight fetch. */
  refresh(repoRoot: string): void;
}
export const diffStatStore: DiffStatStore;
```

`ContentView` needs **no new method** — `getWorkingDirectory?()` already exists.

### API / Commands

| Command | Signature | Notes |
|---------|-----------|-------|
| `working_diff_stat` | `(cwd: String) -> Result<WorkingDiffStat, String>` | Runs from the repo root. `Err("not a git repository")` outside a work tree |

Backend git invocations, in order:

1. `rev-parse --show-toplevel` → root (existing `repo_root`)
2. `--no-pager diff --no-ext-diff --no-textconv -M --numstat -z HEAD` → tracked staged+unstaged.
   On an unborn `HEAD` (fresh repo, no commit) git errors, so fall back to the empty-tree object
   `4b825dc642cb6eb9a060e54bf8d69288fbee4904` as the left side, which makes every tracked file a
   pure addition.
3. `ls-files --others --exclude-standard -z` → untracked; each file under `UNTRACKED_MAX_BYTES`
   and not `looks_binary` contributes its line count to `added` (a final line without a trailing
   newline still counts as one). Skipped files still increment `files` and set `truncated`.
   The walk stops after `UNTRACKED_SCAN_MAX = 500` files, also setting `truncated`.

No new IPC event: the frontend pulls.

### Data Flow

```
1. syncWindowFooter(win) runs (tab visible / window created / pane focus moved)
2. syncWindowDiffStat(win) reads the focused pane's getWorkingDirectory()
3. resolveRepoRoot(cwd) — already cached per cwd — yields the repo root, or null
4. null  → the element is removed, the window's subscription is dropped
   root  → subscribe(root) on diffStatStore, re-rendering on every tick
5. First subscriber for that root: immediate invoke('working_diff_stat'), then a
   4 s interval; further windows on the same root ride the same timer
6. A lane finishing a turn emits ViewBus `harness:lane-idle { cwd }`; the
   compositor resolves its root and calls diffStatStore.refresh(root) — the
   counts update at the turn boundary, not up to 4 s later
7. document.visibilitychange → hidden stops every timer; visible restarts them
   and fires one immediate fetch, so a returning user never reads a stale number
8. renderWindowDiffStat() compares against the window's cached "+a -r" key and
   returns early when unchanged — a poll that finds no change writes no DOM
```

### Keybindings

None. It is a readout. (`Cmd+P d` already opens the Diff Window for the detail.)

### UI Changes

```html
<!-- painted order: usage-status → notif → project (1) → diff-stat (2) → lane-strip (3) -->
<span class="krypton-window__diff-stat"
      title="working tree vs HEAD: +214 -37 across 9 files"
      aria-label="working tree vs HEAD: +214 -37 across 9 files">
  <span class="krypton-window__diff-add">+214</span>
  <span class="krypton-window__diff-del">-37</span>
</span>
```

Painted left to right: `quotas … notification | krypton +214 -37 ⟨lane logo⟩ CLAUDE-1`, where the
project's drop cap, both counts and the lane logo are all magnified ~2.9× and share one baseline,
overgrowing upward out of the 28px rail.

| Concern | Rule | Why |
|---------|------|-----|
| Placement | `order: 2`, lane strip moves to `order: 3`, `margin-left: 6px`, `flex: none` | Immediately right of the name, so name and volume read as one phrase. It is never present without the badge (both derive from the same cwd), so it never needs the group's `margin-left: auto` — that rule stays on the badge untouched |
| Size | `font-size: calc(var(--krypton-chrome-font-size, 11px) * var(--krypton-window-diff-zoom, 2.9))`, where `--krypton-window-diff-zoom` is declared on `.krypton-window__footer` alongside the other two | Magnified to the same level as the lane logo and the project drop cap: the rail's right end is one oversized phrase — *project, volume, lane* — read at scanning distance. Its own variable rather than reusing `--krypton-window-project-zoom`, because the three marks scale from different ink (a glyph pair, digits, an SVG) and a theme that retunes the rail will want them independent — the shared default 2.9 is what makes them agree today |
| Why `font-size`, not `transform` | Same as spec 219 | A transform is invisible to layout, so a magnified count would paint straight over the quotas to its left. Scaled type carries its true painted width, and the quotas are already the rail's compressible half (spec 153) |
| Baseline | `align-self: flex-end` + the same `margin-bottom` calc as `.krypton-window__project`, `line-height: 1`, `position: relative` | Same floor as the badge, so at equal font size the drop cap and the counts share one baseline and the overgrowth escapes upward together. `position: relative` for spec 219's reason: `.krypton-pane` paints in the positioned phase and would otherwise slice the escaped pixels flat at the rail's top edge |
| Narrow window | `@container (max-width: 620px)` drops `--krypton-window-diff-zoom` to `1` | The magnified pair costs ~150px of rail; on a narrow window that is the difference between the quotas rendering and not. Degrading the *size* keeps the information — the same trade the existing 620px rule makes when it drops secondary quotas |
| Colour | `--krypton-ansi-green` / `--krypton-ansi-red` | The pairing `opencode.ts` already uses, and what every precedent above uses. Deliberately *not* the window accent — these are absolute facts about the repo, not window identity |
| Motion | none | The footer's standing no-motion rule; a number that pulses every 4 s would be the noisiest thing on screen |
| Overflow | `white-space: nowrap`, `flex: none`, counts compacted past `DIFF_STAT_COMPACT_FROM` (1 000) | Bounded width by construction: five characters per token whatever the repo, so the magnified pair has a fixed worst case. The badge's tail stays the compressible part |
| Truncated counts | `title` gains `" (partial — large or binary files skipped)"`; no visual marker | Honest without spending rail width on a rare caveat |

Flat: no border box, no chip, no left rail, no glow.

### Configuration

None. `DIFF_STAT_POLL_MS` is a single exported constant. A TOML knob is deliberately deferred
(see Out of Scope).

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Focused pane has no cwd (terminal, no `getWorkingDirectory`) | No element, no subscription |
| cwd outside a git work tree | `resolveRepoRoot` → null; no element (the project badge still shows) |
| Clean tree (`files === 0`) | No element — Starship's `only_nonzero_diffs` rule |
| Deletions only | `+0` is still rendered beside `-37`, so the pair never reads as a lone stray number |
| Counts ≥ 1 000 / ≥ 10 000 | `+1.2k` / `+12k` — five characters maximum per token, so the magnified pair has a fixed worst-case width |
| Window narrower than 620px | Counts drop to rail size (still shown); the drop cap and lane logo keep their zoom, as today |
| Fresh repo, no commits | Empty-tree fallback: every tracked file counts as additions |
| Binary / >1 MiB / unreadable untracked file | Counts toward `files`, contributes 0 lines, sets `truncated` |
| Binary tracked change (numstat `-` `-`) | Same: file counted, lines not, `truncated` set |
| Detached HEAD / mid-rebase / mid-merge | Works unchanged — the diff is always vs whatever `HEAD` is |
| `git` missing or the call fails | `Err` → element removed, error swallowed. No notification: a rail readout must never nag |
| Four windows on one repo | One timer, one git call per tick, four renders |
| Two harness panes in one window | Follows the *focused* pane, like the three readouts beside it |
| App hidden / another Space | Every timer stops; one immediate fetch on return |
| Poll finds no change | Cached-key compare returns early; zero DOM writes |
| Window closed mid-flight | Unsubscribe in `closeWindow()`; a late response finds no subscriber and is dropped |

## Out of Scope

- **A TOML config knob** for the cadence or for disabling the readout. One constant first; a knob
  if the measured cost turns out to matter on a repo much larger than this one.
- **Ahead/behind, branch name, or file-level counts** (`⇡2 ⇣1`, `M 3 ?? 1`) — a different question
  from volume of change, and the rail is full.
- **Staged vs unstaged split** (`+a −r` vs `+a' −r'`). One pair, vs `HEAD`.
- **Per-file or per-lane attribution** ("who wrote these 214 lines") — the Diff Window and spec 160's
  priority hints own that.
- **The workspace footer, live-assist (spec 208), and the loopback surfaces** — window rail only.
- **Making it interactive** (clicking to open the Diff Window). Keyboard-first; `Cmd+P d` exists.

## Deviations During Implementation

- **`DiffStatStore` takes an injectable `VisibilitySource`** (defaulting to the real `document`)
  rather than reading `document.visibilityState` directly. The unit suite runs on node with no DOM
  and the repo ships no jsdom, so the pause-while-hidden behaviour would otherwise have been the
  one untested part of the store. Also revealed a case the spec had not stated: a window opened
  *while* the app is hidden still fetches once — it needs a number to render — but arms no timer.
- **`diff_base()` was extracted in `git.rs`** and `collect_reference_git_state` (spec 207) now
  calls it, instead of the unborn-`HEAD` fallback being written twice. Same behaviour, one
  definition.
- **The focused directory is re-read after the `await`, not just compared by root.** This readout
  is the rail's only async sync, and two of them can finish out of order — a cached repo root
  resolves instantly while an uncached one costs a git call — so an older, slower answer could win
  and leave the rail reporting the pane the user had just left. Both this and the project badge now
  read through one `focusedProjectDir(win)` helper, so the two can never disagree about whose
  project they describe. Related: the element is inserted *after* the badge rather than prepended,
  so reading order stays "project, then its counts" regardless of which lands first.
- **`truncated` also covers binary *tracked* changes**, not only untracked ones. The spec's edge
  case table already said a binary change contributes no lines; flagging it is what makes the
  tooltip's "partial" caveat honest in that case too.

## Resources

- [Starship — `git_metrics` module](https://starship.rs/config/) — the metric, the `+added`/`-deleted`
  green/red format, `only_nonzero_diffs = true`, and the fact that it ships `disabled = true`
  because per-prompt computation is costly; all three shaped the format and the hide-when-clean rule.
- [starship/starship — git integration modules (DeepWiki)](https://deepwiki.com/starship/starship/5.4-git-integration-modules)
  — that the module varies its strategy for performance, which prompted measuring the git cost here
  rather than assuming it.
- [vim-gitgutter](https://github.com/airblade/vim-gitgutter) — `GitGutterGetSummary()` → `[added,
  modified, removed]` and the airline `+N ~N -N` statusline form; the source of the rejected
  three-token variant.
- Local: `/Users/wk/Source/zed/crates/ui/src/components/diff_stat.rs` — Zed's `DiffStat`
  (`+ 1,234` Success / `‒ 56` Error, small label, tooltip) and its use in `git_panel.rs`,
  `project_diff.rs`, `commit_view.rs`.
- Internal: `docs/adr/0008-diff-window-refreshes-on-lane-quiet-points.md` (the refresh policy this
  one departs from, and why), `docs/219-window-project-badge.md` (the neighbour and the rail's
  geometry), `docs/155-*` / `src-tauri/src/git.rs` (the [[Working diff]] definition being extended).
