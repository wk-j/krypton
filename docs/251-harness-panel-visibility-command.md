# Harness Panel Visibility Command — Implementation Spec

> Status: Implemented
> Date: 2026-09-16
> Milestone: M6 — ACP Harness

## Problem

The ACP Harness can surround the active conversation with several persistent
surfaces: the plan, lane peek, live thought, prompt queue, Active Ticket dock,
and (in Zen Mode) the lane navigation rail. Zen and Concise Mode reduce other
parts of the UI, but neither provides one explicit command that clears these
panels without discarding their state.

## Solution

Add a built-in `#panels [hide | show | toggle]` command. Bare `#panels` toggles
the state. Hidden mode removes persistent auxiliary panels from layout while
leaving the lane header, status row, transcript, composer, and safety-critical
inline interactions visible. Panel state is preserved underneath and restored
exactly when shown again; the preference persists per project like Zen and
Concise Mode.

This is a third independent presentation toggle rather than a redefinition of
Zen Mode. Existing Zen and Concise preferences therefore keep their current
meaning, and users can combine them deliberately.

## Research

- The four active-lane auxiliary cards already share one
  `.acp-harness__lane-rail`: plan, contextual lane peek, live thought, and
  prompt queue. A root class can hide them as one unit without four new state
  flags.
- The Active Ticket dock is a separate split pane. Its expanded/collapsed state
  must not be mutated; hidden mode only suppresses its DOM and removes the
  dashboard's `352px`/`46px` right margin so showing panels restores the exact
  prior dock state.
- Zen Mode owns a separate left navigation rail. It remains keyboard-navigable
  through `Tab` / `Shift+Tab`, so hidden mode can suppress the rail and let the
  active body occupy the full width without stranding lane switching.
- Transcript thought rows are conversation content, not panels. They remain
  visible; users who also want them hidden can combine this command with
  Concise Mode.
- Permission, question, and write-review cards remain visible inline. Hiding a
  panel must never conceal an action required to unblock a lane.
- Existing modal surfaces (help, memory, pickers, metrics, triage, review, and
  orchestrator console) are user-summoned tools, not persistent panels. They
  remain available while panels are hidden and continue to own keyboard focus
  normally.
- CSS-only hiding preserves state, but the live thought card has a requestAnimationFrame
  teletype loop. Entering hidden mode must stop that loop, and thought rendering
  must not restart it until panels are shown, avoiding invisible animation work.
- `HASH_COMMANDS` and `commandMeta()` are deliberately drift-guarded by tests;
  the new command must be registered in both and classified as a `surface`
  command so autocomplete and the browser command reference stay aligned.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| Visual Studio Code | `View: Toggle Zen Mode` hides workbench UI around the editor; settings control which bars disappear and whether the state restores. | Confirms one reversible command should clear multiple surfaces without destroying their state. |
| JetBrains IDEs | `Hide All Tool Windows` removes auxiliary tool windows while shortcuts can summon them again; Distraction-free mode goes further and centers the editor. | Closest behavior: hide persistent supporting panels but keep core work and keyboard access. |
| Zed | Project and terminal panels have independent toggle actions in the command palette. | Good per-panel control, but not enough for the requested one-command cleanup. |

**Krypton delta** — `#panels` is typed in the existing keyboard-first Harness
composer, requires no global shortcut, and composes with rather than replaces
Zen and Concise Mode. It hides only persistent Harness panels, not the window,
global footer, transcript content, or explicitly summoned modal tools.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/hash-commands.ts` | Register `#panels`, argument help, and `surface` manifest metadata. |
| `src/acp/acp-harness-view.ts` | Store/persist panel visibility, dispatch the command, toggle the root class, and pause hidden thought animation. |
| `src/styles/acp-harness.css` | Hide persistent rails/dock and reclaim their reserved width under one root modifier. |
| `src/acp/hash-commands.test.ts` | Cover roster/manifest discoverability. |
| `src/acp/acp-harness-view.test.ts` | Cover command parsing, persistence, class application, state preservation, and hidden thought-loop behavior. |
| `docs/72-acp-harness-view.md` | Document command semantics and interaction with Zen/Concise. |
| `docs/04-architecture.md` | Record the view-local presentation state and preserved safety surfaces. |
| `docs/README.md` | Add this spec to the index. |

## Design

### State

```ts
private panelsHidden = false;

function panelsHiddenStorageKey(projectDir: string | null): string;
function readPanelsHiddenPreference(projectDir: string | null): boolean;
function writePanelsHiddenPreference(projectDir: string | null, value: boolean): void;
```

Storage key:

```text
krypton:acp-harness:panels-hidden:<projectDir>
```

The constructor reads the preference beside Zen and Concise Mode. Storage
failures degrade to visible panels and never block Harness startup.

### Command

```text
#panels          toggle
#panels toggle   toggle
#panels hide     hide persistent panels
#panels show     show persistent panels
```

Any other argument clears the draft and flashes:

```text
usage: #panels [hide | show | toggle]
```

