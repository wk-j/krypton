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
| `src/acp/acp-harness-memory.ts` | New tab-local memory feed: flat entry list, pinned/unpinned, auto-extraction from tool calls + MEMORY-footer parsing, recency+filepath injection. |
| `src/acp/acp-harness-view.ts` | New `ContentView` that manages multiple ACP clients, lane state, file-touch tracking, auto-memory extraction, prompt dispatch, lane rendering, permissions, restart, and cancel/dispose. |
| `src/acp/index.ts` | Export `AcpHarnessView`. |
| `src/styles/acp-harness.css` | New harness-specific BEM CSS using existing ACP/agent theme variables. |
| `src/styles/index.css` | Import `acp-harness.css`. |
| `src/types.ts` | Add `'acp_harness'` to `PaneContentType`. |
| `src/compositor.ts` | Add `openAcpHarnessView()` using `getFocusedCwd()`, create a content tab, wire close callbacks. |
| `src/command-palette.ts` | Add "Open ACP Harness" action. |
| `src/input-router.ts` | Add a compositor-mode shortcut for the harness. |
| `src/which-key.ts` | Add the shortcut label. |
| `src/config.ts` or current config type module | Add optional `[acp_harness]` settings if the local config model requires typed frontend access. |
| `src-tauri/src/config.rs` or current Rust config module | Add optional `acp_harness.idle_flash_sound` and `acp_harness.memory_footer` parsing/defaults if config is sourced through Rust IPC. |
| `docs/PROGRESS.md`, `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/06-configuration.md` | Document the harness and its two optional config keys after implementation. |

## Design

### Data Structures

```ts
type HarnessLaneStatus = 'starting' | 'idle' | 'busy' | 'needs_permission' | 'error' | 'stopped';
type HarnessMemorySource = 'tool_observation' | 'agent_footer';

interface HarnessLane {
  id: string;
  index: number;
  backendId: string;
  displayName: string;
  client: AcpClient | null;
  status: HarnessLaneStatus;
  draft: string;
  pendingPermissions: HarnessPermission[];
  composerMode: 'text' | 'permission';
  transcript: HarnessTranscriptItem[];
  usage: UsageInfo | null;
  sessionId: string | null;
  error: string | null;
  acceptAllForTurn: boolean;   // turn-scoped 'A' state; cleared when session/prompt returns
  rejectAllForTurn: boolean;   // turn-scoped 'R' state; cleared when session/prompt returns
  pendingTurnExtractions: PendingExtraction[];  // tool-call observations buffered during current turn
}

interface PendingExtraction {
  text: string;
  filePath?: string;
  source: HarnessMemorySource;
  fromToolCallId?: string;
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
  kind: 'system' | 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'permission' | 'restart' | 'memory';
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
  id: string;
  seq: number;
  text: string;
  filePath?: string;
  sourceLaneId: string;           // always a lane (no user-authored entries)
  sourceLabel: string;            // laneDisplayName, e.g. 'Claude-1'
  source: HarnessMemorySource;    // tool_observation | agent_footer
  createdAt: number;
  pinned: boolean;
}

interface HarnessSharedMemory {
  projectDir: string | null;
  entries: HarnessMemoryEntry[];
  nextSeq: number;
}
```

Default roster:

```ts
const DEFAULT_HARNESS_SPAWN: HarnessSpawnSpec[] = [
  { backendId: 'codex', displayName: 'Codex', count: 1 },
  { backendId: 'claude', displayName: 'Claude', count: 1 },
  { backendId: 'gemini', displayName: 'Gemini', count: 1 },
  { backendId: 'opencode', displayName: 'OpenCode', count: 1 },
];
```

The first version keeps this code-defined. Configurable rosters are out of scope until the workflow proves useful.

### API / Commands

No new Tauri command is required for v1. Shared memory is held by the harness view for the lifetime of the tab. The harness uses existing frontend APIs:

```ts
AcpClient.listBackends(): Promise<AcpBackendDescriptor[]>;
AcpClient.spawn(backendId: string, cwd: string | null): Promise<AcpClient>;
client.initialize(): Promise<AgentInfo>;
client.prompt(blocks: ContentBlock[]): Promise<StopReason>;
client.cancel(): Promise<void>;
client.respondPermission(requestId: number, optionId: string | null): Promise<void>;
client.dispose(): Promise<void>;
```

New compositor method:

```ts
openAcpHarnessView(): Promise<void>;
```

### Shared Memory Model

