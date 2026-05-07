# ACP Harness Lane Picker — Implementation Spec

> Status: Implemented
> Date: 2026-05-07
> Milestone: ACP harness resource budget (continues 86/87/88/89/90/91)

## Problem

`AcpHarnessView.start()` (`src/acp/acp-harness-view.ts:580-611`) auto-spawns every backend in `DEFAULT_HARNESS_SPAWN` (codex, claude, gemini, opencode, pi-acp, droid) on view open. Each lane forks an ACP subprocess, opens a session, attaches MCP servers, and starts streaming events. On a fresh harness this means **6 long-running child processes** before the user has typed anything — large RAM/CPU footprint, slow first paint, and most lanes go unused in any given session.

The harness should default to **zero lanes** and let the user pick which agents to run on demand, via leader keys (no mouse, consistent with the rest of the app).

## Solution

1. Remove auto-spawn loop from `start()`. Boot the view with an empty `lanes[]` array and a dashboard hint telling the user how to add a lane.
2. Add a **Lane Picker overlay** (DOM modal, same layering family as memory/help overlays) listing every installed ACP backend, with per-backend running-lane counts. Cursor with `j/k` (or arrows), `Enter` to spawn a fresh lane of the selected backend, `Esc` to dismiss.
3. Extend `ACP_HARNESS_LEADER_KEYS` so all lane lifecycle actions live behind `Cmd+P` (the existing leader prefix):
   - `+` — **Add Lane** (open picker)
   - `_` — **Close Active Lane** (dispose + remove from `lanes[]`; disabled when no lane)
   - `=` — Lane Metrics (replaces previous `m` binding which silently conflicted with the global leader-reserved `m`)

   *(Single-letter keys `a-z`/`A-Z` are reserved as global leader keys in `src/leader-keys.ts`, so view-local bindings must use unreserved symbols. `Alt+` modifier keys do not work on this app, per project memory.)*
4. Allow multiple lanes per backend (e.g., two Claude lanes). Lane index keeps incrementing per backend so display names stay unique (`Claude-1`, `Claude-2`, ...).

This preserves every existing per-lane behavior (transcript, plan panel, memory, MCP bridge, metrics) — the only change is *when* lanes come into existence.

## Research

**`start()` flow today** (lines 580-611):

```ts
// listBackends(), then:
for (const spec of DEFAULT_HARNESS_SPAWN) {
  if (!backendIds.has(spec.backendId)) { systemRows.push('skipped'); continue; }
  for (let i = 0; i < spec.count; i++) {
    const lane = this.createLane(index++, spec.backendId, `${displayName}-${i+1}`);
    this.lanes.push(lane);
    if (!this.activeLaneId) this.activeLaneId = lane.id;
    this.spawnLane(lane);
  }
}
```

**Leader-key plumbing.** `ContentView.getLeaderKeyBindings()` (`src/types.ts:152`) returns `LeaderKeyBinding[]`; the input router routes `Cmd+P, <key>` to the focused view. `ACP_HARNESS_LEADER_KEYS` (line 167) currently exports `[{ key: 'm', label: 'Lane Metrics', group: 'Harness' }]` and `getLeaderKeyBindings()` (line 295-300) maps each spec to a runtime binding.

**Per-lane teardown precedent.** `dispose()` (line 419-437) loops every lane and calls `lane.client.dispose()`. `restartLane` (line 1098) and `newLaneSession` (line 1119) already wire the dispose-then-respawn dance per lane. Removing a lane cleanly = `client.dispose()` + filter out of `lanes[]` + recompute `activeLaneId` + render.

**Available backends.** `AcpClient.listBackends()` returns `AcpBackendDescriptor[]` with `id` and friendly name. The picker uses this list verbatim (no hard-coded `DEFAULT_HARNESS_SPAWN`).

**Lane index continuity.** Today `createLane` is called with `index++` from the spawn loop. We'll move that counter to a class field `private nextLaneIndex = 1` so `addLane()` can keep numbering monotonically across the session — even after lanes are removed. (Display name `Claude-1` is then never re-used in the same session, avoiding confusion in memory/transcripts.)

**Memory model.** Harness memory lives in `harnessMemoryId` (per-view, not per-lane). Lanes write to memory keyed by `lane.displayName`. If a backend has never been spawned in this view, it simply has no memory rows — already supported. No memory schema changes needed.

**MCP stats.** `mcpStatsByLane` (line 244) is keyed by `laneLabel` (= displayName). Removing a lane should drop its entry to keep the metrics overlay tidy.

