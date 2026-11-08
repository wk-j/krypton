# Assistant Instance Monitor — Implementation Spec

> Status: Implemented
> Date: 2026-11-04
> Milestone: ACP Harness — observability
> Builds on: 0091 (resources), 0301/0302 (components), 0306 (Assist), 0333 (Inline AI), 0337 (Rails), 0347 (side panels)
> Styling superseded by [spec 0366](./0366-console-faceplate-ui.md) and DESIGN.md 2.0.0 (Krypton Console): `DESIGN.console.md` merged into DESIGN.md; dock tokens are `--mat-*`.

## Problem

The Harness can show its lanes, but assistants also run outside those lanes: Assist, Rails judges, session-picker probes, Inline AI, and embedded Pi agents. The existing Lane Metrics overlay and browser Lane Monitor do not answer “how many assistant instances exist, who owns them, and which are working?” A constructed session wrapper is not an initialized agent or a spawned process.

## Solution

Add a persistent **Assistants** tab to the existing in-app right dock, after Ticket and Rails. Its inventory is **app-wide**, across all projects and Harness views, including background helpers and embedded assistants. Opening the monitor never starts, initializes, prompts, or cancels an assistant.

Use the Rust `AcpRegistry` as the authoritative inventory of spawned local/remote ACP transports. Merge initialized embedded `AgentController` instances through one frontend store. Keep assistant counts, process counts, activity, and unavailable resource measurements distinct; this is a read-only monitor, not another agent launcher.

## Research (pre-implementation baseline)

- `src-tauri/src/acp.rs:1789–1848,1874–2062`: all production ACP launches converge on `acp_spawn` and the global registry. Its numeric `session` identifies a transport/process epoch; the string ACP conversation ID can change without a new process.
- `acp_get_lane_metrics` (`acp.rs:2722–2756`) already samples every registered local ACP root, including helpers and probes. Existing Harness rendering filters those results back to its own lanes. Remote clients have no local PID and are absent from resource samples, not from the registry.
- `src/inline-ai-session.ts:54–79,140–151`: Cmd+K can prepare a process before submission; repeated conversations reuse it. Assist and Rails each own a separate lazy `AcpAssistSession`; their wrapper constructors do not spawn anything.
- `src/agent/agent.ts:477–511,655–685`: embedded agents initialize lazily. Actual consumers are AgentView, FileManagerAI, and MarkdownViewAI, verified through `AgentController` references. They share the WebView process and must not receive invented per-agent OS metrics.
- `src/acp/harness-dock.ts` assumed exactly two tabs in availability, cycling, fallback, and persistence. The dock is 352 px wide and overlays content below the existing narrow-container breakpoint; compact rows fit better than a wide process table.
- `getPaletteActions()` returned early when there was no lane. The new action precedes that return. Existing Leader `=` remains Lane Metrics; no new chord is needed.
- Before the shared-feed cutover, each Harness sampled from construction to disposal, not according to visibility despite older wording in spec 0091. The shared store preserves that existing demand rather than adding another all-process poll per monitor.

## Prior Art

| App / surface | Implementation | Design consequence |
|---|---|---|
| VS Code Process Explorer | Help → Open Process Explorer shows a continuously updating process list; `code --status` gives a snapshot. | Explicit identities and resource values, rather than inferring instances from chat rows. |
| VS Code Agents window | Command Palette → Chat: Open Agents window; session list spans workspaces and can group by workspace or time. | All projects by default; make ownership visible. |
| Krypton Lane Metrics / browser Lane Monitor | Per-Harness lane process trees / cross-Harness lane telemetry. Neither inventories all helpers or embedded agents. | Preserve both surfaces; do not rename either as an all-instance monitor. |

**Krypton delta:** a persistent, keyboard-first in-app dock, not a new native window. It includes warm idle helpers and embedded agents while distinguishing them from OS processes.

## Scope and counting

