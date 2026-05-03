# ACP Harness Fresh Session Commands — Implementation Spec

> Status: Implemented
> Date: 2026-05-03
> Milestone: M8 — Polish

## Problem

ACP Harness lanes can be cancelled or restarted after failure, but there is no keyboard-first way to intentionally start a fresh conversation for one lane while keeping the harness tab open. Users also have no direct human command to clear the persisted lane memory that is restored per project.

## Solution

Add three small hash commands to the harness composer: `#new`, `#new!`, and `#mem clear`. `#new` replaces the active lane's ACP subprocess and clears its visible lane state while leaving harness memory untouched. `#new!` does the same and also clears that lane's persisted harness memory. `#mem clear` only clears the active lane's persisted memory and refreshes the drawer.

Keep these as hash commands, not slash commands, because slash-prefixed text is already reserved for agent-side skill and command invocation. Harness-owned commands stay in the `#` namespace alongside `#cancel`, `#restart`, `#mem`, and `#mcp`.

## Research

- Current implementation parses hash commands in `AcpHarnessView.runHashCommand()`. Existing commands are simple string matches with no separate command registry.
- `#restart` is intentionally restricted to `error` and `stopped` lanes, preserves prior transcript, and appends a restart divider. It is a recovery command, not a clean slate command.
- `createLane()` shows the mutable state that must be fresh per lane: permissions, pending extractions, staged images, transcript, tool maps, and seen transcript IDs.
- The Rust backend already exposes `clear_harness_memory_lane(harness_id, lane)`, and `HookServer.clear_harness_memory_lane()` removes one persisted lane document then schedules a save.
- Claude Code uses `/clear` to start a fresh conversation, with aliases `/reset` and `/new`; this confirms users expect a short "new conversation" command.
- Zed treats new agent threads as first-class separate threads and notes external-agent feature support varies. Krypton's harness differs because it keeps several external ACP subprocesses inside one view and needs per-lane reset.
- tmux and WezTerm prior art separate spawning/restarting processes from killing panes/windows. That supports keeping `#new` as explicit lifecycle replacement rather than overloading cancel.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Claude Code | `/clear` starts a new conversation; docs list `/reset` and `/new` as aliases. | Closest user expectation for "fresh conversation". Krypton uses `#new` because slash input is forwarded to agents/skills. |
| Zed Agent Panel | New threads are created with command-palette actions and keyboard shortcuts; external agents may have different feature support. | Krypton mirrors the "new thread" concept per lane, but keeps the harness tab and other lanes intact. |
| tmux | `new-session` creates a separate session; panes/windows have separate kill/respawn commands. | Supports separating fresh lifecycle commands from cancel/restart recovery. |
| WezTerm | Multiplexer APIs spawn new tabs/windows with cwd/domain options. | Reinforces preserving cwd/backend when creating a replacement process. |

**Krypton delta** — Keep command entry keyboard-first and composer-local. Do not add mouse-only toolbar controls. Do not use `/new`, because `/` belongs to agent-side commands and skill discovery in the harness.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/client.ts` | Drop already-queued raw events after `dispose()` by guarding `handleRaw()` with `this.disposed`. |
| `src/acp/acp-harness-view.ts` | Add lane reset helper, wire `#new`, `#new!`, and `#mem clear`, invoke `clear_harness_memory_lane` when requested, update help text. |
| `docs/72-acp-harness-view.md` | Document the new hash commands and edge cases. |
| `docs/05-data-flow.md` | Add the lane fresh-session flow if the command is implemented. |
| `docs/PROGRESS.md` | Add a Recent Landings note after implementation. |

## Design

### Commands

| Command | Scope | Behavior |
|---------|-------|----------|
| `#mem` | Active lane | Print memory command hint; no state mutation. |
| `#new` | Active lane | Fresh ACP subprocess and empty visible lane state. Memory remains. |
| `#new!` | Active lane | Same as `#new`, then clear active lane's persisted harness memory. |
| `#mem clear` | Active lane memory | Clear active lane's persisted harness memory only. Transcript/session remain. |
| `#mcp` | Active lane | Print MCP endpoint/status for harness lanes. |

### Lane Reset Helper

Add one helper to avoid duplicating reset state:

```ts
private async newLaneSession(lane: HarnessLane, options: { clearMemory: boolean }): Promise<void>
```

The helper:

1. Refuses when `lane.status === 'busy'` or `lane.status === 'needs_permission'` with chip `lane busy - #cancel first`.
2. Cancels any pending shell command for that lane with `cancelShell(lane)` before disposal.
3. Increments `lane.spawnEpoch` before disposing the old client so late events can be identified.
4. Awaits `lane.client.dispose()` if present and sets it to `null`.
5. Clears draft/cursor, pending permissions, pending extractions, staged images, usage, session id, error, accept/reject-all flags, streaming ids, tool maps, seen ids, shell id, and support capability flags.
6. Replaces all mutable containers with fresh instances: `pendingPermissions`, `pendingTurnExtractions`, `stagedImages`, `toolTranscriptIds`, `toolCalls`, and `seenTranscriptIds`.
7. Preserves lane identity fields: `id`, `index`, `backendId`, `displayName`, and `accent`. Preserves `projectDir` at the harness level. Capability flags such as `supportsEmbeddedContext` and `supportsImages` are reset and re-derived from the next `initialize()` result.
8. Confirms there is no separate per-lane `events` array, autosaved composer draft, `startedAt`, or `lastActivityAt` field in the current implementation. If those fields exist by implementation time, they must be reset here or explicitly preserved in the implementation note.
9. Replaces transcript with one system row: `starting fresh <displayName>...`.
10. If `clearMemory` is true, calls `clear_harness_memory_lane` for `this.harnessMemoryId` and `lane.displayName`, then `refreshMemory()`. If memory is unavailable, refuse with chip `memory unavailable - use #new`; do not silently degrade to `#new`.
11. Calls `spawnLane(lane)`.

