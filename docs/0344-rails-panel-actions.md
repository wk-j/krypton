# Rails Panel Actions — Implementation Spec

> Status: Implemented (approved 2026-10-29 after the UI preview: "ลงมือ implement สเปก 0344 … ตามภาพจำลองที่ทำไว้ได้เลย")
> Date: 2026-10-29
> Milestone: ACP Harness — architecture conformance
> Builds on: 337 (Rails dock) · 338 (`#rails update`) · 342 (Ticket Panel issue actions) · ADR-0025
> Amends: 337 and 338 Out of Scope (trust and update from the dock)
> Amended by: 343 (2026-10-31). A click and the dock's `r` run the typed sub-command inside a
> spec-343 command run, so the lane head shows `#rails now · 0:03` as it does for the typed command.

## Problem

The Rails dock shows what needs doing next: an untrusted manifest with its argv, open findings, a
failed check. Every next step is typed: `#rails trust`, `#rails now`, `#rails send`,
`#rails update`. Only Run (`r`) and Send (`s` on the head row) have dock keys, and the dock's
key-hint line is the only place that names them. The Ticket Panel in the other tab of the same
column has state buttons for its actions (spec 342). The Rails dock has none.

## Solution

Add an **Actions** bar to the Rails dock with four buttons. Each one is a `#rails` sub-command that
takes no argument and acts now: **Run** (`now`), **Send** (`send`), **Trust** (`trust`) and
**Update** (`update`, bare: the lane proposes changes and waits). A click runs the typed
sub-command (`runCommand`) in the active lane, inside the same spec-343 command run as typing it. Each button shows its state the way the Ticket Panel's buttons
do: plain when idle, cyan `running` while it runs, green `✓` when done, and disabled with the
reason as its tooltip when it cannot run. Spec 342's private `IssueActionButton` becomes a shared
`DockActionButton`, so both docks use one button and cannot drift apart.

## Research

- **Typed paths and their gates** (`harness-rails-controller.ts`):
  - `requestRun` (`:266-278`) refuses mode `off` and a run already in flight.
  - `send(laneId, null)` (`:691-701`) refuses when the newest run has no open finding. It
    delivers through `injectEnvelope` on the lane's next idle, so it has no lane-status gate.
  - `trust()` (`:634-650`) calls `rails_trust`.
  - `update(lane, '')` (`:661-688`) refuses a lane that is not `idle` / `awaiting_peer`, loads a
    fresh snapshot and calls `enqueueSystemPrompt(…, 'rails update')`.
- **Keyboard.** `handleDockKey` (`:281-294`) maps `r` and `s`. While the dock has focus the view
  consumes Tab and every other unmodified key (`acp-harness-view.ts:4570-4580`), so buttons in
  the dock are a mouse path. The keyboard paths stay `r`, `s` and the typed commands.
- **The Ticket Panel button** is `IssueActionButton`, private to `ticket-dock/index.ts:91-135`,
  styled by `ticket-dock.css:165-268`. Its rules: a disabled button shows the reason as its
  tooltip, a running button keeps its colour while disabled, and a done button stays enabled.
  `TicketActionState.running` carries a lane name and the button builds the badge text from it.
  Run's running text is the check progress, not a lane, so the shared state carries the badge
  and the tooltip text instead.
- **Update's running state needs no new tracking.** `beginSystemTurn` sets
  `lane.activeSystemLabel` before the busy flip (`acp-harness-view.ts:2516-2521`). `setLaneStatus`
  clears it when the lane leaves `busy` / `needs_permission`, before it emits `lane:status`
  (`:1771-1784`). The controller already subscribes to the lane bus (`:175-177`). A lane whose
  label is the controller's own `rails update` label is running Update, whether the update was
  clicked or typed.
- **Repaint cost.** `renderDock()` is a deps compare, and `setDockTabAvailable` /
  `setRailsBadge` return early when nothing changed (`harness-dock.ts:75-88`). Switching the
  active lane already repaints the dock: `activateLane` → `render()` → `rightRail` →
  `railsCtl.renderDock()` (`acp-harness-view.ts:15879`, `:12569`).