## DOM & State Changes

### `src/acp/acp-harness-view.ts`

**State additions on the view:**

```ts
private nextLaneIndex = 1;          // monotonic across session
private pickerOpen = false;
private pickerCursor = 0;
private pickerEntries: AcpBackendDescriptor[] = [];   // installed backends
```

**Leader key spec — replace constant:**

`a`/`x`/`m` are all in `GLOBAL_LEADER_RESERVED_KEYS` (`src/leader-keys.ts:5-13`), and `input-router.ts:931-934` rejects local bindings that collide with global reserved keys. Single-letter alphabetic keys are therefore unavailable for view-local leader bindings, and Alt-prefixed keys do not work in this app (per project memory). Use unreserved symbols:

```ts
export const ACP_HARNESS_LEADER_KEYS: readonly LeaderKeySpec[] = [
  { key: '+', label: 'Add Lane',          group: 'Harness' },
  { key: '_', label: 'Close Active Lane', group: 'Harness', effect: 'danger' },
  { key: '=', label: 'Lane Metrics',      group: 'Harness' },
];
```

The previous `m` (Lane Metrics) binding shipped in 91 was silently broken — the global `m` won the lookup and `input-router.handleFocusedLeaderKey` logged "leader key conflicts" then returned false. Replacing with `=` fixes Lane Metrics in addition to adding the new bindings. `src/leader-keys.test.ts` is extended to validate `ACP_HARNESS_LEADER_KEYS` against `GLOBAL_LEADER_RESERVED_KEYS` so regressions break the test suite.

**`getLeaderKeyBindings()` returns three runtime bindings:**

```ts
getLeaderKeyBindings(): LeaderKeyBinding[] {
  return [
    { key: '+', label: 'Add Lane',          group: 'Harness',
      run: () => this.openLanePicker() },
    { key: '_', label: 'Close Active Lane', group: 'Harness', effect: 'danger',
      run: () => this.closeActiveLane(),
      isEnabled: () => this.lanes.length > 0,
      disabledReason: () => 'no active lane' },
    { key: '=', label: 'Lane Metrics',      group: 'Harness',
      run: () => this.toggleMetricsPanel() },
  ];
}
```

**`start()` — drop auto-spawn loop:**

```ts
private async start(): Promise<void> {
  try {
    await this.initializeHarnessMemory();
    try { this.laneModels = (await loadConfig()).acp_harness?.lane_models ?? {}; }
    catch { this.laneModels = {}; }
    this.pickerEntries = await AcpClient.listBackends();
    this.systemRows = ['no lanes running', 'press Cmd+P then + to add a lane'];
  } catch (e) {
    this.systemRows = [`backend list failed: ${String(e)}`];
  }
  this.render();
}
```

**New methods:**

- `openLanePicker(): Promise<void>` — refresh `pickerEntries` from `AcpClient.listBackends()`. If empty → `flashChip('no ACP backends installed')` and skip. Otherwise set `pickerOpen = true`, `pickerCursor = 0`, force-close help/memory drawer, render.
- `closeLanePicker(): void` — `pickerOpen = false`, render.
- `addLane(backendId: string): Promise<void>` — `const existing = this.lanes.filter(l => l.backendId === backendId).length`, `const lane = this.createLane(this.nextLaneIndex++, backendId, ${label}-${existing + 1})`, push, set `activeLaneId` if first, render, then `await this.spawnLane(lane)`.
- `closeActiveLane(): Promise<void>` — bump `spawnEpoch` (so any late events from the disposed client get rejected by the existing epoch guards), `await client.dispose()` (best-effort), `cancelShell` if `pendingShellId`, splice from `lanes[]`, `mcpStatsByLane.delete(lane.displayName)`, pick next neighbor (or `''` and restore the empty-state systemRows), `flashChip('closed <name>')`, render.
- `renderPicker(): void` — paint overlay; called from `render()`.
- `handlePickerKey(e: KeyboardEvent): void` — Esc/q close, j/ArrowDown / k/ArrowUp move cursor (wrap), Enter spawns.

**Picker key handling.** Branch at the top of `onKeyDown` (after help-overlay branch, before metrics-overlay branch — Esc must close picker before falling through to metrics-Esc):

```ts
if (this.pickerOpen) {
  e.preventDefault();
  this.handlePickerKey(e);
  return true;
}
```

