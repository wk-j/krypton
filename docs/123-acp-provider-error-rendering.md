# ACP Provider Error Rendering — Implementation Spec

> Status: Implemented
> Date: 2026-05-27
> Milestone: M-ACP — Harness polish

## Problem

ACP harness lanes can show raw provider failures as assistant text, for example `Error: T: resource_exhausted] Error`. This is confusing because the error looks like a malformed model response instead of a request failure, and the assistant markdown path can further distort provider error strings.

## Solution

Add a first-class provider-error transcript kind for ACP harness lanes. Phase 1 classifies short assistant rows at stream seal time in the frontend, rewrites matching rows into structured `provider_error` cards, and keeps raw details collapsed. Later phases may accept a typed `provider_error` event from Rust or adapters, but the frontend classifier remains as a compatibility fallback because current adapters can stringify provider failures into `agent_message_chunk`.

## Research

- `AcpClient.handleRaw()` maps `session/update { sessionUpdate: "agent_message_chunk" }` to `{ type: 'message_chunk' }`, and `AcpHarnessView.onLaneEvent()` appends it to the assistant stream. That path is the likely source of raw `resource_exhausted` text in the lane transcript.
- Structured ACP `error` events already exist, but the harness currently renders them as `kind: 'system'` with text `error: ...`. That is acceptable for generic lifecycle failures but too weak for recurring provider/API failures.
- The harness already has strong local precedent for dedicated transcript kinds: `permission`, `fs_activity`, `fs_write_review`, `inter_lane`, and `review` rows have typed payloads, render signatures, and dedicated CSS. Provider errors should follow that pattern instead of overloading `system` or `assistant`.
- The streaming pipeline intentionally defers assistant markdown until `sealStreaming()` for performance and flicker reasons. Seal time is therefore the right point to classify complete assistant text: it avoids chunk-fragment false positives and preserves the current streaming fast path.
- Rust `handle_notification()` forwards known `session/update` kinds verbatim. Backend classification is possible, but it would still be heuristic unless adapters emit structured errors, and it would require buffering assistant chunks in Rust.
- Provider docs separate retryable rate/overload failures from non-retryable auth/context/request failures. OpenAI recommends exponential backoff for rate limits; Anthropic exposes distinct error types such as `rate_limit_error`, `api_error`, and `overloaded_error`.
- Closest UI prior art in code editors and agent hosts is a visible error card with a retry affordance or collapsed diagnostics, not a normal assistant message. Krypton should keep that convention but render it in the harness transcript rather than a floating notification.

## Prior Art

| App / API | Implementation | Notes |
|-----------|----------------|-------|
| VS Code | Extension and chat failures are usually surfaced as notifications or inline error affordances with detail actions. | Familiar pattern: errors are distinct UI events, not chat prose. |
| GitHub Copilot Chat | Rate-limit handling guidance centers on detecting limit responses and retrying after delay. | Supports classifying rate/network/provider failures as retryable. |
| Claude / Anthropic API | Error responses include typed classes such as `rate_limit_error`, `api_error`, and `overloaded_error`. | Confirms taxonomy should distinguish rate limit, provider overload, and generic API failure. |
| OpenAI API | Rate-limit guidance recommends backoff and distinguishes limit/quota style failures from other request errors. | Confirms `rate_limit` / `quota` should not be rendered like assistant prose. |
| Krypton fs activity rows | `fs_activity` is a typed transcript row with payload, renderer, render signature, and CSS. | Local implementation model for `provider_error`. |

