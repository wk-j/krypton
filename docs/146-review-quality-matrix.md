# Review Quality Matrix — Implementation Spec

> Status: Implemented (summary-only design)
> Date: 2026-06-06
> Milestone: M-ACP — Harness Peering
> Builds on `docs/145-harness-design-review-panel.md` (agent-orchestrated `#review`).
> Decision record: `docs/adr/0004-review-matrix-observation-not-score.md`.
> Revision: a 2-reviewer design review (Cursor-1 arch/correctness, Codex-2
> requirements-fit) blocked the original "rich record" design on retained
> review-session state. The user chose a **summary-only** record — no stored
> diff size, no transcript anchor, no `verdict` — which removes the retention
> need entirely. This spec reflects that simplification.

## Problem

`#review` (spec 145) fans a working diff out to reviewer lanes; they reply with
Blockers/Warnings, and the [[Authoring lane]] synthesizes the replies into its
turn text. That synthesis is **transient** — once the turn scrolls past,
nothing records *how many problems reviewers kept finding in this lane's work*.
The user, running the "one lane edits, the others review" workflow, wants to
**observe the quality trend of the authoring lane across successive reviews** —
is it producing more bugs / bad design over time, or fewer?

This spec adds a **review quality matrix** (`CONTEXT.md`): a per-session,
in-memory accumulation of a **summary** per review round per lane, surfaced
like attention triage. Per ADR-0004 it is an **observation, not a score** —
raw blocker/warning counts shown as history, never blended into a quality
number, never graded, and never a lane leaderboard.

## Non-goals

- **No quality score / ranking / grade.** (ADR-0004.)
- **No cross-session persistence.** Session-only, in-memory; lost on harness
  close. (Cross-session would require keying by agent/model, not lane instance,
  + a disk store — deferred to a possible v2.)
- **No revival of spec-112 machinery.** No `ReviewPacket`, no `ReviewCard`, no
  coordinator review-session state. The only structured-data path added is one
  self-report tool + one in-memory stats store.
- **No automatic flagging.** A bad trend never auto-raises an attention
  judgement item; the matrix is observed on demand, not pushed.

## Domain model

Two settled domain terms (already in `CONTEXT.md`):

- **Review quality matrix** — the surface defined here.
- **Authoring lane** — the lane credited with the work under review (the one
  that edits + convenes `#review`); attribution is by workflow convention.

### The record

Each completed `#review` round contributes one `ReviewOutcome` to the
authoring lane's history. It is a **small summary**, entirely self-reported by
the authoring lane at synthesis time — no harness-side review-session state,
no git-collector retention, no transcript anchor:

```ts
interface ReviewOutcome {
  authoringLaneId: string;   // the lane being observed (convening lane of the round)
  authoringLaneName: string; // displayName snapshot, so the overlay still labels a closed lane's rows
  subjectLabel: string;      // short human label: diff summary or doc path (self-reported)
  reviewerCount: number;     // how many reviewers the round fanned out to (self-reported)
  blockers: number;          // total blockers reported across reviewers
  warnings: number;          // total warnings reported across reviewers
  at: number;                // ms timestamp, stamped by the store on record()
}
```

Counts are **raw** — `blockers` and `warnings` are kept separate; the spec
never derives a combined figure and never grades the round. There is
deliberately **no `verdict`** (a self-graded `clean/ok/revise` would relaunder
a score — ADR-0004) and **no stored diff size** (it required retaining the
reviewed snapshot, and is meaningless for design-doc rounds). Per ADR-0004 this
keeps only the summary; the actual reviewer replies stay in scrollback as the
evidence behind the counts.

### Store

A per-view `ReviewQualityStore` (new, `src/acp/review-quality.ts`), modelled on
`AttentionTriageStore` / `LaneTriageStats`:

- `Map<laneId, ReviewOutcome[]>` (newest-first), in-memory, view-scoped.
- `record(outcome)` stamps `at`, prepends to the lane's list, and re-emits the
  canonical `review:quality` count signal via the `ViewBus` for the status-bar
  indicator. (One signal name only — `review:quality`; there is no separate
  `system:reviews` signal.)