| Instance role | Included when | Lifetime / counting |
|---|---|---|
| Harness lane | Its ACP subprocess launch succeeds, including initialization in progress. | One row per numeric ACP transport handle. |
| Session-picker probe | Backend browsing actually spawns its ACP client. | Promotion to a lane updates ownership on the same row; no extra instance. |
| Assist | Its lazy ACP launch succeeds. | One warm process per owning Assist session, not one per task or lane. |
| Rails judge | Its separate lazy ACP launch succeeds. | Distinct from Assist; check-command subprocesses are not assistants. |
| Inline AI | Cmd+K setup actually launches its ACP client. | Reused conversations do not increase the process count. |
| Commit explainer | A Commit Browser explainer job spawns its ACP process (spec 0376). | One per running job, labelled `explain <repo>@<sha7>`; gone when the job ends. |
| Embedded AgentView / File Manager AI / Markdown AI | `AgentController` creates the underlying Pi Agent. | One embedded instance; no dedicated PID, CPU, or RSS. |

“All” means every assistant managed by these Krypton lifecycles, not arbitrary agent CLIs the user starts in a terminal or provider-internal workers. MCP servers, shell tools, SSH runtimes, dictation, quota-probe utilities, and configured-but-unstarted wrappers are not additional assistants. Agent-reported subagents are not independently managed ACP transports; the panel must not count their reported names or every OS descendant as another initialized instance. Existing execution/subagent surfaces remain their source of detail.

## Design

### Workflow and presentation

1. In any Harness, including an empty one, press **Cmd+Shift+P → Open Assistant Instances** (`acp.harness.assistants`). The command explicitly shows the right side, unhides Assistants, selects its tab, and focuses it. These are the existing side/panel operations composed by a user-invoked Open command; ordinary per-panel toggles still do not rewrite the right-side flag.
2. The heading says **All projects**; the dock tab above already names the panel. No implicit filter follows the active lane or hosting project. The same line carries freshness (`Updated HH:MM:SS`, local time); a stale or failed refresh becomes a full-width warning line under it — `Refresh failed: <cause> · last success HH:MM:SS`, or `Stale inventory · last success HH:MM:SS` without an error.
3. Summary: four equal columns, glyph + figure over a short label — **ACP** (known-live ACP processes), **embedded**, **working** and **unknown** (liveness); each cell's title carries the full name. A non-zero working count is amber and a non-zero unknown count warning. Known-live process count includes starting/idle/running/stopping processes, excludes confirmed exits, and never treats an unavailable remote observation as zero or a confirmed exit. Total managed rows and known-live process count are not interchangeable.
4. Rows are two lines beside the backend logo. Line one: the name — plus the role unless the row is a Harness lane or the label already says it; a helper label's cwd part is left to the project fact — then the activity chip and CPU / memory in fixed-width cells. Line two: project · host (only when not the usual local process) · model without its provider prefix, then age. A third line of chips appears only while lifecycle or liveness is unsettled or an error is reported. Unmeasured resources show a short reason in the figure slot; a stale sample dims its figures. Left text clips to one line and the right cluster never does, so figures and ages share one right edge down the list. The selected instance's details sit pinned under the list as one label/value grid — identity, execution (including state) and timing bands split by etched grooves, every value on one column — and carry every value whole: full instance/conversation IDs, exact cwd, full model id, local timestamps (the ISO instant as the hover title), and unavailable reasons. Free height is shared between list and details until each fits its content; each scrolls on its own, and a key-hint footer closes the panel. Rows use the dock's body size; state chips use the standard chrome font size from DESIGN.md. Do not show full argv, prompts, transcript text, output tails, credentials, or environment values.
5. Use `j/k` or arrows to select, Home/End for boundaries, and `[` / `]` to cycle available dock tabs backward/forward. Consume monitor-focused typing so it cannot modify the composer draft. Escape returns focus to the composer (Harness root when no lane exists), leaving the tab visible. Existing permission/question handling keeps precedence.
6. Empty inventory is **No assistant instances started**, not an unavailable tab. Loading and errors are separate states. A failed refresh keeps the last successful rows with a stale timestamp and error indicator; it must not replace them with a misleading zero.

