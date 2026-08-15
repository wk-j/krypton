# Developer Daily Note — Implementation Spec

> Status: Implemented
> Date: 2026-08-15
> Milestone: M-ACP — Harness convergence

## Problem

A day of work in Krypton leaves plenty of evidence on disk — per-turn usage rows, commits, review bundles, artifacts — but nothing that answers the one question a developer asks each morning: *what did I do yesterday, and what did I leave unfinished?* Reconstructing it by hand means joining five different stores, and the one store that holds prose (`acp-harness-memory`) is overwritten state, not a log, so yesterday's reasoning is simply gone.

## Solution

Two halves, deliberately separated.

1. **Capture** — an append-only `.krypton/journal/<YYYY-MM-DD>.jsonl`. The harness already routes every event worth recording (handoff written, attention flagged, review synthesized, artifact registered, goal set, ticket bound); the journal tees them to disk with a timestamp. Backend-agnostic by construction — it works for Grok, Codex, and Cursor lanes, which have no transcript on Krypton's side of the wire.
2. **Compose** — `daily_note_build(cwd, date)` joins that journal with the stores that already exist (`usage_log::read_day`, `git log`, `.krypton/reviews/`, `.krypton/artifacts/`) into a `DayDigest`, and a pure TS renderer turns it into markdown at `.krypton/journal/<date>.md`, opened in the existing Markdown Viewer.

**The renderer is deterministic — no LLM, no inference.** Every line traces to a record. Narrative is a separate, explicit act: `#daily brief` feeds the rendered note back to the lane as a prompt. That keeps "what happened" (a record you can trust) apart from "what it meant" (a guess you asked for).

## Research

- `usage_log.rs` already partitions by day (`.krypton/usage/<YYYY-MM-DD>.jsonl`) and exposes `read_day(cwd, date) -> Vec<TurnRecord>` and `rollup(cwd, date, recording) -> UsageRollup` with `by_model` / `by_lane` groups. The `usage_today` command wraps `rollup`. Nothing new is needed on the numeric side.
- `TurnRecord.duration_ms` is **wall-clock from prompt to turn end**, so it includes time the lane spent waiting on the human. A sample built on 2026-08-15 showed a single Claude-3 turn at 1.57 h. It must never be labelled "time worked" — the renderer calls it *lane wall-clock*.
- `git.rs` already has `run_git(cwd, args)`, `repo_root`, and `working_diff_stat(cwd)` (spec 220). The commit half is `git log --since/--until --numstat`; no new process plumbing.
- Review bundles land at `.krypton/reviews/<YYYY-MM-DD>-<slug>/review.md` (spec 217), self-contained and already date-prefixed. Artifacts at `.krypton/artifacts/<harnessId>/<lane>/<id>.html` carry their title in `<title>`.
- **Krypton does not read `~/.claude/projects/*.jsonl` anywhere.** A sample note built by mining those files recovered good narrative but covered only `backend: claude` — the lane that did the most work that day (Grok-2, 26 turns / 3.32 h) had no transcript at all. Mining a second vendor's private on-disk format to half-cover the problem was ruled out in favour of capturing at the harness, where every lane is already visible.
- `acp-harness-memory/*.json` holds `lanes[].summary/detail` with a single `updatedAt`, overwritten on every write — verified empty for 2026-08-15 despite 46 turns that day. Confirms it is state, not history, and cannot back a daily note.
- `compositor.openMarkdownView(path?)` and `commands.rs::write_file` already exist; the note needs no new view type.

## Prior Art

