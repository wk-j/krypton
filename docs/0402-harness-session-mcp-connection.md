# Harness Session MCP Connection — Implementation Spec

> Status: Implemented (approved 2026-11-15: built-in `krypton-harness-memory` for the current lane only)
> Date: 2026-11-15
> Milestone: ACP Harness — Session Info
> Builds on: 0073 (Harness MCP memory), 0301 (component kernel), 0401 (Session Info)

## Problem

Session Info shows the active lane's identity and usage but not its MCP contact. The lane-head chip and `#mcp` already expose partial evidence, so the Session pane should make that evidence readable without implying a live connection that the host cannot measure.

## Solution

Add an **MCP connection** section to the existing Session pane for the lane-scoped `krypton-harness-memory` server. Show whether Krypton can supply its endpoint, whether the agent has contacted it, request counts, and the last observed method/time. Keep this read-only and update it from the existing MCP telemetry event. This scope is the built-in Harness server; project and agent-native MCP servers have no shared runtime status feed.

## Research

- `HookServer::record_mcp_request` tracks `initialize`, `tools/list`, `tools/call`, `last_method`, and `last_seen_at` per harness and lane label. `list_harness_mcp_stats` exposes these through Tauri. The counters record historical requests; there is no heartbeat, disconnect event, or per-agent server inventory.
- `acp-harness-mcp-touched` already calls `refreshMcpStats()`. That refresh updates lane chrome through `refreshMetricsRender()`, but does not currently update Session Info. The Session pane is updated elsewhere on lane changes and usage events.
- `memoryServerForLane(lane)` supplies the built-in server only when the lane can receive it and a local or remote-forwarded port exists. Pi gets no MCP descriptor. Project servers and native adapter configs use different delivery paths, so `.mcp.json` entries cannot be presented as connected merely because they are configured.
- `mcpStatsByLane` is keyed by lane display name and the Rust counters can survive a `#new` or restart of the same lane. A positive `tools/list` count means **observed on this lane**, not connected to the current session right now.
- Session Info uses primitive `readDeps()` values, owns its DOM, and receives `hidden` from `HarnessDock`. `DESIGN.md` calls for engraved labels and recessed fact rows; the existing pane has those styles.

## Prior Art

| App | Observed UX | Krypton choice |
|-----|-------------|----------------|
| VS Code | MCP server controls are scoped to the selected harness/session; its docs warn that a running server alone does not prove the session has tools. | Show observed request evidence, not a speculative live or tool-availability claim. |
| Zed | Settings → AI → MCP Servers uses a status dot and tooltip for each Zed-managed server; external agents can also load native configs. | Show only Krypton's own endpoint, whose requests Krypton observes directly. |

## Affected Files

| File | Change |
|------|--------|
| `src/acp/components/session-info/index.ts`, `session-info.css` | Add primitive MCP props, a section below Details, and conditional fact rows with a historical-activity note. |
| `src/acp/components/session-info/session-info.test.ts` | Cover no contact, observed requests, lane switch, and stale-looking counter semantics. |
| `src/acp/acp-harness-view.ts` | Snapshot the active lane's MCP stats and endpoint availability; refresh the shown Session pane after MCP telemetry changes. |
| `src/acp/acp-harness-view.test.ts` | Verify the MCP refresh reaches Session Info without a transcript repaint. |
| `docs/0401-harness-session-info-panel.md` | Record this later MCP section and preserve the distinction from account Connectors. |

## Design

### Data and state

Extend `sessionInfoProps(lane, projectDir, backendName, mcpStats, mcpEndpointAvailable)` with primitive snapshot fields: `mcpEndpointAvailable`, `mcpInitializeCount`, `mcpToolsListCount`, `mcpToolsCallCount`, `mcpLastMethod`, and `mcpLastSeenAt`. A missing stats entry yields zero counts and no last request. The view computes endpoint availability from the existing `memoryServerForLane(lane)`; the component never reads the mutable stats object during paint.

The status wording is evidence-specific:

| Condition | Readout |
|-----------|---------|
| No built-in descriptor for this lane | `Not supplied` |
| Descriptor available, no request observed | `No contact observed` |
| `initialize > 0`, `tools/list = 0` | `Initialized; tools not listed` |
| Another request observed, `tools/list = 0` | `Contact observed; tools not listed` |
| `tools/list > 0` | `Tools listed on this lane` |

Show the server name `krypton-harness-memory`, initialize/list/call counts, and the last method and absolute local timestamp when present. Counts remain historical for the lane label, including after `#new` or restart. The UI must not say `Connected`, `Online`, or imply that project/native MCP servers are covered. The existing `#mcp` command remains the detailed endpoint view.

### Data flow and keyboard

1. On lane selection or Session tab display, `renderSessionDock()` copies that lane's current stats and endpoint availability into `SessionInfo`.
2. On `acp-harness-mcp-touched`, `refreshMcpStats()` replaces the stats map, then updates the shown Session pane through the existing targeted render path. A background lane's event leaves the active pane's values unchanged.
3. If the right panel or Session tab is hidden, no pane paint occurs; opening it reads the latest snapshot.

The existing `⌥⌘.` shortcut and clickable active-lane name open Session Info. No new action or keybinding is added.

### UI

Place the section between Details and Usage. Reuse the pane's engraved heading and recessed fact-list layout, with no animation or new material tokens. Keep the server name selectable and rows readable in the 352px dock and its narrow overlay.

## Edge Cases

- A missing stats entry shows `No contact observed`; a notification-only request has a last-contact timestamp and shows `Contact observed; tools not listed`.
- After `#new`, historical counts may remain; the label says `on this lane` and the absolute last-contact time prevents a false current-session claim.
- If the endpoint becomes unavailable after prior contact, the status is `Not supplied`; prior counts remain historical evidence.
- Remote Harness uses the existing forwarded endpoint check and the same lane telemetry. No local config file is read for this section.

## Verification

- Focused tests for the component and view MCP refresh path; `npm run check` and `npm run build`.
- Visual check in dark and light schemes at wide and narrow dock widths, including computed visibility after switching lanes/tabs.

Implementation verification: `npm run check` passed; the two focused test files passed (361 tests); component stylesheet ownership passed (7 tests); `npm run build` passed. Visual verification is pending because no Tauri/Vite dev instance was running for this checkout; the build result alone does not establish the rendered layout.

## Open Questions

None for this scope. Showing all project and agent-native MCP server connections requires a separate adapter-backed runtime inventory.

## Out of Scope

- Live connection liveness, heartbeat, reconnect controls, or per-server project/native status.
- Changing MCP transport, counters, `#mcp`, or agent configuration.
- Account Connectors from the Session Info reference image.

## Resources

- [VS Code: Manage and troubleshoot MCP servers](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers) — session/harness scope and the distinction between a running server and available tools.
- [Zed: Model Context Protocol](https://zed.dev/docs/ai/mcp) — managed-server status indicator and external-agent boundary.
- `docs/0073-acp-harness-mcp-memory.md`, `docs/0401-harness-session-info-panel.md`, `DESIGN.md` — Krypton's endpoint, pane, and visual contracts.
