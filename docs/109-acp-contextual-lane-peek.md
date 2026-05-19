# ACP Contextual Lane Peek — Implementation Spec

> Status: Implemented
> Date: 2026-05-19
> Milestone: Post-M-current polish

## Problem

ACP harness users can run multiple lanes at once, but non-active lanes collapse to compact rows. Those rows are good for layout density, but they cannot explain why a hidden lane matters now: peer reply, incoming inbox, permission, error, or related file activity. A global overview would mix lane contexts, while stuffing more text into collapsed rows would make them unreadable.

## Solution

Add a hideable **peek** for exactly one non-active lane. The peek is automatically chosen from the active lane's current interaction context, with keyboard commands for manual override. It shows a concise lane-local summary near the active lane without switching active lanes, and disappears when no non-active lane qualifies.

Terminology: use **peek** throughout. Avoid "overlay" in user-facing labels because it implies a modal surface; this feature is a non-blocking peek.

## Research

- `AcpHarnessView` already renders active and collapsed lane heads through `renderLaneHead()`, with status, inbox chip, lane activity, model/mode/MCP/sandbox/metrics chips, and `pendingPeersFor()` input.
- Collapsed row text is already dense. Adding multi-field activity there would compete with existing status, inbox, metrics, and model chips.
- Peering state from `InterLaneCoordinator` is the strongest source for contextual relevance. It exposes inbox depth and pending peer summaries, but it does not yet expose enough history to infer "latest peer sender" without inspecting transcript rows.
- Permission rows now carry structured `PermissionPayload` in transcript items. That gives the peek a safe compact source for "permission required" without cloning full cards.
- The active lane already has transcript context; the missing context is hidden non-active lanes.
- Zed's Agent Panel supports multiple independent agent threads in a sidebar, thread switching, queued messages, tool indicators, and review surfaces. Krypton differs by hosting simultaneous live lanes in one harness and needing contextual lane peeks rather than a full thread sidebar.
- Visual Studio Peek Definition keeps the user in the current editor while showing related content, supports Esc to close, promotion to a regular tab, and navigation among multiple results. Krypton's peek borrows the "inspect without switching" model, but keeps it lane-local and non-editable.
- Zellij floating panes show that terminal UIs can use hideable, keyboard-addressable floating surfaces. Krypton should borrow the hide/show + keyboard accessibility property, not the multi-pane floating workspace model.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Visual Studio Peek Definition | Inline peek window shows related code without switching away; Esc closes; shortcuts navigate multiple results and promote to a tab. | Strong precedent for "inspect without changing primary context." Krypton's peek is read-only and lane-state focused. |
| Zed Agent Panel | Multiple agent threads can run independently; users switch threads from a sidebar or switcher, and tool/review state is surfaced inside the agent UI. | Similar multi-agent pressure, but Zed uses explicit thread navigation instead of contextual lane peeking. |
| Zellij | Floating panes can be toggled, focused, moved, and pinned with keyboard paths. | Precedent for terminal-native hideable surfaces. Krypton should avoid turning peek into a second pane. |
| Current Krypton ACP Harness | Collapsed lane rows show status/activity, inbox depth, chips, and warning/error styles; active lane shows transcript details. | Good foundation, but hidden lane context is too compressed. |

**Krypton delta** — Krypton keeps one active lane transcript visible and shows one inferred non-active lane peek. It intentionally avoids a global mixed-lane dashboard and avoids stuffing detailed activity into collapsed rows.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add peek candidate derivation, dwell/lock state, render path, command handling, and transcript-derived summaries. |
| `src/acp/inter-lane.ts` | Optionally expose recent peer sender/recipient metadata if transcript inspection is insufficient. |
| `src/acp/types.ts` | Add view-local exported types only if tests or coordinator need them. |
| `src/styles/acp-harness.css` | Add non-blocking peek surface styles, narrow-width behavior, and reduced-motion-safe transitions. |
| `src/acp/acp-harness-view.test.ts` | Add relevance ranking, tie-breaker, dwell/lock, empty-state, and render-signature tests. |
| `docs/72-acp-harness-view.md` | Document the peek behavior and keyboard commands after implementation. |
| `docs/106-inter-lane-messaging.md` | Cross-reference peer-triggered peek behavior after implementation. |
| `docs/107-acp-harness-transcript-readability.md` | Cross-reference permission-card summaries after implementation. |
| `docs/PROGRESS.md` | Add landing note after implementation. |

## Design

### State

View-local state on `AcpHarnessView`:

```ts
interface LanePeekState {
  visible: boolean;
  dismissedAt: number | null;
  dismissedPriority: number | null;
  lockedLaneId: string | null;
  currentLaneId: string | null;
  currentReasonKey: string | null;
  selectedAt: number;
}

interface LanePeekCandidate {
  laneId: string;
  displayName: string;
  priority: number;
  reasonKey: string;
  reasonLabel: string;
  summary: LanePeekSummary;
  at: number;
}

interface LanePeekSummary {
  status: HarnessLaneStatus;
  headline: string;
  detail: string | null;
  payload:
    | { kind: 'permission'; toolName: string; subject: string; decision: string }
    | { kind: 'peer'; direction: 'in' | 'out' | 'awaiting'; peerDisplayName: string; ageLabel: string }
    | { kind: 'error'; message: string }
    | { kind: 'activity'; label: string; ageLabel: string }
    | null;
}
```

`LanePeekState` is in-memory only. It resets on harness tab close, app restart, and `#new` / `#new!`. No TOML config and no persistence in slice 1.

### Relevance Ranking

Only non-active, non-stopped lanes can become candidates. If the active lane is missing or no candidate qualifies, hide the peek.

Priority order:

1. **Direct awaiting peer recipient** — active lane is `awaiting_peer`; show the oldest pending peer target from `pendingPeersFor(activeLane.id)`.
2. **Direct inbound peer sender** — active lane has pending inbox or latest `inter_lane` inbound row from a non-active lane; show the sender.
3. **Peer conversation counterpart** — active lane's latest outbound `inter_lane` row targets a non-active lane that is busy, awaiting, or recently active; show the recipient.
4. **Related permission** — a non-active lane is `needs_permission`, and its permission subject/path matches recent active-lane file activity or active transcript path references.
5. **Non-active error** — a non-active lane is `error`.
6. **Non-active permission** — any non-active lane is `needs_permission`.
7. **Non-active inbox** — any non-active lane has inbox depth > 0.
8. **Recent meaningful activity** — latest non-active transcript item of kind `tool`, `permission`, `inter_lane`, `shell`, `fs_activity`, or `fs_write_review` within 5 minutes.

Tie-breaker:

1. Higher priority wins.
2. Direct relation to active lane wins over unrelated attention.
3. Newer candidate timestamp wins.
4. Existing `currentLaneId` wins if still valid, to reduce churn.
5. Visual lane order wins as final deterministic fallback.

### Direction Rules

Peer direction must be explicit:

- Active sent `peer_send` and is waiting: peek target is the recipient.
- Active received a peer message: peek target is the sender.
- A non-active lane sent to active and is now `awaiting_peer`: peek target can be that sender, because it is waiting on the active lane's eventual reply.
- Synthetic harness notices (`__harness__`) never become peek targets.

### Stickiness

To avoid flapping, automatic candidate changes have a minimum dwell:

- Default dwell: 8 seconds.
- A new candidate can preempt immediately only if its priority is at least 2 levels higher than the current candidate, or if the current candidate becomes invalid.
- Manual lock disables automatic candidate switching until unlocked, active lane changes, the locked lane becomes active/stopped, or the user dismisses the peek.
- Dismissal stores the dismissed candidate priority so same-or-lower priority candidates remain suppressed even if the original candidate drops out. Higher-priority candidates can re-open the peek.

### Manual Keyboard Surface

Slice 1 adds command-palette actions, not new global chords:

| Command | Action |
|---------|--------|
| `ACP: Show Lane Peek` | Show the best current candidate, if any. |
| `ACP: Hide Lane Peek` | Hide peek for the current harness tab until a new higher-priority reason appears. |
| `ACP: Peek Next Lane` | Manual override to next eligible non-active candidate. Locks peek to that lane. |
| `ACP: Peek Previous Lane` | Manual override to previous eligible non-active candidate. Locks peek to that lane. |
| `ACP: Activate Peeked Lane` | Switch active lane to the peeked lane and close peek. |
| `ACP: Unlock Lane Peek` | Return from manual lock to automatic relevance selection. |

`Esc` hides the peek when the peek is visible and no permission banner is active. It must not steal `Esc` from pending permission resolution.

### Visibility

Default behavior:

- Show automatically when a candidate exists.
- Hide when no candidate exists.
- Hide when the candidate lane becomes active.
- Hide on narrow layouts where it would obscure transcript text; collapsed row status remains.
- User dismissal is session-local. It suppresses same-or-lower-priority candidates until active lane changes or a higher-priority candidate appears.

### UI

Placement:

- The peek is positioned inside the active ACP lane shell, anchored top-right over the transcript region.
- It must not cover the composer, permission banner, or lane header.
- It reserves no permanent vertical transcript space.
- It uses `position: absolute` inside the active lane shell and no `backdrop-filter`.
- It must not compete with #104 titlebar HUD; the peek lives inside ACP content, while #104 HUD lives in native window chrome/titlebar.

Shape:

```text
Claude-1        peer · 1m+
reason          awaiting reply
status          awaiting peer
detail          sent review request to Codex-1
```

Fields:

1. Lane display name.
2. Status label.
3. One-line reason/headline.
4. One optional structured payload:
   - permission: tool + subject + decision
   - peer: direction + peer name + coarse age
   - error: short error message
   - activity: label + coarse age

The peek is not a mini-transcript. It shows at most one payload and never embeds full diffs, command output, or long assistant text.

### Existing Surfaces

Keep:

- Collapsed-row status and symbol.
- Inbox depth chip.
- Tab-strip permission/error badges.
- Active lane transcript details.

Peek adds:

- A readable explanation for one selected non-active lane.
- Contextual reason why that lane is relevant now.
- Keyboard path to activate the peeked lane.

Do not remove existing chips in slice 1. Deduplication can happen after user testing.

### Data Flow

```text
1. Lane status, transcript, permission, peer, or inbox state changes.
2. AcpHarnessView schedules/render computes peek candidates from current lanes.
3. Candidate ranking filters out active/stopped lanes and applies priority/tie-breakers.
4. Stickiness/lock rules decide whether to keep or replace current peek lane.
5. If no candidate remains, peek is not rendered.
6. If candidate exists and visible, render the lane-local summary.
7. User can hide, cycle, lock, unlock, or activate through command palette / Esc.
```

### Configuration

No TOML config in slice 1. The peek is an ACP harness behavior, session-local and dismissible.

### Testing

- Ranking: each priority produces expected lane.
- Tie-breakers: recency, current candidate stickiness, visual order.
- Direction: outbound awaiting peer picks recipient; inbound peer picks sender.
- Empty state: no candidates renders nothing.
- Dwell: lower/equal priority candidate cannot replace current before 8 seconds.
- Preemption: much higher priority candidate replaces current immediately.
- Manual lock: next/previous locks, unlock resumes automatic selection.
- Permission precedence: `Esc` does not hide peek when permission prompt owns `Esc`.
- Render: peek contains only one payload and no transcript body cloning.

## Edge Cases

- **Only one lane:** no non-active candidate; no peek.
- **All other lanes stopped:** no peek.
- **Candidate becomes active:** close peek.
- **Candidate closes:** clear lock/current candidate and recompute.
- **Multiple pending peers:** oldest direct pending peer wins; count can be shown in title text later, not in slice 1 UI.
- **Narrow active lane:** hide peek automatically rather than covering transcript text.
- **Permission prompt active:** permission composer remains primary; peek can render but `Esc` belongs to permission handling.
- **Reduced motion:** no animated entrance; opacity/position changes are instant or use existing reduced-motion policy.

## Scope Decisions

- Shared state vocabulary for palette/HUD consumers is deferred. Slice 1 can use view-local types.
- No persistent user preference in slice 1.
- No mouse-only hover behavior.
- No global mixed-lane overview.
- No full transcript row focus; that remains a separate #108 item.
- No permission card expansion; peek only summarizes one permission.

## Open Questions

None blocking this draft. User approval should focus on whether the automatic ranking, 8-second dwell, and command-palette-first keyboard surface are acceptable.

## Out of Scope

- Editing or responding inside the peek.
- Showing more than one lane at a time.
- Showing a global harness health dashboard.
- Replacing lane switching.
- Replacing existing collapsed-row chips or tab badges.
- Persisting peek state across app restart.
- Implementing #104 HUD numerics or display flash.

## Resources

- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) — multiple agent threads, thread switching, tool indicators, review/change surfaces, and keyboard thread navigation.
- [Visual Studio Peek Definition](https://learn.microsoft.com/en-us/visualstudio/ide/how-to-view-and-edit-code-by-using-peek-definition-alt-plus-f12?view=visualstudio) — inspect related content without switching primary context, Esc close, result navigation, and promotion to tab.
- [Zellij Basic Development](https://zellij.dev/tutorials/basic-functionality/) — keyboard-addressable floating panes and hide/show behavior in a terminal UI.
- `docs/106-inter-lane-messaging.md` — peering status, awaiting-peer lifecycle, inbox behavior.
- `docs/107-acp-harness-transcript-readability.md` — structured permission cards and harness event vocabulary.
