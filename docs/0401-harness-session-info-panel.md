# Harness Session Info Panel — Implementation Spec

> Status: Implemented
> Date: 2026-11-15
> Milestone: ACP Harness — right dock
> Builds on: 0301 (component kernel), 0337 (dock column), 0347 (side visibility), 0374 (lane stats), 0380 (canonical lane events), 0396 (Git tab)

## Problem

The active lane's context use is compressed into the small lane-stats line. The user needs a readable session view in the right panel, using the supplied Context screenshot as the information hierarchy: a prominent occupancy readout, a progress bar, and supporting session details.

## Solution

Add a read-only `SESSION` tab to the existing right dock. It follows the active lane and uses the context `used`/`size` reported through canonical ACP usage events, plus session metadata already held by `HarnessLane`. The panel uses Krypton's faceplate materials and existing dock behavior. It never estimates a context-category breakdown from turn token counts. The 2026-11-15 follow-up moves every value from the second `LaneStats` row into Session Info and removes that row from the lane head. Spec 402 adds historical request evidence for the built-in `krypton-harness-memory` server in this pane.

## Research

- `HarnessDock` owns the 352px right column, tab selection, `[`/`]` cycling, and focus rescue. `HarnessLayout` places each tab in `dock.right`; the existing right-side visibility flag applies to every dock tab.
- `HarnessLane.usage` is a last-wins display aggregate. The generic adapter decodes `usage_update` as `used`, `size`, and optional `cost`; prompt-result usage also carries per-turn input/output/cache counters. The latter measure a turn, not the composition of the current context. `HarnessLane` also has `sessionId`, `backendId`, `modelName`, `effort`, and `status`.
- Usage events call `renderActiveLaneChrome` and `renderLanePeek` without repainting the transcript. The new dock must join this targeted path, and active-lane changes must update it even when the lane object is mutated in place.
- The reference image includes category counts, free-space and autocompact details, and account Connectors. ACP supplies only the aggregate context occupancy. There is no trustworthy category or account-connector-state feed in the current lane model. Spec 402 uses separate, host-observed request counters for Krypton's own MCP server; these do not describe account Connectors or live connection state. Showing categories or Reconnect controls from guessed data would be false.
- The component kernel requires a component-owned stylesheet inside `@layer krypton.component`, a registry entry, and a `readDeps()` tuple containing every mutable value its paint reads. The dock host retains ownership of `hidden`.

## Prior Art

| App | Implementation | Krypton choice |
|-----|----------------|----------------|
| VS Code Chat | The context-window control opens a session-info popover with token usage and a category breakdown. | Keep the overview and hierarchy, in a persistent right-dock tab; show only fields ACP actually reports. |
| Zed Agent Panel | Shows thread token use near the model selector and exposes compaction in the thread. | Reuse the existing lane's context reading rather than introduce a second counter. |

The screenshot is the visual reference for emphasis and ordering. Krypton's panel uses the console faceplate instead of copying the light popover surface.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/components/session-info/` | New `SessionInfo` component, CSS, snapshot formatter, and focused tests. |
| `src/acp/components/lane-shell/`, `lane-head/`, `lane-rail/` | Remove the second lane row; make the lane name open Session Info; keep the single head's plate seam. |
| `src/acp/components/registry.ts` | Register the component. |
| `src/acp/harness-dock.ts`, `src/acp/harness-layout.ts` | Add the `session` tab and its placement. |
| `src/acp/harness-panel-visibility.ts`, `src/acp/harness-icons.ts` | Add tab/panel identity, persisted selection, `#panels` target, titlebar toggle and icon. |
| `src/acp/acp-harness-view.ts` | Mount, update, focus, and dispose the pane; refresh it on usage, lane selection, and right-rail commits. |
| `src/styles/harness-shared.css` | Allow five tabs to scroll horizontally at their legible size. |
| `src/acp/hash-commands.ts`, `src/acp/components/help-overlay/` | Include `session` in the panel command/help vocabulary. |
| `docs/README.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, relevant dock/panel specs | Index this feature and update the dock contract. |

## Design

### Data model

```ts
type HarnessDockTab = 'session' | 'ticket' | 'rails' | 'assistants' | 'git';
type HarnessPanelId = 'plan' | 'peek' | 'thought' | 'grammar' | 'queue'
  | 'session' | 'ticket' | 'rails' | 'assistants' | 'git';

interface SessionInfoProps {
  laneName: string;
  sessionId: string | null;
  backendName: string;
  modelName: string | null;
  effortName: string | null;
  status: HarnessLaneStatus;
  contextUsed: number | null;
  contextSize: number | null;
  // The former second-row values are a primitive snapshot as well:
  // project, cache, input/output, cost, tool/row counts, pending items,
  // turn flags, and error.
}
```

The view builds a primitive snapshot from the active lane. `SessionInfo.readDeps()` compares those primitives, not the mutable lane or usage object. No new Rust command, ACP request, timer, or persistent session data is needed.

### Placement and selection

- `SESSION` is the first visible tab. It is available while a lane is selected, including while its session is starting. Its individual panel flag defaults to shown. This makes the right column available for a normal harness with a lane, even when Ticket, Rails, Assistants, and Git are unavailable.
- Keep `ticket` as the default stored selection for existing users: an available Ticket remains selected. If it is unavailable, the dock falls back through available tabs, ending at Session. An explicit Session selection is stored per project.
- The right-side titlebar button and `#panels right` still control the whole column. `#panels session` and its titlebar button control only this tab. Add a palette `Open Session Info` action that shows the right side, shows and selects Session, and focuses its pane.
- Five tab labels use one horizontally scrollable recessed channel with each key at a readable minimum width. `[`/`]` continue to cycle available tabs and bring the selected key into view. Keep the existing 352px column and the narrow-view overlay behavior.
- Exactly one dock pane is rendered at a time. `HarnessDock` owns `hidden`; Session Info honors it with `.acp-session-info[hidden] { display: none }` in `krypton.component`. The shell's `krypton.base` hidden rule alone cannot override the component's `display: flex`.

