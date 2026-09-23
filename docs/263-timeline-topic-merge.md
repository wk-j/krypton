# Timeline Topic Merge and Undo — Implementation Spec

> Status: Implemented
> Date: 2026-09-22
> Milestone: ACP Harness — project provenance

## Problem

Spec 262 stops new duplicate topics, but the ones already recorded stay split. Today the only repair
is hand-editing `topic_id` in the frontmatter of every affected file under `.krypton/timeline/`,
which is gitignored — a wrong edit is unrecoverable, so the human has to remember to back the files
up first (wk-j/krypton#27, proposal 3).

## Solution

Add a keyboard-first `#timeline merge <from> into <into>` command that moves every event of one topic
into another, and `#timeline merge undo` that puts them back. The merge copies each file it will
touch into `.krypton/timeline/backups/<merge-id>/` and writes the undo manifest *before* it rewrites
anything, so an interrupted merge is always recoverable. Only `topic_id` changes: each event keeps
its own title, summary, provenance, and ID, and the browser keeps showing the newest title as the
merged topic's label. The same repair is reachable in plain language through the `timeline_merge`
MCP tool so the human never has to recall the grammar: a lane may run it only on an explicit human
instruction, whose exact words are stored with the backup, and that path is not auto-approved.

## Research

- `scan_project()` derives topic grouping at read time from each file's `topic_id`; there is no index
  to update, so a merge is a `topic_id` rewrite in the frontmatter of the moved files and nothing
  else.
- Spec 261 already establishes that a topic's display label is the newest event's `topic_title` and
  that historical title changes are expected. Rewriting titles during a merge would therefore destroy
  information for no gain.
- Event files are append-only by design and `parse_event` re-validates every field on read, so a
  merge must produce a file that still parses: only the `topic_id` line is replaced, byte-for-byte
  everything else is preserved.
- `.krypton/` is gitignored (issue #27), so the usual undo — `git checkout` — does not exist. The
  backup is not a nicety; it is the only recovery path.
- `TIMELINE_MUTATION_LOCK` already serializes every mutating timeline path; the merge takes the same
  lock so it cannot interleave with a concurrent lane record.
- A merge MCP tool was rejected in the first pass and then explicitly asked for: the human should be
  able to say "รวมสองหัวข้อนี้" instead of recalling the `#timeline merge … into …` grammar. The hole
  that worried specs 261/262 is an agent merging on its *own* judgement, not an agent carrying out an
  instruction. The tool therefore requires the human's exact authorizing words, is the one timeline
  tool left out of the built-in auto-allow set, and inherits the ambiguity refusal and the backup.
- Rejected: merging from the `/timeline` browser page. That surface is read-only loopback
  observability; making it mutate project files would break that contract.
- Selector by topic ID alone was rejected as unusable: the browser shows titles, and the human should
  not have to read frontmatter to name a topic. A unique case-insensitive title substring is accepted
  in addition to an exact `topic-…` ID, and an ambiguous selector fails with the candidates listed.

## Prior Art

| Product | Implementation | Lesson for Krypton |
|---------|----------------|--------------------|
| GitHub issue transfer / Jira move | Moves an item between containers, keeps its content and history, and logs the move | Move the grouping key only; never rewrite the record's own content |
| `git merge` + `ORIG_HEAD` | Records where you were before a rewrite so a single command can undo it | Write the undo manifest before the rewrite, not after |
| Obsidian / Logseq bulk rename | Rewrites frontmatter across many notes and relies on the vault being in version control | Without version control the tool owns the backup itself |
| tmux `move-window`, wezterm tab move | Single keyboard verb, no dialog, immediately reversible | One typed command, result and undo hint in the same line of feedback |

**Krypton delta** — no mouse and, on the typed path, no confirmation modal: the human names the two
topics, the command reports what moved, and `#timeline merge undo` reverses it. Asking a lane in
prose is the other entry point, and that one does ask for permission once. The backup is automatic because the
records are gitignored, which is the opposite of the assumption those bulk-edit tools make.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/timeline.rs` | Topic selector resolution, `merge_topics_project`, `undo_last_merge_project`, frontmatter `topic_id` rewrite, backup + manifest with the authorizing instruction, two Tauri commands, and tests |
| `src-tauri/src/lib.rs` | Register `timeline_merge_topics` and `timeline_merge_undo` |
| `src-tauri/src/hook_server.rs` | Advertise and dispatch the `timeline_merge` MCP tool, mark it project-backed and `timeline`-category, and test its contract |
| `src/acp/timeline.ts` | Parse `merge`/`merge undo`, extend `TimelineCommand`, result types, usage line |
| `src/acp/acp-harness-view.ts` | Dispatch the two subcommands, report the outcome and the undo hint, and tell lanes when they may call `timeline_merge` |
| `src/acp/timeline.test.ts`, `src/acp/acp-harness-view.test.ts` | Parser and dispatch coverage |
| `docs/02-functional-requirements.md`, `docs/04-architecture.md`, `docs/72-acp-harness-view.md`, `docs/253-project-decision-requirement-timeline.md` | Requirement, module role, command reference, storage layout |
| `docs/README.md` | Index this specification |

No persisted event schema change, no config key, no ACP protocol change, no data migration.

## Design

### Commands

```text
#timeline merge <from> into <into>   move every event of <from> into <into>
#timeline merge undo                 restore the most recent merge
```

`<from>` and `<into>` are each either an exact `topic-…` ID or a case-insensitive substring of a
topic title (matched against the newest title of each topic). The separator is the last ` into `
in the argument text, so a title containing the word "into" still works on the left-hand side.

### Agent-Invoked Repair

The same operation is reachable from plain language through the `timeline_merge` MCP tool, so the
human never has to type the grammar above:

```text
timeline_merge {
  from?, into?,            // topic_id from timeline_list, or a unique title substring
  undo?,                   // true reverses the most recent merge; omit from/into
  instruction_excerpt      // REQUIRED: the human's exact authorizing words
} -> { merge_id, moved_events, from_topic_id, from_topic_title,
       into_topic_id, into_topic_title, backup_path }
```

Guards, in order: the tool fires only on an explicit human instruction whose exact words are stored
in the undo manifest beside the acting lane; the selector refuses ambiguity instead of guessing; the
files are backed up before the rewrite; and — unlike `timeline_suggest`, `timeline_record`, and
`timeline_list` — it is deliberately **not** in the built-in auto-allow set, so the lane asks once
before rewriting confirmed records. A lane must not merge because two topics look alike to it; with
no instruction it names the candidates and lets the human decide.

### Data Structures

```rust
pub struct TimelineMergeResult {
    pub merge_id: String,          // mrg-<UTC timestamp>-<hex>
    pub from_topic_id: String,
    pub from_topic_title: String,
    pub into_topic_id: String,
    pub into_topic_title: String,
    pub moved_events: usize,
    pub backup_path: String,       // project-relative
}

pub struct TimelineMergeUndoResult {
    pub merge_id: String,
    pub from_topic_id: String,
    pub into_topic_id: String,
    pub restored_events: usize,
}
```

Backups live at `.krypton/timeline/backups/<merge-id>/`: a verbatim copy of every event file the
merge will touch, plus `manifest.json` (`schema`, `merge_id`, `from_topic_id`, `into_topic_id`,
`merged_at`, `files`, `undone_at`, and — for an agent-invoked merge — `merged_by_lane` and
`instruction_excerpt`). The manifest is the undo record; `undone_at` marks it spent so one merge
cannot be undone twice, and the authorization fields make an agent-performed merge traceable.

### Order of Operations

```text
MERGE
1. Take the timeline mutation lock and scan events.
2. Resolve both selectors to exactly one topic each; refuse if either is ambiguous, unknown,
   or if they are the same topic.
3. Copy every event file of <from> into the backup directory.
4. Write manifest.json.
5. Rewrite the `topic_id` line of each moved file; everything else stays byte-identical.
6. If any rewrite fails, restore every file from the backup, mark the manifest undone, and report
   the failure.

UNDO
1. Take the lock; find the newest manifest without `undone_at`.
2. Copy each backed-up file back over its event file.
3. Stamp `undone_at` on the manifest.
```

### UI Changes

None beyond command feedback: a chip plus one system transcript line naming the moved count, both
topic titles, and the undo hint. No modal, no mouse affordance, no new DOM surface.

## Edge Cases

- Selector matches nothing, or more than one topic: fails before any write, listing up to five
  candidates for the ambiguous case.
- `<from>` equals `<into>`: refused.
- Empty timeline or a topic with no events: refused with a plain message.
- Merge interrupted mid-rewrite: files are restored from the backup automatically; if that restore
  also fails, the manifest still exists and `#timeline merge undo` retries it.
- `#timeline merge undo` with no unspent manifest: refused, nothing is touched.
- Undo restores the exact bytes captured at merge time, so later hand edits to those specific files
  are overwritten. This is stated in the command's reported output.
- Backups are inside `.krypton/`, so they are gitignored and never published, scanned as events, or
  sent to Xenon.
- A relation pointing at an event that moved stays valid: relations reference event IDs, not topics.
- Remote Harnesses have no local project and cannot run the command, like the rest of `#timeline`.

## Open Questions

None.

## Validation

- `cargo test --lib`: 390 passed, 1 ignored (live TypeSafe test). New coverage: merge by ID and by
  title substring, backup contents and the recorded authorization, undo restore,
  ambiguous/unknown/same-topic refusals, that a merged file still parses with every other field
  preserved, the `timeline_merge` descriptor contract, and that it is not auto-allowed.
- `cargo clippy --lib -- -D warnings`, `cargo fmt -- --check`, `npm run check`, `npm test -- --run`,
  and `npm run build` pass.

## Out of Scope

- Splitting a topic, moving a single event, or editing an event's text
- Merge affordances in the read-only `/timeline` browser page
- Retention or pruning of backup directories
- Undoing anything other than the most recent un-undone merge

## Resources

- [GitHub Docs — transferring an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/transferring-an-issue-to-another-repository) — moving a record between containers while preserving its content and history.
- [Git — `ORIG_HEAD`](https://git-scm.com/docs/git-merge#_how_to_resolve_conflicts) — recording the pre-rewrite state so a single command can undo a merge.
- Internal: `docs/253-project-decision-requirement-timeline.md`, `docs/261-timeline-reading-and-topic-identity.md`, `docs/262-agent-timeline-topic-discovery.md`, `src-tauri/src/timeline.rs`.
