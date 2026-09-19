# Project Decision & Requirement Timeline — Implementation Spec

> Status: Implemented
> Date: 2026-09-18
> Milestone: ACP Harness — project provenance

## Problem

After a feature ships, a requirement may change and force rework. Git can show who changed code,
but it cannot reliably show who requested or approved the requirement, what rationale was accepted,
or which later decision superseded it. Krypton needs a private project-local history that keeps those
roles separate and can reconstruct older history from evidence without presenting inference as fact.

## Solution

Add a built-in `#timeline` command family with two complementary paths:

1. **Record** what changed as a new, immutable local Markdown event under
   `.krypton/timeline/events/`, without asking the human to classify it first.
2. **Trace** older behavior read-only through the active lane, using recorded events, Git, project
   docs, and linked issue/PR evidence while distinguishing decision authority from code authorship.

Bare `#timeline` opens a searchable read-only browser timeline. A requirement or decision change is
never edited in place: the new event links to the event it supersedes, so both the old basis and the
new authority remain visible.

## Research

- `src/acp/hash-commands.ts` is the client-owned source of truth for Krypton `#` commands;
  `AcpHarnessView.runHashCommand()` owns dispatch. The manifest drift guard requires every new
  command to carry explicit category and prompt metadata.
- ACP agent `/` commands are agent-advertised. Zed stores `AvailableCommandsUpdate` on its ACP
  thread and forwards native commands as hidden turns, but it has no client-side project-decision
  timeline. `#timeline` therefore remains a Krypton command and requires no ACP protocol change.
- The existing `.krypton/journal/<date>.jsonl` captures sessions, handoffs, attention flags,
  reviews, artifacts, tickets, and human notes for `#daily`. Timeline data should share the
  gitignored `.krypton/` boundary, but use its own append-only schema and must not inherit journal
  retention because requirement history is longer-lived than operational session data.
- Existing `docs/adr/` files preserve architecture rationale well, but they do not cover ordinary
  requirement changes or implementation/rework events, and they have no built-in chronological
  query surface. Timeline events complement ADRs and may link to them; they do not replace them.
- Git `blame` identifies the revision and author that last modified a surviving line. It explicitly
  does not report deleted or replaced lines. A commit author is implementation evidence, not proof
  of who approved a business or product decision.
- GitHub's issue timeline exposes timestamped events and actors, while Linear project updates mix
  chronological updates with property changes and retain document authors/version history. Both
  support the key UX shape: chronology plus actor plus source. Neither separates “decision maker”
  from “recorder,” so Krypton does.
- Rejected alternatives:
  - **Automatic LLM extraction after every turn** — low effort for the user, but silently missed or
    invented decisions would make the audit trail less trustworthy.
  - **Git-only reconstruction** — useful evidence, but cannot prove decision authority or rationale.
  - **Append to one Markdown/JSONL file** — creates multi-lane write conflicts and encourages
    rewriting history. One event per file makes creation atomic and corrections additive.
  - **Store under tracked `docs/`** — portable and reviewable, but it publishes potentially
    sensitive decision history and creates repository churn. The requested v1 is local-only.

## Prior Art

| Tool | Implementation | Notes |
|------|----------------|-------|
| ADR / MADR | One record per decision with context, choice, rationale, and consequences | Durable and reviewable; usually architecture-focused and manually indexed |
| GitHub issue timeline | Chronological issue/PR events and comments with actor and timestamp | Strong source attribution, but scoped to one issue and not a project-wide requirement chain |
| Linear updates/history | Chronological project updates plus target/member/milestone changes; document version history shows authors | Good project history UX; hosted and workspace-specific |
| Git log / blame | Commit history plus last-modifying revision/author per surviving line | Strong implementation evidence; not proof of requirement authority |

**Krypton delta** — keep source records privately beside the project under `.krypton/`, expose them
through the keyboard-first Harness, and display two identities separately: **made by** (who
requested/approved the change) and **recorded by** (who saved the event). Read-only trace mode may
connect older Git or issue evidence, but it must label inference and may not promote a code author
into the decision-maker field.

## Command Contract

| Command | Action |
|---------|--------|
| `#timeline` | Open the complete browser timeline |
| `#timeline open [<topic>]` | Open the browser timeline, optionally filtered by topic |
| `#timeline <topic>` | Shorthand for `open <topic>` |
| `#timeline add [<topic>]` | Open the keyboard-first capture sheet with an optional prefilled topic |
| `#timeline trace <topic>` | Start a read-only evidence-tracing lane turn; no files are changed |

