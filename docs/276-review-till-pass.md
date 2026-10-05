# Review Till Pass (`#review pass`) — Implementation Spec

> Status: Implemented (unit-tested; not yet exercised in the running app)
> Date: 2026-10-04
> Milestone: M-ACP — Harness review
> Builds on: specs 115, 145, 146, 211, 275 · ADR-0004 · inspired by Empryo `/review pass`

## Problem

`#review` runs one round. When reviewers report Blockers, the human reads the Board, tells the
authoring lane to fix, and types `#review` again — once per round, until the reviewers are clean.
For that relay the human adds no judgement as long as the reviewers' verdict is clear; they only
pass messages between lanes.

## Solution

Add `#review pass [N] [<lane>…] [-- <docpath|note>]`: a **harness-sequenced** loop on the authoring
lane — review → every reviewer PASS? stop : fix the Blockers → re-review — for at most N rounds
(default 3, cap 8). The harness also stops early when another round cannot help: nothing changed,
no progress, nothing actionable, or no machine-readable verdict two rounds running (Empryo's
stop rules). Unlike plain `#review` (agent-orchestrated, spec 145 "B2"), the harness fans each
round out itself over the spec-115 mention path and consumes reviewer replies instead of waking the
authoring lane. The authoring lane does two kinds of work only: one fix turn per failed round and
one summary Review Board at the end. The change is one pure module plus one controller (spec 275
pattern) and a small `inter-lane.ts` hook. No Rust change.

## Research

- **Empryo source is not the v3 app.** `~/Source/empryo/README.md:87`: "It is not the full source
  of Empryo v3 … newest features are developed privately." What the repo does show:
  - v2 verifier, `src/core/agents/agent-verification.ts`: runs typecheck + tests first, and any
    errors are "automatic FAIL" (:97, :127). Its prompt says "Fresh eyes — you did NOT write this
    code" (:94). It does not inherit the parent's history (:193), is read-only (`role: "explore"`,
    :179), and ends with `VERDICT: PASS|FAIL|PARTIAL — …` (:106). It runs once; there is no loop.
  - v3 loop behaviour, **inferred from UI strings** (`locales/en.json:968-979`, `4918-4945`):
    - Early stops: `loop-no-progress` ("the same findings came back unchanged"),
      `loop-no-findings` (FAIL that names nothing to fix), `loop-no-structure` (no structured
      findings "two rounds running"), and `loop-inconclusive`.
    - The verdict must be "a machine-readable verdict block".
    - Progress shows as `Round {round}/{max}`, in two phases: fixing and judging.
  - The `/goal` docs add: exit when the same failure repeats in consecutive rounds; `Ctrl+X` stops
    at once; `/goal clear` stops after the current turn; and in the last round the coder is told
    to "stop patching and rethink".
- **Krypton `#review` today** (`acp-harness-view.ts:3118-3228`): idle lane only →
  `reserveCommandTurn(lane,'reviewing')` → subject from `acp_collect_review_git_state` (40 KB cap)
  or a doc path → `dispatchTurn(reviewRequestPrompt(…))`. Nothing links an invocation to its Board
  or `review_outcome`.
- **What B2 costs in a loop:** the authoring lane re-emits the subject as `peer_send` output once per
  reviewer (`review.ts:124-130`) — up to ~240 KB of copied output in a 3-round, 2-reviewer loop.
  Each reply drains into it as its own turn (`inter-lane.ts:665-758`), and only the agent counts
  when the round is over (`review.ts:137`); the harness gets no "round finished" signal.
- **What already exists:** `deliverMentionFanOut` (`inter-lane.ts:319-353`, spec 115) sends one
  harness-composed body to N lanes for a requester and tracks pending per packet; replies clear it
  in `drain()` (`:719`). `enqueueSystemPrompt` (`acp-harness-view.ts:2121`) returns whether a turn
  started and resolves when it ends, so a fix turn can be awaited. Hash commands route before the
  busy check (`:7976`), so `#review stop` works mid-turn. `#cancel` has no feature hook;
  `cancelLane` (`:10107`) must call the controller directly.
