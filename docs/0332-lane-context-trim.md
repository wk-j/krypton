# Lane Context Trim — Implementation Spec

> Status: Implemented
> Date: 2026-10-25
> Milestone: M6 — ACP Harness

## Problem

Spec 289 split the lane context into a per-turn header and a lane policy that is resent only
when its hash changes. The policy has since grown from 2,535 to 10,064 chars (lessons 6,489,
Timeline 1,399), and the hash covers the whole text. Any lesson write in any project, a
`ticket_note`, or a Timeline backlog count change therefore resends all of it. Across 162 OMP lane
sessions (2026-10-13..25) the policy went out 246 times. 84 of those were mid-session resends,
holding 33% of every char Krypton prepended. 60 of the 84 changed nothing but lessons or the
ticket's status/revision numbers.

## Solution

Four changes to the leading block. Each one either moves volatile text out of the hashed policy
or drops text the lane already has:

1. **No tool-name line for OMP lanes.** OMP lists every mounted MCP tool in its system prompt.
2. **Lessons as a delta.** Lessons leave the policy hash. A lesson change after the policy went out
   adds a short `Lessons update` block to that turn's header, not a full resend.
3. **Ticket state in the header.** The pin keeps only the ticket id, title and rules. Status,
   context revision and resource count move to a one-line header field.
4. **Timeline as an index.** The five Timeline policy lines become one trigger line. The backlog
   count moves to a header line that appears only while the count is above 0.

Replaying the observed prompts through these rules gives 1.79M → 1.13M prefix chars (−37%) and
246 → 185 policy sends. Everything is still appended at the end of the conversation, so prompt
caching is unaffected.

## Research

- **Measured with `scripts/session-matrix.py` and the OMP transcripts** (162 sessions, 731 lane
  prompts, 17,656 model requests).
  - Resend causes: `lessons` 41, `ticket-meta` 16 (same ticket, changed status/revision/count),
    both together 3. The remaining 24 are real changes: roster 14, ticket switch 7, Timeline
    wording 2, refresh 1.
  - The tool-name line costs 273 chars on every prompt, 199,574 chars in total (11% of the prefix).
  - Krypton-originated text is about 3–6.5% of the tokens these lanes process. The range assumes
    0.25–0.55 tokens/char, because no tokenizer is available locally. This spec targets the prompt
    prefix, about a third of that.
- **Current code.**
  - `composeLeadingContext` (`acp-harness-view.ts:8697`) hashes the whole output of
    `renderLanePolicy` (`:8739`).
  - `renderTurnHeader` (`:8722`) always pushes `renderToolNameLine` when gates exist.
  - `renderActiveTicketPin` (`harness-prompts.ts:570`) writes
    `(${status}, context r${contextRevision}, ${resourceCount} resources)` into the pin's first line.
    That length also shifts the title truncation, so a revision bump can change the title text too.
  - `renderToolIndex` (`lane-context.ts:96-107`) puts `Legacy pending count: N` into the policy on
    purpose (spec 316: a count change re-delivers the obligation).
- **`PolicyDelivery` is the right home for lesson state.** `lane.policyDelivery = null` happens in
  `spawnLane` (`:7784`) and in the `sendUserPrompt` catch (`:8565`). `stale` is set on a
  compaction drop (`:8232`) and on `/compact` (`:8541`). Delivered-lesson state kept inside
  `PolicyDelivery` is therefore reset at exactly the points where the agent may have lost the list.
  It needs no new invalidation sites.
- **OMP route listing.** This lane runs OMP 18.12.6. Its system prompt carries a `MCP Tool Routes`
  section listing all 30 Krypton tools by exact name, xd:// path and a summary of ≤ 200 chars, on
  every request. Compaction summarizes messages, not the system prompt [INFERENCE], so the spec 130
  naming guarantee holds for OMP without the header line. Claude Code also loads MCP tool names
  upfront and defers only the definitions. That has not been checked against claude-agent-acp,
  so this spec gates OMP only.
