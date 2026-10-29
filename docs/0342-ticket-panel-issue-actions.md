# Ticket Panel Issue Actions — Implementation Spec

> Status: Implemented (rev 3: action icons; rev 2: buttons show whether each action already ran for this ticket)
> Date: 2026-10-29
> Milestone: ACP Harness — working-ticket workflow
> Amends: [0238](./0238-local-ticket-bundles.md) (the Ticket Panel stops being a read-only surface)

## Problem

The Ticket Panel shows the active ticket's GitHub issue, but every issue action has to be typed:
`#analyze-github-issue`, `#fix-github-issue`, `#post-github-comment` and so on. The panel already
knows the issue reference, so a user looking at the ticket cannot start the next step from it.
The panel also cannot say what has already been done. A second Comment posts a second public
comment, and a second Fix starts the work over.

## Solution

Add an **Issue actions** section to the Ticket Panel with six buttons, one for each spec-191
prompt verb that needs only the issue reference: Analyze, Fix here, Handle, Comment, Label and
Attach. A button runs the same path as the matching `#` verb typed with no reference. It calls
`runGithubIssuePromptVerb` with the active ticket's issue URL, in the active lane. The `#ticket`
picker's actions (spec 203) already work this way.

Each button also shows the action's **state** for this ticket. A plain button has never run. A
`running` button is running now in some lane. A `done` button has finished at least once, and its
evidence and time are shown on the button in a different colour. A done button stays clickable,
because the colour is a warning, not a block. Krypton keeps a small log of completed actions in
the ticket's own `ticket.json`, so the state survives a restart. It also reads evidence that
already exists: the analysis bundle, the issue's closed state and the PR that `issue_progress`
reported.

Each button has an icon in front of its label, so the six actions can be told apart at a glance.
The icons are `<symbol>`s in the harness sprite. They draw in `currentColor`, so an icon always
takes its button's state colour.

## Research

- **The panel was made read-only, but the reason no longer applies.** 0238 says *"Ticket Panel
  เป็น read surface ไม่มี action button footer"*. That line came in `f861959` (2026-08-31),
  together with a flicker fix. At that time the dock was rebuilt through one `innerHTML` string on
  every ticket event. That commit removed the old footer (Start work, Open context, Open analysis,
  Refresh, Collapse), and the commit message gives no reason for the removal. Since spec 302 the
  dock has been a `TicketDock` component with a deps tuple
  (`components/ticket-dock/index.ts`), so a button row costs nothing on paint. The user is
  explicitly asking for buttons, so this spec amends 0238.
- **All six verbs are already reachable from the controller.**
  `HarnessTicketHost.runGithubIssuePromptVerb` (`harness-view-host.ts:160-170`) accepts all six.
  The picker calls it with `[ticket.github.issueUrl]` (`harness-ticket-controller.ts:863`). With
  no payload, Label tells the agent to choose labels that already exist in the repo
  (`harness-prompts.ts:762-775`). Attach uploads the analysis bundle's `*.md`, or stops if there
  is none (`:798-815`).
- **Nothing records that a verb ran.** The verbs only enqueue a prompt
  (`acp-harness-view.ts:12223-12314`). The evidence that does exist is partial:
  - `ticket.analysis` (`markdownCount`) shows that an analysis bundle exists.
  - `ticket.github.state` shows `closed`. It is refreshed when the ticket is activated and by
    `#ticket refresh`.
  - `IssueBinding.phase` / `prUrl` (`harness-view-types.ts:856-874`) is self-reported by the lane
    through `issue_progress` (`acp-harness-view.ts:2955-3018`). Its phases are fix-oriented:
    `investigating … pr_opened, done, blocked`.
  - For Comment, Label and Attach nothing local exists. Reading them back from GitHub would need
    extra `gh` calls per paint and guesswork about which comment came from Krypton.
- **`ticket.json` is the right home.** It is project-local and shared by every harness on the
  same cwd, and it is already rewritten with `atomic_write_json` by status, GitHub and note
  updates (`ticket_bundle.rs:706-730`). `TicketMetadata` has no `deny_unknown_fields`, so an older
  Krypton ignores the new field, and with `#[serde(default)]` old files load unchanged.
