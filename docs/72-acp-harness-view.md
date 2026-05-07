# ACP Harness View — Implementation Spec

> Status: Implemented
> Date: 2026-05-01
> Milestone: M8 — Polish

## Problem

Krypton can open multiple ACP agent tabs, but controlling several agents for the same project is manual: prompts, cancels, status checks, and permission prompts are spread across separate tabs. Users also need these agents to coordinate without directly chatting with each other: one ACP instance should be able to publish findings, decisions, and blockers into a shared project memory that later prompt turns for other instances can read.

## Solution

Add an `AcpHarnessView` content view that owns multiple `AcpClient` instances, all spawned with the same `projectDir`. The view splits into two surfaces:

1. **Dashboard** (top, read-only) — lists every lane and renders all activity: status, transcripts, tool calls, permission requests, errors. No input is accepted here.
2. **Command Center** (bottom, input-only) — a tab strip with one tab per lane plus a composer for the active tab. The active tab determines which lane is expanded on the dashboard and which lane will receive the next prompt.

One prompt has exactly one destination lane: the active tab. There is no broadcast, multi-target dispatch, marked-mode, or "all idle" target. The harness owns a tab-local memory board, but memory lifecycle now belongs to ACP agents through a lane-scoped HTTP MCP server on Krypton's existing localhost hook server. The human observes the current board and can expand details, but cannot create, update, delete, pin, restore, or audit memories. Each prompt injects short guidance and the latest 10 summaries; full details are pulled explicitly by agents with `memory_get`. Permission requests pre-empt the affected tab's composer with a minimal options banner (`a/A/r/R/Esc`); the request detail (operation, path, size, diff preview, and any cross-lane file-touch warnings) lives in the lane transcript on the dashboard. `A`/`R` ("accept/reject all") are scoped to the current `session/prompt` turn only and clear automatically when the turn returns.

Memory details are specified in `docs/73-acp-harness-mcp-memory.md`. Older heuristic memory extraction from tool observations and `MEMORY:` response footers is no longer part of the harness memory flow.

## Research

- ACP is already a process-per-session model in Krypton: `AcpRegistry` keys clients by `krypton_session`, emits `acp-event-<session>`, and `AcpClient` wraps one backend subprocess. This supports multiple simultaneous agents without backend protocol changes.
- The ACP protocol defines `session/prompt` as one outstanding prompt turn that streams `session/update` notifications and ends when `session/prompt` returns a stop reason. Harness dispatch must therefore skip or queue busy lanes instead of sending concurrent prompts to one ACP session.
- ACP `session/cancel` is a notification; agents may still send final updates before returning `cancelled`. Harness lanes must stay visible until the stop event, not immediately mark cancelled on keypress.
- ACP content blocks include embedded resources for prompt context when an agent advertises `promptCapabilities.embeddedContext`. For agents that do not advertise it, the memory snapshot can still be injected as a leading text block.
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
| `src/acp/index.ts` | Export `AcpHarnessView`. |
| `src/styles/acp-harness.css` | New harness-specific BEM CSS using existing ACP/agent theme variables. |
| `src/styles/index.css` | Import `acp-harness.css`. |
| `src/types.ts` | Add `'acp_harness'` to `PaneContentType`. |
| `src/compositor.ts` | Add `openAcpHarnessView()` using `getFocusedCwd()`, create a content tab, wire close callbacks. |
| `src/command-palette.ts` | Add "Open ACP Harness" action. |
| `src/input-router.ts` | Add a compositor-mode shortcut for the harness. |
| `src/which-key.ts` | Add the shortcut label. |
| `src-tauri/src/commands.rs` / `src-tauri/src/hook_server.rs` | Create/list/dispose per-project harness memory and clear one lane's persisted memory document. |
| `docs/PROGRESS.md`, `docs/04-architecture.md`, `docs/05-data-flow.md` | Document the harness lifecycle, memory flow, and command surface. |

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