**`displayName` per backend.** Replace `DEFAULT_HARNESS_SPAWN` with a `BACKEND_LABELS: Record<string, string>` lookup (codex → "Codex", claude → "Claude", gemini → "Gemini", opencode → "OpenCode", pi-acp → "Pi", droid → "Droid") plus a `backendLabel(id)` helper that falls back to the capitalized backend id. `HarnessSpawnSpec` and `DEFAULT_HARNESS_SPAWN` are deleted.

### `src/styles/acp-harness.css`

New block `.acp-harness__picker*` overlay (~95 lines as shipped):

- `position: absolute; inset: 0` flex-centered shell, semi-transparent backdrop `rgba(4, 8, 13, 0.72)`.
- Inner panel `width: clamp(320px, 38vw, 480px)`, theme accent border `rgba(0, 204, 255, 0.32)`, no `backdrop-filter` (platform gotcha).
- Header: `// add lane` + hint `j/k move · enter spawn · esc cancel`.
- Rows: backend label + dim backend id + amber `·N running` count when running > 0; cursor highlight via accent left-border + tint background (mirror memory-overlay row treatment).
- z-index `4` — above plan (1), memory overlay (2), and metrics overlay; help overlay (3) and the picker are mutually exclusive (`openLanePicker` clears help/memory; help/memory toggles never co-occur with picker).

### Empty-state hint

When `lanes.length === 0`, the dashboard area shows the systemRows joined by newline:

```
no lanes running
press Cmd+P then + to add a lane
```

Reuse the existing systemRows path — already wired through `renderDashboard()`. Set in `start()` (after listing backends) and re-applied in `closeActiveLane()` when the last lane is removed.

## Edge Cases

- **First lane added** — `activeLaneId === ''`, so `addLane` sets it before render; transcript focus goes to the new lane immediately.
- **Closing the only lane** — `activeLaneId = ''`; render falls back to empty state.
- **Closing a busy lane** — `client.dispose()` cancels in-flight turn; matches existing dispose behavior. No confirmation prompt (consistent with `Cmd+W` window close pattern; user can re-add).
- **Backend disappears between launch and picker open** — `openLanePicker` re-fetches `listBackends()` each time; if the previously-installed binary is gone it simply doesn't appear.
- **Picker open + leader key** — leader keys are only consumed when the view delegates them; while picker is open, `onKeyDown` returns early so leader prefix never reaches the router. (Esc to close first.)
- **Help overlay ↔ picker** — both overlays mutually exclusive; opening picker closes help and vice versa.

## What Does NOT Change

- Lane lifecycle internals (`createLane`, `spawnLane`, `restartLane`, `newLaneSession`).
- MCP bridge, memory model, plan panel, metrics overlay, Zen mode.
- Any Rust code. Pure TypeScript + CSS.
- Per-lane keybindings (Ctrl+N/P lane switch, transcript keys, slash palette).

## Verification

Pre-ship gates passed:

- `npm run check` ✓
- `npm run test` (2 files / 33 tests) ✓ — including `leader-keys.test.ts` which now also validates `ACP_HARNESS_LEADER_KEYS`
- `cargo clippy --all-targets -- -D warnings` ✓ — no Rust changes
- `cargo fmt --check` ✓

Manual walkthrough to run before merge:

- Open harness → empty state, no ACP subprocesses spawned (verify via Activity Monitor).
- `Cmd+P +` → picker; `j/k` move cursor; `Enter` spawns; lane becomes active and starts streaming.
- Add a second backend → both lanes visible in rail, `Ctrl+N/P` switches.
- Add a second Claude lane → named `Claude-2` (because `nextLaneIndex` is monotonic across the session), both lanes run independently.
- `Cmd+P _` → active lane closes; neighbor becomes active or empty state restored.
- Memory writes from a closed-then-reopened backend retain prior rows (memory is per-view keyed by `displayName`).
- `Cmd+P =` opens the metrics overlay.
- Help overlay (`?`) shows the three new bindings under "Lane Control".

## Documentation Updates

- `docs/PROGRESS.md` — Recent Landings entry.
- `docs/04-architecture.md` §20 — "ships six built-in lanes" replaced with "boots empty; user adds lanes via leader-key picker".
- `docs/72-acp-harness-view.md` — default roster section rewritten to "none" + describe `BACKEND_LABELS`.
- `docs/05-data-flow.md` — view-open path no longer fans out to ACP backends. *(Already accurate — the harness flow doc focuses on per-lane spawn, not the bootstrap fan-out.)*
