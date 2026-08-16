# Daily Brief — One Written Day per File — Implementation Spec

> Status: Implemented
> Date: 2026-08-16
> Milestone: M-ACP — Harness convergence
> Supersedes: the note-rendering half of [223](./223-developer-daily-note.md); retires [224](./224-daily-note-publish.md)'s two-file model

## Problem

Spec 223 shipped a deterministic daily *note* — every commit, every lane row, every
journal event, rendered from records with no LLM in the loop. Spec 224 added a
second file beside it, `<date>.brief.md`, holding a lane's narration of that note.

In use, the split inverted: **the brief is what gets read and the note is what gets
scrolled past.** Two failures, both observed on the live pages:

- **The note is a log dump, not a note.** On 2026-08-16 the note was 78 lines, of
  which 40 were artifact events sharing one timestamp — ~62% of the rendered page
  spent on lines that differ only by title. The day's actual shape was below the fold.
- **Two files, two `type:` values, one reader.** Every surface that lists a day has
  to answer "which file did you mean?" — the publish path pairs `note.md` with an
  optional `brief.md`, and the reader lands on a file switcher before any content.

The raw record is not the deliverable. It is the *evidence* for the deliverable.

## Solution

**One file per day, written by a lane, grounded in the records.**

`.krypton/journal/<YYYY-MM-DD>.md` holds a brief: what the day went into, what is
unfinished, and which numbers deserve a second look. The digest that spec 223 built
still exists and is still assembled from `usage_log` + `git` + reviews + artifacts —
it just stops being a file. It is rendered once, in memory, as the prompt payload the
lane reads before writing.

```
usage/*.jsonl ─┐
git log ───────┼→ daily_note_build → DayDigest → renderDigestForBrief → prompt
journal/*.jsonl┤                                    (never touches disk)
reviews/, artifacts/ ┘                                      ↓
                                            lane writes <date>.md (the brief)
```

Three consequences, all accepted deliberately:

1. **A day costs a model turn.** There is no deterministic fallback file. This was
   weighed and dismissed as a concern — a day nobody narrated is a day nobody needed.
2. **Re-running overwrites.** `#daily 2026-08-15` next month yields a different text.
   The freshest reading wins; the sources behind it never change, so nothing is lost.
3. **The file is interpretation, and says so.** `generated: lane-narration` in the
   frontmatter, and the lane that wrote it is named.

## Research

- The digest side needs no work. `daily_note_build(cwd, date, tz_offset_minutes)`
  already returns a `DayDigest` joining every store, and it is read-only — it answers
  with the network down.
- `renderDailyNote(digest)` (renamed here) is already pure and deterministic. Repointing its output
  from a file to a prompt payload is a call-site change, not a rewrite.
- The mechanism is proven in this session: a lane was handed a rendered day plus an
  absolute path and produced `2026-08-15.brief.md` correctly on the first attempt,
  including the mandated frontmatter block.
- `journal::write_note` protects a hand-written file by checking for a `generated:`
  marker in frontmatter and stepping aside to `<date>.generated.md`. When the lane
  writes the file with its own edit tool that guard never runs, so the protection has
  to move to the point where Krypton still controls the decision — path resolution.
- Verified against the live publish surface on 2026-08-16: the daily page renders a
  `brief.md` / `note.md` switcher above the content. With a single source the switcher
  degenerates to one chip.

## Prior Art

| Source | What it does | What we take |
|---|---|---|
| `git log --format` digests / `standup` CLIs | Print the day's commits, nothing else | The one-line header shape: span, counts, delta |
| Obsidian daily notes | One dated file per day, frontmatter, human prose | The file convention — one `YYYY-MM-DD.md`, and prose as the payload |
| Spec 217 review bundles | A lane writes a self-contained document from evidence it was handed | The pattern this spec generalises: evidence in the prompt, document on disk |

