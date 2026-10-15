# Global Lane Lessons — Implementation Spec

> Status: Implemented
> Date: 2026-10-14
> Milestone: M-ACP — Harness
> Builds on: 289 (lane-context delta) · 128/183 (attention redirect/acknowledge) · 146 (review_outcome) · 165 (memory is handoff-only) · ADR-0001 · ADR-0003 · ADR-0004

## Problem

A lane that is corrected (an attention redirect, a reviewer blocker, the human pushing back in chat) forgets the correction when its session ends, and no other lane sees it. The same mistake recurs in the next session, in another backend, and in another project. Native agent memories don't cover this. Claude Code's auto memory is per repo and per backend, Codex memories are off by default, and Cursor has dropped Memories. Krypton's own durable stores are per project: handoffs, and the code wiki. Nothing is shared across every backend and every project.

## Solution

Add **lessons**: short behavioural rules that lanes write when they are corrected. Krypton stores them globally in `~/.config/krypton/lessons/` and injects them into the lane policy of **every lane in every project** (spec 289 delivery).

- **Write:** two new Rust-only MCP tools, `lesson_record` (upsert by slug) and `lesson_retire`. Rust does the writing because lane sandboxes cannot reliably write outside the project cwd. Codex `workspace-write` blocks it, and Claude Code prompts for it.
- **Trigger:** lanes record only at correction moments. Krypton adds a one-line nudge to redirect envelopes, to the `review_outcome` result when it has blockers, and to the `#review pass` fix prompt. A new `#lesson [hint]` command asks the lane to distill the session's corrections on demand.
- **Read:** lanes see all active lessons in the policy. Humans read a generated `INDEX.md` in the in-app Markdown Viewer (`#lessons` or the palette). The lesson files are plain markdown, so a human can edit or delete them directly.
- **Bound:** at most 30 active lessons, with one ≤ 240-char rule each. From 24 active (spec 299) a `lesson_record` create returns a `notice` asking the lane to consolidate on that turn; at 30 a new slug is refused — with the whole store listed — which forces the lane to merge or retire before adding. A rule a human edited past 240 chars is held out of the injected policy until it is shortened.

Decisions taken:
- Scope is global only, per the user's request.
- Lessons go live without a human approval step (ADR-0001 self-report; the human reads, the LLM does the work). Every write is visible in the transcript.
- Free text is in Thai, matching the existing Krypton-tool language rule.

## Research

- **Policy delivery (spec 289).** `renderLanePolicy` (`acp-harness-view.ts:8638`) is rendered synchronously on every `sendUserPrompt`. `hashPolicy` (`lane-context.ts:46`) hashes the exact text, so any lessons rendered into it trigger a resend on change. The policy is otherwise resent on a new session, on compaction, and every 20 turns. Nothing new is needed for delivery. The packet reads cached view state only (directives via `refreshDirectives`, handoffs via `refreshMemory` + the `acp-harness-memory-changed` event), so lessons follow that same pattern: a cached field, refreshed on start and on a Rust event.
- **Policy turns vs system turns.** `enqueueSystemPrompt` / `dispatchTurn` turns (peer mail, redirects, `#wiki`) carry no packet. That is why `#lesson` must restate the language rule itself.
- **MCP plumbing.** Tools are declared in `bus_tool_descriptors()` (`hook_server.rs:6152`) and dispatched in `handle_bus_tool_call` (:4253). `handoff_set` (:5928) is the Rust-only template: validate, atomic write (`write_file_atomic` :7651), emit an event. A new tool must also be added to:
  - `tool_category` (:3549), plus its test;
  - `HARNESS_AUTO_ALLOW_TOOL_NAMES`, the regex, and `harnessToolFamily` (`harness-permission-scan.ts:63-164`); otherwise every call prompts.
  The tool must not be project-backed (:6295), so it is not hidden when the harness has no project.
- **Reach.** Every backend except Pi gets the bus, either through `session/new` or through native overlays (Junie, Cline, Cursor). Remote lanes reach the local hook server (`remote_harness_forward_memory`), so one local store serves them too. Pi lanes cannot call tools but still receive the policy text.
- **Correction signals.**
  - `deliverRedirect` (`inter-lane.ts:406`) is the cleanest human-correction signal.
  - `review_outcome` currently returns only `{recorded:true}`. Its handler (:4975) has the blocker count, so it can add a just-in-time `notice`, the same pattern spec 289 used for the `timeline_record` ack.
  - The `#review pass` loop never calls `review_outcome` itself; its blockers reach the lane through `reviewLoopFixPrompt` (`review-loop.ts:367`).
