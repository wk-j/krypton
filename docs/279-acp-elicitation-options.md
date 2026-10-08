# ACP Form Elicitation (Agent Options Dialogs) — Implementation Spec

> Status: Implemented (scope widened to every lane on 2026-10-07; wire verified against `omp/18.7.0`; harness slash turns fixed to go out bare on 2026-10-08, in-app card check pending)
> Date: 2026-10-07
> Milestone: M-ACP — Harness convergence
> Builds on: `docs/229-grok-ask-user-question.md` (question card), `docs/122-acp-omp-lane.md` (OMP lane)

## Problem

OMP's native TUI shows option pickers: `/review` → **Review Mode** (1–5), then "Select base branch" or "Select commit", the plan-mode exit confirm, and extension/skill `select`/`confirm`/`input`/`editor` dialogs. Under `omp acp` those dialogs are sent as ACP `elicitation/create` requests, and only when the client advertises `clientCapabilities.elicitation.form`. Krypton does not advertise it. So in an OMP lane, `/review` with no arguments ends the turn and does nothing, and plan mode is approved automatically with no prompt.

## Solution

Advertise `elicitation: { form: {} }` in `initialize` to **every ACP backend** (one client-wide capability, same as Zed). Handle inbound `elicitation/create` (form mode) with the same pattern as spec 229: Rust parks a oneshot and the frontend renders the existing **question card** (`ask-user-question.ts`) in the harness lane or the standalone ACP view. The card answers with an ACP `CreateElicitationResponse` (`accept` + `content` | `decline` | `cancel`). Rust stays thin: it forwards the raw `requestedSchema`, and a pure TS module converts schema to card questions and card answers back to `content`. Any lane whose agent sends form elicitations gets the dialog; OMP is the verified driver.

## Research

- **Wire, observed live** (`omp/18.7.0`, probe on 2026-10-07). Without the capability, `session/prompt "/review"` returns `end_turn` and sends no request. With `elicitation.form`, OMP sends:
  `elicitation/create { mode:"form", sessionId, message:"Review Mode", requestedSchema:{ type:"object", properties:{ value:{ type:"string", enum:["1. Review against a base branch (PR Style)", …, "5. Custom review instructions"] } }, required:["value"] } }`.
  Replying `{ action:"accept", content:{ value:"2. Review uncommitted changes" } }` was accepted. The JSON-RPC id was `0`.
- **OMP mapping** (`pi-coding-agent/src/modes/acp/acp-agent.ts` `createAcpExtensionUiContext`). Every OMP dialog uses one property named `value`:
  - `select` → `string` + `enum` of labels
  - `confirm` → `boolean`
  - `input` → `string`, with the placeholder as `description`
  - `editor` → `string`, with the prefill as `default`

  Any non-`accept` reply, or a missing `content`, means `undefined` (cancelled). OMP has no `cancel_elicitation` for form mode: when its local signal aborts or times out, the ACP request stays open on the client.
- **Gated features in OMP**: `/review` menu and its follow-ups (`review/index.ts`), plan-mode exit approval (`#requestAcpPlanApprovalChoice`, auto-approves without the capability), coding-plan reserve fallback confirm, Codex auto-redeem confirm, and extension commands.
- **Not unlocked:** the model's `ask` tool. `omp acp` sets `sessionOptions.hasUI = false` (`main.ts`), so `AskTool` is never registered. Only upstream OMP can change that.
- **ACP schema** (`@agentclientprotocol/sdk` 0.25.0, marked UNSTABLE). Form properties can be:
  - `string` (optional `enum` or `oneOf[{const,title}]`, `default`, `minLength`/`maxLength`/`pattern`/`format`)
  - `number` / `integer` (`minimum`/`maximum`)
  - `boolean`
  - `array` (multi-select, `items.enum` or `items.anyOf`)

  The response is `accept` with `content{[field]: value}`, or `decline`, or `cancel`. URL mode exists, but we do not advertise it.
- **Existing Krypton pieces**: `ask_pending` oneshot + `acp_ask_user_response` (Grok), the question card + key reducer `applyAskUserKey`, `HarnessLane.pendingQuestions`, the transcript `question` row, and standalone `AcpView.renderAskUser`.
- **All-lane safety probe (2026-10-07).** `initialize` with `elicitation.form` added succeeded on every installed backend: Claude (`claude-agent-acp`), Codex, OpenCode, Pi, Droid, Cursor, OMP, Grok, Copilot. Gemini and MiMo are not installed. Junie fails on a local install error, and Cline closes stdout with or without the field, so neither failure is related to elicitation. Agents that do not use the capability ignore it.
- **Rejected:**
  - Translating elicitation into Grok's `ask_user_question` event in Rust. The reply shapes differ, enum/boolean must not offer free-text "Other", and Rust would gain schema logic.
  - A new overlay/modal. It conflicts with the permission/question rail, and spec 229 chose inline rows.
  - Auto-picking the first option. That decides for the human.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| OMP TUI | Boxed list. `Up/Down` navigate, `Enter` select, `Esc` cancel; titles like "Review Mode" | What the user wants mirrored |
