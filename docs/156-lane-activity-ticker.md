# Lane Activity Ticker — Implementation Spec

> Status: Implemented
> Date: 2026-06-12
> Milestone: ACP Harness polish

## Problem

During a long turn the composer status chip shows only a static verb and an elapsed
timer (`Claude-1 running · 8:23 · Ctrl+C cancel`). The user has no signal of what the
agent is actually doing right now, which makes long waits feel dead — the only options
are staring at a counter or scrolling the transcript.

## Solution

Extend the busy branch of the composer status chip with a **live activity segment**
derived from events the harness already receives: the in-flight tool call title,
thinking/writing streaming state, and a running output-token counter. No new timers,
no new events, no sound — the existing 1 s composer tick re-reads lane state and
repaints the chip. Example:

```
Claude-1 running · 8:23 · ⚒ Edit src/acp/types.ts · 12.4k tok · Ctrl+C cancel
Claude-1 running · 8:24 · thinking… · 12.6k tok · Ctrl+C cancel
```

Superseded shape — spec 221 kept the activity segment (it is the row's only leading
indicator) and deleted everything around it that another surface already prints: the
lane name, the token count, the cancel hint and the generic `running` verb. Spec 231
then moved the activity itself off the composer and into a rail action HUD; that HUD
is now removed. The chip is `HANDLING PEER · 8:24` (verb + elapsed). A busy peeked
lane shows a flat `tool` row. See `docs/221-harness-status-line-density.md`
and `docs/231-lane-peek-action-hud.md`.

## Research

- `composerStatusChip()` (`src/acp/acp-harness-view.ts:7221`) builds the busy line;
  it is re-rendered every 1 s by `updateComposerTick()` (line 7246) whenever any lane
  is busy — the refresh loop we need already exists.
- All needed signals already flow through `onLaneEvent()` (line 3857): `tool_call` /
  `tool_call_update` (title, kind, status), `thought_chunk` / `message_chunk`
  (streaming state), `usage` (merged into `lane.usage`, line 3893).
- Tool objects are already cached in `lane.toolCalls`; `formatCount()` already
  formats token counts for the metrics panel (line 10565); `truncate()` exists.
- Streaming chunk handlers and `tool_call` / `tool_call_update` skip full
  re-renders (`needsRender = false`; spec 114 body-only RAF) — the activity
  setter must follow suit: **field writes only**, let the 1 s tick paint the
  composer chip. Tool events still patch the transcript row and the peek tool row.
  No per-chunk chrome rebuild.
- Alternative considered: rotating flavor verbs (Claude Code style "Reticulating
  splines…"). Ruled out — pure decoration; the user chose real signal over whimsy.
- Alternative considered: completion sound. **Explicitly rejected by user.**

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code CLI | Spinner + gerund + `(esc to interrupt · Ns · ↓ N tokens)` status line; live token counter ticks during the turn | Closest match; tool names stay in transcript, not in the status line |
| Codex CLI | "Working" header with elapsed time + esc hint; tool calls render inline in the transcript | No tool name in the status line |
| Zed agent panel | In-progress tool call rows with spinner inside the thread; panel-level "Generating…" label | Activity lives in the transcript, not a footer |
| Cursor | "Generating…" label, per-step cards in the chat | No persistent elapsed/token footer |

**Krypton delta** — Krypton already diverges by having a persistent per-lane status
chip; this spec moves the *current* activity into it because the transcript may be
scrolled away and the chip is the one always-visible surface. Matches Claude Code's
live token counter convention. Text-only, keyboard-first, no new animation (the
existing braille spinner already conveys liveness).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | `LaneActivity` type + `activity` field on `HarnessLane` (init in lane creation); setters in `onLaneEvent` / streaming path; render in `composerStatusChip()`; clear in `finishTurn()` and the `error` handler |
| `docs/72-acp-harness-view.md` | Document the activity segment of the status chip |
| `docs/PROGRESS.md` | Milestone note |

## Design

### Data Structures

```ts
type LaneActivityKind = 'tool' | 'thinking' | 'writing';

interface LaneActivity {
  kind: LaneActivityKind;
  /** tool title (preferred) or kind; empty for thinking/writing */
  label: string;
}

// HarnessLane gains:
activity: LaneActivity | null;   // null between turns
```

### Data Flow

```
1. tool_call / tool_call_update arrives (status pending|in_progress)
   → lane.activity = { kind: 'tool', label: call.title ?? call.kind ?? 'tool' }
2. thought_chunk arrives → lane.activity = { kind: 'thinking', label: '' }
3. message_chunk arrives → lane.activity = { kind: 'writing', label: '' }
   (steps 1–3 are field writes only; no render call — perf rule above)
4. usage arrives → already merged into lane.usage (no change)
5. Every 1 s the composer tick calls renderComposer() → composerStatusChip()
   reads lane.activity + lane.usage and repaints the chip
6. stop/error → finishTurn()/error handler set lane.activity = null
```

A completed tool's label persists only until the next thought/message chunk or tool
call replaces it — no completion-status bookkeeping needed.

### Rendering (busy branch of `composerStatusChip`)

```
${displayName} ${verb}${elapsed}${activity}${tokens}${queued} · Ctrl+C cancel
```

- `activity`: ` · ⚒ ${truncate(label, 32)}` for tools; ` · thinking…` / ` · writing…`
  for streams. Omitted when `lane.activity === null`.
- `tokens`: ` · ${formatCount(lane.usage.outputTokens)} tok`, omitted when usage or
  `outputTokens` is absent (backends without usage events).
- Plain text inside the existing chip span — **zero CSS changes**, no new DOM nodes,
  no left accent borders.

### Keybindings

None — display only.

### Configuration

None — always on; cost is one string concat per 1 s tick.

## Edge Cases

- **Custom-command turns** (`#review` → `activeSystemLabel`): verb stays (e.g.
  `reviewing`), activity segment appends after it unchanged.
- **Transient chip override** (`this.chip`): still takes precedence; untouched.
- **Up to 1 s staleness** on activity transitions — accepted; same cadence as the
  elapsed timer.
- **Very long tool titles** (full paths): hard-truncated at 32 chars so the chip
  stays one line.
- **Cancel (Ctrl+C)** routes through `finishTurn` → activity cleared with
  `activeTurnStartedAt`.
- **Queued-prompt count** and permission/awaiting-peer branches unchanged.

## Open Questions

None.

## Out of Scope

- Sound cues of any kind (rejected by user).
- Activity for non-active lanes (lane headers already have spinner + tool timers).
- Plan-progress summary (`3/7 done`) in the chip.
- Flavor/whimsy verb rotation.
- Input-token / cost display (metrics panel already covers it).

## Resources

- N/A — purely internal change. Prior-art column drawn from direct product
  observation of Claude Code CLI, Codex CLI, Zed agent panel, and Cursor; no
  external docs consulted.