`trace` requires a non-empty topic. Any other text after `#timeline` is the documented topic
shorthand. Topic text is treated as data, not instructions.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/timeline.ts` *(new)* | Command parser, event types, caps, browser URL builder, and capture validation |
| `src/acp/timeline.test.ts` *(new)* | Grammar, topic indexing, capture validation, and focus-order tests |
| `src/acp/timeline-capture.ts` *(new)* | Keyboard-first capture sheet and save lifecycle |
| `src/acp/artifact-timeline.html` *(new)* | Read-only chronological browser surface |
| `src/acp/hash-commands.ts` | Register `#timeline`; add manifest metadata and real trace prompt |
| `src/acp/hash-commands.test.ts` | Extend roster/manifest drift coverage |
| `src/acp/harness-prompts.ts` | Add `timelineTracePrompt(topic)` with evidence and attribution rules |
| `src/acp/harness-prompts.test.ts` | Assert read-only, data framing, citations, and no-authority-inference rules |
| `src/acp/acp-harness-view.ts` | Dispatch the command, host the capture sheet, invoke record/open/trace paths |
| `src/styles/acp-harness.css` | Capture-sheet layout using full borders, no blur, and no left rails |
| `src-tauri/src/timeline.rs` *(new)* | Confined local event creation, parsing, scan, and relation derivation |
| `src-tauri/src/lib.rs` | Register timeline IPC commands and module |
| `src-tauri/src/hook_server.rs` | Serve `/timeline` and `/timeline.json`; add route and rendering tests |
| `DESIGN.binance.md` | Register the timeline as an OS-browser reading surface |
| `docs/02-functional-requirements.md` | Add the durable provenance requirement |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | Record ownership, persistence, capture, query, and trace flows |
| `docs/72-acp-harness-view.md`, `docs/README.md` | Command behavior and spec index |

No configuration key and no ACP protocol extension are required.

## Design

### Event Storage

Every save creates exactly one local-only file:

```text
.krypton/timeline/events/<event-id>.md
```

`event-id` is `tl-<UTC compact timestamp>-<6 random hex>` and the backend uses `create_new`; an
existing path is never overwritten. Correcting an event creates a new event related by
`supersedes`. The repository already ignores `.krypton/`, so records stay on this machine and never
enter the normal commit/review/push workflow. Cloning the repository or deleting `.krypton/` does
not preserve them; export, sync, and backup are deliberately outside v1.

There is no persisted index file. Browse/capture scans the bounded `events/` directory and groups
valid records by stable `topic_id`, so concurrent saves cannot leave a separate index out of sync.

```markdown
---
schema: 1
id: "tl-20260918T082500Z-a1b2c3"
topic_id: "topic-policy-upload-validation"
topic_title: "Policy upload validation"
kind: "event"
occurred_at: "2026-09-18T08:20:00Z"
made_by: "Product owner — Alice"
recorded_at: "2026-09-18T08:25:00Z"
recorded_by: "Local user"
recorder_lane: "Codex-1"
source_ref: "https://github.com/acme/service/issues/17#issuecomment-123"
relation: "supersedes"
related_event: "tl-20260901T031500Z-9f8e7d"
---
# Upload completion now requires metadata transfer

## Rationale
The downstream DIM consumer cannot use a file-only completion state.

## Impact
The existing completed-state implementation must be revised before cutover.
```

Frontmatter strings are emitted as JSON-quoted YAML scalars. `rationale` and `impact` sections may
be empty; `topic_id`, `topic_title`, `kind`, `summary`, `occurred_at`, and `made_by` are required.
`kind` is the hidden compatibility marker `event` for new records; it is neither requested nor
shown. The parser still accepts the four typed values emitted by the initial implementation so
existing local records remain readable.
For a human capture, `recorded_by` is `Local user`; it never consults Git identity and is never
copied into `made_by`. `recorder_lane` records where the command was entered.

```rust
enum TimelineKind { Event, Requirement, Decision, Implementation, Note } // typed values are legacy
enum TimelineRelation { Supersedes, Refines, Implements, Supports, CausedBy }

struct TimelineRecordRequest {
    topic_id: String,              // stable; selected from the index or created once
    topic_title: String,           // editable display label, <= 120 Unicode scalars
    summary: String,               // <= 500
    occurred_at: String,           // RFC 3339
    made_by: String,               // <= 120; explicit human confirmation
    rationale: String,             // <= 4 KiB
    impact: String,                // <= 4 KiB
    source_ref: Option<String>,    // <= 2 KiB
    relation: Option<TimelineRelation>,
    related_event: Option<String>,
    recorder_lane: String,
}

struct TimelineEvent {
    // Stored fields above, plus project-relative local path and derived relation state.
    path: String,
    superseded: bool,
}
```

`relation` and `related_event` are both present or both absent. The related ID must already exist
in the same project. `superseded` is derived when another valid event points to the event with a
`supersedes` relation; old files are not mutated.

