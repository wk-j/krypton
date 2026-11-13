# Harness Git Panel — Implementation Spec

> Status: Implemented
> Date: 2026-11-13
> Milestone: ACP Harness — dock
> Builds on: 0155 (working diff), 0220 (diff stat poll), 0247 (remote harness), 0301 (components), 0320 (titlebar toggles), 0337 (dock column), 0347 (side panels), 0352 (porcelain status), 0357 (Assistants tab)
> Styling: DESIGN.md lamps and materials (`--mat-*`). No L-shaped brackets, no `backdrop-filter`, no infinite animation.

## Problem

A harness user watching a lane edit the tree has to leave the dock to see what is staged, unstaged, or untracked, and has no keyboard path to stage or commit that tree. The window rail shows a `+N -M` volume (spec 220). The Diff View shows a whole-tree snapshot (specs 38 and 155). Neither is a file list you can live in.

## Solution

Add a **Git** tab to the existing right dock (`dock.right`, layout order 40, after Assistants). It lists the harness project's working tree and stages, unstages, discards, and commits through fixed `git` argv in Rust. Enter opens the existing Diff View on that path. The panel does not replace the terminal `git status` card, the Diff Window, the window diff stat, reference-git decorations, or the Commit Browser / `#learn`.

The tab is **hidden by default**, including on upgrade, so a dockless harness does not gain a 352px column.

## Placement

`DOCK_TABS` gains `git` after `assistants`. Availability follows the panel flag and the right-side flag, not "is this a git repo". An unavailable repo is a body state. Ticket's hide-when-empty rule does not apply.

`[` / `]` stay on `HarnessDock.handleKey`. The git handler does not bind them.

### Hidden on upgrade

Storage stays version 2. Today's reader treats any other version as corrupt and would reset every flag, so this does not bump the blob.

Side key `krypton:acp-harness:git-panel-migrated:<projectDir>`:

- Missing or invalid storage returns `['assistants', 'git']` and writes nothing.
- A legacy array adds `assistants` and `git`, then `writeHiddenPanels` (which sets the key).
- A version-2 blob with the key absent adds `git`, writes the blob, and sets the key.
- A version-2 blob with the key present returns the filtered set unchanged. An explicit empty list stays empty.
- `writeHiddenPanels` always sets the migration key. Showing Git goes through `setPanelHidden('git', false)`, which omits `git` from `hidden` and sets the key. Otherwise the next read would hide it again.

### Opening the tab

Palette command `acp.harness.git` ("Open Git Panel", icon `git-branch`) is registered before the no-lane return, next to `acp.harness.assistants`. It shows the right side, clears the `git` hidden flag, selects the tab, and focuses it (`showGitDock`).

Bare `#panels git` does not clear the right-side flag. The chip uses `panelFlash`, which appends `right panel hidden`.

Titlebar: `{ id: 'git', label: 'Git panel', icon: 'krypton-icon-panel-git' }` after Rails in `HARNESS_TOGGLE_PANELS`. Assistants stays off the titlebar (spec 357). The icon is a 16×16 branch stroke in `harness-icons.ts`, with no left rail and no corner brackets. The titlebar cluster grows from seven panel icons to eight, then the existing left/right divider. Below 480px the existing rule still keeps only `left` / `right` plus the backend-update button.

`writeDockTab` stores `'git'` the way it stores `'rails'` and `'assistants'` (only `'ticket'` deletes the key). `readDockTab` accepts `'git'`.

`setAvailable('git', false)` is the default so existing three-tab cycle tests stay valid.

Four labels share 352px. Prefer the full word ASSISTANTS. Tighten `.acp-dock__tab` letter-spacing and font-size only so the four labels fit. Do not rename the tab.

## What the repo is

The cwd is the harness `projectDir`, the same directory Ticket, Rails, and Assistants use. Rust resolves `git rev-parse --show-toplevel`. Paths are root-relative. It is not the focused terminal cwd.

`remoteRuntimeId !== null` paints `Git is local only. This Harness is on a remote host.` and does not invoke git. A null `projectDir` paints `No project directory`. Neither polls.

## Read model

`git_panel_status` is async on the blocking pool. Fixed argv, no caller cmdline:

`status --porcelain=v2 --branch -z --untracked-files=normal --renames`

(the runner adds `--no-pager`). Status and both numstats use `run_git_capped` (5s, 2 MiB, stderr discarded, `GIT_OPTIONAL_LOCKS=0`). A failed status fails the command. A failed numstat becomes `""`.