- `historyFor(laneId): ReviewOutcome[]` for the overlay.
- `totalReviews(): number` for the indicator.
- Dropped entirely on view dispose (no persistence). A lane *closing* mid-session
  does **not** drop its history — the matrix observes the per-session trend, so a
  closed/restarted lane's rows are kept until the whole view disposes (the record
  carries an `authoringLaneName` snapshot so the overlay still labels them). The
  store exposes `onLaneClosed(laneId)` as available API, but the harness
  deliberately does not call it on lane close.

## Producing the outcome (self-report)

Per ADR-0004 the authoring lane self-reports the whole summary at synthesis
time. Because the record holds only self-reported fields, the tool needs **no
frontend enrichment and no retained collector/session state** — the blocker
that two reviewers flagged against the earlier design dissolves. Mechanism:

1. **New MCP tool `review_outcome`** on the existing `krypton-harness-bus`
   server (`src-tauri/src/hook_server.rs`), alongside `peer_send` / `peer_list`
   / `attention_flag`. Arguments: `{ blockers, warnings, reviewer_count, subject_label }`
   — all four supplied by the authoring lane itself (it knows them: it counted
   the reviewers it fanned out to and tallied their replies while synthesizing).
   The tool emits `acp-review-outcome` to the frontend, which simply calls
   `store.record(...)`; the bus reply is a bare ack (no `review_id`, since there
   is no anchor to mint). It does **not** read `acp_collect_review_git_state`.
2. The tool is **default-on built-in harness tooling**, so it is **auto-allowed**.
   Register it in the built-in allow-list `HARNESS_AUTO_ALLOW_TOOL_NAMES` and
   the `harnessAutoAllowToolName()` enforcement point in `acp-harness-view.ts`,
   add it to the MCP `tools/list` registration in `hook_server.rs`, surface it
   for discoverability in `renderPromptMemoryPacket`, and document it in
   `docs/96-acp-built-in-memory-auto-approval.md`. (Spec 145 *removed*
   `review_request`/`review_reply` from that list; this adds one back, narrower.)
3. **Prompt wiring:** `reviewRequestPrompt()` (`src/acp/review.ts`) step 3
   (synthesis) gains one clause: after synthesizing, call `review_outcome` once
   with the blocker/warning totals you reported, the number of reviewers, and a
   short subject label. This is the only `#review` prompt change.

### Under-report mitigation (not a guard)

The authoring lane reports its own counts, so it could under-report. Per
ADR-0004 the mitigation is **not** a deterministic check: the reviewers' actual
replies remain in the authoring lane's scrollback, so the human can re-read
them. The count is an index into that evidence, never a verdict. There is no
stored jump-to-review anchor (dropped with the summary-only design). Same
posture as ADR-0001's silent-turn audit.

## UI surfaces (mirror attention triage exactly)

### Status-bar indicator

- A neutral **`N reviews`** count published on the `ViewBus` (the single new
  signal `review:quality`), summed across harness tabs, shown in the workspace
  footer (`src/workspace-footer.ts`) **next to** but **visually distinct from**
  the attention backpressure gauge (different glyph; never coloured by badness;
  never pulses/blinks).
