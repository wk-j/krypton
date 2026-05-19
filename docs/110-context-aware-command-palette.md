# Context-Aware Command Palette — Implementation Spec

> Status: Shipped (v4, MRU cut to follow-up)
> Date: 2026-05-19
> Milestone: Post-M-current polish (backlog item #4 from `docs/108-overall-ui-improvements.md`)

## Problem

The command palette (`Cmd+Shift+P`) opens with a single flat list of ~60 actions regardless of what the user is currently doing. The palette has a few dynamic entries (pinned windows, ACP backends, sound themes, dashboards) but it is **not aware of the focused view's type or state**, and views cannot contribute their own actions. Consequences:

- View-specific commands either don't exist in the palette (most ACP harness operations) or are buried among unrelated entries.
- The user must type to find anything view-relevant, even when 80% of their next likely action is "do something with the focused view".
- New views cannot expose actions without editing `command-palette.ts` directly, which breaks the encapsulation `ContentView` establishes.

## Solution

Two additive changes to the existing palette:

1. **Contextual section pinned to top.** When the palette opens, prepend a "Context" group whose entries come from the focused pane's `ContentView` via a new optional `getPaletteActions(ctx)` capability. The static list still appears below, unchanged.
2. **View capability (not registry).** `ContentView` gains an optional `getPaletteActions?(ctx): readonly PaletteAction[]`. The compositor asks the focused pane's `contentView` directly — no registry, no lifecycle bookkeeping, no same-type collisions. Matches the existing optional-hook pattern (`focusView?`, `getLeaderKeyBindings?`).

A recent-action MRU was considered (v1–v3 of this spec) but **deferred to a follow-up** so the Context UX is proven first before adding persistence + dedupe + section rendering for a second feature.

The flat list ordering and fuzzy match remain unchanged when the user starts typing — context is a zero-query convenience, not a typing-time filter.

**v1 ships ACP harness as the only contributor.** Other views (agent, file-manager, vault, …) follow in dedicated changes once their real public APIs and entry shapes are inspected.

## Research

Findings from research and three peer-review passes (Codex-1) on `command-palette.ts`, `view-bus.ts`, `compositor.ts`, `types.ts`, and `acp-harness-view.ts`:

- **Static + dynamic split already exists.** `staticActions` registered once; `rebuildActions()` runs on every `open()` and appends dynamic entries (`src/command-palette.ts:841`). Contextual section slots in here.
- **`ContentView` uses optional capability hooks** (`focusView?`, `onResize?`, `getLeaderKeyBindings?` at `src/types.ts:148`). `getPaletteActions?` matches this pattern.
- **Focused-view accessors are public.** `getFocusedContentType()`, `getFocusedViewId()`, `getFocusedPanePublic()` (`src/compositor.ts:979`, `:878`, `:3325`). Palette reads `getFocusedPanePublic()?.contentView` directly.
- **`getFocusedContentType()` returns `null` for terminal panes** (their `contentView` is null). Spec treats `focusedContentType: null` as "terminal or no focused view"; either way no contextual actions.
- **ACP harness internals verified** (`src/acp/acp-harness-view.ts`): `activeLane(): HarnessLane | undefined` is a method; `lanes: HarnessLane[]` is the array (line 376). Existing private methods used by v1: `cancelLane(lane)`, `restartLane(lane)`, `activateLaneByDelta(delta)`, `toggleMemoryDrawer(open)`, `cancelShell(lane)`. In-harness keybindings (used as palette hints): `n`/`N` cycle lane, `Ctrl/Cmd+C` cancel (or cancel pending shell), `Ctrl/Cmd+M` toggle memory drawer.
- **`restartLane(lane)` semantics** (verified during peer review): disposes the ACP client, clears pending permissions / turn extraction flags / sessionId / error / plan, appends `--- session restarted ---` to the transcript, then respawns. **Does not clear transcript or harness memory.** Label is `Restart Lane Session` for precision.
- **Sync throws in `executeSelected()` are not caught today** (`src/command-palette.ts:444`); only Promise rejections are. Fixed here since we touch the same code path.

Alternatives ruled out (across all review passes):

- **`when`-clause DSL.** Over-engineered for ~12 view types. TS optional methods are type-checked, grep-able.
- **Push model via ViewBus.** Palette is closed >99% of the time — push creates invalidation problems with no UX gain.
- **Type-keyed registry.** Two same-type views fight for the slot. View capability avoids this.
- **`viewId`-keyed registry with mount/unmount.** Acceptable but more moving parts than capability.
- **`ViewBus.latestSignal` accessor + `focusedState` on `PaletteContext`.** No v1 contributor reads bus state; ACP reads richer lane-local state directly.
- **`compositor.onPaneClose` hook for palette auto-close.** Too much infra for a rare edge. Closures fail soft.
- **Synthetic terminal contributor.** Static list (`terminal.quick-toggle`, `terminal.scroll-up`, `terminal.scroll-down`) already covers terminals.
- **File-manager contributor in v1.** Field shape assumed (`selectedEntry.absPath`, `kind`, `gitStatus`) does not exist; real fields are `filteredEntries[cursor]`, `FileEntry.path`, `is_dir`. Re-evaluate when implementing.
- **MRU + Recent section + localStorage persistence.** Deferred to follow-up.
- **Frequency ranking, multi-step palette, pre-filtered open, custom user actions.**

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | `when` clauses on commands + Quick Pick; recently used pinned to top | DSL is verbose; we adopt the contextual-pinning idea, not the DSL |
| Sublime Text | Selector-string `context` filter | Selector strings have a learning curve we avoid |
| JetBrains | "Find Action" (`Cmd+Shift+A`) heuristic context | Closest UX precedent — contextual entries float up |
| Zed | View-scoped actions via crate boundaries | Per-view contributor pattern (their crates ≈ our `ContentView` capability) |
| Warp | Block-scoped actions on active terminal block | Inspired per-active-lane logic for ACP |

**Krypton delta** — match JetBrains' contextual-first ordering. Diverge from VS Code's `when` DSL by using optional TS methods on `ContentView` (matches our "vanilla TS + direct DOM" rule). Keep the **full static list visible while typing** — preserves discoverability for users who memorize action names.

## Affected Files

| File | Change |
|------|--------|
| `src/palette-types.ts` *(new)* | `PaletteAction`, `PaletteContext`, `PaletteSection`. Imported by `command-palette.ts` and `ContentView` implementations |
| `src/types.ts` | Add optional `getPaletteActions?(ctx: PaletteContext): readonly PaletteAction[]` to `ContentView` |
| `src/command-palette.ts` | (a) Move `PaletteAction` to `palette-types.ts`; (b) build `PaletteContext` on open; (c) call `compositor.getFocusedPanePublic()?.contentView?.getPaletteActions?.(ctx)`; (d) render Context section header (hidden when empty); (e) wrap `execute()` in try/catch for sync throws; (f) header rows non-selectable, mouse handlers map to filtered index correctly |
| `src/acp/acp-harness-view.ts` | (a) Implement `getPaletteActions(ctx)` — lane-status-conditional actions with stable IDs and keybinding hints; (b) add four public wrappers: `cancelActiveLane()`, `restartActiveLane()`, `cycleActiveLane(delta: number)`, `showMemoryDrawer()` |
| `src/styles/command-palette.css` | BEM additions: `__section-header`, `__item--section-context` |
| `docs/PROGRESS.md` | Note completion |
| `docs/108-overall-ui-improvements.md` | Move "Context-aware command palette" from "Recommended next" to "Shipped" |

## Design

### Types

```ts
// src/palette-types.ts (new)

import type { PaneContentType } from './types';

export type PaletteSection = 'context' | 'static';   // 'recent' deferred to MRU follow-up

export interface PaletteAction {
  /** Stable identity. Must NOT vary with state-dependent labels.
   *  Aliased contextual/static actions must share this id (no aliases in v1, but
   *  the invariant exists so MRU and future deduplication work cleanly). */
  id: string;
  label: string;
  category: string;
  keybinding?: string;
  execute: () => unknown;
  section?: PaletteSection;  // default 'static'
}

export interface PaletteContext {
  focusedViewId: string | null;
  /** null = terminal pane or no focused view. */
  focusedContentType: PaneContentType | null;
}
```

### ContentView Capability

```ts
// src/types.ts addition
export interface ContentView {
  // ... existing fields ...
  /** Contribute palette actions for the "Context" section. Called synchronously
   *  on every palette open. Must be pure — no side effects, no async, no DOM
   *  mutation. Omit actions that cannot run; do NOT return disabled rows. */
  getPaletteActions?(ctx: PaletteContext): readonly PaletteAction[];
}
```

### Palette Open Flow

```
1. User presses Cmd+Shift+P → CommandPalette.open()
2. rebuildActions():
   a. ctx = {
        focusedViewId:      compositor.getFocusedViewId(),
        focusedContentType: compositor.getFocusedContentType(),   // null for terminals
      }
   b. focusedView = compositor.getFocusedPanePublic()?.contentView ?? null
   c. contextual = try { focusedView?.getPaletteActions?.(ctx) ?? [] }
                   catch (e) { console.warn(...); return [] }
                   .map(a => ({ ...a, section: 'context' as const }))
   d. dynamic = (existing dynamic entries: pinned, dashboards, ACP backends, sound themes, hook-toast)
   e. this.actions = [...contextual, ...dynamic, ...staticActions]
3. filter('') → render with "Context" header above the contextual block
   — header hidden when contextual is empty (terminal pane or no provider)
4. User types → render flat, header hidden, fuzzy-ranked
```

No dedupe needed in v1 because contextual actions for ACP do not alias static commands. The `id` invariant in `PaletteAction` documents the rule for the future MRU change.

### Section Header Rendering

Headers are non-interactive DOM nodes inserted between sections **only when the query is empty and the section is non-empty**. They are not appended to `this.filtered`, so:

- `selectedIndex` and Arrow/`j`/`k` navigation skip them naturally.
- Mouse `mouseenter` / `mousedown` handlers continue to live only on item rows (which carry `dataset.index` indexing into `this.filtered`).
- `updateSelection()` queries `.krypton-palette__item`, which does not match the header class.

### Action ID Stability (Invariant)

A contextual action that is an alias of a static command must reuse the static command's ID. Action IDs must not encode mutable runtime state (e.g., the active lane's id) — labels can change, IDs cannot. No alias case exists in v1; the invariant is forward-looking for the MRU follow-up.