- **What already carries the dropped Timeline text.**
  - The `timeline_record` result returns a `conflict_check` continuation, observed in this session.
  - The `timeline_record` / `timeline_list` descriptions carry the read-only, supersedes and
    `insufficient_evidence` rules.
  - Spec 316:33 requires the full contract in the descriptors because system/slash turns carry no
    policy.
  - The policy only needs the *trigger* to record proactively. OMP shows just the 200-char summary
    until the lane reads a tool's doc, so the trigger must stay in the policy.
- **Alternatives considered.**
  - Per-section hashing with section resends: it resends the whole 6.5K lessons block for a
    one-line change.
  - Moving the policy into a system-prompt channel: ruled out in spec 289 (only
    claude-agent-acp honors `_meta.systemPrompt`).
  - A ticket-state line only on change: it needs one more piece of delivered state to save about
    100 chars a turn, while a ticket is active.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code | CLAUDE.md and auto memory (first 200 lines / 25 KB of MEMORY.md) load at session start; MCP tool search loads only tool names and server instructions upfront, definitions on demand | No mid-session memory delta: a memory edit applies from the next session |
| Codex | AGENTS.md injected once into the initial context; MCP tools deferred once there are 100 or more | Same once-per-session model |
| Zed | Sends only user-attached context blocks per prompt; no injected policy | Krypton is the outlier in injecting at all |
| Claude Code prompt caching | New content is appended at the end so each request's prefix matches the previous one | Deltas appended to the latest user message keep that property |

**Krypton delta:** this matches the convention of rules delivered once with tools carrying their
own contracts. It diverges by updating lessons mid-session as an appended delta. Krypton's lessons
are shared live across lanes, backends and projects, so a lane learns a new rule on its next turn,
not at its next session.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/lane-context.ts` | `PolicyDelivery.lessons`; `planPolicyDelivery(prev, hash, lessons)`; `diffLessons()`; `backendListsMcpTools()`; short Timeline index lines; `renderTimelinePendingLine()`; `timelinePendingCount` comment updated |
| `src/acp/lessons.ts` | `LESSONS_UPDATE_HEADING`, `injectableLessons()`, `renderLessonsUpdate(delta)` |
| `src/acp/harness-prompts.ts` | Pin's first line without status/revision/count; new `renderTicketStateLine(t)` |
| `src/acp/acp-harness-view.ts` | `renderLanePolicy` returns `{ text, hashInput, lessons }`; `composeLeadingContext` plans lessons; `renderTurnHeader(lane, lessonsUpdate)` adds the ticket-state, Timeline-pending and lessons-update lines and gates the tool-name line |
| `src/acp/lane-context.test.ts`, `lessons.test.ts`, `harness-prompts.test.ts`, `acp-harness-view.test.ts` | Behavior tests below; drop the count-resend and pin-wording expectations they replace |
| `scripts/session-matrix.py`, `scripts/test-session-matrix.py` | Treat the new header lines (and the `Lessons update` block) as header, so header-only turns are not counted as policy sends |
| `docs/0289`, `0298`, `0316`, `0238`, `0130`, `0002` (FR-ACP-006), `0004`, `0005`, `0072`, `README` | Live contract text: header contents, delta delivery, pin format, pending-count delivery; index entry 332 |

## Design

### Data Structures

```ts
// lane-context.ts
export interface PolicyDelivery {
  hash: string;
  turnsSince: number;
  stale: boolean;
  /** slug → rule of the lessons this agent session has seen (full block or deltas). */
  lessons: ReadonlyMap<string, string>;
}
export interface LessonsDelta { changed: { slug: string; rule: string }[]; retired: string[] }
export function diffLessons(seen: ReadonlyMap<string, string>, current: readonly { slug: string; rule: string }[]): LessonsDelta;
export function backendListsMcpTools(backendId: string): boolean; // 'omp' only

// harness-prompts.ts
export function renderTicketStateLine(t: ActiveTicketPinInput): string;