This helper does not touch other lanes, `fileTouchMap`, top-level harness memory session id, project cwd, or active lane selection.

### Event Race Guard

Add a `spawnEpoch: number` field to `HarnessLane`, initialized to `0` in `createLane()`. Every `spawnLane(lane)` captures `const spawnEpoch = lane.spawnEpoch` before registering its event callback:

```ts
client.onEvent((event) => {
  if (lane.spawnEpoch !== spawnEpoch || lane.client !== client) return;
  this.onLaneEvent(lane, event);
});
```

Also add an early return in `AcpClient.handleRaw()`:

```ts
if (this.disposed) return;
```

`AcpClient.dispose()` already unregisters the frontend listener and Rust sets `client.disposed` before suppressing later emits, but these two frontend guards handle callbacks that were already queued before disposal completed.

### Memory Clear Helper

Add:

```ts
private async clearActiveLaneMemory(lane: HarnessLane): Promise<void>
```

It requires `this.harnessMemoryId`, invokes `clear_harness_memory_lane`, refreshes memory and MCP stats, then shows chip `memory cleared for <lane>`. If memory is not initialized, show `memory unavailable`.

### Data Flow

```text
1. User types #new and presses Enter in the harness composer.
2. runHashCommand() clears the draft and calls newLaneSession(activeLane, { clearMemory: false }).
3. newLaneSession() refuses busy/permission lanes, otherwise disposes the current AcpClient.
4. The lane's UI state is reset to fresh mutable containers and a single starting row.
5. spawnLane() starts the same backend in the same projectDir and initializes a new ACP session.
6. render() updates the dashboard and composer.
```

For `#new!`, step 4 also clears persisted memory for `lane.displayName` before spawning the new session. For `#mem clear`, only the memory clear helper runs.

### UI Changes

Update help overlay Commands section:

```text
#new       start fresh active lane, keep memory
#new!      start fresh active lane and clear its memory
#mem       show memory command hint
#mem clear clear active lane memory only
#mcp       show MCP endpoint/status
```

Change bare `#mem` from a dead-end chip to a short transcript row or chip:

```text
memory commands: #mem clear, #mcp, Ctrl+M drawer
```

No new buttons, overlays, or config keys.

## Edge Cases

- **Lane is busy or needs permission:** refuse `#new` / `#new!`; user must `#cancel` first. This avoids racing `session/prompt` and late streamed updates against a replacement client.
- **Lane is starting:** refuse with `lane starting`; user can wait or close the harness.
- **Lane is error/stopped:** allow `#new`; it acts like a clean retry and clears the previous error transcript.
- **Memory clear fails:** keep the new session behavior for `#new!` only if the clear succeeds. If the clear fails, show the error chip and do not respawn, so `!` remains trustworthy.
- **No harness memory id:** `#new!` refuses with chip `memory unavailable - use #new`. It must not silently preserve memory.
- **Adapter persists its own external history:** Krypton still creates a new ACP subprocess/session. Provider-native restoration, if any, is adapter behavior outside harness control.
- **Other lanes have this lane's memory already injected in an active turn:** clearing memory does not retract already-sent prompt context.
- **Active lane has already received memory in an in-flight turn:** `#mem clear` affects future prompt packets only. If the lane is currently busy, the agent may still use memory that was injected before the clear.
- **Late event arrives from the disposed client:** `AcpClient.handleRaw()` drops events after `dispose()`, and harness callbacks check `spawnEpoch` plus client identity before mutating lane state.

## Open Questions

None. `#new!` refuses when memory is unavailable, and `#new` intentionally preserves `fileTouchMap` because recent write collision warnings are project-level safety context.

## Out of Scope

- Global `#new all` for all lanes.
- `/new` alias. Slash commands should continue to reach agents and skill discovery.
- Compacting/summarizing a lane before reset.
- Deleting provider-native session history outside Krypton.
- A UI confirmation prompt for `#new!`; the exclamation suffix is the confirmation convention.

## Resources

- [Claude Code slash commands](https://code.claude.com/docs/en/commands) — `/clear` starts a fresh conversation and has `/reset`, `/new` aliases.
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) — new agent threads and external-agent support model.
- [tmux Getting Started](https://github.com/tmux/tmux/wiki/Getting-Started) — `new-session` creates a separate session.
- [WezTerm `spawn_tab`](https://wezterm.org/config/lua/mux-window/spawn_tab.html) — spawning a fresh process while preserving cwd/domain-style options.