Stable `Err` strings, matched by equality:

| String | When |
|---|---|
| `git not found` | spawn `NotFound` |
| `not a git repository` | no work tree, and not bare |
| `bare repository` | `rev-parse --is-bare-repository` prints `true` |
| `git status output exceeded 2 MiB` | existing cap |
| `git status timed out` | existing timeout |
| `git status exited with status N` | non-zero status |

`panel_root` calls `repo_root` first, then distinguishes bare, not-a-repo, and missing git. Map `NotFound` to `git not found` in the panel commands. Do not change `run_git_capped`'s own error strings (spec 352). Do not run `git --version` on the 4s poll.

The frontend feeds the three strings to `parseGitStatus`. `StatusEntry` gains required `submodule: boolean`, true when a porcelain mode field is exactly `160000` (`parts.slice(3, 7)` on types `1`, `2`, and `u`). The native card ignores the field. A path that is both staged and unstaged is two rows. A rename or copy is one row with `oldPath`. Ignored is not requested. Untracked is one row per untracked directory.

Row id is `` `${kind}\0${path}` ``. If a refresh drops the selected id, select the nearest index, else the first row, else null.

Header uses `branchLine`: `main → origin/main ↑2 ↓1`, `(no upstream)`, or `detached at abc1234`. Ahead is `--krypton-ansi-2` (`#39ff7f`). Behind is `--krypton-ansi-1`. Summary is the non-zero group counts. A clean tree keeps the branch line and says `Working tree clean`.

Dock badge, a sibling of `setRailsBadge`: any conflict paints `GIT ✗` and hides the count; otherwise a row count; a clean or not-yet-loaded tree paints `GIT` with no count. The tab label is `GIT`.

Untracked and conflict rows show no line counts. Tracked rows show `+A -D`. Both counts null on a staged or unstaged row is dim `bin`. Submodules show no counts. A rename's letter is `R` or `C` and its label is `old → new`.

## Refresh

`GIT_PANEL_POLL_MS = 4000`. Refresh on show, on `r`, on lane-idle for this repo, and on the poll only while the tab is shown and `document.visibilityState === 'visible'`. One in-flight status. A request during flight sets `again`. A stale generation or a changed `projectDir` drops the result. A hidden tab does not run the timer.

The view calls `gitCtl.noteLaneIdle(cwd)` from the existing local-only idle site (`next === 'idle' && projectDir && !remoteRuntimeId`). If the tab is hidden, `noteLaneIdle` does nothing, because show always refreshes. Do not subscribe to `DiffStatStore`. Do not add a filesystem watcher (ADR-0008). Do not refresh from every `renderDock` call: `invalidate('rightRail')` re-enters `renderDock`, and that path only paints and syncs the timer.

A failed refresh keeps the last good snapshot and paints `Refresh failed: <cause> · last success HH:MM:SS`. With no snapshot, the list well is the cause itself. No partial parse of an over-cap status.

Lamp (steady, no spinner, no CSS animation): amber `REFRESHING` / `STAGING` / `COMMITTING` while that work is in flight, including each poll; dark `IDLE` when settled; danger `FAILED` while the last status or mutation failed. `FAILED` clears on the next successful refresh or a typed edit in the commit field.

## Mutations

Separate async commands. `run_git_mutation`: stdin null, stderr kept up to 8 KiB (truncate, do not fail), stdout capped at 64 KiB, `GIT_TERMINAL_PROMPT=0`, `--no-pager`, and **no** `GIT_OPTIONAL_LOCKS=0`. Read stdout and stderr concurrently. Stage, unstage, and discard use 15s. Commit uses 120s. A deadline kill surfaces `git <subcommand> timed out` and the panel refreshes. The commit may have landed. The next status is the truth.

Path gate, after resolving the repo root: Unicode scalars, no NUL; not absolute; no empty, `.`, or `..` component (a trailing slash is fine); the lexical join stays under the root; argv always places `--` before paths. Do not shell out. Error strings: `path is empty`, `path is absolute`, `path escapes the repository`.

