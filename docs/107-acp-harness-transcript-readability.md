# ACP Harness Transcript Readability — Implementation Spec

> Status: Implemented
> Date: 2026-05-19
> Milestone: ACP harness — UI readability polish

## Problem

ACP harness lanes now carry mixed traffic: user prompts, assistant output, tools, permission requests, harness memory, peer messages, shell commands, filesystem activity, and blocked peer states. The transcript already renders these as rows, but several high-trust events still collapse into string labels. Permission and harness auto-allow events are especially hard to audit because the user sees a short line instead of the tool, server, matched rule, arguments, and decision state.

## Solution

Introduce a structured transcript event payload layer for harness-level events, then use it to render dense permission cards and clearer memory/peer rows. This first slice keeps the existing transcript array, visible-window renderer, and transport intact. It replaces string-only permission rows with typed payloads, separates `memory.*` from `peer.*` vocabulary, and makes `awaiting_peer` explain who the lane is waiting for and how to cancel.

## Research

- `src/acp/acp-harness-view.ts` already has `HarnessTranscriptItem.kind`, plus optional payload fields for tools, permissions, filesystem activity, and inter-lane rows. The weak point is that permission resolution and harness auto-allow are still appended as plain text.
- `appendTranscript(lane, kind, text)` is the common append path and caps the transcript at 300 rows. The design should extend it, not replace the storage model in this slice.
- `renderActiveTranscript()` already works over a sliced visible window from Spec 103, using `data-msg-id` and render signatures. New structured payloads must participate in `transcriptRenderSignature()` so cards update without rerendering the whole lane.
- `renderPermissionBody()` currently renders only `kind`, `subject`, and optional suffix. It does not show tool server, raw input summary, available options, resolved state, or why a request was auto-allowed.
- Peering from Spec 106 added `inter_lane` rows, `awaiting_peer`, inbox badges, and composer blocking. The status text says `awaiting peer reply`, but it does not identify the peer or elapsed wait time.
- The implementation also broadens harness auto-approval detection for `peer_send` / `peer_list` and changes the transcript vocabulary from memory-only auto-allow to harness auto-allow. That exposes a vocabulary problem: memory and peer tools need separate taxonomy even though both are allowed by the harness policy.
- Existing style constraints apply: no `backdrop-filter: blur()`, no uppercase paths/tool arguments, keyboard-reachable disclosure controls, dense amber phosphor language for ACP agent surfaces, and no decorative layered UI.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Claude Code | Permission system supports allow/deny modes and permission hooks; tools outside rules prompt or are handled by mode. | Strong precedent for showing why a tool was allowed or denied. |
| Zed Agent Panel | Permission requests appear as tool cards with allow/deny once and "always for" choices; tool permissions can be rule-based per tool/input pattern. | Closest UI precedent: permission is a card, not a chat line. |
| VS Code Agent Mode | Tools that require approval show confirmation before running; external agents can surface runtime permission prompts. | Confirms runtime approval is expected in editor-integrated agents. |
| Current Krypton ACP Harness | Permission rows and auto-allow rows are transcript items, but payloads are minimal and auto-allow is string-only. | Good render foundation, insufficient auditability. |

**Krypton delta** — Krypton has multiple live lanes, shared memory, and peer messaging in one terminal-like surface. Permission UI must explain not only "what tool" but "which harness subsystem" and "why this lane is no longer blocked." It stays keyboard-first and compact; no modal dialogs and no hover-only details.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add structured transcript event payloads for permission decisions and harness tool taxonomy; render permission cards; track awaiting peer target/started time; rename confusing harness-memory constants. |
| `src/acp/acp-harness-view.test.ts` | Update harness auto-allow helper tests for renamed taxonomy helpers and add payload/card behavior assertions. |
| `src/acp/inter-lane.ts` | Add `sentAt` to pending sends and expose enough pending-peer metadata for lane header/activity text, without changing message transport. |
| `src/acp/types.ts` | Add shared types only if payloads need to cross module boundaries; otherwise keep view-local types. |
| `src/styles/acp-harness.css` | Add dense amber permission-card styles and memory/peer event markers; no blur, no large radius, no hover-only disclosure. |
| `docs/72-acp-harness-view.md` | Document transcript event types, permission card fields, and deferred detail expansion. |
| `docs/106-inter-lane-messaging.md` | Note the improved awaiting-peer display and pending-peer metadata. |
| `docs/PROGRESS.md` | Add/readability polish entry after implementation. |

## Design

### Transcript Event Payloads

Keep `HarnessTranscriptItem` as the storage object, but make harness-specific payloads first-class:

```ts
type HarnessToolFamily = 'memory' | 'peer';
type PermissionDecision = 'pending' | 'accepted' | 'rejected' | 'auto_allowed' | 'failed';

interface PermissionPayload {
  id: number;
  toolName: string;
  toolFamily: HarnessToolFamily | 'agent' | 'shell' | 'file' | 'other';
  serverName: string | null;
  kind: string;
  subject: string;
  suffix?: string;
  argsPreview: string;
  options: Array<{ optionId: string; name: string; action: 'accept' | 'reject' | 'other' }>;
  decision: PermissionDecision;
  decisionLabel?: string;
  autoReason?: string;
  expanded: boolean;
}

interface HarnessEventPayload {
  family: HarnessToolFamily;
  toolName: 'memory_set' | 'memory_get' | 'memory_list' | 'peer_send' | 'peer_list';
  direction?: 'in' | 'out';
  peerDisplayName?: string;
  summary: string;
}
```

The existing `inter_lane` payload can remain for visible peer messages. `HarnessEventPayload` is for compact tool/permission audit rows when the harness itself auto-allows memory/peer MCP calls.

`HarnessPermission` must keep a reference to its transcript row so resolution mutates the original card:

```ts
interface HarnessPermission {
  requestId: number;
  toolCall: ToolCall;
  options: PermissionOption[];
  transcriptItem?: HarnessTranscriptItem;
}
```

`addPermission()` creates the row once, assigns `permission.transcriptItem`, and pushes the permission. `resolvePermission()` and auto-allow resolution update `permission.transcriptItem.permission.decision` in place. They must not append a second string-only permission row.

### Vocabulary Rename

Rename the confusing alias before extending UI:

```ts
const HARNESS_MEMORY_TOOL_NAMES = new Set(['memory_set', 'memory_get', 'memory_list']);
const HARNESS_PEER_TOOL_NAMES = new Set(['peer_send', 'peer_list']);
const HARNESS_AUTO_ALLOW_TOOL_NAMES = new Set([
  ...HARNESS_MEMORY_TOOL_NAMES,
  ...HARNESS_PEER_TOOL_NAMES,
]);
```

Rename helper functions from `harnessMemoryPermissionToolName()` / `memoryToolNameFromString()` to harness-neutral names such as:

```ts
function harnessAutoAllowToolName(permission: Pick<HarnessPermission, 'toolCall'>): string | null;
function harnessToolNameFromString(value: string | undefined): string | null;
function harnessToolFamily(toolName: string): HarnessToolFamily | null;
```

Compatibility stays in detection markers: both `krypton-harness-memory` and `krypton-harness-bus` remain accepted server markers.

### Permission Card Rendering

For `item.kind === 'permission'`, render a compact card:

```html
<div class="acp-harness__perm-card" data-decision="auto_allowed">
  <div class="acp-harness__perm-row">
    <span class="acp-harness__perm-family">peer</span>
    <span class="acp-harness__perm-tool">peer_send</span>
    <span class="acp-harness__perm-subject">Claude-1</span>
    <span class="acp-harness__perm-decision">auto-allowed</span>
  </div>
  <div class="acp-harness__perm-reason">matched harness peer auto-allow rule</div>
  <div class="acp-harness__perm-preview">to_lane: Claude-1 · message: …</div>
  <div class="acp-harness__perm-actions">a accept · r reject</div>
</div>
```

Rules:

- Labels may be uppercase through CSS; paths, commands, args, and lane names preserve original case.
- `argsPreview` is one line, truncated to 140 characters. Full keyboard expansion is deferred to a later transcript row-focus slice.
- Pending permissions show options. Resolved/auto-allowed permissions show the decision and no action prompt.
- Auto-allowed cards must state the reason:
  - `matched harness memory auto-allow rule`
  - `matched harness peer auto-allow rule`
- Failed permission replies become `decision: 'failed'` and stay visually emphasized.

### Detail Disclosure

Slice 1 does not add transcript row focus or a new `x` key. Permission cards render a compact one-line preview plus the decision reason. Full keyboard-driven row expansion is deferred until the transcript has an explicit row-cursor model.

The card may include a non-interactive `details available in raw tool event` hint when the preview is truncated, but it must not rely on hover-only behavior.

### Awaiting Peer Clarity

Expose pending peer metadata from `InterLaneCoordinator`:

```ts
interface PendingPeerSummary {
  toLaneId: string;
  toDisplayName: string;
  envelopeId: string;
  sentAt: number;
}

pendingPeersFor(laneId: string): PendingPeerSummary[];
```

Use it in lane header/activity text:

- Current: `awaiting peer reply`
- New: `awaiting Claude-1 · <1m · #cancel`

If multiple peers are pending, show `awaiting 2 peers · <1m · #cancel` and list names in the title attribute.

Do not add a persistent timer just to update elapsed seconds. Use coarse buckets (`<1m`, `1m+`, `5m+`, `15m+`) and refresh on normal harness renders: status changes, transcript updates, lane switch, composer render, and metrics refresh. This avoids a permanent UI tick while still making stale waits visible.

Composer blocked state should mirror this message instead of only flashing `lane awaiting peer — #cancel first`.

### Memory vs Peer Event Treatment

Use taxonomy, not color alone:

- `memory.*` rows use label `mem`, prefix `M`, and summary text such as `memory_set · Codex-1 updated lane memory`.
- `peer.*` rows use label `peer`, prefix `P`, and summary text such as `peer_send · to Claude-1`.
- `memory_list`, `memory_get`, and `peer_list` are routine and collapsed by default.
- `memory_set` and `peer_send` are meaningful coordination events and should stay visible.

This is intentionally smaller than full tool-output progressive disclosure. It only covers harness bus/memory events.

## Data Flow

```
1. Agent asks ACP adapter for permission to call a tool.
2. AcpHarnessView.addPermission() builds PermissionPayload from ToolCall.
3. harnessAutoAllowToolName() classifies memory/peer tools.
4. If auto-allowed, resolveHarnessPermission() responds accept and records a permission card with decision = auto_allowed.
5. If user approval is needed, append a pending permission card and set lane status = needs_permission.
6. User presses a/r/A/R; resolvePermission() reads `permission.transcriptItem` and mutates the original card decision instead of appending a second string-only permission row.
7. Auto-allow uses the same mutation path: create or reuse one permission row, set `decision = auto_allowed`, set `autoReason`, and respond through ACP.
8. renderActiveTranscript() detects payload signature change and patches the card.
```

All `appendTranscript(lane, 'permission', text)` callsites must migrate through one helper, for example:

```ts
function appendPermissionTranscript(
  lane: HarnessLane,
  permission: HarnessPermission,
  payload: PermissionPayload,
): HarnessTranscriptItem;

function updatePermissionDecision(
  permission: HarnessPermission,
  decision: PermissionDecision,
  label: string,
  autoReason?: string,
): void;
```

That keeps pending, accepted, rejected, auto-allowed, and failed states on one row.

## Edge Cases

- **Unknown tool shape:** Render `toolFamily: 'other'`, preserve raw title, and show a safe truncated args preview.
- **Large raw input:** Preview is bounded; expanded detail is bounded to a fixed number of key/value rows. Full raw JSON is not dumped into the transcript.
- **Auto-allow reply fails:** Same card becomes `failed`; append a system row only for the error detail.
- **Multiple pending permissions:** Each permission gets its own card. Composer actions still apply to the first pending permission, matching current behavior.
- **Adapter emits only text content:** Fallback regex detection remains, but the card marks `serverName: null` and uses `autoReason` from the fallback source.
- **Reduced motion:** No new animations are required. Existing row entrance behavior remains.
- **Transparent WKWebView:** No `backdrop-filter`; cards use alpha backgrounds and borders only.

## Open Questions

None. `peer_send` stays auto-allowed in this slice, matching Spec 106 and the current user-directed peering workflow. The new permission card must make that auto-allow visible and auditable instead of changing permission semantics.

## Out of Scope

- Unread markers across lanes.
- Lane comparison dashboard.
- Completion summaries.
- Generic progressive disclosure for all tool output.
- Transcript row-focus cursor and `x` key expansion.
- New permission policy configuration.
- Changing MCP memory/peer transport semantics.
- Persisting permission decisions across sessions.

## Resources

- `docs/103-acp-harness-transcript-window.md` — visible transcript window and render-signature constraints.
- `docs/106-inter-lane-messaging.md` — peering, `awaiting_peer`, inbox, and cancellation model.
- `docs/96-acp-built-in-memory-auto-approval.md` — precedent for memory auto-approval.
- `src/acp/acp-harness-view.ts` — transcript, permission, render, and composer implementation.
- `src/acp/inter-lane.ts` — pending peer state and drain behavior.
- [Claude Code permissions](https://code.claude.com/docs/en/permissions) — permission modes and hooks shape approval behavior.
- [Zed tool permissions](https://zed.dev/docs/ai/tool-permissions) — permission requests appear as tool cards with one-time and always-allow/deny choices.
- [VS Code agent tools](https://code.visualstudio.com/docs/copilot/agents/agent-tools) — tools requiring approval show confirmation before execution.