Successful commands flash either `panels hidden · #panels show` or
`panels shown`. There is no permanent status chip; autocomplete and `#commands`
provide the durable discovery path.

### Hidden Surfaces

| Surface | Hidden | State treatment |
|---------|--------|-----------------|
| Active-lane rail: plan, lane peek, live thought, queue | Yes | DOM/data retained; thought animation paused. |
| Active Ticket dock | Yes | Current expanded/collapsed state retained; dashboard margin reset. |
| Zen lane navigation rail | Yes | State retained; `Tab` / `Shift+Tab` still switch lanes. |
| Lane header and stats | No | Keeps active identity, status, model, permission mode, and usage context visible. |
| Transcript + composer | No | Core conversation and command escape hatch remain available. |
| Inline permission/question/write-review rows | No | Safety-critical interactions cannot be hidden. |
| Transcript thought rows | No | Content, not panel chrome; Concise Mode controls these. |
| Help, memory, metrics, pickers, triage/review overlays, orchestrator console | No | Explicitly summoned tools remain usable and dismiss normally. |
| Workspace footer/window chrome | No | Outside the Harness view's ownership. |

### CSS Contract

`render()` and `renderActiveLane()` apply:

```ts
this.element.classList.toggle('acp-harness--panels-hidden', this.panelsHidden);
```

The modifier:

1. sets `.acp-harness__lane-rail`, `.acp-harness__ticket-dock`, and the Zen
   `.acp-harness__rail` to `display: none`;
2. resets ticket-active/collapsed dashboard right margins to `0`;
3. changes the Zen dashboard grid to one `minmax(0, 1fr)` column so the active
   body fills the reclaimed width.

No element is deleted and no individual panel state is rewritten.

### Runtime Behavior

```text
1. User submits #panels, #panels hide, or #panels show.
2. runHashCommand validates the optional argument and clears the composer draft.
3. setPanelsHidden(next) persists the preference.
4. Hiding stops the live-thought teletype RAF immediately.
5. render() toggles the root class; CSS removes persistent panels and reclaims space.
6. Hidden lane/plan/ticket/queue data continues updating in normal stores.
7. Showing calls the normal render paths, reconstructing current panel content
   from live state without restoring stale DOM snapshots.
```

`renderLaneThought()` returns before mounting or arming its teletype loop while
hidden. The ordinary show render repopulates the slot from the latest snapshot.

## Tests

1. `HASH_COMMANDS` exposes `panels` with the documented arguments and
   `commandMeta()` categorizes it as `surface`.
2. Bare/toggle/hide/show forms select the expected state; invalid input shows
   usage and does not change state.
3. The state persists per project and defaults to visible when storage is empty
   or unavailable.
4. Both full render paths apply the root modifier consistently.
5. Hiding does not mutate Zen, Concise, ticket expansion, plan collapse, lane
   peek selection/lock, or queued prompt state.
6. CSS hides all three persistent panel containers, resets ticket width
   reservation, and collapses the Zen grid to one column.
7. Hidden thought updates do not start a teletype RAF; showing panels renders
   the latest thought again.
8. Permission and question cards remain present in the transcript while panels
   are hidden.

## Edge Cases

- With no active lane, the command is unavailable because Harness commands are
  composer-scoped; opening a first lane restores the saved preference.
- If a ticket becomes active while panels are hidden, its state updates but the
  dock stays hidden; showing panels reveals the current ticket.
- If another lane needs permission while the Zen rail is hidden, the global
  footer/lane indicators still signal it and `Tab` cycles lanes. Once active,
  its inline approval card remains visible.
- Window resize and ticket responsive breakpoints cannot re-show a hidden panel
  because the root modifier is later and at least as specific.
- Remote Harness views support the command because it is local presentation
  state and requires no remote runtime capability.
- `#panels show` is idempotent and safe even if no panel currently has content.

## Open Questions

None. The command's boundary is persistent auxiliary panels; conversation
content and explicitly summoned tools remain available.

## Out of Scope

- Changing Zen or Concise Mode semantics or shortcuts.
- Per-panel visibility settings.
- Hiding transcript message kinds beyond existing Concise behavior.
- Hiding the composer, lane identity/status, permissions, or workspace footer.
- New Tauri IPC, config TOML, or backend state.

## Resources

- [Visual Studio Code: Zen Mode](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_zen-mode) — multi-surface reversible focus mode and restore behavior.
- [JetBrains IDEA: Viewing modes](https://www.jetbrains.com/help/idea/ide-viewing-modes.html) — distraction-free mode keeps core editing while hiding auxiliary UI.
- [JetBrains: Focus on your code](https://www.jetbrains.com/guide/java/tips/focus-on-code/) — one action hides all tool windows.
- [Zed Project Panel](https://zed.dev/docs/project-panel) — keyboard/command-palette panel toggling.
- [Zed Terminal Panel](https://zed.dev/docs/terminal) — independent docked-panel toggling.
- `docs/80-acp-harness-zen-mode.md`, `docs/111-harness-right-rail.md`, and
  `docs/157-harness-concise-mode.md` — current Krypton presentation and rail
  precedents.