- **Send has no record.** The Ticket Panel persists `done` in `ticket.json` because its actions
  write to GitHub. A rails send writes nothing durable and belongs to one run. A mark in memory,
  keyed by `runId`, is enough, and it resets when a newer run lands.
- **Run gets no done state.** A green `✓` beside a run whose verdict is `check_failed` would
  contradict ADR-0025 item 5, where only a failed check is coloured, as a fault. The head row
  already shows the latest run's time and verdict.
- **The Out of Scope lines this amends.** Spec 337 excludes "trust from the dock". Spec 338
  excludes "editing rails from the Rails dock" and "a dock key for update". The rule behind both
  is ADR-0025 item 4: trust is a human act on a manifest the human has reviewed, and Rust enforces
  it (`rails_run_check` re-hashes the manifest). A button keeps that rule. Only the human can click
  it, the dock lists the argv it approves (since spec 345, one line per check row), and Rust still gates every check. Neither Trust nor
  Update gets a dock **key**, so a stray keystroke during `j`/`k` navigation cannot trust a
  manifest or start a lane turn.
- **Init is left out.** The Rails tab exists only while `.krypton/rails.toml` exists
  (`renderDock`, `:299-300`). An Init button could therefore appear only for an empty manifest,
  and the head row already shows the `#rails init` hint in that case.
- **Mode is left out.** `off | manual | auto` is a setting that the head meta line shows. It is
  not an action.
- **ADR-0025 text must follow.** Rails bullet 3 says that only `#rails send` and `s` in the dock
  deliver a `[rails]` envelope, and the judge checks that text against the rails controller and
  `components/rails-dock/**`. Without an edit the judge would flag this change. Items 1 and 4 list
  the human paths too.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code Testing view | **Run** and **Debug** controls in the Test Explorer section heading, a run icon per node, **Show Output**, and **Fix Test Failure** on a failed test. | The actions sit in the panel that shows the results. |
| Cursor Bugbot | Each finding carries **Fix in Cursor** / **Fix in Web** links. A manual re-run is the comment `bugbot run`. | A finding goes to an agent from where it is shown; a re-run is one action. |
| direnv | `direnv allow` approves the exact `.envrc`. | Trust stays an explicit human act on reviewed content. |
| Krypton Ticket Panel (342) | Six state buttons in the dock, each taking the same path as its `#` verb. | The pattern this spec reuses. |

**Krypton delta.** Each button adds a mouse path next to the dock key or the typed command; none is
the only path. Trust gets no key.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/components/dock-action/index.ts` | **New.** `DockActionButton`, `DockActionState` and `dockActionKey()`, moved out of `ticket-dock/index.ts` |
| `src/acp/components/dock-action/dock-action.css` | **New.** Block `acp-dock-action`: the `.acp-ticket-dock__action*` rules moved over unchanged |
| `src/acp/components/dock-action/dock-action.test.ts` | **New.** State → class, badge, tooltip, `disabled` |
| `src/acp/components/registry.ts` | Register `dock-action` |
| `src/acp/components/ticket-dock/{index.ts,ticket-dock.css,ticket-dock.test.ts}` | Use `DockActionButton`; delete `IssueActionButton` and its rules. The grid `.acp-ticket-dock__actions` stays |
| `src/acp/harness-ticket-helpers.ts` (+ test) | `TicketActionState` removed; `ticketActionStates()` returns `DockActionState`, and `running` becomes `{ badge: 'running · <lane>', detail: '<label> running in <lane>' }`. `fullActionTime` is exported for the Send tooltip |
| `src/acp/harness-ticket-controller.test.ts` | Class names `acp-dock-action--running` / `--done` |
| `src/acp/rails/format.ts` | **New.** `localHhMm`, `plural` and `progressText`, moved out of the component so `rails/actions.ts` can use them without an import cycle |
| `src/acp/rails/actions.ts` (+ test) | **New.** `RAILS_DOCK_ACTIONS`, `RailsDockAction`, `railsDockActionFromData()`, `RailsSendMark`, pure `railsDockActions()` |
| `src/acp/components/rails-dock/{index.ts,rails-dock.css,rails-dock.test.ts}` | The Actions bar as an `ActionsBar` sub-component, props `actions` / `onAction`, click routing; bar and grid styles |
| `src/acp/harness-rails-controller.ts` (+ test) | `RAILS_UPDATE_LABEL`, `lastSend`, `runDockAction`, repaint on `lane:status` and at a run's start and end, state computation in `renderDock` |
| `src/acp/harness-icons.ts` | Four symbols: `krypton-icon-rails-run`, `-rails-send`, `-rails-trust`, `-rails-update` |
| Docs | 0337 (UI content, Out of Scope), 0338 (Out of Scope), 0342 (component name), 0302 (§1.10 `DockActionButton`, §5.7), ADR-0025 (items 1 and 4, Rails bullet 3), `0004-architecture.md`, `0005-data-flow.md`, `README.md` |

## Design

### Data Structures

```ts
// components/dock-action/index.ts
export type DockActionState =
  | { readonly kind: 'idle'; readonly detail?: string }
  | { readonly kind: 'running' | 'done'; readonly badge: string; readonly detail: string };