**Krypton delta** — keep the error inside the affected lane transcript so the event stays in context with the failed prompt. Do not use a global toast as the primary surface, and do not markdown-render provider diagnostics. Keep keyboard-first actions for later retry work, but phase 1 is display-only.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/provider-error.ts` | New classifier and payload formatting helpers. |
| `src/acp/types.ts` | Add `ProviderErrorCategory`, `ProviderErrorPayload`, and optionally `AcpEvent { type: 'provider_error' }` for future typed events. |
| `src/acp/client.ts` | Phase 2 path: accept raw `provider_error` events if Rust/adapters emit them. Phase 1 can leave this untouched except for exported types if desired. |
| `src/acp/acp-harness-view.ts` | Add `provider_error` to `HarnessTranscriptItem.kind`, classify sealed assistant rows, update lane status/error, render provider-error rows, and include payload in render signatures. |
| `src/styles/acp-harness.css` | Add dedicated provider-error card styles with category modifiers and collapsed raw detail styling. |
| `src/acp/acp-harness-view.test.ts` | Add harness behavior tests for seal-time rewrite and lane status update. |
| `src/acp/provider-error.test.ts` | New classifier unit tests for real provider strings and false positives. |
| `docs/72-acp-harness-view.md` | Update transcript-kind and error-handling behavior after implementation. |
| `docs/05-data-flow.md` | Document provider-error flow after implementation. |
| `docs/PROGRESS.md` | Record the landing after implementation. |

## Design

### Data Structures

```ts
export type ProviderErrorCategory =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'context'
  | 'network'
  | 'provider'
  | 'unknown';

export interface ProviderErrorPayload {
  category: ProviderErrorCategory;
  code?: string;
  headline: string;
  hint?: string;
  retryable: boolean;
  raw: string;
}

interface HarnessTranscriptItem {
  id: string;
  kind:
    | 'system'
    | 'user'
    | 'assistant'
    | 'thought'
    | 'tool'
    | 'permission'
    | 'restart'
    | 'memory'
    | 'shell'
    | 'fs_activity'
    | 'fs_write_review'
    | 'inter_lane'
    | 'review'
    | 'provider_error';
  text: string;
  providerError?: ProviderErrorPayload;
}
```

Optional future `AcpEvent` variant:

```ts
| { type: 'provider_error'; payload: ProviderErrorPayload }
```

### Classifier

```ts
export function classifyProviderError(text: string, backendId?: string): ProviderErrorPayload | null;
```

Classification is conservative:

- Normalize whitespace and trim ANSI/control characters before matching.
- Only classify short rows by default: `text.length <= 1200`.
- Prefer exact provider/API markers over broad words:
  - `resource_exhausted`, `rate_limit_error`, `rate limit`, `429`, `too many requests` -> `rate_limit`
  - `insufficient_quota`, `quota exceeded`, `credit balance`, `usage limit` -> `quota`
  - `context_length_exceeded`, `context length`, `token limit`, `max tokens`, `maximum context` -> `context`
  - `invalid api key`, `unauthorized`, `authentication failed/error/required`, `failed to authenticate`, `401` -> `auth` (the bare word `authentication` is intentionally NOT a trigger — it appears constantly in normal assistant prose and would rewrite working lanes into auth-error cards)
  - `ECONNRESET`, `ETIMEDOUT`, `network error`, `connection refused`, `503` -> `network`
  - `overloaded_error`, `api_error`, `internal server error`, `529` -> `provider`
- Extract a lowercase code when present, such as `resource_exhausted`, `rate_limit_error`, or `context_length_exceeded`.
- Do not classify long assistant prose, markdown documents, tool outputs, or rows containing multiple paragraphs plus normal explanation.
- **Assistant-prose gate (`{ prose: true }`).** The seal-time path passes `prose: true`; the structured `error` / `prompt failed` paths do not. In prose mode the text must additionally *lead with* an error-shaped token (`Error:`, `API Error 429`, `unauthorized: …`, a leading HTTP status, a leading `snake_case` code, etc.) via `leadsWithErrorShape()`. A keyword anywhere mid-sentence is not enough — conversational prose leads with ordinary words (`I added …`, `**BUILD SUCCESS — 55 tests passed** … (401 paths + success)`), so it is never rewritten. Only leading punctuation/markdown is stripped before the head check, never letters of any script, so a Thai-leading message is not chopped down to a stray status number. The structured paths skip this gate because those strings are already known to be failures and may not open with an error token.

Recommended user-facing copy:

| Category | Headline | Retryable | Hint |
|----------|----------|-----------|------|
| `rate_limit` | Provider rate limit reached | true | Wait briefly, retry, or reduce request frequency. |
| `quota` | Provider quota exhausted | false | Check account quota, billing, or usage limits. |
| `auth` | Provider authentication failed | false | Re-authenticate the backend outside Krypton, then restart the lane. |
| `context` | Request exceeded model context | false | Start a fresh session or send a smaller prompt/context. |
| `network` | Provider network request failed | true | Retry when connectivity or provider availability recovers. |
| `provider` | Provider service error | true | Retry later; the provider returned a temporary service error. |
| `unknown` | Agent request failed | true | Inspect details before retrying. |

### Data Flow

```
1. Adapter sends provider failure as `agent_message_chunk`.
2. `AcpClient.handleRaw()` maps it to `message_chunk`.
3. Harness appends it as a streaming assistant row while chunks arrive.
4. A stop/tool/permission/error event calls `sealStreaming(lane)`.
5. `sealStreaming()` captures the just-sealed assistant item and calls `classifyProviderError(item.text, { prose: true })` (prose gate on — the row must lead with an error shape).
6. If classification returns null, existing assistant markdown sealing continues unchanged.
7. If classification returns a payload:
   - clear assistant markdown caches for that row,
   - set `item.kind = 'provider_error'`,
   - set `item.providerError = payload`,
   - set `item.text = payload.headline`,
   - apply the retryable-aware lane-status decision (see **Lane status & recovery** below),
   - clear turn timing/extraction state if the turn is still active.