- **The turn end is the reliable "it ran" point.** `finishTurn(lane, stopReason)`
  (`acp-harness-view.ts:8863`) sees every turn end, with `stopReason` and `lane.error`, before the
  status change. `end_turn` without an error means that the agent finished the prompt. It does not
  prove that GitHub accepted the write, and the button text says "ran", not "succeeded".
- **The dock does not repaint when the lane goes busy or idle.** `renderTicketDock` runs in the
  `rightRail` region (`acp-harness-view.ts:12525-12533`), which turn end never invalidates
  (`patchLaneTurnChrome`, `:8973`), and `setLaneStatus` (`:1760-1804`) touches no region.
- **A double click is not a duplicate turn, but it is a silent no-op.** For Analyze and Fix the
  verb awaits `bindActiveTicket` (`:12305`) before `enqueueSystemPrompt` flips the lane to `busy`.
  A second click in that window reaches `enqueueSystemPrompt`, which refuses a busy lane and
  returns `false` (`:2491`).
- **The keyboard path already exists.** A `#` verb with no reference resolves to the active ticket
  (spec 194). The dock is `tabIndex=-1`, Escape hides it and `[`/`]` switch tabs (spec 337).
- **Icons have one home and one style.** `src/acp/harness-icons.ts` injects every harness
  `<symbol>` once per document (`ensureHarnessSymbolDefs`), and components place them with
  `harnessIconEl(id, cls)`. The spec 320/323 sets (panel toggles, follow-up buttons) use a 16×16
  viewBox, `stroke-width` 1.35, round caps and joins, and `currentColor`. A wrench already exists as
  `krypton-icon-tool`. The follow-up `prompt` icon is a rectangular bubble with two text lines,
  so Comment needs a different bubble shape.
- **`ActionButton` cannot hold this button.** It renders a key hint and a label only. It sets
  `title` only while disabled (`components/action-button/index.ts:92-102`), and it has no icon
  slot and no second line. Widening the shared component for one caller would put three props on
  every other caller. The dock builds its own small `IssueActionButton` instead, next to its
  existing `ResourceRow`.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| GitHub.com | An issue's **Assignees** sidebar lists **Copilot**. Choosing it opens a dialog, and the agent starts on the issue. Failing Actions runs and PR merge boxes show **Fix with Copilot**. Once assigned, Copilot is listed as an assignee. A session started from a PR comment adds a "Copilot has started work" event to the PR timeline. | One-click agent actions, and the work item itself shows that the work already started. |
| VS Code GitHub Issues, Linear | Contextual actions sit next to the selected issue. | Recorded in spec 203's research. |
| Krypton `#ticket` picker (spec 203) | `⌘1 Analyze` / `⌘2 Post comment` / `⌘3 Fix here` on the selected row, in the active lane. | Same verbs, same lane rule; it has no done state. |

