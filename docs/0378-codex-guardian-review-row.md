# Codex Guardian Review Row — Implementation Spec

> Status: Implemented (approved 2026-11-10: "Let implement")
> Date: 2026-11-10
> Milestone: Krypton Console — transcript clarity
> Builds on: 301/302 (Harness components), 366 (faceplate UI), 371 (notice rows)

## Problem

In a Codex lane, an automatic Guardian assessment appears as a generic `TOOL · THINK Guardian Review` row. Its `Status`, `Action`, `Risk`, `Authorization`, and `Rationale` arrive as a text dump in an output well. Repeated assessments consume much of the transcript and make a denial hard to distinguish from an approval at a glance.

## Solution

Recognize the adapter's Guardian tool-call identity and derive a bounded, typed display payload before generic output trimming. Render it in a dedicated flat transcript row: a status legend and action on the first line, risk and authorization as small readouts, and the rationale as wrapping text. Keep the same ACP call and its updates; this is presentation only, with no change to approval routing or decisions.

## Research

- `codex-acp` reports Guardian reviews as `toolCallId: guardian_assessment:<reviewId>`, `kind: think`, `title: "Guardian Review"`. The initial event has the Codex review in `rawInput`; a later report has it in `rawOutput`. For non-AIR clients, `content` is one text block with the five labelled fields. The sample wire trace includes an `in_progress` start and a `completed` update on the same id. Codex's source enum also includes `timed_out` and `aborted`, so these must not be folded into `denied`.
- ACP `tool_call_update` may omit every field except `toolCallId`. Krypton's `mergeToolCall()` carries earlier fields forward. `renderTool()` builds a display payload before `compactToolCallForRetention()`, so it is the right place to extract the assessment. A completion can report `status: completed` while the review itself says `denied`; the row must read the review outcome, not infer approval from tool completion.
- Today `buildToolPayload()` limits a non-execute section to six lines and `ToolRow` paints it as an output `<pre>`. A generic tool's title becomes its subject, creating the `THINK Guardian Review` line in the screenshot.
- The component kernel maps one keyed transcript item to one row instance. An initial Guardian payload is needed even before an outcome arrives so the row class does not change mid-call. Terminal rows seal through `LiveComponent.seal()` and never repaint afterward.
- DESIGN.md requires flat ink in transcript rows, a status LED before its legend, and no shadow, gradient, or box fill on a repeated row. ADR-0017 reserves strong colour for a fault or a demand for human action.
- Alternative: parse the displayed `<pre>` in `ToolRow`. This leaves the generic title and output layout in place, loses rationale lines after the six-line limit, and makes a second presentation path within a generic row. A dedicated row gives the assessment one bounded data contract.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| VS Code Chat | Its auto approval status moved from inline chat text to the tool call's status/tick icon; the explanation remains available on hover. | Outcome should be scannable without repeating the entire labelled dump. |
| JetBrains AIR | Its published Codex Guardian issue shows the `guardian_assessment:` ACP events and asks for a chat representation of `THINK` updates. | Confirms the same wire shape is a presentation concern across ACP clients. |
| Krypton notice rows | Source label, flat action legend, optional LED, and wrapping subject. | Provides the transcript's visual grammar, without treating Guardian as a Harness notice. |

**Krypton delta:** The rationale stays readable in the transcript because a hover-only explanation is hard to reach with a keyboard. The row uses the existing transcript scrolling keys; it adds no action or focus target.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-guardian-review.ts` (new) | Exact identity check, guarded extraction, bounds, and status mapping. |
| `src/acp/harness-view-types.ts` | Add `GuardianReviewPayload` to `ToolPayload`. |
| `src/acp/acp-harness-view.ts` | Derive the Guardian payload before wire compaction; set a meaningful portable `item.text`. |
| `src/acp/harness-tool-retention.ts` | Preserve known Guardian fields across partial updates. |
| `src/acp/components/guardian-review-row/` (new) | Row class, layered stylesheet, and focused DOM tests. |
| `src/acp/components/transcript/rows.ts` and `src/acp/components/registry.ts` | Dispatch and register the new row. |
| `src/acp/harness-tool-render.test.ts` or a new parser test | Start/completion, denial, malformed and partial-update cases. |
| `docs/0302-harness-component-catalog.md`, `docs/0005-data-flow.md`, `docs/README.md` | Document the component and the observed presentation flow. |

## Design

### Data contract

```ts
type GuardianOutcome = 'reviewing' | 'approved' | 'denied' | 'timed_out' | 'aborted' | 'failed' | 'unavailable';

interface GuardianReviewPayload {
  readonly outcome: GuardianOutcome;
  readonly action: string;
  readonly risk: string | null;
  readonly authorization: string | null;
  readonly rationale: string | null;
  readonly rationaleTruncated: boolean;
}