| Zed | Advertises `elicitation.form` + `url`. `agent_ui/conversation_view/elicitation.rs` renders a full form (string/number/integer/boolean/single+multi select) with validation | Reference ACP client |
| Krypton Grok card (spec 229) | Inline transcript row. `j/k` move, `1–9`/`a–f` pick, `Enter`, `x` skip, `z` other, `Esc` parks | Reused as-is |

**Krypton delta** — We render agent dialogs inline in the transcript with the same keys as the Grok card, instead of OMP's floating box. `Esc` keeps its harness meaning (park), not cancel. `x` declines. Like Zed, the capability is client-wide; unlike Zed, we support form mode only, with no URL mode.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `"elicitation": { "form": {} }` to `clientCapabilities` for every backend. `elicit_pending` map. Inbound `elicitation/create` handler. `acp_elicitation_response` command. Drain with `cancel` on `acp_cancel` / dispose / disconnect. Unit tests |
| `src-tauri/src/lib.rs` | Register `acp_elicitation_response` |
| `src/acp/elicitation.ts` (new) | Pure `parseElicitationForm(message, schema)` → card questions + field map; `elicitationResponse(fields, reply)`; `QuestionTarget`. Tests in `elicitation.test.ts` |
| `src/acp/ask-user-question.ts` | `AskUserQuestion` gains `detail?`, `allowOther?` (default true), `textOnly?`, `textKind?`, `defaultText?`, `defaultOption?`, `optional?`. The reducer honours them. `AskUserReply` (`accept` / `decline` / `cancel`), `QuestionWire`, `questionActionsHint` |
| `src/acp/types.ts`, `src/acp/client.ts` | `elicitation_request` event; `respondQuestion(target, reply)` replaces `respondAskUser` and maps the reply per wire |
| `src/acp/harness-view-types.ts` | `HarnessAskUser extends QuestionTarget` (`wire: 'grok' \| 'elicitation'`, `fields`) |
| `src/acp/acp-harness-view.ts` | `addElicitation` (queues, no displacement); `resolveAskUser`/`abandonPendingQuestions` reply per `wire`; `sendUserPrompt` sends advertised slash commands without the lane-context packet |
| `src/acp/harness-lane-chrome.ts` | `isAgentSlashCommand(text, availableCommands)`. Tests in `harness-lane-chrome.test.ts` |
| `src/acp/harness-transcript-render.ts`, `src/acp/acp-view.ts` | Hide `z Other` when `allowOther === false`; render `detail`; text-only field; `x decline` copy; scroll the focused option into view |
| `src/styles/acp-harness.css`, `src/styles/acp.css` | `.acp-harness__question-detail` (pre-wrap, capped height); options list `max-height` + `overflow-y:auto` |
| `docs/122-acp-omp-lane.md`, `docs/69-acp-agent-support.md`, `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/README.md` | Record the capability + method |

## Design

### Data Structures

```ts
// src/acp/elicitation.ts
type ElicitationFieldKind = 'enum' | 'multi' | 'boolean' | 'text' | 'number' | 'integer';
interface ElicitationField {
  name: string;               // property key, e.g. "value"
  kind: ElicitationFieldKind;
  values?: string[];          // wire values for enum/multi (const for oneOf)
  labels?: string[];          // display labels (title for oneOf, else value)
  required: boolean;
}
type ElicitationResponse =
  | { action: 'accept'; content: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' };
```

Schema → one card question per property, in declared order:
- **enum** (`string` + `enum`/`oneOf`): options = labels, `allowOther: false`.
- **multi** (`array`): `multiSelect: true`, `allowOther: false`.
- **boolean**: options `Yes` / `No`, `allowOther: false`. A `default: false` puts the cursor on `No`.
- **text / number / integer**: `textOnly: true`. The card opens with free-text focused and prefilled from `default`. Numbers are parsed on Enter, and an invalid number stays in the draft.

Question text is the property `title`, falling back to the first line of `message`. `detail` is the rest of `message` plus the property `description`.

### API / Commands

```rust
#[tauri::command]
pub async fn acp_elicitation_response(
    session: u64, request_id: u64, response: Value, // ElicitationResponse
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<(), String>;
```

Event: `{ type: "elicitation_request", requestId, message, requestedSchema, toolCallId? }`.

### Data Flow

