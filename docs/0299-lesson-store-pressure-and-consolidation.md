# Lesson Store Pressure and Consolidation — Implementation Spec

> Status: Implemented (2026-10-15)
> Date: 2026-10-14
> Milestone: M-ACP — Harness
> Builds on: 298 (global lane lessons) · 289 (lane-context delta) · 146 (review_outcome notice) · ADR-0024

## Problem

Spec 298 bounds the lesson store with a hard refusal: at 30 active lessons, a new
slug is rejected (`lessons.rs:464`). Nothing ever reorganizes the store, so the
bound degrades into a wall. Three consequences:

1. **Corrections are lost at the cap.** The refusal arrives mid-turn, after the
   lane already decided what to record. The lane typically reports the failure
   and moves on; the correction is never written. The store is most likely to be
   full exactly when the human has been correcting a lot.
2. **The lane gets no warning.** There is no signal between "plenty of room" and
   "refused". Consolidation only happens if a human runs `#lesson`.
3. **The cap leaks, and oversized rules ride into the policy.** `record()` reads
   `Created` / `Updated` from `path.exists()` while the cap counts only files
   that parsed (`lessons.rs:456-468`), so writing onto a slug whose file is
   invalid skips the check and leaves 31 active. Separately, a hand-edited
   `rule` has no length check on read (`parse_lesson:242-308` only requires a
   title and a non-empty rule), so a 5,000-char rule is injected into every
   lane's policy at full length.

## Solution

Keep the refusal as the final backstop — Krypton deletes nothing on its own — and
add pressure signalling plus two correctness fixes, so the store consolidates
before it hits the wall and what it injects is always a whole rule.

1. **Pressure notice.** When a `lesson_record` write *raises* the active count to
   24 of 30 or higher, the tool result carries a `notice` telling the lane to
   consolidate now: merge near-duplicates by re-recording on the existing slug,
   retire what the human has contradicted. Reuses the `review_outcome` notice
   pattern (`hook_server.rs:5015`) — no scheduler, no extra turn, and the lane is
   already awake with the full lesson list in its policy.
2. **Actionable refusal.** The full-store error lists every active lesson, newest
   first, as `slug · updated · title`, so the lane merges or retires against the
   store as it is right now rather than against the policy it was handed at the
   start of the turn.
3. **Close the cap leak.** The `Created` test becomes `existing.is_some()`, which
   reads the same parsed set the cap counts, so an invalid file can no longer
   smuggle a 31st lesson into every lane's policy.
4. **Oversized rules stop being injected.** A `rule` over 240 chars is held out of
   the policy and listed in `INDEX.md` as oversized with the fix, instead of
   being truncated. A half-sentence rule can invert its own meaning.
5. **Visible count.** `acp-lessons-changed` carries `active` / `cap`, so the
   transcript line reads `[lesson] created: slug — title (27/30)` and the human
   sees pressure without opening `INDEX.md`.

Consolidation stays model-driven. Krypton decides *when* to consolidate; the lane
decides *what* to merge. `#lesson` remains the human-triggered path and gains
nothing new.

## Research

- **The cap is enforced in exactly one place, and it reads the wrong set** —
  `record()` checks `action == Created && loaded.lessons.len() >= MAX_ACTIVE_LESSONS`
  (`lessons.rs:464`) with `action` derived from `path.exists()` (`:459`), while
  `loaded.lessons` excludes anything `load_active` could not parse (`:337-346`).
  A slug whose file is invalid therefore reads as `Updated` and skips the check.
  Updating a *valid* slug must keep passing: that is the property the
  consolidation path depends on, since a full store still has to absorb a
  sharpened rule.
- **Parse is deliberately tolerant** (`lessons.rs:239-241`): only a missing
  frontmatter block, title, or rule makes a file invalid. A length check there
  would drop hand-edited files from every lane with no explanation. Holding an
  oversized rule out of the injected view (`entry()`, `lessons.rs:415-424`) while
  `INDEX.md` names it and says how to fix it keeps the file, bounds the packet,
  and never ships half a sentence as a rule.
- **`retired/` is left alone.** It grows, but it is never injected, never read on
  the hot path, and holds small markdown files — and `lesson_retire` promises the
  human a recoverable file (`hook_server.rs:6018`). Pruning it would also be the
  one deletion Krypton performs on its own, which this spec rules out. Worse,
  unparseable files move with `std::fs::rename` (`lessons.rs:522`), which keeps
  the original mtime, so an mtime-ordered prune could delete a file retired
  minutes ago.