- **Why not reuse existing stores.**
  - `handoff_set` is handoff-only, with no exceptions (spec 165).
  - Repo markdown (ADR-0003) cannot be global.
  - Native memories are per backend and per repo.
  - On-demand `lesson_get` was rejected: a rule the agent does not read is useless. Claude Code and Copilot both inject memories at session start for this reason.
- **Staleness (spec 165's objection) applies less here.** Handoff staleness comes from snapshots of repo state. Lessons are behavioural rules with no code citations to drift, so Copilot-style citation checks don't apply. The remaining risk is a rule that is wrong or over-general. Retirement and the visible transcript line handle that.

## Prior Art

| System | Implementation | Notes |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` holds user rules for all projects, written by hand. **Auto memory** is written by Claude from corrections and lives per repo at `~/.claude/projects/<repo>/memory/`. The first 200 lines or 25 KB of `MEMORY.md` load every session, and Claude is told to shorten it near the limit. | The closest model, but per repo and Claude-only. Krypton copies the "auto-written from corrections, loaded every session, size-capped" pattern. |
| Codex CLI | Global `~/.codex/AGENTS.md` is written by hand. **Memories** are off by default; they are background-summarized into `~/.codex/memories/`. The docs say must-apply rules belong in AGENTS.md, not memories. | Global, but limited to Codex. |
| GitHub Copilot Memory | `store_memory` tool; each memory has a subject, fact, and **citations**. Recent memories are injected at session start, and citations are verified before use. Memories are repo-scoped and expire after 28 days unused. | Citation checks fit code facts, not behaviour rules. Reported merge rate rose from 83% to 90%. |
| Windsurf Cascade | Auto-generated memories are **workspace-scoped**. `global_rules.md` is written by hand and capped at 12,000 chars per file. | Global scope exists only for hand-written rules. |
| Cursor | Generated Memories UI was removed in 2.1; staff say to export them into User/Project Rules. | Shows the failure mode of unmanaged generated memory. |
| Reflexion (Shinn et al., NeurIPS 2023) | The agent writes verbal self-reflections on feedback into an episodic buffer that conditions later trials. | The research basis: learning through text, not weights. |

**Krypton delta.** No product here combines auto-written lessons with global scope across *backends and projects*. Auto-written stores are per repo, and global stores are hand-written. Krypton matches convention on the shape: auto-written from corrections, injected at session start, size-capped, plain files a human can edit. It diverges on scope (global, cross-backend) and on gating: lanes write only at human or reviewer correction points, never ambiently, and a full store forces consolidation instead of growing.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/lessons.rs` | **New.** Store: list, upsert, and retire under a `Mutex`; frontmatter parse/write; `INDEX.md` render; validation and caps; unit tests. |
| `src-tauri/src/hook_server.rs` | `lesson_record` / `lesson_retire` descriptors and dispatch. `tool_category` → `"lessons"`. Hide both from `tools/list` when disabled. Emit `acp-lessons-changed`. Add the `review_outcome` `notice` when blockers ≥ 1. Tests. |
| `src-tauri/src/commands.rs`, `lib.rs` | `list_lessons` command (registered). |
| `src-tauri/src/config.rs`, `src/config.ts` | `AcpHarnessConfig.lessons: bool`, default `true`. |
| `src/acp/lessons.ts` (+test) | **New.** `LessonEntry` / `LessonsSnapshot` types, `renderLessonsBlock()`, the nudge sentences, the `[acp_harness] lessons` flag, and the app-wide cache (`refreshLessons()`, idempotent `watchLessons()`). |
| `src/acp/lane-context.ts` (+test) | `LaneToolGates.lessons`. Tool-name line adds `lesson_record, lesson_retire`. One tool-index line. |
| `src/acp/acp-harness-view.ts` (+test) | `watchLessons()` + `refreshLessons()` on start. `renderLanePolicy` appends the block. `#lesson` / `#lessons` dispatch (`#lessons` is remote-unsupported). A per-harness `acp-lessons-changed` listener adds the transcript line and flash. The redirect call passes `lessonNudge`. |
| `src/acp/harness-review-loop-controller.ts` | Passes `lessonNudge: lessonsEnabled()` to `reviewLoopFixPrompt`. |
| `src/acp/harness-view-types.ts` | `HarnessToolFamily` gains `'lessons'`, used in the auto-allow reason. |
| `src/compositor.ts` | `setLessonsEnabled()` on config apply and Reload Config; `openLessons()` for the palette. |
| `src/acp/artifact-tools.html` | `/tools` page section for the `lessons` category. |
| `src/acp/inter-lane.ts` (+test) | `deliverRedirect(laneId, text, lessonNudge = false)` appends the nudge sentence. |
| `src/acp/review-loop.ts` (+test) | `reviewLoopFixPrompt` appends the nudge when `lessonNudge`. |
| `src/acp/harness-prompts.ts` (+test) | `lessonDistillPrompt(hint)`. |
| `src/acp/harness-permission-scan.ts` (+test) | Auto-allow `lesson_record`, `lesson_retire`. |
| `src/acp/hash-commands.ts` (+test) | `lesson`, `lessons` in `HASH_COMMANDS` + `commandMeta()`. |
| `src/command-palette.ts` | "Open Lessons" → Markdown Viewer on `INDEX.md`. |
| Docs | `docs/0072` (new `### Lessons` subsection, hash table, auto-allow list, config), `docs/0006` (`[acp_harness] lessons`), `docs/0005` (lesson flow), new `docs/adr/0024-lessons-are-global-harness-held-rules.md`, `CONTEXT.md` (**Lesson** term), `docs/README.md`. |

## Design

### Storage

`~/.config/krypton/lessons/<slug>.md` (via `config::config_dir()`), one file per lesson:

```markdown
---
title: ตรวจด้วยเครื่องมือก่อนบอกว่าแก้แล้ว
source: redirect            # redirect | review | correction | manual
origin: krypton             # project basename it was learned in (display only)
author: Claude-1
created: 2026-10-14
updated: 2026-10-14
---
เมื่อจะบอกว่าแก้เสร็จ ให้รันคำสั่งตรวจ (test/build/screenshot) เองก่อน ห้ามโยนให้ผู้ใช้ตรวจแทน

## Why
...

## How to apply
...
```

- **Frontmatter** is hand-parsed as `key: value` lines (no YAML crate).
- **Validation:**
  - `slug` matches `^[a-z0-9][a-z0-9-]{2,47}$`;
  - `title` ≤ 80 chars;
  - `rule` is a single line of ≤ 240 chars;
  - `why` / `how_to_apply` ≤ 600 chars each.
- **Writes** are atomic (temp file + rename, in `lessons.rs`) and serialized by one store mutex.
- **Update** keeps `created` and `origin` from the first write; `author` and `updated` follow the latest write.
- **Retire** moves the file to `lessons/retired/<slug>.md` and adds `retired:` / `retired_reason:` lines. Recording that slug again later creates a fresh active lesson.
- **`INDEX.md`** is regenerated after every write and on every `list_lessons`. Its banner says it is generated. It lists each active lesson in full, plus any files that fail to parse under **Invalid**, plus any whose rule is over the length cap under **Oversized rules (not injected)** with its character count (spec 299).
- **`MAX_ACTIVE_LESSONS = 30`**, with `PRESSURE_WATERMARK = 24` (spec 299): a `lesson_record` create that raises the active count to the watermark or above returns a `notice` asking the lane to consolidate now. An update never carries one, so the consolidation the notice asks for does not nag again.
- **Create vs update** is decided by the *parsed* set, not by `path.exists()` (spec 299). A slug whose file fails to parse is not an active lesson, so writing onto it is a create and faces the cap — an invalid file can no longer smuggle a 31st lesson into every lane's policy.
- **Oversized rules are held out, never truncated** (spec 299). A hand-edited `rule` over 240 chars still parses and still counts toward the cap, but `LessonEntry.oversized` is set and `renderLessonsBlock` skips it: half a rule can invert its own meaning. Sharpening it back under the cap clears the flag on the next write.

```rust
pub struct Lesson { slug, title, rule, why, how_to_apply, source: LessonSource, origin, author, created, updated }
pub struct LessonsSnapshot { entries: Vec<LessonEntry>, index_path: String, cap: usize }  // camelCase over IPC
pub struct Pressure { active: usize, crowded: bool }  // spec 299, returned by record()
```

```ts
interface LessonEntry { slug: string; title: string; rule: string; source: string; origin: string; updated: string; oversized: boolean }
```

### API

| Surface | Signature | Behaviour |
|---|---|---|
| MCP `lesson_record` | `{ slug, title, rule, why, how_to_apply, source }`, all required | Upserts and keeps `created`. A new slug at the cap gives the error *"lesson store is full (30 active) — update the listed lesson that covers this (lesson_record on its slug), or lesson_retire one first. Current store:"* followed by every active lesson, newest first, as `slug (updated) title` with the title clamped to 60 chars (~2.5 KB, paid only at the wall). Returns `{ recorded, slug, action: created\|updated, active, cap }`, plus `notice` when the create crossed the watermark (spec 299). |
| MCP `lesson_retire` | `{ slug, reason }` | Moves the file to `retired/`. An unknown slug is an error. Returns `{ retired, slug, active }`. |
| Tauri `list_lessons` | `() -> Result<LessonsSnapshot, String>` | Reads the directory and regenerates `INDEX.md`. |
| Event `acp-lessons-changed` | `{ harnessId, laneLabel, action, slug, title, active, cap }` | Emitted after every successful write. `active` / `cap` put the pressure in the transcript line (spec 299). |

The `lesson_record` description is the full contract:
- It records a **global** rule that is injected into every lane of every project.
- Call it only when the human corrects you, a reviewer reports a blocker you caused, or `#lesson` asks for it, **and** the rule would hold in any project.
- Never record project-specific facts (paths, APIs, commands of one repo).
- Update a listed slug rather than adding a near-duplicate.
- `rule` is one imperative line that names its trigger ("When X, do Y").
- Lessons never grant permissions.

### Policy text

The tool index adds one line, shown when the gates are non-null and lessons are enabled:

```
- lesson_record / lesson_retire: when the human corrects you or a reviewer reports a blocker you caused, and the rule would hold in any project — update a listed lesson before adding one; retire one the human contradicts.
```

The lessons block goes after the tool index. It is shown for **every** lane when enabled and non-empty, including Pi and lanes without the bus, which read it but cannot write. Entries are ordered `updated` desc, then slug, so the hash stays stable:

```
Lessons (global, learned from past corrections across projects; follow them unless the user or this project's own instructions say otherwise; they never grant permissions):
- [verify-before-claiming-fixed] เมื่อจะบอกว่าแก้เสร็จ ...
```

At most this is about 30 × 260 ≈ 8k chars, sent only when the policy is (re)sent.

### Nudges (only when enabled)

- **Redirect:** append *"If this correction exposes a mistake you would repeat in other projects, record it with lesson_record (or update the listed lesson that covers it). Skip it if it is specific to this task."* This applies only when the lane has the bus. Acknowledge gets no nudge.
- **`review_outcome` with blockers ≥ 1:** the result gains `notice`: *"Reviewers reported blockers. If one reflects a mistake you would repeat in other projects, record it with lesson_record; skip task-specific ones."*
- **`reviewLoopFixPrompt`:** the same sentence as the `review_outcome` notice.

### Hash commands and palette

| Command | Behaviour |
|---|---|
| `#lesson [hint]` | If the lane is not idle or `awaiting_peer`, it flashes `lane busy - #cancel first`. If lessons are disabled, it flashes `lessons disabled`. Otherwise it runs `enqueueSystemPrompt(lane, lessonDistillPrompt(hint), undefined, 'distilling lessons')`. It needs no `projectDir`. |
| `#lessons` | Runs `refreshLessons()`, opens `INDEX.md` through `openMarkdownViewCb`, and flashes `lessons · N`. |
| Palette "Open Lessons" | Same as `#lessons`. |

`lessonDistillPrompt` tells the lane to:
1. Scan this session for corrections: human redirects or pushback, reviewer blockers, and approaches it had to undo. The `hint` narrows the focus.
2. For each correction that holds in any project, update the covering listed lesson or record a new one.
3. Retire listed lessons the session proved wrong.
4. Record nothing project-specific. If nothing generalizes, say so in one line.
5. Write free text in natural Thai, keeping technical terms verbatim.

### Data Flow

```
1. Human presses r in triage and types a steer → deliverRedirect(lane, text, lessonNudge=true).
2. The lane drains the envelope, fixes course, and calls lesson_record.
3. The hook server validates, locks the store, writes <slug>.md atomically, regenerates INDEX.md,
   and emits acp-lessons-changed.
4. Every open harness view (any tab, any project) runs refreshLessons() → list_lessons → cache.
   The originating lane gets the transcript line "[lesson] created: <slug> — <title> (N/30)" and a
   flash chip; a create that raised the count to 24+ also returns a consolidation notice (spec 299).
5. The next sendUserPrompt on any lane renders the new lessons block → hashPolicy differs → the
   policy is resent.
6. A harness opened later in another project calls refreshLessons() at start, so its first policy
   already carries the lessons.
```

### Configuration

```toml
[acp_harness]
lessons = true   # false: no policy block, tools hidden from tools/list, no nudges, #lesson disabled; files untouched
```

The setting is read at harness start and on Reload Config. Rust reads it from config state when serving `tools/list` and handling tool calls.

## Edge Cases

- **Hand-edited or deleted file:** picked up on the next `refreshLessons()` (harness start, `#lessons`, or any change event). There is no filesystem watcher, consistent with the rest of the app.
- **Malformed file:** skipped from injection with a `warn!`, and listed under **Invalid** in `INDEX.md` so the human sees it.
- **Two lanes write the same slug at once:** the store mutex serializes them and the last write wins. Both lanes get `action: updated|created` accordingly.
- **Store full:** the error tells the lane to merge or retire, and lists every active lesson newest first so it chooses against the live store, not the policy it was handed at the start of the turn. Updating an existing *valid* slug always succeeds; a slug whose file no longer parses counts as a create and is refused until that file is fixed or retired (spec 299).
- **Rule edited past 240 chars by hand:** the file stays, still counts toward the cap, and is named under **Oversized rules** in `INDEX.md` — but it is not injected, because a truncated rule can invert its own meaning (spec 299).
- **Pi or other lane without the bus:** reads the lessons block but gets no tool names. `#lesson` still injects the prompt and the lane reports that it has no tools, the same as the `#handoff` precedent.
- **Remote lane:** writes go to the local store through the forwarded hook-server port.
- **Lane records a project-specific fact anyway:** the transcript line makes it visible. The human deletes the file or tells a lane to `lesson_retire` it.
- **Lesson conflicts with the current instruction:** the policy says the user and project instructions win. The tool contract says to retire or rewrite a lesson the human contradicts.
- **Poisoned lesson via repo content (prompt injection persisting across projects):** accepted risk, recorded in ADR-0024. Mitigations:
  - lessons are framed as advisory and never grant permissions;
  - approval gates (spec 140) are unchanged;
  - every write shows in the transcript;
  - sizes are capped;
  - the files are human-auditable.
- **Disabled:** existing files stay on disk. Turning lessons back on restores them.

## Out of Scope

- Project-scoped lessons.
- Changing or syncing native agent memories (Claude Code auto memory, Codex memories).
- A loopback browser page for lessons, Xenon publishing, or cross-machine sync.
- Automatic expiry or decay.
- Semantic retrieval.
- Any per-lane score derived from lessons (ADR-0004).
- Fixing the existing quirk where Pi lanes are advertised bus tool names.

## Resources

- [How Claude remembers your project — Claude Code docs](https://code.claude.com/docs/en/memory): auto memory is per repo, written from corrections, and loads the first 200 lines / 25 KB of MEMORY.md each session, with near-limit shortening. The source of the cap-and-consolidate design.
- [Building an agentic memory system for GitHub Copilot](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/): the `store_memory` tool, citations verified at use, injection at session start, and the merge-rate result.
- [Copilot Memory — GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory): repo scope and 28-day expiry.
- [Codex Memories — OpenAI](https://developers.openai.com/codex/memories): memories are off by default and summarized in the background into `~/.codex/memories`; must-apply rules belong in AGENTS.md.
- [Windsurf Cascade Memories](https://docs.windsurf.com/windsurf/memories): auto memories are workspace-scoped, global rules are hand-written in `global_rules.md`, 12k-char cap.
- [Cursor forum — Custom modes and memories gone in 2.1](https://forum.cursor.com/t/custom-modes-and-memories-gone-in-2-1/143744): the Memories UI was removed and users were told to migrate to Rules.
- [Reflexion: Language Agents with Verbal Reinforcement Learning (NeurIPS 2023)](https://arxiv.org/abs/2303.11366): learning through stored verbal reflection, not weight updates.
