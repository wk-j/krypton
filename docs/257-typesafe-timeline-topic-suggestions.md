# TypeSafe Timeline Topic Suggestions — Implementation Spec

> Status: Implemented
> Date: 2026-09-19
> Milestone: ACP Harness — project provenance

## Problem

Timeline capture reuses an existing topic only when its title matches exactly after normalization.
The current prefix, substring, and field search helps a person find nearby records, but it misses
topics that mean the same thing with different wording or languages. That can split one chronology
across multiple `topic_id` values.

## Solution

Keep exact matching and persistence deterministic. When no exact title match exists, construct a
bounded shortlist from the local timeline index and ask TypeSafe `Choice` to select one candidate or
`create_new`. The result is a visible, optional suggestion in `#timeline add` and `#timeline review`;
it cannot set `topic_id` until the user explicitly chooses it. Missing configuration, low confidence,
poor candidate coverage, cancellation, timeout, and service failure all preserve the current UI and
save path.

The Rust backend owns credentials, the HTTP client, deadlines, retries, circuit state, response
validation, and aggregate metrics. The frontend owns deterministic candidate construction,
debouncing, stale-result rejection, presentation, and the user's final selection.

## Research

- `TimelineCapture` already owns topic input, deterministic matches, duplicate confirmation, and the
  final `TimelineRecordRequest`. Both manual capture and pending-suggestion review use this component,
  so one change covers both requested surfaces.
- `findExistingTopic()` is the authoritative exact-title path. It must short-circuit semantic work so
  existing behavior stays fast, free, offline, and predictable.
- `topicMatchScore()` and `latestTimelineTopics()` can build a deterministic shortlist without a new
  persisted index. Candidate recall must be measured separately because TypeSafe cannot select a
  topic omitted from that shortlist.
- TypeSafe `Choice` returns one closed-set option, the full probability distribution, and confidence.
  Its documentation recommends an explicit no-match option and warns that thresholds depend on the
  domain and consequences. The design therefore includes `create_new`, checks probability and margin
  as well as confidence, and calibrates all gates on Krypton fixtures.
- TypeSafe accepts structured JSON state. Only the draft title/summary and bounded candidate titles
  and summaries help this judgment; all provenance and lane data stay local.
- The current stable model is `jev-1.13.0`; `jev-latest` is movable. Because thresholds are model-
  dependent, the default pins `jev-1.13.0` and requires a new evaluation before changing it.
- `reqwest` and `tokio` are already dependencies, so the backend can call `POST /v1/systemone`
  without adding an SDK or placing the API key in the frontend. `futures-util` can provide abortable
  request futures for explicit cancellation.
- A shared `typesafe.rs` client/config seam is introduced here if issue #25 has not already added one;
  otherwise this feature reuses it. Startup health checks and embeddings/vector storage were rejected
  because an optional hint must add neither startup dependency nor synchronized external state.

## Prior Art

| Product | Implementation | Lesson for Krypton |
|---------|----------------|--------------------|
| Linear Triage Intelligence | Surfaces semantically related or duplicate issues, lets the user inspect, accept, or dismiss the suggestion, and keeps quick search suggestions separate from deeper analysis | Put the suggestion next to the decision and keep the human in control |
| Jira Cloud | Uses AI while a work-item title is entered to surface similar existing work items; the user reviews and links them before creation | Suggest during capture, before a duplicate record is committed |
| GitHub Issues | Supports explicit duplicate relationships and AI-assisted triage, but duplicate disposition remains a maintainer action | Semantic evidence may guide a person but must not silently change canonical identity |
| Krypton Timeline | Shows deterministic nearby-topic chips and requires confirmation before creating a lexical near-duplicate | Preserve this offline baseline and layer semantic help above it |