- **Not available or not meaningful:** the harness has no check runner (spec 101's `/check` is
  AgentView-only). Reviewer file-read coverage is unmeasurable (`ToolPayload` has no locations) and
  proves little when the diff is inside the request message. Dropped.
- **Alternatives considered:**
  - *Agent-orchestrated loop* ("repeat `#review` until clean" in the prompt). Rejected: the round
    count and stops are unreliable, the author judges its own pass, and the 40 KB copy repeats
    for every reviewer in every round.
  - *Author fixes inside its last reply turn.* Saves a turn, but then the author, not the harness,
    decides pass or fail. Rejected.
  - *Fresh reviewer session each round* (`#new` on reviewer lanes). This is Empryo's clean context,
    but it destroys the reviewer lane's own session and work, and spec 270 already rejected
    spawning reviewer sessions. Rejected; the request body is written to make up for it instead
    (see "Reviewer reply contract").
  - *Harness-run typecheck/tests between rounds* (Empryo v2). Needs per-project check detection
    the harness does not have. Deferred; in v1 the fix turn runs the project's own checks.

## Prior Art

| Product | Implementation | Notes |
|---|---|---|
| Empryo `/review pass` | Fresh reviewer → `PASS/FAIL/PARTIAL`; non-PASS goes to the coder as a normal turn; when that turn ends, a new reviewer runs. Default 5 rounds, max 12; `Ctrl+X` / `/review stop`. Each round is a real coder turn plus a real review. | One reviewer. Early-stop rules are visible only as UI strings. |
| Empryo `/goal` | Coder ⟷ fresh reviewer against a stated goal. Typecheck/tests run between rounds; models escalate in rounds 3–4; round 5 says "rethink". | Goal-driven, not review-driven. |
| Aider `--auto-test` | After an edit, runs `--test-cmd`; on a non-zero exit, sends the output back for the model to fix. | Deterministic gate, no reviewer. |
| Anthropic evaluator-optimizer | One LLM generates, another evaluates, in a loop; recommends a maximum-iteration stop. | The underlying pattern. |
| Krypton review threads (spec 270) | Human Approve / Request Changes, one round per snapshot. | Human-driven; unchanged. |

**Krypton delta:** reviewers are N live peer lanes (possibly different models), not one fresh agent;
pass means every reviewer returns PASS; it is driven by `#review pass` / `#review stop` / `#cancel`;
it ends in one Review Board (spec 211), not a verdict bar. No terminal or multiplexer has an
equivalent.

## Affected Files

| File | Change |
|---|---|
| `src/acp/review-loop.ts` | **New.** Pure functions and types: `parseReviewPassArgs`, `parseReviewerReply`, `evaluateRound`, `subjectFingerprint`, and the prompt builders `reviewLoopRequestBody`, `reviewLoopFixPrompt`, `reviewLoopSummaryPrompt`. |
| `src/acp/harness-review-loop-controller.ts` | **New.** Per-lane loop state and round sequencing. |
| `src/acp/harness-view-host.ts` | Add the `HarnessReviewLoopHost` contract. |
| `src/acp/inter-lane.ts` | `deliverMentionFanOut(…, { replyConsumer: 'harness' })` and `PendingSend.consumer`. `clearPendingFromPeer` returns the entry it cleared. `drain()` renders harness-consumed replies, calls `host.onHarnessReply`, and leaves them out of `composePrompt`; it injects no turn when every drained envelope was harness-consumed. |
| `src/acp/acp-harness-view.ts` | Route `#review pass|stop` to the controller. Factor `resolveReviewers` and `collectReviewSubject` out of `runReviewCommand`, and `recordReviewOutcomeFor` out of `handleReviewOutcome`. Add `releaseReservedTurn(lane, next = 'idle')`. `cancelLane` calls `reviewLoopCtl.onLaneCancelled`. Add the chip prefix and help line. |
| `src/acp/review.ts`, `src/acp/types.ts` | Export `parseReviewCommandArgs` (moved from the view, re-exported there), `diffSubjectLines`, `diffstatHeadline`, and the Board rule text (`REVIEW_BOARD_SKIM_RULES`, `REVIEW_BOARD_LANGUAGE_RULE`) for the loop prompts — the `#review` prompt text is unchanged. `InterLaneEnvelope.replyConsumer`. |
| `src/acp/hash-commands.ts` | `review` args hint and `commandMeta` anatomy. |
| Tests | New: `review-loop.test.ts`, `harness-review-loop-controller.test.ts` (self-host double, spec 275). Extend: `inter-lane.test.ts`, `acp-harness-view.test.ts`, `hash-commands.test.ts`. |
| Docs | New `docs/adr/0021-review-loop-rounds-are-harness-sequenced.md`. Amendment notes in the 145/146 headers. Update `04-architecture.md`, `05-data-flow.md`, `CONTEXT.md` (new term "Review loop"), and `docs/README.md`. (No `docs/PROGRESS.md` exists in the repo.) |

