# Automatic Timeline Suggestions — Implementation Spec

> Status: Implemented
> Date: 2026-09-18
> Milestone: ACP Harness — project provenance

## Problem

The project timeline only records events when a human remembers to run `#timeline add`. Important
requirements and decisions can therefore disappear inside a completed agent conversation, while
silently writing an agent's interpretation into the authoritative timeline would create a worse
problem: plausible but incorrect history.

## Solution

Add an agent-facing `timeline_suggest` MCP tool that creates a durable **pending suggestion** during
the agent's normal turn. The active Harness shows a persistent pending count and lets the human
review, edit, confirm, or dismiss each suggestion. Only confirmation promotes a suggestion into the
append-only event store through this unsolicited path. Spec 255 separately permits direct recording
only when the current human message explicitly requests persistence; it does not promote automatic
agent judgement into authoritative history.

Automatic suggestions are enabled by default for local MCP-capable Harness lanes and can be turned
off per project with `#timeline auto off`. This uses the model already doing the work—no sidecar
model, hidden follow-up turn, network request, or post-turn delay.

## Research

- The authoritative store from spec 253 is one immutable Markdown file per event under the
  gitignored `.krypton/timeline/events/` directory. Its explicit `made_by` field is deliberately
  separate from Git authorship and the recording lane.
- ACP's reliable completion boundary is the `session/prompt` response surfaced as `stop`; the
  Harness handles it in `finishTurn()`. Starting a classifier after that boundary would need a
  second model/provider call, compete with queued/peer turns, add latency and cost, and expose the
  whole transcript to another process.
- Krypton's built-in Harness MCP server already supports default-on, self-reported tools such as
  `attention_flag`. Tool descriptors plus a short `renderPromptMemoryPacket()` instruction make a
  capability discoverable without injecting a large policy document every turn.
- The existing built-in-tool auto-approval gate is name-based and must be extended deliberately.
  A suggestion write is eligible because it only creates non-authoritative local pending state;
  confirm/dismiss remain human UI actions.
- `PendingExtraction` is an intentionally empty legacy slot (`never`) and is cleared at turn end.
  Reusing it would lose suggestions and make them lane-session state, so suggestions need their own
  project-local persistence.
- A deterministic keyword matcher was rejected: phrases such as “approved” or “must” are easy to
  match but cannot reliably distinguish quotation, rejected alternatives, jokes, or actual project
  authority. Agent semantic judgement is useful for proposing a candidate, but not for confirming
  it as fact.

## Prior Art

| Product | Implementation | Design lesson |
|---------|----------------|---------------|
| Cursor Memories | A sidecar observes conversations and proposes generated memories; background memories require user approval, while the working agent may also use a tool to propose one | Separate detection from human acceptance; Krypton uses the tool path to avoid a second model |
| GitHub Copilot Memory | Repository facts are created from user-initiated Copilot activity, retain citations to supporting code, and can be reviewed/deleted by repository owners | Scope automatic knowledge to the project and retain inspectable evidence |
| ChatGPT Memory | Useful context may be remembered automatically, with controls to review, edit, delete, or turn memory off | Automatic capture needs visible state and an off switch |
| Krypton attention triage | A working lane self-reports a consequential fork through a built-in MCP tool; the frontend owns the human review surface | Reuse the proven self-report/tool-discovery/event bridge instead of adding a classifier service |