Memory is a flat, tab-local, **auto-curated** feed. The user does not author entries in the default flow. Two extraction paths run in parallel for every turn:

#### Path 1 — Tool-call observation (deterministic, always on)

While a lane's `session/prompt` is in flight, the harness watches incoming `session/update` notifications and converts a narrow set of tool calls into `PendingExtraction` records:

| ACP tool signal | Extraction |
|-----------------|------------|
| `kind: 'edit'` with `status: 'completed'` | `text: "<displayName> modified <path>"`, `filePath = <path>`, `source: 'tool_observation'` |
| Any completed tool update with `content[].type === 'diff'` and a path, even if `kind` is `other` | Treat as `write_like`: `text: "<displayName> modified <path>"`, `filePath = <path>`, `source: 'tool_observation'` |
| `kind: 'execute'` with a completed or failed terminal result | `text: "<displayName> ran <first-word> → <status>"`. Only the first whitespace-delimited token of the command is captured; full argv is **never** included. No `filePath`. |
| `kind: 'read'` | **skipped** — read activity is rarely actionable for other lanes and increases the leak surface. |
| Other tool kinds without diff content | skipped |

Krypton currently normalizes ACP tool kinds to `read | edit | delete | move | search | execute | think | fetch | other`. The harness must use those normalized values and inspect `ToolCall.content` / `ToolCallUpdate.content` for diff-shaped entries rather than expecting adapter-specific `write`, `bash`, or `exec` kinds.

Path extraction order for modified files:

1. First `content[]` entry with `type: 'diff'` and `path`.
2. First `locations[]` entry with `path`.
3. A path-like suffix in `title`, only when the title starts with a known write/edit verb (`edit`, `write`, `create`, `modify`, `patch`).

Command extraction for `kind: 'execute'`:

1. Prefer a string command from `rawInput.command`, `rawInput.cmd`, `rawInput.argv[0]`, or `title`, in that order.
2. Capture only the first whitespace-delimited token or first argv item.
3. Report status as `exit <code>` when `rawOutput.exitCode` or `rawOutput.exit_code` is numeric; otherwise use the normalized tool status (`completed` or `failed`).

Repeated identical observations within the same turn (same `text`) are deduplicated; tool calls with status `pending` / `in_progress` are not extracted, and tool calls that the agent itself cancels are skipped.

When the turn returns (any stop reason except `cancelled`), the buffered observations pass through the **path filter** (see below) and are flushed into the memory feed.

#### Path 2 — Agent footer extraction (LLM cooperation, opportunistic)

Every prompt sent to a lane has a compact fixed footer appended after the user's text and after the injected memory packet:

```text
End your response with a "MEMORY:" block followed by 0–3 short hyphen bullets
("- fact"). Each bullet ≤ 200 chars, optionally prefixed with "<file>:".
Skip the block if nothing useful for other agents on this project.
```

The footer is intentionally terse (~50 tokens) to keep per-turn overhead negligible.

After the turn returns, the harness scans the assistant's final text for a `MEMORY:` block (case-sensitive prefix on its own line). If found:

1. The block is **stripped** from the rendered transcript so the user does not see it as part of the assistant's reply.
2. Each bullet is parsed and appended to the memory feed with `source: 'agent_footer'`.
3. A small badge `+N memory` is shown in the lane transcript at the position the block was stripped.

If no block is found, nothing happens — no warning, no fallback. Compliance is best-effort.

Bullet parsing rules:
- Trim leading `- `, `* `, or `• `.
- Detect `filePath` heuristically from a leading `<path>:` prefix (`src/foo.ts: refactored bar`) or a markdown inline code reference, otherwise null.
- Drop bullets longer than 200 chars or shorter than 8.
- Drop bullets whose text is ≥ 80% similar (Jaccard on lowercase words) to a `tool_observation` entry already pending from the same turn — agent footer entries take precedence in this case (they are richer); the corresponding observation is dropped.
- Run each surviving bullet through the **path filter** (see below). Bullets whose `filePath` matches the deny-list, or whose `text` contains a path-like token matching the deny-list, are dropped entirely (no redaction — the whole bullet is discarded).
- If 0 bullets survive parsing, treat as "no block found".

#### Path filter (applied to both extraction paths)

Both `tool_observation` and `agent_footer` extractions are filtered through a hard-coded deny-list before they are appended to the memory feed. An entry is dropped if its `filePath` (or any path-like token in its `text`, matched as a glob against absolute and tilde-expanded variants) matches any of the following patterns:

```text
~/.ssh/**
~/.aws/**
~/.gnupg/**
~/.config/**/credentials*
~/.netrc
**/*.env
**/*.env.*
**/*credential*
**/*secret*
**/*.pem
**/*.key
**/id_rsa*
**/id_ed25519*
```

Matching is case-insensitive and applies after path normalization. The list is hard-coded in v1 and may be exposed as `acp_harness.memory_path_blacklist = [...]` in a later version. The filter does not attempt to detect inline secrets in free text (e.g. an `AKIA...` substring) — agents that paste secrets into bullet bodies will leak them to other lanes; v1 does not protect against this.

#### Pinning and deletion (escape hatches only)

Entries are immutable text once created. The user has three optional commands that exist solely to recover from bad auto-extractions:

- `#mem pin <id>` — protect an entry from cap eviction. Rare but useful when an early finding should outlive the turn cap.
- `#mem unpin <id>` — undo pin.
- `#mem delete <id>` — remove an entry entirely. For `pinned` entries returns chip `pinned — #mem unpin first`.

There are **no** commands for adding, editing, or pulling memory. The harness produces the feed; the user only views it (and trims if it gets noisy).

### Injection

Every prompt is prefixed with a memory packet built from **other lanes' entries only** — the active lane's own entries are excluded because they already exist in its session history. The selection rule:

1. Include all pinned entries from other lanes (cap 10).
2. Among unpinned other-lane entries, include those whose `filePath` matches any `@path` reference or path-like token in the prompt.
3. If still under budget, include the newest unpinned other-lane entries by `createdAt` until the budget fills.

Budgets:
- Max packet: ~2,000 chars.
- Max entries: 15.
- Pinned entries count against the budget but are always selected first; if pinned alone exceeds the budget, the oldest pinned entries are dropped from the packet (but stay in the feed).

The composer chip beside the input shows `memory: N/M` (selected / total available across all lanes; total includes self-published entries even though they will not inject for this lane). It updates live as the draft changes (file-path matching depends on the draft).

There are no injection modes. The single rule above is always used.

Prompt block construction:

```ts
function buildPromptBlocks(userText: string, lane: HarnessLane): ContentBlock[] {
  const snapshot = renderMemoryPacket(sharedMemory, lane, userText);
  const userBlock: ContentBlock = { type: 'text', text: userText + '\n\n' + MEMORY_FOOTER };
  if (!snapshot) return [userBlock];
  if (laneSupportsEmbeddedContext(lane)) {
    return [
      {
        type: 'resource',
        resource: {
          uri: 'krypton://acp-harness/shared-memory.md',
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
        `Shared project memory from other agents in this Krypton harness. ` +
        `Use as read-only context.\n\n${snapshot}`,
    },
    userBlock,
  ];
}
```

`MEMORY_FOOTER` is the constant footer text from Path 2 above. It is always appended, regardless of whether a memory packet was injected, so every turn has a chance to contribute back.

### Hard cap and overflow

Total memory entries are capped at **50**. Pinned entries are kept; the oldest unpinned entries are dropped silently when the cap is reached. v2 may raise the cap or add a per-lane sub-cap; v1 keeps it simple.

### Data Flow

