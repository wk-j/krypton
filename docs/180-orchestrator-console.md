# Orchestrator Console — Implementation Spec

> Status: Implemented
> Date: 2026-06-30
> Milestone: M-ACP — Harness Multi-Agent
> Decision record: `docs/adr/0011-orchestrator-privileged-lane-and-acting-console.md`
> Terms: see `CONTEXT.md` → **Orchestrator**, **Orchestrator console**, **Dispatch**
> Related: `docs/164-polly-orchestration.md`, `docs/166-polly-live-plan.md`, `docs/168-harness-lane-monitor.md`, `docs/106-inter-lane-messaging.md`, `docs/111-harness-right-rail.md`, `docs/148-lane-goal-focus-scope.md`

## Problem

When a human runs several lanes — one coordinating, others doing the work — there is no single **in-app** surface to watch the whole fleet and act on it. The operator must switch the active lane to read each one, dispatch by hand-typing into a transcript, and watch progress through a per-lane Plan panel. The read-only lane monitor dashboard (spec 168) answers *"who needs me?"* but lives in an external browser, only observes, and sits outside the keyboard-first mode system. The user wants a dedicated, keyboard-driven **Orchestrator console** seated on one lane, and the UI must be **extensible** so future panels (task list, delegation graph) plug in without a rework.

## Solution

Introduce the **Orchestrator** — a privileged, **behavior-neutral** lane role (at most one per harness) — and the **Orchestrator console**, a full-surface in-app overlay opened from that lane. Per ADR-0011: designating an orchestrator only unlocks the console, badges the lane, and reserves it as the home for future orchestrator-only tools; it does **not** change how the lane's model behaves. Autonomous coordination stays opt-in via the existing `#polly` prompt — so the console has live fan-out to show on day one without new orchestration machinery. The console is built as a **shell of fixed regions** (lane grid · orchestration feed · dispatch) plus one **reserved region** future panels slot into, mirroring the rail-slot extensibility of spec 111. It **acts**: the human dispatches work (a `peer_send`, never a Goal-set) and overrides lanes (interrupt-turn / kill / restart, all reusing existing primitives). No new Rust command, no new MCP tool, no new telemetry channel, no lane-suspend concept.

## Research