**Krypton delta** — Timeline suggestions preserve exact evidence and remain non-authoritative until
confirmed. Unlike preference memory, a confirmed timeline event is append-only provenance and is
never automatically merged, rewritten, expired, or used to infer a decision maker. A later explicit
user request may promote a matching pending item without opening the review sheet (spec 255).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/timeline.rs` | Pending/dismissed storage, settings, list, suggest, confirm, and dismiss operations |
| `src-tauri/src/hook_server.rs` | Advertise/handle `timeline_suggest`, validate inputs, emit suggestion notification |
| `src-tauri/src/lib.rs` | Register suggestion/settings Tauri commands |
| `src/acp/timeline.ts` | Suggestion/settings types and expanded `#timeline` grammar |
| `src/acp/timeline.test.ts` | Grammar, validation, and suggestion-state tests |
| `src/acp/timeline-capture.ts` | Prefilled review mode with evidence, confirm, and dismiss actions |
| `src/acp/acp-harness-view.ts` | Tool instruction, event subscription, pending count, review/auto command dispatch |
| `src/acp/acp-harness-view.test.ts` | Lane-context, notification, command, and review-flow tests |
| `src/acp/harness-permission-scan.ts` and tests | Auto-approve only the built-in `timeline_suggest` tool |
| `src/styles/acp-harness.css` | Pending badge and suggestion evidence treatment |
| `docs/253-project-decision-requirement-timeline.md` | Cross-reference the automatic proposal extension |
| `docs/02-functional-requirements.md` | Add automatic suggestion plus confirmation requirement |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | Record MCP, persistence, notification, and promotion flows |
| `docs/72-acp-harness-view.md` | Command, badge, keyboard, availability, and lifecycle behavior |
| `docs/96-acp-built-in-memory-auto-approval.md` | Add the narrow pending-only tool to the allowlist contract |
| `docs/186-mcp-tool-reference-page.md` | Categorize and document the new tool |
| `docs/README.md` | Add this spec to the index |

No external service, new dependency, or tracked project file is introduced.

## Design

### Persistence

Project-local layout:

```text
.krypton/timeline/
├── events/                         # confirmed append-only events (spec 253)
├── pending/<event-id>.md           # agent-proposed, not authoritative
├── dismissed/<event-id>.md         # archived rejection; not shown as history
└── settings.json                   # { "schema": 1, "automaticSuggestions": true }
```

Missing `settings.json` means enabled. Settings writes use a same-directory temporary file plus
atomic rename. Suggestions and dismissed files are gitignored with the rest of `.krypton/`.

A suggestion reserves its final `tl-<UTC>-<random>` event ID. Its Markdown contains `status:
"pending"`, proposed event fields, `suggested_at`, `suggested_by_lane`, and an exact
`evidence_excerpt`. Caps match confirmed events, with evidence limited to 1,000 Unicode scalars.
The backend accepts at most 100 pending suggestions and deduplicates normalized
`topic_title + summary` against pending files.

Confirmation renders the human-edited final event to the reserved ID using `create_new`, preserves
`suggested_by_lane` and `evidence_excerpt`, and then removes the pending file. If the event already
exists with the same suggestion ID after a partial failure, confirmation returns that event and
retries pending cleanup instead of creating a duplicate. Dismissal atomically renames the pending
file into `dismissed/`; it never deletes a confirmed event.

### Data Structures

```ts
interface TimelineSuggestion {
  schema: 1;
  id: string;                       // reserved final event ID
  topicTitle: string;
  summary: string;
  madeBy: string;
  occurredAt: string;
  evidenceExcerpt: string;
  rationale: string;
  impact: string;
  sourceRef?: string;
  suggestedAt: string;
  suggestedByLane: string;
  path: string;
}

interface TimelineSuggestionRequest {
  topicTitle: string;
  summary: string;
  madeBy: string;
  evidenceExcerpt: string;
  rationale?: string;
  impact?: string;
  sourceRef?: string;
}

interface TimelineSuggestionSettings {
  automaticSuggestions: boolean;
}

interface TimelineSuggestionListResponse {
  suggestions: TimelineSuggestion[];
  diagnostics: TimelineDiagnostic[]; // malformed pending files are skipped, not fatal
}
```

`TimelineEvent` gains optional `suggestedByLane`, `evidenceExcerpt`, and `suggestionId` fields. Old
event files remain valid. Pending files are parsed by a separate parser and are never returned by
`timeline_list` or `/timeline.json`.

