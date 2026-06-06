# Simplify `#review` — Agent-Orchestrated Multi-Reviewer (Diff or Design Doc) — Implementation Spec

> Status: Implemented
> Date: 2026-06-06
> Milestone: M-ACP — Harness Peering
> Supersedes the structured-review *delivery/findings/UI* machinery of `docs/112`
> (the shared git-diffstat collector is retained — see Affected Files).
> Reviewed by lanes Codex-2 (architecture/correctness) and Cursor-1
> (requirements-fit/simplicity); their findings are folded in below.

## Problem

The current `#review` (spec 112) is over-engineered for a keyboard tool with a
human in the loop: a structured git `ReviewPacket` (worktree fingerprint,
partial-staging detection, churn-sorted hunk caps), a rigid `review_reply` findings
schema, dedicated `review_request`/`review_reply` MCP tools, a bespoke delivery path
with a per-sender `inFlightReviews` guard, and a `ReviewCard` UI. It also reviews
**one** lane only. The user wants `#review` to be far simpler, to consult **several
reviewers at once** (one reviewer shares the author's blind spots), and — since the
design stage is where being wrong is most expensive — to be able to review a
**design document**, not only a code diff.

## Solution

Replace the bespoke review channel with the lightweight `#wiki` pattern (spec 144),
**agent-orchestrated** (decision **B2**): `#review` collects the review *subject*
(a bounded `git diff` **or** a design-doc file) and injects **one** prompt via
`enqueueSystemPrompt`. The prompt directs the convening lane to `peer_send` the
subject to **every** named reviewer **in that one turn** (explicitly overriding the
default "end your turn after one send"), end its turn, then **synthesize** replies
as they arrive — routing genuine forks to the human via `attention_flag`. The
agent owns orchestration and aggregation; the harness stays thin (harness
philosophy: discoverability, not embedded state machines).

Multi-reviewer rides `peer_send`'s **per-target** guard (`inter-lane.ts:835`), so
N distinct targets are permitted. The net change is a large **deletion** (findings
schema, `ReviewCard`, both MCP tools, the dedicated delivery path) while **retaining
a shared minimal git-diffstat collector** that an unrelated feature depends on.

## Research / Review Findings (folded in)

- **`peer_send`'s "end your turn" contract is a reliability risk for fan-out**
  (Codex-2). The tool description and lane context both say "end your turn after
  `peer_send`" (`hook_server.rs:2287`, `acp-harness-view.ts:3803`), so an agent may
  stop after reviewer 1. **Mitigation (B2):** the orchestration prompt explicitly
  instructs "call `peer_send` for *all* listed reviewers this turn, *then* end."
  Per-target guard already permits it. **Accepted residual risk:** delivery to all
  N is best-effort (model compliance), not harness-guaranteed — stated plainly,
  per the user's B2 choice.
- **Synthesis-after-all is not a harness primitive** (Codex-2: replies drain and
  wake the requester one at a time, `inter-lane.ts:304,876,985`). Under B2 the
  convening lane handles aggregation in-conversation (it knows how many reviewers it
  sent to and waits/aggregates in its own reasoning). Non-deterministic but
  consistent with the agent-owned design; documented as a trade-off.
- **Deleting the git-state types breaks attention triage** (Codex-2, critical).
  `enrichJudgementDiffstat()` uses `acp_collect_review_git_state` + `ReviewGitState`
  + `buildReviewPacket` for an attention item's blast-radius; `JudgementItem.diffstat`
  and `attention-overlay.ts` consume `ReviewDiffstatEntry` (`acp-harness-view.ts:1810`,
  `types.ts:423`, `attention-overlay.ts:9,41`). → **Retain a shared minimal
  diffstat collector + `ReviewDiffstatEntry`**; only the review-specific extras go.
- **`git diff HEAD` alone is insufficient** (Codex-2): omits **untracked/new files**
  (often the core of a feature) and **fails on an unborn HEAD** (no commits) even
  though `rev-parse --is-inside-work-tree` succeeds. → collector must include bounded
  untracked content/status and handle the empty-tree fallback as a distinct case.
- **Keep collector hygiene** (Codex-2): preserve `--no-pager --no-ext-diff
  --no-textconv` (`hook_server.rs:1470`); do not coerce non-zero `git diff` into an
  empty diff; the byte cap bounds the *payload*, not process memory; truncate on a
  UTF-8 boundary with the marker inside the cap.
- **Include intent** (Codex-2 + Cursor-1): a raw diff without "what I was trying to
  do" reproduces spec 112's original problem. Carry transcript-derived intent
  (cheap; `buildPacketFromTranscript` already extracts it) into the prompt.
- **Prose needs a skim format** (Cursor-1): instruct reviewers to use a light
  markdown template (`### Blockers` / `### Warnings` + `path:line — concern`) so
  N replies don't drown as undifferentiated peer rows (cf. spec 120). ~5 prompt
  lines, not a validated schema.
- **`#cancel` clears *all* pending peers, not a batch** (Codex-2,
  `acp-harness-view.ts:5152`). Under B2 there is no batch object, so this is simply
  documented: `#cancel` aborts the whole review.
- **Direction confirmed right by both reviewers:** multi-reviewer, `#wiki`-style
  `enqueueSystemPrompt`, deleting the bespoke MCP reply path + `ReviewCard`, diff
  cap, round-robin lenses, and `attention_flag` on forks.

## Decisions (resolved with the user)

- **Q1 = (b):** subject may be a **design-doc path** (`#review <lanes> -- docs/NN.md`)
  **or** the working diff (default). Reviewing the design before coding is the
  highest-value case.
- **Q2 = B2:** agent-orchestrated fan-out, no harness batch state machine.
- **Q3 = auto-detect reviewers:** lane args optional; bare `#review` reviews with
  all other live local lanes (manual naming is a subset override).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Rewrite `runReviewCommand` (parse optional N reviewers — default to all other live local lanes when none named — + `-- <docpath\|note>`, collect subject, `enqueueSystemPrompt(reviewRequestPrompt(...))`). Delete `buildAndDeliverReviewRequest`, the `review_reply` listener (`:2535`), `ReviewCard` rendering (`:9952`) + transcript kind (`:135`), `reviewReplyAttemptsThisTurn` (`:989,1436`). **Keep** `enrichJudgementDiffstat` working via the retained collector |
| `src/acp/review.ts` | Reduce to `reviewRequestPrompt(...)` + a `buildDiffstat`/intent helper used by attention triage. Delete `ReviewFinding`, validation, `composeReviewerPrompt`, `composeReviewReplyPrompt` |
| `src/acp/inter-lane.ts` | Delete `deliverReviewRequest`, `deliverReviewReply`, `inFlightReviews`, review envelope branches (`:99,1081`). Peer path untouched |
| `src/acp/types.ts` | Remove `ReviewPacket`/`ReviewFinding`/`ReviewCardPayload`/review channel types (`:273,423`). **Keep `ReviewDiffstatEntry`** (attention triage) |
| `src-tauri/src/hook_server.rs` | Delete `review_request` + `review_reply` tool descriptors/handlers; **keep** `collect_git_state`, extended with bounded untracked + unborn-HEAD handling; fix stale review comments (`:1253`) |
| `src-tauri/src/commands.rs`, `lib.rs` | Keep `acp_collect_review_git_state` (now shared by `#review` + attention); update handler registration only if signatures change |
| `src/acp/review.test.ts` | Delete findings/validation tests; add `reviewRequestPrompt` content tests (fan-out-all instruction, skim template, lens assignment, doc-vs-diff subject) |
| `src/acp/inter-lane.test.ts` | Remove the 4 review-delivery tests (peer tests stay) |
| `src/acp/acp-harness-view.test.ts` | Add `#review` arg-parsing (`-- docpath` vs note, multi-lane) + injection tests |
| `src/styles/*.css` | Remove `ReviewCard` styles |
| `docs/PROGRESS.md`, `docs/112-*.md`, `docs/113-*.md`, `CLAUDE.md` | Doc sync; mark 112 partially superseded; fix 113's stale `inFlightReviews` mutex claim |

Final implementation gate: a repo-wide `rg 'review_request|review_reply|ReviewPacket|ReviewCardPayload|reviewPacketId|composeReviewer'` must come back empty (Codex-2's sweep requirement) + `npm run check` + `cargo build`.

## Design

### Command syntax

```
#review [<lane> ...] [-- <docpath | focus note>]
```

- **Lane args are optional (Q3).** Omit them and the harness auto-resolves the
  reviewer set to **all other live lanes in this view** (it already holds
  `this.lanes`; the agent can also confirm via `peer_list`). Naming lanes is the
  **override** for a specific subset.
- Reviewers resolved by `displayName` (case-insensitive, exclude self; `:2095`);
  stopped/error and cross-project lanes excluded from the auto set (diff subject
  needs a shared worktree); ≥1 valid reviewer required.
- After `--`: if the token resolves to an existing repo file (e.g. `docs/145.md`),
  the subject is that **design doc** (the agent reads it); otherwise it is a free
  **focus note** and the subject is the working diff.

### `acp_collect_review_git_state` (retained, simplified)

Returns `{ hasGitRepo, isUnbornHead, diffstat: ReviewDiffstatEntry[], diff, untracked }`:
- `diff`: `git --no-pager diff HEAD --no-ext-diff --no-textconv`, payload-capped
  (`REVIEW_DIFF_CAP` ~40 KB, UTF-8-safe, marker inside the cap).
- `untracked`: bounded head excerpts of untracked files (so new files are visible).
- `isUnbornHead`: true when there are no commits → callers diff against the empty
  tree / report "no committed baseline."
- Drops fingerprint, partial-staging, churn-sort, commands/tool summaries. Keeps
  `diffstat` (for attention triage) and the git hygiene flags.

### `reviewRequestPrompt({ reviewers, subject, intent, note }): string`

One-shot instruction (sibling to `wikiIngestPrompt`) telling the convening lane to:
1. **Fan out in this turn:** for *every* reviewer, call `peer_send { to_lane,
   message, done:false }` — message = subject (diff or doc reference + content) +
   intent + focus note + the reviewer's round-robin lens (architecture /
   requirements-fit / simplicity) + a request to reply using the skim template
   (`### Blockers` / `### Warnings`, `path:line — concern`). **Send to ALL reviewers
   before ending the turn** (overrides the default single-send guidance).
2. End the turn.
3. As replies arrive (separate user-turns), track how many of the N reviewers have
   answered; once all have (or the user `#cancel`s), synthesize: cluster concerns
   raised by ≥2 reviewers (high signal), list conflicts, note unique catches.
4. Route a genuine unresolved fork to the human via `attention_flag`; do **not**
   auto-commit. Reviewer count + lenses embedded as data (cf. `wikiIngestPrompt:495`).

### Data Flow

```
1. User: `#review -- docs/145.md`  (no lanes → auto = all other live local lanes)
   or:    `#review Codex-2 Cursor-1 -- focus on error handling`  (explicit subset, diff)
2. runHashCommand (:5283) → runReviewCommand(L, parts.slice(1))
3. Validate (≥1 live reviewer, L idle); classify `--` arg as docpath vs note;
   if diff-subject: await acp_collect_review_git_state(cwd)
4. enqueueSystemPrompt(L, reviewRequestPrompt({...})) → L.client.prompt(...)
5. L peer_sends the subject to Codex-2 AND Cursor-1 this turn, then ends turn
6. Reviewers drain on idle, review independently, reply via peer_send (skim prose)
7. Replies arrive to L as user-turns; L aggregates once both in; fork → attention_flag
```

### UI Changes

Net removal: no `ReviewCard`. `flashChip` for validation + `#review → Codex-2,
Cursor-1`. `peer_send`/reply use existing peer-message rows.

## Edge Cases

- **No valid reviewers** (bare `#review` with no other live local lane, or all named
  lanes invalid) → `flashChip('#review: no reviewable lanes')`.