The `timeline_list(harness_id)` and `timeline_record(harness_id, request)` Tauri commands resolve
the project from HookServer state; the frontend cannot nominate an arbitrary filesystem root.

### Capture Sheet

`#timeline add` opens an in-app sheet over the active Harness lane. Fields, in tab order:

1. topic picker — recent topics first; fuzzy-searches titles, summaries, actors, and sources;
   selecting a related event selects its topic; creating a near-duplicate requires confirmation
2. summary
3. made by — required and never inferred from the recorder, lane, or code history
4. occurred at — defaults to now, editable for backfill
5. source reference — URL, issue/comment reference, commit, or repo-relative doc path
6. relation + related event
7. rationale
8. impact

`Tab` / `Shift+Tab` navigate, arrow keys change select fields, `Cmd/Ctrl+Enter` saves, and `Esc`
cancels without writing. The sheet states `saves locally under .krypton/timeline (not tracked by
Git)`. While saving, controls disable and a second submission is ignored. Success appends a system
row with the event ID and project-relative path; validation or I/O failure leaves the sheet open.

### Browser Surface

`GET /timeline?harness=<id>&topic=<query>` serves a reader-style Binance surface that fetches
`GET /timeline.json` for the same project. The page is a scan-first list, not a stack of cards: one
row per event, and only the selected event expands. It shows:

- searchable topic list grouped by stable `topic_id`, ordered by latest activity, with the newest
  `topic_title` shown in full as display text (wrapping rather than ellipsizing) and a record count;
- day headers that stick under the header while scrolling, so position in the chronology stays
  visible;
- one compact row per event — time, the full summary (wrapping onto extra lines rather than
  ellipsizing), **made by**, and small state pills (topic while unfiltered, `superseded`, `src`)
  — separated by full-width rules, never left accent rails;
- the selected row expanded in place with **recorded by**, topic, suggesting lane, evidence, the
  exact authorizing instruction when a natural-language request created the event, rationale,
  impact, relation such as `supersedes`, and the source link; at most one row is expanded, so the
  detail block is the only heavy DOM on the page;
- source links, with HTTP(S) opened normally and repo-relative docs routed through `/doc`;
- a visible `local only` marker and diagnostics for malformed or missing linked local events.

Keyboard: `/` search, `j`/`k` move (and expand) events, `Enter` opens the selected source, `[`/`]`
move between topics, `r` reverses chronological order (oldest first by default, shown next to the
count), and `Esc` clears the active filter. Moving the selection only re-renders the two affected
rows; filter, search, order, and topic changes re-render the list. The page follows OS light/dark
preference like the docs reader. It polls nothing; refresh reads disk again. All event text is
inserted with `textContent`.

### Language Contract

Timeline chrome and agent-composed topic, summary, rationale, impact, and trace prose use natural
Thai. Technical terms stay English inside Thai sentences. Evidence, exact authorizing instructions,
identities, source references, identifiers, paths, URLs, commit hashes, enum values, quoted source
text, manual input, and existing records remain verbatim. The browser declares `lang="th"` and uses
the `th-TH` locale for day headings; the persisted schema and machine values remain unchanged. See
spec 256.

### Trace Prompt

`#timeline trace <topic>` sends one hidden system turn through `enqueueSystemPrompt()` and labels the
operation `tracing timeline`. The prompt requires the lane to:

1. read matching `.krypton/timeline/events/` records first;
2. inspect the smallest relevant Git history, code/docs, and linked issue/PR evidence available;
3. produce a chronological answer with a source path/URL/commit for every event;
4. label each row `recorded`, `observed`, or `inferred`;
5. name a **decision maker** only when an explicit source attributes the decision;
6. call a Git/GitHub actor **author**, **committer**, or **commenter**, never decision maker by
   implication;
7. remain read-only and state gaps plainly;
8. answer in natural Thai while keeping technical terms, citations, quotes, and the `recorded` /
   `observed` / `inferred` labels verbatim.

This path helps with history that predates the ledger. It never writes or backfills events; the
human can confirm a reconstructed event through `#timeline add` afterward, or explicitly ask the
lane to persist sourced rows through the direct natural-language path in spec 255.

### Data Flow

