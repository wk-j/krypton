# ACP Harness Subagent Cards — Implementation Spec

> Status: Implemented
> Date: 2026-10-09
> Milestone: ACP Harness

## Implementation Deviations

- **Where the payload is attached.** `subagents` is set in `AcpHarnessView.renderTool`, right after `mergeToolPayloadForUpdate`, by calling `parseSubagentPayload(merged, status, previous, codexAgentNames)`. That call also carries the previous card forward. `mergeToolPayloadForUpdate` is unchanged. The view sets the kind chip to `agents` and the subject to the intent title.
- **Terminal settlement.** When a foreground (non-background) spawn ends, any agent still marked `pending` or `running` takes the parent's terminal status (`completed` / `failed` / `cancelled`), not `cancelled` every time.
- **OMP status-only or results-only updates** build on the previous card instead of re-reading `rawInput.tasks`. Compaction can drop `rawInput`, and re-reading would reset every agent to pending.
- **OMP background spawns** count as in flight, for both the signature and the in-place patch, until `details.async.state` leaves `running`.
- **Adapter payloads are checked with loose TypeBox schemas** (`@sinclair/typebox/value`) at the boundary in `harness-subagents.ts`.
- **No `theme-scheme.css` override is needed.** The card colours derive from `--krypton-fg-rgb`.

## Problem

When a lane spawns subagents (OMP `task`, Claude `Task`/`Agent`, Codex `spawnAgent`), the harness draws an ordinary tool row. It shows the intent title and one line of content such as `Running agent ReviewSortCode...`, so the user cannot see:

- how many agents are running
- what each agent is doing right now
- which agents have finished
- what each agent produced

Claude makes this worse. A subagent's own tool calls and text stream into the parent session, so they appear flat in the lane as if the main agent were doing them.

## Solution

Detect subagent tool calls from data the adapters already send, then render them as a **subagent card**: one row per agent showing a status glyph, name, agent type, current activity, tool count, tokens, and duration, all updated live. Each agent row is a target in `f` hint mode, and selecting it opens that agent's assignment and output inline.

For Claude, child tool calls and child text tagged with `_meta.claudeCode.parentToolUseId` are absorbed into their parent card instead of becoming separate transcript rows.

This stage needs no Rust change and no new ACP capability.

## Research

**What the adapters send.**

- **OMP** (`~/.bun/bin/omp`, ACP mapping `npi` / `xLe`):
  - `tool_call` has `title` = intent, `kind: "other"`, and `rawInput` = the args of the `task` tool. That is `{ tasks: [{ name?, task, … }], context?, … }`.
  - Every `tool_call_update` carries `rawOutput: partialResult`. During a run, `partialResult.details.progress[]` holds one entry per agent, `{ index, id, agent, status, task, assignment, description, lastIntent, recentTools[], toolCount, requests, tokens, cost, durationMs }`, and `content[0].text` is `Running agent <id>...`.
  - At the end, `details.results[]` has the per-agent results.
  - A background spawn adds `details.async = { state, jobId, type: "task" }`.
- **Claude** (`claude-agent-acp`):
  - The tool is `Task` or `Agent`, identified by `_meta.claudeCode.toolName` (`tool-calls/renderer.js:477`). Its `rawInput` is `{ description, prompt, subagent_type }`.
  - Krypton does not advertise the `subagents` / `subagent-transcript` capabilities. The adapter therefore streams the child's text and tool calls into the parent session and stamps each one with `_meta.claudeCode.parentToolUseId` (`acp-agent.js:501`, `stampParentToolUseId`). This `parentToolUseId` is the toolCallId of the `Task` call.
- **Codex** (`codex-acp`):
  - `collabAgentToolCall` has `title = item.tool` (`spawnAgent` / `sendInput` / `wait` / …), `rawInput = { prompt, receiverThreadIds, agentsStates, model, … }`, and `_meta.codex.collaboration` (`index.js:28424-28466`).
  - `subAgentActivity` has `_meta.codex.subagent = { threadId, path, activity }` and the title `Start subagent <name>` (`index.js:28467-28512`).

**How Krypton handles this today.**