- **All signals already live in the TS frontend.** `coordinator.listLanes()` → `LaneSummary { laneId, status, displayName, backendId, modelName, inboxDepth, activeDirective }` (`src/acp/types.ts:414`); `AcpHarnessView` owns `triageStore.statsFor(laneId)`, `reviewPriorityStore.highCountFor(laneId)`, and `this.lanes[]` (per-lane `plan`, `goal`, `activity`, `pollyBuiltinRole`). The lane monitor's `HarnessTelemetryPublisher` already folds exactly these into a snapshot — the console reads the **same** sources directly, in-app, so it needs no transport (`docs/168`).
- **Lifecycle primitives already exist; pause/resume does not.** `cancelLane()` (interrupt the current turn = `#cancel`/Ctrl+C), `closeLane()` (kill → `stopped`), `restartLane()` (`src/acp/acp-harness-view.ts:6962, 6876, 1881`). There is **no** suspend/freeze, and it does not fit ACP (an agent can have its turn cancelled, not paused mid-token) — so v1 binds the three that exist and adds no new lane state.
- **Autonomy already exists in prompt form.** `#polly` makes the active lane fan work out to workers via `peer_send` and loop on replies (`docs/164`, `src/acp/polly.ts`). The orchestrator role does **not** inject this (decoupled — grill Q9); the human runs `#polly` when they want autonomy. Note `pollyBuiltinRole` is **not** the orchestrator-seat field: `composeLeadingContext` injects `POLLY_ROLE_PROMPTS[pollyBuiltinRole]` whenever it is set (`acp-harness-view.ts:5625-5629`), so reusing it would inject the Polly orchestrator prompt and break behavior-neutrality. The seat is a **dedicated, prompt-free field** (`orchestratorLaneId`) and the console badge derives from it — `#polly` sets `pollyBuiltinRole` independently when the human opts into autonomy.
- **Dispatch must not set a Goal.** Setting a `Goal` clears the lane (fresh session + empty transcript — `CONTEXT.md`/spec 148). A dispatch is therefore a plain `peer_send` (inbox drop, drained on the worker's own idle turn); it never wipes a worker's context mid-run (grill Q7).
- **Overlay + slot patterns are established.** Triage/review/metrics overlays are `aside` at `position:absolute; inset:0` toggled by a boolean + keybinding (`acp-harness-view.ts:4501`); the lane-rail "slot" model (spec 111) is the precedent for the reserved region.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| k9s | full-screen live resource table; `:`-command acts on the selected row | closest model: a keyboard table of live rows + actions on the selection |
| tmux / Zellij | `choose-tree` / session-manager pane pickers | jump-only; no task dispatch, no per-pane telemetry |
| Omnigent (Polly) | a supervisor agent fans work to workers and synthesizes | the autonomy model `#polly` already ports; the console is its human-facing cockpit |
| Krypton spec 168 lane monitor | browser dashboard, poll telemetry, **read-only** | the console is its in-app, **acting** sibling (ADR-0011) |

**Krypton delta** — Unlike the read-only browser dashboard, the console is in-app, keyboard-first, and **acts** (dispatch + lifecycle override), staying inside the harness mode system. Unlike a tmux/Zellij picker, rows are live lane cards and the primary verb is *delegate*, not *switch focus*. It deliberately introduces the first asymmetric lane role and the first mutating cross-lane surface, bounded per ADR-0011 (behavior-neutral role; human keeps judgement + kill switch).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | New `orchestratorLaneId` (the designated seat — a dedicated, prompt-free field, **not** `pollyBuiltinRole`, which injects a prompt) + `orchestratorConsoleOpen` state + lazy `this.orchestratorConsoleEl` overlay; `renderOrchestratorConsole()` (region shell: lane-grid + orchestration-feed + dispatch + reserved slot) reading `coordinator.listLanes()` + stores + `this.lanes[]`; selection model + keyboard (`j/k/Enter/d/c/x/r/o/Esc`); dispatch → existing `InterLaneCoordinator` path; override → `cancelLane`/`closeLane`/`restartLane`; live re-render on `LaneBus` while open. |
| `src/acp/acp-harness-view.ts` (commands) | `#orchestrator` (alias `#console`) composer command = promote active lane (if no seat) + open console; `o` in console = transfer designation to selected lane. Enforce one-per-harness. Primary entry is the command; **leader key `` Leader ` ``** also opens it — `Leader Shift+O` was unavailable (`o`/`O` are reserved *global* leader keys, `leader-keys.ts`), so the backtick (free, adjacent to the `; ' , . /` cluster) substitutes per the spec-124/127/128 precedent (Q1). |
| `src/styles/orchestrator-console.css` *(new)* | `.acp-harness__orchestrator` overlay + `.acp-orchestrator__` region/grid/card/feed/dispatch + `--reserved` slot + the `.acp-harness__lane-orchestrator` lane-head badge. Flat chrome, no left-border rails, no nested boxes; `minmax(0, …)` grid tracks (WebKit collapse guard). Imported in `src/styles/index.css`. |
| `src/acp/hash-commands.ts` | `#orchestrator` added to the `#` palette catalog (discoverable autocomplete). |
| `src/acp/acp-harness-view.test.ts` | Unit tests for the exported dispatch helpers (`nextDispatchPurpose`, `orchestratorDispatchBody`, `dispatchDisabledReason`): purpose cycle/wrap; purpose-tagged body that is not a Goal/directive; dispatch eligibility (self / no-seat / no-target / lone-lane / allowed). The view needs a DOM, so the logic is extracted and tested — same convention as the rest of the file. |
| `CONTEXT.md`, `docs/adr/0011-…md` | Done. |
| `docs/PROGRESS.md` | Landing note. |

## Design

### State (view-private)

```ts
private orchestratorLaneId: string | null = null;   // the designated seat; prompt-free badge field, NOT pollyBuiltinRole
private orchestratorConsoleOpen = false;
private orchestratorConsoleEl: HTMLElement | null = null;   // lazy, like triageEl
private orchestratorSelectedLaneId: string | null = null;   // j/k cursor over lane cards
private orchestratorDispatch = { purpose: 'implement' as DispatchPurpose, draft: '' };
type DispatchPurpose = 'implement' | 'review' | 'explore' | 'search';   // mirrors #polly worker brief
```

Designation is **behavior-neutral** (ADR-0011): setting `orchestratorLaneId` flips the badge (the card's orchestrator badge derives from `lane.laneId === orchestratorLaneId`, not from `pollyBuiltinRole`) and unlocks the console; it injects no prompt. Autonomy is whatever `#polly` the human runs on that lane — which sets `pollyBuiltinRole` separately.

### Render model — derived, no persisted types

Per lane in `coordinator.listLanes()`, the lane-grid card derives `{ displayName, backendId, modelName, status, isOrchestrator, inboxDepth, attnOpen (triageStore), highPriority (reviewPriorityStore), goal, activity, planProgress (lane.plan done/total) }`. The orchestration-feed region renders recent dispatch/flag/reply events read off the same `LaneBus` + inter-lane rows. Nothing new is stored.

### Region shell (extensible — spec 111 pattern)

```
.acp-harness__orchestrator              (aside, position:absolute, inset:0, z-index:7)
├─ __head        seat · summary "3 lanes · 1 busy · 1 awaiting · 2 flags"
├─ __body (grid: main col + reserved col)
│   ├─ __region[data-region="lanes"]   → lane-grid panel (cards; selected ringed; orchestrator badged)
│   ├─ __region[data-region="feed"]    → orchestration-feed panel (autonomous fan-out + flags + replies)
│   └─ __region--reserved              → empty slot; future specs mount a panel here (task list, delegation graph)
├─ __dispatch    target (selected) · purpose · input
└─ __keys        keybinding legend
```

Region order is fixed in code (no plugin registry — grill Q6). The reserved region is defined but empty in v1; a later spec mounts its panel without touching the shell.

### Dispatch (the one mutation that creates work)

```
1. Selected lane card + press d → dispatch input opens; type task, Tab cycles purpose, Enter sends.
2. dispatchFromConsole(purpose, text)  [eligibility via dispatchDisabledReason()]
3. composes orchestratorDispatchBody() = "[purpose] <text>" and calls the SAME InterLaneCoordinator
   path @mention fan-out uses, with a single target:
   coordinator.deliverMentionFanOut(seat → [target], body). It is a peer_send — NOT a Goal set.
4. target gets an inter_lane in-row, drains on its next idle turn, replies as a new user message
   to the orchestrator (spec 106 lifecycle). The seat flips to awaiting_peer; the console
   re-renders on the next LaneBus event (a live subscription held while open).
```

The dispatch helpers (`nextDispatchPurpose`, `orchestratorDispatchBody`, `dispatchDisabledReason`)
are exported pure functions, unit-tested in `acp-harness-view.test.ts` (the view itself needs a DOM,
so the testable logic is extracted — same convention as the rest of that test file).

### Override (reuse existing primitives — no new state)

| Key | Action | Calls |
|-----|--------|-------|
| `c` | interrupt the selected lane's current turn | `cancelLane(lane)` |
| `x` | kill the selected lane | `closeLane(lane)` |
| `r` | restart the selected lane | `restartLane(lane)` |

No pause/resume (grill Q8). No setting another lane's permission *mode* in v1 (deferred — safety). **Follow-up (spec 181):** answering a worker's *pending* `needs_permission` request — accept/reject in place via `a`/`r` — is added in `docs/181-orchestrator-console-permission-action.md` (the persistent *mode* stays deferred); while the selected card has a pending permission, `r` is reject and restart is shadowed.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `#orchestrator` / `#console` | Harness composer | promote active lane (if no seat) + open console |
| `Leader` `` ` `` | Harness | promote active lane (if no seat) + open console (same as `#orchestrator`) |
| `j` / `k` | Console | move selection across lane cards — the **background active lane follows the selection** (`selectOrchestratorCard` → `activateLane`), so the transcript behind the console previews the selected card live; the overlay is a separate element `render()` never touches, so it stays open and on top |
| `Enter` | Console, card selected | jump to that lane + close console (the background is already on it, so this just dismisses the overlay) |
| `d` | Console, card selected | dispatch to selected (focus input; Enter sends) |
| `i` | Console (live seat) | prompt the seat — a normal turn, not a dispatch (spec 182; focus input, Enter sends) |
| `Tab` | Dispatch input | cycle purpose |
| `c` / `x` / `r` | Console, card selected | interrupt / kill / restart |
| `o` | Console, card selected | transfer orchestrator designation to it |
| `Esc` | Console | close |

No Alt modifier (project constraint).

### Live update

While open, subscribe `LaneBus` to `renderOrchestratorConsoleEl()` (any lane signal — status / spawned / closed / triage / review-priority — refreshes the grid + feed); unsubscribe on close and on view dispose. The re-render only rebuilds the panel's `innerHTML` (cheap) and `LaneBus` is purely event-driven — an idle harness emits nothing, so there is no idle CPU cost (no debounce needed).

## Edge Cases

- **Single lane:** console opens read-only — one card, dispatch disabled ("no other lanes").
- **Orchestrator lane closed/stopped:** designation clears; console closes; re-promote needed.
- **Dispatch target goes `stopped` between select and send:** fails like `peer_send` to a stopped lane (`lane_stopped` from the inter-lane path — `inter-lane.ts:186,240`; `harness_closed` is the distinct disposed-harness mode) — one-line notice, no crash.
- **Dispatch to self:** disallowed (greyed).
- **`awaiting_peer` target:** allowed — queues in inbox, drains on next idle (spec 116); inbox depth ticks up.
- **Reserved region:** renders an empty bordered placeholder in v1 (so the extension point is visible/tested), never a dead gap.

## Open Questions

1. **Keybinding `Leader Shift+O`** — *Resolved:* it collides (`o`/`O` are both reserved global leader keys in `leader-keys.ts`). Originally shipped with **no leader key** (`#orchestrator`/`#console` as the only entry). **Follow-up:** a leader key was added on request — `` Leader ` `` (backtick), the one free non-reserved punctuation key adjacent to the harness overlay cluster (`; ' , . /`), per the spec-124/127/128 free-symbol substitution precedent. The composer command remains the primary, discoverable entry.
2. **Cross-harness foreign peers in the console** — same-harness lanes only in v1 (dispatch + override); foreign peers (spec 141) listed read-only or omitted. **Proposed: omit in v1.** Confirm at implementation.
3. **Reserved-region placement** — right column (per mockup) vs bottom strip. Cosmetic; settle during CSS.

## Out of Scope

- **Orchestrator-only MCP tools** (e.g. `task_list`, structured dispatch tool) — deferred to follow-up spec(s) that mount into the reserved region / register onto the role (grill Q5).
- **AI-driven command of other lanes** (force-drain, set another lane's permission mode autonomously) — deferred; would need its own ADR (ADR-0011 "Considered Options").
- **Pause/resume / lane suspend** — does not exist and does not fit ACP (grill Q8).
- **Dispatch setting a Goal** — explicitly excluded (would clear the worker — grill Q7).
- New Rust command, MCP tool, or telemetry/SSE channel; mutating the read-only lane monitor dashboard; splitting `acp-harness-view.ts` (spec 105).

## Resources

- `docs/adr/0011-orchestrator-privileged-lane-and-acting-console.md` — the governing decision.
- `src/acp/inter-lane.ts` (`InterLaneCoordinator.deliver`) + `docs/106` — the dispatch (`peer_send`) path.
- `src/acp/polly.ts` + `docs/164`, `docs/166` — the `#polly` autonomy + live plan the console surfaces.
- `src/acp/harness-telemetry.ts` + `docs/168` — the read-only dashboard whose signals the console reuses in-app.
- `docs/111-harness-right-rail.md` — the slot extensibility pattern the region shell follows.
- `src/acp/acp-harness-view.ts:4501` (triage overlay), `:6962/:6876/:1881` (cancel/close/restart) — overlay + lifecycle prior art.
- `DESIGN.amber.md` — amber-phosphor chrome the console matches.
