# Review Board Is Opt-In — Implementation Spec

> Status: Implemented
> Date: 2026-10-14
> Milestone: M-ACP — Harness
> Builds on: 145 (`#review` fan-out) · 211 (Review Board) · 276 (`#review pass`) · 146 (review quality matrix)

## Problem

Every `#review` ends by forcing a Review Board. `reviewRequestPrompt`
(`review.ts:196-206`) tells the convening lane to compose one "instead of
reporting it in your turn text", and step 5 makes even an all-LGTM round produce
a Board. That costs a `review_new` round trip, a full document write, a
`review_register` round trip, and the tokens to author a skim document — after
the reviewers have already answered. The user wants the verdict, not a document,
and the Board turns a finished review into several more minutes of work.

## Solution

Turn the Board into something the user asks for.

1. **Default: no Board.** The convening lane reports the synthesis as turn text —
   clustered concerns, conflicts between reviewers, unique catches — and still
   calls `review_outcome`, so the quality matrix (spec 146) keeps every round.
2. **Opt-in: a leading `board` token**, in the same slot `pass` / `stop` already
   occupy: `#review board Codex-1 -- note`, `#review pass board 3`. With it, the
   prompt carries today's Board instructions unchanged.
3. **Asking afterwards still works.** `review_new` / `review_register` stay
   available, so "ทำ Review Board ให้หน่อย" after reading the synthesis produces
   one from the same replies, with no re-review.

## Research

- **The Board is prompt-driven, not app-driven.** `#review` only collects the
  subject and dispatches `reviewRequestPrompt` (`acp-harness-view.ts:3345-3371`);
  the transcript card is raised by the `acp-harness-review` event that
  `review_register` emits (`hook_server.rs:6296-6310`, listener at
  `acp-harness-view.ts:6838`). Making the Board optional is therefore a prompt
  change plus one token of command parsing — no registry, event, or card change.
- **`pass` / `stop` already set the precedent** for a reserved leading token
  (`acp-harness-view.ts:11450-11456`), including the assumption that no lane is
  named after it. `board` joins that set.
- **The spec-211 rationale still holds where it applies.** The comment at
  `review.ts:193-195` is right that turn text scrolls away and carries no reading
  order — which is why the Board stays one token away, and why `#review-thread`
  (a Board Guide by definition) is untouched. What it got wrong is making that
  trade for every round, including the one-reviewer LGTM round.
- **`review_outcome` is independent of the Board.** It is its own tool call
  (`hook_server.rs:5014-5041`) and the matrix row costs one round trip, so the
  default keeps it.

## Prior Art

| Tool | Where the review output lands | Lesson |
|---|---|---|
| `gh pr review` | Verdict + comments go to the PR; no separate document is generated | The verdict is the product; a document is a separate, deliberate artifact |
| GitHub Copilot code review | Inline comments by default; a summary only when the change warrants it | Default to the cheap surface, escalate on demand |
| Danger / reviewdog | Bot posts findings inline; a report file is produced only when configured | Report generation is opt-in in every CI reviewer that offers it |

**Krypton delta.** Krypton keeps the Board — it is better than any of these for
explaining a change — but stops charging for it on every round. The token is
Krypton-specific because `#review` is a keyboard command, not a CI hook.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/review.ts` (+test) | `ReviewRequestPromptInput.board?: boolean`; steps 4 / 4b / 5 become the turn-text synthesis unless `board`; step 7 routes a fork to `attention_flag` when there is no Board |
| `src/acp/review-loop.ts` (+test) | Same flag on the `#review pass` summary instruction (`:450-453`) |
| `src/acp/harness-review-loop-controller.ts` | Strip a leading `board` from the loop args and carry the flag |
| `src/acp/acp-harness-view.ts` (+test) | `runReviewCommand` strips a leading `board`; the chip shows `+board` when set |
| `src/acp/hash-commands.ts` (+test) | `args` becomes `[pass [N] | stop] [board] [<lane>…] [-- <doc | note>]`; anatomy mentions the default |
| `docs/0145-harness-design-review-panel.md`, `docs/0211-review-board.md`, `docs/0276-review-till-pass.md`, `docs/0072-acp-harness-view.md` | Record that the Board is opt-in and how to ask for one later |

## Design

### API

```ts
export interface ReviewRequestPromptInput {
  reviewers: string[];
  subject: ReviewSubject;
  intent: string;
  note?: string;
  /** spec 300: `#review board …` — compose a Review Board instead of turn text. */
  board?: boolean;
}
```

### Prompt delta

`board: true` keeps steps 4, 4b, 5, 6, 7 exactly as they are today. `board`
absent or false replaces 4 / 4b / 5 with one step and adjusts 7:

> 4. Report the synthesis in your turn text — at most 8 lines. Lead with the
>    verdict, then the blockers, then warnings worth acting on, then conflicts
>    between reviewers and catches only one reviewer made. Each finding is one
>    line as `path:line — concern`. If every reviewer said LGTM, say so in one
>    line and stop. Do NOT call `review_new`; the user asks for a Review Board
>    when they want one.

> 7. … If the reviews surface a genuine unresolved fork, raise it with
>    `attention_flag` (there is no Board to carry a `review:decision`).

### Command grammar

```
#review [board] [<lane>…] [-- <doc | note>]
#review pass [board] [N] [<lane>…] [-- <note>]
#review stop
```

`board` is only recognized as the first token after `#review` (or after `pass`),
matching how `pass` / `stop` are read today. A lane named `board` would shadow
it — the same reservation `pass` / `stop` already carry.

## Edge Cases

- `#review board` with no live reviewers — unchanged: `#review: no reviewable lanes`, nothing dispatched.
- `#review pass board` — every round reports in turn text; only the end-of-loop summary becomes a Board.
- User asks for a Board after reading the synthesis — the lane calls `review_new` / `review_register` from the replies already in its context; no re-review, no new fan-out.
- `#cancel` mid-review — unchanged: no synthesis, no Board, no `review_outcome`.
- A reviewer lane is literally named `board` — the token wins; rename the lane or use `#review -- <note>` with the full reviewer set.

## Out of Scope

- A config key for the default (one mechanism only: the token).
- `#review-thread`, whose whole output is a Board Guide.
- Removing or gating the `review_new` / `review_register` tools.
- Changing the Board document format, the card, or the `.krypton/reviews/` layout.
- Auto-Boards from any other surface (attention, diff window, `#wiki`).

## Resources

N/A — purely internal change; the prior-art row above is from existing knowledge of those tools, not from new research.