### Tool and Commands

The built-in MCP server adds:

```text
timeline_suggest {
  topic_title,
  summary,
  made_by,
  evidence_excerpt,
  rationale?,
  impact?,
  source_ref?
} -> { suggestion_id, pending_count }
```

The descriptor and lane-context instruction impose these rules:

- Call at most once per turn, only for a durable project requirement, explicit decision,
  consequential change, approval/rejection, or implementation outcome worth finding later.
- Do not call for routine edits, passing tests, status chatter, agent recommendations, unanswered
  questions, inferred authority, or facts already represented by a pending/confirmed event.
- `made_by` and `evidence_excerpt` must be supported by the user's actual words or trusted transport
  provenance. The tool's output is a suggestion, never confirmation.
- Write agent-composed `topic_title`, `summary`, `rationale`, and `impact` in natural Thai while
  keeping technical terms in English. Preserve `evidence_excerpt`, `made_by`, `source_ref`,
  identifiers, paths, URLs, commit hashes, and quoted source text verbatim. The review sheet uses
  Thai chrome without translating stored values. See spec 256.

The command family becomes:

| Command | Action |
|---------|--------|
| `#timeline review` | Open the oldest pending suggestion; show “none pending” when empty |
| `#timeline auto` | Show whether automatic suggestions are enabled for this project |
| `#timeline auto on` | Enable automatic suggestions |
| `#timeline auto off` | Disable new suggestions; retain existing pending items |

Existing `open`, `add`, topic shorthand, and `trace` behavior is unchanged.

New Tauri commands:

```rust
timeline_suggestion_list(harness_id) -> TimelineSuggestionListResponse
timeline_suggestion_confirm(harness_id, suggestion_id, request) -> TimelineEvent
timeline_suggestion_dismiss(harness_id, suggestion_id) -> TimelineSuggestion
timeline_suggestion_settings(harness_id) -> TimelineSuggestionSettings
timeline_suggestion_set_enabled(harness_id, enabled) -> TimelineSuggestionSettings
```

### Data Flow

```text
Suggest
1. A local MCP-capable lane receives the short automatic-suggestion rule in lane context.
2. During normal work, the agent recognizes one explicit important event and calls timeline_suggest.
3. HookServer resolves the registered project, checks settings/caps/deduplication, and creates pending/<id>.md.
4. HookServer emits acp-timeline-suggestion with harness/lane/id/count and returns immediately.
5. The Harness refreshes the project-wide pending count; no extra agent turn starts.

Confirm
1. Human runs #timeline review or activates the pending badge.
2. Harness loads the oldest candidate and opens TimelineCapture in suggestion-review mode.
3. Human checks the exact evidence, edits fields if needed, and confirms.
4. Backend creates events/<same-id>.md, preserves suggestion provenance, and clears pending state.
5. Harness reports the event path and refreshes the badge.

Dismiss
1. Human dismisses from the review sheet.
2. Backend moves pending/<id>.md to dismissed/<id>.md.
3. Harness refreshes the badge; no authoritative event is created.
```

### UI and Keyboard

- The active lane header shows a compact `timeline N` button only when `N > 0`. It uses a full
  border and existing warning text color, with no glow, left rail, or animation.
- Activating the badge or running `#timeline review` opens the existing capture sheet prefilled
  from the suggestion. A bordered evidence block shows the exact excerpt and suggesting lane.
- `Tab`/`Shift+Tab` traverse fields and actions; `Cmd/Ctrl+Enter` confirms; `Cmd/Ctrl+D` dismisses;
  `Esc` closes without changing the pending suggestion.
- Confirm and dismiss disable controls while in flight. Failures leave the sheet open.
- A newly created suggestion does not steal focus or open an overlay. The badge/count is the
  persistent signal; a brief chip says `timeline · N pending · #timeline review`.

### Availability and Control