export interface DockActionProps { readonly state: DockActionState; readonly disabledReason: string | null }
export class DockActionButton extends Component<DockActionProps> {
  constructor(spec: { label: string; icon: string; data: Readonly<Record<string, string>> });
}
export function dockActionKey(state: DockActionState): string; // one stable string per state
// Tooltip: disabledReason ?? detail ?? none. Badge line only when running or done.

// rails/actions.ts
export const RAILS_DOCK_ACTIONS = [
  { verb: 'now', label: 'Run', icon: 'rails-run' },
  { verb: 'send', label: 'Send', icon: 'rails-send' },
  { verb: 'trust', label: 'Trust', icon: 'rails-trust' },
  { verb: 'update', label: 'Update', icon: 'rails-update' },
] as const;
export type RailsDockAction = (typeof RAILS_DOCK_ACTIONS)[number]['verb'];
export function railsDockActionFromData(value: string | undefined): RailsDockAction | null;
export interface RailsSendMark { runId: string; laneName: string; count: number; at: number }
export interface RailsActionView { state: DockActionState; disabledReason: string | null }
export interface RailsDockActions {
  states: Record<RailsDockAction, RailsActionView>;
  laneLine: string; // `lane codex-1 · idle`, or `no active lane`
}
export function railsDockActions(input: {
  snapshot: RailsSnapshot | null; mode: RailsMode; progress: RailsProgress; running: boolean;
  latest: RailsRunRecord | null; lastSend: RailsSendMark | null;
  activeLane: { displayName: string; status: string; hasClient: boolean } | null;
  updateLane: string | null; // display name of the lane whose activeSystemLabel is RAILS_UPDATE_LABEL
  now: number;
}): RailsDockActions;
```

### State rules

| Button | running | done | disabled (tooltip) | idle tooltip |
|--------|---------|------|--------------------|--------------|
| Run | A run is in flight: badge `progressText(progress)` while `checking` / `judging`, else `running` (an older `held` or `cooling` line is not progress) | never | mode `off`: `rails is off · #rails manual`; a run in flight: `a run is already in progress` | trusted: `Run the checks and the judge now (#rails now · r)`; otherwise `Judge only — checks wait for trust (#rails now · r)` |
| Send | never | `lastSend.runId === latest.runId`: badge `✓ <time>`, tooltip `<n> findings sent to <lane> <date time>` | no open finding: `no open findings`; no active lane: `no active lane` | `Send <n> open findings to <lane> (#rails send · s on the head row)` |
| Trust | never | `trust === 'trusted'`: badge `✓ trusted`, tooltip `rails.toml is trusted · <n> checks may run` | never | `untrusted`: `Allow the <n> checks listed above to run (#rails trust)`; `changed`: `rails.toml changed since trust — allow the <n> checks listed above (#rails trust)`; no checks: `Trust rails.toml so auto runs can start (#rails trust)` |
| Update | `updateLane` set: badge `running · <lane>`, tooltip `Update running in <lane>` | never | `ticketWorkActionDisabledReason(activeLane)` | `<lane> proposes rails changes, then waits for you (#rails update)` |

