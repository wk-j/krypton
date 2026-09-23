# Natural-Language Timeline Recording — Implementation Spec

> Status: Implemented
> Date: 2026-09-18
> Milestone: ACP Harness — project provenance

## Problem

Persisting a timeline event currently requires opening and completing a capture or review sheet.
That is unnecessary ceremony when the human has already told the active lane, in ordinary language,
to save a decision or traced event.

## Solution

Add a project-backed `timeline_record` MCP tool for an explicit current-turn user request such as
“record this decision in the timeline.” The user's instruction is the confirmation: the lane writes
the final append-only event directly, returns its ID/path in the conversation, and opens no modal.
Unsolicited agent-selected events continue to use `timeline_suggest` and remain pending; natural
language does not turn automatic inference into authoritative history.

## Research

- `timeline.rs::record_project` already provides the required confinement, validation, relation
  checking, `create_new` append semantics, and Markdown persistence. The new path should reuse it
  rather than create a second event format.
- `timeline_suggest` is already a project-backed Harness MCP tool with lane attribution and bounded
  input. Its pending-only rule, frontend badge, and review sheet exist because the agent initiated
  the capture; they are not needed when the current human prompt explicitly requests persistence.
- `hook_server.rs` receives the Harness ID, lane label, and tool arguments, but not the current
  human prompt. The direct tool therefore requires the exact instruction excerpt in its payload
  and stores it for auditability; this is a model-enforced authorization boundary, not a
  cryptographic proof that the excerpt came from the active turn.
- A deterministic phrase matcher was rejected. Natural requests vary by language and wording, and
  routing them through keyword matching would both miss valid requests and create false writes.
- Replacing all suggestions with direct writes was rejected. It would let an agent silently promote
  its own interpretation into project history, which is materially different from honoring an
  explicit user instruction.
- Adding a dedicated confirmation command or transient grant token was rejected for this revision:
  both preserve command/UI ceremony instead of solving the requested conversational workflow.

## Prior Art

| Product | Implementation | Lesson for Krypton |
|---------|----------------|--------------------|
| ChatGPT Saved Memory | A user can say “Remember …” conversationally; saved memories remain reviewable and removable later | An explicit natural-language request can itself authorize persistence |
| Cursor Memories | Agent tool calls may create memory directly when the user explicitly asks; background-generated memories require approval | Keep direct user intent separate from unsolicited automatic capture |
| GitHub Copilot Memory | Repository facts arise from user-initiated Copilot activity, retain supporting citations, and can be reviewed/deleted | Scope records to the project and preserve evidence/provenance |

**Krypton delta** — timeline events are immutable provenance rather than mutable preferences. A
direct record therefore stores the exact authorizing excerpt and recorder lane, keeps the existing
bounded schema, and is corrected later with a superseding event rather than silently edited.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/timeline.rs` | Add explicit-record request/result types, direct-record persistence, idempotency, and pending promotion |
| `src-tauri/src/hook_server.rs` | Advertise and handle project-backed `timeline_record` |
| `src/acp/harness-permission-scan.ts` | Auto-allow the exact built-in direct-record tool so no permission UI interrupts it |
| `src/acp/acp-harness-view.ts` | Add the explicit-vs-unsolicited timeline rule to local lane context |
| `src/acp/acp-harness-view.test.ts` | Cover tool discoverability and lane-context wording |
| `src/acp/timeline.ts` | Expose the optional authorizing instruction on listed events |
| `src/acp/artifact-timeline.html` | Search and display the stored authorizing instruction |
| `docs/02-functional-requirements.md` | Add conversational direct recording requirement |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | Document trust boundary, persistence, and direct flow |
| `docs/72-acp-harness-view.md` | Document natural-language examples and no-modal behavior |
| `docs/96-acp-built-in-memory-auto-approval.md` | Add the narrow `timeline_record` allowlist rationale |
| `docs/186-mcp-tool-reference-page.md` | Document the direct timeline tool |
| `docs/253-project-decision-requirement-timeline.md` | Cross-reference conversational recording |
| `docs/254-automatic-timeline-suggestions.md` | Clarify that pending review remains only for unsolicited capture |
| `docs/README.md` | Index this specification |

No CSS, capture-sheet, configuration, or ACP protocol change is required.

## Design

### Data Structures

```rust
struct TimelineDirectRecordRequest {
    topic_id: Option<String>,
    topic_title: String,
    summary: String,
    made_by: String,
    instruction_excerpt: String,
    occurred_at: Option<String>,
    rationale: String,
    impact: String,
    source_ref: Option<String>,
    relation: Option<TimelineRelation>,
    related_event: Option<String>,
}

