# ACP Harness Plan Tracking — Implementation Spec

> Status: Implemented
> Date: 2026-05-07
> Milestone: ACP harness review surfaces (continues 87/88/89)

## Problem

ACP agents (Claude, Gemini, Codex) emit `session/update` notifications with `sessionUpdate: "plan"`, carrying a checklist of work items the agent intends to do (`entries[]` with `status` and `priority`). Today the harness renders each plan update as a regular transcript item via `appendTranscript('plan', ...)`. That means:

- Each plan revision adds a new card to the scroll log; the *current* state of the plan is whichever card happens to be latest, and you have to scroll to find it.
- Once new tool calls/messages arrive after a plan, the plan scrolls out of view — exactly when the user most wants to know "what is the agent actually doing right now?".
- Multi-revision plans accumulate as duplicate-looking cards (same items, one row toggled).

The harness needs a **persistent at-a-glance** view of the agent's current plan, not buried history.

## Solution

Add a per-lane **floating plan panel** absolutely positioned at the top-right of the active lane's transcript region. The panel hovers over the transcript (does not push it down), has a fixed max-width, and is collapsible. Each new `plan` event *replaces* the panel's contents in place rather than appending a new card. The panel auto-hides when the lane has no plan, and clears when a session restart starts a fresh lane. The legacy inline `appendTranscript('plan', ...)` call is removed — the panel becomes the single surface for plan state.

This matches the existing render pattern of mode/status (persistent state rendered outside the transcript) and the floating-overlay precedent set by the memory overlay, and aligns with how IDE-style agent UIs (Cursor, Zed) surface active plans without consuming the main reading column.

## Research

**Event flow is already wired end-to-end.** From the explore pass:

- Rust `src-tauri/src/acp.rs:605-636` already matches `"plan"` inside `session/update` and forwards via `client.emit_event`.
- TS client `src/acp/client.ts:204-208` converts to `AcpEvent { type: 'plan'; entries: PlanEntry[] }`.
- Harness handler `src/acp/acp-harness-view.ts:773-775` calls `this.renderPlan(lane, event.entries)`.
- `renderPlan` (line 1666-1669) currently maps entries to `[ ] / [~] / [x]` lines and calls `appendTranscript(lane, 'plan', text)`.

So the only changes are: (a) store entries on the lane, (b) render to a new DOM region instead of the transcript, (c) remove the inline append, (d) reset on dispose/restart.

**Lane state already carries similar persistent fields**: `currentMode`, `availableCommands`, `modesById`, `usage`, `pendingPermissions`. Adding `plan: PlanEntry[] | null` follows the established convention (line 116-152).

**Layout — where to mount.** The harness DOM (line 425, `buildDOM`) is roughly:

```
.acp-harness
├── .acp-harness__topbar
├── .acp-harness__body  (position: relative, flex 1)
│   ├── .acp-harness__dashboard  (the lane transcript)
│   ├── .acp-harness__memory-overlay  (aside, hidden)
│   └── .acp-harness__help-overlay    (aside, hidden)
└── .acp-harness__command-center / __composer
```

Mount points considered:

1. **Floating overlay inside `.acp-harness__body`**, absolutely positioned `top:8px; right:8px` — uses the existing `position: relative` on `__body` and follows the memory-overlay/help-overlay precedent already in the DOM. **Chosen** per user direction.
2. Sibling strip above `.acp-harness__dashboard` (full-width) — eats vertical space from the transcript.
3. Inside `.acp-harness__topbar` — too crowded; plans can be 5–15 lines and would dwarf the topbar.

The floating choice does occlude a slice of the transcript's top-right corner. The transcript content is left-aligned text; the right edge is mostly whitespace except for occasional scrollbar/timestamps. The panel uses a translucent cyberpunk-styled background (no `backdrop-filter: blur` per the platform gotcha) and can be collapsed with a single keypress when occlusion is undesired.

**Mode chip is *not* a precedent for "pinned panel".** Spec 87's mode chip is a 2-second TTL flash rendered inside `.acp-harness__composer-meta` — not pinned. The closest existing precedent is the legacy `acp-view.ts` plan rendering (line 779-794) which uses `querySelector('.acp-view__plan')` + `innerHTML` replace, but it appends to the transcript scroll container. We adopt its replace-in-place pattern but mount outside the transcript.