```
1. User opens ACP Harness from command palette or compositor shortcut.
2. Compositor resolves projectDir through getFocusedCwd().
3. AcpHarnessView calls AcpClient.listBackends(), then spawns the default roster with that same projectDir.
4. Each lane registers its own client.onEvent() callback and initializes independently.
5. User selects an active tab (default is lane 1) and types a prompt, a `#mem pin`/`#mem unpin`/`#mem delete`/`#cancel` command, or resolves a permission.
6. For a normal prompt, harness builds the memory packet (pinned + filepath-matched + recent unpinned **from other lanes only**, ~2k char cap) and prepends it via embedded resource or text block. The fixed `MEMORY_FOOTER` instruction is appended to the user text on every turn, asking the agent to publish 0–3 bullets at the end of its response.
7. Harness dispatches the prompt to the active tab's lane only. If the active lane is busy, dispatch is rejected with an inline composer chip `lane busy`; the prompt is not queued. When the lane transitions busy→idle and the composer still holds a non-empty draft, the chip flashes `lane idle — Enter to send` for 2 seconds; dispatch remains manual.
8. While the turn streams: each lane renders stream/tool/plan/usage updates into its dashboard transcript. Completed `edit` calls and completed diff-bearing `write_like` tool updates update `fileTouchMap[path] = {laneId, laneDisplayName, toolKind, at}` (overwriting older entries). Completed `edit` / `write_like` calls and completed or failed `execute` calls are buffered as `PendingExtraction` records; `read` and other tools are skipped.
9. When the turn returns (stop reason ≠ `cancelled`): (a) the harness scans the assistant's final text for a `MEMORY:` block, strips it from the rendered transcript, parses bullets into `agent_footer` extractions; (b) buffered tool observations are deduplicated against agent-footer extractions (footer wins on ≥80% similarity); (c) every surviving extraction passes through the **path filter** — entries that match the deny-list are dropped silently; (d) the remaining extractions are appended to the memory feed and a `+N memory` badge is rendered at the strip site (or at turn end if no block was found but observations occurred).
10. Permission requests move that lane to `needs_permission` and pre-empt that tab's composer with the options banner. The lane transcript holds the request detail (operation, path, size, diff preview) and a cross-lane warning when `fileTouchMap[path]` exists from a different lane within the last 10 minutes. The user must switch to that tab to read context, then resolve via `a/A/r/R/Esc`. `A`/`R` apply only for the current `session/prompt` turn; both flags clear when that turn returns.
11. `Ctrl+C` (or `#cancel`) in the composer cancels the active lane only. On cancel, buffered `PendingExtraction` records for that turn are dropped — partial turns do not contribute memory.
12. Closing the tab disposes every client and drops all in-memory state (transcripts, memory entries, file-touch map, pending extractions). Nothing is persisted to disk.
```

### UI Changes

The harness has two surfaces stacked vertically:

1. **Dashboard** (top, read-only) — renders all activity for every lane. No input is accepted on this surface.
2. **Command Center** (bottom, input-only) — tab strip + composer. One tab per lane. The active tab determines which lane is expanded on the dashboard and which lane will receive the next prompt.

The **memory drawer** is an overlay (`Esc`, then `v`) that covers the dashboard. The command center stays visible and reachable while the drawer is open.

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
      <header class="acp-harness__lane-head">[3] ● Gemini-1 …</header>
      <div class="acp-harness__lane-body"><!-- scrollable transcript --></div>
    </section>
    <div class="acp-harness__lane acp-harness__lane--collapsed acp-harness__lane--permission">
      <header class="acp-harness__lane-head">[4] ! Gemini-1 perm: write src/…</header>
    </div>
  </div>
  <aside class="acp-harness__memory-overlay" hidden>
    <header class="acp-harness__memory-head">MEMORY · 12 entries (3 pinned)</header>
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
  [N] <symbol> <Name>   <activity-or-status>
  ```

  Status symbols:

  ```text
  · starting
  ○ idle
  ● busy
  ! permission
  × error
  ```

  The `<activity-or-status>` slot is the latest tool/assistant activity by default (`editing src/acp/client.ts`, `reading src/layout.ts`, `running cargo test`, `thinking…`, or the most recent assistant text truncated to ~40 chars). When status is `needs_permission` or `error`, the slot is replaced by the blocking detail (`perm: write src/styles/acp.css`, `error: spawn failed`).

  Color rules:

  - `needs_permission` → warning/gold.
  - `error` → error/red.
  - `busy` → active accent.
  - `idle` / `starting` → muted.

  Status uses symbol + text + color together; never color alone.

- The **active lane** fills the remaining viewport. Its body is internally scrollable. Collapsed rows above and below the active lane stay anchored.
- The active lane body shows the full per-lane transcript: user prompts, assistant text, thoughts, tool calls and summaries, plan updates, permission requests and resolutions, usage snapshots, and system rows. Tool rows show diff/output preview inline (collapsible). Long assistant text truncates at ~12 lines with a `[…]` expand affordance. The transcript scrolls within the lane body.
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
- **Memory chip** (`memory: 3/21`) sits above the composer line. Counts are `selected / total`, computed against the live draft (file-path matches refresh as the draft changes). There is no mode segment.
- The composer has no target chip, no broadcast warning border, and no marked-mode indicator. The active tab is always the destination.

Composer text mode:

- Multi-line input.
- `Enter` sends to the active tab's lane.
- `Shift+Enter` inserts a newline.
- Composer auto-grows up to 6 lines, then scrolls internally.
- If the active lane is busy, `Enter` shows an inline chip `lane busy` and does not dispatch. The prompt is not queued.
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
- `A` and `R` are **turn-scoped**: they apply only to subsequent permission requests in the current `session/prompt` turn, and both `acceptAllForTurn` / `rejectAllForTurn` flags clear automatically when the turn returns. There is no harness-wide or session-wide "always accept". Each new turn starts with `a/r` only.
- Any draft text the user had typed before the request arrived is preserved and re-displayed when the composer returns to text mode.
- If multiple permission requests are queued for the same lane, the composer stays in pre-empt mode and walks them in order; the lane transcript shows each request and resolution row. When `acceptAllForTurn` (or `rejectAllForTurn`) is set, the harness resolves subsequent requests automatically without re-displaying the banner; each auto-resolution still appends a `✓/✗ accepted/rejected (auto for remainder of this turn)` row to the lane transcript.
- If a permission request arrives for a non-active tab, only that tab's composer enters pre-empt mode internally. The currently active tab's composer is unaffected. The tab strip shows `!N` to draw the user to switch.
- Switching to a tab whose composer is in permission mode immediately shows the banner; switching back to a text-mode tab restores its draft.
- There is no "approve permission from another tab" shortcut. Resolving a permission requires switching to its tab. This is an intentional safety property.

Permission option mapping:

- `a` selects the first option whose `kind === 'allow_once'`. If absent, select the first option whose `kind === 'allow_always'`. If neither exists, show chip `no accept option`.
- `A` sets `acceptAllForTurn = true` and resolves the current request with the first `allow_once` option. If `allow_once` is absent, use `allow_always`; the flag is still cleared at turn end and is not treated as a standing grant by Krypton. If no allow option exists, show chip `no accept option`.
- `r` selects the first option whose `kind === 'reject_once'`. If absent, select the first option whose `kind === 'reject_always'`. If neither exists, call `respondPermission(requestId, null)`.
- `R` sets `rejectAllForTurn = true` and resolves the current request with the first `reject_once` option. If `reject_once` is absent, use `reject_always`; if no reject option exists, call `respondPermission(requestId, null)`.
- `Esc` always rejects/cancels the focused request by using the same mapping as `r`.
- When `acceptAllForTurn` or `rejectAllForTurn` auto-resolves a later request, use the same option lookup against that later request's own `PermissionOption[]`; if the required option is missing, fall back as above and append the actual option label to the transcript resolution row.

Hash-command autocomplete:

- Typing `#` opens an autocomplete popup above the composer.
- `Tab`/`Enter` accepts the selected command; `Esc` dismisses (does not clear text).
- Available commands:

  ```text
  #mem pin <id>      pin memory entry (sticks across cap-overflow drops)
  #mem unpin <id>    unpin memory entry
  #mem delete <id>   delete memory entry (pinned: chip "unpin first")
  #restart           respawn the active tab's lane (only when status = error or stopped)
  #cancel            cancel the active tab's lane (= Ctrl+C)
  ```

  Memory is auto-curated by the harness from each lane's tool calls and optional `MEMORY:` footer block. There are no `#mem add`, `#pullmem`, `#mem edit`, or `#mem confirm` commands — entries appear automatically as turns complete. The three escape-hatch commands above are the entire user surface for memory mutation.