**Krypton delta** — the evidence is machine-collected across every lane backend
(Grok, Codex, Cursor included, which have no transcript on Krypton's side), and the
writing is a lane turn. Neither half exists in the tools above.

## Affected Files

| File | Change |
|---|---|
| `src/acp/daily-note.ts` | `renderDailyNote` → `renderDigestForBrief`; output is prompt payload, never written. Sections trimmed to what a writer needs (see *Digest Payload*) |
| `src/acp/harness-prompts.ts` | `dailyBriefPrompt` rewritten — it now commissions *the* daily file with a required shape, not a reply plus a sibling |
| `src/acp/acp-harness-view.ts` | `#daily` collapses to one action; `brief` subcommand removed; the `openDailyNote` injection is dropped (the compositor now owns reading a day outright) |
| `src/acp/hash-commands.ts` | `daily` entry args/description; reference-page prompt sample |
| `src/acp/acp-harness-view.ts` (`open`) | `#daily open` accepts a date and jumps to that day's `/doc` page |
| `src-tauri/src/journal.rs` | `brief_path` + `write_note` deleted; `daily_write_path` (guarded) and `daily_read_path` (unguarded) added |
| `src-tauri/src/commands.rs` | `daily_brief_path` + `daily_note_write` deleted; `daily_write_path` + `daily_read_path` added |
| `src-tauri/src/lib.rs` | Handler registrations updated |
| `src-tauri/src/xenon.rs` | Daily collection: one source keyed `daily.md`; `hasBrief`/`noteAuthor`/`briefAuthor` meta → a single `author` read from the file |
| `src-tauri/src/hook_server.rs` | `/journal` index labels ("note" → "daily") |
| `src/compositor.ts` | `openDailyNote` opens an existing day read-only; it no longer builds or writes |
| `docs/223`, `docs/224`, `docs/README.md`, `docs/02`, `docs/05`, `docs/06` | Status, index, requirement, flow and config text |

## Design

### File Structure

```markdown
---
date: 2026-08-15
type: daily
generated: lane-narration
lane: Claude-1
repos: [krypton]
turns: 59
commits: 5
tags: [daily, harness]
---

# 2026-08-15 (เสาร์)

สรุปวัน 1–2 ประโยค: ได้อะไรเป็นชิ้นเป็นอัน ติดอะไรอยู่ — อ้างตัวเลขหลัก
(`06:30 → 23:25` · 59 turns · 5 commits · +5215/-143) ในย่อหน้านี้เลย

- **DONE** — <task> — ผลคือ: …
- **DOING** — <task> — ถึงไหน: … — ทำต่อ: …
- **BLOCKED** — <task> — รอ: <ใคร/อะไร> — ตามอีกที: <วันไหน>
- **DROPPED** — <task> — เพราะ: … (only on a day something was cut)
- **NEXT 1** — <small, concrete next action> (max 3)
- **NOTE** — idea / decision / open attention flag / figure that does not add up

---

เขียนโดย AI · <MODEL>
```

Fixed by the prompt, not by a renderer:

- **Frontmatter** — `date`, `type: daily`, `generated: lane-narration`, `lane`, plus
  the counts the digest already knows. `generated:` is what marks the file replaceable.
- **One paragraph + one flat list, nothing else.** No section headings below the H1,
  no checkboxes (the note is read-only output — nothing is ever ticked), no separate
  stat line: the key figures ride inside the opening paragraph.
- **Bold word prefixes, fixed order.** Every bullet is `- **STATUS** — …` with the
  status as a bold word, never an emoji, in the order DONE → DOING → BLOCKED →
  DROPPED → NEXT → NOTE. One task = one line = one status, task text starts with a
  verb, and the status appears nowhere else on the line. Every DOING carries
  ถึงไหน/ทำต่อ; every BLOCKED carries รอ/ตามอีกที; NEXT is capped at 3 and never
  duplicates a DOING/BLOCKED line.
- **No silent disappearance.** The writer reads the most recent earlier day in the
  same directory; every DOING/BLOCKED from it reappears — as DONE, as an updated
  DOING/BLOCKED, or as DROPPED with a reason. The newest note alone is the complete
  state; the reader never digs through older days.
- **Model footer.** The last body line is `เขียนโดย AI · <MODEL>` with the writer's
  actual product name (Grok 4.6, Claude Opus 4.6), not the lane. Lane stays in
  frontmatter; the published page does not show frontmatter, so the model has to
  live in the body.

The prose is spoken-register Thai (the lane-context default); identifiers, paths,
spec stems, commit subjects and figures stay verbatim in English. Long detail stays
out of the note — specs, reviews and artifacts are named as plain text instead of
being expanded inline.

### Self-Containment

Carried forward unchanged from 223: **the file contains no links.** Specs, reviews and
artifacts are named, paths printed as code. No relative path is correct on every
surface the day is read from, and nothing guarantees a link target was ever published.

### Digest Payload

`renderDigestForBrief(digest)` returns the same dense markdown 223's renderer produced,
minus the parts that only made sense on disk:

| Dropped | Why |
|---|---|
| The `<details>` provenance table | The prompt states provenance; the writer does not need it restated |
| The `#daily brief` pointer | It is the thing being run |
| The wall-clock caveat blockquote | Moved into the prompt as an instruction, so the writer never mislabels it as time worked |

Everything else — commits with diffstat and spec stems, lane and model rollups, open
attention, events, reviews, artifacts, extra projects — stays. The payload is the
writer's evidence and should be complete.

### API / Commands

| Command | Change |
|---|---|
| `daily_note_build(cwd, date, tz_offset_minutes) -> DayDigest` | Unchanged. The name keeps "note" for historical continuity rather than churning the IPC surface |
| `daily_write_path(cwd, date) -> String` | **New.** Resolves `<output_dir>/<date>.md` and creates the directory. Errors when the file exists and its frontmatter has no `generated:` marker |
| `daily_read_path(cwd, date) -> String` | **New.** The day's file as it exists, for opening. Deliberately unguarded — reading a hand-written day is right, only overwriting it is not. Falls back to the legacy `<date>.generated.md`; errors when the day was never written |
| `daily_brief_path` | **Deleted** |
| `daily_note_write` | **Deleted** — the lane writes the file |

### Data Flow

1. `#daily [<YYYY-MM-DD>]` on an idle lane (today when the date is omitted; a malformed
   date is refused rather than silently falling back to today).
2. `daily_note_build` returns the digest for that local day.
3. `renderDigestForBrief` renders it in memory.
4. `daily_write_path` resolves the target. On the hand-written-file error the run
   continues **reply-only** — the brief still happens, nothing on disk is touched.
5. `dailyBriefPrompt(date, payload, path)` is enqueued as a system prompt.
6. The lane replies with the brief and writes the same content to `path`, overwriting
   whatever generated file was there.

### Keybindings

| Key | Action | Change |
|---|---|---|
| Leader `J` | Open the day's existing file in the Markdown Viewer, via `daily_read_path` | No longer builds or writes — reading a day and commissioning one are different acts, and the compositor has no lane to commission with. The palette entry is `Open Today` |
| `#daily [<date>]` | Commission the day | Was: render deterministically |
| `#daily note <text>` | Append a manual journal line | Unchanged |
| `#daily open [<date>]` | Browse days in the browser — the `/journal` index, or straight to one day's `/doc` page | Naming a day is new. `open` means the browser with or without a date: one word, one meaning. Refuses a day nobody wrote, and a day under an absolute `output_dir` outside the project (which `/doc` cannot serve) |
| `#daily brief` | — | Removed; `#daily` is the brief |

### Configuration

`[daily_note]` keeps its name — renaming a TOML section silently breaks an existing
`~/.config/krypton/krypton.toml`. `enabled`, `retain_days`, `output_dir` and
`extra_projects` all keep their meaning; `output_dir` now holds briefs.

## Edge Cases

| Case | Behaviour |
|---|---|
| A hand-written `<date>.md` (no `generated:` marker) | `daily_write_path` errors; the brief is delivered reply-only and the file is untouched |
| Lane busy | Refused with `lane busy - #cancel first`, as `#daily brief` does today |
| A day with no turns and no commits | The lane says the day was quiet. There is no empty-section skeleton to render |
| A day whose digest is truncated (50-item cap) | The payload carries the truncation flag and the prompt requires it be stated |
| `#daily open <date>` for a day that was never written | `daily_read_path` errors and the message is shown — better than opening a 404 page |
| `#daily open <date>` with an absolute `output_dir` outside the project | Refused with a reason: `/doc` validates "under cwd", so no browser page exists for it |
| Orphan `<date>.brief.md` from spec 224 | Ignored — `note_dates_in` already treats `.brief.md` as a companion, so it never invents a phantom day. Not listed, not published, not deleted |
| Existing `<date>.md` written by 223 | Carries `generated: krypton-journal`, so it is replaceable and gets overwritten on the next run |
| Re-running the same day | Overwrites. Accepted: the records behind it are immutable |

## Out of Scope

- Weekly/monthly rollups
- Backfilling days that predate this spec
- Scheduling — nothing runs `#daily` for you
- A deterministic fallback file when no lane is available. This is the trade this spec
  exists to make, not an omission
- Teaching any reader to resolve links out of a day; the file stays self-contained

## Implementation Notes

Deviations from the design above, and why.

| Change | Reason |
|---|---|
| `daily_path` split into `daily_write_path` and `daily_read_path` | One command could not serve both callers. The write path must refuse a hand-written day; the read path must open exactly that day. Folding both into one flag-driven command would have made the guard a parameter, which is how guards get passed `false` |
| `renderDailyNote` renamed `renderDigestForBrief` | The name claimed the function produced the note. It produces the evidence the note is written from, and nothing it returns reaches disk |
| The `openDailyNote` callback injected into `AcpHarnessView` was removed entirely | With `#daily` writing rather than opening, nothing in the harness called it. The compositor still owns `openDailyNote` for Leader J |
| `payloadHeader` replaced `frontmatter` in the renderer | The payload is not a file, so a frontmatter block would only be a block for the writer to copy verbatim. It states the same counts as one plain line, which the prompt tells the writer to copy into the real frontmatter |
| The wall-clock caveat and the self-containment rule moved from the rendered text into the prompt | As rendered text they were strings the writer could ignore or restate. As prompt instructions they bind what gets written. Both are asserted in `harness-prompts.test.ts` |
| Xenon `meta` gained `author`, read from the file's own `generated:` marker | The old `noteAuthor` / `briefAuthor` pair hard-coded who wrote what. With one file that could be a lane's or a human's, the file has to be asked rather than assumed |
| Body ends with `เขียนโดย AI · <MODEL>` | First live day (2026-08-16) published without naming the model. Frontmatter `lane` is not enough: Xenon does not render frontmatter, and a lane name is not a model. The prompt now requires the product name in a footer |
| Three `##` sections replaced by one paragraph + one flat status list (2026-08-16) | The user rejected the sectioned style after reading it live and locked three constraints: no section headings, no checkboxes (the note is read-only — nothing is ever ticked), and bold word prefixes (`**DONE**`, `**DOING**`, …) instead of emoji. `## ที่ยังค้าง` became DOING/BLOCKED lines; `## จุดที่ควรดูอีกที` and open attention flags became NOTE lines. The locked design also adds day-to-day continuity: the writer reads the previous day's note and carries every DOING/BLOCKED forward |
| The locked design's "link out instead" rule became "name as plain text" | The upstream design says long detail should link out of the note, but this spec's self-containment rule exists because no link resolves on every surface a day is read from. Both intents survive: detail stays out of the note, and the reference is a plain-text name with paths as code |

## Resources

- [223 — Developer Daily Note](./223-developer-daily-note.md) — the capture half, still authoritative
- [224 — Publish the Daily Note to Xenon](./224-daily-note-publish.md) — the publish path this spec reduces to one file
- [217 — Review Archive](./217-review-archive-self-contained.md) — the same evidence-in-prompt, document-on-disk pattern