```
1. User sends "/review" in an OMP lane. `review` is in the lane's `available_commands`, so the harness sends the text bare, without the lane-context packet (see Edge Cases)
2. OMP → elicitation/create { mode:"form", message, requestedSchema }
3. Rust: mode != "form" → reply { action:"decline" }; else park oneshot in elicit_pending[seq], emit elicitation_request { requestId: seq, message, requestedSchema, toolCallId }
4. Frontend parses the schema. If that fails → respondQuestion(decline) + system row. Else it queues a question card and sets the lane to needs_permission
5. Human picks (1–9 / j,k+Enter), types, or x-declines
6. invoke acp_elicitation_response → Rust sanitizes the response (malformed → cancel) and replies on the original JSON-RPC id
7. OMP continues (e.g. a second elicitation "Select base branch …", then the review turn)
```

Lane `#cancel`, error, restart, or dispose replies `{ action:"cancel" }` to every parked elicitation. The standalone `AcpView` also cancels parked cards on turn `stop`, as it already did for Grok questions.

### Keybindings

The spec 229 keys are unchanged. Differences only:

| Key | Context | Action |
|-----|---------|--------|
| `x` | elicitation card | Reply `decline` |
| `z` | enum/boolean field | No-op (Other hidden) |
| typing | text/number field | Edits draft (already focused) |

The composer strip comes from `questionActionsHint`, e.g. `1–9 pick · Enter · x decline` for a closed picker or `type · Enter submit · Esc park · then x decline` for a text field.

### UI Changes

The same `.acp-harness__question` row. New `__question-detail` block under the subject (multi-line message, e.g. the 12-line plan preview). The options list scrolls, and the focused row is kept visible, so the 20-commit and N-branch pickers fit. Options past the 15th have no hotkey and are reached with `j/k`. A resolved row shows `✓ <label>` / `declined` / `cancelled`.

## Edge Cases

- **Agent JSON-RPC id shape.** Cards are keyed by a per-client `elicit_seq`, not the JSON-RPC id. OMP sends id `0`, and string ids are legal; neither can collide.
- **Lane-context packet hides slash commands.** The harness normally prepends the lane-context/directive packet to every prompt. OMP's `#convertPromptBlocks` joins all blocks into one string and only parses a command when that string starts with `/`, so `/review` behind the packet reached the model as plain text and no elicitation was ever sent. A live probe on 2026-10-08 confirmed it: `[packet, "/review"]` produced model output, while `["/review"]` produced `elicitation/create "Review Mode"`. `isAgentSlashCommand` (`harness-lane-chrome.ts`) therefore sends a draft whose first token matches an advertised command without the packet. Paths like `/Users/…` and unadvertised tokens keep the packet. A pending one-shot directive override is kept for the next normal turn.
- **Several elicitations in flight**: they queue FIFO. Unlike Grok's, they do not displace each other.
- **OMP aborts locally (timeout or signal)**: the card stays pending until it is answered or the turn is cancelled. A late answer is ignored by OMP, which is harmless.
- **Plan-mode exit**: it now asks a Yes/No question instead of auto-approving. This matches the OMP TUI.
- **Bypass / acceptEdits / accept-all / Telegram turns**: they still show the card, because an elicitation is not a tool permission (same rule as spec 229).
- **Required field left empty, or a multi-select with nothing chosen**: `Enter` on an empty required text field does nothing (on a multi-select with nothing toggled it commits the focused option); `x` declines. After a commit, the card moves to the next unanswered question. If `h`/`l` skipped a required field, focus jumps back to it instead of submitting. As a backstop, an accept that still lacks a required field is sent as `cancel`.
- **Duplicate `oneOf` titles** (e.g. two branches both titled `main`): the label gets the `const` appended (`main (a1)`), so each row maps back to its own value.
- **Queued cards**: only the head card has a transcript row (harness) or DOM block (AcpView). Queued cards mount when they reach the head, so the transcript never shows a live-looking card that ignores keys.
- **Multi-line `editor`**: single-line draft only. Pasted newlines are kept as-is in the draft.

## Open Questions

None.

## Out of Scope

- URL-mode elicitation and `elicitation/complete`.
- OMP's model `ask` tool (`hasUI=false` upstream).
- Live-assist / Telegram / control-API answering.
- JSON Schema validation beyond type, required, and enum membership (`pattern`, `format`, and length are ignored and left to the agent).

## Resources

- `@agentclientprotocol/sdk` 0.25.0 `dist/schema/types.gen.d.ts`: `CreateElicitationRequest/Response`, `ElicitationPropertySchema`, `ElicitationCapabilities`
- `@oh-my-pi/pi-coding-agent` 18.7.0: `modes/acp/acp-agent.ts` (`elicitFromAcpClient`, `createAcpExtensionUiContext`, plan approval), `extensibility/custom-commands/bundled/review/index.ts`, `main.ts` (`hasUI`)
- Zed `crates/agent_servers/src/acp.rs` (`handle_create_elicitation`, capability advertisement), `crates/agent_ui/src/conversation_view/elicitation.rs`
- `docs/229-grok-ask-user-question.md`: card, keys, park pattern
- Live probe: `omp acp` with and without `elicitation.form`, 2026-10-07