struct TimelineDirectRecordResult {
    event: TimelineEvent,
    disposition: TimelineDirectRecordDisposition,
}

enum TimelineDirectRecordDisposition {
    Created,
    Existing,
    PromotedPending,
}
```

`instruction_excerpt` is bounded to 1,000 Unicode scalars and rendered into an explicit
`## Authorizing instruction` section. Direct events use `recorded_by: "Agent via explicit user
instruction"` and the MCP lane label as `recorder_lane`. If the current user is the decision
authority and no more specific identity is available, `made_by` is `Current user`; a named third
party may be used only when the prompt or cited source attributes the decision to them.

When `topic_id` is absent, the backend reuses the newest case-insensitive exact `topic_title` match
or derives the same stable slug/fallback-hash shape used by the capture sheet. When `topic_id` is
present, it must identify an existing local topic and is authoritative even if the display title has
changed. Unknown explicit IDs fail before writing. Relations remain independent from topic identity.

### MCP Tool

```text
timeline_list {
  topic_id?,
  query?,
  limit?
} -> {
  topics[] | events[],
  total_topics | total_events,
  truncated
}

timeline_record {
  topic_id?,
  topic_title,
  summary,
  made_by,
  instruction_excerpt,
  occurred_at?,
  rationale?,
  impact?,
  source_ref?,
  relation?,
  related_event?
} -> {
  event_id,
  topic_id,
  path,
  disposition: "created" | "existing" | "promoted_pending",
  new_topic,
  existing_topics?,
  notice?,
  warnings?
}
```

Spec 262 adds the read half. `timeline_list` is read-only: with no arguments it returns bounded topic
digests (stable ID, newest title, event count, time span, newest summary) newest-activity first; with
`topic_id` it returns that topic's events newest-first. Without it a fresh session cannot obtain an ID
it did not create, so exact-title reuse never fires across sessions or languages and one subject
splits into several topics. `existing_topics`/`notice` appear only when a record opened a new topic;
`warnings` carries non-fatal notices such as an `occurred_at` far in the future. Both are advisory:
nothing is merged, re-parented, or refused on the persistence path.

The descriptor and lane context impose these rules:

- Call only when the current human message explicitly asks to record, remember, persist, or add
  something to the project timeline. The wording may be any language.
- The exact supporting phrase goes in `instruction_excerpt`; do not paraphrase it there.
- Write agent-composed `topic_title`, `summary`, `rationale`, and `impact` in natural Thai while
  keeping technical terms in English. Preserve `instruction_excerpt`, `made_by`, `source_ref`,
  identifiers, paths, URLs, commit hashes, and quoted source text verbatim. See spec 256.
- Do not call merely because an event seems important. That remains `timeline_suggest` territory.
- Call `timeline_list` before the first record about a subject and reuse the `topic_id` of the topic
  that already covers it. A title that does not match does not mean the topic is new.
- Record one file per distinct event. If the user asks to persist a traced chronology, record only
  `recorded`/`observed` items supported by their sources; do not turn `inferred` rows into facts.
  Omit `topic_id` only when no existing topic covers the subject, then reuse the returned ID for
  every remaining event and keep event-specific wording in `summary`, not `topic_title`.