**Per-lane storage, single visible panel.** The harness shows one focused lane at a time (`activeLane()`); each lane keeps its own plan, and switching lanes re-renders the panel from that lane's stored plan. This mirrors how `transcript`, `pendingPermissions`, `currentMode` are scoped.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code (TodoWrite) | Always-visible todo list rendered inline at the top of each turn; persists across the conversation | Closest UX target — pinned, sticky, replace-in-place |
| Cursor | "Composer" agent has a persistent task list panel above the chat; checkboxes update in place | Right-side panel rather than top, but same replace-in-place semantics |
| Zed agent panel | Streams plan updates in a dedicated section above the transcript | Pinned, collapsible |
| GitHub Copilot Workspace | Session-level plan rendered as a sidebar; one source of truth, edits in place | More elaborate (editable plans); we don't go there |
| Krypton legacy `acp-view.ts` | `renderPlan` does replace-in-place via `querySelector` but mounts inside `messagesEl` (scrolls away) | We borrow the replace-in-place idea, mount outside transcript |

**Krypton delta** — match the IDE convention (pinned, replace-in-place, status icons). Diverge by:
- No mouse interaction; no inline-edit. Plans are read-only display.
- Cyberpunk styling consistent with mode chip / fs review cards (bordered card, monospaced rows, status-colored boxes — green completed, amber in-progress, dim pending).
- Collapsible via single keypress (no chord) since the harness already has a tight keyboard surface.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add `plan: PlanEntry[] \| null` and `planCollapsed: boolean` to `HarnessLane`; init in `createLane`; clear on `disposeLane` / restart; new `renderPlanPanel(lane)` method; mount `.acp-harness__plan` element inside `.acp-harness__body` (sibling to `__dashboard`, after the existing overlays) in `buildDOM`; rewrite `renderPlan` to store + call `renderPlanPanel` instead of `appendTranscript`; add `'p'` keybinding in command-mode (transcript focus) to toggle collapse; wire `renderPlanPanel` calls into existing render passes (lane switch, plan event) |
| `src/acp/acp-harness-view.ts` | Remove `'plan'` from `HarnessTranscriptItem.kind` (no longer used); remove the plan branch in transcript render switch |
| `src/styles/acp-harness.css` | New `.acp-harness__plan*` BEM classes (~60 lines) — container, header (title + count + collapse hint), entry rows, status icons, priority accents, empty/collapsed states |
| `docs/04-architecture.md` | Add §26 "ACP Harness plan panel" entry; bump renumbering if needed |
| `docs/05-data-flow.md` | Add a new step: plan event → lane storage → panel render (replaces current "plan as transcript item") |
| `docs/PROGRESS.md` | Recent Landings entry |

No Rust changes, no IPC changes, no test changes (existing event plumbing already covered).

## Design

### Data Structures

Extend `HarnessLane` (file: `src/acp/acp-harness-view.ts:116`):

```ts
interface HarnessLane {
  // ...existing fields...
  plan: PlanEntry[] | null;       // null = no plan ever received; [] = explicit empty plan
  planCollapsed: boolean;         // user toggle, default false
}
```

`PlanEntry` already exists in `types.ts` and matches ACP shape:

```ts
interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}
```

`HarnessTranscriptItem.kind` loses the `'plan'` member.

### API / Commands

None. No new IPC.

### Data Flow