Counts use the singular for one (`1 open finding`, `1 finding sent`).

`<time>` is `formatActionTime` from spec 342: `HH:MM` today, `MM-DD` otherwise, so the dock needs no
timer. A done button stays enabled. A running button keeps its colour when disabled.

### Controller

```ts
export const RAILS_UPDATE_LABEL = 'rails update'; // the label update() already passes
private lastSend: RailsSendMark | null = null;    // set by send(…, null), the send-all path
runDockAction(action: RailsDockAction): void;
// active lane L → host.trackCommandRun(L, `#rails ${verb}`, () => runCommand(L, [verb], text)):
//   now → requestRun(L), awaited until recorded · send → send(L.id, null) · trust → trust()
//   update → update(L, '')
// no active lane: now → requestRun(null) · trust → trust() · else flash "no active lane"
// `r` in the dock is runDockAction('now')
```

The lane-bus subscription calls `renderDock()` after `onLaneStatus` on every `lane:status`.
`startRun` and the run's `finally` call it too, so Run turns running before the first progress
report and idle once the run settles. A closed lane needs no handler: `closeLane` already ends in
`render()`, which repaints the dock. `renderDock()` passes `{ model, actions: railsDockActions(…),
onSelectRow, onAction }`.

`RailsDock` mounts the bar as its own `ActionsBar` sub-component and updates it before its own
deps compare, so a lane going busy repaints the four buttons and never recomputes the rows.

### Data Flow

```
Send
1. Click Send. RailsDock's delegated listener finds [data-rails-action="send"]. It ignores a
   disabled button and the second click of a double click (event.detail > 1), then calls
   onAction('send').
2. runDockAction('send') → trackCommandRun(L, '#rails send', …) → runCommand → send(L.id, null):
   the same call as `#rails send` and as `s` on the head row → injectEnvelope; chip
   "rails: sent 3 findings → codex-1".
3. lastSend = { runId, laneName, count, at } → renderDock() → Send repaints as "✓ 14:02" in the
   done colour and stays enabled.
4. A newer run lands (history[0] changes) → the mark no longer matches → Send is idle again.

Update
1. Click Update while the active lane is idle → update(lane, '') → rails_load →
   enqueueSystemPrompt(lane, prompt, undefined, RAILS_UPDATE_LABEL).
2. The view sets lane.activeSystemLabel, flips the lane to busy and emits lane:status →
   renderDock(): Update shows "running · codex-1", disabled with its colour kept.
3. The turn ends → setLaneStatus clears the label and emits lane:status → renderDock(): Update
   is idle again.
```

### Keybindings

No new keys. Each button's keyboard path already exists:

| Button | Keyboard path |
|--------|---------------|
| Run | `r` in the dock, `#rails now` |
| Send | `s` on the head row, `#rails send` |
| Trust | `#rails trust` |
| Update | `#rails update` |

### UI Changes

The bar sits between the scrolling rows and the key hints, so it never scrolls away:

```text
  …rows (scroll)…
ACTIONS                         lane codex-1 · idle
[ ▷ Run              ] [ ➚ Send              ]
[  check 2/3 tsc     ] [  ✓ 14:02            ]
[ ◇ Trust            ] [ ✎ Update            ]
[  ✓ trusted         ] [                     ]
j/k · ↵ · 1–5 · s send · r run · [ ] tab · esc
```

- `.acp-rails-dock__actions` is the bar: `flex: 0 0 auto`, a top border like `__keys`, padding
  `8px 14px`. Its head line holds `actions` in the `__section` style on the left and
  `.acp-rails-dock__lane-line` on the right. `.acp-rails-dock__action-grid` has two columns with
  `minmax(36px, auto)` rows and a 6 px gap: the ticket grid's rows, two columns wide, so a badge
  such as `check 2/3 typecheck` or `running · claude-1` fits.