### Sync-Throw Handling (existing bug, fixed here)

```ts
private executeSelected(): void {
  if (this.filtered.length === 0 || this.selectedIndex >= this.filtered.length) return;
  const action = this.filtered[this.selectedIndex].action;
  this.close();
  this.compositor.flashAck();

  let result: unknown;
  try {
    result = action.execute();
  } catch (err) {
    console.error(`[CommandPalette] Action "${action.id}" threw:`, err);
    return;
  }
  if (result instanceof Promise) {
    result.catch((err) => console.error(`[CommandPalette] Action "${action.id}" rejected:`, err));
  }
}
```

### ACP Harness Contributor

```ts
// In AcpHarnessView — new public wrappers (thin):
public cancelActiveLane(): void {
  const lane = this.activeLane();
  if (!lane) return;
  if (lane.pendingShellId) void this.cancelShell(lane);
  else void this.cancelLane(lane);
}
public restartActiveLane(): void {
  const lane = this.activeLane();
  if (lane) void this.restartLane(lane);
}
public cycleActiveLane(delta: number): void {
  this.activateLaneByDelta(delta);
}
public showMemoryDrawer(): void {
  if (!this.memoryDrawerOpen) this.toggleMemoryDrawer(true);
}

// Capability:
getPaletteActions(_ctx: PaletteContext): readonly PaletteAction[] {
  const lane = this.activeLane();
  if (!lane) return [];
  const out: PaletteAction[] = [];

  // Cancel — only when something is cancellable. Mirrors Ctrl+C.
  if (
    lane.pendingShellId ||
    lane.status === 'busy' ||
    lane.status === 'needs_permission' ||
    lane.status === 'awaiting_peer'
  ) {
    out.push({
      id: 'acp.harness.cancel',
      label: 'Cancel Current Turn',
      category: 'ACP Harness',
      keybinding: 'Ctrl+C',
      execute: () => this.cancelActiveLane(),
    });
  }
  // Restart — only after error or stopped. Backend session reset; transcript/memory preserved.
  if (lane.status === 'error' || lane.status === 'stopped') {
    out.push({
      id: 'acp.harness.restart',
      label: 'Restart Lane Session',
      category: 'ACP Harness',
      execute: () => this.restartActiveLane(),
    });
  }
  // Switch lane — only when ≥2 lanes exist. Mirrors n.
  if (this.lanes.length > 1) {
    out.push({
      id: 'acp.harness.switch-lane',
      label: `Switch Lane (current: ${lane.displayName})`,  // label snapshot; id stable
      category: 'ACP Harness',
      keybinding: 'n',
      execute: () => this.cycleActiveLane(1),
    });
  }
  // Memory drawer — open if closed. Mirrors Ctrl+M.
  out.push({
    id: 'acp.harness.show-memory',
    label: 'Open Lane Memory Drawer',
    category: 'ACP Harness',
    keybinding: 'Ctrl+M',
    execute: () => this.showMemoryDrawer(),
  });
  return out;
}
```

