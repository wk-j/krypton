# ACP Lane Adapters — Implementation Spec

> Status: Approved (2026-11-10) — phases 1, 2a and 2b implemented (2026-11-10), phases 3 and 4a implemented (2026-11-11); phase 4b open
> Date: 2026-11-10
> Milestone: ACP Harness — one rendering for every lane
> Builds on: 69 (ACP backends), 72 (harness view), 175 (control API), 282 (subagent cards), 288 (wire profiler), 301/302 (components), 319/370 (execution, jobs), 378 (Guardian row)

## Problem

ACP servers report the same action in different shapes. A command's exit code arrives as `rawOutput.exit_code` (Codex), as an `exit: N` text prefix (Grok), or not at all (Claude, because Krypton does not declare the terminal-output convention). Claude's Bash `description` shows up in the output well. Subagent parents, thread state, usage location and MCP tool names also differ per vendor. Krypton reads these wire shapes in about twenty modules, so the same work renders differently per lane, and a new backend gets whatever the fallbacks produce. Krypton, not the server, must decide the final UI: everything any surface shows has to come from one model Krypton owns.

## Solution

Add one adapter stage at the point every lane already passes through: `AcpClient.handleRaw`, plus the `AcpClient` methods that return init, session and prompt results. `src/acp/adapters/` holds a generic adapter, which implements the ACP spec and the cross-vendor `_meta` conventions, and one small adapter per backend that overrides only what deviates. Adapters turn raw wire JSON into `LaneEvent`, `LaneInit` and `LaneSession`. No other module may read wire JSON or branch on backend id to decide what it shows, and a guard test enforces this. Krypton also declares `clientCapabilities._meta.terminal_output`, as Zed does, so Claude and Codex report command output and exit codes in one convention. Rust stays the transport (CLAUDE.md constraint 3). It still answers protocol requests, but only the TypeScript adapter interprets what Rust forwards.

## Research

- **Choke point.** Rust forwards ten `session/update` kinds verbatim (`acp.rs:2074-2132`). It also emits its own events (permission, Grok ask-user, elicitation, fs, `turn_marker`, `stop`) on `acp-event-<session>`, for local and remote lanes alike. `AcpClient.handleRaw` (`client.ts:295`) is the only subscriber. Live Assist reads harness transcript snapshots, so it inherits the harness model.
- **`AcpEvent` is half canonical** (`types.ts:926`). Chunks, plan, usage, commands and mode are already normalized. `tool_call`, `tool_call_update` and `permission_request` still carry the raw wire `ToolCall`, which downstream code re-interprets.
- **Wire interpretation outside the client** (all of it moves):
  - **Tool rows:**
    - `buildToolPayload`, `toolSubject`, `inferToolLabel`, `cleanToolTitle`, `rawOutputSections`, `grokRawOutputSections`, `decodeByteArray`, `peelExitPrefix`, Grok read anchors and `<workspace_result>` (`harness-tool-render.ts`).
    - `mergeToolCall` and `compactToolCallForRetention` (`harness-tool-retention.ts`).
    - The OMP background hold, OMP jobs and Codex Guardian branches in `renderTool` (`acp-harness-view.ts:15191-15290`, `harness-guardian-review.ts:81`).
    - Subagent shape sniffing in the order OMP→Claude→Codex (`harness-subagents.ts:224-366`).
    - OMP code cells (`harness-execution.ts:216`).
    - Claude background-launch text (`harness-background-tasks.ts:27`).
    - `extractModifiedPath` (`acp-harness-memory.ts:219`), the tool-image walk (`harness-images.ts:295`), and `collectToolImages`, `observeFileTouch`, `noteToolActivity` and `isMemoryTool`.
    - Lane peek and chrome command lines (`lane-peek.ts:842`, `harness-lane-chrome.ts:283`).
  - **Permissions:**
    - `describePermission`.
    - MCP identity in `harness-permission-scan.ts`: the Claude `mcp__s__t` form, the fx `mcp_<s>_<t>` form, and `Always allow ("…")`.
    - High-risk gating through `extractCommandLineRaw`.
    - `headless-fence.ts` reads `_meta.claudeCode`.
  - **Questions:** Grok questions are normalized twice (`acp.rs:1666`, `ask-user-question.ts:76`).
  - **Session:**
    - The model name is guessed by a recursive key search (`harness-lane-chrome.ts:44-74`).
    - Mode names come from the off-spec `agent_capabilities.availableModes` (`acp-harness-view.ts:8399`); the ACP `modes` field of `session/new` is never read.
    - Prompt usage sits at the top level (Claude) or under `_meta.usage` (Codex) (`client.ts:221`).
  - **Other consumers:**
    - `inline-ai-session.ts` and `inline-ai-remote.ts` read `rawInput.command`.
    - `commit-explainer.ts` calls `toolSubject` and `mergeToolCall`.
    - The control SSE `publishStream` forwards raw tool calls.
    - Telegram reads `title`, `kind` and `rawInput` from that stream (`telegram.rs:680`).
- **Exit codes are available.** claude-agent-acp and codex-acp both implement `_meta.terminal_info` / `terminal_output` / `terminal_exit {exit_code, signal}` for clients that declare `clientCapabilities._meta.terminal_output: true`. Without that declaration, Claude sends a console code block plus a display copy of the Bash `description` in `content`, and Codex sends `rawOutput.exit_code`. Krypton declares only `"terminal": false` (`acp.rs:2629`).
  - *Re-checked against the sources for phase 3 (2026-11-11):* a client that declares nothing gets its command output from published codex-acp 2.6.0 only as `_meta.terminal_output_delta` chunks, with no `content` text, and a command with a terminal reports its exit only in `terminal_exit`. `rawOutput.exit_code` is sent only for a command without a terminal (read, search, list). Before phase 3, Krypton read none of those keys, so a Codex shell row could have no output and no exit. This was read from the package source and was not seen on a live lane.
