# Timeline Reading and Stable Topic Identity — Implementation Spec

> Status: Implemented
> Date: 2026-09-22
> Milestone: ACP Harness — project provenance

## Problem

The timeline browser expands provenance and audit metadata as soon as an event is selected, so one
record can occupy most of the viewport and interrupt chronological reading. Separately,
`timeline_record` derives topic identity from an exact normalized `topic_title`; a lane that varies
the wording while saving one traced chronology can therefore split one subject across several
`topic_id` values.

## Solution

Make the browser chronology-first: navigation selects a compact event row, while useful context and
full audit provenance open only on explicit keyboard or pointer action. Keep every stored field and
the append-only Markdown schema unchanged.

Give direct recording an explicit, reusable topic identity. The first `timeline_record` call may
still derive a topic from its title, but the result returns `topic_id`; later calls can pass that ID
and the backend will reuse it even when the display title changes. The lane instruction requires one
returned ID for every remaining event in a traced chronology.

## Research

- Spec 253 already defines `topic_id` as the stable grouping key and permits `topic_title` to be an
  editable display label. The direct MCP path added later exposes only the label, weakening the
  original identity contract.
- `direct_topic_id()` currently reuses a topic only when normalized titles are exactly equal. Case
  and whitespace differences are tolerated; punctuation, explanatory suffixes, and paraphrases
  create a new topic.
- `timeline_record` currently returns only event ID, path, and disposition. A lane cannot reliably
  continue a topic without reusing title text from its own context.
- `related_event` is not topic identity: relations may legitimately connect events in different
  topics. Automatically inheriting its topic was rejected because it would make cross-topic
  `supports`, `caused_by`, and `implements` relations surprising.
- The current browser keeps only one heavy detail subtree, but `select()` always creates it. The DOM
  strategy is efficient; the default-open behavior and information hierarchy are the problem.
- GitHub and Linear activity feeds establish the useful default shape: chronological event, actor,
  time, and source first; internal record machinery is not the headline.
- WAI-ARIA's disclosure pattern uses an explicit control with `aria-expanded`, toggled by `Enter` or
  `Space`. The timeline keeps its faster global keys while exposing a real disclosure button for
  pointer, Tab, and assistive-technology users.
- Fuzzy or semantic auto-merge at persistence time was rejected. A false merge silently changes
  project history; explicit identity is deterministic and auditable.

## Prior Art

| Product / standard | Implementation | Lesson for Krypton |
|--------------------|----------------|--------------------|
| GitHub issue timeline | Ordered timeline events expose event type, actor, timestamp, and linked source data | Lead with the event; retain structured provenance without making it the primary reading surface |
| Linear Activity | Shows changes over time and who made them in an issue activity feed | Keep chronology scan-friendly and defer supporting detail |
| WAI-ARIA Disclosure | A button advertises `aria-expanded`; `Enter` and `Space` toggle controlled content | Make hidden detail explicit and keyboard-accessible rather than expanding on focus |
| Krypton capture sheet | Persists an explicit `topic_id` selected by the user | Reuse the same stable-identity contract for agent direct recording |