The closure captures `this`, not lane objects — lane state is re-read at execute time via `this.activeLane()`. The "Switch Lane" label is a snapshot of the current lane's display name; the action is "cycle by +1" regardless of which lane is current at execute time.

### UI Changes

```css
.krypton-palette__section-header {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--krypton-text-muted);
  padding: 0.25rem 0.75rem;
  border-bottom: 1px solid var(--krypton-border-subtle);
}
.krypton-palette__item--section-context {
  border-left: 2px solid var(--krypton-accent);
}
```

No new fonts/colors. Existing theme variables only.

### Keybindings & Configuration

No new keybindings. No TOML config.

## Test Plan

Minimum:

- **`npm run check`** — type check passes.
- **Palette unit tests** (existing `src/command-palette.test.ts` or new test file using the same DOM harness pattern):
  - Provider throws → contextual section empty, no exception bubbles, warning logged.
  - Empty contextual section → "Context" header not rendered.
  - Non-empty contextual section → "Context" header rendered above context items only when query is empty.
  - User types → headers hidden; results merged into a single fuzzy-ranked list.
  - Arrow/`j`/`k` navigation skips header nodes; `selectedIndex` stays within `this.filtered`.
  - Mouse handlers map `dataset.index` to the correct `this.filtered` entry (no off-by-one when headers are present).
  - `executeSelected()` with a sync-throwing action → palette closes, error logged, no uncaught exception.