- **Rejected: adapters in Rust before `emit_event`.** Every interpreter and its tests are TypeScript, the outbound control path would still need a second schema, and CLAUDE.md keeps Rust a forwarder. Telegram instead reads the canonical payload the harness publishes.
- **Rejected: keep shape sniffing per function and tidy it.** That cannot guarantee sameness, because nothing stops the next surface from reading `rawOutput` again.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed | `acp_thread` converts every update into its own thread model (`AgentThreadEntry`; `ToolCallPatch` shims v1/v2 wire) before `agent_ui` renders it. Rendering has no per-agent branch. `client_capabilities_for_agent` declares `_meta.terminal_output` and `terminal-auth` for every agent. Display terminals come from `terminal_info/output/exit`, and shared `_meta` keys (`tool_name`, `subagent_session_info`) are read by name. | Per-agent code is limited to capabilities and auth (a Cursor model-picker flag, Gemini auth). |
| JetBrains AIR (per the claude-agent-acp and codex-acp `air-extensions.md`) | The client declares the conventions it renders, and the adapters shape their output to match (terminal channel, `commandTitle`, subagent flag). | What the client declares controls what the server sends. That is why declaring `terminal_output` is the lever for exit codes. |

**Krypton delta:** like Zed, Krypton uses one internal model and keeps backend branches out of the UI. Unlike Zed, Krypton runs vendors that follow no convention (Grok's typed `rawOutput`, OMP `details`). It therefore keeps an explicit adapter per backend instead of relying on conventions alone, and it adds a guard test so the boundary cannot erode.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/adapters/types.ts` (new) | `LaneEvent`, `ToolView`, `LaneInit`, `LaneSession`, `LaneAdapter`, `SupplyMatrix` |
| `src/acp/adapters/decoder.ts` (new) | `createLaneDecoder(backendId)`: dispatch, per-call tool state (moved from `harness-tool-retention.ts`), adapter chain |
| `src/acp/adapters/generic.ts` (new) | ACP fields, `_meta.terminal_*`, generic exit/section/command keys, byte-array decode, title cleanup, ACP `modes` |
| `src/acp/adapters/{claude,codex,grok,omp,fx}.ts` (new) | Vendor overrides moved from the modules listed in Research |
| `src/acp/adapters/registry.ts` (new) | backend id → adapter; unknown ids get `generic` |
| `src/acp/adapters/fixtures/<backend>/*.jsonl`, `adapters.contract.test.ts`, `wire-boundary.test.ts` (new) | Captured wire, the cross-backend contract, the boundary guard |
| `src/acp/harness-transcript-items.ts` (new) | Pure item builders `toolPayloadFromView`, `permissionItemFromEvent`, `questionItemFromEvent`, moved out of `AcpHarnessView` (`buildToolPayload`, `describePermission`, `addAskUser`) and shared with the spec 381 gallery |
| `src/acp/client.ts` | `handleRaw` and the init/session/prompt methods go through the decoder; `onEvent` emits `LaneEvent` |
| `src/acp/types.ts` | `AcpEvent` replaced by `LaneEvent`; wire types (`ToolCall`, `ToolCallUpdate`, `ToolCallContent`) imported only by adapters |
| `src/acp/harness-tool-render.ts`, `harness-tool-retention.ts`, `harness-subagents.ts`, `harness-execution.ts`, `harness-guardian-review.ts`, `harness-background-tasks.ts`, `harness-images.ts`, `harness-permission-scan.ts`, `ask-user-question.ts`, `acp-harness-memory.ts`, `lane-peek.ts`, `harness-lane-chrome.ts` | Wire readers move into adapters; what remains takes `ToolView` / `LaneSession` |
| `src/acp/acp-harness-view.ts` | `onLaneEvent`, `renderTool`, `addPermission`, `addAskUser`, `collectToolImages`, `observeFileTouch`, `noteToolActivity`, lane setup consume canonical input; backend branches leave these paths |
| `src/acp/headless-fence.ts`, `src/inline-ai-session.ts`, `src/inline-ai-remote.ts`, `src/commit-explainer.ts`, `src/acp/assist/acp-completion.ts` | Read `LaneEvent` fields |
| `src-tauri/src/acp.rs` | Declare `clientCapabilities._meta.terminal_output: true`; return the raw `modes` value from session/new, load and resume |
| `src-tauri/src/telegram.rs` | Read the canonical `view` payload of `tool_call` / `tool_call_update` stream events |
| `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0069-acp-agent-support.md`, `docs/0175-harness-web-control-api.md`, `docs/0282-harness-subagent-cards.md`, `docs/README.md`, `docs/adr/0031-ui-reads-only-canonical-lane-events.md` (new) | Describe the boundary, the payload change and the decision |

## Design

### Boundary rules

1. Only `src/acp/adapters/**` and `src/acp/client.ts` read wire JSON: `rawInput`, `rawOutput`, `_meta`, `content` items, `title`, `sessionUpdate`, and the wire `ToolCall*` types.
2. `LaneEvent`, `LaneInit` and `LaneSession` carry no backend id. Every surface (rows, chrome, peek, Live Assist, control SSE, Telegram, inline AI, commit explainer) decides what to show from canonical fields only.
3. **Same data, same slot.** A field that is `null` or empty paints nothing in its slot, the same way for every backend. Adapters never infer a value the server did not send; for example, a `completed` status never becomes `exit 0`.

### Data Structures

```ts
// src/acp/adapters/types.ts
export type ToolState = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export interface McpIdentity { readonly server: string; readonly tool: string }

/** Everything any surface may show about one tool call. A full snapshot every time. */
export interface ToolView {
  readonly id: string;
  readonly parentId: string | null;          // spec 282: the subagent call this one belongs to
  readonly status: ToolState;
  readonly kind: string;                     // inferred ACP kind, or 'agents' | 'wait'
  readonly declaredKind: string | null;      // the ACP kind as declared; policy reads only this
  readonly title: string;                    // cleaned title (activity line, labels)
  readonly toolName: string | null;          // the tool's own name when its input states one
  readonly subject: string;                  // command, else primary path, else title
  readonly command: string;                  // '' unless kind === 'execute' (today's ToolPayload.command)
  readonly commandLine: string | null;       // full, untruncated command in the input, any kind (spec 143)
  readonly modifiedPath: string | null;      // the file an edit/write targets
  readonly locations: readonly string[];
  readonly inputPaths: readonly string[];    // values under path-like input keys (spec 133)
  readonly sections: readonly ToolSection[]; // decoded, unwrapped, bounded output
  readonly exit: number | null;              // exit code; null: the server reported none
                                             // (a wire `signal` has no slot today and is dropped)
  readonly diffs: readonly ToolDiff[];
  readonly mcp: McpIdentity | null;          // exact adapter identity only (spec 143)
  readonly background: { readonly taskId: string; readonly outputPath: string | null } | null;
  readonly subagents?: SubagentPayload;
  readonly jobs?: JobsPayload;
  readonly execution?: ExecutionPayload;
  readonly guardianReview?: GuardianReviewPayload;
}

// Field names that consumers already read (`text`, `messageId?`, `toolCallId?`) are kept.
// Only the vendor-worded `parentToolUseId` is renamed.
export type LaneEvent =
  | { type: 'user_message_chunk'; text: string; content: ContentBlock }
  | { type: 'message_chunk'; text: string; content: ContentBlock; messageId?: string; parentToolId?: string }
  | { type: 'thought_chunk'; text: string; parentToolId?: string }
  /** `jobsReport` (spec 370): an OMP `wait` frame's job snapshot, only on the frame that carried it. */
  // `images`: what this update adds to the row's image strip (blocks, location paths,
  // the call's first location for byte pairing, paths scanned from input/output).
  | { type: 'tool'; phase: 'call' | 'update'; view: ToolView; images: ToolImageUpdate; jobsReport?: readonly OmpJob[] }
  // Policy facts computed once by the decoder with the spec 96/143 rules (see phase 2b).
  | { type: 'permission_request'; requestId: number; view: ToolView; options: PermissionOption[];
      harnessTool: string | null; highRisk: boolean; argsPreview: string; serverName: string | null }
  | { type: 'ask_user_question'; requestId: number; questions: AskUserQuestion[]; toolCallId?: string }
  // elicitation_request, plan, usage, available_commands, mode_update, fs_activity,
  // fs_write_pending, turn_state, turn_marker, stop, error: today's payloads, unchanged.
  ;

export interface LaneInit {
  readonly promptImage: boolean; readonly promptEmbeddedContext: boolean;
  readonly sessions: AcpSessionCapabilities; readonly mcp: { http: boolean; sse: boolean };
  readonly steering: boolean; readonly authMethods: readonly unknown[];
  readonly reportedModel: string | null;   // model name an agent puts in its capabilities
  readonly modes: readonly AcpAgentMode[]; // off-spec `agentCapabilities.availableModes`
}
export interface LaneSession {
  readonly sessionId: string;
  readonly models: readonly ModelInfo[];   // Rust's parsed list, already Krypton-shaped
  readonly currentModelId: string | null;
  readonly modes: readonly AcpAgentMode[]; readonly currentModeId: string | null;
  readonly modelApplyFailed: boolean;
}
// Modes reuse the existing Krypton type `AcpAgentMode { id; name; description? }`.
```

`ToolPayload` (`harness-view-types.ts:266`) becomes `ToolView` plus the fields the view owns: `glyph`, `result`, timing, and `artifactRedaction`. Spec 133 redaction stays in the view because it checks Krypton's artifact registry against `view.modifiedPath` (and the scratch check against `modifiedPath`, `locations` and `inputPaths`), not wire data.

### Adapter interface

```ts
export interface LaneAdapter {
  readonly id: string;                       // 'generic' or a backend id
  readonly supplies: SupplyMatrix;           // see Supply matrix
  /** Each hook refines the generic result; omit a hook to keep the generic result. */
  tool?(wire: WireToolCall, base: ToolView, prior: ToolView | null): ToolView;
  chunkParent?(meta: unknown): string | null;
  turnState?(update: unknown): 'active' | 'idle' | null;
  questions?(raw: unknown): AskUserQuestion[] | null;
  session?(raw: unknown, base: LaneSession): LaneSession;
  promptResult?(raw: unknown): { usage: UsageInfo | null };
}

export interface LaneDecoder {
  event(raw: RawAcpEvent): LaneEvent[];      // zero or more canonical events
  init(raw: unknown): LaneInit;
  session(raw: unknown): LaneSession;
  promptResult(raw: unknown): { stopReason: StopReason; usage: UsageInfo | null };
  reset(): void;                             // fresh session / spawn epoch
}
export function createLaneDecoder(backendId: string): LaneDecoder;
```

| Adapter | Overrides (moved from) |
|---------|------------------------|
| generic | ACP fields; `_meta.terminal_info/output/exit` (Claude and Codex follow it); `rawOutput` `exit_code`/`exitCode`/`code`; generic section keys; byte-array decode; title cleanup; tool-kind inference (including shell-like titles); the exact `mcp__<server>__<tool>` identity; the image walk; ACP `modes`; Rust's parsed model list; ask-user question parsing; prompt usage at the top level or under `_meta.usage` |
| claude | `_meta.claudeCode.parentToolUseId` on chunks and tools; Task/Agent subagents; background-launch text; `mcp__s__t` and `claudeCode.mcpServer` identity; drops the Bash `description` display copy if terminal meta is absent; drops the `Exit code N` first line when N is the shown exit (`exitLine`) |
| codex | `_meta.codex.threadStatus` → `turn_state`; `collaboration.spawnAgent` subagents and names; Guardian review |
| grok | Typed `rawOutput`, `exit:` prefix, read anchors, `<workspace_result>` |
| omp | `details` subagents, `wait` jobs, code cells, background-frame status hold |
| fx | `mcp_<s>_<t>` identity |
| all others | generic only |

### Data Flow

```
1. Rust emits acp-event-<session> (unchanged).
2. AcpClient.handleRaw → decoder.event(raw).
3. The decoder runs the generic step, then the backend adapter's hook.
   For tools it merges the wire update into its per-call state, builds a full
   ToolView, and reuses the prior `sections` / `diffs` arrays when
   the update carried none. ToolRow deps compare those by reference.
4. Each listener gets the LaneEvent: AcpHarnessView.onLaneEvent, inline AI,
   commit explainer, assist, headless fence.
5. onLaneEvent → renderTool(lane, view) builds the row payload with the pure
   toolPayloadFromView(view, timing); permission and question rows use the pure
   permissionItemFromEvent / questionItemFromEvent. Spec 381's gallery calls the
   same functions, so it shows exactly what a lane shows.
   publishStream sends the same LaneEvent to control SSE under its existing
   kind (`tool_call` / `tool_call_update` from `phase`), and Telegram reads `view`.
6. initialize / session/new|load|resume / prompt results go through
   decoder.init / session / promptResult before the view stores them.
```

Per-call state is bounded: the compacted merged wire call (`compactToolCallForRetention`, which drops `_meta`, so the decoder also remembers each call's `parentId`) and the last `ToolView`. Terminal calls are kept in an LRU of 512 entries, more than the 300-row transcript cap. Calls that are still live are never evicted. An update for an id the decoder never saw yields no event. The view keeps its row-level orphan rule unchanged (see the phase 2 plan).

### Supply matrix

Each adapter exports `supplies`: for `exit`, `subagents`, `turnState`, `usageCost`, `models`, `modes` and `images`, the value is `'yes'`, `'no'` or `'unverified'`. The matrix is published in `docs/0069` and drives the contract test. Missing data is then documented per backend, not silently absent.

### Contract and guard tests

- **Fixtures.** Capture wire-profiler `full` JSONL exports (spec 288) of each backend running the same scripted prompts. Scenarios: `printf` success, `false` failure, file read, file edit, plan, permission, question, and a subagent where supported. Scrub home paths and tokens, and keep each file at most 64 KB (the test enforces this). The spec 381 gallery renders these fixtures side by side.
- **`adapters.contract.test.ts`.** Decode every fixture and reduce each `LaneEvent` to its visible projection (`kind`, `subject`, `status`, section text, `exit`, diff paths, subagent names). Every backend must match the scenario's single expected projection. The only exception is a field marked `'no'` for that backend, which must then be null or empty. A `'yes'` field must be present.
- **`wire-boundary.test.ts`.**
  - Scan `src/**/*.ts`, excluding tests, `src/acp/adapters/**` and `src/acp/client.ts`. Fail on property access to `rawInput`, `rawOutput`, `_meta` or `sessionUpdate` (matched as `.name` or `['name']`, so BEM `__meta` classes do not match), and on imports of the wire `ToolCall*` types.
  - Also fail on `backendId` inside `src/acp/components/**` and inside the bodies of `onLaneEvent`, `renderTool`, `addPermission`, `addAskUser`, `collectToolImages` and `noteToolActivity`. In components, the identity uses that existed before 4a (logo, label, session-picker target, launch-trust chip) are pinned by count instead; see the Phase 4a deviations.
  - Fail on any `@tauri-apps` import under `src/acp/adapters/**` or in `harness-transcript-items.ts`, direct or reached through other imports (see the Phase 4a deviations). Both stay pure, so the spec 381 gallery can run them in the browser.

### Phases

Each phase lands separately and leaves the app working.
1. Types, decoder, registry and the non-tool events (`LaneInit`, `LaneSession`, prompt result). `onEvent` emits `LaneEvent`. Until phase 2, `LaneEvent` keeps today's `tool_call` / `tool_call_update` / `permission_request` members, which carry the wire `ToolCall`. These are marked transitional. See "Phase 1 — Implementation Plan".
2. `ToolView`: move the wire readers and per-call state into adapters. Switch `renderTool`, permissions, peek, images, inline AI, commit explainer, headless fence, control SSE and Telegram. Move the existing render, subagent, execution and Guardian tests with their inputs.
3. Declare `_meta.terminal_output` and handle the terminal convention in the generic adapter.
4. Fixtures, supply matrix, contract and guard tests, docs, ADR 0031. Lands in two steps: **4a** (no live lane needed) moves the remaining wire readers, adds the guard test, the supply matrix and ADR 0031; **4b** captures the fixtures and adds the contract test.

### UI Changes

No new DOM, CSS or row components; every row is fed `ToolView` instead of wire data. Visible differences:
- Claude and Codex lanes gain the `EXIT n` readout.
- The Claude Bash description no longer fills the output well.
- A failed Claude command's well no longer repeats its exit code as an `Exit code N` first line.
- Mode names come from the ACP `modes` field, and the lane head shows the session's starting mode as soon as the session opens, not only after the first `current_mode_update`.
- The lane activity line shows the cleaned tool title (phase 2a).

### Phase 1 — Implemented (2026-11-10)

- `src/acp/adapters/` holds `types`, `generic`, `claude` (`chunkParent`), `codex` (`turnState`), `registry` and `decoder` (+ `decoder.test.ts`, 16 tests). `AcpClient` decodes events and the init/session/list/prompt results. `initialize()` returns `{ init, session }`. `AcpEvent`/`AgentInfo` are gone; `WireInitInfo`/`WireSessionInfo` are adapter-only. Rust forwards the session's `modes`.
- The view applies modes through `configureLaneFromInfo(lane, init, session)` and `applyRestoredSession(lane, init, session)`. Restored lanes keep their init-only model-name inference.
- Behaviour kept exactly: an unknown `stopReason` still passes through; capability flags keep their truthiness checks; prompt usage reads both locations for every backend. Claude parent ids and Codex thread state are read only on `claude` / `codex` lanes. Those are the only backend ids that run claude-agent-acp and codex-acp.
- Verified: `npm run check`, `npm run build`, the full `npx vitest run` (297 files, 3,579 tests), `cargo fmt -- --check`, `cargo clippy`, `cargo test` (676 tests) and `git diff --check`. `cargo clippy --all-targets` reports one existing `bool_assert_comparison` warning in `src/timeline.rs` tests. The starting-mode chip has not yet been seen in the running app (it needs `make install` and a relaunch).

### Phase 2 — Implementation Plan

Phase 2 lands in two steps, and the app works after each. **2a** covers tool rows and every non-permission consumer. **2b** covers permissions. Behaviour stays the same except for the items listed under "Visible in 2a".

**2a — Implemented (2026-11-10).**
- **Decoder:** `adapters/tool.ts` (`ToolCallDecoder`: merge, LRU, the prior-reference rule) plus the `grok`, `claude`, `codex` and `omp` adapters. The view's `renderTool` keeps only view state. `harness-transcript-items.ts` (`toolPayloadFromView`) builds the row payload. `lane.toolCalls` became `lane.toolViews`, and `lane.codexAgentNames` moved into the decoder.
- **Consumers:** ToolRow no longer re-applies Grok cleanup. Peek, lane stats and the rail entry read `toolViews`. The commit explainer, inline AI (`hostExecCommandOfView`), the control stream (`tool_call`/`tool_call_update` kinds, canonical payload) and Telegram (`payload.view`) read views. `buildToolPayload` and `mergeToolPayloadForUpdate` are deleted; their tests moved to `adapters/tool.test.ts` (21 tests).
- **Deviations from the plan:**
  - Images are per update (`event.images`), not a `ToolView` field: the strip adds what each update brings.
  - `paths` became `locations` + `inputPaths`.
  - The wire-reading helpers keep their modules (`harness-tool-render`, `-subagents`, `-execution`, `-guardian-review`, `-background-tasks`, `-images`). For tool events only the adapters call them; the permission path still does until 2b. Phase 4's guard test moves and locks them (done in 4a).
  - `headless-fence.ts` only answers permissions, so it moves in 2b.
- **Visible:**
  1. Grok cleanup runs on Grok lanes only: an `exit: 3` first line stays text elsewhere.
  2. The activity line trims the title.
  3. File touches and the memory refresh read the merged call, so a completion update without a path still records the touch.
  4. Telegram names an MCP call `server · tool` from the adapter identity, not from argument keys.
- **Verified:** `npm run check`, `npm run build`, the full `npx vitest run` (298 files, 3,592 tests), `cargo fmt -- --check`, `cargo clippy`, `cargo test` (676) and `git diff --check`. Not yet seen in the running app.

**2b — Implemented (2026-11-10).**
- **Decoder:** `adapters/permission.ts` builds the request's `ToolView` with `ToolCallDecoder.view()`. The view is unmerged and leaves call state untouched, as the old card did. The decoder also computes the policy facts once with the exact functions that decided them before: `harnessTool` (`harnessAutoAllowToolName`, spec 96), `highRisk` (`permissionCommandIsHighRisk`, spec 143), `argsPreview` and `serverName`.
- **View:** `HarnessPermission` extends that `PermissionRequest`. `addPermission`, the artifact and review grants, the `acceptEdits` check (`view.declaredKind === 'edit'`), the high-risk check, `describePermission` (now the pure `permissionPayloadFromRequest`), the compact labels, `permission.list` and the orchestrator rows read only the request.
- **Other consumers:**
  - `headless-fence.ts`'s `isExactMcpTool` compares `view.mcp`. On permission requests the Claude adapter holds that identity to the paired rule, so `claudeCode` must restate both the tool and the server.
  - Inline AI reads `hostExecCommandOfView`. The wire `hostExecCommand` is deleted.
- **Deviations from the plan:**
  - Auto-allow reads the decoder's `harnessTool`, not `view.mcp`. The spec 96 rule needs Krypton's own server names and the top-level-metadata pairing, so it is computed once in the decoder with the reviewed function; `view.mcp` stays the generic identity that the fence and inline AI read.
  - The fx and Junie forms stay generic, as before (the plan put them under their adapters). A per-backend gate would only risk prompting on a backend that sends the same exact form.
  - `declaredKind` was added so `acceptEdits` never trusts an inferred kind. A regression test pins this.
- **Verified:** after 2b, nothing outside `src/acp/adapters/` and the helper modules the adapters call reads `rawInput`, `rawOutput` or `_meta` (grep). `npm run check`, `npm run build`, the full `npx vitest run` (298 files, 3,596 tests) and `git diff --check` passed. No Rust changed in 2b; the 2a cargo run stands.

**2b — plan as approved**

- **Event:** `permission_request` carries `view` (built from the request's own tool call, not merged, as today). `describePermission` becomes the pure `permissionItemFromEvent`. The control `permission.list` `tool` string and the compact labels (`harness-lane-chrome.ts`, rail entry) read `view`.
- **Mode check:** `acceptEdits` keeps reading the wire kind. The view gets it as `view.kind` only where `inferToolLabel` agrees; a test pins this.
- **High-risk gating:** reads `view.commandLine` and `view.kind === 'execute'`. A test pins equality with `isExecuteLikeToolCall` on today's inputs.
- **Harness-tool auto-allow:** decides only from `view.mcp`. Each adapter derives it from its own exact form: Claude/Codex title `mcp__<server>__<tool>`, fx `mcp_<server>_<tool>`, Junie `Always allow ("<server>:<tool>")`, the rendered `Tool: <server>/<tool>` content line, and top-level server metadata. These are the rules the auto-allow fix below already enforces in `harness-permission-scan.ts`; 2b moves them into the adapters.

**Auto-allow finding (2026-11-10, reproduced with a throwaway vitest probe, then deleted).** For every harness tool except the timeline family, `harnessAutoAllowToolName` accepts:
- a server marker found anywhere in the call (arguments, content, title), combined with
- a tool name found anywhere, including the word-boundary fallback regex.

Both of these returned `peer_send`, which auto-resolves the request with `allow_once`:
- an execute permission titled `rg peer_send ~/x/krypton-harness-memory`;
- `mcp__evil__peer_send` with `rawInput { note: "krypton-harness-bus" }`.

So a shell command that only mentions a harness server and tool name ran without a prompt. The timeline family was already hardened ("never argument text").

**Fixed before 2a (2026-11-10, user decision: fix now, timeline-grade).** `builtInPermissionToolName` now applies the timeline rule to every built-in tool family:
- no free-text marker or name scan;
- no `rawInput` server identity;
- an `execute` call never qualifies.

Plain harness tool names that carry their server only in `rawInput` now prompt. The four tests that asserted that form now assert the prompt, and also that the same identity is accepted as top-level metadata. A new regression test covers the bypass shapes: a shell command, an `execute` call with a qualified title, a foreign `mcp__` title, free text, and an option label. Spec 0096 is updated.

**Verification (each step):** `npm run check`, `npm run build`, the full `npx vitest run`, `cargo fmt -- --check`, `cargo clippy`, `cargo test`, `git diff --check`. Then, after the user installs and relaunches, a screen capture of a Grok and a Claude lane running the same command.

### Phase 3 — Implemented (2026-11-11)

- **Rust:** `client_capabilities(backend_id)` builds `initialize.clientCapabilities` and adds `_meta.terminal_output: true` for every backend. `terminal: false` stays: Krypton runs no client terminals. A unit test pins both.
- **Generic adapter:** `terminalMetaOf(meta)` reads `terminal_output.data` and `terminal_exit.exit_code`. A non-number code reads as null. `terminal_info` is not read, because it only names the terminal, and both servers use the tool call id as the terminal id.
- **Decoder (`adapters/tool.ts`):**
  - Each call keeps a `TerminalState`, because `compactToolCallForRetention` drops `_meta` from the merged call.
  - Output chunks are appended, as Zed does, and the head is kept to `TERMINAL_OUTPUT_CHAR_LIMIT` (16 KiB).
  - Once any output arrived, it is one `output` section.
  - `terminal_exit.exit_code` wins over `rawOutput.exit_code`.
  - An update that changes neither output nor exit keeps the prior `sections` array. Past the 16 KiB bound, or for a late `terminal_exit` with no code, ToolRow does not repaint.
  - The chunk text is scanned for image paths, like the console block it replaces.
- **Claude adapter:** the spec 305 launch line is read from `content` as before, or from the call's terminal output (`parseBackgroundLaunchText`).
- **Wire shapes, read from the adapter sources:**
  - **claude-agent-acp** (`tool-calls/renderer.ts`, `reporters/bash.ts`):
    - A command sends its whole output in one `terminal_output` update.
    - A second update carries `terminal_exit`, the status and `content: [{type: "terminal"}]`, with no `rawOutput`.
    - The exit is 0 on success, and the `Exit code N` code on failure.
    - A background command has none: `terminal_exit` is dropped until the task ends, and then it carries `exit_code: null`.
  - **codex-acp 2.6.0:**
    - A command with a terminal streams `terminal_output` chunks and ends with `terminal_exit`.
    - A read, search or list command has no terminal. Its output comes as `content` text, and its exit as `rawOutput.exit_code`.
- **Deviations from the plan:**
  - The Claude adapter's fallback that drops the Bash `description` copy when terminal meta is absent is not implemented. With the declaration, claude-agent-acp never sends that copy.
  - Codex's `readableInput` display copy in `content` still fills the well until the first output chunk arrives. It also stays for a command that prints nothing, which is the same as before phase 3. On a live Codex lane, `false` (no output) showed an empty well, so this copy did not appear in that case.
- **Verified:** `npm run check`, the full `npx vitest run` (298 files, 3,607 tests; `src/acp/adapters` 52), `cargo fmt -- --check`, `cargo clippy`, `cargo test` (674 + 3) and `git diff --check`.
- **Seen in the running app (2026-11-11, Claude lane):**
  - The installed bundle was built after phase 3 and declares `terminal_output`.
  - Window captures of a Claude lane show `EXIT 0` with output for successful commands, `EXIT 1` for `false`, and `EXIT 3` with `boom` for `echo boom; exit 3`.
  - A failing command's well started with Claude's `Exit code N` line, so the code showed twice. The follow-up below removes it.
  - Codex lane, in a `tauri dev` build of the phase 3 + 4a working tree: `printf hi` shows `EXIT 0` with `hi` in the well. Before phase 3, codex-acp sent this output only as `terminal_output_delta`, which Krypton did not read. `false` shows `EXIT 1` with an empty well. No `Exit code N` line and no input copy appeared, unlike Claude.
- **Follow-up (2026-11-11): Claude's `Exit code N` line.**
  - `LaneAdapter.exitLine` is a pattern for a first output line that restates the exit code. The Claude adapter sets it to `Exit code N`.
  - `generic.ts` `dropExitLine` removes that line from every section, terminal output or `content` text, when N is the exit the row shows. It runs before the line cap, so the well still shows its full line count.
  - The line stays while the exit is unknown, and when it names another code, because the well is then the only place that code appears. A `false` whose output was only that line shows an empty well, as on Codex.
  - Tests in `adapters/tool.test.ts` cover terminal output, `content` text, the unknown and mismatched exits, a later line, a Codex lane, and the kept `sections` reference.
  - Seen in a `tauri dev` build on a Claude lane: `echo boom; exit 3` shows `EXIT 3` with only `boom` in the well.

### Phase 4a — Implemented (2026-11-11)

- **Wire readers moved into `src/acp/adapters/`.** The code moved without logic changes. Each source module keeps what reads decoded data only.

  | From | To | What moved |
  |------|----|------------|
  | `harness-tool-render.ts` | `generic.ts` | `mergeToolCall`, `inferToolLabel`, `looksLikeShellCommand`, `extractRawToolName`, `extractCommandLine(Raw)`, `isExecuteLikeToolCall`, `permissionCommandIsHighRisk`, `extractToolExit(Code)`, `peelExitPrefix`, `peelSectionExit`, `rawOutputGenericSections`, `contentOutputSections`, `contentBlockText`, `decodeByteArray`, `stringifyToolValue`, `toolSubject`, `extractToolDiffs` |
  | `harness-tool-render.ts` | `grok.ts` | `GROK_RAW_OUTPUT_TYPES`, `formatGrokFileMatches`, `grokRawOutputSections` |
  | `acp-harness-memory.ts` | `generic.ts` | `extractModifiedPath` |
  | `harness-tool-retention.ts` | `tool.ts` | `compactToolCallForRetention` and its limits (`TOOL_CALL_RETENTION_CHAR_LIMIT`). `truncateRetainedText` is now exported from the retention module and shared |
  | `harness-subagents.ts` | `subagents.ts` | The boundary schemas, `parseSubagentPayload`, `codexSubagentName`, `isOmpBackgroundUpdate`, `parseOmpJobs`. The card state (`absorbChildToolCall`, `applyOmpJobs`, `jobsPayload`, summaries) stays, and exports `SUBAGENT_*_LIMIT`, `outputTail`, `forwardSubagentEntry` and `isLiveSubagent` to the decoder |
  | `harness-execution.ts` | `omp-execution.ts` | The boundary schemas and `parseExecutionPayload`. `executionState`, `executionTiming` and `executionOutputParts` stay |
  | `harness-guardian-review.ts` | `codex-guardian.ts` | The whole module and its test (`git mv`) |
  | `harness-background-tasks.ts` | `claude.ts` | `parseBackgroundLaunch`, `parseBackgroundLaunchText`, `launchCommand` |
  | `harness-permission-scan.ts` | `permission.ts` | The spec 96 identity rules (`harnessAutoAllowToolName` and its private helpers), `extractHarnessServerName`, `stringValueForKeys`, `permissionArgsPreview`, `extractToolArguments`, `boundedInlineValue`. The tool-name sets stay; `HARNESS_AUTO_ALLOW_TOOL_NAMES` is exported to the decoder |

- **Removed (no runtime caller):**
  - `extractionFromTool` and its three private helpers in `acp-harness-memory.ts` (no caller since `819d35e`).
  - `callTargetsArtifactScratch` / `rawInputPathMentionsScratch`. Since 2a the view redacts with `viewTargetsArtifactScratch` over `view.inputPaths`. The two regression tests now run that live path through the decoder.
  - `rawOutputSections`, which ran the Grok reader first, then the generic one. Its byte-array tests now call `rawOutputGenericSections`.
  - The unused wire `ToolCall` import in `harness-view-types.ts`, and the view's re-exports of the moved functions. Tests import from the owning module.
- **Guard test (`adapters/wire-boundary.test.ts`):**
  - It reads the TypeScript syntax tree, so comments, strings and BEM classes never match.
  - It fails on `.key`, `['key']` and `{ key }` reads of `rawInput`, `rawOutput`, `_meta` and `sessionUpdate`, and on any import or re-export of `ToolCall`, `ToolCallUpdate` or `ToolCallContent` from `src/acp/types.ts`. It skips tests, `src/acp/adapters/**` and `src/acp/client.ts`.
  - It fails on `backendId` in the six named view methods, and on any `@tauri-apps` import, static or dynamic, that `src/acp/adapters/**`, `harness-transcript-items.ts` or `ask-user-question.ts` reach through any chain of runtime imports. Type-only imports don't count.
  - A probe case checks that the scanner catches each form and ignores the look-alikes.
- **Supply matrix:**
  - `SupplyMatrix` / `Supply` in `adapters/types.ts`. `LaneAdapter.supplies` is required. `UNVERIFIED_SUPPLIES` is the starting value, and the generic adapter keeps it.
  - A `no` is set only where Krypton's own code cannot fill the field for that backend: subagents on Grok, and turn state on Claude, Grok and OMP. `adapters/supplies.test.ts` checks each `no` against the decoder.
  - Every other cell stays `unverified` until 4b. The table is in `docs/0069-acp-agent-support.md`.
- **Docs:** ADR 0031 (indexed in `docs/README.md`), plus `docs/0004`, `0005`, `0069`, `0072` and `0282`. The 0005 entries for OMP code cells, background OMP status and the background-launch flow still said `renderTool` does the decoding, which was stale since 2a; they now name the adapter.
- **Deviations from the plan:**
  - **`backendId` in components.**
    - The planned rule, no `backendId` anywhere under `src/acp/components/**`, would fail on three existing components. None of them reads wire data; each names the backend for identity:
      - `lane-head`: the logo, plus the Pi/Junie launch-trust chip.
      - `rail-entry`: the logo, plus the backend name trimmed off a directive title.
      - `session-picker`: which backend's sessions it lists.
    - The guard pins those uses by count (4, 8 and 4). Any other component, or a new use in these three, fails.
  - **Subagent shapes stay in one module** (`adapters/subagents.ts`). The plan gave each shape to its own adapter. The OMP→Claude→Codex order still runs on all three adapters, as before, so no lane changes behaviour.
  - **The Tauri rule checks the whole import chain, not only direct imports** (added while preparing spec 381, 2026-11-11). The decoder used to reach `@tauri-apps/api/core` through `harness-images.ts`, `harness-format.ts` and `agent/tools.ts` → `profiler/ipc.ts`. The pure helpers it needs moved into Tauri-free modules, which the old modules re-export:
    - `classifyBashCommand` → `src/agent/bash-risk.ts`
    - `truncate` / `truncateInline` → `src/acp/text-truncate.ts`
    - the image-path scanner → `src/acp/image-paths.ts`

    The guard now follows every runtime import from the adapters and the shared item builders (`harness-transcript-items.ts`, `ask-user-question.ts`). It fails on any `@tauri-apps` import it reaches and names the chain.
  - **Some readers stay in place.** They read decoded text or a plain value, never a wire key:
    - `scanValueForImagePaths` (now in `image-paths.ts`), which walks a plain value.
    - `cleanToolTitle`, `boundedOutputLines` and `normalizeToolDump` in `harness-tool-render.ts`, which rows also use.
- **Verified:** `npm run check`, `npm run build`, the full `npx vitest run` (300 files, 3,616 tests; `src/acp/adapters` 68) and `git diff --check`. No Rust changed in 4a.

### Configuration

None.

## Edge Cases

- **Unknown or new backend:** the generic adapter applies; its supply matrix is all `'unverified'` until a fixture exists.
- **Remote lanes and `session/load` replays:** both go through the same decoder. `reset()` runs on spawn epoch and on session switch, so replayed calls rebuild their state.
- **Terminal meta and `content` text together:** once any `terminal_output` arrived for a call, it is the whole output well, and `content` / `rawOutput` text is not shown beside it, so output never appears twice. Until then the call keeps the generic sections, so a denial text that arrives instead of output still shows.
- **A backend that ignores `_meta.terminal_output`:** behaviour is unchanged (Grok, OMP and the others keep their adapters).
- **`completed` without exit data:** `exit` is null and no readout is painted, for any backend.
- **Harness-tool auto-allow uses only `view.mcp`:** an exact server/tool identity from the adapter, never substrings of `rawInput`. The adapter derives it from the vendor's own form: Claude/Codex `mcp__s__t` (Claude cross-checked with `claudeCode.mcpServer`), fx `mcp_<s>_<t>`, the `Always allow ("…")` option label, the rendered `Tool: <s>/<t>` content line, or top-level server metadata. Execute-like calls never qualify. A tool name that merely looks like a harness tool but has no matching identity stays manual. Spec 133 artifact-write approval keeps keying on `view.modifiedPath` plus the registry.
- **Assistant-prose provider-error scan (`classifyProviderError` at seal):** stays in the view. It reads canonical text, not wire.

## Open Questions

The missing-data policy follows the user's direction that every lane must look the same: same slots, a null field is absent for every backend, and nothing is fabricated.

The auto-allow decisions are resolved (2026-11-10): the bypass is fixed before 2a, with timeline-grade exact identity for every built-in tool.

## Out of Scope

- Outbound and spawn-time backend choices: MCP delivery, spawn args, startup hints, fs scope, steering requests, resource blocks, timeline/lessons gating.
- Rust protocol replies: answering permissions and questions, the Grok exit-plan auto-approve, `set_model` / `set_config_option`.
- Visual changes to rows or chrome beyond those listed in UI Changes.
- `terminal_output_delta` streaming and ACP v2 `terminal_update` notifications.

## Resources

- Zed source, `/Users/wk/Source/zed` @ `93d7456688`: `crates/agent_servers/src/acp.rs` (`client_capabilities_for_agent`, terminal notifications), `crates/acp_thread/src/acp_thread.rs` (thread model, `_meta` keys, `ToolCallPatch`) — the canonical-model pattern and the terminal capability.
- [claude-agent-acp `docs/air-extensions.md`](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/docs/air-extensions.md) — `terminal_info/output/exit` and when Claude sends the `description` copy and console block.
- [codex-acp `docs/air-extensions.md`](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/air-extensions.md) — Codex `terminal_exit` vs `rawOutput.exit_code`.
- [ACP — Tool Calls](https://agentclientprotocol.com/protocol/tool-calls) — canonical tool-call fields, kinds and statuses.