```
1. Agent emits session/update { sessionUpdate: 'plan', entries: [...] }
2. Rust acp.rs forwards as "plan" event (already in place)
3. client.ts maps to AcpEvent { type: 'plan', entries }
4. acp-harness-view.ts case 'plan':
     lane.plan = event.entries
     this.renderPlanPanel(lane)        // replaces panel DOM in place
     // NO appendTranscript call
5. On lane switch (setActiveLane / focusLane):
     this.renderPlanPanel(this.activeLane())  // re-render from stored state
6. On lane dispose / session restart:
     lane.plan = null
     this.renderPlanPanel(lane)        // hides panel
7. Command mode key 'p' (transcript focus only):
     lane.planCollapsed = !lane.planCollapsed
     this.renderPlanPanel(lane)
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `p` | Command mode (transcript focus), lane has `plan != null` | Toggle plan panel collapse |

`p` is currently unbound in transcript focus (verified by grepping the keyHandler switch). When focus is on the composer (`focus === 'text'`), the key passes through to text input as today.

### UI Changes

**DOM** — added once in `buildDOM()` as a sibling inside `.acp-harness__body`, after the dashboard and existing overlays:

```
.acp-harness
├── .acp-harness__topbar
├── .acp-harness__body  (position: relative)
│   ├── .acp-harness__dashboard
│   ├── .acp-harness__memory-overlay
│   ├── .acp-harness__help-overlay
│   └── .acp-harness__plan        (NEW — position:absolute; top:8px; right:8px;
│       │                          hidden via display:none when lane.plan == null)
│       ├── .acp-harness__plan-header
│       │   ├── .acp-harness__plan-title          ("// plan")
│       │   ├── .acp-harness__plan-progress       ("3/7 done")
│       │   └── .acp-harness__plan-hint           ("p")
│       └── .acp-harness__plan-entries            (hidden when collapsed)
│           └── .acp-harness__plan-entry --pending|--in-progress|--completed [--high|--medium|--low]
│               ├── .acp-harness__plan-entry-mark   ([ ] / [~] / [x])
│               └── .acp-harness__plan-entry-text
└── .acp-harness__command-center
```

**Position & sizing rules:**
- `position: absolute; top: 8px; right: 8px;` inside `.acp-harness__body`.
- `width: clamp(220px, 28vw, 360px);`
- `max-height: calc(100% - 16px);` with `overflow-y: auto;` on `.acp-harness__plan-entries`.
- `z-index` above `.acp-harness__dashboard` content but below `__memory-overlay` / `__help-overlay` (those are full-screen modals and should win).
- Translucent background (e.g., `rgba(<surface>, 0.92)`) with the standard cyberpunk border + faint outer glow. **No `backdrop-filter`** (platform gotcha — freezes WKWebView).
- `pointer-events: auto` on the panel, `none` on a wrapping ghost layer if needed (not expected — panel is keyboard-only, no clicks).

**Visual rules** (consistent with cyberpunk-aesthetic skill + existing fs-review card):
- `--pending`: dim foreground, faint border.
- `--in-progress`: amber accent (reuse `--krypton-warning` family), subtle pulse on the mark.
- `--completed`: green accent (reuse `--krypton-success` family), strikethrough on text.
- Priority adds a 2px left border in priority color (high = warning red, medium = accent, low = dim) — purely informational.
- Header line uses the `// plan` lowercased title pattern from legacy `acp-view.ts` for visual continuity.
- Collapsed state: only header visible (~24px tall, same width); entries hidden; header still shows progress (`3/7 done`).

### Configuration

None. Plan panel is always enabled.

## Edge Cases

- **Empty `entries: []`** — agent explicitly cleared the plan. Treat as "no plan" → hide panel (set `lane.plan = null` if `entries.length === 0`, or store `[]` but render hidden — choose store-`[]`, hide-render to keep "agent acknowledged plan" semantics; either works, document the choice in code).
- **Plan arrives mid-streaming** — render is independent of `sealStreaming`; calling `renderPlanPanel` does not affect the assistant chunk in progress. Keep the existing `sealStreaming(lane)` call from line 773 to match prior behavior of plan boundary closing the current chunk.
- **Lane switch during long plan** — re-render from stored state; collapse state is per-lane.
- **Session restart** — `disposeLane` / restart path nulls `plan` and re-renders.
- **Very long plan (20+ entries)** — `.acp-harness__plan-entries` scrolls internally; outer panel capped to `calc(100% - 16px)` of body height.
- **Panel occluding scrollbar / right-edge content** — accepted trade-off; user can press `p` to collapse if it bothers them. Panel never overlaps the composer (it lives inside `__body`, not `__command-center`).
- **Memory/help overlay opens** — those overlays already cover `__body` fully and have higher z-index, so they paint over the plan panel as expected; nothing to do.
- **Long entry content** — wrap normally (CSS `overflow-wrap: anywhere`); no truncation.
- **`p` key in composer focus** — passes through as text input; toggle only fires on transcript focus (consistent with how `?` `^M` etc. behave).
- **Plan replace mid-resize/scroll** — `renderPlanPanel` only touches the panel subtree; transcript scroll position untouched.

## Open Questions

None — all design decisions resolved above. (Empty-plan handling resolved: store `[]`, hide-render.)

## Out of Scope

- Editing plan entries from the UI (read-only).
- Persisting plans to memory or across sessions.
- Cross-lane aggregated plan view.
- Mouse interaction (clicking entries, drag-reorder).
- Notifications/sound on plan changes.
- Diffing successive plans (highlighting which entry changed).
- Markdown rendering inside plan content (kept as plain text, matches legacy renderer).

## Resources

- `docs/87-acp-extended-session-updates.md` — reference for how mode/status chip is wired (data-flow comparison).
- `docs/89-acp-diff-preview.md` — reference for keyboard-handler layering precedent.
- `src/acp/acp-view.ts:779-794` — legacy `renderPlan` (replace-in-place template).
- `src-tauri/src/acp.rs:605-636` — confirms `plan` already in the forwarded `session/update` set.
- ACP spec `sessionUpdate: "plan"` (entries with `status` ∈ `{pending, in_progress, completed}`, `priority` ∈ `{high, medium, low}`) — already typed in `src/acp/types.ts:PlanEntry`.