**Krypton delta.** A button starts a visible lane turn with its own transcript, permission mode
and `#cancel`. The done state warns with colour and never blocks, as the user asked. It records
that the turn finished, which is what Krypton can observe. It does not inspect GitHub for each
write.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/ticket_bundle.rs` | `TicketMetadata.actions: BTreeMap<String, TicketActionRun>`; `record_ticket_action_for_project`; command `acp_record_ticket_action`; tests |
| `src-tauri/src/lib.rs` | Register `acp_record_ticket_action` |
| `src/acp/harness-view-types.ts` | `TicketActionRun`; `LocalTicketSummary.actions?` |
| `src/acp/harness-ticket-helpers.ts` | `TICKET_DOCK_ACTIONS`, `TicketDockAction`, `ticketDockActionFromData()`, pure `ticketActionStates()` and `formatActionTime()` |
| `src/acp/harness-icons.ts` | Five new symbols in `HARNESS_ICON_SVG_DEFS`: `krypton-icon-issue-analyze`, `-issue-handle`, `-issue-comment`, `-issue-label`, `-issue-attach`. Fix reuses `krypton-icon-tool` |
| `src/acp/components/ticket-dock/index.ts` | Props `laneName`, `laneStatus`, `workDisabledReason`, `actions`; the Issue actions section; an `IssueActionButton` sub-component (icon, label, badge, `title`); deps tuple |
| `src/acp/components/ticket-dock/ticket-dock.css` | Grid, two-line buttons, `--running` / `--done` modifiers, target line, in `@layer krypton.component` |
| `src/acp/harness-ticket-controller.ts` | Running map, `beginAction` / `cancelAction` / `onTurnEnd`, `runTicketDockAction`, click routing, state computation in `renderTicketDock` |
| `src/acp/harness-view-host.ts` | `HarnessTicketHost.issueBinding(issueKey)` |
| `src/acp/acp-harness-view.ts` | Register/cancel in `runGithubIssuePromptVerb`; `ticketCtl.onTurnEnd` in `finishTurn`; dock refresh in `setLaneStatus` (active lane) and in the `issue_progress` handler (active ticket's issue); clear the running entry on lane removal |
| Tests | `ticket_bundle.rs` (record, validation, old file loads); `harness-ticket-helpers` state rules; `ticket-dock.test.ts`; `harness-ticket-controller.test.ts` |
| Docs | `0238` (replace the read-surface bullet, document `actions` in `ticket.json`), `0302` §5.7, `0004-architecture.md`, `0005-data-flow.md`, `README.md` index |

## Design

### Data Structures

```rust
// ticket_bundle.rs — one entry per verb: its latest completed run.
pub struct TicketActionRun { pub at: u64, pub lane_display_name: String }
// TicketMetadata gains:
#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
pub actions: BTreeMap<String, TicketActionRun>,
```

```ts
// harness-ticket-helpers.ts
export const TICKET_DOCK_ACTIONS = [
  { verb: 'analyze-github-issue', label: 'Analyze', icon: 'issue-analyze' },
  { verb: 'fix-github-issue', label: 'Fix here', icon: 'tool' },
  { verb: 'handle-github-issue', label: 'Handle', icon: 'issue-handle' },
  { verb: 'post-github-comment', label: 'Comment', icon: 'issue-comment' },
  { verb: 'tag-github-issue', label: 'Label', icon: 'issue-label' },
  { verb: 'attach-issue-artifact', label: 'Attach', icon: 'issue-attach' },
] as const;
export type TicketDockAction = (typeof TICKET_DOCK_ACTIONS)[number]['verb'];

export type TicketActionState =
  | { kind: 'idle' }
  | { kind: 'running'; lane: string }
  | { kind: 'done'; badge: string; detail: string };   // badge: "✓ 14:02" · "✓ PR" · "✓ closed"