8. Renderer uses `renderProviderErrorBody()` and never passes `payload.raw` through markdown.
```

For structured `AcpEvent { type: 'error' }`, the initial implementation may also classify `event.message`. Classified provider errors append a `provider_error` row; unclassified errors keep the existing `system` row.

### UI Changes

Render `provider_error` as a compact transcript card:

```text
AGENT LIMIT HIT
Provider rate limit reached
Wait briefly, retry, or reduce request frequency.

Details ▸ Error: T: resource_exhausted] Error
```

DOM shape:

```html
<div class="acp-harness__msg acp-harness__msg--provider_error">
  <div class="acp-harness__msg-label">agent</div>
  <div class="acp-harness__msg-body acp-harness__provider-error acp-harness__provider-error--rate_limit">
    <div class="acp-harness__provider-error-kicker">agent limit hit</div>
    <div class="acp-harness__provider-error-headline">Provider rate limit reached</div>
    <div class="acp-harness__provider-error-hint">Wait briefly, retry, or reduce request frequency.</div>
    <details class="acp-harness__provider-error-details">
      <summary>details</summary>
      <pre>Error: T: resource_exhausted] Error</pre>
    </details>
  </div>
</div>
```

The label remains `agent` so the row is visually associated with the failed agent turn, but the body styling makes it clearly non-prose. Category colors should reuse existing theme variables and avoid `backdrop-filter`.

### Lane status & recovery

A provider fault is classified over a **live** session — a classified `provider_error` (whether it arrived as a sealed assistant row, a typed `provider_error` event, or a rejected `session/prompt` call, e.g. `-32603 "API Error: Overloaded"`) means the agent subprocess answered; only the request failed, not the process. `lane.error` is the **single source of truth for the terminal status**, and the choke point `markLaneProviderError()` sets it by the payload's `retryable` flag:

- **Retryable** (`rate_limit`, `network`, `provider`, `unknown`) → `lane.error = null`, lane returns to **`idle`**. The RETRYABLE card still renders, but the lane stays usable so the user can resend the same prompt in the same session. This avoids stranding the composer (which refuses input on an errored lane) and forcing a lane restart that discards all session context.
- **Non-retryable** (`auth`, `quota`, `context`) → `lane.error = payload.headline`, lane goes to **`error`**. Resending cannot succeed; the card's hint tells the user what to fix, and recovery is a restart.

**Who performs the status transition** matters, because `setLaneStatus(idle)` can synchronously drain queued peer mail (re-entrantly starting the next turn):

- The **seal-time** conversion (`convertAssistantRowToProviderError`) runs inside `finishTurn()`'s `sealStreaming()` — *before* `finishTurn` resets the turn pointers and performs its single status transition. It therefore calls `markLaneProviderError(..., { deferStatus: true })`: it sets `lane.error` only and does **not** transition. `finishTurn()` then owns the one correctly-ordered transition (it reads `lane.error`: null → `idle`/coordinator-suggested; set → `error`). Transitioning during the seal would race that cleanup and get clobbered.
- The **`sendUserPrompt` catch** (a rejected `session/prompt`) has no following stop event, so it transitions directly: classified faults route through `appendProviderError → markLaneProviderError` (non-deferred). An **unclassifiable** rejection is treated as genuine transport/subprocess death — it flips the lane to `error` with the raw message (restart-only recovery). If the lane recovered to `idle`, the catch drains one queued prompt (mirroring `finishTurn`).

### API / Commands

No new Tauri command in phase 1.

Optional future Rust/frontend event:

```json
{
  "type": "provider_error",
  "payload": {
    "category": "rate_limit",
    "code": "resource_exhausted",
    "headline": "Provider rate limit reached",
    "hint": "Wait briefly, retry, or reduce request frequency.",
    "retryable": true,
    "raw": "Error: T: resource_exhausted] Error"
  }
}
```

> **Contract:** a typed `provider_error` event MUST be **terminal for its turn** — an adapter may not emit further turn events after it. The handler transitions the lane immediately (a retryable one to `idle`, making the lane promptable again), so a non-terminal `provider_error` followed by more streaming would let the user submit into a turn the adapter still considers live. Adapters that can recover mid-turn must instead surface the fault as assistant text (caught by the seal-time classifier) or defer it to the `stop`/`error` event.

### Keybindings

No new keybinding in phase 1.

A retryable provider fault now leaves the lane **`idle`** (see **Lane status & recovery**), so "retry" is simply resending the prompt through the normal composer — no dedicated keybinding is required. Future work may still add an `r` / command-palette shortcut that replays the last prompt for the focused retryable row (storing a safe `lastSubmittedPrompt` payload); that convenience remains out of scope for this spec.

## Edge Cases

- **Chunk-boundary split**: classify only after seal, so split chunks reconstruct before matching.
- **False positive prose**: long text or multi-paragraph assistant explanations are not rewritten unless they contain strong provider/API markers near the start.
- **Provider error after partial useful response**: if the assistant row is long and mixed, do not rewrite it. Append a separate provider-error row only if a structured `error` event arrives.
- **Existing markdown cache**: when rewriting an assistant row, clear `markdownSource`, `markdownHtml`, `streamPlainLength`, and `streamingMarkdownWritten`.
- **Thought rows**: do not classify `thought` rows in phase 1.
- **System startup errors**: keep existing startup hint handling; this spec targets prompt-time provider/API failures.
- **Provider raw text contains HTML/markdown**: render raw details with `textContent` inside `<pre>`, never `innerHTML`.
- **Repeated identical failures**: render each failed turn separately. Coalescing would hide when retries were attempted.
- **Lane peek / rail**: `lane.error` stores only the headline so rail summaries remain short. A retryable fault clears `lane.error` (the lane is idle, not broken), so it produces no rail error summary — the transcript card is the only trace.
- **Non-harness ACP view**: out of scope for phase 1; implementation may share classifier helpers so `acp-view.ts` can adopt the same UI later.

## Open Questions

None.

## Out of Scope

- Retrying the last prompt.
- Automatic exponential backoff.
- Backend buffering/classification of `agent_message_chunk`.
- Upstream adapter changes to emit protocol-native provider errors.
- Single-lane `AcpView` provider-error UI.
- Quota dashboards, billing links, or provider account integration.

## Resources

- [OpenAI API rate limits](https://platform.openai.com/docs/guides/rate-limits) — informed retryable rate-limit handling and backoff guidance.
- [Anthropic API errors](https://anthropic.mintlify.app/en/api/errors) — informed provider error taxonomy, including rate-limit and overload classes.
- [GitHub Copilot rate-limit handling guide](https://docs.github.com/en/copilot/tutorials/copilot-chat-cookbook/debugging-errors/handling-api-rate-limits) — confirmed retry-after-delay as a common agent UX for limit failures.
- `docs/72-acp-harness-view.md` — current harness architecture, lane lifecycle, transcript model, and memory/permission flow.
- `docs/88-acp-fs-activity-surface.md` — local precedent for adding a typed transcript item and renderer.
- `src/acp/acp-harness-view.ts` — current streaming, sealing, rendering, and lane error behavior.
- `src/acp/client.ts` — current ACP event mapping from raw Tauri events to frontend events.
- `src-tauri/src/acp.rs` — current Rust notification forwarding and startup-error hint handling.