| Action | Git | Notes |
|---|---|---|
| Stage row | `git add -- <path>` | Rename or copy sends `oldPath` and `path`. The controller refuses conflicts: `Resolve the conflict before staging.` Rust still runs a plain `git add` for a conflict path. Submodules may be staged. |
| Stage all (`S`) | `git add -- <paths…>` | Every non-conflict path, deduped, chunks of 200. Skipped conflicts: `Staged N · K conflicts left`. Never `git add -A`. |
| Unstage row | `git restore --staged -- <paths>` | Worktree stays. An untracked row flashes `Nothing staged for <path>.` and does not call git. |
| Unstage all (`U`) | `git restore --staged -- .` | Rust special-cases exactly `["."]`. Any other `"."` in a list is `".\" is only valid alone"`. Empty `paths` is `no paths`. Not `git reset`. |
| Discard unstaged | `git restore --worktree -- <path>` | Staged hunks stay. |
| Discard untracked file | `git clean -f -- <path>` | Not `-x`, not `-ff`. Kind `untracked-file` when the path does not end with `/`. |
| Discard untracked dir | `git clean -fd -- <path>` | Only after `git ls-files --others --exclude-standard --directory -z -- <path>` prints that path (`dir` or `dir/`). Otherwise `path is not an untracked file`. |
| Discard staged | none | `Press u to unstage. The worktree copy stays.` |
| Discard conflict | none | `Resolve the conflict before discarding.` |
| Discard submodule | none | `Submodules are not discarded from this panel.` |
| Commit | `git commit -m <trimmed> --` | Index only. Not `-a`, `--amend`, `--allow-empty`, `--no-verify`, `-S`, or `--no-gpg-sign`. |

Empty or whitespace message: `commit message is empty` (trim before the length check), in the controller and again in Rust. Over 100_000 bytes (`message.len()`): `commit message is too long`. Empty index: `git diff --cached --quiet` exit 0 is `nothing staged`; exit 1 proceeds, including an unborn branch; other exits fail. The controller may skip IPC when there are no staged rows. Hooks and `commit.gpgsign` run as the user's git config. A hook or gpg failure keeps the message, paints the first stderr line clipped at 200 characters, and refreshes. Success clears the message, flashes `Committed <sha>`, and refreshes. The message is memory only.

One mutation in flight. A second one flashes `Git is busy` and does not queue. A status refresh during a mutation sets `again` and runs after. Lamp `STAGING` covers stage, unstage, and discard. `COMMITTING` covers commit.

Do not log the commit message, the path list, or full stderr. `log::warn` on timeout with the subcommand name. `log::info` on commit success with the short sha only. Failure logs the first stderr line clipped to 200 characters.

## Opening a diff

Enter calls `openWorkingDiff({ cwd, staged, revealPath })` on the compositor, the local branch of `openDiffView`: `collect_working_diff(cwd, staged)`, then `DiffContentView` with the same `refreshProvider`, `review`, and `reviewPriority` channels, then `revealLocation(revealPath)`. Staged rows pass `staged: true`. Unstaged, untracked, and conflict rows pass `false`. The return value is `revealLocation`'s boolean. `false` flashes `No rendered diff for <path>`. If collect throws, return false and do not build another renderer. The diff tab may still open when reveal returns false.

Do not call `openDiffView()` (it diffs the focused workspace). Do not use `openDiffFromString`.

`AcpHarnessView.setOpenWorkingDiff` is optional so existing `new AcpHarnessView(dir)` tests keep compiling. Enter then flashes `Diff view is not available`. Wire it at both compositor construction sites, including the remote harness. The panel does not call it when the harness is remote.

## Focus and keys

Insert the git controller in the dock block of `AcpHarnessView.onKeyDown` (`dockFocused && !laneBlocked`), as a sibling of Assistants and Rails. Pending questions, permissions, computer approvals, and write-reviews still win. `laneBlocked` runs first.

The input router preventDefaults when `onKeyDown` returns true, which would cancel a textarea's default action. Commit-field keys therefore return false from `onKeyDown` itself:

- `passesToField`: the target is the textarea, and the key is not bare Escape and not Cmd/Ctrl+Enter, or `event.isComposing`. The view returns false immediately.
- Escape in the field: return true, focus the list, keep the message, clear confirm.
- Cmd+Enter or Ctrl+Enter in the field: return true, commit. Plain Enter inserts a newline.
- List focus: `handleDockKey` returns true for every list binding and for every key that would edit a lane draft (printable, Backspace, Delete, arrows, Home/End, Space, Ctrl+C/A/E/K, Tab). Cmd+C copies the selected path. Cmd+W returns false so the later close-window handler runs. Other meta/alt keys return false.
- While discard is armed, only `y` confirms and `n` or Escape cancels. Other list keys return true. `c` focuses the field and clears the arm.