- Never copy secrets, tokens, environment values, or raw tool output.
- Report every resulting event ID/topic ID/path in the assistant response so the write is visible
  without a separate UI.

The tool is advertised only for a local project-backed Harness, is included in the exact built-in
auto-approval allowlist, and is independent of the `automaticSuggestions` setting. Remote Harnesses
and Pi retain the existing read-only/manual fallbacks.

### Persistence and Idempotency

1. Validate and normalize the direct request with the existing timeline limits.
2. Resolve topic identity from an explicit existing ID or the exact-title/new-topic fallback. A
   normalized match on resolved topic ID, summary, authorizing excerpt, and source returns the
   existing event with `disposition: existing`; title-only rewording cannot duplicate that retry.
3. If a pending suggestion has the same normalized topic title and summary, promote its reserved ID
   atomically, preserve its suggestion provenance/evidence, add the authorizing instruction, remove
   the pending file, and return `promoted_pending`.
4. Otherwise create a new event with `create_new` and return `created`.
5. A retry after a response loss resolves through step 2 rather than creating a duplicate.

Confirmed event files remain schema 1. The parser accepts the optional authorizing-instruction
section, so all existing events remain readable.

### Data Flow

```text
1. Human tells the active lane in ordinary language to save a timeline fact.
2. Lane extracts bounded event fields and calls timeline_record with the exact instruction excerpt.
3. HookServer resolves the local project from harness ID and supplies the authenticated lane label.
4. timeline.rs validates, deduplicates, optionally promotes a matching pending item, and appends the
   final Markdown event under .krypton/timeline/events/.
5. The MCP result returns event ID, topic ID, path, and disposition in the same turn.
6. Lane tells the human what was recorded; no capture/review/permission modal opens.
```

### UI Changes

No new interactive UI. The existing structured tool card and assistant response are the immediate
audit surface, and the read-only `#timeline` browser shows the stored authorizing instruction only
in the event's explicit audit disclosure. `#timeline add` and `#timeline review` remain available
for manual capture and unsolicited suggestions.

## Edge Cases

- **Ambiguous request** — ask a normal conversational question instead of writing.
- **Several traced events** — write one event per supported occurrence and return all paths.
- **Matching pending suggestion** — promote it rather than creating a duplicate or opening review.
- **Repeated MCP call/response loss** — return the already-created event through content deduplication.
- **Named authority absent** — use `Current user`; never infer a manager/product owner from Git author.
- **Relation target missing** — fail without writing, as the existing validator does.
- **Automatic suggestions disabled** — explicit direct recording still works because it is user-driven.
- **Remote Harness or Pi** — return a clear unsupported message; do not map a remote path locally.
- **Sensitive instruction** — refuse to persist the sensitive fragment and explain why.

## Open Questions

None. Explicit current-turn user intent is the confirmation boundary; unsolicited capture remains
proposal-first.

## Out of Scope

- Automatically recording events merely because the agent considers them important
- Removing the existing capture/review UI or pending records
- Keyword-based intent detection in the frontend
- Editing or deleting confirmed events
- Sync, export, encryption, or Git tracking
- Remote-project timeline persistence

## Resources

- [Memory FAQ — OpenAI](https://help.openai.com/en/articles/8590148-memory-faq) — explicit
  conversational “remember” requests and later user control.
- [Cursor Memories](https://docs.cursor.com/en/context/memories) — direct agent tool creation for
  explicit requests versus approval for background-generated memories.
- [About GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) —
  project scoping, citations, validation, and user-initiated activity.
- Internal: `docs/253-project-decision-requirement-timeline.md`,
  `docs/254-automatic-timeline-suggestions.md`, `src-tauri/src/timeline.rs`,
  `src-tauri/src/hook_server.rs`, and `src/acp/harness-permission-scan.ts`.
