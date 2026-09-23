# Agent-Side Timeline Topic Discovery — Implementation Spec

> Status: Implemented
> Date: 2026-09-22
> Milestone: ACP Harness — project provenance

## Problem

A lane recording project history through `timeline_record` cannot see what the timeline already
contains. Every new session therefore invents its own `topic_title`, and because lane guidance asks
for Thai titles while some agent backends still write English ones, the exact normalized-title reuse
in `direct_topic_id()` can never fire across sessions. One subject recorded from three sessions
becomes three topics (wk-j/krypton#27: 3 topics, 19 events, ~5 duplicated facts), and the only repair
is hand-editing `topic_id` in files that `.gitignore` excludes from recovery.

## Solution

Give the lane a read-only `timeline_list` MCP tool so it can look before it writes: a bounded digest
of existing topics, optionally filtered, optionally drilled into one topic's events. Make
`timeline_record` say when it just created a new topic and hand back the existing topics next to the
ack, so a lane that skipped the lookup can still correct the rest of the chronology in the same turn.
Persistence stays deterministic — no fuzzy matching, no auto-merge, no silent re-parenting.

## Research

- Spec 261 (uncommitted at the time of writing) added an explicit `topic_id` request field and
  returns the resolved ID. That fixes identity *within* one traced chronology but gives a fresh
  session no way to obtain an ID it did not create itself, which is exactly the reported failure.
- `timeline_record`'s own schema already tells the agent to reuse an ID "returned by `timeline_record`
  or `timeline_list`", but `timeline_list` is a **Tauri command** (`src-tauri/src/lib.rs:239`) reachable
  only from the frontend. No MCP tool of that name is advertised, so the instruction is unfollowable.
  Reusing the name for the MCP tool resolves the reference instead of deleting it; Tauri commands and
  MCP tools live in separate namespaces, so no rename is required.
- The Tauri `timeline_list` returns every event with every field (`TimelineListResponse`, up to
  `MAX_EVENTS = 2_000`). Handing that to a model is unaffordable, so the MCP surface returns a
  per-topic digest by default and event bodies only for one requested topic.
- `scan_project()` already sorts events by `occurred_at`, marks `superseded`, and reports malformed
  files as diagnostics. Topic digests can be folded from that single scan with no new I/O path.
- Substring `query` cannot bridge Thai and English titles, which is the actual cross-session failure.
  The default unfiltered, newest-first listing is therefore the primary discovery path and `query` is
  only a convenience for large timelines.
- Semantic matching was ruled out: spec 257's TypeSafe topic suggestion is explicitly a human-reviewed
  capture-sheet affordance, and both 257 and 261 reject probabilistic identity on the persistence
  path. A wrong auto-merge silently rewrites project history.
- Aggravating factor 3 in the issue (an event dated five months from the commit it cites) is met with
  a non-fatal `warnings` field rather than a rejection: the write was explicitly authorized by a human,
  so the system should tell the lane rather than refuse.
- `harness-permission-scan.ts:38` groups the timeline tools for built-in auto-approval; a read-only
  lister belongs there, otherwise discovery costs a permission prompt and lanes will skip it.

## Prior Art

| Product / standard | Implementation | Lesson for Krypton |
|--------------------|----------------|--------------------|
| Anthropic memory tool | Pairs `view` (list directory / read file) with `create`; the model is instructed to view memory before writing so it appends to existing files instead of starting new ones | A write tool without a matching read tool guarantees duplicates; the read must be cheap and default-on |
| Linear / GitHub MCP servers | Expose `list_issues` / list endpoints beside `create_issue`, with pagination limits, so an agent can search before creating | Read-before-write is the established shape for agent-facing record systems |
| GitHub REST — list issues | Bounded, sorted, paginated listing returning identifiers plus a short title, not full bodies | Return identifiers and one scannable line per record, never the full corpus |
| MCP tool annotations | `readOnlyHint` marks tools that do not mutate their environment, letting hosts relax approval | Justifies auto-approving `timeline_list` alongside the existing timeline tools |
| `git log --oneline` before commit | Compact one-line history is the standard orientation step before appending | Digest shape: identifier + date + one line |

**Krypton delta** — Krypton's records are project-local Markdown, not a hosted API, so listing is a
single filesystem scan with no pagination cursor; the bound is a `limit` and a truncation flag. Unlike
issue trackers, the digest leads with the stable `topic_id` because that ID — not the human title — is
the thing the lane must copy back.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/timeline.rs` | Add `TimelineTopicDigest` / `TimelineTopicListing`, fold digests from `scan_project`, add `list_topics_project` and `list_topic_events_project`, add the future-date warning helper, and test digest folding, filtering, bounds, and warnings |
| `src-tauri/src/hook_server.rs` | Advertise and dispatch `timeline_list`, mark it project-backed and `timeline`-category, extend the `timeline_record` result with `new_topic` / `existing_topics` / `warnings`, correct the `topic_id` field description, and test descriptor + result shape |
| `src/acp/harness-permission-scan.ts` | Recognize `timeline_list` as a built-in auto-approved timeline tool |
| `src/acp/acp-harness-view.ts` | Lane guidance: check `timeline_list` before the first `timeline_record` on a subject and reuse the matching `topic_id` |
| `src/acp/acp-harness-view.test.ts` | Pin the discovery instruction and the permission-scan classification |
| `docs/255-natural-language-timeline-recording.md` | Document the read-before-write rule and the extended result |
| `docs/186-mcp-tool-reference-page.md` | Note the new read-only tool contract |
| `docs/02-functional-requirements.md`, `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/72-acp-harness-view.md` | Record topic discovery in requirements, module role, flow, and lane tooling |
| `docs/README.md` | Index this specification |

No persisted event schema, config key, ACP protocol extension, or data migration is required.

## Design

### Data Structures

```rust
// Serialized as-is: these types are MCP payloads, where the rest of the tool
// surface is snake_case. The camelCase Tauri types are unaffected.
pub struct TimelineTopicDigest {
    pub topic_id: String,        // stable identity the lane copies back
    pub topic_title: String,     // newest title seen for the topic
    pub event_count: usize,
    pub first_occurred_at: String,
    pub last_occurred_at: String,
    pub latest_summary: String,  // newest event summary, truncated to 200 chars with `…`
}

pub struct TimelineTopicListing {
    pub topics: Vec<TimelineTopicDigest>,
    pub total_topics: usize,      // matching the request, before `limit`
    pub total_topics_all: usize,  // stored in total, so "no match" != "empty timeline"
    pub truncated: bool,
}

pub struct TimelineTopicEvent {
    pub event_id: String,
    pub occurred_at: String,
    pub summary: String,
    pub made_by: String,
    pub source_ref: Option<String>,
    pub superseded: bool,
}

pub struct TimelineTopicEventListing {
    pub topic_id: String,
    pub topic_title: String,
    pub events: Vec<TimelineTopicEvent>,
    pub total_events: usize,
    pub truncated: bool,
}

// The lighter shape carried by a `timeline_record` ack.
pub struct TimelineTopicRef {
    pub topic_id: String,
    pub topic_title: String,
    pub event_count: usize,
    pub last_occurred_at: String,
}
```

Folding rule: group `scan_project()` events by `topic_id`; `topic_title` and `latest_summary` come
from the newest event by `(occurred_at, recorded_at, id)`; topics are ordered by `last_occurred_at`
descending so recent work is first. Malformed files stay diagnostics and are never grouped.

### API / Tool

```text
timeline_list {
  topic_id?: string,   // ^topic-[a-z0-9-]+$ — return this topic's events instead of the topic digest
  query?: string,      // <=120 chars; case/whitespace-normalized substring over topic title + summaries
  limit?: integer      // 1..50, default 20
} -> {
  topics?: [ { topic_id, topic_title, event_count, first_occurred_at, last_occurred_at, latest_summary } ],
  events?: [ { event_id, occurred_at, summary, made_by, source_ref?, superseded } ],
  topic_id?, topic_title?,                     // echoed when a topic was requested
  total_topics + total_topics_all | total_events,
  truncated: boolean
}
```

- Without `topic_id`: the topic digest, newest topic first, at most `limit` entries.
- With `topic_id`: that topic's events, newest first, at most `limit` entries, each one line of
  content plus its identifiers. An unknown ID returns the same error text as `timeline_record`.
- `query` filters topics (or events, when drilling in) on normalized substring match; it never
  reorders and never fuzzy-matches.
- The tool is read-only: it opens no UI, emits no event, and writes nothing.
- Advertised only for a local project-backed Harness (`project_backed_bus_tool`), categorized
  `timeline`, and included in built-in auto-approval beside `timeline_suggest`/`timeline_record`.

The `timeline_record` result becomes additively larger:

```json
{
  "event_id": "tl-...",
  "topic_id": "topic-is-cover-role",
  "path": ".krypton/timeline/events/tl-....md",
  "disposition": "created",
  "new_topic": true,
  "existing_topics": [ { "topic_id": "...", "topic_title": "...", "event_count": 7, "last_occurred_at": "..." } ],
  "notice": "This created a NEW topic. If existing_topics already contains this subject, ...",
  "warnings": ["occurredAt is 154 day(s) in the future relative to the recording time; ..."]
}
```

- `new_topic` is true only when this call produced a `topic_id` that no stored event used before.
- `existing_topics` is present only when `new_topic` is true and other topics exist: at most 10
  digests, newest first, without `latest_summary`, beside a `notice` naming what to do about it. It
  is advice, not an action — nothing is merged.
- `warnings` is omitted when empty. It carries the future-date check: `occurred_at` more than 24h
  ahead of the recording time. The event is still written; the lane must relay the warning.
- The `topic_id` input description drops the dangling reference and points at the now-real tool.

### Data Flow

```text
DISCOVERY (new session, same subject)
1. Human asks the lane to record something about subject X.
2. Lane calls timeline_list (no arguments) and reads the topic digest.
3. Lane recognizes X in the digest and copies its topic_id.
4. First timeline_record carries that topic_id; every later event reuses it (spec 261).
5. Rust validates the ID against stored events and appends into the existing chronology.

FALLBACK (lane did not look first)
1. timeline_record resolves no existing topic and creates one.
2. The ack returns new_topic: true plus existing_topics.
3. The lane reuses the right ID for the remaining events and tells the human which topic was split.
```

### UI Changes

None. The `#timeline` browser, capture sheet, and review UI are untouched.

## Edge Cases

- Empty timeline: `{ "topics": [], "total_topics": 0, "truncated": false }`; no error.
- No local project: the tool is not advertised, matching the other project-backed tools.
- More topics than `limit`: `truncated: true` and `total_topics` reports the real count so the lane
  can raise `limit` or use `query` instead of guessing.
- Malformed event files: excluded from digests, still reported by the existing browser diagnostics.
- A topic whose title was deliberately renamed: one digest under the stable ID with the newest title.
- `query` matching nothing: an empty list with `total_topics: 0` beside `total_topics_all`, so the
  lane can tell "nothing matched" from "the timeline is empty" without a second call.
- Superseded events still appear in digests and event listings, flagged rather than hidden.
- `timeline_record` retries: unchanged: `disposition: existing` implies `new_topic: false`.

## Open Questions

None.

## Validation

- `cargo test --lib`: 387 passed, 1 ignored (the live TypeSafe test, which needs credentials and
  network access). New coverage: digest grouping/ordering/bounds/query, topic event reading and the
  unknown-topic error, `new_topic` + `existing_topics`, and the future-date warning.
- `cargo clippy --lib -- -D warnings` and `cargo fmt -- --check` pass. `is_none_or` was replaced with
  an explicit `match` — it is newer than the project's 1.77.2 MSRV.
- `npm run check` and `npm test -- --run` (3,541 tests) pass, including the pinned lane-guidance
  instruction and the `timeline_list` auto-approval case.

**Deviations from the design above:** the new MCP types serialize as plain snake_case rather than
camelCase (MCP payloads are snake_case; the camelCase convention belongs to the Tauri types), and
`TimelineTopicListing` gained `total_topics_all` so a filtered miss is distinguishable from an empty
timeline without a second call.

## Out of Scope

- Merging, re-parenting, or repairing the duplicate topics that already exist (issue proposal 3) —
  it mutates confirmed history under `.gitignore` and needs its own spec with an undo path.
- Semantic or fuzzy topic matching during persistence, including any TypeSafe call on this path.
- Cross-checking `occurred_at` against a git commit named in `source_ref`: `source_ref` may point at
  another repository, so resolution is not reliably local.
- Changing the Markdown event schema, the Tauri `timeline_list` command, or the browser UI.
- `timeline_suggest`, manual capture, Xenon publishing, backup, and sync behavior.

## Resources

- [MCP — Tools](https://modelcontextprotocol.io/docs/concepts/tools) — tool descriptor/annotation model, including `readOnlyHint` for non-mutating tools.
- [Anthropic — Memory tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool) — the `view`-before-write pairing that keeps an agent appending to existing records.
- [GitHub REST API — list repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues) — bounded, sorted listing returning identifiers plus a short title.
- [Linear MCP server](https://linear.app/docs/mcp) — list tools offered beside create tools for agent read-before-write.
- Internal: `docs/253-project-decision-requirement-timeline.md`, `docs/255-natural-language-timeline-recording.md`, `docs/257-typesafe-timeline-topic-suggestions.md`, `docs/261-timeline-reading-and-topic-identity.md`, `src-tauri/src/timeline.rs`, `src-tauri/src/hook_server.rs`, `src/acp/harness-permission-scan.ts`.