- **ACP contributor tests** (`src/acp/acp-harness-view.test.ts` — existing file already covers harness behavior):
  - `status = 'busy'` or `needs_permission` or `awaiting_peer` or `pendingShellId` set → contextual entries include cancel.
  - `status = 'error'` or `'stopped'` → contextual entries include `acp.harness.restart`.
  - `lanes.length === 1` → no `acp.harness.switch-lane` entry.
  - `lanes.length > 1` → `acp.harness.switch-lane` entry present with current lane name in label.
  - `acp.harness.show-memory` always present.
  - All entries carry stable ids; switch-lane id does not encode the current lane id.

## Edge Cases

- **No focused pane / terminal pane** (`focusedContentType: null`) — contextual section empty; "Context" header hidden.
- **Focused view has no `getPaletteActions`** — same as above.
- **Provider throws** — try/catch; log warn; section empty.
- **Palette open, focused view unmounts before user executes** — closures re-read `this.activeLane()` at execute time and fail soft if state is gone.
- **Palette open, focus shifts to a different pane** — stale context until next open. Acceptable.
- **Two ACP harness panes** — focused one is asked. Non-focused contribute nothing.
- **Sync throw inside `execute()`** — caught; logged; palette already closed.

## Open Questions

None.

## Out of Scope

- **MRU + Recent section + localStorage persistence.** Deferred to a dedicated follow-up once the Context UX has been used.
- **Agent, vault, markdown, hurl, pencil, webview, diff, context, file-manager contributors.** Follow-up changes; each must verify its real public API first.
- **Synthetic terminal contributor.**
- **`when`-clause DSL.**
- **Multi-step palette (arguments).**
- **Pre-filtered open** (`Cmd+Shift+P A`).
- **Custom user-defined actions.**
- **Palette telemetry.**
- **Disabled action rows.** Contributors omit unavailable actions.
- **Re-running contributors on focus change while palette is open.**
- **`ViewBus.latestSignal` accessor.**
- **`focusedState` on `PaletteContext` + `view:state` subscriber cache.**
- **Auto-close palette on pane unmount.**