**Krypton delta** — the browser remains denser and more keyboard-driven than issue trackers, and it
keeps decision authority separate from recorder provenance. The audit trail stays complete but is
progressively disclosed instead of occupying the default chronology.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/timeline.rs` | Accept optional direct `topic_id`, resolve it against existing records, deduplicate by resolved identity, and test reuse/error/compatibility paths |
| `src-tauri/src/hook_server.rs` | Add `topic_id` to the MCP schema and result; strengthen descriptor and browser-source tests |
| `src/acp/acp-harness-view.ts` | Tell lanes to reuse the returned topic ID throughout a traced chronology |
| `src/acp/acp-harness-view.test.ts` | Pin the chronology identity instruction |
| `src/acp/artifact-timeline.html` | Keep rows compact on selection; add context/audit disclosures and concise source rendering |
| `docs/02-functional-requirements.md` | Require stable direct-record topic reuse and chronology-first browsing |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | Update the direct-record identity flow and browser disclosure behavior |
| `docs/72-acp-harness-view.md` | Document the new browser keys and traced-chronology recording rule |
| `docs/186-mcp-tool-reference-page.md` | Document the additive `topic_id` request/result contract |
| `docs/253-project-decision-requirement-timeline.md` | Replace auto-expand browser behavior with progressive disclosure |
| `docs/255-natural-language-timeline-recording.md` | Add explicit topic reuse and response identity |
| `docs/README.md` | Index this specification |

No persisted event schema, config key, ACP protocol extension, or data migration is required.

## Design

### Direct Record Contract

```rust
struct TimelineDirectRecordRequest {
    topic_id: Option<String>,      // existing topic only; omitted for the first event
    topic_title: String,           // display label; still required and bounded
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
```

The MCP result becomes additive:

```json
{
  "event_id": "tl-...",
  "topic_id": "topic-is-cover-role",
  "path": ".krypton/timeline/events/tl-....md",
  "disposition": "created"
}
```

Topic resolution is deterministic:

1. When `topic_id` is present, validate its syntax and require at least one existing event with that
   ID. Persist the new event under that ID. The request's `topic_title` remains the display label, so
   a deliberate rename does not fork the chronology.
2. When `topic_id` is absent, retain the existing exact normalized-title reuse and stable new-ID
   derivation. Existing callers remain compatible.
3. Never infer topic membership from `related_event`; relation and grouping remain independent.
4. A retry compares the resolved `topic_id`, normalized summary, authorizing instruction, and source.
   Rewording only the title cannot duplicate an otherwise identical event.
5. Unknown explicit IDs fail before any file is created and report that the caller must omit the ID
   for a new topic or use an ID returned by `timeline_record`/`timeline_list`.

For a traced chronology, the lane creates the first event without `topic_id`, reads `topic_id` from
the result, and passes it to every later call. Event-specific language belongs in `summary`, not in
`topic_title`.

### Browser Information Hierarchy

The compact row remains time + full summary, followed only by metadata needed for scanning:

- show the topic pill only in the all-topics view;
- show `made_by` only when it is not a generic value such as `Current user` or `Local user`;
- retain `superseded` and a compact source indicator;
- do not render recorder, lane, instruction, IDs, raw URL, rationale, or impact by default.

Selection and disclosure are separate states:

- `j` / `k` select and scroll without expanding;
- `Space` toggles **context** for the selected event;
- `i` toggles the full **audit** view for the selected event;
- `Enter` opens the selected source as today;
- selecting another event closes the prior disclosure;
- a visible `รายละเอียด` disclosure button mirrors `Space`, uses `aria-expanded`, and is reachable by
  Tab/click; the footer documents both new keys.

Context contains only non-empty rationale, impact, a human-readable relation, and a compact
`เปิดแหล่งอ้างอิง` link. Audit additionally contains recorder/lane, authorizing instruction,
evidence, topic ID, event ID, related event ID, and the full source reference. Missing optional
fields produce no placeholder sections.

Only the selected event may own a context/audit subtree. Text continues to enter the DOM through
`textContent`; no stored field is interpreted as HTML.

### Data Flow

```text
DIRECT RECORD
1. First event omits topic_id.
2. Rust exact-matches or creates one topic and persists the event.
3. MCP result returns event_id + topic_id.
4. Lane reuses topic_id for every later event in the trace.
5. Rust validates that identity and writes all events into one chronology.

BROWSER
1. /timeline.json is fetched once and grouped by topic_id.
2. Render creates compact rows only.
3. j/k changes selection without creating detail DOM.
4. Space or the disclosure button creates context for one row; i creates its audit view.
5. Moving selection removes the prior detail subtree.
```

## Performance Requirements

- Preserve the one-fetch, no-polling browser model and idle CPU below 1%.
- Keep one document-level keyboard listener and avoid per-row global listeners.
- At most one detail subtree exists; selection updates only affected rows.
- No layout reads inside row-render loops, no animation loop, no blur, and no left accent rail.
- Validate with the `perf-checklist` against the timeline page after implementation.

## Edge Cases

- Existing clients omit `topic_id`: behavior is unchanged.
- A caller passes a valid-looking but unknown ID: reject without writing.
- The same topic has historical title changes: all records group by ID and the newest title remains
  the sidebar label.
- A relation targets an event in another topic: explicit topic identity wins; relation remains valid.
- An event has no rationale, impact, provenance excerpt, relation, or source: it stays one compact
  row and disclosure omits empty content.
- Search still covers hidden context and audit fields.
- Existing hand-edited and historical Markdown records require no rewrite.

## Open Questions

None. Explicit topic identity is authoritative; relation inference and fuzzy persistence are out.

## Validation

- `cargo test` passed all 383 non-ignored library tests; the local-listener Telegram test was rerun
  outside the sandbox because binding its fake HTTP server is denied there. The one live TypeSafe
  test remains intentionally ignored because it requires credentials and network access.
- `cargo clippy --lib -- -D warnings`, `cargo fmt -- --check`, `npm test -- --run` (3,541 tests),
  `npm run build`, the embedded browser-script syntax check, and `git diff --check` pass.
- The timeline-page performance audit passes the relevant checklist items: one delegated event
  listener per interaction type, no polling, no layout-read loop, no animation/blur, incremental
  two-row selection updates, and at most one detail subtree. Search, topic, and ordering changes
  intentionally rebuild the bounded event list.

## Out of Scope

- Automatically repairing or merging existing topic IDs
- Changing `.krypton/timeline/events/*.md` schema or rewriting local records
- Semantic/fuzzy auto-merge during direct persistence
- Changing manual capture or TypeSafe's optional human-reviewed topic suggestion
- Publishing, Xenon rendering, backup, or sync behavior

## Resources

- [GitHub REST API — timeline events](https://docs.github.com/en/rest/issues/timeline) — chronological event data keeps actor, time, event type, and linked source structured.
- [Linear Docs — assignment activity history](https://linear.app/docs/assigning-issues) — the Activity feed presents changes over time and who made them.
- [WAI-ARIA APG — Disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) — explicit `aria-expanded` control with `Enter`/`Space` keyboard behavior.
- Internal: `docs/253-project-decision-requirement-timeline.md`, `docs/255-natural-language-timeline-recording.md`, `src-tauri/src/timeline.rs`, `src-tauri/src/hook_server.rs`, and `src/acp/artifact-timeline.html`.