## Design

### Command

```
#review pass [N] [<lane> …] [-- <docpath | focus note>]
#review stop
```

- **`#review pass`:** `N` (first token after `pass`, integer 1–8, default 3) is the maximum number of
  review rounds; the rest parses exactly as `#review` (spec 145) — no lanes named means every other
  live local lane. Preconditions as `#review` (lane `idle`, ≥1 live reviewer, a git repo for a diff
  subject), plus: no loop already running on the lane (`#review: loop already running — #review
  stop`), and no pending peer from the lane to any reviewer (so `peer_in_flight` cannot block it).
- **`#review stop` — graceful:** during a review round the pending requests are cancelled
  (`cancelConversationsFor(L, { consumer: 'harness' })` — only the loop's requests; L's own peer waits
  stay) and the loop goes to the summary; during a fix turn the turn finishes, then the summary runs
  instead of the next round.
- **`#cancel` / `Ctrl+C` — hard:** the loop ends with no summary turn. During a review round the
  loop's pending requests are withdrawn the same way, even when a user prompt has made L `busy` (a
  busy `#cancel` otherwise keeps peer waits, spec 116) — so no reviewer reply arrives with no loop to
  read it. Plain `#review` is unchanged.

### Data structures (`review-loop.ts`)

```ts
export type ReviewerVerdict = 'pass' | 'fail' | 'partial' | 'missing';
export interface ReviewerResult {
  reviewer: string;           // displayName
  verdict: ReviewerVerdict;   // normalized, see parse rules
  blockers: ReviewFinding[];  // spec 146 shape: severity 'blocking'
  warnings: ReviewFinding[];  // 'non-blocking'
  suggestions: ReviewFinding[];
  partialReason?: string;
  raw: string;                // reply text, quoted into the fix prompt
}
export type ReviewLoopStop =
  | 'pass' | 'max_rounds' | 'no_change' | 'no_progress' | 'no_findings'
  | 'inconclusive' | 'no_structure' | 'reviewer_lost' | 'subject_error' | 'stopped' | 'cancelled' | 'lane_lost';
export interface ReviewRoundSummary { round: number; fingerprint: string; results: ReviewerResult[]; at: number }
export type RoundDecision = { kind: 'fix' } | { kind: 'stop'; reason: ReviewLoopStop };
export function evaluateRound(cur: ReviewRoundSummary, prev: ReviewRoundSummary | undefined, maxRounds: number): RoundDecision;
```

Controller state: one per lane, in memory, dropped on `lane:closed`.

```ts
interface ReviewLoop {
  laneId: string; reviewers: { laneId: string; displayName: string }[]; maxRounds: number;
  tail: string;                          // doc path or focus note, as typed
  phase: 'collecting' | 'reviewing' | 'fixing' | 'summarizing';
  round: number; packetId: string | null;
  replies: Map<string, ReviewerResult>;  // current round, keyed by reviewer displayName
  history: ReviewRoundSummary[];
  stopRequested: boolean;                // #review stop
  cancelled: boolean;                    // checked after every await
}
```

### Reviewer reply contract

**Request.** One body per round, the same to every reviewer, with spec 145's lens table inline. It
asks for spec 145's skim sections plus a final line `VERDICT: PASS` (no Blockers), `VERDICT: FAIL`
(≥1 Blocker), or `VERDICT: PARTIAL — <what you could not verify>`. Headings, `path:line — concern`
anchors, and the verdict line stay English (parsed); concern prose may be Thai.