interface HarnessTranscriptItem {
  id: string;
  kind: 'system' | 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'permission' | 'restart' | 'memory' | 'shell';
  text: string;
  status?: string;
  diff?: { title: string; unified: string };
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

Default roster: **none.** The harness boots empty (`lanes = []`) and the user spawns lanes on demand via the lane-picker leader key (`Cmd+P → +`). Backend display names are mapped through `BACKEND_LABELS` (`codex` → "Codex", `claude` → "Claude", `gemini` → "Gemini", `opencode` → "OpenCode", `pi-acp` → "Pi", `droid` → "Droid"); unknown backend ids fall back to a capitalized form. See `docs/92-acp-lane-picker.md` for the picker UI and lane lifecycle. Earlier versions auto-spawned every installed backend on view open — that path was removed because it forked 6 long-running ACP subprocesses before the user typed anything.

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

Memory is a per-project set of lane-owned markdown-like documents. The harness creates one memory store through `create_harness_memory(projectDir)` and passes each ACP lane a lane-scoped HTTP MCP endpoint. Agents manage memory with MCP tools:

- `memory_set` overwrites the caller's own summary/detail document.
- `memory_get` reads any lane's full document by lane label.
- `memory_list` lists lane summaries.

The human surface is intentionally smaller: the memory drawer is read-only, and `#mem clear` clears only the active lane's persisted document. The harness no longer extracts memory from tool observations or `MEMORY:` assistant footers.

Krypton auto-allows ACP permission prompts for the built-in `krypton-harness-memory` MCP tools (`memory_set`, `memory_get`, and `memory_list`) because that tool surface is lane-scoped, tab-local, and intentionally agent-managed. Other ACP tool permission requests still use the normal composer pre-empt flow.

#### Memory clearing (escape hatch only)

Lane memory is an agent-managed document. The user has one optional command to recover from stale or bad lane memory:

- `#mem clear` — clears the active lane's persisted memory document.

There are **no** commands for adding, editing, pinning, deleting individual rows, or pulling memory. Agents own the document lifecycle through MCP tools; the user views the board and can clear the active lane when it gets stale.

### Injection

Every prompt is prefixed with a memory packet containing the active lane label, the full lane roster, and the current memory document for each lane. Agents can read details on demand through MCP tools. There are no injection modes.

Prompt block construction:

```ts
function buildPromptBlocks(userText: string, lane: HarnessLane): ContentBlock[] {
  const snapshot = renderPromptMemoryPacket(lane);
  const userBlock: ContentBlock = { type: 'text', text: userText };
  if (!snapshot) return [userBlock];
  if (laneSupportsEmbeddedContext(lane)) {
    return [
      {
        type: 'resource',
        resource: {
            uri: 'krypton://acp-harness/memory.md',
          mimeType: 'text/markdown',
          text: snapshot,
        },
      },
      userBlock,
    ];
  }
  return [
    {
      type: 'text',
      text:
        snapshot,
    },
    userBlock,
  ];
}
```

### Data Flow

```
1. User opens ACP Harness from command palette or compositor shortcut.
2. Compositor resolves projectDir through getFocusedCwd().
3. AcpHarnessView calls AcpClient.listBackends(), then spawns the default roster with that same projectDir.
4. Each lane registers its own client.onEvent() callback and initializes independently.
5. User selects an active tab (default is lane 1) and types a prompt, a hash command, or resolves a permission.
6. For a normal prompt, harness builds the memory packet from current lane documents and prepends it via embedded resource or text block.
7. Harness dispatches the prompt to the active tab's lane only. While the turn is running, the composer chip shows `<lane> running · m:ss · Ctrl+C cancel` and updates once per second. If the active lane is busy, dispatch is rejected with an inline composer chip `lane busy`; the prompt is not queued. When the lane transitions busy→idle and the composer still holds a non-empty draft, the chip flashes `lane idle — Enter to send` for 2 seconds; dispatch remains manual.
8. While the turn streams: each lane renders stream/tool/plan/usage updates into its dashboard transcript. Completed `edit` calls and completed diff-bearing `write_like` tool updates update `fileTouchMap[path] = {laneId, laneDisplayName, toolKind, at}` (overwriting older entries). Memory tool calls trigger a memory-board refresh.
9. When the turn returns, pending permissions and turn-scoped accept/reject-all flags clear. Cancelled turns do not modify memory unless the agent already called MCP memory tools before cancellation.
10. Permission requests for the built-in memory MCP tools are auto-allowed and append a `memory auto-allow` transcript row without entering permission mode. Other permission requests move that lane to `needs_permission` and pre-empt that tab's composer with the options banner. The lane transcript holds the request detail (operation, path, size, diff preview) and a cross-lane warning when `fileTouchMap[path]` exists from a different lane within the last 10 minutes. The user must switch to that tab to read context, then resolve via `a/A/r/R/Esc`. `A`/`R` apply only for the current `session/prompt` turn; both flags clear when that turn returns.
11. `Ctrl+C` (or `#cancel`) in the composer cancels the active lane only. `#new` starts a fresh active-lane session after awaiting old-client disposal; `#new!` also clears the active lane's persisted memory; `#mem clear` clears memory without replacing the session.
12. Pasted, dropped, and global screen-captured images stage in the active lane composer (up to 4 images, 5 MB each). Each staged image renders as a compact placeholder chip with thumbnail, filename/type label, and an `x` remove button; `Esc` still clears all staged images. Pasted and dropped images are saved under Krypton's temp image directory; global captures reuse the `capture_screen` file path. On submit they are sent as embedded ACP image content blocks with base64 data plus a `file://` URI to the saved path alongside the draft text. The submitted user transcript row keeps the chat text and adds a compact image-count attachment chip, so the transcript shows that the turn included images without retaining base64 thumbnails in history.
13. Closing the tab disposes every client and drops all in-memory UI state (transcripts, file-touch map, pending permissions, staged images). **Memory documents are persisted to disk per project directory.** See `docs/76-acp-harness-memory-persistence.md`.
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
      <header class="acp-harness__lane-head">[4] ! Gemini-1 perm: write src/…</header>
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
      <button class="acp-harness__tab">[3] Gemini-1</button>
      <button class="acp-harness__tab acp-harness__tab--permission">[!4] Gemini-1</button>
    </nav>
    <div class="acp-harness__composer">
      <div class="acp-harness__composer-meta">
        <span class="acp-harness__memory-chip">memory: 3/21</span>
        <span class="acp-harness__project-status">~/project on main</span>
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
  [N] <symbol> <Name> [model-if-known] <activity-or-status>
  ```

  Status symbols:

  ```text
  · starting
  ○ idle
  ● busy
  ! permission
  × error
  ```

  The optional model chip is rendered only when Krypton can determine the active lane model. Resolution order: (1) `acp_harness.lane_models.<backend>.active` from `krypton.toml` if set; (2) model fields advertised by the agent in `agent_capabilities`; (3) for OpenCode only, the historical default `zai-coding-plan/glm-5.1`. Unknown models are hidden, not shown as `unknown`. See `docs/06-configuration.md` for the per-backend `lane_models` schema. The `<activity-or-status>` slot is the latest tool/assistant activity by default (`editing src/acp/client.ts`, `reading src/layout.ts`, `running cargo test`, `thinking…`, or the most recent assistant text truncated to ~40 chars). When status is `needs_permission` or `error`, the slot is replaced by the blocking detail (`perm: write src/styles/acp.css`, `error: spawn failed`).

  Color rules:

  - `needs_permission` → warning/gold.
  - `error` → error/red.
  - `busy` → active accent.
  - `idle` / `starting` → muted.

  Status uses symbol + text + color together; never color alone.

- The **active lane** fills the remaining viewport. Its body is internally scrollable. Collapsed rows above and below the active lane stay anchored.
- The active lane body shows the full per-lane transcript: user prompts, assistant text, thoughts, tool calls and summaries, plan updates, permission requests and resolutions, usage snapshots, and system rows. Tool rows show diff/output preview inline (collapsible) as plain monospace text, not syntax-highlighted code. Output groups use label-specific text colors and text-shadow glow only; the group container does not add a background glow. Long assistant text truncates at ~12 lines with a `[…]` expand affordance. The transcript scrolls within the lane body.
- Permission requests appear inline in the transcript at the time they arrive, framed by a clear divider:

  ```text
  ⚠ permission required ─────────────────────
  operation: write
  path:      src/styles/acp.css
  size:      142 lines (47 added, 12 modified)
  ⚠ also touched by Claude-1 2m ago (write)
  diff preview:
  + .acp-harness__lane-row { … }
  + .acp-harness__lane-row--active { … }
    [12 more lines hidden, scroll to expand]
  ⚠ ─────────────────────────────────────────
  waiting for user response…
  ```

  The `also touched by …` line is rendered only when `fileTouchMap[path]` exists from a different lane within the last 10 minutes. Otherwise the line is omitted. After the user resolves the request from the composer, the row updates to `✓ accepted`, `✓ accepted (auto for remainder of this turn)` (when triggered by `A`), `✗ rejected`, or `✗ rejected (auto for remainder of this turn)` (when triggered by `R`), and stays in transcript history.

- When a non-active lane reaches `needs_permission` or `error`, only its collapsed-row indicator updates. The dashboard does not auto-scroll or auto-switch the active lane. The user is drawn to the lane via the tab strip badge, not via dashboard movement.

#### Command Center

- The command center is **input-only**. It does not render transcripts or activity.
- Tab strip lists one tab per lane in spawn order. Each tab shows `[N]` and the lane's display name. Tab badges:
  - The active tab is visually emphasized (active accent border/background).
  - `!N` prefix on tabs whose lane has a pending permission (warning color).
  - `×N` prefix on tabs whose lane is errored (error color).
  - `●N` (subtle) when busy, optional; status is primarily on the dashboard row.
- **Per-tab draft preservation**: each lane's tab keeps its own composer draft. Switching tabs swaps the visible composer to that tab's draft; nothing is lost. Drafts are tab-local only and are dropped when the harness closes.
- **Memory chip** (`memory: 3/3`) sits above the composer line. Counts show up to 10 displayed lane summaries over total lane summaries. During an active turn it changes to `<lane> running · m:ss · Ctrl+C cancel` with a subtle lane-accent pulse so long silent agent runs still show liveness and the cancel affordance.
- The composer has no target chip, no broadcast warning border, and no marked-mode indicator. The active tab is always the destination.

Composer text mode:

- Multi-line input.
- `Enter` sends to the active tab's lane.
- `Shift+Enter` inserts a newline.
- Composer auto-grows up to 6 lines, then scrolls internally.
- If the active lane is busy, `Enter` shows an inline chip `lane busy` and does not dispatch. The prompt is not queued.
- While the active lane is busy, the composer chip updates every second with elapsed runtime and `Ctrl+C cancel`. The timer clears when the turn stops, errors, or the lane is restarted.
- **Idle flash**: when the active lane transitions `busy → idle` and the composer holds a non-empty draft, the chip flashes `lane idle — Enter to send` for 2 seconds, then returns to the memory chip. The prompt is **not** auto-dispatched; the user must press Enter. An optional sound cue (single soft tick from the existing sound engine) plays in parallel; this can be disabled in config.
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
  Esc cancel (rejects)
```

- The banner does **not** include path, diff, or size. That detail (and the cross-lane file-touch warning, when applicable) lives in the active lane's transcript on the dashboard. The user is expected to read context there before responding.
- Built-in memory MCP permissions do not show this banner. The harness automatically chooses the first allow option for `memory_set`, `memory_get`, and `memory_list`, then appends a transcript row such as `✓ memory_set (memory auto-allow)`.
- `A` and `R` are **turn-scoped** for non-memory permissions: they apply only to subsequent permission requests in the current `session/prompt` turn, and both `acceptAllForTurn` / `rejectAllForTurn` flags clear automatically when the turn returns. There is no harness-wide or session-wide "always accept" for filesystem, process, or other non-memory tools. Each new turn starts with `a/r` only.
- Any draft text the user had typed before the request arrived is preserved and re-displayed when the composer returns to text mode.
- If multiple permission requests are queued for the same lane, the composer stays in pre-empt mode and walks them in order; the lane transcript shows each request and resolution row. When `acceptAllForTurn` (or `rejectAllForTurn`) is set, the harness resolves subsequent requests automatically without re-displaying the banner; each auto-resolution still appends a `✓/✗ accepted/rejected (auto for remainder of this turn)` row to the lane transcript.
- If a permission request arrives for a non-active tab, only that tab's composer enters pre-empt mode internally. The currently active tab's composer is unaffected. The tab strip shows `!N` to draw the user to switch.
- Switching to a tab whose composer is in permission mode immediately shows the banner; switching back to a text-mode tab restores its draft.
- There is no "approve permission from another tab" shortcut for prompted permissions. Resolving a non-memory permission requires switching to its tab. This is an intentional safety property.

Permission option mapping:

- `a` selects the first option whose `kind === 'allow_once'`. If absent, select the first option whose `kind === 'allow_always'`. If neither exists, show chip `no accept option`.
- `A` sets `acceptAllForTurn = true` and resolves the current request with the first `allow_once` option. If `allow_once` is absent, use `allow_always`; the flag is still cleared at turn end and is not treated as a standing grant by Krypton. If no allow option exists, show chip `no accept option`.
- `r` selects the first option whose `kind === 'reject_once'`. If absent, select the first option whose `kind === 'reject_always'`. If neither exists, call `respondPermission(requestId, null)`.
- `R` sets `rejectAllForTurn = true` and resolves the current request with the first `reject_once` option. If `reject_once` is absent, use `reject_always`; if no reject option exists, call `respondPermission(requestId, null)`.
- `Esc` always rejects/cancels the focused request by using the same mapping as `r`.
- When `acceptAllForTurn` or `rejectAllForTurn` auto-resolves a later request, use the same option lookup against that later request's own `PermissionOption[]`; if the required option is missing, fall back as above and append the actual option label to the transcript resolution row.
- After a permission key is accepted, the harness immediately appends the resolution row and returns the lane to `busy` before awaiting the ACP permission-response IPC. If that IPC fails, the same permission is restored and the composer re-enters permission mode so the user can retry.

Hash-command autocomplete:

- Typing `#` opens an autocomplete popup above the composer.
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
  ```

  Memory documents are agent-managed through MCP. Human memory mutation is limited to `#mem clear`, which clears the active lane's persisted memory document. Bare `#mem` is a hint only.

- `#new` refuses while the lane is busy, awaiting permission, or still starting; use `#cancel` first. `#new!` also refuses if harness memory is unavailable so it does not silently behave like non-destructive `#new`.

#### Memory drawer overlay

- Toggled with `Ctrl+M`. Closes with `Esc` or `Ctrl+M`.
- Overlays the dashboard. The command center stays visible for lane context, but the composer input line is hidden and ordinary typing is captured by the drawer until it closes. Run commands such as `#mem clear` after closing the drawer.
- Single list view — no tabs. Rows are sorted newest-first by lane document update time.
- The drawer maintains a **cursor row** moved with `Ctrl+N`/`Ctrl+P`, `ArrowUp`/`ArrowDown`, `PageUp`/`PageDown`, or `Home`/`End`; clicking a row selects it. While the drawer is open, these keys are captured before global lane-switch shortcuts so `Ctrl+N`/`Ctrl+P` move memory rows instead of changing lanes. Current human commands do not target individual rows.
- Rows show `<lane> <summary>`, and the selected row expands to show that lane's full memory detail.
- The drawer is **read-only display**. Lane memory documents are managed by agents through MCP; humans can clear only the active lane's document with `#mem clear`.
- The drawer never auto-scrolls away from the row the user is reviewing. New entries appended during a review do not move the cursor.

Memory injection preview:

- The memory chip beside the composer (`memory: 3/3`) shows up to 10 displayed summaries over total memory rows. There is no mode segment.
- The drawer is the single audit surface; the prompt packet contains the same lane summaries/details represented by the board.

Same-project notice:

- The composer meta/status line shows the harness working directory and, when the directory is in a Git repository, the current branch. Detached HEAD state is displayed as `HEAD <sha>`. Non-Git directories show only the cwd.
- When more than one lane is idle or busy in the same `projectDir`, the topbar adds a small `shared cwd` segment. This is informational, never modal, and does not block dispatch. (Per-lane file-touch warnings already cover the actual collision risk during write requests.)

### Keybindings

The default focus is the composer. Almost every key acts on the composer or on overlays opened from it. The dashboard is read-only — its only input is "scroll the active lane's transcript" via the transcript-scroll focus mode.

| Key | Context | Action |
|-----|---------|--------|
| `Leader Y` | Compositor mode | Open ACP Harness. |
| `Tab` / `Shift+Tab` | Composer text mode | Cycle to next/previous lane tab. |
| `Enter` | Composer text mode | Send prompt to active tab's lane. |
| `Shift+Enter` | Composer text mode | Insert newline. |
| `#` | Composer text mode | Open hash-command autocomplete. |
| `Tab` / `Enter` | Hash autocomplete | Accept selected command. |
| `Esc` | Hash autocomplete | Dismiss popup (text preserved). |
| `?` | Transcript scroll focus | Toggle help overlay. |
| `Esc` / `?` / `q` | Help overlay open | Close help overlay. |
| `Ctrl+C` | Composer text mode, active lane busy | Cancel active lane. |
| `Esc` | Composer text mode | Enter transcript/command focus. Composer is disabled until `i` or `Esc` returns to input. |
| `a` | Composer permission mode | Accept the focused permission. |
| `A` | Composer permission mode | Accept-all-from-this-lane for the **current `session/prompt` turn only**; clears when the turn returns. |
| `r` | Composer permission mode | Reject the focused permission. |
| `R` | Composer permission mode | Reject-all-from-this-lane for the **current `session/prompt` turn only**; clears when the turn returns. |
| `Esc` | Composer permission mode | Cancel pending permission (rejects). |
| `Ctrl+M` / `Cmd+M` | Composer or transcript context | Toggle memory drawer overlay. |
| `Ctrl+N` / `Ctrl+P`, `ArrowDown` / `ArrowUp`, `PageDown` / `PageUp` | Memory drawer open | Move cursor row. |
| `Home` / `End` | Memory drawer open | Jump cursor to top/bottom of list. |
| Click row | Memory drawer open | Select memory row. |
| `Esc` / `Ctrl+M` / `Cmd+M` | Memory drawer open | Close drawer (composer draft preserved). |
| Other text input | Memory drawer open | Ignored; composer draft is unchanged. |
| `j` / `k` | Transcript scroll focus | Scroll active lane transcript line by line. |
| `1`–`9` | Transcript scroll focus | Switch to lane tab N without inserting text. |
| `g` / `G` | Transcript scroll focus | Jump to top/bottom of active lane transcript. |
| `Ctrl+u` / `Ctrl+d` | Transcript scroll focus | Page up/down active lane transcript. |
| `i` / `Esc` | Transcript scroll focus | Return to composer input. |
| `q` | Transcript scroll focus | Close harness tab. |
| `Cmd+.` | Any composer/transcript context | Toggle Zen Mode (collapses inactive lanes into a left rail; active lane fills the body). Persisted per project. See `docs/80-acp-harness-zen-mode.md`. |
| `Cmd+P → m` | Harness focused | Toggle lane resource metrics overlay (CPU/RSS tree per lane). See `docs/91-acp-lane-resource-metrics.md`. |

Memory mutations are not bound to dedicated keys; active-lane memory clearing executes through `#mem clear` in the composer. This keeps the keybinding surface narrow and the input rule consistent (input always in the command center).

Removed from earlier drafts:

- `m` / mark-mode, `t` / target cycle, `Ctrl+Shift+C` / cancel-all (broadcast removed).
- `M` / promote transcript item to memory (agents manage memory through MCP).
- `z` / lane fullscreen and `[` / `]` / fullscreen lane switching (no fullscreen mode; the active lane already fills remaining viewport).
- `P` / focus permission queue, `Esc` on permission queue (no global permission queue; permission is per-tab pre-empt).
- `e`, `d`, `a` / `r` on memory rows, `p` / pin, `c` / compact (drawer is read-only; mutations via `#mem`).
- `x` / cycle memory injection mode, `X` / force `agent_select` once (no injection modes in v1).
- `i` / open Selection tab, `h` / `l` / Tab cycling drawer tabs (drawer is single list, no tabs).

`Leader A`, `Leader E`, and `Leader I` continue to open single ACP agent tabs.

### Configuration

No TOML keys are wired for the harness. The default roster is code-defined, and memory persistence is always keyed by project directory.

## Edge Cases

- **One lane fails to spawn:** mark only that lane `error`; its tab gets the `×N` badge; other lanes continue. The user can run `#restart` from that tab to retry.
- **Lane subprocess dies mid-turn (crash, OOM, external SIGKILL, malformed JSON-RPC, error stop reason):** mark the lane `error`, dispose its `AcpClient`, clear turn-local permission/extraction state, and append a transcript row `× session ended unexpectedly: <reason>`. Other lanes are unaffected. The user can run `#restart` to respawn.
- **`#restart` command:** runs only when the active tab's lane status is `error` or `stopped`. The harness calls `AcpClient.spawn(backendId, projectDir)` with the same backend and `cwd` as the original lane (display name is preserved). The lane's `transcript` keeps prior history with a divider `─── session restarted ───` appended; `sessionId`, `pendingPermissions`, `acceptAllForTurn`, and `rejectAllForTurn` are reset; memory entries previously published by this lane stay in the feed (memory is owned by the harness, not the lane). On running lanes (`idle`, `busy`, `needs_permission`), `#restart` is refused with chip `lane <status> — #cancel first`. There is no restart count limit; the user is the rate limiter.
- **`#new` command:** runs only when the active lane is idle, error, or stopped. It awaits disposal of the old ACP client, clears visible lane state and mutable containers, increments the lane spawn epoch, and starts the same backend in the same project directory. Harness memory is preserved.
- **`#new!` command:** performs `#new` only after clearing the active lane's persisted memory document. If memory is unavailable or clearing fails, the fresh session is refused so the destructive suffix never degrades silently.
- **Late events after fresh session:** `AcpClient` drops raw events after `dispose()`, and harness lane callbacks compare both spawn epoch and client identity before mutating state.
- **`#mem clear` during active work:** clears the active lane's memory document for future prompt packets only. Any prompt already sent may still contain the old memory snapshot.
- **User presses Enter while active lane is busy:** show inline composer chip `lane busy`; do not dispatch and do not queue. User must wait for the lane to return to idle (or `Ctrl+C` to cancel). On busy→idle transition with non-empty draft, chip flashes `lane idle — Enter to send` for 2s + optional sound cue; dispatch is still manual.
- **Permission arrives for a non-active tab:** memory MCP permissions are auto-allowed in place. Other permissions put that tab's composer in permission mode internally; the active tab's composer is unaffected. The tab strip shows `!N` and the dashboard collapsed row turns warning-colored. The user must switch to the tab to resolve. There is no cross-tab approve shortcut by design.
- **Multiple permissions on the same lane:** the lane's composer pre-empts and walks them in order; lane transcript shows resolution rows for each. If `acceptAllForTurn` / `rejectAllForTurn` is set, subsequent requests resolve automatically until the turn returns; each auto-resolution still appends a transcript row.
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

## Open Questions

None. The v1 implementation choices that were previously ambiguous are fixed here: use `Leader Y` for opening the harness, normalize tool observation to Krypton's current ACP `ToolKind` union, map permission keys through `PermissionOption.kind`, and either wire the two optional config keys fully or keep them hard-coded until a follow-up config PR.

Assumptions for v1:

- "Same project" means every ACP subprocess receives the same `cwd`, not separate git worktrees.
- "Shared memory" means visible Krypton-owned memory injected into prompts, not direct agent-to-agent messaging and not provider-private memory files.
- "Shared memory" is loaded into a tab-local harness store at runtime and persisted per project directory. Closing the harness drops transcripts and in-RAM lane state, but saved memory is restored next time the same project opens.

## Out of Scope

- **Broadcast or multi-target prompts.** Each prompt has exactly one destination: the active tab's lane. No `selected/all_idle/marked` modes, no marked lanes, no `synchronize-panes`-style fan-out.
- **User-authored memory entries through the harness UI.** No `#mem add`, no manual notes, no manual decisions. Agents update memory through MCP tools.
- **`#pullmem` or any user-triggered extraction.** The harness does not infer memory from transcripts or tools.
- **Inline-secret detection in memory documents.** v1 does not scan summaries/details for AWS keys, API tokens, JWTs, or similar patterns. Agents should avoid writing secrets to shared memory.
- **Configurable memory persistence.** Memory persistence is always enabled for project-scoped harness memory.
- **Memory center / derived summary.** No second layer above the entry list. Selection at dispatch time is the only "view" of memory.
- **Memory kinds / decision tier.** Lane memory is a summary/detail document, not a typed entry stream with decision states.
- **Memory injection modes.** No `auto` / `agent_select` / `pinned_only` / `manual` / `off` switching. The current harness memory packet is always sent before the user prompt.
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
- New Rust ACP protocol capabilities.
- ACP `session/load`, `session/list`, or transcript persistence.
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
- [OpenCode ACP support](https://opencode.ai/docs/acp/) — confirmed `opencode acp` as the stdio ACP subprocess command; Krypton's built-in OpenCode lane selects `zai-coding-plan/glm-5.1` through ACP session configuration after `session/new`.
- [Zed external agents](https://zed.dev/docs/ai/external-agents) — prior art for UI-hosted ACP subprocesses, custom agent configuration, built-in Claude/Codex/Gemini/OpenCode support, and ACP debugging.
- [Claude Code power-user tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips) — prior art for running multiple coding sessions in parallel and the trade-off of worktree isolation.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) — prior art for separate contexts, background subagents, and agent management UI.
- [Claude Code memory](https://code.claude.com/docs/en/memory) — prior art for visible project memory and auto memory loaded as session context.
- [tmux synchronize panes](https://tmuxai.dev/tmux-synchronize-panes/) — prior art for broadcast input, visible sync state, and the risk model of sending one command to many panes.