The tab defaults hidden so upgrading does not reserve a new 352 px column in previously dockless Harnesses. Explicit opening persists its visibility and selected-tab preference per project using existing mechanisms. Extend hidden-panel storage to `{ version: 2, hidden: HarnessPanelId[] }`; migrate legacy arrays by preserving every old flag and adding only `assistants` as hidden. The new-format `hidden` array may omit `assistants` after an explicit show. Invalid/missing storage uses the existing defaults for old panels and hides only the new one. Migrate legacy data on read/write without maintaining two writer formats.

Add `assistants` to `HarnessDockTab`, `HarnessPanelId`, `#panels` parsing/help, layout order 30 in `dock.right`, and tab persistence. Keep the existing seven individual titlebar icons; the existing right-side toggle controls this dock too. Generalize the dock's ordered available-tab traversal/fallback, not a second dock implementation. Availability is independent of row count; panel visibility still follows its own flag and the right-side flag. No new TOML configuration.

### Inventory contracts

New types live beside ACP types and mirror Rust serialization using snake_case:

```ts
type AcpInstanceRole = 'harness_lane' | 'session_probe' | 'assist' | 'rails_judge' | 'inline_ai' | 'commit_explainer';
interface AcpInstanceOwner {
  role: AcpInstanceRole;
  label: string;
  harness_id: string | null;
  lane_id: string | null;
}
interface AcpInstanceSnapshot {
  session: number; // process epoch; never the string conversation id
  backend_id: string;
  owner: AcpInstanceOwner;
  cwd: string;
  acp_session_id: string | null;
  execution: { kind: 'local' | 'remote'; runtime_id: string | null; host: string | null };
  pid: number | null; // local PID only; remote PID is unavailable in this change
  lifecycle: 'initializing' | 'ready' | 'terminating' | 'disconnected';
  activity: 'idle' | 'running' | 'waiting';
  liveness: 'alive' | 'exited' | 'unknown';
  has_error: boolean;
  requested_model_id: string | null;
  confirmed_model_id: string | null;
  model_uncertain: boolean;
  started_at_ms: number;
  last_activity_at_ms: number;
}
```

Expose `acp_list_instances() -> Result<Vec<AcpInstanceSnapshot>, String>` as a read-only Tauri command. Require an `owner: AcpInstanceOwner` argument on `AcpClient.spawn` / `acp_spawn`, migrating **every** production caller; expose `acp_set_instance_owner(session, owner) -> Result<(), String>` for probe-to-lane promotion and Inline AI owner changes without respawn. Helper hosts supply lazy Harness-ID getters because their constructors run before Harness memory initialization. Labels are attribution, never authorization.

Retain lightweight lifecycle/model observations in Rust `AcpClient` at existing initialize, session new/load/resume, prompt, pending-interaction, model-change, disconnect, and disposal paths. Activity comes from actual protocol work, not CPU heuristics. Human-interaction wait is derived from existing pending maps. Distinguish reported/confirmed models from requested aliases and timed-out uncertain changes; never present config alone as confirmed model state. Do not collect token/cost totals for this panel.

Backend snapshots do not send requests to agents. Snapshot client references under the registry lock, then read per-client state without holding that lock across awaits or OS sampling. A local process's identity is its numeric transport epoch plus captured process start identity, not PID alone; reject samples from a reused PID. A terminating client remains observable until existing teardown completes, with one teardown owner under concurrent disposal. Confirmed-ended disposals disappear; unresolved remote executions follow the rule below. There is no history database or retained-history UI.