- Default: enabled for a local project Harness.
- `auto off` suppresses the lane-context instruction and makes `timeline_suggest` return a clear
  disabled error. It does not remove existing pending/dismissed/confirmed files.
- Remote Harnesses cannot suggest, review, confirm, or dismiss local records; `trace` remains
  available as in spec 253.
- Pi has no MCP host, so it cannot create automatic suggestions. Manual `#timeline add` remains
  the fallback and the UI must not claim Pi is monitoring automatically.
- The tool is added to the narrow built-in auto-approval allowlist. No other timeline operation is
  agent-callable.

## Edge Cases

- **Cancelled/error turn after a tool call** — the candidate remains pending; it is visibly
  attributed to the lane and still requires human confirmation.
- **Repeated calls** — normalized topic+summary deduplication returns the existing pending ID;
  the descriptor's one-per-turn rule limits semantic flooding.
- **Two lanes suggest the same event** — first pending candidate wins deduplication; evidence and
  suggesting lane remain inspectable.
- **Human explicitly asks to persist a matching event** — `timeline_record` promotes the reserved
  pending ID directly and preserves suggestion plus authorizing-instruction provenance.
- **Agent invents authority or quote** — nothing enters history until the human sees and confirms
  the candidate; edit or dismiss is available.
- **Confirm interrupted after event creation** — retry finds the same suggestion ID in the final
  event, returns it, and cleans up pending state without duplication.
- **Setting disabled mid-turn** — a late tool call fails without writing.
- **Malformed pending file** — list reports a diagnostic/count warning and skips it; confirmed
  events and the browser timeline remain unaffected.
- **Pending cap reached** — reject new suggestions with `review or dismiss existing suggestions`.
- **Sensitive text** — evidence is local but not encrypted; the tool instruction forbids copying
  secrets, tokens, environment values, or raw tool output.

## Open Questions

None. The design fixes the detection path as agent self-report, requires human confirmation, is
default-on with a per-project off switch, preserves evidence, and never runs a sidecar model. Spec
257 may help the human reuse an existing topic while reviewing a pending candidate, but it runs only
inside the explicitly opened capture sheet and does not participate in candidate creation.

## Out of Scope

- Silent creation of authoritative events
- A second/sidecar model or automatic post-turn prompt
- Keyword-only classification or confidence scores
- Mining old sessions automatically; `#timeline trace` remains the explicit reconstruction path
- Sync, export, Git tracking, or organization-wide identity verification
- Automatic deletion/expiry of pending or dismissed suggestions
- Browser-page mutation; `/timeline` remains read-only
- Remote-Harness and Pi automatic suggestions

## Resources

- [Cursor Memories](https://docs.cursor.com/en/context/memories) — sidecar extraction, agent tool
  creation, and approval before saving background-generated memories.
- [About GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
  — project-scoped facts, supporting citations, validation, and owner review.
- [Managing Copilot Memory](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/manage-for-yourself)
  — user-visible enable/disable and review/delete controls.
- [ChatGPT Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
  — automatic relevance selection paired with review, correction, deletion, and off controls.
- Internal: `docs/253-project-decision-requirement-timeline.md`,
  `docs/96-acp-built-in-memory-auto-approval.md`, `src-tauri/src/hook_server.rs`,
  `src/acp/acp-harness-view.ts`, and `src/acp/timeline-capture.ts`.

## Validation

- `npm test -- --run` — 225 files, 3,525 tests passed.
- `npm run build` — TypeScript check and production Vite build passed.
- `cargo test --lib` — 369 Rust tests passed (run outside the managed sandbox so the fake
  loopback Telegram listener could bind).
- `cargo clippy --lib -- -D warnings` — passed.
- `rustfmt --edition 2021 --check src/timeline.rs src/hook_server.rs src/lib.rs` — passed.
- `git diff --check` — passed.
- `cargo clippy --all-targets -- -D warnings` remains blocked by an unrelated existing
  `clippy::octal_escapes` warning in `src/git.rs:788`.