// lessons.ts
export function injectableLessons(entries: readonly LessonEntry[]): LessonEntry[]; // !oversized
export function renderLessonsUpdate(delta: LessonsDelta): string | null;          // null when empty
```

### Leading block

Header (every ordinary turn, in this order; each line only when its condition holds):

```text
You are lane OMP-1.
Krypton tools (if not visible, …): …                       ← gates && !backendListsMcpTools
Ticket state: in_progress · context r15 · 0 resources — re-read ticket.md when the revision changes.
Timeline legacy pending: 3. In this working turn read timeline_list { pending: true } and resolve each ID with timeline_pending_resolve (record / duplicate / discard), then continue the user's task; if only unreadable diagnostics remain, report them and stop retrying.
Lessons update (replaces the matching entries in your Lessons list):
- [new-slug] rule text
- [old-slug] retired
Telegram provenance (…)                                    ← unchanged
```

Policy (unchanged order). Changed parts:

- Pin first line: `Active local ticket: <id> — <title>.`
- Timeline index, automatic recording on:
  `- timeline_*: you own durable project history — in ordinary working turns record evidence-backed requirements, decisions and observed outcomes yourself; this replaces older human-approval guidance (no approval queue, never attention_flag). Never write Timeline state in a read-only turn.`
- Automatic recording off:
  `- timeline_*: automatic recording is off — record no new intake; legacy resolution and conflict verdicts stay yours, never a human approval queue. Never write Timeline state in a read-only turn.`
- The `Respect explicit read-only…`, `Legacy pending count…` and `After a record…` lines are removed.

`hashInput` is the policy text with the lessons block replaced by `LESSONS_HEADING` alone, or by
nothing when there is no block. Content changes therefore never move the hash. Lessons on↔off and
empty↔non-empty still do, and those send the full policy.

### Data Flow

```
1. sendUserPrompt → buildPromptBlocks → composeLeadingContext(lane)
2. policy = renderLanePolicy(lane)                 // { text, hashInput, lessons: injectable entries }
3. plan = planPolicyDelivery(lane.policyDelivery, hashPolicy(policy.hashInput), policy.lessons)
   - send (first / hash change / stale / turn 21): next.lessons = map(policy.lessons); no update block
   - header-only: delta = diffLessons(prev.lessons, policy.lessons);
     next.lessons = map(policy.lessons); update = renderLessonsUpdate(delta)
4. lane.policyDelivery = plan.next
5. header = renderTurnHeader(lane, update) → return send ? header + '\n' + policy.text : header
```

Peer mail, `#review`, slash commands and steer still carry no leading block (spec 289). A lesson
change waits for the next ordinary turn, as the full policy does today.

### Configuration

None.

## Edge Cases

- **Prompt fails after a header-only turn carried a lessons update.** The catch sets
  `policyDelivery = null`, so the next turn sends the full policy with every lesson.
- **Compaction (detected or `/compact`).** `stale` makes the next turn a full send. An undetected
  compaction is covered by the turn-21 refresh, as today.
- **Several lesson writes between two turns.** One update block, against the last delivered map.
  A lesson that was created and then retired in between appears in neither list.
- **Oversized rule (spec 299).** `injectableLessons` filters it before the hash marker and before
  the diff. A rule that becomes oversized shows as `retired`, and one shortened back under the cap
  shows as changed.
- **Lessons disabled mid-session, or the last lesson retired.** The hash marker changes, so the full
  policy goes out without a block. This matches today's behavior.
- **Pi lanes.** They read lessons (spec 298), so they receive deltas too. The tool-name gate is per
  backend id and does not touch them.
- **Ticket switched, added or cleared.** The pin's id/title changes the hash and the full policy
  goes out. The state line disappears when the ticket is cleared.
- **Very long ticket title.** The pin no longer carries the variable-length state, so the title
  truncation stays the same across revisions.
- **Timeline pending count drops to 0 mid-session.** The header line stops. Without a pending line
  there is no prompt to rescan, so the policy's old `No legacy intake… do not rescan` sentence is
  not needed.
- **OMP changes its route listing** (cap or deferral). The gate is one entry in
  `backendListsMcpTools`; removing `'omp'` restores the line.

## Verification

- **Unit, `lane-context.test.ts`.**
  - `diffLessons` (added, changed rule, retired, no change).
  - `backendListsMcpTools('omp')` is true; `claude`, `codex` and `pi-acp` are false.
  - Pending line rendering for counts 0 and above.
  - A count change leaves `planPolicyDelivery.send` false.