Local liveness uses actual process observation; stdout closure by itself is not a confirmed process exit. Remote rows use the existing runtime identity and connection/exit observations. SSH/runtime loss is **unknown**, not exited. `AcpRegistry` retains a lightweight unresolved-remote snapshot before releasing a disconnected proxy, independent of frontend subscriptions; include it in `acp_list_instances` until that execution's exit is confirmed or the app closes. This is unresolved execution state, not completed-instance history. A reconnect creates distinct process epochs and must not overwrite unresolved rows. Older runtimes need no protocol extension: remote PID/CPU/RSS show **— · not available from remote runtime**. Inline AI in an SSH pane is labeled **local execution** because only its tools target SSH.

### Embedded agents and shared frontend state

Add one app-scoped `assistant-instance-store.ts`, imported without Harness dependencies by `AgentController` and by the monitor controller. It merges backend ACP snapshots with embedded entries keyed by an opaque, never-reused ID. Embedded roles are `agent_view`, `file_manager_ai`, and `markdown_ai`; their process fields are null with reason **shared WebView process**. Their count is displayed separately from ACP process count.

Register an embedded entry only after its underlying Pi Agent exists. Publish activity/model/project changes from the controller's actual lifecycle. Reset/model replacement retires the old instance; the next real Agent gets a new ID. Add a controller `dispose()` called by all three owning views/overlays; stop observation and retire its entry on teardown. Abort alone does not delete a warm agent. If an old run is still settling after reset/disposal, its entry remains stopping until settlement, and late callbacks cannot mutate a replacement instance.

Reuse one ref-counted local metrics feed for existing Harness consumers and the monitor, replacing each Harness's independent `acp_get_lane_metrics` timer. Preserve those consumers' existing sampling demand; the monitor adds demand only while actually shown and the document is visible. At most one request cycle is in flight, with immediate first load and a 2000 ms repeat interval. Multiple visible monitors share the same snapshots/samples. Metadata polling is needed only while an inventory consumer is visible; embedded lifecycle registration continues while hidden. With no consumers, stop timers; reopening loads current state before claiming freshness. Reject late responses from an earlier subscription generation.

Join existing resource results by numeric ACP handle. CPU/RSS cover adapter plus descendants, but descendants do not increase assistant counts. Unavailable/unsampled/stale values are labeled rather than fabricated as zero. Until a fresh CPU delta exists, show **warming up**, not a measured zero. Panel resource values use existing `formatCpu`/`formatRss`; no new meters, sparklines, or process-tree UI.

### Component ownership

Add props-only `AssistantInstances` under `src/acp/components/assistant-instances/`, registered once in `HARNESS_COMPONENTS`. Its controller owns row selection and shared-store subscriptions; `HarnessDock` owns pane placement and `hidden`. Use `Component.readDeps()` and keyed `reconcile()` by instance ID; dependencies include every displayed state/freshness value, never a mutable row object alone.

Updates invalidate only `rightRail` or call the owning component's `update()`. They never render transcript/composer regions or mutate sealed rows. Follow `DESIGN.md`, existing theme tokens, BEM, and `krypton.component` / `krypton.scheme` layers. Include an explicit block-scoped `[hidden]` rule where display is declared. No new ambient animations, left-edge accent rails, corner brackets, or blur.

The panel uses the console faceplate of `DESIGN.md`, like the Ticket and Rails docks: engraved labels, the counts in readout windows, the list and the details in recessed wells split by etched grooves, lamps for state (DESIGN.md "Lamps": an LED before the state word — a lamp window behind glass for work in progress, a human wait or a fault, a dark LED and ink for a settled or ended state), ink tiers for values, and a full-row selection tint (ADR-0027); its rows inherit the dock body size, while state chips use the standard chrome font size like Rails check outcomes. Glyphs are `<symbol>` defs in `harness-icons.ts` (`assistants`, `process`, `embedded`, `unknown`, `clock`) and backend logos tinted by `--krypton-backend-*`; a state chip carries no glyph, its LED says the tone. State chips reuse `Chip`. The selected-instance details are their own sub-component with a value dependency tuple, so an age tick that changes nothing they show leaves their DOM — and any text the user selected in it — untouched.