- **The notice pattern already exists.** `review_outcome` attaches
  `REVIEW_LESSON_NOTICE` to its result when blockers ≥ 1
  (`hook_server.rs:5015`, `:5948`). A pressure notice is the same shape, so no
  new plumbing, no new prompt-injection path, and it is gated by the same
  `lessons_enabled(&state.config)` check.
- **`active` is already returned** by `record` / `retire`
  (`hook_server.rs:6104-6110`, `:6125`), so the watermark test costs nothing.
- **Why not automatic eviction.** `updated` is a bad proxy for value: a rule
  recorded once and obeyed ever since has an old date *because it works*. Silent
  deletion also breaks ADR-0024's property that every lesson change appears in a
  lane transcript. ADR-0004 (no scores, no ranking) is about scoring *lanes* in
  the review matrix, not about ordering lessons, so it does not decide this;
  the argument against eviction is the proxy being wrong, not that ADR.
- **Why not an auto-injected consolidation turn.** `enqueueSystemPrompt` could
  fire `lessonDistillPrompt` when the store fills, but it would interrupt a lane
  doing unrelated work, cost a full turn, and let a mid-task model rewrite rules
  with no human watching. The notice rides a turn that is already happening.

## Prior Art

| Product | At capacity / on write | Krypton lesson |
|---|---|---|
| [mem0](https://github.com/mem0ai/mem0/blob/main/docs/open-source/features/custom-update-memory-prompt.mdx) | Every write is an LLM decision over similar existing memories returning `ADD`, `UPDATE`, `DELETE`, or `NONE`; updates reuse the original memory ID | Dedupe belongs at the write, decided by a model — matches "re-record on the existing slug" over appending a near-duplicate |
| [ChatGPT / Codex memories](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-faq) | Memory is user-managed: individual deletes, clear-all, or off; the summary is auto-updated as the user chats | Humans keep an editable store; automatic deletion is not how the convention works |
| [Letta / MemGPT](https://docs.letta.com/letta-agent/memory) | Core memory blocks carry a size limit and the agent self-edits them; a queue manager signals pressure before flushing (search-result summary; the docs pages returned 404 on fetch) | Warn at a watermark, let the agent rewrite its own block — the shape adopted here |
| Claude Code memory | Per-repo files the user edits; no capacity management | No prior art for a cross-project store to copy |

**Krypton delta.** Convention is either model-managed dedupe at write time (mem0)
or human-managed deletion (ChatGPT). Krypton keeps the human-readable store and
the human's delete key, and adds a watermark that makes the *lane* consolidate at
the moment it is already writing — because Krypton's store is global, so one
over-general rule costs every project, and only the lane knows which two rules
say the same thing.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/lessons.rs` | `PRESSURE_WATERMARK` const; `Created` derived from `existing.is_some()`; `record` returns `Pressure`; full-store error lists every active lesson; `LessonEntry.oversized`; `render_index` oversized section; unit tests |
| `src-tauri/src/hook_server.rs` | `LESSON_PRESSURE_NOTICE`; `lesson_record` attaches it when a create crosses into the watermark; `emit_lessons_changed` carries `active` / `cap`; tests |
| `src/acp/lessons.ts` (+test) | `LessonsChangedPayload.active` / `.cap`; `LessonEntry.oversized`; `renderLessonsBlock` skips oversized entries |
| `src/acp/acp-harness-view.ts` (+test) | Transcript line appends `(N/cap)` |
| `docs/0298-global-lane-lessons.md`, `docs/0072-acp-harness-view.md` | Record the watermark, the cap-leak fix, and the oversized-rule rule under the existing Limits text |
| `docs/README.md` | Index entry 299 |

## Design

### Constants

```rust
/// Active count at which lesson_record starts asking the lane to consolidate.
pub const PRESSURE_WATERMARK: usize = 24; // 80% of MAX_ACTIVE_LESSONS
```

### API

```rust
pub struct Pressure { pub active: usize, pub crowded: bool }
pub fn record(..) -> Result<(RecordAction, Pressure), String>
```

`crowded` is `action == Created && active >= PRESSURE_WATERMARK`: only a write
that *raised* the count can nag, so re-recording onto an existing slug — the very
act the notice asks for — never triggers another one. The notice therefore fires
at most seven times in the life of a store (at 24 through 30).

`hook_server::lesson_record` keeps its `active` / `cap` fields and adds `notice`
when `crowded && lessons_enabled`:

> The lesson store is at 27/30. Before your next one, merge the near-duplicates
> you can see in your Lessons list — call lesson_record on the slug that already
> covers a rule rather than adding one beside it — and lesson_retire any the
> human has since contradicted. If none of them genuinely overlaps, add yours and
> leave the rest alone.

The full-store error carries the **whole** active set, newest first, because the
lesson that covers this correction is not reliably the oldest one, and the policy
the lane is holding can already be stale (another lane may have written during
this turn):

```
lesson store is full (30 active) — update the listed lesson that covers this
(lesson_record on its slug), or lesson_retire one first. Current store:
  verify-before-claiming-done (2026-10-14) ตรวจด้วยเครื่องมือก่อนบอกว่าแก้แล้ว
  …28 more rows…
  stale-slug-a (2026-04-02) Title A
```

Thirty rows with titles clamped to 60 chars cap the error near 2.5 KB, paid only
at the wall.

### Data Flow

```
1. Lane calls lesson_record; Rust writes the file and reloads the store.
2. record() returns Pressure { active, crowded }.
3. hook_server attaches `notice` when crowded, and emits
   acp-lessons-changed { .., active, cap }.
4. The lane reads the notice in the same tool result and, on this turn,
   re-records onto an existing slug or retires one — that write carries no
   second notice.
5. The transcript line shows `(27/30)`; the policy hash changes, so every lane
   sees the consolidated set on its next turn.
6. At 30, a new slug is still refused — now with the whole store listed.
```

### Oversized rules

`entry()` sets `oversized: true` when `rule` exceeds `MAX_RULE_CHARS`; the
frontend's `renderLessonsBlock` skips those entries, so the policy packet stays
bounded without ever shipping a truncated rule — a cut sentence can drop the
exception that made the rule safe. `render_index` lists them under
`## Oversized rules (not injected)` with the character count and the fix (shorten
the first paragraph to 240 chars). They still count toward the cap: an oversized
lesson is a real lesson that is temporarily unusable, not a free slot.

## Edge Cases

- `[acp_harness] lessons = false` — no notice, no event, no behavior change.
- Lane ignores the notice — unchanged: the refusal still backstops at 30.
- Store crosses the watermark via a human deleting files by hand — no event
  fires (no watcher); the next write or `#lessons` refresh picks it up.
- Retire drops the count back under the watermark, then a new create raises it
  again — the notice returns. That is one notice per crossing, not per write.
- A slug whose file is invalid is re-recorded at 30 active — refused, because
  `Created` now comes from `existing.is_some()` and the invalid file is not in
  that set. Fixing or retiring the broken file is the way through.
- An oversized rule is sharpened back under 240 chars — the next write clears
  `oversized`, and the lesson returns to every lane's policy on the next turn.
- Invalid files still do not count toward the cap (`load_active:317-351` splits
  them out); they remain listed in `INDEX.md` under `## Invalid files`.

## Out of Scope

- Automatic eviction, expiry, or any deletion Krypton performs on its own —
  including pruning or archiving `retired/`, which keeps `lesson_retire`'s
  promise that a retired file is recoverable.
- Semantic dedupe in Rust (no embeddings, no similarity scoring).
- Counting invalid files toward the cap, or auto-repairing them.
- Raising `MAX_ACTIVE_LESSONS`, per-project scoping, or syncing the store.
- A filesystem watcher.

## Resources

- [mem0 — custom update-memory prompt](https://github.com/mem0ai/mem0/blob/main/docs/open-source/features/custom-update-memory-prompt.mdx) — the `ADD` / `UPDATE` / `DELETE` / `NONE` decision per write, and ID retention on update.
- [mem0 — how it works](https://docs.mem0.ai/core-concepts/how-it-works.md) — write-time consolidation sits between app and model.
- [OpenAI — Memory FAQ](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-faq) — memory is user-managed: per-item delete, clear-all, or off.
- [ChatGPT Learn — Memories](https://learn.chatgpt.com/docs/customization/memories) — ChatGPT and Codex keep separate stores; durable team guidance belongs in `AGENTS.md`.
- [Letta — memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks/index.md) — size-limited self-edited blocks (consulted as a search-result summary; both docs URLs returned 404 on fetch).