- **Unit, `harness-prompts.test.ts`.** The pin is byte-identical across status, revision and count
  changes. The state line carries all three.
- **Integration, `acp-harness-view.test.ts`, via the production `composeLeadingContext`.**
  - An OMP header has no tool-name line; a Claude header keeps it.
  - A lesson added after turn 1: turn 2 is the header plus a one-line update and no policy; turn 3
    is the header only.
  - Ticket revision r1 → r2 does not resend the policy, and the header shows r2.
  - A ticket id switch resends the policy.
  - Pending 24 → 23 does not resend; 0 removes the line.
- **Script.** The new `scripts/test-session-matrix.py` cases classify the new header lines as
  header.
- **Runtime smoke.** Run `npx tauri dev` with one OMP lane and one Claude lane in a temp project.
  1. Send turn 1, then record a lesson from the Claude lane, then send OMP turn 2.
  2. `#ticket new` → `ticket_note` → send OMP turn 3.
  3. Read the OMP transcript's raw prompts and run
     `python3 scripts/session-matrix.py --project <tmp> --backend omp --since 1d`.
  4. Expected: one policy send and zero resends; turn 2 carries the update block; turn 3 carries
     the new revision.
- **Then:** `npm run check`, `npm test -- --run`, and `python3 -W error scripts/test-session-matrix.py`.

### Results (2026-10-25)

- `npm run check` passed. `npm test -- --run` passed: 232 files, 2,946 tests.
  `python3 -W error scripts/test-session-matrix.py` passed: 8 tests.
- **Runtime smoke, with deviations from the plan above.**
  - **Setup.** The debug `app` binary ran against the Vite dev server under an isolated `HOME`, so
    lessons, harness memory and controller state stayed out of the real `~/.config/krypton`.
    `~/.omp` and `~/.codex` were symlinked in for adapter auth.
  - **Driving.** The control API ran `harness.create`, `lane.spawn` and `lane.send`.
  - **Codex instead of Claude** as the non-OMP lane, because Claude's keychain auth is uncertain
    under a different `HOME`.
  - **Ticket.** Pre-seeded as a bundle plus an active-ticket pointer, because `#ticket` is a
    composer command the control API does not reach.
  - **Lesson and note.** Recorded by calling `lesson_record` / `ticket_note` on the harness MCP
    endpoint directly, as a lane would.
- **What the agents received** (read from their own transcripts):
  - **OMP turn 1:** header without the tool-name line, `Ticket state: … r1`, then the policy with
    the stable pin and one lesson.
  - **OMP turn 2:** 291 chars, `Ticket state: … r2` plus a one-line `Lessons update`, no policy.
  - **OMP turn 3:** 157 chars, header only.
  - **Codex turn 2:** the tool-name line, `r2` and the same update, no policy.
  - Every turn of both lanes replied `ok`.
- **Session matrix.** `scripts/session-matrix.py` on the smoke project counted the OMP session as
  1 policy send, 0 resends and 2 header-only turns.

## Open Questions

None. Decisions taken:

- **Tool-name line gated for OMP only.** Claude Code is plausible but unverified.
- **Ticket state line on every turn while a ticket is active.** About 100 chars a turn; this is
  simpler than tracking delivered state.
- **The Timeline trigger stays in the policy, the contract stays in the descriptors.**

## Out of Scope

- MCP descriptor deduplication, `timeline_list` default payload, per-lane `tools/list` gating
  (analysis group 2).
- Lessons language, caps or project scoping. Spec 298 fixed global scope and Thai text by user
  decision (analysis group 3).
- Gating the tool-name line for Claude, Codex or other backends.
- Moving roster changes out of the hash (2 resends in the sample).

## Resources

- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp) — tool search loads only tool names and server instructions at session start; basis for keeping the name line on non-OMP backends until verified.
- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching) — appended content keeps the cached prefix; header deltas append like any user turn.
- [Prompt caching — Claude API](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — prefix order tools → system → messages; nothing here edits earlier messages.
- Internal: specs 130, 194, 238, 289, 298, 299, 316; `scripts/session-matrix.py`; Timeline events `tl-20261025T151736Z-074e4f`, `tl-20261025T152655Z-3f052f`.