| Key | Action |
|---|---|
| `j` / `k`, arrows | Select next / previous, scroll into view |
| Home / End | First / last row |
| Enter | Open the Diff View |
| `s`, Space | Stage the row |
| `S` | Stage every non-conflict row |
| `u` | Unstage the row |
| `U` | Unstage all |
| `x` | Arm discard. Not `d` |
| `y` / `n` | Confirm or cancel. `n` and Escape cancel |
| `c` | Focus the commit field |
| `r` | Refresh |
| Cmd+C | Copy the selected path |
| Escape | Focus the composer. The tab stays visible |
| Cmd/Ctrl+Enter | Commit, from the field only |

Footer hints use `keyHintNodes`. The commit chord is one cap, `⌘Enter`. Confirm replaces the hint row with `Discard unstaged changes in <path>? Worktree returns to the index.` or `Delete untracked <path>? This cannot be undone.` Click selects and focuses. Click does not stage. A footer COMMIT button (`data-git-commit`) runs the same function as Cmd+Enter. Confirm has no mouse path that skips `y`.

Escape from the list calls `focusComposer()` (the harness root when there is no lane).

## UI

Component `GitDock` in `src/acp/components/git-dock/`, props only, registered in `HARNESS_COMPONENTS` layer 5 next to `assistantInstances`. Block `acp-git-dock`. The sheet is inside `@layer krypton.component`. Host class `acp-harness__git-dock` is placed in `harness-shared.css` with the other docks (flex column, hidden display none, focus outline none). The component sheet includes `.acp-git-dock[hidden] { display: none }` because a component-layer `display: flex` beats the base `[hidden]` rule. `syncClasses` preserves the host class. The controller sets `tabIndex = -1`.

Materials are `--mat-*` only. Full 1px border or none. The selected row is a full-row tint (`--mat-select`). While the dock holds the keyboard, selected-row text is `--mat-lit`. Rows are reconciled by row id. Section headers are not selectable. Paths ellipsize from the left (directory dimmed, filename ink). The commit textarea's `value` is assigned only when it differs from the DOM.

`readDeps` lists snapshot generation, selected id, message, confirm state, and lamp phase, plus the other primitive strings `paint()` reads. It does not list a mutated snapshot object.

`GitDock` does not import the controller, does not call `invoke`, and does not own `hidden`. Updates call `invalidate('rightRail')` only. They do not `render()` the transcript, write a sealed row, or enter `bodyDeps()`.

The controller owns the aside, snapshot, selection, keys, poll, and mutations. Tests inject a `GitPanelApi`. The default implementation uses `invoke`.

## API

| Command | Args | Returns |
|---|---|---|
| `git_panel_status` | `{ cwd }` | `{ repoRoot, status, stagedNumstat, unstagedNumstat }` |
| `git_panel_stage` | `{ cwd, paths }` | void |
| `git_panel_unstage` | `{ cwd, paths }` | void |
| `git_panel_discard` | `{ cwd, path, kind }` | void |
| `git_panel_commit` | `{ cwd, message }` | `{ sha }` |

`kind` is `unstaged`, `untracked-file`, or `untracked-dir`. Register in `lib.rs` next to `native_git_status`. Signatures return `Result<T, String>`. No `.unwrap()` outside tests. Frontend `invoke` sits in try/catch. Serde `rename_all = "camelCase"`.

## Out of scope

Push, pull, fetch, upstream, branch switch, stash, amend, fixup, rebase, merge continue, hunk staging, interactive add, commit templates, `$EDITOR`, `#learn`, the Commit Browser, blame, submodule recursion, worktree creation, a loopback page, and any change to the terminal native card or the window diff stat. No TOML config, no new sound, no libgit2, no `run_command`, no filesystem watcher, no remote-shell git.

## Files

- `src-tauri/src/git.rs`, `commands.rs`, `lib.rs` — panel commands, path gate, mutation runner
- `src/native-output/git-status.ts` — `submodule` on `StatusEntry`
- `src/acp/harness-panel-visibility.ts`, `harness-dock.ts`, `harness-layout.ts`, `harness-icons.ts`, `hash-commands.ts`
- `src/acp/components/git-dock/`, `registry.ts`, `help-overlay`
- `src/acp/harness-git-controller.ts`, `acp-harness-view.ts`
- `src/compositor.ts` — `openWorkingDiff`
- `src/styles/harness-shared.css` — dock placement and the four-tab strip