**Krypton delta** — unlike issue trackers, Timeline is an append-only provenance ledger and the
stable `topic_id` controls chronology. A wrong automatic choice would rewrite meaning, so Krypton
never auto-merges or preselects a semantic result. The new row is keyboard reachable, shows its
confidence, and requires either “use this topic” or “create a new topic.”

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/typesafe.rs` | Shared TypeSafe HTTP client, credential resolution, deadlines, retry/circuit policy, cancellation, schema validation, and aggregate metrics |
| `src-tauri/src/config.rs` | Add non-secret `[typesafe]` and timeline-topic feature configuration |
| `src-tauri/src/timeline.rs` | Add the bounded semantic-topic request/response Tauri commands |
| `src-tauri/src/lib.rs` | Manage TypeSafe state and register topic-suggest/cancel commands |
| `src/config.ts` | Mirror non-secret TypeSafe configuration for frontend behavior |
| `src/acp/timeline.ts` | Add pure candidate construction and semantic request/result types |
| `src/acp/timeline-capture.ts` | Debounce requests, reject stale results, render the choice, and require an explicit user decision |
| `src/acp/acp-harness-view.ts` | Inject the local Harness id, mode, and invoke callbacks into `TimelineCapture` |
| `src/styles/acp-harness.css` | Style the suggestion/status row with full borders and keyboard focus states |
| `src/acp/timeline.test.ts` | Cover exact bypass, shortlist coverage/caps, and request composition |
| `src/acp/timeline-capture.test.ts` | Source-contract coverage for debounce, cancellation, stale responses, explicit choice, keyboard-native buttons, and fallback |
| TypeScript/Rust tests and `src/acp/fixtures/timeline-topic-semantic.json` | Cover candidate quality, UI lifecycle, response gates/failures, and labeled Thai/English evaluation cases without live network calls |
| `docs/02-functional-requirements.md`, `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/06-configuration.md`, `docs/72-acp-harness-view.md` | Document requirements, trust/data flow, opt-in configuration, and keyboard UI |
| `docs/253-project-decision-requirement-timeline.md`, `docs/254-automatic-timeline-suggestions.md` | Cross-reference the capture/review aid without changing persistence semantics |
| `docs/README.md` | Index this specification |

## Design

### Configuration

```toml
[typesafe]
enabled = false
api_key_env = "TYPESAFE_API_KEY"
base_url = "https://api.typesafe.ai"
model = "jev-1.13.0"
connect_timeout_ms = 300
attempt_timeout_ms = 650
overall_deadline_ms = 1600
max_retries = 1
failure_threshold = 3
cooldown_secs = 30

[typesafe.timeline_topics]
mode = "off"                 # off | shadow | suggest
debounce_ms = 350
min_confidence = 0.65
min_probability = 0.55
min_margin = 0.15
max_candidates = 12
```

`enabled = false` prevents every request. `shadow` runs inference and aggregate metrics without UI;
`suggest` enables the visible choice. `Reload Config` applies when a later capture sheet opens.

The API key is resolved in Rust from `api_key_env`, including the existing macOS login-shell fallback.
The value is never serialized by `get_config`, returned by IPC, written to disk, or logged. Phase 1
does not add a credential settings UI or a second keyring path. A future shared TypeSafe settings UI
may replace the resolver without changing this feature contract.

Unsafe configuration is clamped or rejected: candidates `2..=20`, debounce `150..=1500 ms`, overall
deadline <= `5000 ms`, retries `0..=2`, and probability gates `0..=1`. Invalid mode acts as `off`.

### Data Structures

```ts
export interface TimelineTopicCandidate {
  topicId: string;
  title: string;
  occurredAt: string;
  recentSummaries: string[];
  lexicalScore: number;
}

export interface TimelineTopicSemanticRequest {
  requestId: string;
  draft: { title: string; summary: string };
  candidates: TimelineTopicCandidate[];
}

export type TimelineTopicSemanticResult =
  | { kind: 'suggestion'; requestId: string; topicId: string; title: string;
      confidence: number; probability: number; model: string; latencyMs: number }
  | {
      kind: 'fallback';
      requestId: string;
      reason: 'create_new' | 'low_confidence' | 'disabled' | 'missing_key'
        | 'shadow' | 'cooldown' | 'cancelled' | 'timeout' | 'unavailable' | 'invalid_response';
      latencyMs: number };
