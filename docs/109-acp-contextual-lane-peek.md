# ACP Contextual Lane Peek — Implementation Spec

> Status: Implemented (slice 1 contextual peek + slice 2 lane-pair activity heat)
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

Slice 2 activity heat touches the same frontend files only:

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add view-local lane activity samples, lane-pair heat derivation, interactive heat mode/window state, render helpers, and command handlers. |
| `src/styles/acp-harness.css` | Add compact heat strip, metric selector state, expanded heat rows, and reduced-motion-safe pulse styles. |
| `src/acp/acp-harness-view.test.ts` | Add heat score, token delta, tool-count windowing, degradation, and keyboard command tests. |
| `docs/72-acp-harness-view.md` | Document the heat strip after implementation. |
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
- **Peer dismiss preempt (spec 118)**: when the top-ranked candidate is a direct peer relation (priority ≤30, `payload.kind === 'peer'`), `bestLanePeekCandidate()` clears `dismissedAt` / `dismissedPriority` *before* calling `selectLanePeekCandidate()` — otherwise dismissal at the same priority tier would return `null` and the peek would stay hidden. See `docs/118-acp-peer-activity-ui.md`.

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

- The peek lives inside the **lane rail overlay** (`.acp-harness__lane-rail` — see `docs/111-harness-right-rail.md`), anchored top-right of the active lane and stacked below the plan slot.
- The rail container handles positioning (`position: absolute`, no `backdrop-filter`); the peek itself is a normal flex-flow child of its rail slot.
- It must not cover the composer, permission banner, or lane header.
- It reserves no permanent vertical transcript space (the rail is an overlay, not a reserved column).
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

## Slice 2: Interactive Activity Heat

### Goal

Make the peek more interactive without turning it into a global harness dashboard. The user should be able to glance at the **current lane pair** — active lane + peeked lane — and answer:

- Which side is hotter right now?
- Is the heat mostly tool calls, token/context growth, peer traffic, shell/process load, or permissions/errors?
- Did the heat happen in the last few seconds, the last few minutes, or across the session?

The heat surface is lane-pair-local. It never summarizes all lanes at once and does not replace lane switching, the resource metrics panel, or transcript inspection.

### State

View-local state on `AcpHarnessView`:

```ts
type LanePeekHeatMetric = 'auto' | 'tools' | 'tokens' | 'peer' | 'process' | 'alerts';
type LanePeekHeatWindow = '30s' | '5m' | 'session';

/** Ring-buffer row: poll-aligned CPU/RSS + usage.used for token deltas (not full per-metric tallies). */
interface LaneActivitySample {
  at: number;
  usageUsed: number | null;
  cpuPercent: number | null;
  rssMb: number | null;
}

interface LanePairHeatState {
  metric: LanePeekHeatMetric;
  window: LanePeekHeatWindow;
  expanded: boolean;
}

interface LanePairHeatSummary {
  metric: Exclude<LanePeekHeatMetric, 'auto'>;
  window: LanePeekHeatWindow;
  active: LaneHeatSide;
  peeked: LaneHeatSide;
  pairScore: number; // max(active.score, peeked.score)
  dominantSide: 'active' | 'peeked' | 'balanced';
  unavailableReason: string | null;
  deltaLine: string; // compact summary line under the bars
}

interface LaneHeatSide {
  laneId: string;
  displayName: string;
  score: number; // 0..100
  toolDelta: number;
  tokenDelta: number | null;
  peerDelta: number;
  permissionDelta: number;
  errorDelta: number;
  cpuPeak: number | null;
  label: string;
}
```

Exported types and `deriveLanePairHeat` live in `src/acp/acp-harness-view.ts` and should match this block.

Samples are in-memory only. Keep a small ring buffer per lane, capped at 10 minutes or 240 samples, whichever is smaller. Each sample records **time, context usage (`used` when present), CPU %, and RSS** from the existing metrics poll path; tool, peer, permission, and error activity for a window are **not** duplicated into every sample — they are derived from transcript tails plus current lane fields (`usage.*`, `mcp.toolsCallCount`, `toolCalls`, pending peer counts, etc.) when computing heat. Session totals should come from monotonic lane state where available and from transcript reconstruction only for event kinds that have timestamps (`tool`, `inter_lane`, `permission`, `provider_error`, `shell`). Do not combine both sources for the same counter in the same window.

### Metric Sources

Use existing frontend state first:

| Metric | Primary source | Notes |
|--------|----------------|-------|
| Tool calls | `lane.toolCalls.size`, transcript `tool` rows, MCP `toolsCallCount` deltas | Prefer completed/in-progress event deltas over raw map size when transcript timestamps are available. |
| Tokens | `lane.usage.inputTokens`, `outputTokens`, `used`, `cachedReadTokens`, `cachedWriteTokens` | Use deltas within the selected window. If only `used` exists, label as context growth. If no usage exists, show `tokens --`. |
| Peer | `pendingPeers`, `inboxDepth`, recent `inter_lane` rows | Count sends, receives, pending waits, and inbox changes. |
| Process | `AcpLaneMetrics.total_cpu_percent`, `total_rss_mb` | Reuse the metrics poll. CPU is heat; RSS is supporting detail, not primary heat. |
| Alerts | permission, error, shell, peer, and busy status | Auto mode can select this blended alert score when blocking/attention state dominates. |

Do not add Rust or ACP protocol changes for slice 2. If an adapter does not emit usage, the UI degrades to tools/peer/process heat and clearly marks tokens unavailable.

Precedence rules:

1. Windowed tool deltas use transcript `tool` rows with timestamps when present.
2. MCP `toolsCallCount` deltas are the fallback for tool activity when transcript timestamps are missing.
3. `lane.toolCalls.size` is a session fallback only; do not use it as a 30s/5m delta.
4. Token deltas use monotonic usage counters between samples. If providers report usage in batches, clamp a single-window token jump to the lane's current `usage.used` and let the next sample settle the display.
5. Process heat samples at the existing metrics poll interval. A 30s CPU peak is the max observed poll sample in that window, not a sub-second profiler.

For recompute paths that must inspect transcript history, cap tail scans at the newest 200 transcript items per lane. Older activity is represented through the ring buffer or session totals.

### Heat Scoring

Scores are normalized per selected window:

```text
toolScore     = clamp01(toolDelta / 8)
tokenScore    = clamp01(log10(max(tokenDelta, 0) + 1) / 4)   // 10k tokens ~= full heat
peerScore     = clamp01((peerDelta + pendingPeerWeight) / 6)
processScore  = clamp01(cpuPeak / 100)
alertScore    = max(permissionBoost, errorBoost, shellBoost, awaitingPeerBoost)
autoScore     = max(toolScore, tokenScore, peerScore, processScore, alertScore)
```

Weights and boosts:

- pending peer weight: `2` per outstanding peer wait.
- tool score: `8` tool events in the selected window is full heat.
- token score: about `10k` token growth in the selected window is full heat.
- peer score: about `6` peer events/weighted waits in the selected window is full heat.
- permission waiting: at least `70`.
- error: `100`.
- active shell: at least `55`.
- awaiting peer: at least `65`.

`auto` resolves to the highest contributing non-zero metric for the current pair. `alerts` is the blended blocking-state metric; use it when permissions, errors, active shells, or peer waits dominate. This keeps command labels distinct: `auto` chooses what to show, while `alerts` is one selectable metric.

Bars show the selected metric's score. In `auto`, bars show the winning metric's score and the delta line names that metric, for example `alerts permission vs idle` or `tools 6 vs 2`. This avoids showing an alert-saturated bar next to an unrelated tool-count label. `pairScore` is the max side score and is used only for CSS intensity; it is not rendered as a third number.

### UI

Add a compact heat strip to the bottom of the peek, above existing stat chips. Default rendering must stay to one line plus one terse delta; expanded rows appear only after `ACP: Toggle Peek Heat Detail` or a click on the strip.

```text
heat auto · 5m   active ███████░ 72   peek ███░░░░░ 31   tools 6 vs 2
```

Default compact mode:

1. `heat` prefix.
2. Current metric and window.
3. Two side-by-side bars: active lane first, peeked lane second.
4. One terse delta label for the selected metric, for example `tools 6 vs 2`, `tokens +12.4k vs --`, `peer 2 vs 1`, or `cpu 84% vs 12%`.

Expanded mode adds up to four rows:

```text
tools   6          2
tokens  +12.4k     +3.1k
peer    2          1
cpu     84%        12%
```

The expanded rows are still summaries, not transcript rows. No command output, diffs, prompts, or assistant text are embedded.

Visual rules:

- Use existing lane accent colors for each side.
- Heat bars must have stable dimensions so changing counts does not resize the peek.
- Use fixed labels `active` and `peek` in compact mode; put full lane names in `title` text and expanded detail to avoid widening the rail unpredictably.
- Abbreviate large counts with `formatCount()` and keep compact deltas under 24 characters where practical.
- Use opacity/intensity changes, not blur.
- No hover-only controls. Tooltips can explain exact numbers, but all actions need command-palette access.
- Do not rely on color alone: active side is always first, peeked side is always second, and expanded rows include text labels.
- Respect reduced motion. If a heat value changes, a short opacity flash is allowed only outside `prefers-reduced-motion: reduce`.

### Interaction

Command-palette actions:

| Command | Action |
|---------|--------|
| `ACP: Cycle Peek Heat Metric` | `auto → tools → tokens → peer → process → alerts → auto`. |
| `ACP: Cycle Peek Heat Window` | `30s → 5m → session → 30s`. |
| `ACP: Toggle Peek Heat Detail` | Expand/collapse the heat rows. |

The commands operate only when a lane peek is visible. If no peek is visible, flash `no lane peek candidate`, matching the existing peek command behavior.

Mouse support is optional and secondary:

- Click metric label cycles metric.
- Click window label cycles window.
- Click heat strip toggles expanded detail.

Keyboard behavior remains the contract; mouse interactions cannot be the only way to reach the feature.

### Lane-Pair Semantics

The pair is always:

```text
active lane  +  currently peeked lane
```

When the peek candidate changes, heat recomputes immediately for the new pair. Dwell/lock rules still control which lane is peeked; heat never changes lane selection by itself. If a manual lock pins the peek to a lane, heat follows that locked pair.

Default window is `5m`, except direct peer-relation candidates (`awaiting-peer`, `inbound-peer`, `peer-counterpart`) should default to `30s` for the first render of that pair so rapid back-and-forth feels live. User-selected window overrides the contextual default for the rest of the harness session.

For a direct peer relation, the heat strip should emphasize peer/tool/token contrast between the active sender and the peeked recipient. For unrelated permission/error candidates, heat is still useful but secondary to the blocking reason.

### Slice 2 Data Flow

```text
1. ACP event, transcript append, usage update, MCP stats poll, or process metrics poll arrives.
2. AcpHarnessView records a LaneActivitySample for the affected lane.
3. Peek candidate selection chooses the current non-active lane as in slice 1.
4. deriveLanePairHeat(active, peeked, metric, window, now) computes side summaries.
5. renderLanePeek() appends compact heat strip; expanded rows render only when enabled.
6. Command-palette actions mutate metric/window/expanded state and re-render the peek.
```

Sampling should be debounced to existing render cadence. Do not introduce a high-frequency timer just for heat; reuse ACP event renders and the existing metrics poll.

### Slice 2 Configuration

No TOML config in slice 2. The heat strip is visible when a peek is visible. User-selected metric/window/detail state is session-local and resets with the harness tab.

### Slice 2 Testing

- Tool heat: transcript/tool deltas in a 5-minute window produce expected `toolDelta` and score.
- Token heat: usage deltas produce expected labels; missing usage renders `tokens --` without `NaN`.
- Peer heat: pending peer + inbox + `inter_lane` rows contribute to peer score.
- Process heat: CPU peak drives process score; RSS appears only as supporting detail.
- Auto metric: picks the strongest available metric and falls back to alerts when only permission/error state exists.
- Windowing: 30-second, 5-minute, and session windows produce different deltas from the same samples.
- Pair switch: changing the peeked lane recomputes heat for active+new peeked lane.
- Manual lock: heat follows the locked peek lane.
- Commands: cycle metric, cycle window, and toggle detail mutate state and preserve existing peek visibility rules.
- Alert dominance: permission/error boosts saturate bars while tiny tool deltas remain visible only in expanded rows or non-auto metric modes.
- Render: heat strip has stable bar dimensions and never renders transcript body content.

### Slice 1 Data Flow

```text
1. Lane status, transcript, permission, peer, or inbox state changes.
2. AcpHarnessView schedules/render computes peek candidates from current lanes.
3. Candidate ranking filters out active/stopped lanes and applies priority/tie-breakers.
4. Stickiness/lock rules decide whether to keep or replace current peek lane.
5. If no candidate remains, peek is not rendered.
6. If candidate exists and visible, render the lane-local summary.
7. User can hide, cycle, lock, unlock, or activate through command palette / Esc.
```

### Slice 1 Configuration

No TOML config in slice 1. The peek is an ACP harness behavior, session-local and dismissible.

### Slice 1 Testing

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
- `docs/prototypes/109-lane-peek-heat-prototype.html` — static HTML mock for slice 1 + slice 2 layout and heat interaction (open in a browser).