```text
Capture
1. Human runs #timeline add ...
2. AcpHarnessView opens TimelineCapture with an optional topic default
3. Human confirms authority, source, rationale, impact, and optional relation
4. timeline_record resolves the registered Harness project and validates fields
5. timeline.rs atomically creates .krypton/timeline/events/<id>.md
6. Harness reports the path and confirms that the record is local-only

Browse
1. Human runs #timeline [open] [topic]
2. Harness opens loopback /timeline with harness id + optional filter
3. /timeline.json resolves the registered project, scans bounded event files, and derives the
   topic index and relations in memory
4. Browser renders the read-only chronology

Trace old behavior
1. Human runs #timeline trace <topic>
2. Harness injects timelineTracePrompt(topic) into the active idle lane
3. Lane reads ledger + repository evidence (+ linked remote evidence when available)
4. Lane returns a cited chronology with explicit certainty and actor roles; no write occurs
```

### Backend Constraints

- Resolve and canonicalize the project through the registered Harness id; all reads/writes remain
  under `<project>/.krypton/timeline/events/`.
- Accept only regular `.md` files whose frontmatter parses to schema 1; report malformed files in
  the JSON diagnostics instead of silently dropping them.
- Scan at most 2,000 event files and cap each at 32 KiB.
- Recording and browsing run without Git subprocesses or network access. Only an explicit `trace`
  turn may inspect repository history as supporting evidence.
- Never fetch network data from the browser endpoint. Remote sources are links; only the lane's
  explicit `trace` turn may use its normal approved tools.
- Recording and browsing are unavailable in a Remote ACP Harness in v1 because the local hook
  server does not own the remote repository. `trace` remains available because the remote lane can
  inspect its own workspace.

## Edge Cases

- **No Git repository** — recording and browsing still work because the store is project-local,
  not repository-backed.
- **Recorder identity** — a human capture records `Local user` plus the lane; `made_by` still
  requires explicit input and is not authenticated in v1.
- **No source reference** — allowed, but the browser marks the event `asserted · no linked evidence`.
- **Requirement changed twice** — each change is a new event that supersedes the previous active
  event; the full chain remains visible without requiring classification.
- **Topic renamed** — update the display title on the next event while retaining `topic_id`; prior
  event files remain unchanged and the newest title becomes the index label.
- **Similar topic already exists** — the picker ranks it first and requires confirmation before a
  new `topic_id` is created.
- **Correction of a typo or wrong actor** — create a replacement event with `supersedes`; never
  overwrite the old record through the command.
- **Related event missing or malformed** — reject save and keep the sheet open.
- **Concurrent Harness saves** — unique IDs plus `create_new` prevent overwrite; both events remain.
- **Malformed hand-edited event** — surface its filename and parse error in diagnostics; do not
  include it in derived relations.
- **Lane busy** — browse/add are local and remain available; `trace` is refused with the standard
  `lane busy - #cancel first` message.
- **Topic contains command-like text** — encoded as data in the trace prompt and URL; never executed.
- **Sensitive content** — the capture sheet warns that local-only does not mean encrypted. No
  transcript body, token, environment value, or tool output is copied automatically.

## Open Questions

None. The base design chooses explicit capture plus read-only reconstruction, gitignored local
project files, separate authority/recorder identities, and additive supersession. Spec 254 extends
it with agent-proposed pending candidates that still require human confirmation. Spec 255 adds a
direct MCP path only when the current human message explicitly requests persistence.

## Out of Scope

- Silent automatic creation of authoritative events. Spec 254 permits at most one agent-proposed
  pending candidate per turn and requires human confirmation; spec 255 permits direct creation only
  when the current human instruction is itself the confirmation.
- Timeline export, sync, backup, commit, push, GitHub comment, or issue mutation
- Treating Git authorship as proof of product/business authority
- Editing or deleting prior timeline events through Krypton
- Organization identity, signatures, RBAC, or cryptographic attestation
- Rework-cost or time-spent calculation
- Remote-repository capture/browser support in v1
- Replacing ADRs, issue trackers, the daily journal, or project specs

## Resources

- [Architectural Decision Records](https://adr.github.io/) — decision records preserve rationale,
  trade-offs, and consequences as a decision log.
- [GitHub REST API: timeline events](https://docs.github.com/en/rest/issues/timeline) — actor and
  timestamp shape for issue/PR history.
- [Linear initiative and project updates](https://linear.app/docs/initiative-and-project-updates) —
  chronological updates mixed with project-property changes.
- [Linear document history and authors](https://linear.app/docs/documents) — version history and
  visible human/agent authorship.
- [Git blame documentation](https://git-scm.com/docs/git-blame) — author/revision attribution and
  the explicit limitation for deleted or replaced lines.
- `/Users/wk/Source/zed/crates/acp_thread/src/acp_thread.rs` — local ACP client reference for
  agent-advertised commands and hidden native-command turns.
- `docs/223-developer-daily-note.md` and `src-tauri/src/journal.rs` — existing local journal scope,
  persistence, and retention behavior.
- `docs/adr/` — Krypton's existing architectural decision records, retained as complementary
  project evidence.
