# ACP Harness View — Implementation Spec

> Status: Implemented
> Date: 2026-05-01
> Milestone: M8 — Polish

## Live Assist projection (spec 208)

On macOS, `Ctrl+Shift+I` opens a separate `live-assist` Tauri webview with a
dedicated compact renderer. It is not a compact CSS mode of this view and never
reparents `.acp-harness` DOM. `AcpHarnessView` stays mounted in the primary
Krypton window and continues to own every ACP client, lane, transcript,
permission queue, prompt queue, and session transition.

The projection reuses the Harness control surface. Internal
`live_assist.bootstrap` reads all live lane summaries and suggests the previous
assistant selection, otherwise the active lane in the focused Harness, otherwise
the first stable live lane. The auxiliary command allowlist is limited to
status/transcript/permission reads plus send, cancel, and oldest-permission
resolution. Its composer draft and lane selection are local to the auxiliary
window; they do not overwrite the full Harness composer or active lane.

The normal `publishControlEvent` path remains the only live event source. Rust
mirrors its sequence-stamped envelope to `live-assist`; chunks append
incrementally (assistant markdown is tokenised as they arrive) and
authoritative boundaries re-pull the snapshot. If no Harness
is registered, the assistant shows a read-only empty state without opening or
focusing one in the primary window. See `docs/0208-harness-live-assist-mode.md`.

## Problem

Krypton can open multiple ACP agent tabs, but controlling several agents for the same project is manual: prompts, cancels, status checks, and permission prompts are spread across separate tabs. Users also need these agents to coordinate without directly chatting with each other: one ACP instance should be able to publish findings, decisions, and blockers into a shared project memory that later prompt turns for other instances can read.

## Solution

Add an `AcpHarnessView` content view that owns multiple `AcpClient` instances, all spawned with the same `projectDir`. The view splits into two surfaces:

1. **Dashboard** (top, read-only) — lists every lane and renders all activity: status, transcripts, tool calls, permission requests, errors. No input is accepted here.
2. **Command Center** (bottom, input-only) — a tab strip with one tab per lane plus a composer for the active tab. The active tab determines which lane is expanded on the dashboard and which lane will receive the next prompt.

One prompt has exactly one destination lane: the active tab. There is no broadcast, multi-target dispatch, marked-mode, or "all idle" target. The harness owns a tab-local memory board, but memory lifecycle now belongs to ACP agents through a lane-scoped HTTP MCP server on Krypton's existing localhost hook server. The human observes the current board and can expand details, but cannot create, update, delete, pin, restore, or audit memories. Each prompt injects short guidance and the latest 10 summaries; full details are pulled explicitly by agents with `memory_get`. Permission requests pre-empt the affected tab's composer with a minimal options banner (`a/A/r/R/Esc`); the request detail (operation, path, size, diff preview, and any cross-lane file-touch warnings) lives in the lane transcript on the dashboard. `A`/`R` ("accept/reject all") are scoped to the current `session/prompt` turn only and clear automatically when the turn returns.

Memory details are specified in `docs/0073-acp-harness-mcp-memory.md`. Older heuristic memory extraction from tool observations and `MEMORY:` response footers is no longer part of the harness memory flow.

If the localhost loopback server cannot start, harness memory setup surfaces the recorded startup reason from the backend state. Fixed-port conflicts therefore show the failed bind address and OS error rather than the generic "Krypton loopback server is not running; set `[loopback_server] enabled = true` in krypton.toml" fallback — which is also what `[loopback_server] enabled = false` produces. Server failure does not block the ACP Harness itself: the view continues to list and spawn ACP lanes, the composer and memory drawer show memory as unavailable, and lanes run without the `krypton-harness-memory` MCP server.

## Research

- ACP is already a process-per-session model in Krypton: `AcpRegistry` keys clients by `krypton_session`, emits `acp-event-<session>`, and `AcpClient` wraps one backend subprocess. This supports multiple simultaneous agents without backend protocol changes.
- The ACP protocol defines `session/prompt` as one outstanding prompt turn that streams `session/update` notifications and ends when `session/prompt` returns a stop reason. Harness dispatch must therefore skip or queue busy lanes instead of sending concurrent prompts to one ACP session.
- ACP `session/cancel` is a notification; agents may still send final updates before returning `cancelled`. Harness lanes must stay visible until the stop event, not immediately mark cancelled on keypress.
- ACP content blocks include embedded resources for prompt context when an agent advertises `promptCapabilities.embeddedContext`. For agents that do not advertise it, the same lane-context stub is delivered as a leading text block. (Memory bodies are pulled on demand via MCP — see Spec 98.)
- ACP `_meta` and extension methods exist, but relying on custom `_krypton/*` methods would require each external ACP adapter to implement them. The harness should stay adapter-agnostic and use prompt content instead.
- Claude Code memory prior art separates project instructions (`CLAUDE.md`) from auto memory. For Krypton, shared harness memory should be a transparent markdown-like board scoped to the harness/project, not hidden provider-specific memory.
- Claude Code auto memory only loads a bounded entrypoint at session start and expects detailed notes to be read on demand. Krypton should mirror that constraint by injecting only relevant memory entries per prompt, not the full board.
- Zed treats external agents as separate UI threads backed by separate ACP subprocesses and exposes an ACP log view for debugging. Krypton should similarly avoid hiding the fact that each lane is an independent adapter process.
- Claude Code guidance for parallel agent work emphasizes separate contexts and, for write-heavy work, isolated git worktrees. The requested v1 is explicitly "same project", so it should use the same `cwd` while warning in the UI when several writable agents are active.
- tmux `synchronize-panes` is the closest terminal precedent: broadcast input is powerful but needs an obvious active indicator and a quick way to turn it off.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Zed | Opens external ACP agents as separate agent threads, each backed by its own subprocess; custom agents are configured under `agent_servers`; ACP logs are available from the command palette. | Confirms one UI thread per ACP process is the expected host model. |
| Claude Code | Supports subagents/background agents with separate contexts; project/user memory is loaded through markdown files and auto memory. | Validates separate contexts plus shared written memory; v1 harness mirrors the memory-board idea without writing provider memory files. |
| tmux | `synchronize-panes` broadcasts input to all panes; `synchronize-panes off` is the safe default. | Considered as a model for multi-lane dispatch; v1 explicitly drops broadcast — per-tab dispatch is safer and matches the dashboard/command-center split. |
| Zellij/tmux pane layouts | Multiple sessions are arranged in tiled panes with keyboard navigation. | Harness lanes are compact and scannable on a dashboard; reading detail lives in the active lane, not in side-by-side full chats. |

**Krypton delta** — Match the familiar "many panes, one command deck" pattern, but keep it inside the compositor as a real `ContentView`. Split display from input: the dashboard renders activity for every lane while the command center accepts input only — one tab per lane, no broadcast. Add a transparent memory board so agents coordinate indirectly through shared facts and decisions. Diverge from provider-native memory by keeping this memory owned by Krypton, visible to the user, and injected into prompts rather than hidden in Claude/Codex/Gemini private stores.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/client.ts` | Expose `sessionId`/`backendId` accessors and keep existing one-client-per-process API. |
| `src/acp/types.ts` | Add harness-facing lane state types if they are not local to the view. |
| `src/acp/acp-harness-memory.ts` | Helpers for identifying modified paths and memory tool calls in ACP tool updates. |
| `src/acp/acp-harness-view.ts` | New `ContentView` that manages multiple ACP clients, lane state, file-touch tracking, prompt dispatch, lane rendering, permissions, hash commands, restart, fresh session, and cancel/dispose. |
| `src/acp/harness-*-controller.ts` | Spec 275: dictation, timeline and ticket state/behavior live in per-feature controllers that reach the view only through the `src/acp/harness-view-host.ts` contracts. |
| `src/acp/index.ts` | Export `AcpHarnessView`. |
| `src/styles/acp-harness.css` | New harness-specific BEM CSS using existing ACP/agent theme variables. |
| `src/styles/index.css` | Import `acp-harness.css`. |
| `src/types.ts` | Add `'acp_harness'` to `PaneContentType`. |
| `src/compositor.ts` | Add `openAcpHarnessView()` using `getFocusedCwd()`. The harness *replaces the launching terminal tab*: open it as a content tab in the same window via `createContentTab()`, then close the terminal tab it launched from (`closeTabByIndex`) so the harness slides into its place — no new window, sibling tabs and other windows untouched. Wire the close callback to `closeTab()`. Fallback: when there is no focused window (empty workspace), open the harness in its own window via `createContentWindow()` with a `closeWindow(harnessWindowId)` close callback. |
| `src/command-palette.ts` | Add "Open ACP Harness" action. |
| `src/input-router.ts` | Add a compositor-mode shortcut for the harness. |
| `src/which-key.ts` | Add the shortcut label. |
| `src-tauri/src/commands.rs` / `src-tauri/src/hook_server.rs` | Create/list/dispose per-project harness memory and clear one lane's persisted memory document. |
| `docs/PROGRESS.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md` | Document the harness lifecycle, memory flow, and command surface. |

## Design

### Data Structures

```ts
type HarnessLaneStatus = 'starting' | 'idle' | 'busy' | 'needs_permission' | 'error' | 'stopped';

interface HarnessLane {
  id: string;
  index: number;
  backendId: string;
  displayName: string;
  client: AcpClient | null;
  status: HarnessLaneStatus;
  draft: string;
  cursor: number;
  pendingPermissions: HarnessPermission[];
  transcript: HarnessTranscriptItem[];
  spawnEpoch: number;
  usage: UsageInfo | null;
  lastTurnTokens: CacheTokenTuple | null; // coherent cache-rate tuple (spec 249)
  sessionId: string | null;
  supportsEmbeddedContext: boolean;
  supportsImages: boolean;
  error: string | null;
  acceptAllForTurn: boolean;   // turn-scoped 'A' state; cleared when session/prompt returns
  rejectAllForTurn: boolean;   // turn-scoped 'R' state; cleared when session/prompt returns
  pendingTurnExtractions: never[];
  currentAssistantId: string | null;
  currentThoughtId: string | null;
  toolTranscriptIds: Map<string, string>;
  toolCalls: Map<string, ToolCall | ToolCallUpdate>;
  seenTranscriptIds: Set<string>;
  pendingShellId: string | null;
  stagedImages: StagedImage[];
}

interface HarnessViewState {
  lanes: HarnessLane[];
  activeLaneId: string;
  memoryDrawerOpen: boolean;
  memoryCursorRowId: string | null;
  transcriptScrollFocus: boolean;
  fileTouchMap: Map<string, FileTouchRecord>;  // path → most recent edit/write-like diff per lane
}

interface FileTouchRecord {
  path: string;
  laneId: string;
  laneDisplayName: string;
  toolKind: 'edit' | 'write_like';
  at: number;
}

interface ProviderErrorPayload {
  category: 'rate_limit' | 'quota' | 'auth' | 'context' | 'network' | 'provider' | 'unknown';
  code?: string;
  headline: string;
  hint?: string;
  retryable: boolean;
  raw: string;
}

interface HarnessTranscriptItem {
  id: string;
  kind: 'system' | 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'permission' | 'restart' | 'memory' | 'shell' | 'fs_activity' | 'fs_write_review' | 'inter_lane' | 'review' | 'provider_error';
  text: string;
  status?: string;
  diff?: { title: string; unified: string };
  providerError?: ProviderErrorPayload;
}

interface HarnessSpawnSpec {
  backendId: string;
  displayName: string;
  count: number;
}

interface HarnessMemoryEntry {
  lane: string;
  summary: string;
  detail: string;
  updatedAt: number;
}
```

Default roster: **none.** The harness boots empty (`lanes = []`). On first open, instead of auto-spawning a default lane, `start()` opens the lane picker automatically (when at least one supported backend is installed) so the user chooses which ACP backend to start; dismissing the picker with `Esc`/`q` leaves the harness empty with the `press Cmd+P then + to add a lane` hint. Thereafter the user spawns more lanes on demand via the lane-picker leader key (`Cmd+P → +`). Gemini remains available in the standalone ACP agent view but is intentionally excluded from the multi-lane harness picker, session picker, and backend-scoped directives. The picker order is Claude, Codex, Grok, OpenCode, Pi, then remaining installed backends by id (`HARNESS_BACKEND_ORDER` in `src/acp/harness-lane-identity.ts`). Backend display names are mapped through `BACKEND_LABELS` (`claude` → "Claude", `codex` → "Codex", `grok` → "Grok", `opencode` → "OpenCode", `pi-acp` → "Pi", `droid` → "Droid", `cursor` → "Cursor", `junie` → "Junie", `omp` → "OMP"); unknown backend ids fall back to a capitalized form. See `docs/0092-acp-lane-picker.md` for the picker UI and lane lifecycle. Earlier versions auto-spawned every installed backend on view open — that path was removed because it forked long-running ACP subprocesses before the user typed anything.

### API / Commands

The harness uses existing frontend ACP APIs plus harness memory IPC:

```ts
AcpClient.listBackends(): Promise<AcpBackendDescriptor[]>;
AcpClient.spawn(
  backendId: string,
  cwd: string | null,
  mcpServers?: AcpMcpServerDescriptor[],
): Promise<AcpClient>;
client.initialize(): Promise<AgentInfo>;
client.prompt(blocks: ContentBlock[]): Promise<StopReason>;
client.cancel(): Promise<void>;
client.respondPermission(requestId: number, optionId: string | null): Promise<void>;
client.dispose(): Promise<void>;
view.stageCapturedImage(image: CapturedImage): boolean;