**Parse rules (`parseReviewerReply`):**
1. Sections split at `### Blockers|Warnings|Non-blocking|Suggestions` (case-insensitive); each
   non-empty line under a heading is one finding; `path[:line] — note` sets `file`/`line`, else
   `file: '(unanchored)'`.
2. Verdict = the **last** line matching `/^\W*VERDICT:\W*(PASS|FAIL|PARTIAL)\b(.*)$/im`; none → `missing`.
3. Any Blocker ⇒ `fail`, whatever the reviewer claimed (a "PASS" listing Blockers is a FAIL).

**Rounds ≥ 2** (reviewers are reused, not fresh) add the round number, the previous round's
Blockers per reviewer as data, and: "Judge the CURRENT subject; your memory of earlier rounds may
be stale. Keep a previous Blocker only if it still holds. Raise a new Blocker only for a real defect
(bug, broken requirement, data loss, security), including one the fix introduced — not style."

### Round evaluation (`evaluateRound`, first match wins)

| # | Condition | Decision |
|---|---|---|
| 1 | A reviewer is `missing` this round and was also `missing` last round | stop `no_structure` |
| 2 | Every reviewer is `pass` | stop `pass` |
| 3 | Zero Blockers, and at least one reviewer is `fail` | stop `no_findings` |
| 4 | Zero Blockers, no `fail`, and some reviewer is `partial` or `missing` | stop `inconclusive` |
| 5 | `round === maxRounds` | stop `max_rounds` |
| 6 | Round ≥ 2, the Blocker count is ≥ the previous round's, and every Blocker was already raised last round (same file and concern text, compared case- and whitespace-insensitively; the line is ignored because a fix shifts it) | stop `no_progress` |
| 7 | Otherwise | `fix` |

**No-change check.** Before round k ≥ 2 starts, the controller compares the fresh subject
fingerprint with round k−1's. If they are equal, it stops with `no_change`: the fix turn changed
nothing, so another review would return the same verdict. The fingerprint is `fnv1a`
(`review-board/parse.ts:56`):
- for a diff subject, over the full diffstat + diff + untracked excerpts;
- for a doc subject, over the doc's mtime (`stat_files`).

Warnings never block and never go to a fix turn; they appear in the final Board.

### Data flow