## Affected Files

| File(s) | Change |
|---|---|
| `src-tauri/src/acp.rs`, `src-tauri/src/lib.rs` | Inventory/owner DTOs and commands, lifecycle observations, teardown visibility, and unresolved remote execution snapshots. |
| `src-tauri/src/process_metrics.rs` | Validate root process start identity before attaching an OS sample to an ACP epoch. |
| `src-tauri/src/remote_harness.rs` | Read-only runtime/host accessors and distinguish connection loss from confirmed agent exit; no remote-protocol change. |
| `src/acp/client.ts`, `src/acp/types.ts`, `src/types.ts` | Typed spawn attribution/owner update, inventory contract, and required `AcpLaneMetrics.cpu_ready`. |
| `src/assistant-instance-store.ts` (new) | Shared ACP inventory consumption, embedded registration, and ref-counted metrics feed. |
| `src/acp/assist/acp-completion.ts`, `src/acp/harness-assist-controller.ts`, `src/acp/harness-rails-controller.ts`, `src/acp/harness-view-host.ts` | Explicit helper roles and lazy owner identity. |
| `src/inline-ai-session.ts`, `src/compositor.ts` | Inline attribution and current owner, preserving warm-process reuse. |
| `src/agent/agent.ts`, `src/agent/agent-view.ts`, `src/file-manager-ai.ts`, `src/markdown-view-ai.ts` | Embedded lifecycle registration, owner labels, and teardown integration. |
| `src/acp/harness-assistants-controller.ts` (new), `src/acp/acp-harness-view.ts` | Dock lifecycle, zero-lane palette action, keyboard/focus, targeted rendering, shared metrics consumption, and probe promotion. |
| `src/acp/components/assistant-instances/` (new), `src/acp/components/registry.ts` | Component, layered stylesheet, and behavior tests. |
| `src/acp/harness-dock.ts`, `src/acp/harness-panel-visibility.ts`, `src/acp/harness-layout.ts`, `src/styles/harness-shared.css` | Three-tab traversal/persistence, opt-in visibility migration, new pane fill/hidden selectors. |
| `src/acp/hash-commands.ts`, `src/acp/components/help-overlay/index.ts` | Extend existing `#panels` IDs/help; no new hash command required. |
| Existing ACP/agent/store/dock/component tests | Extend behavior boundaries described below, not source-text or forwarding assertions. |
| `docs/README.md` | Index the implemented spec. |
| `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0091-acp-lane-resource-metrics.md`, `docs/0302-harness-component-catalog.md`, `docs/0337-rails-verifier.md`, `docs/0347-harness-left-right-panel-toggles.md` | Inventory flow, shared polling, third tab, visibility/persistence, component catalog, and exact current resource shortcut. Whole-contract sweep removes obsolete two-tab/polling claims. |

## Edge Cases and Acceptance

1. Opening an otherwise unused Harness and its monitor starts no agent: inventory and both instance counters are zero; constructing Assist/Rails wrappers creates no rows.
2. Start lanes in two Harnesses/projects: either panel shows both. Switching active lane/project does not filter the inventory.
3. Trigger Assist, Rails judge, and Cmd+K setup: separate helper rows appear, warm idle rows remain visible, repeated turns/conversations do not inflate counts, and view disposal removes confirmed-ended instances.
4. Browse saved sessions: the real probe appears before a conversation is loaded; promotion relabels the same row without another process.
5. Initialize each embedded owner: all three roles appear without fabricated PID/CPU/RSS; close/reset/model replacement retires the correct identity despite late events.
6. Initialization error, permission wait, cancellation, unexpected EOF, and concurrent disposal show accurate independent lifecycle/activity/liveness; stopping rows do not disappear before teardown.
7. Remote lanes/Assist/probes are listed; disconnect reports unknown and retains unresolved identities across reconnect. Unsupported remote resources and embedded metrics never read as measured zero. Local PID reuse cannot attach another process's sample.
8. Two open panels plus multiple Harnesses share one metrics request cycle. Overlap, hidden/reopen, disposal, errors, and out-of-order responses cannot publish stale state as fresh or erase valid inventory.
9. Opening works with zero lanes and a previously hidden right side. Three-tab directional cycling/fallback, legacy preferences, explicit hide/show, focus restoration, permission precedence, and narrow layouts preserve existing behavior and composer drafts.
10. After approval and implementation: extend deterministic lifecycle/counting/persistence tests, run the actual Tauri app, exercise lanes/helpers/embedded instances and dock keyboard navigation, and observe rendered/hidden state and live counts. Verify unchanged rows retain DOM identity and unrelated sealed transcript rows receive no mutations. Remote execution smoke needs an already configured reachable remote Harness; report unavailable environments explicitly.