```

Rust mirrors the wire types with `deny_unknown_fields` on the TypeSafe response structs. Internal
`TypeSafeState` owns one `reqwest::Client`, cancellation senders keyed by `request_id`, consecutive-
failure and cooldown state, and aggregate outcome/latency counters. Request ids are opaque and contain no
draft text.

### Candidate Construction

`buildTimelineTopicCandidates(draft, events, maxCandidates)` is pure and deterministic:

1. Collapse events by stable `topicId`; retain the newest title/date and the two newest distinct
   summaries, truncated to 240 Unicode scalars each.
2. Compute each topic's maximum existing `topicMatchScore()` against the draft title and summary.
3. When the unique-topic count is at most `maxCandidates`, include every topic.
4. For a larger corpus, include up to eight positive lexical matches in score/recency order, then
   fill remaining capacity with recent topics not already selected.
5. If the corpus exceeds the cap and no topic has a positive lexical score, return no candidates and
   use the current UI. Do not send an arbitrary partial corpus that cannot cover the likely answer.
6. Reject the request if fewer than two candidates remain or serialized state exceeds 8 KiB.

The exact normalized-title check runs before this function. An exact match cancels pending semantic
work, clears any semantic row, and uses the existing `topic_id` path without a network call.

### TypeSafe Request

The backend sends one request to `POST {base_url}/v1/systemone` with this semantic shape:

```json
{
  "model": "jev-1.13.0",
  "state": { "draft": { "title": "...", "summary": "..." },
    "candidate_topics": [{ "id": "topic-upload", "title": "Upload validation",
      "recent_summaries": ["..."] }] },
  "questions": {
    "topic": {
      "type": "choice",
      "instructions": { "question": "Which existing topic has the same project meaning as the draft?",
        "rule": "Choose create_new when none is the same subject; related is not the same." },
      "criteria": {
        "topic-upload": "The candidate named topic-upload in candidate_topics",
        "create_new": "No candidate represents the same continuing project topic"
      } } }
}
```

Only candidate `topic_id` values and `create_new` are accepted as criteria keys. The response is
rejected as a whole unless `answers.topic` is a `choice`, every probability is finite and within
`0..=1`, the chosen option exists, the distribution covers the supplied options, and its sum is
within `0.01` of `1.0`.

An existing-topic result becomes visible only when all three configured gates pass: response
confidence, chosen probability, and the probability margin over the runner-up. `create_new` and any
failed gate return `fallback` and leave the current UI unchanged. The initial values above are
conservative starting points for a harmless suggestion, not permission to persist; they must be
recalibrated against the checked-in fixture before changing the default model or enabling `suggest`
in a distributed config.

### Commands

```rust
#[tauri::command]
async fn timeline_topic_suggest(
    harness_id: String,
    request: TimelineTopicSemanticRequest,
    hook_server: State<'_, Arc<HookServer>>,
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
    typesafe: State<'_, Arc<TypeSafeState>>,
) -> Result<TimelineTopicSemanticResult, String>;