- **Lane busy** → `flashChip('lane busy - #cancel first')` (`:5354`).
- **Diff subject, no git repo** → `flashChip('#review: no git repo in lane cwd')`.
- **Unborn HEAD** → collector reports it; prompt notes "no committed baseline; review
  untracked/working state shown."
- **Doc path doesn't exist** → treated as a focus note (diff subject), not an error.
- **Empty diff** → prompt notes it and points reviewers at intent + untracked excerpts.
- **A reviewer never replies** → lane waits; user `#cancel`s (clears *all* pending
  peers for the lane — documented).
- **Agent ends turn after reviewer 1** → known B2 residual; later reviewers simply
  don't receive it. Mitigated by the explicit "send to all first" instruction.

## Open Questions

None blocking. Decisions: Q1=(b) doc-or-diff subject, Q2=B2 agent-orchestrated.
Residual B2 risks (all-reviewer delivery + synthesis are model-driven, not
guaranteed) accepted per user direction.

## Out of Scope

- Structured/anchored findings + clickable `ReviewCard` (removed; re-addable later).
- Worktree-drift fingerprint + partial-staging warning (removed).
- Harness-side batch state / dedup / clustering (B1 — rejected in favour of B2).
- Cross-project / cross-harness reviewers.

## Resources

- `docs/144-harness-wiki-command.md` — the `#`-command + `enqueueSystemPrompt` pattern.
- `docs/112-*.md` — the review system being partially superseded.
- `docs/106-inter-lane-messaging.md` — `peer_send` lifecycle, per-target pending.
- `src/acp/inter-lane.ts:835` (`hasPendingTo`, per-target) vs `:365`
  (`inFlightReviews`, per-sender) — why fan-out lives on `peer_send`.
- `src/acp/acp-harness-view.ts:1810` (`enrichJudgementDiffstat`) — the retained
  collector's other consumer.