```
1. `#review pass 3 -- docs/276.md` → runHashCommand → reviewLoopCtl.start(L, rest)
2. Validate → ReviewLoop{round:0} → startRound()
3. startRound():
   a. reserveCommandTurn(L, 'review pass k/N')
   b. await collectReviewSubject(L, tail)                    (shared with #review)
   c. Every early exit below calls releaseReservedTurn(L) FIRST, so L never stays busy:
      cancelled → return
      collection failed (no repo, git error) → finish('subject_error')
      stopRequested → finish('stopped'); a reviewer no longer live → finish('reviewer_lost')
   d. k ≥ 2 and fingerprint unchanged → finish('no_change')
   e. body = reviewLoopRequestBody({round, maxRounds, subject, intent, note, lenses, previous})
   f. coordinator.deliverMentionFanOut(L.id, L.displayName, targets, body, harnessId,
                                       {replyConsumer:'harness'})
      any target failed → cancelConversationsFor(L, {consumer:'harness'}); finish('reviewer_lost')
   g. releaseReservedTurn(L, 'awaiting_peer'); system row "review pass · round k/N → A, B"
4. Each reviewer lane drains the [mention] request when idle, reviews, and peer_sends its
   reply to L (existing spec 115 behaviour).
5. L's drain(): a reply clears a pending entry whose consumer is 'harness' →
   - the row is rendered as today
   - host.onHarnessReply(L, {packetId, from, message})
   - the reply is NOT composed into a prompt for L
   The controller runs parseReviewerReply and stores the result in loop.replies.
6. When replies.size === reviewers.length (in a microtask):
   a. recordReviewOutcomeFor(L, …)               matrix row + journal, see below
   b. system row "round k/N: FAIL · 2 blockers (A FAIL 2 · B PASS)"
   c. evaluateRound → stop ⇒ finish(reason), fix ⇒ runFix()
7. runFix():
   a. phase = 'fixing'; await whenIdle(L)
   b. await enqueueSystemPrompt(L, reviewLoopFixPrompt(…), 'fixing k/N')
      (resolves when the turn ends)
   c. L in error / stopped / gone → finish('lane_lost')
      stopRequested            → finish('stopped')
      otherwise                → startRound()
8. finish(reason):
   - first, while reviewers have not all replied: cancelConversationsFor(L, {consumer:'harness'}) —
     every stop reason withdraws the round's requests, lane_lost on an errored L included
     (recomputePeerStatus leaves a stopped/errored lane's status alone).
   - cancelled or lane_lost, or no round has completed yet → system row + flash only; delete the loop.
   - otherwise → phase = 'summarizing'; await whenIdle(L);
     enqueueSystemPrompt(L, reviewLoopSummaryPrompt({reason, history, maxRounds}), 'review pass summary')
     → L composes ONE Review Board (spec 211); delete the loop.
```

**`whenIdle(L)`** resolves on the next `lane:status` whose `next` is `idle` (or at once if L is already idle). The check runs in a
microtask, because another drain-on-idle queue (specs 136, 211, 158) may claim the lane in the
same tick. It rejects when the loop is cancelled. If `enqueueSystemPrompt` returns `false`,
`whenIdle` is re-armed.

### Prompts

- **Fix turn (`reviewLoopFixPrompt`)** — round k/N and each reviewer's Blockers verbatim, as DATA.
  Fix every Blocker; leave Warnings and Suggestions. If two Blockers contradict, fix neither, call
  `attention_flag`, and end the turn (the same Blockers return and rule 6 stops the loop). Run the
  project's own type-check/tests for what you touched and fix what fails. Do not commit, call
  `review_outcome`, write a Board, or `peer_send` reviewers — the harness re-reviews when the turn
  ends. The last allowed fix round adds Empryo's line: "If a Blocker survived an earlier fix,
  reconsider the approach instead of patching it again."
- **Summary turn (`reviewLoopSummaryPrompt`)** — data: outcome and stop reason in plain words, a
  per-round table (each reviewer's verdict, Blocker/Warning counts), and the Blockers/Warnings still
  open. "Compose ONE Review Board (`review_new` → write → `review_register`) under the `#review`
  Board rules (Thai prose, English fence keys)": `## สรุป` with the outcome first, one
  `review:finding` per open Blocker or Warning, a `review:walkthrough` when the final change spans
  several files, a `review:decision` per contradiction. "Do NOT call `review_outcome`: the harness
  recorded every round."

### Review quality matrix (spec 146)

- **One row per completed round**, through `recordReviewOutcomeFor` (the store, journal, and
  transcript path `handleReviewOutcome` uses), built from the parsed replies: summed `blockers` /
  `warnings`, parsed `findings` (≤500), `reviewerCount`, and `subjectLabel` =
  `<diffstat headline | doc path> · pass k/N`.
- **Still an observation, not a score:** raw counts, no verdict (ADR-0004). The loop's pass/fail is
  control flow and is not stored.
- **Provenance changes for loop rounds only:** harness-parsed instead of lane self-reported — more
  faithful, since the author no longer summarizes its own review.

### UI

No new in-app DOM or CSS. (The browser lane monitor shows the loop live — spec 277,
`docs/277-review-pass-dashboard.md`.) System transcript rows on L for round start, round result, and stop reason
(`review pass · stopped: no progress (round 2/3)`). While reviewing, the existing pending-peer chip
gets a `review pass k/N ·` prefix; fix and summary turns show their `activeSystemLabel` (`fixing
k/N`, `review pass summary`). Help line and hash palette hint:
`#review [pass [N] | stop] [lanes…] [-- doc|note]`.

### Keybindings

| Key / command | Context | Action |
|---|---|---|
| `#review pass [N] …` | Lane composer, lane idle | Start the loop |
| `#review stop` | Any lane status | Graceful stop → summary Board |
| `#cancel` / `Ctrl+C` | Any | Hard stop, no summary |

### Configuration

None. The number of rounds comes from `N` (default 3, cap 8).

## Edge Cases

- **Reviewer never replies** → the round waits, as `#review` does; `#review stop` ends it with a summary.
- **Reviewer lane stops / errors / closes mid-round** → `cancelConversationsFor(L, { consumer: 'harness' })`, stop
  `reviewer_lost`, summary turn.
- **Reviewer sends a second message after its reply** → no pending entry left → ordinary peer turn on
  L (existing). A busy reviewer's request waits in its inbox (existing). One lane reviewing for two
  loops → each packet's pending is tracked separately.
- **Authoring lane closed / `#new` / restarted** → `lane:closed` or `stopped` → loop dropped silently.
- **Authoring lane errors or stops mid-round** → `finish('lane_lost')` withdraws the round's requests
  first, so no reviewer keeps working for a dead loop and no stale pending entry survives `#restart`
  to block the next `#review pass`. The lane stays `error` / `stopped`.
- **User prompts queued on L during a fix turn** drain first (spec 136); the next round starts on the
  following idle and reviews whatever the worktree then holds.
- **`#cancel` during `collecting`** → the controller's `cancelled` flag is checked after every await;
  an ACP cancel alone would not stop the prelude.
- **Another lane edits the shared worktree mid-loop** → included in the next round's diff, as with
  `#review`; not detectable.
- **Diff over the 40 KB cap** → the fingerprint also hashes the full diffstat, so a fix outside the
  excerpt still counts; a fix leaving every file's +/− counts identical is missed (residual).
- **Doc edited within the same second as the last check** → equal mtime → false `no_change`
  (seconds resolution; rounds take minutes — accepted).
- **Scope:** loops are per lane. Remote harness: `#review` is in
  `REMOTE_UNSUPPORTED_HASH_COMMANDS`, and `pass` inherits that.

## Decisions (for approval)

1. **The harness sequences rounds and fans out the requests** (spec 115 path), reversing spec 145's
   B2 for loop mode only (ADR-0021): deterministic stop rules, pass judged from the reviewers not
   the author, and no 40 KB copy per reviewer per round.
2. **Pass = every reviewer returns `PASS`** (zero Blockers). Warnings never block.
3. **Default 3 rounds, cap 8.** Empryo uses 5/12 with one reviewer; a Krypton round costs N reviewer turns.
4. **Reviewers are reused, not respawned**; staleness is handled by "judge the current subject" plus
   the previous Blockers as data.
5. **The harness records loop rounds in the matrix; one Board at the end**, not per round, so
   `/reviews` and Xenon auto-push are not flooded.
6. **No harness-run checks in v1**; the fix turn runs them.

## Open Questions

None. The items above are proposed decisions; any the user rejects reopens the spec.

## Out of Scope

- A harness-run typecheck/test gate, model escalation between rounds (Empryo `/goal`), token/time
  budgets, a per-round reviewer timeout, respawning reviewers, reviewer file-read coverage.
- Changes to plain `#review`, the Board grammar, review threads (spec 270), or the matrix overlay.
- Cross-harness reviewers (same constraint as `#review`); a Command Palette entry (the composer
  command is the keyboard path, as for `#review`).

## Resources

- [Empryo — The reviewer · Review until it passes](https://empryo.com/docs/agents/review#review-until-it-passes) — loop shape, verdicts, round limits, cost model.
- [Empryo — Goal loop](https://empryo.com/docs/agents/goal-loop) — same-failure exit, graceful vs hard stop, last-round "rethink".
- `~/Source/empryo/src/core/agents/agent-verification.ts` — v2 verifier: deterministic checks first, verdict line, no inherited history.
- `~/Source/empryo/locales/en.json:968-979, 4918-4945` — v3 loop stop reasons and loop UI (strings only).
- `~/Source/empryo/README.md:87` — v3 source is private.
- [Anthropic — Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) — evaluator-optimizer pattern; maximum-iteration stops.
- [Aider — Linting and testing](https://aider.chat/docs/usage/lint-test.html) — `--auto-test` deterministic fix loop.
