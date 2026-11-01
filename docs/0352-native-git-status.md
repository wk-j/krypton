# Native `git status` Output — Implementation Spec

> Status: Implemented
> Date: 2026-11-01
> Milestone: M8 — Polish
> Builds on: [0351](./0351-native-command-output.md) (command blocks, the native card, Native/Raw, the re-run gate)

## Problem

After 0351, a finished `git status` still shows as plain text. User, 2026-11-01: "Yes git status also".

## Solution

`git status` is a second native renderer on the 0351 layer. Its human output is localisable and
depends on config (`status.short`, advice hints, colour), so it is never parsed. When a finished
block's command line is a plain local `git status`, Krypton re-runs it once through the 0351 gate
(the pane's own shell is in front; Rust validates the argv). The re-run is
`--porcelain=v2 --branch -z`, plus `diff --numstat -z` for the staged and unstaged sides. The card
shows:
- the branch line;
- groups: Conflicts, Staged, Unstaged, Untracked, Ignored;
- per entry: a status letter, the path with its directory dimmed, and `+A -D` counts.

## Research

- **Porcelain v2 with `-z`** is git's stable machine format. It has `# branch.oid/head/upstream/ab`
  headers and one entry per path: `1` ordinary, `2` rename/copy (source path in the next NUL
  field), `u` unmerged, `?` untracked, `!` ignored. `XY` gives the staged and worktree letters, `.`
  meaning unchanged. With `-z` the paths are not quoted.
- **`diff --numstat -z`** gives `A\tD\tpath\0`, or `A\tD\t\0old\0new\0` for a rename. `-` counts
  mean binary.
- **Locks:** `GIT_OPTIONAL_LOCKS=0`, already set by the 0351 helper, stops `status` from taking
  `index.lock` to refresh the index.
- **SSH:** the re-run is local-only, so an SSH pane's `git status` stays raw. Parsing the long
  format from the buffer was rejected because it is locale- and config-dependent.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Rex | Native mode observed for `git diff` only | — |
| lazygit / VS Code SCM | Staged and unstaged sections with status letters, a branch header with ahead/behind | Same grouping here |

**Krypton delta:** inline over the command's own rows, with Native/Raw and Copy on the same keys
as 0351. Nothing new to learn.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/git.rs` | `git_rerun_tokens` (shared tokenizer), `run_git_capped` (shared 5 s / 2 MiB runner), `git_status_rerun_args`, `native_git_status`, `NativeGitStatus` |
| `src-tauri/src/commands.rs`, `lib.rs` | async `native_git_status` command |
| `src/native-output/git-status.ts` | New. `parseGitStatus`, `isGitStatusCmdline`, `gitStatusText`, `branchLine` |
| `src/native-output/render-status.ts` | New. Status body |
| `src/native-output/render-diff.ts` | Diff body, moved out of the card |
| `src/native-output/native-card.ts` | Was `native-diff-card.ts`; the card takes a `NativeModel` (`diff` \| `status`) |
| `src/native-output/layer.ts` | `resolve()` picks the buffer diff, the diff re-run or the status re-run; per-kind copy text |
| `src/compositor.ts` | `rerunLocalGit<T>(pane, command, cmdline)` serves both re-runs |
| `src/native-output/native-output.css` | `.krypton-native-status__*` |
| `src/which-key.ts`, `src/command-palette.ts` | Copy entries say "Native Output" |

## Design

### API

`native_git_status(cwd: String, cmdline: String) -> Result<NativeGitStatus, String>`, where
`NativeGitStatus { status, staged_numstat, unstaged_numstat }` has snake_case keys.

`git_status_rerun_args` accepts exactly `git [--no-pager] status <rest>`, with the same character
and tilde rules as 0351. `<rest>` may hold:
- format flags, which are dropped: `-s`, `--short`, `-b`, `--branch`, `-sb`, `-bs`, `--long`;
- `-u[no|normal|all]` / `--untracked-files[=…]`;
- `--ignored[=traditional|no|matching]`;
- pathspecs, which are always passed back after `--`.

Anything else is refused, e.g. `-v`, `--porcelain`, `-z`, `--column`, `git -C`. The status run must
exit 0. Each numstat is best-effort: on failure its field is empty.

### Data Flow

```
1. OSC 133 C…D for `git status` (0351 steps 1–3); exit ∈ {0, 1, none}, rawRows ≥ 1
2. layer.resolve: the rows are not a diff → isGitStatusCmdline → host.rerunGitStatus
   → compositor.rerunLocalGit: get_foreground_process null → get_pty_cwd → native_git_status
3. parseGitStatus: each `1`/`2` entry splits into a Staged (X) and an Unstaged (Y) side, with
   counts from the matching numstat; `u` → Conflicts; `?`/`!` → Untracked/Ignored.
   No `# branch.` header → no card.
4. NativeCard({ model: { kind: 'status', status } }) → renderStatus; Copy writes gitStatusText
```

### UI

```
master → origin/master ↑0 ↓0                 .krypton-native-status__branch
UNSTAGED 16                                   __label (+ __count), conflicts red, staged green
   M  docs/0004-architecture.md      +2 -0   __entry: __code--{modified,added,…} · __path (__dir dim) · __counts
UNTRACKED 4
   ?  src/native-output/
```

The empty case is `nothing to commit, working tree clean`. A detached HEAD reads
`detached at <sha7>`, and a branch with no upstream reads `<branch> (no upstream)`.

## Edge Cases

- **SSH, `docker exec`, or another foreground:** no re-run, so the block stays raw.
- **`git status -s` / `-sb`:** the raw output has fewer rows than the card, so the body scrolls
  inside the card. The prompt never moves.
- **`git status` with a pager or alias:** an alias (`git st`) or a wrapper function does not match
  and stays raw.
- **Clean tree:** the branch line and the clean message.
- **Each git call** has its own 5 s timeout, so a request takes about 15 s at worst. A timed-out
  status returns no card.

## Out of Scope

Status from SSH panes, `git status -v` (status plus diff), stash counts (`--show-stash`), and
actions on entries (stage or open from the card).

## Tests

- `git-status.test.ts`:
  - one porcelain fixture with a staged entry, an unstaged entry, a path changed on both sides, a
    rename with spaces, a conflict and an untracked directory;
  - a clean, detached, first-commit repo;
  - non-porcelain output → null;
  - `branchLine` forms and the copy text;
  - `isGitStatusCmdline`.
- `git.rs`:
  - the validator accepts and rejects the examples above;
  - `native_git_status` in a temp repo with `color.ui=always` and `status.short=true`, run as
    `git status -sb`, gives the porcelain entries, the numstats and no colour;
  - a scoped `-uno -- staged.txt` run returns only that file.

## Verification

- `npm run check`, `npx vitest run` (277 files, 3 332 tests); `cargo clippy` (no warnings),
  `cargo test git::tests` (16 passed).
- Browser smoke (throwaway, deleted). The real `NativeOutputLayer` ran on bytes from an interactive
  `fish -i` running `git status` in this repo. The status stub returned this repo's real porcelain
  v2 and numstat output. Observed:
  - one status card with Unstaged 16 and Untracked 4, and counts such as `src-tauri/src/git.rs
    +497 -1`;
  - the raw rows were hidden;
  - Copy wrote the branch line and groups;
  - a delta `git diff` block still rendered as a diff card.
- Not exercised: the running Tauri app (no screen-capture or keystroke permission for the agent).

## Resources

- `git help status` — "Porcelain Format Version 2" (`# branch.*`, `1`/`2`/`u`/`?`/`!` entries, `-z`).
- `git help diff` — `--numstat`, and `-z` rename records.
