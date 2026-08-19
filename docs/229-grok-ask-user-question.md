# Grok `ask_user_question` ACP Client Method — Implementation Spec

> Status: Approved (code landed; reply tag verified as `outcome` against grok 1.0.5 / `5115b46bc909`)
> Date: 2026-08-17
> Milestone: M-ACP — Harness convergence
> Builds on: `docs/135-acp-grok-lane.md` (`_x.ai/exit_plan_mode`), `docs/69-acp-agent-support.md` (permission oneshot)

## Problem

Grok's `ask_user_question` tool asks the ACP *client* to show a blocking question card. It sends JSON-RPC `_x.ai/ask_user_question` (also registered as `x.ai/ask_user_question`). Krypton's inbound dispatcher only handles `fs/*`, `session/request_permission`, and `_x.ai/exit_plan_mode`. The catch-all replies `-32601 Method not found`. The tool card fails. The human never sees the question.

## Solution

Handle the method the same way as `session/request_permission`: park a oneshot, emit a frontend event, render an inline transcript card, reply when the human picks or skips. Do **not** auto-answer. Permission modes (`bypass`, `acceptEdits`, accept-all, Telegram bypass) do not apply — a question is not a tool-permission.

## Research

- **Same gap as plan-mode exit.** Spec 135 added `_x.ai/exit_plan_mode` because the TUI approval surface is absent over ACP. `ask_user_question` is the sibling: Grok TUI opens a question card (`Opened question view from ext_method`). Without a handler the tool dies instead of falling back (Grok 1.0.4 strings include a "fallback path", but ACP treats method-not-found as a hard error: `Failed to reach the client for user question: Method not found: _x.ai/ask_user_question`).
- **Wire (grok 1.0.5 / `5115b46bc909`).** Method names sit next to each other as `x.ai/ask_user_question` / `x.ai/exit_plan_mode`. The error string uses the `_x.ai/` prefix — handle both, matching spec 135. `AskUserQuestionExtRequest` has 4 fields. Tool input is `AskUserQuestionInput { questions[] }`; each question has `question`, `options[{ label, description, preview? }]`, optional `multiSelect`. Response is internally tagged `AskUserQuestionExtResponse` on **`outcome`** (not serde's default `type`): `Accepted { answers, partial_answers }`, `ChatAboutThis`, `SkipInterview`. Sending `{ "type": "accepted", ... }` fails with `Client returned an invalid response to user question: missing field 'outcome'`. TUI skip copy: `User declined to answer the questions. Continue with the task using your best judgment`. TUI state includes `selected_labels` and `build_accepted_response`.
- **Timeout is Grok's.** `[toolset.ask_user_question] timeout_secs` (default 1800) lives in Grok config. If Grok times out it continues without answers. Krypton does not add a second timer.
- **Existing park pattern.** `perm_pending` / `fs_write_pending` + `acp_permission_response` / `acp_fs_write_response`. Disconnect already clears those maps (oneshots drop). A new `ask_pending` map belongs there.
- **Key collision.** Transcript focus `1–9` switches lanes. Permission uses `a`/`r` so it can sit *after* that. Question options use `1–9`, so question keys must run *before* `handleTranscriptKey`.
- **Rejected:** auto-Skip (hides the fork). Auto-pick first option (decides for the human). Reuse `attention_flag` (non-blocking, wrong contract). Overlay (fights permission / plan / attention). New lane status `needs_answer` in v1 (ripples live-assist / Telegram / orchestrator); reuse `needs_permission` as "blocked on the human".

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Grok TUI | Blocking question card. `j/k` options, `h/l` questions, `1–9`/`a–f` pick, `z` free-text, `Enter` advance/submit, `Shift+X` dismiss, `Esc` park | Source of the ACP method |
| Claude Code | `AskUserQuestion` tool → IDE/TUI questionnaire | Same job, different wire |
| Krypton permission card | Inline transcript row + composer `a/A/r/R/Esc` | Pattern to copy |
| Krypton attention triage | Non-blocking review queue | Wrong: agent must wait |

**Krypton delta** — Grok TUI's card, rendered as a permission-style transcript row (keyboard-first, no overlay, no left accent rail). Skip is explicit (`x`), not Esc.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | `ask_pending` map; inbound `_x.ai/ask_user_question` / `x.ai/ask_user_question`; `acp_ask_user_response` |
| `src-tauri/src/lib.rs` | Register the command |
| `src/acp/types.ts` | `ask_user_question` event + question types |
| `src/acp/client.ts` | Parse event; `respondAskUser(...)` |
| `src/acp/harness-view-types.ts` | `pendingQuestions`; transcript kind `question` |
| `src/acp/acp-harness-view.ts` | Card, keys, composer `ask` strip, lane-pause |
| `src/acp/harness-transcript-render.ts` | Render the question row |
| `src/acp/harness-lane-chrome.ts` | `ask` chip when a question is pending |
| `src/acp/acp-view.ts` | Same card on the standalone ACP window |
| `src/styles/acp-harness.css` (+ `acp.css` if AcpView needs it) | `.acp-harness__question` |
| `src/acp/live-assist-view.ts` | If snapshot status is `needs_permission` because of a question, copy says answer in the harness. No resolve. |
| tests next to the TS modules above | Parse, key dispatch, skip vs accept, no auto-answer under bypass |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/135-acp-grok-lane.md`, `docs/69-acp-agent-support.md`, `docs/README.md` | Record the method |

## Design

### Data structures

```ts
interface AskUserOption { label: string; description: string; preview?: string }
interface AskUserQuestion {
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean;
}
type AskUserDecision =
  | { outcome: 'accepted'; answers: AskUserAnswer[]; partial_answers: null }
  | { outcome: 'skip_interview' };
interface AskUserAnswer { question: string; selected_labels: string[] }
```

Rust parks `oneshot::Sender<Value>` in `ask_pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>`, keyed by the JSON-RPC request id.

### API / commands

```rust
#[tauri::command]
pub async fn acp_ask_user_response(
    session: u64,
    request_id: u64,
    decision: Value, // AskUserDecision
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String>;
```

Inbound params (lenient): `questions` required (array). `sessionId` / `toolCallId` optional (log + `tool_call_update` title). Extra fields ignored.

Reply JSON (verified against grok 1.0.5 internally tagged on `outcome`, same pattern as `exit_plan_mode`):

```json
{ "outcome": "accepted", "answers": [{ "question": "…", "selected_labels": ["OS browser loopback"] }], "partial_answers": null }
{ "outcome": "skip_interview" }
```

Rust remaps a leftover `{ "type": "…" }` to `outcome` at the JSON-RPC reply so a stale frontend cannot reproduce the `missing field 'outcome'` tool failure.

**Verification gate (blocks "Implemented"):** live Grok lane, trigger `ask_user_question`, pick an option, confirm the tool completes (not `Client returned an invalid response to user question`). Tag name is settled; remaining live check is that `answers` / `selected_labels` deserialize.

### Data flow

```
1. Grok tool ask_user_question
2. Agent JSON-RPC request _x.ai/ask_user_question { questions, sessionId?, toolCallId? }
3. Rust parks oneshot in ask_pending[id], emits acp-event
   { type: "ask_user_question", requestId, questions, toolCallId }
4. Frontend appends transcript kind "question", setLaneStatus(needs_permission)
5. Human picks / types Other / x-skips
6. invoke acp_ask_user_response → Rust replies on the oneshot
7. Grok unblocks; tool_call_update completed
```

A second request for the same session: reply `skip_interview` on the previous oneshot (Grok TUI: "Replacing active question - cancelling previous"), then park the new one.

Disconnect / `acp_dispose` / `acp_cancel`: drop or `skip_interview` every `ask_pending` entry so Grok does not hang. Clear `pendingQuestions` on lane error / `#cancel` / `#restart` like `pendingPermissions`.

### Keybindings

Question keys win over transcript `1–9` lane switch while `pendingQuestions.length > 0`. Permission still wins if both queues are non-empty (resolve perm first).

| Key | Context | Action |
|-----|---------|--------|
| `j` / `k`, `↑` / `↓` | question pending | Move option (clamp) |
| `1`–`9`, `a`–`f` | question pending | Select that option (toggle if `multiSelect`) |
| `Enter` | question pending | Commit option; next question; submit on last |
| `z` | question pending | Focus Other / free-text |
| `h` / `l` | multi-question | Previous / next question |
| `x` | question pending | `skip_interview` for the whole request |
| `Esc` | free-text | Leave Other, keep card |
| `Esc` | no free-text | Park (card stays). Does **not** skip |

Composer strip while pending: `ask` + `1–9 pick · Enter · x skip · z other`.

### UI

Transcript row, permission-card chrome (full border / background tint — no left rail):

```
ask  Where should the new client live?
  1  OS browser loopback     <description>
  2  Visual prototype first
  3  …
  z  Other
```

Resolved row stays in the transcript (`✓ <labels>` or `skipped`). Multi-select: space/number toggles; Enter commits that question.

### Configuration

None. Grok's `[toolset.ask_user_question]` timeout stays in `~/.grok/config.toml`.

## Edge Cases

- Empty `questions` → JSON-RPC error `-32602 Invalid params` (Grok itself says "No questions provided").
- `bypass` / `acceptEdits` / accept-all / Telegram-origin turn: still show the card.
- Live-assist: lane looks paused; copy "Question pending — answer in the harness". No A/R mapping.
- Standalone `AcpView`: same event and keys (no harness composer). Card is inline like its permission block.
- Hidden / unfocused lane: card waits; status stays `needs_permission` so the rail shows it.
- Free-text Other: `selected_labels: ["<typed text>"]` for that question.

## Open Questions

None. Reply tag is `outcome` (grok 1.0.5). Remaining live check is `answers` / `selected_labels` only.

## Out of Scope

- Interactive `_x.ai/exit_plan_mode` review (still auto-approve per spec 135).
- Telegram / control-API resolve ops for questions.
- Live-assist answering.
- `ChatAboutThis` (type-instead-of-picking). Skip or Other cover "I don't want these options".
- Advertising a client capability at `initialize` — Grok already calls the method without one.

## Resources

- `~/.grok/docs/user-guide/03-keyboard-shortcuts.md` — question-card keys
- `~/.grok/docs/user-guide/05-configuration.md` — `[toolset.ask_user_question]` timeout
- `~/.grok/docs/user-guide/15-agent-mode.md` — `x.ai/*` extensions (list is non-exhaustive; this method is missing there)
- `~/.grok/docs/user-guide/19-plan-mode.md` — plan mode uses `ask_user_question`
- grok 1.0.4 binary strings — method names, `AskUserQuestionExtRequest`/`Response`, error copy
- [ACP overview](https://agentclientprotocol.com/overview/introduction) — client-handled JSON-RPC requests
- `docs/135-acp-grok-lane.md` — `_x.ai/exit_plan_mode` auto-approve precedent
- `docs/69-acp-agent-support.md` — permission oneshot pattern
