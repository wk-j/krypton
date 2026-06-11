# Live Working Diff — Implementation Spec

> Status: Implemented
> Date: 2026-06-11
> Milestone: M8 — Polish
> Builds on: spec 38 (Diff View Window) · ADR-0008 · `CONTEXT.md` [[Working diff]]

## Problem

The Diff Window (spec 38) is a one-shot snapshot: it runs `git diff` once at
open time and never updates. In the ACP harness workflow — lanes continuously
editing the shared worktree while the human supervises — the snapshot is stale
almost immediately. Watching a lane's work today means closing and reopening
the diff tab after every turn.

Two secondary frictions compound it:

- Collecting the working diff costs **N+2 IPC round-trips** per open
  (`git diff`, `git ls-files`, then one `git diff --no-index` per untracked
  file — `compositor.ts:2018-2089`), which is tolerable once but not on every
  refresh.
- The working-diff composition logic now exists **twice**: in
  `openDiffView()` (frontend, for display) and in
  `hook_server::collect_git_state_public()` (backend, for `#review`). The two
  can drift apart on untracked/binary/cap handling.

## Solution

Make the Diff Window refresh itself at **lane quiet points** (ADR-0008): when
any harness lane in the same repo transitions to `idle`, the window
re-collects the [[Working diff]] and re-renders in place, preserving the
current file and scroll position. A manual `r` key covers mid-turn refresh.
Hidden tabs defer to a dirty flag and refresh once on reveal.

Collection moves to a single backend command `collect_working_diff` that owns
the [[Working diff]] definition (tracked changes + untracked as additions);
`acp_collect_review_git_state` is refactored onto the same git primitives so
`#review` and the Diff Window can never disagree about what the working diff
is.

Explicit non-goal, per ADR-0008: **no filesystem watcher**. The diff does not
move while a lane is mid-turn; that is the design.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/git.rs` | **New** — shared git primitives: `repo_root()`, `untracked_paths()`, binary sniff, `run_git()` (extracted from `hook_server.rs`) |
| `src-tauri/src/commands.rs` | **New command** `collect_working_diff { cwd, staged }`; `acp_collect_review_git_state` unchanged in shape, re-based on `git.rs` |
| `src-tauri/src/hook_server.rs` | `collect_git_state_public` internals delegate to `git.rs` primitives |
| `src-tauri/src/lib.rs` | Register `collect_working_diff`; declare `mod git` |
| `src/view-bus-types.ts` | New signal kind `'harness:lane-idle'` → `{ cwd: string }` |
| `src/acp/acp-harness-view.ts` | Publish `harness:lane-idle` from the centralized lane-status mutation path when a lane enters `idle` |
| `src/types.ts` | `ContentView` gains optional `onShow?(): void` |
| `src/compositor.ts` | `openDiffView()` uses `collect_working_diff`; wires ViewBus subscription → `DiffContentView.refresh()`; `showActiveTab()` calls `contentView.onShow?.()` |
| `src/diff-view.ts` | `refresh(unifiedDiff)` with file/scroll preservation; `r` keybinding; `synced HH:MM` / `refreshing…` nav indicator; dirty-flag + `onShow()` |
| `docs/38-diff-view-window.md` | Update keybindings table + note live-refresh behavior (and correct the diff library: `diff2html`, not `@pierre/diffs`) |
| `docs/PROGRESS.md` | Record under M8 — Polish |

## Design

### Backend: `collect_working_diff`

```rust
// commands.rs
#[tauri::command]
pub fn collect_working_diff(cwd: String, staged: bool) -> Result<WorkingDiff, String>

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiff {
    repo_root: String,        // canonical toplevel, the matching key
    diff: String,             // unified diff, untracked appended as additions
    skipped: Vec<SkippedFile> // { path, reason: "too_large" | "binary" }
}
```

Composition (all via `git.rs` primitives, single process-spawn batch):

1. `git rev-parse --show-toplevel` → `repo_root` (error → command fails;
   caller shows the existing "Not a git repository" notification).
2. `git diff -M` (or `--staged`) → tracked portion. `--no-ext-diff
   --no-textconv` like the review path.
3. If not staged: `git ls-files --others --exclude-standard -z` → untracked
   paths; for each, synthesize an addition diff (equivalent of
   `git diff --no-index /dev/null <path>`, composed in-process — no extra
   `git` spawn per file):
   - **binary** (null byte in first 2048 bytes — same sniff as
     `hook_server.rs:1956`) → skip content, add to `skipped` with
     `reason: "binary"`,
   - **> 1 MiB** → skip content, `reason: "too_large"`,
   - otherwise append full content as `+` lines with a proper
     `diff --git a//dev/null b/<path>` header so `diff2html` parses it as a
     new file.

No 40 KB cap: that cap exists for prompt embedding in `#review`; the window
renders full diffs (diff2html already degrades its matching strategy past
500 lines).

`acp_collect_review_git_state` keeps its current JSON shape and caps — only
its internals (root resolution, untracked enumeration, binary sniff, git
invocation) move to `git.rs` so both consumers share one definition of the
working diff's ingredients.

### ViewBus signal: `harness:lane-idle`

```typescript
// view-bus-types.ts
'harness:lane-idle': { cwd: string };
```

Published by `AcpHarnessView` from the same centralized status-mutation path
that already feeds `lane:status` on the LaneBus, **only** on transitions into
`idle`, with `cwd = projectDir`. No payload beyond `cwd`: the consumer only
needs "a lane in this project just went quiet". (Mirrors the precedent of
`review:quality` — harness-owned, view-level, neutral.)

