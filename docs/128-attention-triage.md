# Attention Triage — Implementation Spec

> Status: Implemented
> Date: 2026-05-30
> Milestone: M8 — Polish

> **Implementation notes (2026-05-30).** Two deviations from the draft, both
> following established Krypton precedent:
> - **Leader key.** The draft's `Leader j` ("judgement") could not be used: `j`
>   is a `GLOBAL_LEADER_RESERVED_KEYS` entry (compositor focus-down), and the
>   input router rejects local bindings that collide with global leader keys.
>   Mirroring the spec-124 (`.`) and spec-127 (`,`) substitutions, the overlay
>   is bound to **`Leader ;`** ("Triage Queue"). Spec 130 later removed the
>   separate equip/unequip leader action. Inside the overlay,
>   `j`/`k`/`a`/`r`/`o`/`Enter`/`Esc` work exactly as the draft's overlay table
>   specifies (raw keys, not leader-gated).
> - **Equip persistence.** "Persisted alongside lane config" is implemented as a
>   *runtime* per-lane toggle (`HarnessLane.triageEquipped`), matching the
>   spec-124 directive-binding model the draft explicitly invokes (that binding is
>   runtime, not on-disk). There is no `krypton.toml` / `acp-harness.toml` key in
>   v1. The toggle is mirrored into the hook server for the `tools/list` gate.
>   Caveat: because most ACP clients fetch `tools/list` once per session,
>   equipping is most effective at/before a lane's first turn; the call-time gate
>   is authoritative regardless.
>
> **Follow-up (spec 129).** That "effective at/before the first turn" caveat is
> now *satisfiable*: a directive (spec 124) may carry `triage_equipped = true`,
> and a lane spawned with such a directive is equipped before its first
> `tools/list` (the Rust mirror is awaited ahead of `spawnLane`). The manual
> `Leader '` toggle remains as a runtime override; `HarnessLane.triageEquipped`
> is now the *effective* state, derived from the override or the bound
> directive. See `docs/129-directive-triage-grant.md`.
>
> **Follow-up (spec 130).** Specs 128/129's per-lane opt-in model is superseded:
> every lane that receives the `krypton-harness-memory` MCP server is advertised
> `attention_flag` / `attention_resolve` by default. The `Leader '` manual equip
> action is removed from the active UI. `triage_equipped` remains visible as
> legacy directive metadata only; it no longer gates tool visibility. See
> `docs/130-default-attention-triage.md`.
>
> **Follow-up (spec 134) — prompt reframe.** With the tool default-on, real usage
> showed it was *still* almost never called even across turns full of decision
> points — the ADR-0001 cognitive-surrender risk materializing. Root cause was the
> prompt, not the plumbing: both the tool description and the injected lane-context
> line were prohibition-dominant ("the boring 80% must NEVER become a judgement
> item … over-flagging is **worse than not flagging** … never flag proactively"),
> which told the model the safe move was silence. Spec 134 reframes both strings
> (the only change — no architecture, ADR-0001 self-report model intact): lead with
> positive, *recognizable* fork triggers (picked among ≥2 viable approaches the user
> might decide differently on / resolved an ambiguity by guessing / did something
> costly or hard to undo), make the error framing **symmetric** ("letting a genuine
> fork pass unflagged is as costly as over-flagging"), and demote the "skip the 80%,
> one per turn, never to cover yourself" guard to a single trailing clause. The
> presence floor and ranking are unchanged.
>
> **Follow-up — plain-language card content.** Real usage showed the *fields* were
> being filled with terse technical jargon — the chosen decision (e.g. an API or
> data-structure name) embedded without explaining the real stake — leaving the
> human unable to triage a card without first reading the code. The card structure
> (`question` → `chosen` → `because` → traded-off → unsure, `attention-overlay.ts`)
> and the presence floor were already correct; the gap was the injected lane-context
> line never told the model *who the reader is*. The line now appends a writing
> directive: write the free-text fields **in Thai, for a human who is NOT reading
> the code** — `question` names the real stake in plain language (not just an API /
> data-structure name), `rationale` explains the *consequence* (why it matters), not
> only the mechanism, and any unavoidable technical term is followed by one plain
> sentence on its concrete impact. Prompt-layer only (`acp-harness-view.ts`); the
> Rust tool schema/contract is untouched.

## Problem

Running many ACP lanes is cheap; closing the loop on them is not. The human's attention is the single serial bottleneck (the "orchestration tax" — see ADR-0001 and *The Orchestration Tax* in Resources). Today the only cross-lane signal is `lane peek heat`, which ranks lanes by *activity* (tools/tokens/cpu) — i.e. by busy-ness, which is decoupled from what actually needs human judgement. There is no surface that distils *the specific decisions that need the human* and lets them be reviewed in one batched place.

## Solution

A default-on **attention triage** system for harness-memory-capable lanes. A lane with the `attention_flag` MCP tool self-reports, at end-of-turn and non-blocking, the specific decisions that need human judgement (a *judgement item*). Items accumulate in a **demand queue** rendered in a summon-on-demand **overlay**, ranked by reversibility/blast-radius. The only ambient signal is a static **backpressure gauge** (a count in the status bar). Triage is a *router, not a gatekeeper*: turns with no flagged item fall to a silent pile, nothing is auto-approved or deleted. See `CONTEXT.md` for the vocabulary and `docs/adr/0001-attention-triage-self-reported-router.md` for the trust-model decision.

## Research

- **Mechanism is fully resolved** via a prior grill session (13 decisions). This spec records the resolution, it does not re-open it.
- **MCP bus is lane-scoped at the transport level.** `hook_server.rs:536` exposes `GET /mcp/harness/:harness_id/lane/:lane_label` — the connection carries both ids, so `tools/list` *and* tool-call dispatch already know the calling lane. Per-lane opt-in is therefore enforceable at both points with no new plumbing.
- **Round-trip bus tools exist.** `peer_send` / `review_request` register a oneshot via `register_bus_reply(request_id)`, emit a Tauri event, and await the frontend coordinator's reply (`hook_server.rs:690`, `:778`). `attention_flag` reuses this exact pattern.
- **Blast-radius capture already exists.** `review.ts::buildPacket()` assembles a `ReviewPacket` (diffstat, hunks, commands, tool summary) from lane state. The triage card reuses this rather than re-implementing diff capture.
- **Redirect delivery path exists.** `InterLaneCoordinator.enqueueSystemPrompt(laneId, text, drain?)` (`inter-lane.ts:84`) injects a programmatic user-turn, gated by `canDrainInbound(status)` so it lands on the lane's next idle. Redirect uses this.
- **Status bar exists** (`docs/121-workspace-status-bar.md`) — the natural home for the backpressure gauge.

## Prior Art

| Tool | Implementation | Notes |
|------|----------------|-------|
| Conductor / Claude Squad / vibe-kanban | Multi-agent dashboards: a live grid of running agents with status, diffs, logs | Activity-centric — exactly the "dashboard is full and everything moves" busy-trap the source warns against |
| Warp Agents / Zed agent panel | Per-agent transcript panes, manual switching | No cross-agent judgement distillation; the human polls each agent |
| GitHub PR review queue | Items wait in a queue, reviewed in batches, approve/request-changes | Closest analogue to the demand queue + batched review, but human-authored not agent-flagged |

**Krypton delta** — Every comparable tool surfaces *activity* (what agents are doing) and lets the human poll. Attention triage deliberately surfaces only *self-flagged judgement* (what needs the human) and is non-blocking, summon-on-demand, with a single static gauge as the only ambient pull. The novel part — the working agent self-reporting "this needs your judgement" via an MCP tool, ranked by reversibility — has no direct market equivalent.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Add `attention_flag` + `attention_resolve` to `bus_tool_descriptors()` (advertised only for opted-in lanes); dispatch in `handle_bus_tool_call`; round-trip via `register_bus_reply` → emit `acp-attention-flag` / `acp-attention-resolve`. |
| `src-tauri/src/commands.rs` | Legacy per-lane triage mirror retained for compatibility. Since spec 130, `tools/list` and call-time dispatch no longer consult it. |
| `src/acp/types.ts` | `JudgementItem`, `Reversibility`, `AttentionFlagPayload`, `AttentionResolvePayload`; new `LaneBusEvent` variants. |
| `src/acp/attention-triage.ts` | **New.** `AttentionTriageStore` — demand queue, ranking, lifecycle, silent pile. |
| `src/acp/attention-overlay.ts` | **New.** Overlay UI: one ranked card shown at a time (j/k pages), single-key actions. Reuses the review-card renderer. |
| `src/acp/review.ts` | Extract/reuse `buildPacket` for blast-radius; export a card-render helper shared with the overlay. |
| `src/acp/inter-lane.ts` | Redirect delivery wrapper over `enqueueSystemPrompt` (next-idle). |
| `src/acp/acp-harness-view.ts` | Wire bus events → store; track busy→idle as silent turns into `LaneTriageStats`; publish the open count on the global `system:attention` ViewBus signal; leader key; mount overlay; per-lane equip toggle. |
| `src/workspace-footer.ts` / `src/styles/workspace-footer.css` | Subscribe (un-gated) to `system:attention`; keep a per-`sourceId` tally and render the SUMMED open-count gauge (`N attention`, `__segment--attention`) in the global workspace footer — its documented home — surviving focus changes, hidden at zero. Summing across sources means every harness tab's attention collects in this one place rather than last-writer-wins. |
| `src/view-bus-types.ts` | `system:attention { sourceId, openCount }` signal kind (global `SystemSource`); `sourceId` identifies the publishing harness instance for footer aggregation. |
| `src/styles/attention-triage.css` | **New.** Overlay styles (cyberpunk; mirrors review-card patterns). The open-count gauge styling lives in `workspace-footer.css`. |
| `docs/PROGRESS.md`, `docs/04-architecture.md`, `docs/06-configuration.md` | Module note + per-lane equip docs. (Equip is a runtime toggle, **not** a config-file key — `06-configuration.md` documents that explicitly; see Implementation notes above.) |

## Design

### Data Structures (`src/acp/types.ts`)

```ts
export type Reversibility = 'reversible' | 'costly' | 'irreversible';

export type JudgementStatus = 'open' | 'accepted' | 'redirected' | 'self_resolved';

export interface AttentionFlagPayload {
  question: string;        // the decision needing judgement
  chosen: string;          // the best-guess the lane already took (non-blocking)
  rationale: string;       // why it chose that
  tradedOff: string[];     // options rejected + why — MANDATORY, non-empty (anti-rosy-card)
  uncertainty: string;     // what the agent is unsure of / what would change its mind — MANDATORY, non-empty
  reversibility: Reversibility;
}

export interface JudgementItem extends AttentionFlagPayload {
  id: string;
  laneId: string;
  packetId: string | null; // linked ReviewPacket (blast-radius diffstat/hunks), null if no repo changes
  diffstat: ReviewDiffstatEntry[];
  createdAt: number;
  status: JudgementStatus;
}
```

```ts
export interface LaneTriageStats {
  laneId: string;
  flaggedCount: number;   // turns that produced ≥1 judgement item
  silentTurnCount: number; // turns that ended (busy→idle) with no flag
  lastSilentTurnAt: number | null;
}
```

The harness **rejects** an `attention_flag` call whose `tradedOff` is empty or `uncertainty` is blank. This is a **presence floor, not a quality guard** — it forces the *fields to exist*, but an agent can still fill them with empty calories ("traded off: nothing significant", "uncertainty: low"). It does **not** by itself prevent rosy cards. The real defenses are (a) the human reading `tradedOff` / `uncertainty` during review (they are always rendered, never collapsed), and (b) a peer lane reviewing card quality. Treat the floor as a prompt to the agent, not a safeguard the system enforces.

### MCP Tools (`hook_server.rs`)

```
attention_flag {
  question, chosen, rationale, traded_off[], uncertainty, reversibility
} -> { item_id }            // assigned id, so the lane can later resolve it
attention_resolve { item_id, note } -> { ok }   // lane self-resolves (demote, not delete)
```

Both follow the `review_request` round-trip: the frontend coordinator assembles the `ReviewPacket` from current lane state, inserts the `JudgementItem`, and replies. Tool description (reframed in spec 134 — see the follow-up note above) **leads with positive, recognizable fork triggers** and a *symmetric* calibration: *flag a real fork the human would want to weigh in on — ≥2 viable approaches the user could reasonably decide differently on, a guessed-at consequential ambiguity (one changing the user-visible outcome / architecture / workflow), or a costly/irreversible action; both a silent genuine fork and a trivia flag degrade the queue.* The guard from `peer_send` / `review_request` (*skip the boring machine-verifiable 80%, one flag per turn, never to cover yourself*) is retained as a single trailing clause rather than the dominant theme.

**Default tool exposure.** Since spec 130, `tools/list` for `:lane_label` includes `attention_flag` / `attention_resolve` for every lane that receives the `krypton-harness-memory` MCP server. Payload validation and frontend queue insertion are the meaningful guards; the old triage-equipped gate is retained only as legacy metadata.

### Ranking (`attention-triage.ts`)

Demand queue = open items, sorted by `reversibility` (`irreversible` > `costly` > `reversible`), tie-broken by `createdAt` **ascending** (oldest first — old unreviewed forks compound downstream rework). **`lane peek heat` is explicitly not consulted** — it measures activity, not judgement weight (ADR-0001).

### Silent-turn audit (v1 minimal)

Pure self-report means a lane that mis-judges its own work and *never flags* produces no demand-queue item — the cognitive-surrender risk of ADR-0001. To keep that risk **auditable in v1** (rather than fully deferring it to a pile-browser follow-up), the harness tracks `LaneTriageStats` per lane: every busy→idle transition increments `silentTurnCount` unless that turn flagged. The overlay shows a per-lane header — `Claude-3 · 2 flagged · 12 silent` — and selecting a lane lets the human open that lane's transcript window (`o`) to spot-check silent turns. This is deliberately minimal: a count plus a jump-to-transcript, **not** a rich per-turn pile browser (deferred — Out of Scope). It is enough to make ADR-0001's "the pile remains auditable" claim true in v1.

### Actions (overlay)

- **Acknowledge** — marks `accepted`, removes from demand queue, **and notifies the lane** that its `chosen` path is approved via `InterLaneCoordinator.deliverAcknowledge(laneId)` (spec 183 — same `injectHarnessEnvelope` delivery as redirect, drains on the lane's next idle). The store transition stays pure bookkeeping; the lane-notify lives in the harness handler. The envelope is **no-op-friendly** — a lane whose flagged work is already complete is told no reply or new work is required, so a confirmation never forces a vacuous turn. *(Was silent in v1 — reversed per spec 183: a human sign-off should reach the actor, like a PR "Approve", not just clear the queue. The cost is waking an idle lane for one drain, mitigated by the no-op wording.)*
- **Redirect** — opens a one-line input; the text is delivered via `InterLaneCoordinator.enqueueSystemPrompt(laneId, text)` on the lane's **next idle** (`canDrainInbound`). Marks `redirected`, removes from queue. Late-arrival rework is accepted (ADR-0001).
- **Dig** — opens the lane's transcript window for full review. Item stays `open`.
- Doing nothing = defer (item stays ranked in the queue). There is no dismiss action.

A lane's `attention_resolve` marks the item `self_resolved` and drops it from the demand queue into the silent pile — never deleted.

### Data Flow (one judgement item)

```
1. Equipped lane finishes work, calls attention_flag{question,chosen,rationale,traded_off,uncertainty,reversibility}
2. hook_server validates (traded_off non-empty, uncertainty non-blank), registers oneshot, emits acp-attention-flag
3. acp-harness-view receives it → AttentionTriageStore.insert():
   coordinator assembles ReviewPacket via buildPacket() → JudgementItem with diffstat
4. hook_server replies { item_id }; the lane sees it and ends its turn (keeps working next turn)
5. Status-bar backpressure gauge updates to the new open count (static, no motion)
6. Human summons overlay (leader key) → one ranked card at a time, j/k pages → presses a / r / o:
     a → acknowledged, dequeued
     r → enqueueSystemPrompt(laneId, correction) on next idle → redirected, dequeued
     o → open lane transcript window
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader ;` | Compositor / harness | Summon the triage overlay (judgement queue) |
| `j` / `k` | Triage overlay | Page to next / previous item (one detail shown at a time) |
| `a` | Triage overlay, card selected | Acknowledge (dequeue, no lane effect) |
| `r` | Triage overlay, card selected | Redirect (open correction input → next-idle inject) |
| `o` or `Enter` | Triage overlay, card selected | Dig — open the lane transcript window |
| `Esc` | Triage overlay | Dismiss overlay |

No Alt modifier (project constraint). All actions single-keystroke.

### UI Changes

- **Overlay** — modeled on the command-palette / Quick Terminal overlay: centered panel, absolute-positioned, summoned and dismissed, never occupying a workspace slot. Shows **one detail at a time** — only the selected (highest-ranked first) card is rendered full-width, with `j`/`k` paging through the queue and the header showing the cursor position (`2 / 5`). This gives each decision the whole panel instead of stacking every open item into a scroll list where the tall traded-off / uncertainty fields get clipped. The card shows question / chosen / rationale / **traded-off** / **uncertainty** / reversibility badge / diffstat summary. The traded-off and uncertainty blocks are always rendered (never collapsed) so the human sees what the agent gave up.

  **Card layout (post-ship polish, 2026-06-02).** The card started as four uniform label+text rows (an 84px label gutter), which read as one grey wall. It was reworked into a deliberate hierarchy: `chosen` is promoted into a **verdict block** (full background tint + hairline border, the tint colour carrying reversibility — cyan / amber / red) so the eye lands on the decision first; rationale / traded-off / uncertainty follow as **stacked sections** (an eyebrow label above a full-width body), with the rationale dimmed and the uncertainty flagged in amber. Per a hard user preference the surface uses **no left-bar accent rails** anywhere — reversibility is signalled by the badge and the verdict-block tint, not a coloured left border. Effects are flat (one tint + one border per accent). See `renderJudgementCard` in `src/acp/attention-overlay.ts`.
- **Backpressure gauge** — a static count (`N attention`) chip in the **global workspace footer**, published by each harness via the `system:attention` ViewBus signal and rendered un-gated so it persists across focus changes (the harness is one view among many, but the count matters wherever the user is). When more than one harness tab is open the footer **sums** their counts (keyed by per-instance `sourceId`) so all lanes' attention collects in one place; a harness publishes `0` for its id on dispose, removing only its own contribution. No blink, no pulse. Hidden when the total is zero. **Spec 138** makes the chip *weight-dynamic* while keeping it motionless: its colour tracks the **heaviest open reversibility tier** (cyan / amber / red) and a **pip strip** encodes the count (`6+` past the cap). The signal carries `maxReversibility` for this; colour + pips are steady-state encodings, not animation — see `docs/138-attention-gauge-weight-dynamic.md`. The overlay is summoned with the `;` harness leader key. It deliberately does **not** live in the harness chrome — duplicating it there would split the single ambient pull the spec calls for.

### Configuration

Since spec 130, attention tools are default-on for every lane that receives the `krypton-harness-memory` MCP server. There is no global `krypton.toml` switch and no required per-lane equip action. The legacy `triage_equipped` directive field remains accepted and visible as metadata only.

## Edge Cases

- **`attention_flag` with empty `traded_off` or blank `uncertainty`** → tool returns an error; no item created (presence floor — does not police field *quality*, see Design).
- **Lane without harness memory MCP** → no attention tools appear because no MCP server is injected.
- **Lane self-resolves an item already acknowledged/redirected by the human** → no-op (terminal status wins); the resolve is dropped.
- **Redirect to a stopped/cancelled lane** → `enqueueSystemPrompt` / `canDrainInbound` rejects; surface an inline notice, item returns to `open`.
- **Lane keeps flagging (queue floods)** → the static gauge climbs; this is *intended* backpressure signal, not an error. The "never proactively" guard is the only throttle.
- **Overlay summoned with empty queue** → shows "no judgement pending" + a pointer to the silent pile.
- **Harness with zero flagged items** → gauge hidden, `Leader ;` shows the empty state.

## Open Questions

None — all 13 design decisions and the 3 prior open points (mandatory card fields, redirect timing, acknowledge semantics) are resolved above.

## Out of Scope

- The **rich silent-pile browser** UI (per-turn cards, filtering, diff-of-every-no-flag-turn). v1 ships the demand queue + the minimal silent-turn audit (per-lane counts + jump-to-transcript, see Design); the full browser is a follow-up spec.
- Any **deterministic floor** or **independent observer** producer (rejected — ADR-0001).
- **Blocking** judgement mode (rejected — non-blocking only).
- Reusing or modifying `lane peek heat`.
- Cross-harness aggregation of judgement items.
- A `krypton.toml` global enable; equip is per-lane in-app only.

## Resources

- `docs/adr/0001-attention-triage-self-reported-router.md` — the trust-model decision this spec implements.
- `CONTEXT.md` — vocabulary (judgement item, demand queue, silent pile, backpressure gauge).
- *The Orchestration Tax*, Addy Osmani (2026) — source framing: attention as the serial bottleneck, backpressure, batched review, "only spend the lock on judgement."
- `docs/106-inter-lane-messaging.md`, `docs/112-acp-review-lane-mode.md`, `docs/124-acp-harness-directive-management.md` — reused machinery (coordinator, review packet/render, per-lane binding).