| Tool | Implementation | Notes |
|---|---|---|
| [dev-journal](https://github.com/LakshmiSravyaVedantham/dev-journal) | Collects git commits, file changes, shell history; `collect` then `generate` produces standup notes and weekly summaries | Closest shape. Capture and compose are separate commands — the split this spec adopts |
| [devlog](https://dev.to/zeshama/devlog-i-built-an-ai-powered-developer-journal-that-turns-git-commits-into-stories-3fdl) | Reads git history, pipes it through Copilot CLI to produce a narrative journal | LLM does all the work; output is unreproducible and can drift from the commits it cites |
| [Dayflow](https://github.com/JerryZLiu/Dayflow) | Screen recording → AI timeline of activity cards, local-first | Highest fidelity, highest cost/intrusion. Krypton already has the structured events, so screen capture buys nothing |
| [GitDailies](https://gitmore.io/blog/github-activity-digest-notification-tools) / [Gitrecap](https://www.gitrecap.com/features/git-reports) | Server-side digest of commits/PRs/issues pushed to Slack or email | Team-facing standup, not a personal record; only sees what reached the remote |
| [Obsidian Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) + Templater | Creates `YYYY-MM-DD.md` from a template on a schedule; Dataview queries across notes | Defines the file convention users already expect: one dated markdown file, wikilinked |

**Krypton delta** — Match the Obsidian convention exactly (one `YYYY-MM-DD.md`, `[[wikilinks]]`, frontmatter) so the output is at home in the existing Vault Viewer (spec 59) or a real vault. Diverge from every tool above on the input: none of them see *agent* activity — which lane, which model, how many turns were cancelled, what was flagged for human judgement, what a review round returned. That is Krypton's unique substrate and the reason this is built in rather than shelled out to `dev-journal`. Also diverge from `devlog` by refusing to let an LLM write the record: generation is deterministic, narrative is opt-in.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/journal.rs` | **New** — journal append/read, `DayDigest` assembly, `daily_note_build` |
| `src-tauri/src/commands.rs` | Register `journal_append`, `daily_note_build`, `daily_note_write` |
| `src-tauri/src/lib.rs` | Register the three commands; wire `journal::prune` into the existing usage-log prune pass |
| `src-tauri/src/config.rs` | `[daily_note]` section (`enabled`, `retain_days`, `extra_projects`, `output_dir`) |
| `src/acp/journal.ts` | **New** — typed `journalAppend()` helper the harness calls at capture points |
| `src/acp/daily-note.ts` | **New** — pure `renderDailyNote(digest): string` |
| `src/acp/daily-note.test.ts` | **New** — renderer tests against a fixture digest |
| `src/acp/acp-harness-view.ts` | Capture calls at 6 existing sites; `#daily` dispatch in `runHashCommand` |
| `src/acp/hash-commands.ts` | Register `#daily` in `HASH_COMMANDS` |
| `src/acp/harness-prompts.ts` | `dailyBriefPrompt()` for `#daily brief` |
| `src-tauri/src/hook_server.rs` | `collect_journal_notes`, `render_journal_list`, `journal_index_page`, `GET /journal`; `render_docs_harness_bar` generalised over route |
| `src/compositor.ts` | `openDailyNote(date?)` — build, write, hand to `openMarkdownView` |
| `src/command-palette.ts` | `daily.open` entry |
| `src/input-router.ts`, `src/which-key.ts` | `Leader J` binding |
| `docs/06-configuration.md`, `docs/05-data-flow.md`, `docs/02-functional-requirements.md`, `docs/README.md` | Doc updates |

## Design

### Data Structures

```rust
// journal.rs — one appended row. Deliberately small and flat.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEvent {
    pub v: u32,               // 1
    pub at: i64,              // epoch ms
    pub kind: JournalKind,
    pub harness_id: String,
    pub lane: String,         // display name, e.g. "Claude-4"
    pub backend: String,
    #[serde(default)] pub model: Option<String>,
    /// One line, already human-readable. The renderer never reformats it.
    pub summary: String,
    /// Kind-specific extras (issueKey, blockers, artifactId, itemId …).
    #[serde(default)] pub meta: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalKind {
    Session,    // lane opened / #new / resume
    Goal,       // #goal set|clear
    Handoff,    // handoff_set
    Attention,  // attention_flag / attention_resolve
    Review,     // review_outcome
    Artifact,   // artifact_register
    Ticket,     // #ticket / issue-binding phase change
    Note,       // #daily note <text> — the human's own line
}

// The composed, read-only view a note is rendered from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayDigest {
    pub date: String,                       // YYYY-MM-DD, local
    pub project: ProjectDigest,             // cwd's repo
    pub extra: Vec<ProjectDigest>,          // config `extra_projects`
    pub events: Vec<JournalEvent>,          // merged, time-ordered
    pub generated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDigest {
    pub name: String,
    pub path: String,
    pub usage: crate::usage_log::UsageRollup,   // reused as-is
    pub first_turn_at: Option<i64>,
    pub last_turn_at: Option<i64>,
    pub cancelled_turns: i64,
    pub user_origin_turns: i64,
    pub system_origin_turns: i64,
    pub max_context_used: Option<i64>,
    pub commits: Vec<CommitEntry>,          // hash, at, subject, files, ins, del
    pub uncommitted: Option<WorkingDiffStat>,   // reuse spec 220
    pub reviews: Vec<ReviewEntry>,          // slug, path (dir name is dated)
    pub artifacts: Vec<ArtifactEntry>,      // id, title, lane, at
}
```

### API / Commands

| Command | Signature | Notes |
|---|---|---|
| `journal_append` | `(cwd: String, event: JournalEvent) -> Result<(), String>` | Append-only. Failure is logged and swallowed by the caller — never blocks a turn |
| `daily_note_build` | `(cwd: String, date: Option<String>) -> Result<DayDigest, String>` | Pure read. `date` defaults to today, local |
| `daily_note_write` | `(cwd: String, date: String, markdown: String) -> Result<String, String>` | Writes `<output_dir>/<date>.md`, returns the path |

No new IPC events — the note is pull-only.

### Data Flow

```
Capture (throughout the day)
1. Harness handles handoff_set / attention_flag / review_outcome / artifact_register / #goal / #ticket
2. Existing handler additionally calls journalAppend({ kind, lane, summary, meta })
3. journal.rs appends one line to .krypton/journal/<today>.jsonl

Compose (on demand)
4. User presses Leader J, runs #daily, or picks "Open Daily Note"
5. compositor.openDailyNote(date) → invoke('daily_note_build', { cwd, date })
6. journal.rs assembles ProjectDigest per project:
   usage_log::read_day + rollup · git log --since/--until --numstat ·
   working_diff_stat · walk .krypton/reviews/<date>-* · walk .krypton/artifacts (mtime on date)
7. Frontend renderDailyNote(digest) → markdown string (deterministic)
8. invoke('daily_note_write', …) → .krypton/journal/<date>.md
9. compositor.openMarkdownView(path)

Narrative (opt-in)
10. #daily brief reads the same file and sends dailyBriefPrompt(markdown) to the lane
11. The lane's answer is ordinary turn text — it is NOT written back into the note
```

### Note Structure

Frontmatter (`date`, `type: daily-note`, `repos`, `turns`, `commits`, `tags`) then, in order:

1. **Header line** — activity span, repo count, turns, commits, uncommitted file count
2. **ที่ทำวันนี้** — one section per commit, keyed to the spec number parsed out of the subject (`spec NNN` / `(NNN)` / `docs/NNN-`), rendered as a `[[NNN-slug]]` wikilink; journal events falling inside that commit's window listed under it
3. **ค้างอยู่** — `working_diff_stat` files, plus any `Attention` event with no matching `attention_resolve`
4. **Lane ที่ลงแรง** — table from `usage.by_lane`, column labelled *lane wall-clock*
5. **Review & artifacts** — links to `review.md` bundles and artifact HTML
6. **งานนอก repo** — one line per `extra` project
7. `<details>` **ที่มาของข้อมูล** — source table, every row `derived`

The note is written in Thai (matching the harness's lane-context default); identifiers, paths, spec numbers, and commit subjects stay verbatim.

### Keybindings

| Key | Context | Action |
|---|---|---|
| `J` | Compositor mode | Open today's Daily Note (`Leader J` — `j` is Focus Down; no Alt, per house rule) |

`#daily` in the harness composer:

| Form | Action |
|---|---|
| `#daily` | Build + open today's note |
| `#daily <YYYY-MM-DD>` | Build + open that day's note |
| `#daily note <text>` | Append a `Note` event — the human's own line for today |
| `#daily open` | Open `/journal` — every rendered note, in the browser |
| `#daily brief` | Build today's note, then ask this lane to narrate it |

### Browser Surface — `GET /journal`

An **index only**, in the shared loopback chrome (`render_docs_page`, same
Binance-dark styling as `/docs` and `/reviews`): a harness bar, a filter box,
and one row per rendered note, newest day first. Rows link to
`/doc?harness=<id>&path=.krypton/journal/<date>.md` — the **existing** docs
reader, which already validates any `.md` under a harness working directory.
There is no journal reader, so notes inherit markdown rendering, the spec-172
live reload, inline feedback, and the spec-174 artifact export without any of it
being reimplemented.

`collect_journal_notes` is a plain `read_dir` of one flat directory, not the
`WalkBuilder` the `/docs` index uses. `.krypton/` is both dot-prefixed and
gitignored, so `standard_filters(true)` drops every note — correctly, since
lifting those filters for `/docs` would also admit `node_modules` and every
other ignored markdown file in the repo. A `<date>.generated.md` sibling is
listed as its own row, labelled, directly after the canonical day it stands in
for.

### Configuration

```toml
[daily_note]
enabled = true              # master switch for journal capture
retain_days = 400           # .krypton/journal/*.jsonl pruning; .md files are never pruned
output_dir = ".krypton/journal"   # relative to project root, or an absolute vault path
extra_projects = []         # absolute paths also summarised in the note
```

## Edge Cases

| Case | Handling |
|---|---|
| No journal file for the date | Digest still builds from usage + git; note renders without the event sections |
| No activity at all | `daily_note_build` returns an empty digest; the note says so in one line rather than erroring |
| `cwd` is not a git repo | `commits` and `uncommitted` are empty; usage and events still render |
| Work crosses midnight | Rows land in the day they occurred (local date). No stitching — a 01:00 commit belongs to the new day |
| Usage rows pruned by `[usage_log] retain_days` | Older `.md` notes already exist and are never regenerated; rebuilding an old date yields a thinner note (stated in the note's source table) |
| `journal_append` fails (disk full, permissions) | Logged at `warn!`, swallowed. Capture must never fail a turn |
| Same date rebuilt | The `.md` is overwritten. A human-edited note is protected: if the file exists and its `generated` frontmatter is absent, write to `<date>.generated.md` instead and say so |
| `extra_projects` path missing or unreadable | Skipped with a `warn!`; the note lists it as unavailable rather than omitting it silently |
| Journal event summary contains newlines | Collapsed to one line at append time — the format is one row, one line |
| Very long day (thousands of events) | Renderer caps each section at 50 entries with a `+N more` line; the jsonl stays complete |

## Out of Scope

- **Mining `~/.claude/projects/*.jsonl` or any vendor's private transcript store.** Covers one backend of six and couples Krypton to a format it does not own
- LLM-written note content. `#daily brief` narrates on request; it never edits the file
- Weekly/monthly/yearly rollups (the Obsidian *Periodic Notes* superset)
- Pushing the note to Xenon, Telegram, or Slack
- Backfilling notes for dates before this feature ships
- A dedicated content view — the note is markdown, and the Markdown Viewer already renders it
- A dedicated browser *reader* for notes — `/journal` is an index; `/doc` reads
- `[[wikilink]]` resolution in the browser reader. The in-app Vault Viewer resolves them; `/doc` renders them as literal text, and teaching it Obsidian syntax is a docs-browser change, not a daily-note one

## Implementation Notes

Deviations from the design above, and why.

| Change | Reason |
|---|---|
| The local day is an explicit `tz_offset_minutes` parameter threaded from the frontend, not something Rust derives | The process has no reliable zone. `local_day_range` turns a date into an epoch-ms window and **every** source is filtered by instant; only usage *file selection* stays UTC, because that is how `usage_log` names them. A local day straddles at most two, so both are read and filtered |
| `CommitEntry.specs` was added, and wikilinks come from the diff | The design said the spec number would be parsed out of the commit subject. That is a guess, and this note is supposed to contain none. Reading `docs/<NNN>-<slug>.md` out of `--numstat` yields a link that points at a file that exists |
| `journal::prune_once` runs on the first capture of a run, not in the startup prune pass | There is no project directory at startup — the journal lives under one. Retention piggybacks on the first thing that knows where to write |
| `#daily brief` rebuilds the digest instead of reading the note file back | The render is deterministic, so rebuilding yields the identical string, and it sidesteps having to guess whether the file landed at `<date>.md` or `<date>.generated.md` |
| `uncommitted` is collected only when the requested day is still running | Uncommitted work is a property of *now*. Attaching today's working tree to last Tuesday's note would be a plain falsehood |
| The lane table has no Model column | `by_lane` groups carry no model, and joining them per-lane would be inference. Models are reported as their own fact line instead |
| `JournalKind::Handoff` exists but nothing writes it | `handoff_set` is an MCP tool served by the hook server; it raises no event the harness view observes, unlike `attention_flag` and `review_outcome`. Capturing it needs a new round-trip and is left for a follow-up rather than faked from `#handoff` command time, which is when the write is *requested*, not when it happens |
| A commit's time is `%ct` (committer), not `%at` (author) | `git log --since/--until` select on the committer date. Displaying the author date would have placed an amended or rebased commit at a time outside the very window that selected it |

**Day boundaries diverge from the rest of the app.** `usage_log::day_stamp` and
every other dated path here name files by UTC. This feature does not: a note is
a human's day, and at UTC+7 a UTC-named "today" silently begins at 07:00 local
and drops the morning. The consequence is that a note's totals will not match a
Xenon usage dashboard reading the same date — same rows, different window.

Verified: `cargo fmt --check` clean, `cargo clippy --all-targets` reporting
nothing in either changed module, 21 Rust tests in `journal.rs` (including
`collect_commits` exercised against real throwaway repos), 2 in `hook_server.rs`
for the `/journal` index, 15 renderer tests in `src/acp/daily-note.test.ts`, and
the full suites green at 297 Rust and 792 frontend tests. The digest was
additionally smoke-run against this repo's own 2026-08-15 data and reproduced
its 46 turns, 3 commits, artifact, and lane breakdown; and `/doc` was confirmed
against the running app to render `.krypton/journal/2026-08-15.md` (HTTP 200,
live-reload hash served, feedback overlay present) **before** `/journal` existed
— which is what established that no new reader was needed. `/journal` itself is
unit-tested only until the app is next rebuilt and relaunched.

## Resources

- [dev-journal](https://github.com/LakshmiSravyaVedantham/dev-journal) — the collect/generate split this spec mirrors
- [I Built a CLI That Auto-Generates My Daily Standup Notes from Git History](https://dev.to/lakshmisravyavedantham/i-built-a-cli-that-auto-generates-my-daily-standup-notes-from-git-history-ac) — which git fields actually carry standup signal
- [Devlog: An AI-Powered Developer Journal That Turns Git Commits Into Stories](https://dev.to/zeshama/devlog-i-built-an-ai-powered-developer-journal-that-turns-git-commits-into-stories-3fdl) — the LLM-authored approach, rejected here for reproducibility
- [Dayflow](https://github.com/JerryZLiu/Dayflow) — local-first capture-then-summarise model
- [obsidian-periodic-notes](https://github.com/liamcain/obsidian-periodic-notes) — the dated-file/template convention the output conforms to
- [Structured daily/weekly notes in Obsidian](https://dev.to/michalbryxi/structured-dailyweekly-notes-in-obsidian-2n5h) — section ordering that survives daily use
- [GitHub Activity Digest & Notification Tools (2026)](https://gitmore.io/blog/github-activity-digest-notification-tools) / [Gitrecap](https://www.gitrecap.com/features/git-reports) — team-digest framing, contrasted with a personal record