// Added to ToolPayload:
guardianReview?: GuardianReviewPayload;
```

`isCodexGuardianReview(backendId, call)` requires `backendId === 'codex'`, the `guardian_assessment:` id prefix, `kind === 'think'`, and the exact title `Guardian Review` after the existing partial-call merge. This is a display classifier, never a permission identity. A matching start always gets a payload, even if only `reviewing` and `Action unavailable` are known.

`parseGuardianReview(call, previous, acpStatus)` reads `review.status`, `riskLevel`, `userAuthorization`, and `rationale` from guarded objects with this precedence: latest `rawOutput.review`, labelled `content` text, initial `rawInput.review`, then the previous display payload. The content parser matches only line-leading `Status:`, `Action:`, `Risk:`, `Authorization:`, and `Rationale:` (case-insensitive); continuation lines belong to `Rationale` until another recognised label. Read the action from `Action:`. Map structured `inProgress`/`in_progress` to `reviewing` and `timedOut`/`timed_out` to `timed_out`. Unknown object shapes and unknown enum strings are not guessed. On a terminal ACP call, a stale `inProgress` from the initial event is not a result: use `failed` if ACP failed and `unavailable` otherwise. Preserve previous non-empty action and assessment fields when a later update omits them. Clamp the displayed action to 240 characters and rationale to 4,096 characters, adding a visible truncation marker. Store only this bounded payload in the transcript item.

### Data flow

1. Rust forwards the Codex adapter's `tool_call` / `tool_call_update` unchanged as ACP events.
2. `renderTool()` merges the partial call, builds the ordinary `ToolPayload`, and adds `guardianReview` for the exact Codex identity before compacting the wire payload.
3. It keeps the same transcript item id and emits portable `item.text` as `Guardian review: <outcome> — <action>` for text-only readers.
4. `rowKindFor()` routes a tool item with `guardianReview` to `GuardianReviewRow` before the generic `ToolRow` branch. `Transcript` keeps that row instance for later updates.
5. The row patches its own bounded fields while live and seals at the terminal ACP status. Sealing triggers no transcript render.

### UI

```text
 GUARD  · APPROVED  MCP lesson_record on krypton-harness-memory
        risk medium  ·  authorization high
        The user correction and lane instructions authorize this update.

     │  ● DENIED  exec outside workspace
        risk high  ·  authorization unknown
        The requested path is outside the authorized workspace.
```

- Shared transcript chrome remains: the first `GUARD` label in a consecutive run uses theme magenta; later Guardian rows show a neutral connector in the label gutter (spec 379). The body stays aligned with every other row. The label distinguishes this source from amber `AGENT` and blue `TOOL`; it does not encode the review result. The first line shows a flat outcome legend followed by the action and wraps at narrow widths without clipping. A steady amber LED marks an active review; a fault LED marks `denied`, `timed_out`, or `failed`. `approved`, `aborted`, and `unavailable` use neutral ink without an LED. No card, output well, coloured outline, or animated pulse.
- The second line appears only for fields actually reported. Risk and authorization are small, legible readouts; `unknown` is shown only when Codex sent that value.
- The rationale is a wrapping text line under the action, never a `<pre>` or a one-line ellipsis. `unavailable` says `Review outcome unavailable`; it does not invent a rationale. Long text is bounded with `… truncated`.
- No new keybinding: this row is read-only and has no control. Existing transcript navigation and scrolling reach all of its content.
- `GuardianReviewRow.readDeps()` includes `[acpStatus, outcome, action, risk, authorization, rationale, rationaleTruncated]` plus the base row's wrapper/image dependencies. It updates the same nodes during progress and uses `seal()` for the only live-to-static transition.

## Edge Cases and Verification

- `completed` ACP status with review `denied` paints `DENIED`, and does not present a human approval button. A Guardian denial is Codex's decision; Krypton only reports it.
- A malformed or missing outcome paints `REVIEW OUTCOME UNAVAILABLE` on a terminal call. A timed-out review paints `TIMED OUT`; an aborted review paints `ABORTED`. A normal Codex `think` call and another backend's similarly titled call remain generic tool rows.
- A status-only update retains the action, risk, authorization, and rationale. A terminal update that omits the review outcome must not leave the row showing `REVIEWING`.
- Tests use adapter-shaped initial and completion events, including long and multiline rationale, missing fields, denial, failure, and the exact identity boundary. DOM tests assert stable row/node identity during updates and no mutations after sealing. CSS ownership and frontend type-check/build gates run after implementation. A native dark/light smoke check remains for the next app run.

## Open Questions

None.

## Out of Scope

- Changing Codex Guardian policy, authorizing or retrying an action, or adding a manual override.
- Changing other `think` tools, other backends, Live Assist layout, or approval history storage.
- Collapsing the rationale or adding a details interaction.

## Implementation Notes

- `npm run check` and `npm run build` passed. Focused Harness/view/component tests passed (366), as did the tool-retention/render tests (84).
- Native dark/light layout was not inspected in this run; the implementation was verified through source, DOM tests, CSS ownership tests, and the frontend build.

## Resources

- [codex-acp AIR extension wire contract](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/air-extensions.md) — exact Guardian tool id, kind, title, and content/raw fields for standard clients.
- [Codex Guardian assessment protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/approvals.rs) — assessment statuses and structured fields.
- [ACP v1 Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls) — partial update and status semantics.
- [JetBrains AIR-7075](https://youtrack.jetbrains.com/issue/AIR-7075) — adapter-shaped start and completion events, and the chat representation request.
- [VS Code 1.106 release notes](https://code.visualstudio.com/updates/v1_106) — compact auto approval status on the tool indicator.