## Implementation verification

- `npm run build`: frontend type-check plus main and loopback Vite builds passed. Existing third-party directive, mixed-import and chunk-size warnings remain.
- `npm test`: 284 files, 3404 tests passed. Coverage includes shared demand/freshness generations, all embedded roles with real Pi settlement, late restore/persistence/skills work, visibility migration, dock navigation, cross-project rendering and unchanged sealed rows/drafts.
- `cargo test --lib`: 644 tests passed. Inventory tests exercise transport versus conversation identity, owner promotion, actual pending interactions, model alias/timeout races, local EOF, concurrent/cancelled teardown, unresolved remote epochs across reconnect and PID reuse/CPU readiness.
- `cargo clippy -- -D warnings`, `cargo build`, and targeted `rustfmt --check` passed on `aarch64-apple-darwin`.
- Actual native Tauri/WKWebView smoke: 30 checks passed with real IPC, five ACP transports spanning two projects (lane, promoted probe, Assist, Rails and reused Inline AI), and three initialized embedded Pi Agents. The 352 px monitor showed every role; embedded rows had no fabricated process metrics, cwd updates propagated, and disposal retained stopping rows until settlement. Embedded setup held dispatch at the real persistence boundary and disposed before release: no provider request was sent.
- The same native run verified empty-Harness opening, hidden-right restoration, focus/typing/selection, shared sampling (at most one metrics request in flight), hidden Rails computed `display: none`, zero ACP prompts and zero sealed-row mutations. Source/render audit: keyed value dependencies, owned/disposed listeners and subscriptions, no per-monitor poll or ambient animation.
- Environment limits: no configured reachable remote Harness was exercised live; remote loss/reconnect behavior is covered by deterministic Rust tests. Windows/Linux runtime execution was unavailable on this macOS host. Native keyboard routing used real view handlers; macOS denied OS-level keystroke injection, so that OS chord injection was not claimed as verified.

## Open Questions

None for this proposal. Approval covers app-wide scope, embedded-agent inclusion, the opt-in persistent right-dock placement, and explicit unknown remote liveness/resources.

## Out of Scope

Launch/kill/restart controls, changing helper defaults or model behavior, token/cost accounting, remote metrics protocol extensions, persistent instance history, arbitrary terminal-process discovery, provider-internal worker discovery, a new loopback/browser page, or replacing Lane Metrics/Lane Monitor. The monitor never sends an LLM request or grants permissions.

## Resources

- [VS Code Performance Issues](https://github.com/microsoft/vscode/wiki/Performance-Issues) — official continuously updated Process Explorer workflow and `code --status` snapshot distinction.
- [VS Code Agents window](https://code.visualstudio.com/docs/agents/run/agents-window) — cross-workspace session inventory, palette entry, and explicit active-session context.
- `/Users/wk/Source/pi-mono/packages/agent/src/agent.ts:166–243,294–310` — embedded Agent lifecycle subscription/state and abort-versus-settlement behavior; read-only reference, no upstream changes.