- `client.ts` passes `tool_call`/`tool_call_update` through as raw objects, so `_meta` survives at runtime but is not typed.
- Message chunks go through `assistantMessageEvent`, which drops `_meta`.
- `buildToolPayload` reads only `rawOutput` sections and `content` text.
- `compactToolCallForRetention` keeps an explicit list of fields. `_meta` is not on it, so detection must happen while the payload is built, before retention compacts it.
- In-flight tool rows keep a structural signature and are patched in place by `patchStreamingToolBody` (spec 114 rev 8), so live progress has to be patched as well, not rebuilt on every update.

**Alternatives rejected.**

- *Advertising `clientCapabilities.subagents` and rendering child sessions now.* It needs a Rust whitelist change, routing per child session, and an extension that is still being standardized (the adapter cites ACP PR #1992). That is deferred to a later spec.
- *Matching on the title text* ("Running agent"). It is fragile and breaks on any change to the wording or the language.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed agent panel | `ToolCall::is_subagent()` (`acp_thread.rs:1111`) is true when `tool_name == "spawn_agent"` or `_meta.subagent_session_info` is present. `render_subagent_tool_call` (`thread_view.rs:10523`) draws a dedicated card and can open the child thread. Subagent output inside the child view gets a dashed border (`thread_view.rs:6221`). | Detection is based on metadata. Zed shows the full child transcript because it negotiates sessions. |
| Claude Code CLI | `Task(description)` with nested `⎿` tool lines and a `Done (N tool uses · X tokens · Ys)` summary. | [INFERENCE] from general use of the CLI. I did not check its source. |
| OMP TUI | Its `progress` fields (`recentTools`, `toolCount`, `tokens`, `lastIntent`) are built for a live view of each agent. | [INFERENCE] from the shape of the payload. |

**Krypton delta**
- **Matches convention:** a dedicated card, detected from metadata, with one live line per agent and a summary of count, tokens, and time.
- **Differs on purpose:** it is keyboard-first. Each agent is an `f` target that expands inline. No child transcript view in this stage.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-subagents.ts` (new) | `parseSubagentPayload(call, previous)` for OMP, Claude, and Codex; status mapping; bounds. |
| `src/acp/harness-view-types.ts` | `SubagentPayload`, `SubagentEntry`; `ToolPayload.subagents?`; `HarnessTranscriptItem.subagentExpanded?`; `HarnessLane.subagentChildren`, `codexAgentNames`. |
| `src/acp/types.ts` | `ToolCall`/`ToolCallUpdate` gain `_meta?: unknown`. The `message_chunk`/`thought_chunk` events gain `parentToolUseId?: string`. |
| `src/acp/client.ts` | Read `update._meta.claudeCode.parentToolUseId` into chunk events. |
| `src/acp/harness-tool-render.ts` | `buildToolPayload` attaches `subagents`; `renderToolBody` draws the card; `patchStreamingToolBody` patches the agent block. |
| `src/acp/harness-tool-retention.ts` | `mergeToolPayloadForUpdate` keeps the previous `subagents` when an update lacks output and carries hint labels over by entry id. |
| `src/acp/harness-transcript-render.ts` | The signature includes the structural subagent fields. |
| `src/acp/acp-harness-view.ts` | Claude child routing, open-hint targets and dispatch, the click toggle, and lane map resets. |
| `src/styles/acp-harness.css` | `.acp-harness__subagents*` (plus a light-theme override in `theme-scheme.css`). |
| `docs/72-acp-harness-view.md`, `docs/206-assistant-response-resources.md`, `docs/README.md` | Card, hint target, and index row. |

## Design

### Data Structures

```ts
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface SubagentEntry {
  id: string;                 // stable key + display name (OMP id, Claude description, Codex name/thread tail)
  agent: string;              // type/role: OMP `agent`, Claude `subagent_type`, Codex '' 
  status: SubagentStatus;
  activity: string;           // lastIntent | description | latest child tool title  (≤ 160 chars)
  recentTools: string[];      // ≤ 3, newest last
  toolCount: number | null;
  tokens: number | null;
  durationMs: number | null;
  task: string;               // assignment / prompt (≤ 2 KB)
  output: string;             // result text or child text tail (≤ 4 KB)
  hintLabel: string | null;
}
export interface SubagentPayload {
  source: 'omp' | 'claude' | 'codex';
  background: boolean;        // OMP details.async.state === 'running'
  agents: SubagentEntry[];    // ≤ 16
  overflow: number;
}
// ToolPayload.subagents?: SubagentPayload
// HarnessTranscriptItem.subagentExpanded?: string[]      (entry ids, survives payload rebuilds)
// HarnessLane.subagentChildren: Map<childToolCallId, parentToolCallId>   (Claude)
// HarnessLane.codexAgentNames: Map<threadId, name>                       (Codex)
```

### Detection (`parseSubagentPayload`)

Detection is shape-based; titles are never used.

- **OMP:** `rawOutput.details.progress[]` entries carry a string `id`, a string `status`, and an array `recentTools`. Before any progress arrives, `rawInput.tasks[]` entries with a string `task` produce `pending` entries named `name ?? "task N"`. At the end, `details.results[]` is merged by `id` (`exitCode !== 0` or `error` → `failed`; output text → `output`).
  - Status mapping: `pending → pending`, `running → running`, `completed → completed`, `failed|error|aborted → failed`, `cancelled → cancelled`, anything else → `running`.
- **Claude:** `_meta.claudeCode.toolName ∈ {Task, Agent}` gives one entry: `id = description || "agent"`, `agent = subagent_type`, `task = prompt`, `status` from the tool status, and `output` = the final text content.
- **Codex:** `_meta.codex.collaboration.tool === 'spawnAgent'` gives one entry per `receiverThreadIds[i]`. Its name comes from `lane.codexAgentNames.get(threadId)`, otherwise `agent-<last 6 chars of threadId>`. Its status comes from `agentsStates[threadId].status` (`pendingInit|running → running`, `completed → completed`, `errored → failed`, `shutdown|interrupted → cancelled`). The `prompt` becomes `task`.
  - Every `_meta.codex.subagent` activity row records `threadId → last segment of path` in `codexAgentNames`. Those rows themselves render unchanged.
- **Bounds:** at most 16 agents per card (`overflow` counts the rest). Text is trimmed to the limits listed in the types. `_meta` is read only here, before compaction.

### Claude child routing (`acp-harness-view.ts`)

1. On a `tool_call` with `_meta.claudeCode.parentToolUseId = P` where `lane.toolTranscriptIds.get(P)` is a row whose `tool.subagents.source === 'claude'`:
   - record `subagentChildren.set(child.toolCallId, P)`;
   - push `cleanToolTitle(child)` onto the entry's `recentTools` (keep 3), set it as the entry's `activity`, and increase `toolCount`;
   - create **no** transcript row.
2. A `tool_call_update` whose id is in `subagentChildren` only marks the parent row dirty. No row is created or changed.
3. A `message_chunk` with `parentToolUseId = P` (a card exists) appends to the entry's `output` (keeping the last 4 KB) instead of the main assistant row. A `thought_chunk` with `parentToolUseId` sets `activity = 'thinking'` and its text is dropped.
4. If no card is found for `P` (evicted, or the adapter did not stamp the call), the update falls back to today's flat rendering.
5. Permission requests for child tools are unchanged, because they come through `session/request_permission`.
6. `subagentChildren` and `codexAgentNames` are cleared wherever `clearToolTranscriptRetention` runs. A `subagentChildren` entry is deleted when its parent row is evicted.

### Rendering

```html
<div class="acp-harness__msg-body acp-harness__tool">
  <div class="acp-harness__tool-head">… spinner · [agents] · Spawning two parallel reviewers · 1/2 done · 1m 42s</div>
  <div class="acp-harness__subagents" data-background="0">
    <div class="acp-harness__subagent acp-harness__subagent--running" data-subagent-id="ReviewSortCode">
      <span class="acp-harness__subagent-hint">a</span>          <!-- f mode only -->
      <span class="acp-harness__subagent-glyph">●</span>
      <span class="acp-harness__subagent-name">ReviewSortCode</span>
      <span class="acp-harness__subagent-agent">reviewer</span>
      <span class="acp-harness__subagent-activity">reading SortService.java</span>
      <span class="acp-harness__subagent-stats">14 tools · 38k tok · 1m 12s</span>
      <div class="acp-harness__subagent-tools">↳ grep · read · read</div>
      <div class="acp-harness__subagent-detail">TASK … / OUTPUT …</div>  <!-- expanded only -->
    </div>
  </div>
</div>
```

- **The tool head** keeps its spinner, timer, and subject. Its kind chip reads `agents`, and its `result` slot shows `N/M done`, plus `· background` while `background` is true.
- **Sections are hidden** for subagent cards, because the content text repeats the card. Diffs still render.
- **Glyphs:** `pending ○`, `running ●` (pulsing, with the existing spinner animation; reduced motion → static), `completed ✓`, `failed ✗`, `cancelled –`.
- **Style:** a full 1px border, no corner brackets, no `backdrop-filter`. Positioning uses the transform rule, and only rows are reflowed.
- **Text:** every value is set through `textContent`.
- **Signature:** the structural part is `source`, the agent ids and statuses, `overflow`, `background`, `subagentExpanded`, and the hint labels. While the card is in flight, the activity, tools, and stats stay out of the signature. `patchStreamingToolBody` replaces `.acp-harness__subagents` in place, deduped on a string of those mutable fields, the same way sections are patched today.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `f` | Transcript focus | Open-hint mode. Every subagent entry becomes a target, in transcript order, alongside artifacts, references, and images. |
| `<label>` | Open-hint, subagent target | Toggle that agent's inline detail (TASK + OUTPUT + recent tools), then exit hint mode. |

Clicking an agent row toggles its detail too.

### Configuration

None.

## Edge Cases

- **Updates after a background spawn** (OMP `async.state: running`): they keep rebuilding the card even though the tool status is `completed`. The card shows `background` until `async.state` becomes `completed` or `failed`.
- **An update without `rawOutput`** (status only): `mergeToolPayloadForUpdate` keeps the previous `subagents`.
- **Hint labels during updates:** labels and expanded state carry over by entry `id`. An entry that disappears drops its label.
- **Two agents with the same `id`:** the second becomes `id#2`.
- **More than 16 agents:** the card adds a `+N more` row.
- **Claude child text arrives before the `Task` tool_call is known:** it falls back to flat rendering. Nothing is buffered.
- **A cancelled turn:** entries still `pending` or `running` render as `cancelled` once the parent tool status is terminal.
- **Remote runtimes, Live Assist, control SSE:** unchanged. The card is built from the same events.
- **Artifact redaction** (spec 133) wins over the card: a redacted row never builds `subagents`.

## Open Questions

None.

## Out of Scope

- Child session transcripts (ACP `subagents` capability, `subagent_spawned` / `subagent_state_update`, Claude `subagent-transcript`). That is a later spec.
- Folding the OMP `wait`/job tool row ("WAITING FOR REVIEWERS") into the card. It is a separate tool call and I have not verified its payload shape.
- Steering or cancelling a single subagent from the card.
- Codex `sendInput` / `wait` / `closeAgent` collab calls. They stay plain tool rows.

## Resources

- `~/.bun/bin/omp` (strings): ACP mapping `npi`/`xLe` (tool_call `rawInput: args`, update `rawOutput: partialResult`) and the task progress shape (`index, id, agent, status, task, assignment, lastIntent, recentTools, toolCount, tokens, durationMs`, `details.async`).
- `@agentclientprotocol/claude-agent-acp` `dist/acp-agent.js:501-516, 2455-2465`, `dist/tool-calls/renderer.js:470-485`, `dist/native-subagents.js`: `parentToolUseId` stamping, `Task`/`Agent` `toolName` meta, and the capability-gated native child sessions.
- `@agentclientprotocol/codex-acp` `dist/index.js:28424-28512, 37146-37152`: the `_meta.codex.collaboration` / `_meta.codex.subagent` shapes and the `subagents` capability.
- Zed `crates/acp_thread/src/acp_thread.rs:124-291, 1111`, `crates/agent_ui/src/conversation_view/thread_view.rs:8116-8120, 10523-10551`: subagent detection and the card.