- Semantics: "there are N recorded review rounds — press the key to inspect."
  It is *depth*, not *demand* (contrast: the attention gauge means "act on
  me"). This distinction is load-bearing (Q7 of the design grill).
- Hidden when `totalReviews() === 0`.

### Summon-on-demand overlay

- New `Leader <key>` command (a free leader chord — `Leader ;` is taken by
  attention triage; pick e.g. `Leader '` if free, else propose at
  implementation). Opens a `renderReviewMatrixOverlay()` modelled on
  `renderTriageOverlayEl()` (`acp-harness-view.ts`).
- Layout: one lane selected at a time (j/k to switch lanes if >1 has history),
  showing that lane's `ReviewOutcome[]` as a table — newest on top:
  `round · subject · reviewers · 🔴 blockers · 🟡 warnings`.
- Actions: `Esc` closes; that is all. No row activation / jump-to-transcript
  (no anchor is stored), no accept/score actions — it is read-only observation.

## Files touched

- `src/acp/review-quality.ts` — **new** `ReviewQualityStore` (record / historyFor / totalReviews).
- `src/acp/types.ts` — `ReviewOutcome` type; `review:quality` `ViewBus` signal.
- `src/acp/review.ts` — one synthesis clause in `reviewRequestPrompt()`.
- `src/acp/acp-harness-view.ts` — listen for `acp-review-outcome` → `store.record()`;
  publish the `review:quality` count; `renderReviewMatrixOverlay()`; leader
  command; add `review_outcome` to `HARNESS_AUTO_ALLOW_TOOL_NAMES` /
  `harnessAutoAllowToolName()` and to `renderPromptMemoryPacket` discoverability;
  dispose clears the store.
- `src/workspace-footer.ts` — render the `N reviews` depth indicator next to the
  attention gauge, subscribing to `review:quality`.
- `src/styles/review-quality.css` — **new** overlay styling (imported in
  `src/styles/index.css`); footer indicator styling added to
  `src/styles/workspace-footer.css` (`__segment--reviews`). (Reuse triage
  classes where possible).
- `src-tauri/src/hook_server.rs` — `review_outcome` tool: `tools/list`
  registration + handler that emits `acp-review-outcome` and acks (mirror the
  `attention_flag` round-trip, minus any return payload). No git collection.
- `docs/96-…md` — add `review_outcome` to the auto-allow built-in list.
- `CLAUDE.md`, `docs/04-architecture.md`, `docs/72-acp-harness-view.md`,
  `docs/PROGRESS.md` — document the surface (per `/feature-implementation`).

## Test plan

What is unit-tested (matches the shipped suite):

- `review-quality.test.ts` — `record`/`historyFor`/`lanesWithHistory`/`totalReviews`,
  newest-first ordering, per-lane isolation, `at`-stamping, and `onLaneClosed`
  drop + re-emit (the store API; the harness no longer calls it on lane close).
- `review.test.ts` — `reviewRequestPrompt()` includes the `review_outcome`
  synthesis clause and wires `reviewer_count` to the reviewer total.
- `acp-harness-view.test.ts` — `review_outcome` auto-allow detection (Codex-style
  namespaced, hyphenated bus marker, and rejection without a bus marker).
- Rust `parse_count_field` — absent → `None` (caller defaults to 0); valid
  int/integer-float/numeric-string → `Some`; present-but-invalid (negative,
  fractional, junk) → `Err` (never coerced to 0).

Integration-level (not unit-tested, consistent with `attention_flag`, which is
also not unit-tested): the Rust `review_outcome` emit + bus round-trip and the
frontend `acp-review-outcome → handleReviewOutcome → record → { recorded: true }`
glue both require a live `app_handle` / a constructed `AcpHarnessView`, so they
are exercised manually, not in vitest/cargo unit tests.

## Resolved (from the spec-146 design review)

- **No `verdict` field.** Two reviewers flagged a self-graded `clean/ok/revise`
  as relaundering a score; the user confirmed "keep only a summary." Dropped.
- **No stored diff size / no transcript anchor.** These were the sole reason the
  earlier design needed retained collector/session state (both reviewers'
  blocker). The user chose the summary-only record, so they are dropped and the
  data-flow conflict with the "no review-session state" non-goal disappears.

## Open questions

- **Leader chord** for the overlay — needs a confirmed-free key (`Leader ;` is
  taken by attention triage; proposed `Leader '` — verify at implementation).
- **Multiple authoring lanes in one session** — supported by keying on lane,
  but the indicator's single `N reviews` count is a sum; the overlay separates
  by lane. Confirm that is the desired at-a-glance behaviour.