create_harness_memory(projectDir: Option<String>): HarnessMemorySession;
list_harness_memory(harnessId: String): HarnessMemoryEntry[];
clear_harness_memory_lane(harnessId: String, lane: String): void;
dispose_harness_memory(harnessId: String): void;
```

New compositor method:

```ts
openAcpHarnessView(): Promise<void>;
```

### Shared Memory Model

Memory is a per-project set of **handoff documents**, each with its own id (`ho-…`), author (lane label at last write), host, and timestamps (spec 293, ADR-0023). Every harness tab of one project shares one store. The harness attempts to create one memory store through `create_harness_memory(projectDir)` and passes each ACP lane a lane-scoped HTTP MCP endpoint when available. If the global localhost hook server is unavailable, memory is disabled for that harness tab but ACP backend listing, lane spawning, prompts, permissions, and transcripts continue normally. Agents write handoffs with one MCP tool when the endpoint exists:

- `handoff_set` overwrites the handoff **bound** to the calling lane, or mints a new handoff and binds the lane to it. There is no MCP read tool — reading happens only through `#resume`, which injects the document.

The human surface is intentionally smaller: the memory drawer is read-only and lists handoffs newest first with author, host, and age; `#mem clear` deletes the handoff bound to the active lane. The harness no longer extracts memory from tool observations or `MEMORY:` assistant footers.

Krypton auto-handles only its built-in Harness MCP allowlist with matching server identity. Memory/peer/attention/review bookkeeping, global lesson tools (spec 298), and bounded ticket progress keep their existing contracts. Timeline's exact final tools are `timeline_record`, `timeline_list`, `timeline_merge`, `timeline_pending_resolve`, `timeline_conflict_list`, `timeline_conflict_record`, and `timeline_conflict_checked` ([spec 316](0316-llm-managed-timeline.md)). These are agent-owned, not gated by current-human persistence instructions. A built-in Timeline request without an accept option is cancelled with `respondPermission(requestId, null)` and a diagnostic, never queued for the human. Same-name third-party tools receive no additional rights. Handoffs remain project-scoped, lane bindings memory-only, peering user-directed, and unrelated permissions retain the normal composer flow. Auto-allowed calls remain auditable in transcript permission cards.

Spec 133 adds a **separate** auto-approval mechanism for HTML-artifact file writes. Because the write is performed by a backend-native filesystem tool (not the harness MCP server), it **cannot** key off the spec-96 built-in-server marker. Instead it matches the write target's canonical path against an issued artifact path in the registry for the same `harnessId + laneId + artifactId` (state `pending` or `registered_live`). The auto-approved write card is redacted to path + bytes + hash. See `docs/0133-harness-html-artifacts.md` and `docs/0096-acp-built-in-memory-auto-approval.md`.

#### Memory clearing (escape hatch only)

A handoff is an agent-managed document. The user has one optional command to recover from a stale or bad one:

- `#mem clear` — deletes the handoff bound to the active lane and drops the binding (no-op if unbound).

There are **no** commands for adding, editing, or pinning handoffs. Agents own the document through `handoff_set`; the user views the board, resumes with `#resume`, and can clear the active lane's handoff when it gets stale.

#### User-triggered handoff (specs 139, 293)

Cross-session handoff is **user-triggered, not always-on** — an always-on handoff would push proactive memory writes every session (real token cost), so the cost is paid only on an explicit command. A handoff belongs to a work thread, not a lane (ADR-0023):