export function ticketActionStates(input: {
  ticket: LocalTicketDetail;
  binding: IssueBinding | null;          // host.issueBinding(ticket.github.issueKey)
  running: ReadonlyMap<TicketDockAction, string>; // verb → lane, for THIS ticket
  now: number;
}): Record<TicketDockAction, TicketActionState>;
```

### State rules

`running` comes first. After that, the first matching evidence wins:

| Button | Done when (first match) | Badge |
|--------|--------------------------|-------|
| Analyze | log `analyze`; else log `handle`; else `ticket.analysis.markdownCount > 0` | `✓ <time>` (analysis: its `updatedAt`) |
| Fix here | `github.state === 'closed'`; else `binding.phase` is `pr_opened` or `done`; else log `fix`; else log `handle` | `✓ closed` · `✓ PR` · `✓ done` · `✓ <time>` |
| Handle | log `handle` | `✓ <time>` |
| Comment | log `comment`; else log `handle` | `✓ <time>` |
| Label | log `tag` | `✓ <time>` |
| Attach | log `attach` | `✓ <time>` |

- A finished **Handle** marks Analyze, Fix here and Comment as done, because it runs all three.
  Their tooltip says `via Handle`.
- `<time>` is `HH:MM` for today and `MM-DD` otherwise. These are absolute times, as in the Rails
  dock, so no timer is needed; "today" is judged against `now` at paint. The tooltip holds the
  full local date-time and the lane, for example `Comment ran 2026-10-29 14:02 in codex-1`, or the
  PR URL.

### API / Commands

```rust
#[tauri::command]
pub fn acp_record_ticket_action(harness_id: String, ticket_id: String, verb: String,
    lane_display_name: String, hook_server: State<'_, Arc<HookServer>>)
    -> Result<TicketBundleDetail, String>
// Rejects a verb outside the six names and an empty lane name. Read → set actions[verb] =
// { at: now_ms(), lane } → bump updated_at → atomic_write_json (same path as the GitHub update).
```

```ts
// HarnessTicketController
beginAction(lane: HarnessLane, verb: TicketDockAction): object | null; // null: no active ticket,
                                                                       // or lane already has one
cancelAction(lane: HarnessLane, token: object): void;   // only if the entry is still this token
onTurnEnd(lane: HarnessLane, stopReason: StopReason): void;
async runTicketDockAction(action: TicketDockAction): Promise<void>;
// HarnessTicketHost
issueBinding(issueKey: string): IssueBinding | null;
```

The running map is `Map<laneId, { ticketId, verb, token }>`, held in memory only. A running entry
is never written to disk, so a crash cannot leave a stuck `running` state.

### Data Flow

```
1. Click "Comment" (or type #post-github-comment; or picker ⌘2: every path enters the verb).
2. runTicketDockAction: no GitHub ref or lane not runnable → flash the reason, stop.
   A dock click already starting in that lane → flash "<label>: <lane> is starting an action", stop.
3. runGithubIssuePromptVerb builds the prompt. If the issue is the active ticket's:
   token = ticketCtl.beginAction(lane, verb) → the button shows "running · codex-1".
4. started = await enqueueSystemPrompt(...); if (!started && token) ticketCtl.cancelAction(lane, token).
5. finishTurn(lane, stopReason) → ticketCtl.onTurnEnd: remove the lane's entry. If
   stopReason === 'end_turn' && !lane.error → invoke acp_record_ticket_action →
   the returned detail replaces activeTicket when the id still matches → renderTicketDock().
   any other stop reason or a lane error → the entry is removed and nothing is recorded.
6. The button repaints as "Comment ✓ 14:02" in the done colour. It stays clickable.
```

`setLaneStatus` on the active lane and an `issue_progress` report for the active ticket's issue
call `renderTicketDock()`; that call is a deps-tuple compare when nothing changed. Lane removal,
restart and `#new` go through `releaseLane` (formerly `clearTicketWorkerForLane`), which drops
the lane's worker binding and its in-flight action together.

### Keybindings

There are no new keys. Each button is the same as its `#` verb typed with no reference:
`#analyze-github-issue`, `#fix-github-issue`, `#handle-github-issue`, `#post-github-comment`,
`#tag-github-issue`, `#attach-issue-artifact`. Typed verbs update the same state.

### UI Changes

A new `<section>` sits between `Worker` and `Context`:

```text
ISSUE ACTIONS
run in codex-1 · idle
[ ◇ Analyze ] [ ◇ Fix here ] [ ◇ Handle ]
[  ✓ 10-27  ] [    ✓ PR    ] [          ]
[ ◇ Comment ] [ ◇ Label    ] [ ◇ Attach ]
[  ✓ 14:02  ] [            ] [          ]
```

`◇` marks where each action's icon sits in this text sketch; the icons are listed below.

| Action | Icon | Drawing (16×16, stroke 1.35, `currentColor`) |
|--------|------|-----------------------------------------------|
| Analyze | `krypton-icon-issue-analyze` | Magnifier: circle r 4.3 at (7,7) and a handle to (13.8,13.8) |
| Fix here | `krypton-icon-tool` (existing) | The wrench the lane bar already uses |
| Handle | `krypton-icon-issue-handle` | Two nodes joined by a line, ending in an arrow: one action running several steps |
| Comment | `krypton-icon-issue-comment` | A rounded oval speech bubble with a tail, no text lines (unlike the follow-up `prompt` bubble) |
| Label | `krypton-icon-issue-label` | A tag with a hole |
| Attach | `krypton-icon-issue-attach` | A paperclip |

- Each button is an `IssueActionButton`: `<button type="button" class="acp-ticket-dock__action"
  data-ticket-dock-action="<verb>">`. Inside it, the first line holds the icon
  (`harnessIconEl(icon, 'acp-ticket-dock__action-icon')`, `aria-hidden`, 13px) and the label. The
  second line is the badge `.acp-ticket-dock__action-state`. The button's accessible name stays
  the label text. It has no click listener of its own, because the controller's delegated
  handler stays the only click path, as it is for `›`. Grid rows share one height, so a button
  without a badge centres its icon and label.
- **idle:** the amber secondary style of the dock's `›` button.
- **running:** `acp-ticket-dock__action--running`. It has the accent (cyan) border and text and the
  badge `running · <lane>`. It stays static, with no animation. A long lane name is cut with an
  ellipsis, and the full name is in the tooltip.
- **done:** `acp-ticket-dock__action--done`. It uses the green of the dock's existing
  `pill--done` (`#a8ffbf`) for border and text, with the `✓` badge. It is **not** disabled.
- **Lane not runnable** (busy, stopped, not connected): every button gets `disabled` and the reason
  as its tooltip, and the target line shows the reason as text. A running button keeps full opacity
  and its colour, so you can still see what is running.
- **No GitHub reference:** the section shows only `Link a GitHub issue to run issue actions:
  #ticket link <ref>`.
- The state is never shown by colour alone: the `✓` / `running` badge text carries it too.

## Edge Cases

- **Turn cancelled, errored, refused or cut off** (`cancelled`, `max_tokens`,
  `max_turn_requests`, `refusal`, lane error): the run is not recorded. A done state from an
  earlier run stays.
- **The agent finished but the GitHub write failed** (for example `gh` not authenticated): the
  button shows done. The badge means "ran", and the transcript has the failure. Checking GitHub
  for each write is out of scope.
- **The action ran in another lane:** it shows `running · <that lane>` and stays clickable from
  this lane.
- **The verb targets an issue that is not the active ticket's** (`#fix-github-issue owner/repo#9`):
  no entry is registered, and that ticket's log is not touched.
- **Active ticket switched mid-turn:** the entry keeps its `ticketId` and is written to that ticket.
  Only the dock of the ticket that is active at that moment repaints.
- **Lane removed or restarted mid-turn:** the entry is dropped. A restart's `finishTurn`
  (`cancelled`) also drops it.
- **Issue reopened after a fix:** `closed` no longer applies. The log (`✓ <time>`) still shows that
  Fix ran.
- **Two harnesses on one project:** both write the same `ticket.json`. The other harness picks up
  the change on its next ticket load (`#ticket refresh`, activation, worker idle reload). The
  write is an unlocked read-modify-write, like the existing GitHub and status updates. If both
  harnesses write in the same instant, one entry can be lost, which is the same risk those
  updates already accept.
- **Midnight:** a badge painted yesterday as `14:02` becomes `10-28` on the next dock paint.
- **Panel hidden or Rails tab shown:** `renderTicketDock` returns early. The state is painted when
  the tab is shown.

## Open Questions

None. These choices are deliberate:

1. Six prompt verbs only. **New lane** (`#dispatch-github-issue`) is excluded, as the user
   confirmed.
2. Actions run in the active lane. The running state is shown for any lane.
3. "Done" means the turn finished (`end_turn`), plus the evidence that already exists (analysis
   bundle, closed issue, `issue_progress` PR). GitHub is not queried for each write.
4. Done buttons stay enabled, with colour and badge only, as the user asked. There is no confirm
   dialog.

## Out of Scope

- A **New lane** button.
- Reading comments, labels or artifacts back from GitHub to prove a write.
- A run history beyond the latest completed run per verb.
- Showing the state in the `#ticket` picker.
- Local ticket actions (`#ticket work`, `refresh`, `open`, `status`) and `#create-github-issue`.
- A label picker, comment editor or confirmation dialog; dock-only shortcut keys.

## Resources

- [Using Copilot in the cloud on GitHub — Assigning an issue to Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github) — the Assignees → Copilot flow, the **Fix with Copilot** buttons and the "Copilot has started work" PR timeline event: GitHub's one-click agent actions, and the work item showing that work already started.
- Internal: specs 178/190 (`IssueBinding`, `issue_progress`), 191 (prompt verbs), 194 (no-reference verbs), 203 (picker actions), 238 (Ticket Panel, `ticket.json`), 302 §5.7 (`TicketDock`), 331, 337 (Rails dock: local times, no timer); commit `f861959`.