## Resources

- `src/command-palette.ts` — existing palette implementation
- `src/command-palette.ts:444` — `executeSelected` (sync-throw fix lands here)
- `src/command-palette.ts:841` — `rebuildActions` (contextual block inserted here)
- `src/types.ts:148` — `ContentView` interface
- `src/compositor.ts:878,979,3325` — focus accessors
- `src/acp/acp-harness-view.ts:376` — `private lanes` array
- `src/acp/acp-harness-view.ts:680-746` — in-harness keybindings (informs palette hints)
- `src/acp/acp-harness-view.ts:2014,2039,1992` — verified private methods (`cancelLane`, `restartLane`, `activateLaneByDelta`)
- `docs/105-view-protocol.md` — ViewBus protocol; this spec consumes it without extension
- `docs/108-overall-ui-improvements.md` — backlog item being implemented
- [JetBrains "Find Action"](https://www.jetbrains.com/help/idea/searching-everywhere.html) — UX precedent
- [VS Code "when" clauses](https://code.visualstudio.com/api/references/when-clause-contexts) — prior art comparison only; not adopted

## Changelog

- **v4 (MRU cut)** — Cut MRU + Recent section + localStorage persistence to a follow-up spec per Codex-1's recommendation. v1 now ships only: `palette-types`, `ContentView.getPaletteActions?`, Context section rendering with hidden empty header, ACP contributor with four thin public wrappers, sync-throw fix. Restart label changed to `Restart Lane Session` for precision. `PaletteContext.focusedContentType` documented as nullable for terminals. `laneCount()` replaced with inline `this.lanes.length`. Added Test Plan section. Removed `SignalState` from Resources (unused in v1). Removed `'recent'` from `PaletteSection` union.
- **v3 (post-second-peer-review)** — Cut `focusedState` + `view:state` cache; cut `onPaneClose` hook; cut file-manager contributor. Verified ACP harness internals. Resolved Context-vs-Recent display/dedupe inconsistency. Replaced `Map`-overwrite dedupe with explicit priority pass.
- **v2 (post-first-peer-review)** — Replaced type-keyed registry with `ContentView.getPaletteActions?` capability. Removed `ViewBus.latestSignal`. Cut scope from 3 contributors to 2. Moved palette types to `src/palette-types.ts`.
- **v1 (initial draft)** — Type-keyed provider registry, `ViewBus.latestSignal`, three contributors, MRU bundled.