| Command | Action |
|---|---|
| `#handoff` | inject a one-shot instruction: write/refresh the handoff for this work via `handoff_set` in a resume-ready shape (what's done, current state, next steps, open questions; reference artifacts by path; never write secrets; overwrite, ≤ 8000 chars). Writes the lane's bound handoff, or mints and binds a new one |
| `#resume` | resume the **newest handoff in the project**, local ∪ Xenon (when `[xenon].enabled`), whichever lane, backend, or machine wrote it |
| `#resume list` | open the **handoff picker** overlay over the merged local ∪ Xenon rows (`id · age · host · author · summary`, source `local`/`xenon`); `Enter` resumes the cursor row in this lane, `Esc` closes. See `docs/0307-handoff-picker.md` |
| `#resume <id>` | resume that handoff; a unique prefix of ≥ 4 chars after `ho-` is accepted |

`#resume` resolves the document in Krypton and injects it via `enqueueSystemPrompt()` as possibly-stale data (verify files/branches/commits before acting), so every backend can resume — no MCP tool needed. The lane then **adopts** the handoff (`handoff_bind`), so its next `#handoff` continues the same thread. `#new` / `#new!` / `#restart` / lane close unbind. Remote Xenon copies are never written to the local store (ADR-0022); Xenon unreachable or `missing_scope` falls back to local with a system line naming the reason. No handoff anywhere → chip `no handoff to resume`.

Both commands guard with a `flashChip` no-op when memory is unavailable (`harnessMemoryId` unset) or the lane is mid-work (`busy` / `needs_permission` / `starting` → `#cancel first`); they **are** allowed while `awaiting_peer`, matching the soft-awaiting model (spec 116). No always-on stub line, no per-turn cost. See `docs/0139-default-memory-handoff.md` and `docs/0293-global-handoff-resume.md`.

#### Global lane lessons (spec 298)

Lessons are short behavioural rules that lanes write when they are corrected. Unlike handoffs, they are **global**: one store at `~/.config/krypton/lessons/` (one `<slug>.md` per lesson, `retired/` for retired ones, and a generated `INDEX.md`) is shared by every lane of every backend in every project. ADR-0024 records the decision.

- **Write.** `lesson_record { slug, title, rule, why, how_to_apply, source }` upserts a lesson by slug. `lesson_retire { slug, reason }` moves one to `retired/`. Rust writes the files, so lane sandboxes never have to write outside the project.
- **Limits.** At most 30 active lessons. A `rule` is one line of ≤ 240 chars. From 24 active (spec 299) a `lesson_record` create returns a `notice` telling the lane to consolidate on that same turn — merge near-duplicates by re-recording on the covering slug, retire what the human contradicted; an update never carries one. At 30 a new slug is refused, and the refusal lists every active lesson (`slug (updated) title`, newest first) so the lane merges against the live store. Create-vs-update is decided by the parsed set, so a slug whose file does not parse is a create and faces the cap. A rule a human edited past 240 chars still counts toward the cap but is held out of the injected policy — never truncated — and `INDEX.md` names it under **Oversized rules** with its length.
- **Read.** The lane policy (spec 289) carries a `Lessons (…)` block with one `- [slug] rule` line per lesson, newest first. Every lane gets it, including Pi and lanes without the hook server, which can read lessons but not write them. Because a lesson change alters the policy hash, each lane gets the new set on its next turn.
- **Visibility.** The app keeps one cache, refreshed by `list_lessons` at harness start and on `acp-lessons-changed`. When a lane writes a lesson, its transcript shows `[lesson] <action>: <slug> — <title> (N/30)` — the count comes from the event, so pressure is visible without opening `INDEX.md` — and a chip flashes.
- **Nudges.** Lanes record only at correction points:
  - a redirect envelope gets a lesson_record sentence appended;
  - a `review_outcome` result with blockers carries a `notice`;
  - the `#review pass` fix prompt ends with the same sentence.
  Acknowledge (`a`) sends no nudge.

| Command | Action |
|---|---|
| `#lesson [hint]` | inject `lessonDistillPrompt`: scan the session for corrections, update or record lessons that hold in any project, retire ones the session proved wrong. Needs no project dir; refused while the lane is busy or when lessons are disabled |
| `#lessons` | refresh, then open `INDEX.md` in the Markdown Viewer (palette: **Open Lessons**). Unavailable in a remote Harness |

`[acp_harness] lessons = false` removes the policy block, hides both tools from `tools/list`, drops the nudges, and disables `#lesson`. Lesson files on disk are left untouched. There is no filesystem watcher: hand edits apply on the next refresh.

### Injection

Every prompt is prefixed with a short **lane-context stub** containing the active lane label and the lane roster. Handoff bodies are **not** injected and the stub no longer names memory tools (spec 165); a handoff reaches a lane only through `#resume`. See `docs/0098-acp-harness-memory-on-demand.md` for the on-demand rationale.

Prompt block construction:

```ts
function buildPromptBlocks(userText: string, lane: HarnessLane): ContentBlock[] {
  const stub = renderPromptMemoryPacket(lane);
  const userBlock: ContentBlock = { type: 'text', text: userText };
  if (!stub) return [userBlock];
  if (laneSupportsEmbeddedContext(lane)) {
    return [
      {
        type: 'resource',
        resource: {
          uri: 'krypton://acp-harness/lane-context.md',
          mimeType: 'text/markdown',
          text: stub,
        },
      },
      userBlock,
    ];
  }
  return [
    { type: 'text', text: stub },
    userBlock,
  ];
}
```

### Data Flow

```
1. User opens ACP Harness from command palette or compositor shortcut.
2. Compositor resolves projectDir through getFocusedCwd().
3. AcpHarnessView attempts `create_harness_memory(projectDir)`. Failure records a memory warning and leaves MCP server descriptors empty; it does not abort harness startup.
4. AcpHarnessView calls AcpClient.listBackends(), then spawns the default roster with that same projectDir.
5. Each lane registers its own client.onEvent() callback and initializes independently.
6. User selects an active tab (default is lane 1) and types a prompt, a hash command, or resolves a permission.
7. For a normal prompt, harness builds the lane-context stub (identity + roster + MCP-tools nudge when memory exists, or a memory-unavailable note when it does not) and prepends it via embedded resource or text block. Memory bodies are not injected; agents fetch them via `memory_list` / `memory_get` only when MCP memory is available (Spec 98).
8. Harness dispatches the prompt to the active tab's lane only. While the turn is running, the composer chip shows `m:ss[ · N queued]` and updates once per second (spec 221: the lane name and the generic `running` verb are not repeated here — the lane head and the spinner one row below already say them). Cancel is `Ctrl+C` / `#cancel` (workspace footer `#cancel running` when the harness is focused); the lane head does not paint a cancel chip. A busy peeked lane shows a flat tool row; there is no rail action HUD (spec 231 removed). **If the active lane is busy or in `needs_permission`, the prompt is enqueued** into a per-lane FIFO `queuedPrompts` (text + frozen image snapshot + mention targets, capped at 10) instead of being discarded; one item drains on each idle transition (spec 136). The queue renders in a bottom-anchored right-rail slot (numbered rows, `▸` next marker, `→lane`/`img×N` tags) and is managed with `#unqueue [N]` / `#queue clear` / `#queue edit N`. Peer mail drained on idle takes precedence (the queue shows `held behind lane mail` until idle). When the lane transitions busy→idle with a non-empty draft **and an empty queue**, the chip flashes `lane idle — Enter to send`; dispatch remains manual.
9. While the turn streams: each lane renders stream/tool/plan/usage updates into its dashboard transcript. Completed `edit` calls and completed diff-bearing `write_like` tool updates update `fileTouchMap[path] = {laneId, laneDisplayName, toolKind, at}` (overwriting older entries). Memory tool calls trigger a memory-board refresh.
10. When the turn returns, pending permissions and turn-scoped accept/reject-all flags clear. Cancelled turns do not modify memory unless the agent already called MCP memory tools before cancellation.
11. Permission requests for built-in harness memory/peer MCP tools are auto-allowed and update a structured permission card with `auto-allowed` plus the matched rule (`matched harness memory auto-allow rule` or `matched harness peer auto-allow rule`) without entering permission mode. Other permission requests move that lane to `needs_permission` and pre-empt that tab's composer with the options banner. The lane transcript holds the request detail and a cross-lane warning when `fileTouchMap[path]` exists from a different lane within the last 10 minutes. The user must switch to that tab to read context, then resolve via `a/A/r/R/Esc`. `A`/`R` apply only for the current `session/prompt` turn; both flags clear when that turn returns.
12. `Ctrl+C` (or `#cancel`) in the composer cancels the active lane only **and clears its prompt queue**. `#new` starts a fresh active-lane session after awaiting old-client disposal and unbinds the lane from its handoff; `#new!` also deletes the handoff bound to the active lane when memory is available; `#mem clear` deletes that handoff without replacing the session. `#unqueue [N]` removes the last (or 1-indexed) queued prompt; `#queue clear` empties the queue without cancelling the running turn; `#queue edit N` pops item N back into the composer to edit and re-send (spec 136). `#handoff` injects a one-shot instruction so the active lane writes the handoff for its work via `handoff_set`; `#resume` / `#resume <id>` resolve the newest (or named) project handoff from local ∪ Xenon, inject it, and bind the lane to it, and `#resume list` opens the handoff picker overlay over the same merged rows so `Enter` resumes the row under the cursor — user-triggered cross-session handoff, no always-on cost (specs 139, 293, 307). `#draw <request>` injects a one-shot tldraw Offline workflow: the lane uses its existing tools and permission policy to discover the running app, read its version-matched `/readme`, pick the target document (the focused one, or a named one via the docs-listing filter — the substring filter must resolve to exactly one match or the lane stops to disambiguate), inspect it through the local agent API, then edit it along one of two branches — static content batches through `/api/doc/:id/exec`; durable or interactive behavior (clickable UI, animation loops, custom shapes) goes through the app's document-script workspace (`script-workspace` → read the matching `api.recipes` entry → edit only app-declared `editable` script files, extending any existing script → success only when `script-status` reports `state: "applied"`) — and finally verifies records plus a screenshot. If a loopback request fails while `server.json` exists, the prompt requires a listener check and a permitted-path retry before the lane may report the app as not running — a sandboxed lane must not mistake its own network restriction for a dead app (issue #11). The command adds no MCP tool or lane state; Krypton never stores the app token, and the packed `.tldraw` archive plus `appOwned` files stay untouchable — the app's watcher alone embeds script edits into the document (specs 196/197).
12a. `#lesson [hint]` injects a one-shot instruction to distill this session's corrections into global lessons with `lesson_record` / `lesson_retire`. `#lessons` opens the generated `~/.config/krypton/lessons/INDEX.md` in the Markdown Viewer. Every write emits `acp-lessons-changed`, so every open Harness refreshes its lesson cache and each lane's next policy send carries the new set (spec 298).
13. Pasted, dropped, and global screen-captured images stage in the active lane composer (up to 4 images, 5 MB each). Each staged image renders as a compact placeholder chip with thumbnail, filename/type label, and an `x` remove button; `Esc` still clears all staged images. Pasted and dropped images are saved under Krypton's temp image directory; global captures reuse the `capture_screen` file path. On submit they are sent as embedded ACP image content blocks with base64 data plus a `file://` URI to the saved path alongside the draft text. The submitted user transcript row keeps the chat text and shows the images as a thumbnail strip (13a); the base64 is decoded once into Blob URLs and never kept as `data:` strings in the transcript.
13a. **Inline images (spec 281)** — sent images render as thumbnails in the user row (not a `▧ N images` chip). Agent `image` blocks, image `resource` blobs, tool-result images (Claude `Read`), and local image paths the lane touches (tool `locations`/`resource_link`, paths scanned from tool input/output, reply text, and prompt text — e.g. `curl -o /tmp/issue-42.png`) render as a thumbnail strip under the owning row. Paths load through `read_image_file` (magic-byte-sniffed in Rust, 10 MiB cap), so `/tmp` works; scanned paths that are missing or not images vanish silently. A path shows once per turn. Each lane keeps ≤ 64 MiB of live image bytes (oldest released first). `f` hint mode includes images; a label opens the image viewer (`n`/`p` step, `=`/`-` zoom, `0` fit, `1` 100%, `hjkl` pan, `o` open in the OS app, `Esc` close). Remote runtimes show byte images only.
13b. **Subagent cards (spec 282)** — a tool call that spawns subagents (OMP `task`: `rawInput.tasks[]` + `rawOutput.details.progress/results/async`; Claude `Task`/`Agent`: `_meta.claudeCode.toolName`; Codex `spawnAgent`: `_meta.codex.collaboration`) renders as an `agents` card. Each agent gets one live row: status glyph, name, type, current activity, the last 3 tools, tool count, tokens, and duration. The head shows `N/M done` (plus `background` while an OMP background spawn runs). Claude subagent tool calls and text tagged `_meta.claudeCode.parentToolUseId` fold into their Task card instead of becoming top-level rows. Each agent row is an `f` hint target (and is clickable) that toggles its inline TASK / OUTPUT detail.
13c. **SVG fence cards (spec 283)** — once an assistant row seals, each valid ` ```svg ` fence becomes a card with an `svg` toolbar (`Source`/`Preview`, `Copy`) over an `<img src="data:image/svg+xml,…">` preview. It is never inline SVG DOM, so scripts and external fetches stay inert. While the row streams, the fence draws in progressively, element by element (Revision 2): at most every 200ms, the source so far is cut at its last complete tag, open elements are auto-closed (`closeSvgPrefix`), and a decoded frame paints into a non-interactive `--live` card before the fence. The live card is removed before the seal capture. Before encoding, `var(--fg|muted|border|accent|success|warning|error|surface|c1…c6)` resolve to the active theme (OMP's palette names), and the root gets default `xmlns`, `color`, `fill`, and `font-family`. WebKit blocks user-installed fonts inside an `<img>` SVG, so the `svg_font_faces` command subsets the user-installed families of that stack to the figure's characters, and they are embedded as `@font-face` data URLs (Revision 3; mermaid cards too). Theme switches re-theme rendered cards in place. Invalid or oversized fences stay code. The cache (`markdownHtml`) stays pure markdown and decoration runs on every render. Clicking the preview, or its `f` hint `<label>`, zooms the SVG in the spec 281 image viewer (fit fills the stage, `=`/`-` zoom stays sharp, `s` closes and shows Source); on a card already showing Source the plain `<label>` returns to Preview, and `Shift+<label>` copies the original source. Every lane's per-turn preamble carries one `SVG figures:` line that advertises the feature and the palette.
13c′. **Mermaid fence cards (spec 294)** — a ` ```mermaid ` fence is the same card. The lazily loaded `mermaid` library renders it in the main document (`securityLevel: 'strict'`, `htmlLabels: false`, Krypton palette as `themeVariables`; `%%{init}%%` cannot change theme, `themeCSS`, or font), and the SVG string goes into the card `<img>`. Renders are queued one at a time and cached (LRU 64) by theme + source, so a row rebuilt from `markdownHtml` paints synchronously; a miss shows `mermaid · rendering…` and patches only the card when it settles. A parse error shows the source under `mermaid · error`. While streaming, a fence draws once it closes. Labels read `mermaid · <type>`; `f` zoom/copy/Source match SVG cards. The lane policy carries one `MERMAID_FENCE_GUIDANCE` line after the SVG line.
13d. **Inline HTML visuals (spec 292, draft only)** — this proposed ` ```visual ` fence and sandboxed `srcdoc` iframe are not implemented. Today a `visual` fence remains code. Full-page HTML still uses `artifact_new` (spec 133 / ADR-0002). See spec 308 for the separate, data-only generative UI design.
13e. **Generative UI cards (specs 308/309/310/312)** — an ordinary reply streams each ` ```krypton-ui ` fence as a one-line strip (`interactive UI · receiving spec · N lines`); at seal the fence compiles through the bounded expression language and becomes a static title/summary card. An explicit `#ui <request>` stages its assistant reply before transcript and SSE publication, validates it with the same compiler, and asks the same lane to repair invalid output at most twice. A valid final reply is painted as a completed row and its card expands without taking focus or scrolling; after two failed repairs, one diagnostic and the bounded source are shown. A card click or transcript `f` hint seats the view's single panel in that card's slot. Its renderers are kernel components, so moving one input repaints only dependent nodes and the sealed row never repaints. A control can only load a visible draft into the owning lane's empty composer — it cannot send a message, run a tool, read a file, or reach the network; the user's later Enter sends the draft through normal routing. `#ui` guidance is one-shot; the standing lane policy remains unchanged. Fences outside `#ui` retain the seal-time compiler error and source fallback. A `version 1` JSON fence is no longer accepted. No executable agent HTML, Rust IPC, or ACP protocol addition is involved.
13f. **GenUI component gallery (spec 313)** — `#ui-gallery` opens `/genui-gallery` in the OS browser without starting an agent turn. The page is an index rail of every shipped GenUI component plus one component per view (fragment-routed): its fixed example through the production compiler and renderer, its parameters, source, reset, and local input state. The preview is painted from the app's own resolved theme and `[font]` (fetched from `/genui-gallery/theme.json`), on a reproduction of the Krypton window, so a component looks exactly as it does in a lane. Draft and OpenUrl actions only show demo feedback. The command palette provides the same open action as `genui-gallery.open`.
14. Closing the tab disposes every client and drops all in-memory UI state (transcripts, file-touch map, pending permissions, staged images). **Memory documents are persisted to disk per project directory when memory was available.** See `docs/0076-acp-harness-memory-persistence.md`.
```

### UI Changes

The harness has two surfaces stacked vertically:

1. **Dashboard** (top, read-only) — renders all activity for every lane. No input is accepted on this surface.
2. **Command Center** (bottom, input-only) — tab strip + composer. One tab per lane. The active tab determines which lane is expanded on the dashboard and which lane will receive the next prompt.

The **memory drawer** is an overlay (`Ctrl+M`) that covers the dashboard. The command center stays visible and reachable while the drawer is open.

The **help overlay** is toggled with `Esc`, then `?`. It covers the dashboard, keeps the command center visible, and lists lane control, permission, memory, transcript, and hash-command keys. It closes with `Esc`, `?`, or `q`.

There is no global permission queue strip, no broadcast/target mode, no marked-mode, no lane fullscreen mode. Each of those surfaces was removed because the dashboard/command-center split makes them redundant or unsafe.

DOM shape:

```html
<div class="acp-harness">
  <div class="acp-harness__topbar">
    <span class="acp-harness__title">ACP HARNESS</span>
    <span class="acp-harness__cwd">~/project</span>
    <span class="acp-harness__counts">2 idle · 1 busy · 1 perm</span>
  </div>
  <div class="acp-harness__dashboard">
    <div class="acp-harness__lane acp-harness__lane--collapsed">
      <header class="acp-harness__lane-head">[1] ● Codex-1 …</header>
    </div>
    <div class="acp-harness__lane acp-harness__lane--collapsed">
      <header class="acp-harness__lane-head">[2] ○ Claude-1 …</header>
    </div>
    <section class="acp-harness__lane acp-harness__lane--active">
      <header class="acp-harness__lane-head">[3] ● OpenCode-1 zai-coding-plan/glm-5.1 …</header>
      <div class="acp-harness__lane-body"><!-- scrollable transcript --></div>
    </section>
    <div class="acp-harness__lane acp-harness__lane--collapsed acp-harness__lane--permission">
      <header class="acp-harness__lane-head">[4] ! Droid-1 perm: write src/…</header>
    </div>
  </div>
  <aside class="acp-harness__memory-overlay" hidden>
    <header class="acp-harness__memory-head">Memory · 3 entries</header>
    <section class="acp-harness__memory-panel"><!-- entry list with cursor row --></section>
  </aside>
  <div class="acp-harness__command-center">
    <nav class="acp-harness__tab-strip">
      <button class="acp-harness__tab acp-harness__tab--active">[1] Codex-1</button>
      <button class="acp-harness__tab">[2] Claude-1</button>
      <button class="acp-harness__tab">[3] OpenCode-1</button>
      <button class="acp-harness__tab acp-harness__tab--permission">[!4] Droid-1</button>
    </nav>
    <div class="acp-harness__composer">
      <div class="acp-harness__composer-chrome">
        <div class="acp-harness__composer-meta">
          <span class="acp-harness__memory-chip">memory: 3/21</span>
          <span class="acp-harness__project-status"><svg class="acp-harness__icon"><use href="#krypton-icon-branch"/></svg><span class="acp-harness__project-branch">main</span></span>
        </div>
        <div class="acp-harness__composer-tools">
          <span class="acp-harness__help-hint">? help</span>
          <button class="acp-harness__dictation" type="button">MIC</button>
        </div>
      </div>
      <span class="acp-harness__prompt">›</span>
      <span class="acp-harness__input"></span>
    </div>
  </div>
</div>
```

Topbar:

```text
ACP HARNESS  ~/krypton   2 idle · 1 busy · 1 perm
```

- CWD is abbreviated.
- Idle/busy/permission/error counts are visible.
- No target mode chip (no broadcast). No memory mode chip (memory has no modes).
- Token/cost details stay in lane transcripts, not the topbar.

#### Dashboard

- Lanes are listed top to bottom in spawn order.
- Lane positions are **stable**. Switching the active tab changes which lane expands; the order and positions of all other lanes do not move.
- **Collapsed lane row** is exactly one line:

  ```text
  [N] <symbol> <Name> <status> [metadata-chips] <activity-or-status>
  ```

  Status symbols:

  ```text
  · starting
  ○ idle
  ● busy
  ! permission
  × error
  ```

  Metadata chips (model, mode, MCP, safety, metrics) render as a compact flowing group and do not reserve space when absent. Pi lanes show `⚠ unsandboxed`; Junie lanes show `⚠ permissions unverified` until their ACP write-permission behavior is manually verified. OMP lanes use the normal permission rail and do not show a warning chip in v1. The optional model chip is rendered only when Krypton can determine the active lane model. Resolution order: (1) `acp_harness.lane_models.<backend>.active` from `krypton.toml` if set; (2) model fields advertised by the agent in `agent_capabilities`; (3) the session's agent-reported current model id (`models.currentModelId` or the `configOptions` model select's `currentValue`). Unknown models are hidden, not shown as `unknown`. See `docs/0006-configuration.md` for the per-backend `lane_models` schema. The `<activity-or-status>` slot is the latest tool/assistant activity by default (`editing src/acp/client.ts`, `reading src/layout.ts`, `running cargo test`, `thinking…`, or the most recent assistant text truncated to ~40 chars). When status is `needs_permission` or `error`, the slot is replaced by the blocking detail (`perm: write src/styles/acp.css`, `error: spawn failed`).

  Color rules:

  - `needs_permission` → warning/gold.
  - `error` → error/red.
  - `busy` → active accent.
  - `idle` / `starting` → muted.

  Status uses symbol + text + color together; never color alone.

- The **active lane** fills the remaining viewport. Its body is internally scrollable. Collapsed rows above and below the active lane stay anchored.
- The active lane's stats row shows the latest complete turn's prompt-cache hit rate as `cache N%` when the adapter reports a coherent input/cache tuple. The tooltip keeps read, write, and uncached-input counts. If input or cache-read is absent, the row keeps the raw read/write counters instead of inventing a percentage. `#usage` reports the day as a structured transcript card: cache hit + proportional input/cache composition, visible raw input/output/read/write metrics, per-model rows, and explicit cost/delivery notices. At narrow widths the four metrics become `2 × 2`, model rows stack their stats, and the cache bar moves below its percentage; recording-off and empty-day results remain plain sentences. The equivalent text summary remains on the transcript item for Live Assist and generic projections. `#daily` adds the same rate to each lane row.
- The active lane body shows the full per-lane transcript: user prompts, assistant text, thoughts, tool calls and summaries, plan updates, permission requests and resolutions, usage snapshots, and system rows. Tool rows show diff/output preview inline as monospace text. Kind chips reuse the spec 231 HUD accents (chip text + 1px border, not a filled pill). Dump body is foreground phosphor, not cyan; stdout/output/content/text drop the body text-shadow. Dump and inline-diff payload use the same `--krypton-font-size` as conversation text; kind chips, section labels, and timers stay chrome-scale. The group container has no background glow and no left rail (spec 235). Execute-tool output can render structured summaries for recognized command output: unified `git diff` output becomes compact file/hunk/add/delete rows, `git diff --stat` becomes per-file mini bars, and `git status --short` becomes status badges plus paths. A leading `exit: N` (Grok Bash `output_for_prompt`, or structured `exit_code`) peels off the dump and paints a quiet exit readout on the first OUTPUT/TERMINAL label — muted tabular number for 0, danger color for non-zero, no kind-chip frame — instead of a raw `exit: 0` line. Git-rich dumps (no section label) keep the readout as its own row. Grep/rg dumps (search kind, or execute wrapping `rg`/`grep`/`ag`/`ack`) split into path / line / text tokens when a majority of lines match, with optional hit spans from a quoted query. Line numbers right-align in a shared ≥4ch gutter so mixed digit counts and mixed path lengths stay in columns. Grok search wraps hits in a `<workspace_result>` envelope and groups them as a path header plus `line:text` rows; that envelope is stripped even when the line cap drops the close tag, so a miss is `No matches found`, not XML tags. Grok `read_file` line anchors (`1→`, `10→`) are stripped on read dumps. Grok `rawOutput.type` variants (`ReadFile`, `GrepSearch`, `ListDir`, `Bash`, `MCP`, …) are unpacked from their structured fields before that strip (spec 235); unknown types keep the generic key walker. Unknown output keeps the generic labeled text sections. Git-stat paths and unidiff file headers use the warning token, not cyan. Short provider/API failures that arrive as assistant text are classified when the stream seals and rewritten into `provider_error` cards with a headline, hint, retryability chip, and collapsed raw details; raw provider diagnostics are not markdown-rendered. Long assistant text truncates at ~12 lines with a `[…]` expand affordance. **Agent-emitted markdown images** (`![alt](path)`) are displayed inline: agents that generate images write files to disk and reference them by absolute filesystem path (e.g. Grok's `image_gen` → `~/.grok/sessions/<enc-dir>/<id>/images/N.jpg`), which the webview origin cannot fetch directly, so `resolveLocalImageSrcs()` rewrites local `<img src>` to a Tauri asset URL via `convertFileSrc()` at every markdown→DOM site (assetProtocol scope `$HOME/**`); a leading `/` is a true absolute path, relative paths resolve against the lane project dir, and remote/`data:`/already-resolved schemes pass through untouched. A failed load swaps in an `IMG BREACH // <path>` notice and the image is capped to the column width. The transcript scrolls within the lane body.
- **Execution Inspector (specs 315/319)** — validated current OMP Python/JavaScript code cells replace the generic source dump with one compact execution card per `toolCallId`: language, clean title, state, timing provenance, latest reported activity and `Inspector`. Transcript `f` hints or a click open one view-owned **modal dialog** (spec 319) over the Harness body: a head (language, title, `Close · Esc`), a summary (Status, Time with `runtime`/`observed` provenance, Exit code, Job), Code / Output / Activity tabs with counts, one scrolling section, and a key-hint foot. The dialog owns the keyboard while open: `1`–`3` select a section (`←`/`→` on a focused tab), `j`/`k` and `g`/`G` scroll it, `c` copies the retained source, `r` toggles Formatted/Raw when table/JSON views exist, `Tab` stays inside the dialog, and `Esc` or a scrim click closes it and returns focus to the composer; Cmd/Ctrl chords pass through, so native copy of selected output works. The section chosen last is kept for the next open. Only source is language-highlighted; ordinary tool dumps keep spec 235. Table/JSON views come from validated backend metadata, never parsed stdout. Output text laid out by character columns (an ASCII frame or table around Thai, box drawing) sits on the spec 324 cell grid, so its borders stay aligned. Streaming updates preserve retained selection/scroll; terminal/replayed state never invents timing or progress, and detached state is only a last-reported snapshot. Generic tools, redaction, subagent cards, diffs and images keep their existing renderers. The dialog follows Harness font/theme tokens, never writes transcript-row DOM, stays open when its row leaves the mounted tail window, and closes without taking focus on lane switch/reset/restart, hidden tab, another overlay opening, or the item leaving the lane transcript.
- **Thought rows** render dimmed at their full natural height. They have no per-message height clamp or inner scrollbar; the lane transcript owns scrolling, so both streaming and sealed reasoning remain fully visible in the conversation. A 5-bar effort meter under the `thought` label remains as a log-scaled depth cue. Repeated and leading/trailing blank lines in the thought body (Codex `\n\n` section breaks) are dropped on display without removing message text. **Veiled thinking:** providers that keep reasoning server-side (Claude Code on current Opus models) stream `thought_chunk`s whose text is empty — the model is thinking but no content ever reaches the client. While such a row streams, the body shows an animated placeholder (`thinking` + pulsing dots, opacity-only animation) instead of an empty block, and the effort meter is suppressed; if the row still has zero text when the stream seals (or the turn errors), it is dropped from the transcript entirely.
- **System rows.** A plain `sys` row is prose the user reads, so its body keeps the conversation's `--krypton-font-size` — the same size as user and assistant text. Only the card-shaped kinds shrink to `0.88em` (`tool`, `plan`, `memory`, `restart`, `permission`, `shell`), plus the three `sys` variants that set their own smaller size: `usage` (`0.88em`), harness `event` (`0.86em`), and the hidden-rows indicator (`0.78em`).
- A **contextual lane peek** can appear in the active lane transcript region for one non-active lane. It is a non-blocking, hideable top-right summary, not a global overview: it shows only the automatically selected lane's name, status, reason, and at most one compact payload (permission, peer, error, or recent activity). Selection prioritizes direct peer relations from the active lane, related permissions, non-active errors/permissions/inbox, then recent meaningful activity. Direct peer candidates (priority ≤30) clear a prior user dismiss before selection runs. `Esc` hides the peek only when no permission banner owns `Esc`; command palette actions can show/hide, cycle, unlock, or activate the peeked lane. No placeholder is shown when no non-active lane qualifies. Spec 216 adds a **sibling thought slot** (own card, same 320px column) under the peek. Hide / `Esc` dismiss the peek only. The thought slot shows the peeked lane’s thought when that card is up and has content, otherwise the active lane’s thought, and hides when neither has content. Spec 232 paints live thought as a catch-up teletype (caret + phosphor settle, no scan, no brackets); sealed thought stays GFM. **Lane-pair activity heat** (slice 109) adds a compact strip above the peek stat chips: active vs peeked bars for the selected metric/window, optional expanded rows (tools / tokens / peer / CPU), and palette actions to cycle metric (`auto`, tools, tokens, peer, process, alerts), cycle window (`30s`, `5m`, `session`), and toggle detail; click targets mirror palette behavior. Heat samples reuse the harness metrics poll and throttled transcript/usage snapshots (no extra timer). See `docs/0109-acp-contextual-lane-peek.md`.
- **Peer activity (zen rail + composer)** — in Zen Mode, each left-rail lane row shows compact peer glyphs (`⇆` outstanding send, `▼N` inbox depth, `←`/`→` recent peer traffic). The active composer may show an informational peer strip above the input (`#cancel drops pending peer wait`); it does not block typing while `awaiting_peer` (spec 116). See `docs/0118-acp-peer-activity-ui.md`.
- **Rail entry anatomy (spec 125)** — each left-rail row is `dot · logo · head · meta`. The status dot (col 1) carries lane status; the backend logo (col 2, an inline-SVG monogram tinted per `backendId`) carries the adapter identity; the head row carries the lane display name plus peer/tool/ctx chips; and the meta row carries a role tag chip plus the directive title with the backend-label prefix stripped (presentation-only — storage and `peer_list` keep the full title). The role tag is derived from `directive.task` via keyword matching (`analysis` / `review` / `impl` / `plan` / `explore`); unmatched non-empty values display the raw lowercased `task` and pick a stable hash-bucket color; empty `task` displays the literal `custom`. Pending-clear adds an `--clearing` modifier to the tag (line-through, dashed border, dimmed). Unbound lanes render dot + logo + name + status-label meta with no tag. See `docs/0125-lane-rail-disambiguation.md`.
- **Merged active tab (spec 325)** — in Zen the active rail entry is a tab painted in the active lane body's colour (`--acp-lane-canvas`). It is rounded on the rail side, runs flush into the body, and joins it through two concave fillets with no seam. The rail paints nothing itself while it has an active entry: the tab's `::before` shadow paints the rail colour around it. Inactive entries are 8px-rounded rows inset from both rail edges, and keep their directive, pending and permission tints. The active tab carries no tint and no row pulse; its dot still pulses. In Zen the active lane's head and stats bands lose their tint, so the body is one surface. Lane switches are instant. See `docs/0325-harness-zen-rail-merged-tab.md`.
- Permission requests appear inline in the transcript at the time they arrive as dense cards:

  ```text
  peer  peer_send  Claude-1                         auto-allowed
  matched harness peer auto-allow rule
  to_lane: Claude-1 · message: …
  ```

  The card shows tool family, tool name, subject/path, decision state, a one-line argument preview, and any auto-allow reason. The `also touched by …` line is rendered only when `fileTouchMap[path]` exists from a different lane within the last 10 minutes. Otherwise the line is omitted. After the user resolves the request from the composer, the same row updates in place to `✓ accepted`, `✓ accepted (auto-turn)` (when triggered by `A`), `✗ rejected`, or `✗ rejected (auto-turn)` (when triggered by `R`), and stays in transcript history. The harness does not append a second string-only resolution row.

- **Assistant response references (spec 206)** — a sealed assistant row gets a flat `REFERENCES` rail when it contains typed ACP `resource_link`/embedded-resource chunks or explicit Markdown anchors. Structured ACP metadata wins over Markdown labels; targets are normalized, deduplicated in first-appearance order, and capped at 32. No prose, inline code, commands, or code fences are guessed. File locations accept `path:line[:column]` and `path#Lline[:column]`; relative paths resolve lexically against the harness project directory. File actions open a new Helix tab, while HTTP(S)/mailto actions use the OS handler. Inline local/file anchors stay inert—the rail is their explicit action surface. See `docs/0206-assistant-response-resources.md`.
- **Reference thumbnails (spec 286)** — each REFERENCES row leads with a 48×34 thumbnail. An image file reference shows the image itself, reusing the object URL spec 281 already loaded on that row or on an earlier row of the lane (no second read). Other files show an extension glyph (`TS`, `MD`, `TOML`, …) and URLs show a globe. Opening an image reference with pixels opens the image viewer (`VIEW ↗`) instead of Helix, and that image no longer repeats in the row's image strip. See `docs/0286-harness-reference-thumbnails.md`.
- **Transcript annotations (spec 240)** — select a span in an assistant reply, press `c`, type a note, Enter **adds** it to a local batch (highlight + notes rail; the lane is not contacted). Repeat, then `s` (transcript focus) or the rail **send N** control ships every unsent note to the **same lane** as one system turn (JSON `{ quote, heading, note }` framed as user data). Idle drain uses `TranscriptAnnotationQueue` immediately after the peer-mail coordinator. Unsent notes do not persist across restart. See `docs/0240-harness-transcript-annotation.md`.
- **Programmatic reference Git state (spec 207)** — changed file references gain a compact `M/A/D/R/?/!` badge and `+added −removed` summary computed by Rust from the current local working tree against `HEAD`; the assistant supplies only the normalized file target and cannot supply or override the displayed counts. Binary files show `BIN`, unavailable bounded counts show `N/A`, and clean/out-of-repository files retain the normal reference row. Refresh is event-driven at message seal, successful writes, and lane idle transitions; bare `r` in transcript command mode refreshes immediately. See `docs/0207-assistant-reference-git-state.md`.
- **HTML artifact cards and unified open hints (specs 133/206)** — a `kind: 'artifact'` transcript row (label `html`) is raised when a lane registers an HTML artifact via `artifact_register`. The card shows the artifact title, byte size, and short content hash. In **command mode** (transcript focus), pressing `f` enters a unified open-hint mode: response references, live artifacts, and follow-up buttons (spec 323, labelled after the row's other targets) in the active lane receive single/double-character labels in transcript order; pressing a label dispatches the matching file, URL, artifact, or follow-up action, while `Esc` cancels. Keys are intercepted only while hint mode is active. A swept/cancelled artifact's card reports `unavailable`. Both the artifact-path **write/edit tool-observation card and the permission card's argument preview are redacted to path + bytes + hash** (never the diff/content/args) for pending and registered-live paths, so the HTML never enters the transcript model under the file-write tool — the real spec-103 fix. Redaction matches the registry *or* the raw `.krypton/artifacts/` scratch-path pattern, so a card that renders before the registry's pending event arrives still never shows the HTML (the event/registry race). Auto-approval, by contrast, stays strictly registry-keyed and write-kind-gated (a read/exec that merely names the path is never granted; an absolute target must equal the issued path exactly, not just share its tail). Lanes must write artifacts with file-write APIs, not shell heredocs (a lane that insists on shell can still leak its own command text). See `docs/0133-harness-html-artifacts.md`.
- **Follow-up actions (specs 323, 327)** — when the `follow-up` assist task is on (`#assist follow-up auto`; default off), a finished reply can gain a `FOLLOW-UP` rail of up to three buttons under it (`FollowUpRail`, block `acp-harness__followups`): a button with the terminal-prompt icon (`krypton-icon-follow-up-run`) runs a shell command from the reply in a new `ACP // <label>` terminal tab in the project directory, one with the box-arrow icon (`krypton-icon-follow-up-open`) opens an http(s) URL in the OS browser, and one with the speech-bubble icon (`krypton-icon-follow-up-prompt`, spec 327) sends a prompt to the lane — queued if the lane is busy — while its `paste` button (or `Shift`+hint) inserts the prompt into the composer instead. Run and open targets are extracted by Krypton from the reply's shell fences, multi-word code spans, and URLs — a one-word span such as a commit hash or path is never a command; the cheap model only picks and labels them. A prompt is written by the model for a step the reply offered that continues from the finished work (never an offer to redo, split or revert it), shown in full, and never starts with `#`, `!`, `/` or `@`. Click or `f` hint runs a button; the reply body never repaints. Skipped on remote harnesses. See `docs/0323-harness-follow-up-actions.md` and `docs/0327-harness-follow-up-prompts.md`.
- **Text diagrams on a cell grid (spec 324)** — a fenced code block in an assistant reply that is laid out by character columns is laid out on character cells (`cell-grid.ts`, block `acp-cellgrid`). That covers blocks with box-drawing (U+2500–U+257F) or block-element (U+2580–U+259F) characters, and blocks where non-ASCII text is padded with two or more spaces to line up what follows (ASCII `+--+`/`|` frames and tables around Thai). Every grapheme takes its terminal width in cells, and box characters are drawn by CSS in their cell instead of by a fallback font. Borders line up with their rows and vertical lines join, whatever `[font] family` lacks. Cell size is `ch`/`lh` rounded to device pixels in CSS, so font, size and display-scale changes reflow without repainting. The grid is built while the reply streams, so sealing changes nothing; selection, copy and annotations see the original characters. Other code blocks are untouched. See `docs/0324-harness-cell-grid-box-drawing.md`. Spec 326 puts every other output block on the same grid: tool sections (stdout, stderr, …), grep rows, every `DiffBlock` (tool diffs, FS write review, directive diff, GenUI `Diff`), subagent detail, `!shell` output, the provider-error payload, inter-lane mail, the cold peek thought, GenUI `Code` and Live Assist replies. A gridded block does not wrap; it scrolls sideways. The tool card cuts lines over 140 cells (not code units) at 139 cells plus `…`. Prose rows (thought, user, question, system text) keep wrapping. See `docs/0326-cell-grid-for-all-output.md`.
- When a non-active lane reaches `needs_permission`, its collapsed row becomes a pulsing gold-tinted **action required** surface; Zen mode gives the matching rail entry the same tinted treatment. Reduced-motion users get the persistent high-contrast state without the pulse. Errors keep their distinct error indicator. The dashboard does not auto-scroll or auto-switch the active lane, so permission context and resolution remain local to the blocked lane.

#### Command Center

- The command center is **input-only**. It does not render transcripts or activity.
- Tab strip lists one tab per lane in spawn order. Each tab shows `[N]` and the lane's display name. Tab badges:
  - The active tab is visually emphasized (active accent border/background).
  - `!N` prefix on tabs whose lane has a pending permission (warning color).
  - `×N` prefix on tabs whose lane is errored (error color).
  - `●N` (subtle) when busy, optional; status is primarily on the dashboard row.
- **Per-tab draft preservation**: each lane's tab keeps its own composer draft. Switching tabs swaps the visible composer to that tab's draft; nothing is lost. Drafts are tab-local only and are dropped when the harness closes.
- **Direct-insertion feedback**: printable keys, `Shift+Enter`, plain-text paste, and `Ctrl+Y` keep the draft and existing inline caret fully immediate, then spawn overlay copies of the inserted graphemes as a cyan phosphor afterimage that ignites, drifts upward 3px, and dissolves (spec 252). Fast typing stacks a fading trail of letters — not an expanding ellipse; a paste flashes at most `composer_bloom_trail` visible graphemes (default 5) over `composer_bloom_ms` (default 320). The effect never replaces Krypton's cursor and does not run for Backspace/Delete, navigation, programmatic rewrites, dictation, lane switches, or status refreshes. System Reduce Motion or `composer_bloom = false` removes it. See `docs/0252-harness-composer-soft-bloom.md`.
- **Text cursor**: an underline drawn by CSS (`components/caret/caret.css`), never a typed glyph. `.acp-harness__caret` is a zero-width span whose `::after` bar (one `ch` wide, `max(2px, 0.1em)` tall) overlays the cell to its right, so the character under the cursor stays readable and the draft keeps the character grid it has with no cursor at all. A block cursor failed on both counts: `█` (U+2588) is missing from `Share Tech Mono` and fell back ~1.15 cells wide, and because it consumed a cell it split the word it sat in — with the spec-285 ghost, `pend` + cursor + ghost `ing` read as two fragments one cell apart instead of one `pending`. Same shape for the dictation preview, the ticket picker filter, the triage redirect line (window accent) and the orchestrator console.
- **Word autocomplete** (spec 285): when the cursor sits at a line end right after a word, the composer shows the predicted rest of that word as dim ghost text after the caret (`.acp-harness__ghost`). `Tab` accepts it and adds a space; `→` accepts it with no space. Typing the ghost's next letters shrinks it without flicker. It is hidden while a palette, dictation, or transcript focus owns the keys. Predictions come from one n-gram model in a Web Worker (`word-predict-worker.ts`) segmented with `Intl.Segmenter`, so Thai works. The model is trained on a shared history that **every lane** feeds: each composer submit, whatever the backend, goes into `~/.config/krypton/harness-prompt-history.db` (SQLite, `0600`, deduped with `use_count`, capped at 20,000 rows). It is also seeded read-only from `~/.claude/history.jsonl`, `~/.codex/history.jsonl`, and `~/.omp/agent/history.db`. Prompts starting with `/`, `#`, or `!` and pastes over 8 KB are not logged. `[acp_harness] word_autocomplete = false` hides the ghost; logging continues.
- **Dictation**: when the host webview exposes the Web Speech API, the composer status row shows a `MIC` button in `.acp-harness__composer-tools` (right of the meta chips, not on the input line — the window footer's magnified KR/GR marks overflow upward over that corner). `Cmd+D` (or the button) starts English (`en-US`) recognition; `Cmd+Shift+D` starts Thai (`th-TH`). Final text uses the normal composer colour, interim text is dimmed and underlined, and the status advances through `MIC EN`/`MIC TH`, `● REC EN`/`● REC TH`, and `FINALIZING…`. Stopping inserts the recognized text at the saved cursor but does not send it; the user reviews it and presses `Enter` separately. `Esc` restores the exact saved draft/cursor. Lane switch/close, Harness disposal, permission/question pre-emption, and focus leaving the Harness abort capture so no hidden microphone session survives. Unsupported webviews omit the button and report `dictation unavailable in this webview` for either chord. Krypton does not retain or attach audio, but the user-agent recognition service may process it remotely. See `docs/0246-harness-dictation.md`.
- **Memory chip** (`memory: 3/3`) sits above the composer line. Counts show up to 10 displayed lane summaries over total lane summaries. During an active turn it changes to the elapsed clock `m:ss` with a subtle lane-accent pulse so long silent agent runs still show liveness. The busy form is built from segments rather than one string (spec 221); the lane name is **not** repeated here — the lane head carries it for the active lane in every layout, including Zen Mode. Nor is a generic `running` verb: the spinner on the input line, the accented chip and the ticking clock are the busy cue. Cancel is `Ctrl+C` / `#cancel` (workspace footer `#cancel running`); there is no lane-head chip. A **named** operation still leads the chip (`reviewing · 0:41 · …` for a custom command such as `#review`), and `running` survives only as a fallback for the frame before the clock and activity exist.
- **Git branch** sits on the same composer-meta row: the `krypton-icon-branch` symbol — the same geometry the workspace footer draws (`src/chrome-icons.ts`) — followed by the bare ref (`feat/…`). It is a symbol, not a prefix character: `⎇` (U+2387) is in none of Krypton's shipped fonts, so it fell back to a system font and drew ~1.85 text cells wide, nothing like the footer's icon. The ref is probed at harness open (and again once `projectDir` resolves) and re-probed when a tool ends, a lane goes idle, or the user presses `r` in transcript command mode. A later `git switch` no longer leaves the previous ref on the chip; later probes keep the last label until the new one arrives so the row does not flash empty. Under a 480px container the whole segment hides — the workspace footer prints the branch as soon as the window is focused.
- The composer has no target chip, no broadcast warning border, and no marked-mode indicator. The active tab is always the destination.
- The composer is a flush command line (`border-radius: 0`), not an 8px container card. The host window chrome (frame, titlebar, footer) keeps the theme 8px bevel — the prompt is inside the pane, above the footer, so squaring the window does not change the prompt and only removes the manufactured corner from the tile. The add-lane picker is a floating overlay: one `.acp-harness__picker-panel` with the theme 8px bevel (not two independently rounded boxes).

Composer text mode:

- Multi-line input.
- `Enter` sends to the active tab's lane.
- `Shift+Enter` inserts a newline.
- Composer auto-grows up to 6 lines, then scrolls internally.
- If the active lane is busy or in `needs_permission`, `Enter` **enqueues** the prompt (FIFO `queuedPrompts`, cap 10) and flashes `queued (N)`; it drains one item per idle transition (spec 136). Managed via `#unqueue [N]` / `#queue clear` / `#queue edit N`.
- **Steering (spec 278):** when the busy lane's adapter advertises `_session/steering` (claude-agent-acp, codex-acp), `Enter` sends the prompt **into the running turn** instead (row label `steer…` → `steer`, chip `steered`). `Cmd+Enter` always queues. A steer that misses (turn already over, unsteerable turn, adapter error) moves to the head of the queue. `@mention` prompts and the orchestrator console always queue. See `docs/0278-acp-harness-steering.md`.
- While the active lane is busy, the composer chip updates every second with elapsed runtime. The timer clears when the turn stops, errors, or the lane is restarted.
- **Activity ticker (spec 156 / 231)**: the live action is no longer a composer segment, and the spec 231 rail action HUD is gone. `lane.activity` is still written as a field on the hot path. A busy peeked lane paints a flat `tool` row on the 109 card (and drops the activity event row that would restate it). The composer busy chip keeps verb / elapsed / queued only. See `docs/0156-lane-activity-ticker.md` and `docs/0231-lane-peek-action-hud.md`.
- **Idle flash**: when the active lane transitions `busy → idle` and the composer holds a non-empty draft **and the prompt queue is empty**, the chip flashes `lane idle — Enter to send` for 2 seconds, then returns to the memory chip. The prompt is **not** auto-dispatched; the user must press Enter. (When the queue is non-empty the flash is suppressed — a queued prompt is about to drain the lane back to busy.) An optional sound cue (single soft tick from the existing sound engine) plays in parallel; this can be disabled in config.
- `Esc` with non-empty input does not discard text. Behavior:
  1. If the memory drawer is open, `Esc` closes the drawer.
  2. Else, `Esc` moves focus to the active lane's transcript scroll view (allows `j/k` to scroll). Composer text remains; pressing any character returns focus to the composer.
- `Ctrl+C` cancels the active tab's lane (when busy). `#cancel` is the equivalent command.

Composer permission mode (pre-empt):

When the active tab's lane has a pending permission, the composer pre-empts text input and renders a minimal options banner:

```text
! permission required — see lane
  a accept           A accept-all-from-this-lane
  r reject           R reject-all-from-this-lane
  Esc never answers — it only flashes this hint
```

- The banner does **not** include path, diff, or size. That detail (and the cross-lane file-touch warning, when applicable) lives in the active lane's transcript on the dashboard. The user is expected to read context there before responding.
- Built-in harness MCP permissions do not show this banner. The harness automatically chooses the first allow option for the built-in tools — memory (`memory_set`, `memory_get`, `memory_list`), peer (`peer_send`, `peer_list`), attention (`attention_flag`, `attention_resolve`), and review (`review_outcome`) — then updates the original permission card to `auto-allowed` with a visible harness-rule reason. (Attention is default-on per spec 130; `review_outcome` is default-on per spec 146; auto-allow also preserves their non-blocking contract.)
- Contextual lane peek is controlled through command palette actions: `ACP: Show Lane Peek`, `ACP: Hide Lane Peek`, `ACP: Peek Next Lane`, `ACP: Peek Previous Lane`, `ACP: Activate Peeked Lane`, `ACP: Unlock Lane Peek`, plus heat controls when a peek is visible: `ACP: Cycle Peek Heat Metric`, `ACP: Cycle Peek Heat Window`, and `ACP: Toggle Peek Heat Detail`.
- `A` and `R` are **turn-scoped** for non-memory permissions: they apply only to subsequent permission requests in the current `session/prompt` turn, and both `acceptAllForTurn` / `rejectAllForTurn` flags clear automatically when the turn returns. There is no harness-wide or session-wide "always accept" for filesystem, process, or other non-memory tools. Each new turn starts with `a/r` only.
- Any draft text the user had typed before the request arrived is preserved and re-displayed when the composer returns to text mode.
- If multiple permission requests are queued for the same lane, the composer stays in pre-empt mode and walks them in order; the lane transcript shows each request card and its in-place decision update. When `acceptAllForTurn` (or `rejectAllForTurn`) is set, the harness resolves subsequent requests automatically without re-displaying the banner; each auto-resolution still updates its permission card.
- If a permission request arrives for a non-active tab, only that tab's composer enters pre-empt mode internally. The currently active tab's composer is unaffected. The tab strip shows `!N` to draw the user to switch.
- Switching to a tab whose composer is in permission mode immediately shows the banner; switching back to a text-mode tab restores its draft.
- There is no "approve permission from another tab" shortcut for prompted permissions. Resolving a non-memory permission requires switching to its tab. This is an intentional safety property.

Permission option mapping:

- `a` selects the first option whose `kind === 'allow_once'`. If absent, select the first option whose `kind === 'allow_always'`. If neither exists, show chip `no accept option`.
- `A` sets `acceptAllForTurn = true` and resolves the current request with the first `allow_once` option. If `allow_once` is absent, use `allow_always`; the flag is still cleared at turn end and is not treated as a standing grant by Krypton. If no allow option exists, show chip `no accept option`.
- `r` selects the first option whose `kind === 'reject_once'`. If absent, select the first option whose `kind === 'reject_always'`. If neither exists, call `respondPermission(requestId, null)`.
- `R` sets `rejectAllForTurn = true` and resolves the current request with the first `reject_once` option. If `reject_once` is absent, use `reject_always`; if no reject option exists, call `respondPermission(requestId, null)`.
- `Esc` never resolves a request (permission or file-write review). It flashes the `a accept · r reject` hint instead, because a stray Esc — leaving the composer or closing a popup — used to reject a write the user meant to accept (user report, 2026-10-08). Rejecting always takes `r`/`R`.
- `a`/`A`/`r`/`R` answer a pending permission or file-write review in **both** composer and transcript (command) focus. Transcript focus otherwise owns printable keys (`r` refreshes reference Git state, the rest are swallowed), so before this rule an `Esc` into command focus followed by a permission request left the banner advertising keys that did nothing (user report, 2026-10-08). While a request is pending, transcript `r` is shadowed by reject; `j`/`k`/`g`/`G` still scroll the request context.
- The banner keeps the `perm` / `ask` label visible: the base `.acp-harness__composer-meta` is an inline-size container, which sized the non-growing label to 0 px and clipped it, so the permission rule opts out with `container-type: normal`.
- When `acceptAllForTurn` or `rejectAllForTurn` auto-resolves a later request, use the same option lookup against that later request's own `PermissionOption[]`; if the required option is missing, fall back as above and append the actual option label to the transcript resolution row.
- After a permission key is accepted, the harness immediately appends the resolution row and returns the lane to `busy` before awaiting the ACP permission-response IPC. If that IPC fails, the same permission is restored and the composer re-enters permission mode so the user can retry.

Hash-command autocomplete:

- Typing `#` opens an autocomplete popup above the composer.
- The popup is bounded to the lower half of the Harness. Long result sets scroll inside the popup, keeping both the selected row and composer input visible above the workspace footer.
- `Tab`/`Enter` accepts the selected command; `Esc` dismisses (does not clear text).
- Available commands:

  ```text
  #cancel     cancel the active tab's lane (= Ctrl+C)
  #new        start a fresh active lane session, preserving memory
  #new!       start a fresh active lane session and clear that lane's memory
  #restart    respawn the active tab's lane (only when status = error or stopped)
  #mem        show memory command hint
  #mem clear  clear active lane memory only
  #mcp        print MCP endpoint/status for harness lanes
  #panels     hide or restore Harness panels, all or one by name
  #timeline   browse, trace or check conflicts in agent-managed history; set automatic recording
  ```

  Memory documents are agent-managed through MCP. Human memory mutation is limited to `#mem clear`, which clears the active lane's persisted memory document. Bare `#mem` is a hint only.

- `#panels [hide | show | toggle]` controls one per-project presentation flag (bare `#panels` toggles). Hidden mode removes the active-lane auxiliary rail (plan, lane peek, live thought, grammar review, and prompt queue), the Active Ticket dock, and the Zen lane-navigation rail while preserving their state. The lane header/stats, transcript, composer, inline permissions/questions/write reviews, and explicitly summoned modal tools remain available. Transcript thought rows are content rather than panel chrome; combine with Concise Mode when those should also disappear. See `docs/0251-harness-panel-visibility-command.md`.
- `#panels [hide | show | toggle] <panel>` (spec 320) sets one panel's own flag — `plan`, `peek`, `thought`, `grammar`, `queue`, or `ticket`; bare `#panels <panel>` toggles it. The flags persist per project (`krypton:acp-harness:hidden-panels:<projectDir>`) beneath the master switch: neither level rewrites the other, and a panel shows only when both allow it. A hidden panel leaves the rail (or, for the ticket dock, gives back its reserved width) and its state is kept; a hidden grammar panel ignores `Cmd+G` and `Cmd+0`. The same toggles appear as icons in the hosting window's titlebar — six panels, a divider, then `all` (= bare `#panels`); while `all` is off the six are disabled, and a titlebar narrower than 480px keeps only `all` (plus the backend-update button below). See `docs/0320-harness-titlebar-panel-toggles.md`.
- **Backend update button (spec 322).** Once per launch Krypton checks whether Grok (`grok update --check --json`) or OMP (`omp --version` vs npm `@oh-my-pi/pi-coding-agent`) is behind. While either is, a local Harness appends a warning-coloured download button after `all` (divider before it; tooltip `Backend updates: OMP 18.12.6 → 18.13.0`), and the Harness palette offers `Update ACP Backends (…)`. Either opens an `ACP // update` terminal tab that runs `grok update` / `omp update`, then waits for Enter; when that tab's process exits the check runs again and the button disappears once nothing is behind. Claude and Codex never appear: they spawn as `npx -y <adapter>@latest`. Remote Harness views show no button. See `docs/0322-acp-backend-update-check.md`.

- `#timeline` opens read-only local history in the OS browser. `j`/`k` selects, `Space` toggles context, `i` toggles audit provenance, `Enter` opens the source, and `r` reverses chronology. Topic shorthand/open prefilters history; trace sends a read-only evidence-tracing prompt. Final grammar is `#timeline [open [topic] | trace topic | conflicts [topic] | auto [on|off] | topic]`. Add/review/merge commands and aliases, capture forms and pending badge are removed; unrelated `Start Review` remains. Gitignored schema-1 events live under `.krypton/timeline/events/`, with no automatic publication.
- The working local non-Pi MCP-capable lane selects durable evidence-backed requirements, decisions and consequential outcomes itself through `timeline_record`, without current-human persistence instructions or an item-per-turn cap. Required fields are `topic_title`, `summary`, `made_by`, `evidence_kind` (`user_statement`, `observed_outcome`, `agent_decision`) and `evidence_excerpt`; optional fields are `topic_id`, `occurred_at`, `rationale`, `impact`, `source_ref`, `relation`, `related_event`. `instruction_excerpt` has no alias. Recorder is Agent plus transport lane; `agent_decision` uses the lane as `made_by`. Agent prose is Thai; exact evidence/actors/sources stay verbatim, without secrets or raw dumps. Old human/authorizing provenance remains readable.
- Before recording, the lane reads `timeline_list`: default topic digests or `topic_id` events accept `query`/`limit` (default 20/max 50), exclusive `event_id` returns full evidence/rationale/provenance. Stable topic IDs are reused across titles/languages, retries deduplicate, and normal recording never implicitly promotes pending candidates. Results report event ID/topic ID/path/disposition plus conflict continuation. See specs [262](0262-agent-timeline-topic-discovery.md) and [316](0316-llm-managed-timeline.md).
- Legacy pending files are internal backlog. Exclusive `timeline_list({pending:true})` returns candidates, `remaining_pending`, diagnostics and truncation (default 5/max 20), without event/topic/query modes. During ordinary writable work the lane evaluates all candidates through `timeline_pending_resolve({pending_id,outcome,rationale,record?,event_id?})`: record requires nested evidence-first record data; duplicate requires canonical event_id; discard has neither. It continues until none remain without a per-turn/five-topic migration cap. Idempotent `resolutions/<pending_id>.json` receipts preserve original_candidate verbatim, outcome, lane/time/reason and event reference; pending removal follows event/receipt persistence. Malformed files remain diagnosed and counted. No new pending API exists.
- `#timeline auto [on|off]` controls default-on `automaticRecording` through `timeline_settings` / `timeline_set_enabled`. Settings schema 1 automaticSuggestions migrates atomically to schema 2 preserving false; events stay schema 1. Off blocks new recording, not legacy resolution. `timeline_pending_count` and `acp-timeline-changed` (harnessId/pendingCount) update nonvisual ordinary-turn policy state, never a badge or extra model turn. Read-only work including trace defers all mutations. Remote/Pi lanes without project-backed tools do not mutate local storage. Rollout requires the rebuilt host and normally reconnected MCP session; fixtures do not establish that the real queue migrated.
- `#timeline conflicts [<topic>]` delegates incremental review to the lane (spec 267): `timeline_conflict_list` identifies unchecked events/open pairs, `timeline_conflict_record` stores lane-attributed confirmed/resolved/insufficient_evidence/dismissed verdicts with rationale, and `timeline_conflict_checked` checkpoints comparisons. Post-record continuation uses the same tools. Confirmed means a conflict exists, not which business decision is true; insufficient evidence is recorded without asking the human to choose. Sourced policy changes use supersedes without rewriting history. Browser time-cell markers, related-event links, `p` pair navigation, event deep links and `h` superseded visibility remain read-only. See specs [266](0266-timeline-decision-trace-and-conflicts.md) and [267](0267-timeline-conflicts-by-agent.md).
- `timeline_merge` repairs grouping with from/into or undo:true plus required rationale; transport supplies acting lane. Ambiguous/unknown/same-topic selectors are refused, records are backed up under `.krypton/timeline/backups/<merge-id>/`, and only topic_id changes. Merge/undo manifests retain lane/reason without human quotes or permission gates. TypeSafe topic choice and unused transport/configuration/footer/Profiler metrics are retired, with no hidden semantic service.

- `#new` refuses while the lane is busy, awaiting permission, or still starting; use `#cancel` first. `#new!` also refuses if harness memory is unavailable so it does not silently behave like non-destructive `#new`.

#### Memory drawer overlay

- Toggled with `Ctrl+M`. Closes with `Esc` or `Ctrl+M`.
- Overlays the dashboard. The command center stays visible for lane context, but the composer input line is hidden and ordinary typing is captured by the drawer until it closes. Run commands such as `#mem clear` after closing the drawer.
- Single list view — no tabs. Rows are sorted newest-first by handoff `updatedAt`.
- The drawer maintains a **cursor row** moved with `Ctrl+N`/`Ctrl+P`, `ArrowUp`/`ArrowDown`, `PageUp`/`PageDown`, or `Home`/`End`; clicking a row selects it. While the drawer is open, these keys are captured before global lane-switch shortcuts so `Ctrl+N`/`Ctrl+P` move memory rows instead of changing lanes. Current human commands do not target individual rows.
- Rows show the project's handoffs newest first as `<id> · <author>@<host> · <age> <summary>`, and the selected row expands to show that handoff's full detail (spec 293).
- The drawer is **read-only display**. Handoffs are written by agents through `handoff_set`; humans can delete only the handoff bound to the active lane with `#mem clear`.
- The drawer never auto-scrolls away from the row the user is reviewing. New entries appended during a review do not move the cursor.

Memory injection preview:

- The memory chip beside the composer (`memory: 3/3`) shows up to 10 displayed summaries over total memory rows. There is no mode segment.
- The drawer is the single audit surface; the prompt packet contains the same lane summaries/details represented by the board.

The memory drawer and the handoff picker are two different surfaces over the same handoffs. The drawer (`Ctrl+M`) is **read-only display** and shows the **local store only** — it never lists Xenon copies and never acts on a row. The handoff picker is opened by `#resume list` (spec 307), lists the **merged local ∪ Xenon** rows with a `source` tag and a detail pane, and is the only surface where `Enter` resumes: it binds the lane to the handoff and dispatches the turn.

Same-project notice:

- The composer meta/status line shows the harness working directory and, when the directory is in a Git repository, the current branch. Detached HEAD state is displayed as `HEAD <sha>`. Non-Git directories show only the cwd.
- When more than one lane is idle or busy in the same `projectDir`, the topbar adds a small `shared cwd` segment. This is informational, never modal, and does not block dispatch. (Per-lane file-touch warnings already cover the actual collision risk during write requests.)

### Keybindings

The default focus is the composer. Almost every key acts on the composer or on overlays opened from it. The dashboard is read-only — its only input is "scroll the active lane's transcript" via the transcript-scroll focus mode.

| Key | Context | Action |
|-----|---------|--------|
| `Leader Y` | Compositor mode | Open ACP Harness. |
| `Ctrl+N` / `Ctrl+P` | Composer text mode (no palette open) | Cycle to next/previous lane tab. |
| `Tab` | Composer text mode, word ghost visible, no palette open | Accept the word-autocomplete suggestion plus a space (no space after Thai/Lao/Khmer/Myanmar/CJK words) (spec 285). |
| `→` | Composer text mode, word ghost visible | Accept the word-autocomplete suggestion with no space (spec 285). |
| `Enter` | Composer text mode | Send prompt to active tab's lane. Busy lane: steer the running turn if the adapter supports `_session/steering`, else queue (spec 278). |
| `Cmd+Enter` | Composer text mode, busy lane | Queue as a follow-up for the next turn (spec 136/278). |
| `Shift+Enter` | Composer text mode | Insert newline. |
| `Cmd+D` / click `MIC` | Composer text mode, speech recognition available | Start English dictation; repeat to stop and keep editable text. |
| `Cmd+Shift+D` | Composer text mode, speech recognition available | Start Thai dictation; repeat to stop and keep editable text. |
| `Enter` | Dictation active | Stop and keep recognized text; do not submit on the same keypress. |
| `Esc` | Dictation active | Abort capture and restore the saved draft/cursor. |
| `Cmd+Shift+L` / `#live [voice]` | Harness focused | Start a live voice session on the active lane, initially muted; repeat shortcut (or `#live stop`) to end it (specs 280, 314). |
| Hold bare `Left Option` | Live voice running in focused Harness | Talk while held; release, blur, document hidden, or focus leaving Harness mutes without ending playback/session. Another key cancels the hold until Left Option is released; Right Option remains unchanged (spec 314). |
| `#` | Composer text mode | Open hash-command autocomplete. |
| `Tab` / `Enter` | Hash autocomplete | Accept selected command. |
| `Esc` | Hash autocomplete | Dismiss popup (text preserved). |
| `?` | Transcript scroll focus | Toggle help overlay. |
| `Esc` / `?` / `q` | Help overlay open | Close help overlay. |
| `Ctrl+C` | Composer text mode, active lane busy | Cancel active lane. |
| `Shift+Tab` | Composer text mode (no palette open) | Cycle the active lane's persistent permission mode `normal` → `acceptEdits` → `bypass` (same order as the Agent view). `acceptEdits` auto-accepts file edits only; `bypass` auto-accepts every request, including high-risk. A non-`normal` mode shows a composer-meta chip (`auto-edit ⇧⇥` / `⚠ bypass ⇧⇥`); Polly/Salty bypass keeps its own chip. The mode survives turns; `kryptonctl acp permission-mode` and Raycast set the same field. |
| `Esc` | Composer text mode | Enter transcript/command focus. Composer is disabled until `i` or `Esc` returns to input. |
| `a` | Permission pending (composer or transcript focus) | Accept the focused permission. |
| `A` | Permission pending (composer or transcript focus) | Accept-all-from-this-lane for the **current `session/prompt` turn only**; clears when the turn returns. |
| `r` | Permission pending (composer or transcript focus) | Reject the focused permission. |
| `R` | Permission pending (composer or transcript focus) | Reject-all-from-this-lane for the **current `session/prompt` turn only**; clears when the turn returns. |
| `Esc` | Composer permission mode | No-op: flashes `a accept · r reject`. Never rejects. |
| `Ctrl+M` / `Cmd+M` | Composer or transcript context | Toggle memory drawer overlay. |
| `Ctrl+N` / `Ctrl+P`, `ArrowDown` / `ArrowUp`, `PageDown` / `PageUp` | Memory drawer open | Move cursor row. |
| `Home` / `End` | Memory drawer open | Jump cursor to top/bottom of list. |
| Click row | Memory drawer open | Select memory row. |
| `Esc` / `Ctrl+M` / `Cmd+M` | Memory drawer open | Close drawer (composer draft preserved). |
| Other text input | Memory drawer open | Ignored; composer draft is unchanged. |
| `j` / `↓` / `Ctrl+N` | Handoff picker open (`#resume list`) | Move cursor to the next row (wraps). |
| `k` / `↑` / `Ctrl+P` | Handoff picker open | Move cursor to the previous row (wraps). |
| `Home` / `End` | Handoff picker open | Jump cursor to the first/last row. |
| `Enter` | Handoff picker open | Resume the cursor row in the lane that opened the picker (bind + inject); refuses with a chip if that lane is gone or busy. |
| `Esc` / `q` | Handoff picker open | Close the picker; composer draft unchanged, no lane touched. |
| `c` | Transcript focus, or composer with an armed selection | Open the annotate overlay on the selection (or the nearest visible block). |
| `Enter` | Annotate overlay | Add the note to the unsent batch (does not dispatch). |
| `s` | Transcript focus | Send every unsent annotation to the active lane as one turn. |
| `d` | Transcript focus | Delete the last unsent annotation. |
| `j` / `k` | Transcript scroll focus | Scroll active lane transcript line by line. |
| `1`–`9` | Transcript scroll focus | Switch to lane tab N without inserting text. |
| `g` / `G` | Transcript scroll focus | Jump to top/bottom of active lane transcript. |
| `Ctrl+u` / `Ctrl+d` | Transcript scroll focus | Page up/down active lane transcript. |
| `i` / `Esc` | Transcript scroll focus | Return to composer input. |
| `q` | Transcript scroll focus | Close harness tab. |
| `Cmd+.` | Any composer/transcript context | Toggle Zen Mode (collapses inactive lanes into a left rail; active lane fills the body). Persisted per project. See `docs/0080-acp-harness-zen-mode.md`. |
| `Cmd+Shift+.` | Any composer/transcript context | Toggle Concise Mode (spec 157). Tool cards collapse to their single head line (glyph + kind + subject + result + live timer; output sections and diff previews hidden); `thought`/`fs_activity`/`memory` rows hide entirely. Interactive rows (`permission`, `fs_write_review`) and everything else stay visible. CSS-only — rows stay in the DOM, streaming continues underneath. Persisted per project; no composer readout — the collapsed cards are the cue (spec 221). Note: the Ctrl+H hidden-row indicator counts transcript rows, so in concise mode N can exceed what visibly appears. See `docs/0157-harness-concise-mode.md`. |
| `Cmd+P → +` | Harness focused | Open lane picker and spawn a fresh backend lane. |
| `Cmd+P → _` | Harness focused | Close and dispose the active lane. |
| `Cmd+P → =` | Harness focused | Toggle lane resource metrics overlay (CPU/RSS tree per lane). See `docs/0091-acp-lane-resource-metrics.md`. |
| `Cmd+P → 0` | Harness focused | Open the active backend's project session picker; resume when `session/resume` is available, otherwise load when `loadSession` is available. |
| `Cmd+P → .` | Harness focused | Open the directive picker (spec 124). `j/k`/arrows move, `Enter` spawns a new lane initialized with the selected directive, `Backspace` clears the focused lane directive, `Esc` cancels. Directives are reusable backend/task-scoped system prompts from `acp-harness.toml`; the active directive injects into the leading context packet and shows as a composer `directive …` chip. Agents can manage directives via `directive_list`/`directive_preview`/`directive_remove`/`directive_apply` MCP tools, with persistent or cross-lane changes gated by an `a`/`r` approval card in the lane transcript. See `docs/0124-acp-harness-directive-management.md`. |
| `Cmd+P → '` | Harness focused | Open the review quality matrix overlay (spec 146) — a read-only, per-lane history of `#review` rounds (round · subject · reviewers · blockers · warnings). `j/k` switch the selected lane when more than one has history, `Esc` closes. Disabled (no-op) until at least one round is recorded. Observation, not a score: raw counts only, no jump-to-transcript, no grade. See `docs/0146-review-quality-matrix.md`. |
| `Ctrl+H` | Any composer/transcript context | Expand the active lane's transcript visible window by 60 rows. When the window reaches the total row count it snaps to "all"; pressing once more wraps back to 60. Older rows are removed from the DOM; a muted indicator row at the top of the transcript shows the hidden count. Per-lane setting, resets on `#new`/`#new!`/`#restart`. See `docs/0103-acp-harness-transcript-window.md`. |

Memory mutations are not bound to dedicated keys; active-lane memory clearing executes through `#mem clear` in the composer. This keeps the keybinding surface narrow and the input rule consistent (input always in the command center).

Removed from earlier drafts:

- `m` / mark-mode, `t` / target cycle, `Ctrl+Shift+C` / cancel-all (broadcast removed).
- `M` / promote transcript item to memory (agents manage memory through MCP).
- `z` / lane fullscreen and `[` / `]` / fullscreen lane switching (no fullscreen mode; the active lane already fills remaining viewport).
- `P` / focus permission queue, `Esc` on permission queue (no global permission queue; permission is per-tab pre-empt).
- `e`, `d`, `a` / `r` on memory rows, `p` / pin, `c` / compact (drawer is read-only; mutations via `#mem`).
- `x` / cycle memory injection mode, `X` / force `agent_select` once (no injection modes in v1).
- `i` / open Selection tab, `h` / `l` / Tab cycling drawer tabs (drawer is single list, no tabs).

The ACP Harness is the only ACP surface; the single-lane ACP agent tab (`Leader A`/`E`/`I`) was removed.

### Configuration

The default roster remains code-defined. Optional `[[acp_harness.remote_profiles]]`
entries provide SSH aliases and absolute remote project paths (spec 247); local
Harness memory persistence remains keyed by project directory. `[acp_harness] lessons`
(default `true`) turns global lane lessons on or off (spec 298).

## Edge Cases

- **One lane fails to spawn:** mark only that lane `error`; its tab gets the `×N` badge; other lanes continue. The user can run `#restart` from that tab to retry.
- **Lane subprocess dies mid-turn (crash, OOM, external SIGKILL, malformed JSON-RPC, error stop reason):** mark the lane `error`, dispose its `AcpClient`, clear turn-local permission/extraction state, and append a transcript row `× session ended unexpectedly: <reason>`. Other lanes are unaffected. The user can run `#restart` to respawn.
- **`#restart` command:** runs only when the active tab's lane status is `error` or `stopped`. The harness calls `AcpClient.spawn(backendId, projectDir)` with the same backend and `cwd` as the original lane (display name is preserved). The lane's `transcript` keeps prior history with a divider `─── session restarted ───` appended; `sessionId`, `pendingPermissions`, `acceptAllForTurn`, and `rejectAllForTurn` are reset; memory entries previously published by this lane stay in the feed (memory is owned by the harness, not the lane). On running lanes (`idle`, `busy`, `needs_permission`), `#restart` is refused with chip `lane <status> — #cancel first`. There is no restart count limit; the user is the rate limiter.
- **`#new` command:** runs only when the active lane is idle, error, or stopped. It awaits disposal of the old ACP client, clears visible lane state and mutable containers, increments the lane spawn epoch, and starts the same backend in the same project directory. Harness memory is preserved.
- **`#new!` command:** performs `#new` only after clearing the active lane's persisted memory document. If memory is unavailable or clearing fails, the fresh session is refused so the destructive suffix never degrades silently.
- **Late events after fresh session:** `AcpClient` drops raw events after `dispose()`, and harness lane callbacks compare both spawn epoch and client identity before mutating state.
- **`#mem clear` during active work:** clears the active lane's memory document immediately. Subsequent prompts only carry the lane-context stub, so the cleared body is gone for any future `memory_get` call. In-flight turns that already fetched memory keep the old snapshot in agent context until that turn ends.
- **User presses Enter while active lane is busy:** show inline composer chip `lane busy`; do not dispatch and do not queue. User must wait for the lane to return to idle (or `Ctrl+C` to cancel). On busy→idle transition with non-empty draft, chip flashes `lane idle — Enter to send` for 2s + optional sound cue; dispatch is still manual.
- **Permission arrives for a non-active tab:** built-in harness memory/peer MCP permissions are auto-allowed in place only when the permission payload identifies Krypton's harness MCP server (including `krypton-harness-memory`, `krypton-harness-bus`, underscored namespace fragments, rendered `Tool: krypton-harness-bus/peer_send` labels, or `/mcp/harness/` endpoint URLs). Other permissions put that tab's composer in permission mode internally; the active tab's composer is unaffected. The dashboard collapsed row and Zen rail entry become pulsing gold-tinted **action required** surfaces. The user must switch to the tab to resolve. There is no cross-tab approve shortcut by design.
- **Multiple permissions on the same lane:** the lane's composer pre-empts and walks them in order; lane transcript shows one card per request and mutates each card with its decision. If `acceptAllForTurn` / `rejectAllForTurn` is set, subsequent requests resolve automatically until the turn returns; each auto-resolution still updates the corresponding card.
- **Multiple permissions across different lanes:** each affected tab independently sits in permission mode. The user resolves them by switching tabs in any order they prefer.
- **Permission arrives while user is mid-typing in that tab:** composer pre-empts; the draft text is preserved and re-displayed when the composer returns to text mode.
- **Permission for a path another lane recently wrote:** banner detail in the lane transcript adds a single `⚠ also touched by Lane-N <duration> ago (write_like|edit)` line, derived from `fileTouchMap` (10-minute window). The composer pre-empt banner stays minimal; user must switch to the lane to read context. This is informational — it does not block accept.
- **Agent publishes low-quality memory:** the user can clear the active lane document with `#mem clear`; otherwise the next agent `memory_set` overwrites that lane's document.
- **Two lanes publish contradictory memory:** both remain visible with source labels. v1 has no canonical conflict resolution; the user can ask a lane to update its memory or clear the active lane document.
- **Agent lacks embedded context support:** inject memory as a leading text block instead of a resource block.
- **User closes harness mid-turn:** dispose every client (existing Rust teardown sends SIGTERM then SIGKILL); drop all in-memory state; nothing written to disk.
- **Backend list lacks a default roster backend:** omit that backend and add a system row to the harness header (e.g. `Codex backend not installed — skipped`). If zero lanes spawn, harness opens with an empty dashboard and a single banner `no ACP backends available`. v1 does not auto-fall-back to a different backend.
- **Same project write conflicts:** v1 does not lock or prevent them. The topbar `shared cwd` segment and per-permission `also touched by …` warnings are the only signals. Users should drive write-heavy work through one lane.
- **Drawer cursor row is on a row that gets removed (cap overflow):** snap the cursor to the nearest surviving row.
- **Image paste/drop/screen capture:** images stage only for the active lane. If the lane has a pending permission prompt, the user must resolve it before staging another image. If the active backend does not advertise image support, the harness shows a warning chip but still sends the image because some ACP adapters under-report capabilities. The visible placeholder chip is transient, individually removable before submit, and clears after submit; the ACP image block still carries a local `file://` URI for adapters that need a filesystem path.
- **Cmd+V text/image paste with multiple Harness windows:** paste applies only to the compositor-focused Harness. Window/pane focus moves DOM focus onto that view (native paste follows `document.activeElement`). A paste that still lands on a background Harness is ignored there and retargeted to the focused view's composer. Overlay text fields (pickers, dialogs) keep native paste.
- **Speech recognition unavailable or denied:** the normal text composer remains usable. Unsupported runtimes omit `MIC`; permission, device, service, and network errors preserve the original draft unless recognized text already exists, in which case the latest text is committed for review but never sent.
- **Dictation lifecycle changes:** `Esc`, active-lane switch/close, a permission or question taking the composer, focus leaving the Harness, and Harness disposal invalidate callbacks before aborting recognition. Late results therefore cannot alter another lane or revive a closed view.

## Open Questions

None. The v1 implementation choices that were previously ambiguous are fixed here: use `Leader Y` for opening the harness, normalize tool observation to Krypton's current ACP `ToolKind` union, map permission keys through `PermissionOption.kind`, and either wire the two optional config keys fully or keep them hard-coded until a follow-up config PR.

Assumptions for v1:

- "Same project" means every ACP subprocess receives the same `cwd`, not separate git worktrees.
- "Shared memory" means visible Krypton-owned memory injected into prompts, not direct agent-to-agent messaging and not provider-private memory files.
- "Shared memory" is loaded into a tab-local harness store at runtime and persisted per project directory. Closing the harness drops transcripts and in-RAM lane state, but saved memory is restored next time the same project opens.

## Remote execution target (spec 247)

`Leader Shift+S` opens a keyboard-first target picker. A detected focused SSH
session appears first, followed by `[[acp_harness.remote_profiles]]`. Detection
uses structured process metadata and passive OSC 7 CWD only; the Harness never
drives the existing interactive shell. If no passive CWD exists, the picker asks
for an absolute remote project path.

The resulting Harness owns one immutable SSH workspace for all lanes. Its header
shows the profile or resolved `user@host:port`, remote path, and connection state.
On first connection Krypton installs the matching helper automatically under the
remote user's versioned cache, using a bundled binary when possible and a
SHA-256-verified release asset otherwise. No manual `krypton-remote` install is
required; only the selected agent CLI and its authentication must already exist.
When the stream drops, Enter on the disconnected header (or “Reconnect Remote
Harness” in the contextual command palette) starts a fresh companion and resumes
saved agent sessions without replaying an in-flight prompt.

Remote mode currently supports ACP lane lifecycle, permissions, remote fs
callbacks, project MCP discovery/overlays, tunneled in-memory Harness MCP, Git
branch, and explicit diff opens. Local editor/file views, images, project-backed
tickets/docs/artifacts, daily notes, usage persistence, Hurl and Xenon are visibly
unavailable rather than accidentally operating on a same-looking local path.

## Connected Computers from local lanes (spec 311)

Every local Harness lane can list app-connected SSH targets and request one
command against an explicit target without moving its project or agent process.
Backends with in-process MCP descriptors receive `computer_list` and
`computer_exec` on their per-lane built-in Harness server. Pi, Cursor, Junie
and Cline receive the staged `kryptonctl` path and use `computer list --json`
or `computer exec <id> -- <command>` through a shell tool. Their native MCP
config files do not contain the lane capability.
The lane capability is private, bound to its ACP process session and revoked
when that session ends. Remote Harness lanes do not receive it.

The built-in tool route may pass the adapter's permission check. A command that
passes Krypton's read-only classifier (spec 318) on a computer whose
`auto_approve_read_only` setting is on (default) runs immediately: it appears
only as the lane's own `computer_exec` / shell tool row, with no `⚠ remote`.
Any other `computer_exec` waits for a Krypton decision carrying the exact SSH
target, remote directory and command. It renders as a permission row in the requesting
lane's own transcript — same chrome, same `a`/`r` keys as a tool permission, no
modal dialog — and the lane shows `⚠ remote` until it is answered. The queue
behind that row is separate from `pendingPermissions` on purpose: permission
mode, `A`/`R` for the turn, a Telegram turn and the Polly/Salty roles all drain
tool permissions automatically, and none of them may open an SSH session. One
keystroke answers one command; an unanswered request expires in 120 seconds and
never runs. A command finishing with a nonzero exit reports that exit code. A
timeout, disconnect or lane cancellation reports an unknown remote outcome and
is never retried automatically. The detailed contract is in
`docs/0311-connected-computer-commands.md`.

## Out of Scope

- **Broadcast or multi-target prompts.** Each prompt has exactly one destination: the active tab's lane. No `selected/all_idle/marked` modes, no marked lanes, no `synchronize-panes`-style fan-out.
- **Voice conversation and spoken replies.** Dictation produces editable composer text only; it does not auto-submit, read agent replies aloud, listen continuously, or guarantee on-device recognition.
- **User-authored memory entries through the harness UI.** No `#mem add`, no manual notes, no manual decisions. Agents update memory through MCP tools.
- **`#pullmem` or any user-triggered extraction.** The harness does not infer memory from transcripts or tools.
- **Inline-secret detection in memory documents.** v1 does not scan summaries/details for AWS keys, API tokens, JWTs, or similar patterns. Agents should avoid writing secrets to shared memory.
- **Configurable memory persistence.** Memory persistence is always enabled for project-scoped harness memory.
- **Memory center / derived summary.** No second layer above the entry list. Selection at dispatch time is the only "view" of memory.
- **Memory kinds / decision tier.** Lane memory is a summary/detail document, not a typed entry stream with decision states.
- **Memory injection modes.** No `auto` / `agent_select` / `pinned_only` / `manual` / `off` switching. The lane-context stub is always sent before the user prompt; memory bodies are always pulled on demand by the agent via MCP (Spec 98).
- **`agent_select` preflight.** No two-step prompt that asks the LLM to choose memory IDs.
- **Compaction.** No fold-into-summary, no `#mem compact`, no stale rules. Each lane owns one summary/detail document.
- **Conflict / pending-decision flows.** No `pending_decision`, `conflict`, or `resolution_proposal` states. No `#mem approve` / `#mem reject`. Conflicts are resolved by asking agents to update memory or clearing a lane document.
- **`#mem confirm` and pending destructive ops.** `#mem clear` and `#new!` are immediate; the explicit command text is the confirmation.
- **Inline editing of memory entries.** No `#mem edit` in v1. Wrong text → ask the lane to update its memory or clear it.
- **Cross-lane file lock or write coordination.** `fileTouchMap` is informational only; the harness never blocks a permission based on another lane's recent writes.
- **Standing per-lane permission grants.** `A`/`R` are scoped to the current `session/prompt` turn. There is no harness-wide or session-lifetime auto-accept.
- **Lane fullscreen mode.** The active lane already fills the dashboard's remaining viewport with internal scroll.
- **Cross-tab permission resolution for non-memory tools.** Resolving a prompted permission requires switching to its tab; this is intentional so context is read before approval.
- **Global permission queue strip.** Permission is per-tab pre-empt; tab strip badges and dashboard row colors carry the urgency signal.
- **Per-lane focus on the dashboard.** The dashboard is read-only; lane "focus" is implicit through the active tab.
- Git worktree creation, branch management, or merge orchestration.
- ACP `session/close`, manual resume by pasted session id, session delete/archive/fork, or Krypton-side transcript persistence.
- Writing to `CLAUDE.md`, `AGENTS.md`, provider auto-memory folders, or other agent-native memory stores.
- Custom `_krypton/*` ACP extension methods for memory.
- Mid-turn memory retrieval by the agent.
- MCP/tool exposure of the harness memory board.
- Configurable harness rosters in `krypton.toml`.
- Auto-delegation or LLM-based task routing inside Krypton.
- Sharing raw transcripts between ACP lanes.
- Running multiple prompt turns concurrently within a single ACP session.

## Resources

- [Agent Client Protocol overview](https://agentclientprotocol.com/protocol/overview) — confirmed JSON-RPC lifecycle, `session/prompt`, `session/update`, permission requests, and cancellation behavior.
- [Agent Client Protocol schema](https://agentclientprotocol.com/protocol/schema) — confirmed initialize capabilities, cancellation semantics, session list/close capabilities, and `_meta` extensibility.
- [Agent Client Protocol content](https://agentclientprotocol.com/protocol/content) — confirmed embedded resource content blocks as the preferred way to include contextual resources in prompts.
- [Agent Client Protocol extensibility](https://agentclientprotocol.com/protocol/extensibility) — confirmed `_meta` and custom `_` methods exist, but adapter support is optional.
- [OpenCode ACP support](https://opencode.ai/docs/acp/) — confirmed `opencode acp` as the stdio ACP subprocess command; Krypton's built-in OpenCode lane applies a configured model through the `configOptions` model select after `session/new`.
- [Zed external agents](https://zed.dev/docs/ai/external-agents) — prior art for UI-hosted ACP subprocesses, custom agent configuration, built-in Claude/Codex/Gemini/OpenCode support, and ACP debugging.
- [Claude Code power-user tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips) — prior art for running multiple coding sessions in parallel and the trade-off of worktree isolation.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) — prior art for separate contexts, background subagents, and agent management UI.
- [Claude Code memory](https://code.claude.com/docs/en/memory) — prior art for visible project memory and auto memory loaded as session context.
- [tmux synchronize panes](https://tmuxai.dev/tmux-synchronize-panes/) — prior art for broadcast input, visible sync state, and the risk model of sending one command to many panes.