- When the memory drawer is open and a row is highlighted by the cursor, `#mem` autocompletes prefer the highlighted row (the popup pre-fills the cursor row's `<id>`).

#### Memory drawer overlay

- Toggled with `v`. Closes with `Esc`.
- Overlays the dashboard. The command center stays visible and reachable; `#mem` commands run while the drawer is open and effects appear immediately.
- Single list view — no tabs. Pinned entries float to the top; unpinned entries follow newest-first.
- The drawer maintains a **cursor row** moved with `j`/`k`. The cursor identifies the row that `#mem` commands without an explicit `<id>` will target (e.g. typing `#mem pin` with cursor on row M3 acts on M3); commands that include an explicit id ignore the cursor.
- Rows show `[id] <source-lane> <text>` followed by a small badge indicating origin: `tool` for `tool_observation`, `agent` for `agent_footer`. Pinned rows are prefixed with a lock glyph and visually emphasized.
- The drawer is **read-only display**. Memory is auto-curated from agent activity; the only commands are the three escape-hatch mutators in the composer (`#mem pin`/`#mem unpin`/`#mem delete`).
- The drawer never auto-scrolls away from the row the user is reviewing. New entries appended during a review do not move the cursor.

Memory injection preview:

- The memory chip beside the composer (`memory: 3/21`) shows `selected / total` counts. There is no mode segment.
- The drawer is the single audit surface; live "what would inject right now" preview is not a separate view because the algorithm is transparent (pinned + filepath match + recent unpinned). To see exactly what will inject, watch the chip count update as the draft changes.

Same-project notice:

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
| `v` | Transcript scroll focus | Toggle memory drawer overlay. |
| `j` / `k` | Memory drawer open | Move cursor row. |
| `g` / `G` | Memory drawer open | Jump cursor to top/bottom of list. |
| `Esc` | Memory drawer open | Close drawer (composer draft preserved). |
| `j` / `k` | Transcript scroll focus | Scroll active lane transcript line by line. |
| `1`–`9` | Transcript scroll focus | Switch to lane tab N without inserting text. |
| `g` / `G` | Transcript scroll focus | Jump to top/bottom of active lane transcript. |
| `Ctrl+u` / `Ctrl+d` | Transcript scroll focus | Page up/down active lane transcript. |
| `i` / `Esc` | Transcript scroll focus | Return to composer input. |
| `q` | Transcript scroll focus | Close harness tab. |

Memory mutations are not bound to dedicated keys; they execute through `#mem` commands in the composer. This keeps the keybinding surface narrow and the input rule consistent (input always in the command center).

Removed from earlier drafts:

- `m` / mark-mode, `t` / target cycle, `Ctrl+Shift+C` / cancel-all (broadcast removed).
- `M` / promote transcript item to memory (memory is auto-curated; user cannot promote).
- `z` / lane fullscreen and `[` / `]` / fullscreen lane switching (no fullscreen mode; the active lane already fills remaining viewport).
- `P` / focus permission queue, `Esc` on permission queue (no global permission queue; permission is per-tab pre-empt).
- `e`, `d`, `a` / `r` on memory rows, `p` / pin, `c` / compact (drawer is read-only; mutations via `#mem`).
- `x` / cycle memory injection mode, `X` / force `agent_select` once (no injection modes in v1).
- `i` / open Selection tab, `h` / `l` / Tab cycling drawer tabs (drawer is single list, no tabs).

`Leader A`, `Leader E`, and `Leader I` continue to open single ACP agent tabs.

### Configuration

No TOML keys in v1 except two optional toggles:

```toml
[acp_harness]
idle_flash_sound = true   # play a soft tick when an idle lane has a pending draft
memory_footer = true      # append MEMORY-extraction footer to outgoing prompts
```

Setting `memory_footer = false` disables Path 2 (agent footer extraction); Path 1 (tool-call observation) keeps running. The default roster is code-defined. Memory is tab-local — nothing is persisted to disk in v1.

If the existing config plumbing makes new TOML keys disproportionate for the first implementation slice, both settings may be hard-coded to their defaults in the initial PR, but the implementation must then leave the `docs/06-configuration.md` entry out until the keys are actually wired. The preferred complete v1 includes config parsing and docs.

## Edge Cases

- **One lane fails to spawn:** mark only that lane `error`; its tab gets the `×N` badge; other lanes continue. The user can run `#restart` from that tab to retry.
- **Lane subprocess dies mid-turn (crash, OOM, external SIGKILL, malformed JSON-RPC, error stop reason):** mark the lane `error`, dispose its `AcpClient`, drop any `PendingExtraction` records for the in-flight turn (no partial memory), and append a transcript row `× session ended unexpectedly: <reason>`. Other lanes are unaffected. The user can run `#restart` to respawn.
- **`#restart` command:** runs only when the active tab's lane status is `error` or `stopped`. The harness calls `AcpClient.spawn(backendId, projectDir)` with the same backend and `cwd` as the original lane (display name is preserved). The lane's `transcript` keeps prior history with a divider `─── session restarted ───` appended; `sessionId`, `pendingPermissions`, `acceptAllForTurn`, and `rejectAllForTurn` are reset; memory entries previously published by this lane stay in the feed (memory is owned by the harness, not the lane). On running lanes (`idle`, `busy`, `needs_permission`), `#restart` is refused with chip `lane <status> — #cancel first`. There is no restart count limit; the user is the rate limiter.
- **User presses Enter while active lane is busy:** show inline composer chip `lane busy`; do not dispatch and do not queue. User must wait for the lane to return to idle (or `Ctrl+C` to cancel). On busy→idle transition with non-empty draft, chip flashes `lane idle — Enter to send` for 2s + optional sound cue; dispatch is still manual.
- **Permission arrives for a non-active tab:** that tab's composer enters permission mode internally; the active tab's composer is unaffected. The tab strip shows `!N` and the dashboard collapsed row turns warning-colored. The user must switch to the tab to resolve. There is no cross-tab approve shortcut by design.
- **Multiple permissions on the same lane:** the lane's composer pre-empts and walks them in order; lane transcript shows resolution rows for each. If `acceptAllForTurn` / `rejectAllForTurn` is set, subsequent requests resolve automatically until the turn returns; each auto-resolution still appends a transcript row.
- **Multiple permissions across different lanes:** each affected tab independently sits in permission mode. The user resolves them by switching tabs in any order they prefer.
- **Permission arrives while user is mid-typing in that tab:** composer pre-empts; the draft text is preserved and re-displayed when the composer returns to text mode.
- **Permission for a path another lane recently wrote:** banner detail in the lane transcript adds a single `⚠ also touched by Lane-N <duration> ago (write_like|edit)` line, derived from `fileTouchMap` (10-minute window). The composer pre-empt banner stays minimal; user must switch to the lane to read context. This is informational — it does not block accept.
- **Memory hits the 50-entry cap:** oldest unpinned entries are dropped silently to make room. Pinned entries are never dropped. If pinned alone exceed 50, the cap is treated as a soft limit and pinned entries stay.
- **Sensitive path is read or written by a lane:** the path filter drops the extraction silently before it reaches the memory feed. The user is not notified — surfacing every drop would be noisy and itself leak the existence of sensitive paths to the lane's transcript.
- **Agent footer bullet contains a secret in free text (no path):** v1 does not detect or redact inline secrets. Other lanes will see the bullet. Documented as a known gap; users running with multiple lanes should treat the harness like a chat room with all lanes — anything an agent says is shared.
- **Agent omits the MEMORY footer:** no warning, no fallback. Tool-call observations from that turn still flow in (after path filtering). v1 accepts that some agents will not comply.
- **Agent emits a malformed MEMORY block:** the parser drops bullets that fail the rules (length, format) and keeps any that pass. No surfaced warning — silent best-effort.
- **Agent emits MEMORY block but turn was cancelled:** all `PendingExtraction` records for the turn are discarded; the agent's partial response is not parsed. Memory only grows on completed turns.
- **Tool-call observation duplicates agent footer claim:** if both paths describe the same fact (≥80% similarity), the agent footer entry wins and the observation is dropped. The richer text survives.
- **Lane publishes only about its own work:** memory still grows but the lane never injects its own entries back into itself. Other lanes will see them. Self-deduplication is implicit.
- **Injection budget exceeded:** pinned entries selected first; then filepath-matched; then most-recent unpinned. When the ~2k char budget is reached, remaining candidates are dropped from the packet (still in the feed).
- **Agent ignores injected memory:** memory is context, not a command. The drawer's full list and the chip count make injection auditable. No further mitigation in v1.
- **Agent publishes low-quality memory:** entries appear in the drawer and can be deleted with `#mem delete <id>` before they can be injected into other lanes' future prompts.
- **Two lanes publish contradictory entries:** both remain with source labels. v1 has no canonical conflict resolution; the user resolves by deleting one and/or pinning the preferred entry.
- **Footer instruction interferes with agent's own response format:** v1 accepts this risk. Agents that emit code blocks at the end of responses may include or fight with the MEMORY footer — the parser is tolerant (looks for `MEMORY:` on its own line) but agents may produce weird output. Users can disable the footer with `acp_harness.memory_footer = false` once the optional config key is wired; if the initial PR hard-codes defaults, this remains a follow-up config task.
- **Agent lacks embedded context support:** inject memory as a leading text block instead of a resource block.
- **User closes harness mid-turn:** dispose every client (existing Rust teardown sends SIGTERM then SIGKILL); drop all in-memory state; nothing written to disk.
- **Backend list lacks a default roster backend:** omit that backend and add a system row to the harness header (e.g. `Codex backend not installed — skipped`). If zero lanes spawn, harness opens with an empty dashboard and a single banner `no ACP backends available`. v1 does not auto-fall-back to a different backend.
- **Same project write conflicts:** v1 does not lock or prevent them. The topbar `shared cwd` segment and per-permission `also touched by …` warnings are the only signals. Users should drive write-heavy work through one lane.
- **Drawer cursor row is on a row that gets removed (cap overflow):** snap the cursor to the nearest surviving row.
- **Image paste/drop:** out of scope for harness v1; text prompts and memory resource/text blocks only.

## Open Questions

None. The v1 implementation choices that were previously ambiguous are fixed here: use `Leader Y` for opening the harness, normalize tool observation to Krypton's current ACP `ToolKind` union, map permission keys through `PermissionOption.kind`, and either wire the two optional config keys fully or keep them hard-coded until a follow-up config PR.

Assumptions for v1:

- "Same project" means every ACP subprocess receives the same `cwd`, not separate git worktrees.
- "Shared memory" means visible Krypton-owned memory injected into prompts, not direct agent-to-agent messaging and not provider-private memory files.
- "Shared memory" is **tab-local**. Closing the harness drops every entry. Persisting memory across sessions is a v2 concern.

## Out of Scope

- **Broadcast or multi-target prompts.** Each prompt has exactly one destination: the active tab's lane. No `selected/all_idle/marked` modes, no marked lanes, no `synchronize-panes`-style fan-out.
- **User-authored memory entries.** No `#mem add`, no manual notes, no manual decisions. Memory is auto-curated by the harness from agent activity.
- **`#pullmem` or any user-triggered extraction.** Extraction runs automatically on every turn (footer + tool observation). The user does not trigger memory pulls.
- **Inline-secret detection in memory bullets.** v1 does not scan bullet text for AWS keys, API tokens, JWTs, or similar patterns. The path filter only blocks entries whose paths or path-tokens match the deny-list.
- **Configurable path deny-list.** v1 ships a hard-coded list (ssh/aws/gnupg/.env/credentials/keys). Custom blacklists via TOML are a v2 concern.
- **Read-tool observation.** Read calls are never extracted, regardless of file size or path. Other lanes coordinate on edits, write-like diffs, and command runs only.
- **Full command-line capture in `execute` observations.** Only the first whitespace-delimited token (e.g. `cargo`, `npm`, `curl`) and the exit code/status are captured — full argv is dropped to reduce inadvertent secret leakage from CLI flags.
- **Memory persistence to disk.** No `~/.config/krypton/acp-harness-memory/*.json`; no namespace keys; no repo-vs-worktree choice; no lockfile; no atomic write. Memory lives in tab state only.
- **Memory center / derived summary.** No second layer above the entry list. Selection at dispatch time is the only "view" of memory.
- **Memory kinds / decision tier.** Entries have no `kind` field. Pinning is the only durability signal; everything else is just a flat entry.
- **Memory injection modes.** No `auto` / `agent_select` / `pinned_only` / `manual` / `off` switching. A single deterministic rule (other-lane pinned + filepath match + recent unpinned, ~2k char cap) is always used.
- **`agent_select` preflight.** No two-step prompt that asks the LLM to choose memory IDs.
- **Compaction.** No fold-into-summary, no `#mem compact`, no stale rules. Hard cap at 50 entries with silent oldest-unpinned drop is the entire overflow policy.
- **Conflict / pending-decision flows.** No `pending_decision`, `conflict`, or `resolution_proposal` states. No `#mem approve` / `#mem reject`. Conflicts are resolved by user delete/pin or by future agent activity overriding stale entries.
- **`#mem confirm` and pending destructive ops.** Pinned entries require explicit `#mem unpin` before `#mem delete`; no two-step confirm with hidden state.
- **Inline editing of memory entries.** No `#mem edit` in v1. Wrong text → delete; let the next turn re-extract.
- **Cross-lane file lock or write coordination.** `fileTouchMap` is informational only; the harness never blocks a permission based on another lane's recent writes.
- **Standing per-lane permission grants.** `A`/`R` are scoped to the current `session/prompt` turn. There is no harness-wide or session-lifetime auto-accept.
- **Lane fullscreen mode.** The active lane already fills the dashboard's remaining viewport with internal scroll.
- **Cross-tab permission resolution.** Resolving a permission requires switching to its tab; this is intentional so context is read before approval.
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
- [OpenCode ACP support](https://opencode.ai/docs/acp/) — confirmed `opencode acp` as the stdio ACP subprocess command.
- [Zed external agents](https://zed.dev/docs/ai/external-agents) — prior art for UI-hosted ACP subprocesses, custom agent configuration, built-in Claude/Codex/Gemini/OpenCode support, and ACP debugging.
- [Claude Code power-user tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips) — prior art for running multiple coding sessions in parallel and the trade-off of worktree isolation.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) — prior art for separate contexts, background subagents, and agent management UI.
- [Claude Code memory](https://code.claude.com/docs/en/memory) — prior art for visible project memory and auto memory loaded as session context.
- [tmux synchronize panes](https://tmuxai.dev/tmux-synchronize-panes/) — prior art for broadcast input, visible sync state, and the risk model of sending one command to many panes.