### Compositor wiring

`openDiffView()`:

1. `const { repoRoot, diff, skipped } = await invoke('collect_working_diff', { cwd, staged })`
   — replaces `isGitRepo()` + the N+2 `run_command` calls.
2. Create `DiffContentView(diff, container, { skipped })` as today.
3. If `this.bus` is set, subscribe:

```typescript
const unsub = this.bus.onSignal({ kind: 'harness:lane-idle' }, async (sig) => {
  const root = await this.resolveRepoRoot(sig.value.cwd); // cached per cwd
  if (root === repoRoot) diffView.requestRefresh('lane-idle');
});
diffView.onClose(() => { unsub(); this.closeTab(); });
```

`resolveRepoRoot()` caches `cwd → toplevel` in a `Map` (one
`git rev-parse` per unique harness cwd per app run). Multiple matching
harnesses need no special handling — every event funnels into the same
debounced `requestRefresh()`.

`showActiveTab()` additionally calls `pane.contentView?.onShow?.()` when
revealing a content pane (alongside the existing focus handling).

### DiffContentView: refresh lifecycle

New state: `refreshProvider: () => Promise<string>` (injected by compositor —
the view itself never touches Tauri, staying a pure renderer), `dirty:
boolean`, `refreshing: boolean`, `lastSyncedAt: Date | null`.

```
requestRefresh(reason)
  ├─ hidden (element not displayed)? → dirty = true, return
  └─ visible → debounce 300 ms → doRefresh()

doRefresh()
  ├─ refreshing? → mark trailing request, return (coalesce)
  ├─ refreshing = true; nav shows "refreshing…"
  ├─ diff = await refreshProvider()
  ├─ remember: currentFilePath, fileContainer.scrollTop
  ├─ re-parse, re-render
  │    ├─ same path still present → restore index by path + scrollTop
  │    └─ path gone → clamp to nearest index, scrollTop = 0
  └─ refreshing = false; nav shows "synced HH:MM"; run trailing if marked

onShow()
  └─ dirty? → dirty = false, doRefresh()   // reveal = always fresh
```

- `r` in `onKeyDown()` → `doRefresh()` directly (no debounce — explicit
  human intent).
- The nav indicator is a static text node next to the existing mode label:
  `synced 14:32` ↔ `refreshing…`. It never blinks, pulses, or colors
  itself — same philosophy as the [[Backpressure gauge]].
- Empty refresh result (everything committed/reverted) → existing
  `renderEmpty()` "No changes" state; the window stays open and keeps
  refreshing.
- `skipped` files render as a name-only line in the nav area (e.g.
  `assets/logo.png — binary`), so nothing the lane created is invisible.
- Window title (`DIFF // N files · …`) is updated by the compositor after
  each refresh via the existing title path.

### Staged windows

`Leader D` windows subscribe identically; their `refreshProvider` calls
`collect_working_diff` with `staged: true`. (Lanes rarely stage, but the
mechanism is shared and the indicator keeps semantics honest.)

## Data Flow

```
lane finishes turn
  → AcpHarnessView status path: lane → idle
  → bus.publishSignal({ kind: 'harness:lane-idle', value: { cwd: projectDir } })
  → compositor subscription: resolveRepoRoot(cwd) === diff.repoRoot?
  → diffView.requestRefresh('lane-idle')
       visible → debounce → collect_working_diff (1 IPC call)
                → re-render, preserve file + scroll → "synced 14:32"
       hidden  → dirty = true
                  … user switches to the diff tab …
                → showActiveTab → onShow() → doRefresh()
```

## Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `r` | Diff view focused | Refresh now (manual, works with or without a harness) |
| *(existing)* | | `j/k/h/l`, `f/b`, `g/G`, `n/N`, `[/]`, `s`, `q` unchanged |

## Edge Cases

- **No harness open / cwd outside any harness repo:** subscription never
  fires; window behaves as today plus manual `r`.
- **Harness opened *after* the diff window:** matching is per-event (repo
  root compared at signal time), so it starts refreshing with no re-wiring.
- **Multiple harnesses in one repo:** all funnel into one debounced refresh.
- **Refresh while a previous collect is in flight:** coalesced — one
  trailing refresh runs after the current one completes.
- **Current file disappears from the diff:** clamp to nearest file index,
  reset scroll for that file.
- **Repo becomes diff-empty:** "No changes" empty state; keep listening.
- **Untracked binary / > 1 MiB files:** listed by name with reason, content
  skipped (`skipped[]`).
- **`collect_working_diff` failure mid-session** (e.g. `.git` vanished) **or a
  refresh payload `diff2html` cannot parse**: keep the last rendered diff,
  indicator shows `sync failed HH:MM` (static); next trigger retries. A parse
  failure is never coerced into the "No changes" empty state.
- **Originally focused subdirectory deleted/renamed by a lane:** harmless —
  refreshes are anchored to the resolved repo root, not the cwd the window was
  opened from.
- **Window/tab closed:** `onClose` unsubscribes the bus handler — no leaked
  listeners (perf-checklist item).

## Out of Scope

- Filesystem watching / mid-turn live updates (ADR-0008 — deliberate).
- Per-lane or per-turn diff scoping (worktree is shared; per-line ownership
  unprovable — see [[Authoring lane]]).
- Word-level diff, hunk staging, editing (spec 38 out-of-scope list stands).
- Auto-opening the Diff Window from `#review` or harness events.
- Hot-reload of the 1 MiB / binary policy via config.