#[tauri::command]
fn timeline_topic_suggest_cancel(
    request_id: String,
    typesafe: State<'_, Arc<TypeSafeState>>,
) -> bool;
```

`timeline_topic_suggest` first verifies that `harness_id` resolves locally and every candidate field
matches that project's Timeline, then validates bounds before credentials or network work. Expected optional-
service outcomes are returned as `fallback`, not command errors. Command errors are reserved for
malformed caller input or broken internal invariants.

### Data Flow

```text
1. User edits Timeline topic or summary.
2. TimelineCapture clears any earlier semantic decision and schedules a 350 ms debounce.
3. Exact normalized title match -> cancel old request, use existing deterministic topic, stop.
4. Candidate builder produces a bounded shortlist; inadequate coverage -> keep current UI, stop.
5. Frontend cancels the previous request id and invokes timeline_topic_suggest with a new id.
6. Rust checks opt-in config/key/cooldown, sends the bounded Choice request, validates and gates it.
7. Frontend accepts the result only if the dialog, draft generation, and request id still match.
8. Shadow mode updates aggregate metrics only. Suggest mode renders one semantic suggestion row.
9. User chooses “ใช้หัวข้อนี้” or “สร้างหัวข้อใหม่”; only the first sets selectedTopicId.
10. Existing validation and timeline_record/timeline_suggestion_confirm persist the chosen request.
```

Input after step 5, dialog close, pending-item change, or component disposal calls cancel and also
increments a frontend generation token. Backend abort saves work where possible; the generation
guard is the correctness boundary if completion races cancellation.

### Retry, Cooldown, and Recovery

- Each attempt has a `650 ms` timeout under a hard `1600 ms` overall deadline.
- Retry once for connection interruption, `408`, `429`, `529`, and other `5xx` responses using
  jittered `150 ms` exponential backoff. Honor `Retry-After` only when it fits the remaining deadline.
- Do not retry `401`, `403`, or `422`; categorize them without logging the body.
- Three consecutive retryable failures open a `30 s` in-memory circuit. A successful request closes
  it. A model/endpoint/key-name change or cooldown expiry permits a fresh request.
- Missing key, cancellation, malformed response, and all exhausted failures fall back silently.
  They never block save, close, lane turns, app shutdown, or later requests.
- Log only category, status class, model, duration, retry count, and request id. Never log state,
  criteria, API key, headers, raw response, topic titles, summaries, or `topic_id` values.

### UI and Keyboard Behavior

The existing lexical topic chips remain unchanged. A semantic result adds one full-width, fully
bordered row below them:

```text
หัวข้อที่น่าจะตรง · Upload validation · confidence 78%
[ใช้หัวข้อนี้] [สร้างหัวข้อใหม่]
```

The buttons participate in normal `Tab` / `Shift+Tab` order and activate with `Enter` or `Space`.
No global keybinding is added because the capture sheet already has a complete keyboard path.
While a visible semantic result is unresolved, `Cmd/Ctrl+Enter` explains that one of the two choices
must be selected. Choosing the existing topic copies its latest title and stable id. Choosing new
keeps the typed title and allows the existing duplicate-confirmation flow. Editing topic or summary
after either choice clears it and starts a fresh generation. Loading/failure states do not steal
focus, announce noisy errors, or disable the form.

The row uses `.acp-timeline__semantic-match` with a full border/background tint; it must not add the
banned L-shaped or left-only accent treatment. `aria-live="polite"` announces a newly visible result.

### Evaluation and Release Gate

The checked-in fixture records only synthetic or explicitly sanitized drafts and expected
`topic_id`/`create_new` outcomes. Tests report these separately:

1. Candidate recall before TypeSafe.
2. Top-1 selection accuracy when the expected topic is present.
3. Wrong-topic visible-suggestion rate after all gates.
4. `create_new` accuracy and ambiguity abstention.
5. p50/p95 latency and fallback success.

Shadow mode retains only aggregate suggestion/fallback counts and total latency in memory. It does
not persist titles, summaries, request/response bodies, or per-record predictions. Visible `suggest`
mode is not a release default until an explicit Krypton fixture run reaches
candidate recall >= 90%, wrong-topic visible suggestions <= 5%, `create_new` accuracy >= 90%, and
p95 <= 1200 ms. Exact-match, missing-key, and network-failure suites run fully
offline; live API validation is optional and requires an explicit key-bearing test environment.

## Edge Cases

- **One or zero existing topics** — do not call TypeSafe; current UI is already sufficient.
- **Exact title match** — deterministic reuse wins even if a stale semantic request completes later.
- **Thai/English pair** — allowed when the complete corpus fits the cap; evaluated separately because
  TypeSafe documents lower accuracy outside its primary English training language.
- **Large corpus without lexical signal** — show no semantic suggestion rather than implying coverage.
- **Ambiguous candidates** — `create_new`, low confidence, or insufficient margin falls back.
- **Candidate deleted/changed** — backend validation fails normally instead of substituting an id.
- **Pending review** — evidence and suggested-lane provenance remain local and are never sent.
- **User selects a relation** — the related event remains authoritative and continues to set its
  topic exactly as today; any semantic request is cancelled.
- **Remote Harness** — unchanged: local Timeline capture/review is unavailable, so no request runs.
- **Offline startup** — no network or credential work occurs before an eligible opted-in request.
- **App closes mid-request** — cancellation senders are dropped; no write or awaited shutdown work exists.

## Validation

- `npm test -- --run`, `npm run build`, Rust tests/lint/format, `git diff --check`, and an explicit
  key-gated live `jev-1.13.0` test pass; semantic-match, ambiguous, and `create_new` fixtures were exercised.

## Out of Scope

- Semantic matching in MCP `timeline_record` or `timeline_suggest`
- Automatically choosing, merging, renaming, or rewriting a stored `topic_id`
- Changing authority, provenance, relation, supersession, or append-only rules
- Sending transcript, memory, evidence/instruction excerpts, source references, source tree, tool
  output, secrets, other lanes, or the complete Timeline corpus to TypeSafe
- Embeddings, vector storage, cross-project topic search, browser search, or `#timeline trace`
- API-key settings UI, billing UI, persisted raw telemetry, or model training
- The semantic `#command` suggestion UI from issue #25

## Resources

- [TypeSafe API reference](https://docs.typesafe.ai/api) — HTTP endpoint and typed wire schema.
- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice) — closed-set selection, probabilities,
  confidence, structured criteria, and no-match options.
- [TypeSafe Confidence](https://docs.typesafe.ai/confidence) — uncertainty routing and calibration.
- [TypeSafe State](https://docs.typesafe.ai/concepts/state) — minimal structured state and language caveat.
- [TypeSafe Models](https://docs.typesafe.ai/models) — `jev-1.13.0`, aliases, and limits.
- [TypeSafe Re-ranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe) — shortlist recall
  and semantic selection are separate quality measures.
- [Linear Triage Intelligence](https://linear.app/docs/triage-intelligence) — inspectable semantic
  duplicate/relationship suggestions.
- [Jira Cloud: Find and link similar work items with AI](https://support.atlassian.com/jira-software-cloud/docs/create-a-work-item-and-a-sub-task/#Find-and-link-similar-work-items-with-AI) — suggestions during title entry before creation.
- [GitHub: Administering issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues) — AI triage and explicit duplicate handling remain separate maintainer actions.
- Internal: `docs/253-project-decision-requirement-timeline.md`,
  `docs/254-automatic-timeline-suggestions.md`, `docs/255-natural-language-timeline-recording.md`,
  `src/acp/timeline.ts`, `src/acp/timeline-capture.ts`, and `src-tauri/src/timeline.rs`.
