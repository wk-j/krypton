# Cancel Escalation → Force-Restart for Hung ACP Lanes — Implementation Spec

> Status: Implemented
> Date: 2026-07-23 (implemented 2026-07-25)
> Issue: [#13](https://github.com/wk-j/krypton/issues/13)

## Problem

When the upstream `claude` CLI hangs after a turn that used background tasks
(anthropics/claude-code#19195 family), the turn never ends: `session/cancel` is
delivered but the interrupt dies inside the hung CLI. The lane stays `busy`
forever, `#restart` refuses non-`error`/`stopped` lanes, and the only recovery
is killing the CLI PID from an external terminal.

## Solution

Pure-frontend cancel escalation in `acp-harness-view.ts`. Track when a cancel
goes unacknowledged; after 10 s flip the lane into a visible "cancel not
acknowledged" state where the next `Ctrl+C` force-restarts the lane —
`restartLane()` gains a `force` flag that bypasses its status guard and reuses
the existing dispose path (`acp_dispose` already SIGTERMs the whole process
group, then SIGKILLs after 2 s). The force path then **resumes the same agent
session** (`session/resume`, falling back to `session/load`, then to a fresh
session) so the lane keeps its conversation context — the user never chose to
lose it; the CLI hung. No Rust changes.

## Research

- `terminate_client` in `src-tauri/src/acp.rs:1683` already kills the adapter
  process **group** (`libc::kill(-pid, SIGTERM)` → 2 s → SIGKILL) and is invoked
  by `acp_dispose`; `AcpClient.dispose()` (`src/acp/client.ts:225`) calls it.
  Force-restart therefore needs no new IPC command.
- `restartLane()` (`acp-harness-view.ts:8578`) refuses unless status is
  `error`/`stopped` — the only blocker for recovering a hung-busy lane.
- `cancelLane()` (`acp-harness-view.ts:8552`) fires `session/cancel` but keeps
  no record that it did; repeated `Ctrl+C` just re-sends into the hung CLI.
- `setLaneStatus()` (`acp-harness-view.ts:1607`) is the single status mutation
  point — the right place to clear escalation state when a turn really ends
  (same `busy`/`needs_permission` carve-out as `activeSystemLabel`).
- A hung lane means the pending `lane.client.prompt(...)` promise in
  `sendUserPrompt` rejects when we dispose mid-turn. Its catch block flips the
  lane to `error` — racing the respawn. The codebase already has the guard
  convention for this: `lane.spawnEpoch` (bumped on dispose/respawn, checked as
  `lane.spawnEpoch !== epoch || lane.client !== client` in `spawnLane` and the
  session picker). The prompt handlers just don't apply it yet.
- Session resume machinery already exists end-to-end: `AcpClient` has
  `initializeOnly()` (initialize without `session/new`), `setMcpServers()`,
  `resumeSession()` and `loadSession()`; the session picker
  (`acp-harness-view.ts:8360`) composes them, preferring `resume` (no history
  replay) over `load`. Capabilities come from `sessionCapabilitiesFromAgent`
  (`sessionCaps.resume` / `loadSession: true`), and the installed
  `@agentclientprotocol/claude-agent-acp` advertises both, mapping them onto
  the CLI's `resume` option. Claude Code persists the session transcript in
  `~/.claude/projects/<dir>/<session-id>.jsonl`, so the context survives the
  kill (verified on the real incident: the hung session's file was complete).
- Real-world validation (2026-07-23, lane Claude-5, session `2b042cbb`): turn
  transcript complete, zero child processes, CLI never emitted `result`;
  manual `kill <pid>` → adapter error → `#restart` recovered the lane.
- Upstream: claude-code#19195 (primary, open, no workaround), #24999/#13188
  (regression), #39632 (stream-json race); claude-agent-acp#338 confirms the
  adapter is unusable after CLI death — respawning the whole chain (what
  `restartLane` already does) is the correct recovery.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| docker / systemd | `stop` = SIGTERM → grace timeout → SIGKILL | Same two-stage pattern; our grace period is user-visible instead of silent |
| VS Code | "Terminate task" → if still running, second attempt offers force kill dialog | Escalation on repeat gesture, mouse-driven dialog |
| Claude Code (interactive) | Esc Esc interrupts; works because the TUI loop is alive even when the turn queue hangs (#24999) | Not available over ACP stream-json — interrupt rides the hung process |
| Zed (ACP client) | Detects dropped response channel and surfaces an error state; user restarts the agent server from the error banner | Reactive (transport death), doesn't cover a *silently* hung CLI |
| tmux | `prefix x` kill-pane, unconditional | No escalation concept; kill is always available |

**Krypton delta** — same repeat-gesture escalation as VS Code but fully
keyboard-driven (`Ctrl+C` again, no dialog), with an explicit timed window like
docker's grace period. The hung state is a transcript system row rather than a
modal or a lane-head chip. No market equivalent handles the "turn finished but
turn-end never signalled" case specifically; this design treats it as generic
cancel-unresponsiveness.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Escalation state on `HarnessLane`, `cancelLane` escalation logic, `restartLane(force)`, `spawnLane(resumeSessionId)` resume path, `setLaneStatus` clearing, stale-completion guard in `sendUserPrompt`, timer cleanup in `destroy()` |
| `src/acp/acp-harness-view.test.ts` | Escalation state-machine tests |
| `docs/PROGRESS.md` | Milestone entry |

## Design

### Data Structures

```ts
// HarnessLane additions
cancelRequestedAt: number | null;   // first unacknowledged session/cancel of this turn
cancelUnacked: boolean;             // true once CANCEL_ESCALATION_MS elapsed → next Ctrl+C force-restarts
cancelEscalationTimer: number | null;

const CANCEL_ESCALATION_MS = 10_000;
```

### Data Flow

```
1. Turn hung: lane busy, user hits Ctrl+C → cancelLane()
2. client.cancel() sent (unchanged). cancelRequestedAt == null → stamp it,
   arm setTimeout(CANCEL_ESCALATION_MS)
3a. CLI acks: turn ends → setLaneStatus(idle|error) → escalation state +
    timer cleared. Normal life resumes.
3b. Timer fires, lane still busy/needs_permission and stamp unchanged →
    cancelUnacked = true, transcript system row
    "cancel not acknowledged for 10s — Ctrl+C again to force-restart",
    render()
4. User hits Ctrl+C again:
   - cancelUnacked → forceRestartLane(): transcript row
     "force restart: cancel unacknowledged", restartLane(lane, { force: true })
   - not yet unacked (< 10 s) → re-send session/cancel (today's behavior),
     keep the original stamp
5. restartLane(force): captures lane.sessionId + session capabilities, skips
   the status guard, dispose() kills the process group (existing
   SIGTERM→SIGKILL), then respawns WITH resume (step 7)
6. The orphaned prompt promise rejects during dispose; sendUserPrompt's catch
   sees the lane's spawnEpoch moved on and returns silently
7. spawnLane(lane, { resumeSessionId }): AcpClient.spawn → initializeOnly()
   → setMcpServers(mcpServersForLane(...)) → resumeSession(resumeSessionId)
   (or loadSession when only that is advertised). On success the lane is idle
   in the SAME agent session — context intact. On failure (or when the backend
   advertises neither capability) fall back to sessionNew() with a transcript
   note "resume failed — fresh session"
```

### Session resume on force-restart

`spawnLane` gains an optional `resumeSessionId` parameter; the body mirrors
the session picker's resume block (`initializeOnly` + MCP injection +
`resumeSession`/`loadSession`, epoch-guarded), reusing
`sessionCapabilitiesFromAgent` for the mode decision. `restartLane` passes it
only on the force path — a normal `#restart` from `error`/`stopped` keeps
today's fresh-session semantics (users rely on it to clear context).
`resume` is preferred over `load` because the lane still holds its rendered
transcript; a `session/load` history replay would duplicate rows, so a
load-only backend suppresses replayed updates until the load completes (the
picker's existing behavior).

### Stale-completion guard

`sendUserPrompt` captures `const epoch = lane.spawnEpoch; const client =
lane.client` before `await client.prompt(blocks)`; the catch block bails out
first thing when `lane.spawnEpoch !== epoch || lane.client !== client` — the
same convention `spawnLane` and the session picker already use. The same guard
applies to the system-prompt path (`enqueueSystemPrompt`'s prompt catch) —
both handlers otherwise flip a freshly-respawned lane to `error`.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+C` | lane busy, no pending cancel | send `session/cancel`, arm 10 s escalation (existing gesture, new bookkeeping) |
| `Ctrl+C` | cancel unacknowledged ≥ 10 s | force-restart the lane |

`#cancel`, the orchestrator-console `c` key, and the command-palette wrapper
all route through `cancelLane()` and get escalation for free. `#restart`
gating is unchanged.

### UI Changes

- No lane-head cancel chip. Busy, permission, peer-wait, and hung-cancel
  states used to paint `⌃C cancel` / `⌃C force restart` in the head's last
  grid column; that control sat isolated from the rail HUD and restated a
  keybinding the workspace footer (`#cancel running`) and `?` help already
  carry. `Ctrl+C` / `#cancel` are unchanged.
- Transcript system rows are the durable hung-lane signal: they narrate both
  the escalation offer and the force restart. No new DOM surfaces, no modal.
  A pending shell cancel still takes the key first, so a force-restart is
  never offered while `pendingShellId` is set.

## Edge Cases

- **Turn ends naturally right after escalation** — `setLaneStatus` to any
  non-`busy`/`needs_permission` state clears stamp + flag + timer; the next
  `Ctrl+C` is the normal clear-draft gesture.
- **`busy` ↔ `needs_permission` flapping** — escalation state survives (same
  carve-out as `activeSystemLabel`), since it's still the same turn.
- **Ctrl+C mashing after unack** — `forceRestartLane` no-ops while a restart
  is already in flight (status `starting`, or `lane.client === null`).
- **Shell cancel (`pendingShellId`)** — takes precedence in the key handler
  today; untouched.
- **`awaiting_peer` cancel** — peer-conversation cancel path is untouched;
  escalation only arms when `client.cancel()` was actually sent.
- **View teardown** — `destroy()` clears `cancelEscalationTimer` alongside the
  existing spinner/tool timers.
- **Timer fires after lane closed** — callback re-checks the lane is still
  registered and stamp unchanged before flagging.
- **Resume fails** (session file corrupt, adapter rejects, backend lacks both
  capabilities) — fall back to `sessionNew()`; transcript notes the context
  loss. The lane must never end up worse than today's fresh-restart behavior.
- **Hung turn left a mid-turn session file** — the killed CLI may have
  persisted an incomplete last turn; Claude Code tolerates resuming such files
  (it resumes from the last complete message). If the resumed session proves
  unusable the user can still `#restart` for a fresh one.
- **`lane.sessionId` is null** (lane hung before `session/new` completed) —
  nothing to resume; force path goes straight to the fresh-session fallback.

## Open Questions

None — resolved during research: no Rust command needed (dispose already
kills the group), and the 10 s threshold is a constant, not config.

## Out of Scope

- Making the threshold configurable in `krypton.toml`.
- Auto-force-restart without a second user gesture (too destructive to do
  silently).
- Changing normal `#restart` semantics — it stays fresh-session; resume is
  exclusive to the force path.
- Fixing the upstream hang itself (tracked in anthropics/claude-code#19195).
- `awaiting_peer` / peer-conversation hangs — different machinery.

## Resources

- [anthropics/claude-code#19195](https://github.com/anthropics/claude-code/issues/19195) — root-cause match: background-task queue ops after completion signal hang the session (`stop_reason: null`)
- [anthropics/claude-code#24999](https://github.com/anthropics/claude-code/issues/24999) / [#13188](https://github.com/anthropics/claude-code/issues/13188) — same family, marked regression; Esc-Esc recovery only exists in interactive mode
- [anthropics/claude-code#39632](https://github.com/anthropics/claude-code/issues/39632) — stream-json background-task notification race
- [agentclientprotocol/claude-agent-acp#338](https://github.com/agentclientprotocol/claude-agent-acp/issues/338) — adapter permanently broken after CLI death → full-chain respawn is the correct recovery
- Zed `crates/agent_servers/src/acp.rs` (local checkout) — dropped-response-channel error surfacing; prior art for detecting a dead turn