### UI

- Header: `SESSION`, active lane name, and a small session-status lamp with a readable status word.
- Context section: `Context`, whole-number occupancy percentage, `used / size` token readout, and a steady filled meter. The meter is a recessed well with a semantic fill; no animation or text glow. When only `used` is known, show its count without a percentage or meter; when nothing is known, show `Context unavailable`.
- Details section: full session ID (selectable), backend, model, and reasoning effort when supplied. Show `Pending` for an unassigned session ID; `Unknown` for missing model/effort. Read-only content does not take keyboard focus except the pane itself.
- Spec 402 adds an MCP connection section between Details and Usage. It names only `krypton-harness-memory` and shows endpoint availability, observed request counts, and last contact. The counts are historical for the lane label, so the pane does not claim a live connection or list project/native servers.
- The former second-row values move here: project; latest-turn cache hit/read/write/input; aggregate input/output and cost; tool and transcript counts; pending permissions/questions; turn flags; and error. These keep their existing source and meaning. The lane header has one row, with no stats row below it.
- The context percentage is `clamp(used / size × 100, 0, 100)` only for finite `used >= 0`, finite `size > 0`. Keep the numeric token readout unrounded in an accessible label; compact formatting may be used visually. A value above `size` stays visible numerically while the meter caps at 100%.
- Omit the screenshot's category rows, autocompact buffer, and account Connectors section until an adapter provides those facts through canonical lane events. Do not relabel per-turn input/output/cache counts as context categories.
- Use `--mat-*` tokens, an engraved section label, a recessed meter/readout and a steady status lamp. No L-shaped brackets, left-edge state rail, infinite animation, or CSS outside the component's owned block.
- The header and section headings pair their text with decorative 14px SVG icons from the shared harness symbols: `panel-session`, `gauge`, `list`, `remote`, `embedded`, and `exec-activity`. Icons inherit the label ink, use `aria-hidden="true"`, and never replace text or the status LED.

### Data flow and keyboard

1. A lane becomes active: the view snapshots its session fields and calls `SessionInfo.update` if the tab is shown.
2. A canonical `usage` event updates `lane.usage`; the existing targeted chrome path also updates Session Info for the active lane. A background lane's update does not change the visible pane.
3. A session reset clears the existing lane usage and ID; the next pane update shows pending/unknown values. Switching lanes replaces the pane snapshot without retaining the previous lane's context.
4. `#panels session`/titlebar toggle control its hidden flag; `[`/`]` select adjacent dock tabs; `Escape` returns focus to the composer, consistent with other docks. Clicking the shown lane name or pressing `⌥⌘.` opens Session Info.
5. Spec 402's `acp-harness-mcp-touched` event refreshes the built-in MCP section from lane-scoped host telemetry without repainting a transcript row.

## Edge Cases

- Missing, zero, negative, non-finite, or partial usage never produces `NaN` or a false percentage. A reported zero is distinct from missing data.
- A context decrease after compaction redraws the meter from the new aggregate; the panel does not sum historical turns.
- A hidden right side receives no pane paint; showing it renders the latest active-lane snapshot.
- No active lane makes Session unavailable. If all tabs are unavailable, the existing dock removes its width. Narrow panes keep the right overlay and internal scrolling.
- Remote Harness uses the same canonical lane snapshot, with no local filesystem or account lookups.

## Verification

- Unit tests cover formatting, missing/invalid usage, former second-row values, lane switching, compaction decrease, one-row lane header, persistence, tab cycling and focus rescue.
- `npm run check`, focused Vitest files, and a browser visual check of wide and narrow dock widths, including dark and light schemes. Confirm computed visibility and meter width; a build alone is not visual verification.

Implementation verification after the one-row follow-up: `npm run check` and `npm run build` passed; focused tests passed (391); full `npm test` passed (3,900). Browser visual verification remains pending because the available terminal browser could not display graphics and the in-app browser host was unavailable in this session.

Dock visibility regression verification: a browser fixture mounting production `HarnessDock` and `SessionInfo` with the shell styles reproduced Session as `hidden=true` but computed `display:flex` while Rails was selected. After the component-layer hidden rule, the same assertion passed on Rails → Session → Rails and at 280px viewport width. Focused dock and Session tests passed (21). This verifies pane visibility, not a full running-app or Rails-content scenario.

## Open Questions

None. The screenshot's unsupported data is deliberately omitted; a later adapter-backed extension needs a separate contract.

## Out of Scope

- Reading Codex's private context breakdown or connector accounts from local files or app internals.
- New connector management, Reconnect actions, or estimates of system/tool/message token categories.
- Changing ACP wire decoding or the usage log.

## Resources

- [VS Code: Your first agent session](https://code.visualstudio.com/learn/foundations/approvals-autonomy-and-context-budget) — context overview and category-breakdown interaction.
- [VS Code: Optimize AI credit usage](https://code.visualstudio.com/docs/agents/guides/optimize-usage) — session-info popover and distinction between context and per-turn usage.
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) — thread token indicator and compaction behavior.
- `docs/0301-harness-ui-components.md`, `docs/0337-rails-verifier.md`, `docs/0347-harness-left-right-panel-toggles.md`, `docs/0380-acp-lane-adapters.md`, `DESIGN.md` — local component, dock, data and visual contracts.