- The bar is a `role="group"` (`aria-label="Rails actions"`) outside the `listbox`. `j`/`k` never
  land on it, and the listbox keeps only options and presentation rows.
- Each button is a `DockActionButton` with `data-rails-action="<verb>"`. The ticket buttons keep
  `data-ticket-dock-action`. The look of the `acp-dock-action` block is the ticket look moved over
  unchanged: amber idle, cyan running, green done, 0.45 opacity when disabled, and full opacity for
  a running button that is disabled. There is no animation.
- The light scheme adds the bar heading to the rails sheet's `#8a5a00` accent list.
- Icons, 16×16, stroke 1.35, round caps and joins, `currentColor`: Run is a play triangle, Send a
  paper plane, Trust a shield holding a check, Update a pencil.
- Colour and ADR-0025 item 5: the button colours are action states shared with the Ticket Panel,
  never verdicts. No button is coloured by a verdict, Run has no done state, and the fault colour
  stays reserved for a failed check.

## Edge Cases

- **Double click on Send:** the second click is ignored. A later, separate click sends again; the
  done colour warns but never blocks (the spec 342 rule).
- **Mode `off`:** Run is disabled with the reason. A typed `#rails now` still answers with its chip.
- **Update clicked twice before the lane goes busy** (`rails_load` in flight): the second
  `enqueueSystemPrompt` sees a busy lane and returns false, so no second turn starts.
- **Update typed with a request** (`#rails update <request>`): it uses the same label, so the
  button shows the same running state.
- **Active lane switched:** `render()` repaints the dock. The Send and Update tooltips name the new
  lane. The Send mark stays, because it is keyed by run, not by lane; its tooltip names the lane it
  went to.
- **Lane closed mid-update:** the lane leaves `lanes` before `closeLane` ends in `render()`, which
  repaints the dock. No lane carries the label, so Update is idle.
- **Manifest edited after trust:** `trust` becomes `changed`, and Trust is idle again with the
  changed wording.
- **Trust while auto runs are paused:** the existing `trust()` clears `paused`, flashes and
  repaints.
- **Remote harness, narrow overlay, dispose:** unchanged. There is no controller remotely, the bar
  is part of the dock content, and no timer is added.

## Open Questions

None. These choices are deliberate:

1. Four buttons: Run, Send, Trust and Update. There is no Init button (the tab exists only with a
   manifest) and no mode buttons (mode is a setting).
2. Trust becomes clickable in the dock, which amends spec 337's and 338's Out of Scope. Trust still
   has no key.
3. Update from the dock is the bare form only: the lane proposes and waits. A specific change is
   still typed as `#rails update <request>`.
4. The bar is fixed above the key hints instead of being a row in the list, so it never scrolls
   away and `j`/`k` skip it.
5. Spec 342's button becomes a shared component. The Ticket Panel's look and behaviour do not
   change.

## Out of Scope

- Init and mode buttons; any new dock key.
- A Send button on each finding row (`s` on a finding row already sends one).
- Keeping the Send mark across restarts.
- A confirmation dialog for Trust.
- Any change to what the Ticket Panel shows or does: its six verbs, their states, badges and
  tooltips stay as they are. Only its button class moves to the shared component.

## Resources

- [Testing — Visual Studio Code docs](https://code.visualstudio.com/docs/debugtest/testing): Run and Debug controls in the Test Explorer heading, a run icon per node, Show Output and Fix Test Failure beside the results.
- [Bugbot — Cursor docs](https://cursor.com/docs/bugbot): Fix in Cursor / Fix in Web links on each finding; manual re-run with `bugbot run`.
- [direnv(1)](https://direnv.net/man/direnv.1.html): `direnv allow` approves exact file content (the spec 337 trust model).
- Internal: specs 337, 338, 342, 343, 302 §1.6 and §5.7; ADR-0025.
