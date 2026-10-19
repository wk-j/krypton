# ACP Harness `#ui` Preflight and Repair — Implementation Spec

> Status: Implemented (2026-10-19)
> Date: 2026-10-19
> Milestone: ACP Harness

## Problem

`#ui` teaches an ACP lane the `krypton-ui` language, but an invalid reply reaches the transcript before the host compiler reports its diagnostic. The user sees `UI unavailable` and source instead of the requested interactive panel. Prompt wording alone cannot guarantee that an LLM emits valid syntax.

## Solution

For a `#ui` command, stage assistant output in the Harness until the turn ends. Check the complete reply with the existing `compile()` function before adding it to the transcript or control stream. If a UI fence fails, give the same lane compiler diagnostics and at most two automatic repair turns. Release a valid reply once; after the repair budget, show one bounded failure with the source and diagnostic. Transport failures keep their existing error handling. Ordinary assistant replies retain today's seal-time validation and fail-closed rendering.

## Research

- `runHashCommand` calls `genUiPrompt()` through `enqueueSystemPrompt()`; the lane receives one-shot catalog guidance. The prompt permits exactly one `krypton-ui` fence **or** prose without a fence. No permanent MCP checker is registered, preserving spec 309's zero standing instruction cost.
- `compile()` in `src/acp/genui/compile.ts` enforces the 20,000-character source cap and runs parser plus catalog validation. `decorateUiFences()` currently invokes it only when `AssistantRow` seals, then shows `UI unavailable` for an error. The live strip hides a well-formed fence's source during streaming, but malformed fence markers can still leak source.
- `onLaneEvent()` publishes raw `message_chunk` to the control SSE stream before local rendering. Live Assist consumes that stream and also refreshes from `lane.transcript`. A transcript-only gate would therefore still expose an invalid draft elsewhere.
- `finishTurn()` can synchronously drain peer mail when it sets a lane idle; a repair must reserve the same lane before that transition. It also records usage and resets permission/turn state, which must happen for every attempt.
- The existing evaluator catches runtime faults per component and file-backed data is resolved when a panel opens. This feature checks reply structure and compile-time syntax/catalog validity; it cannot promise every data file exists or every interactive input will evaluate without a node-level diagnostic.
- [A2UI protocol](https://github.com/a2ui-project/a2ui/blob/main/specification/v1_0/docs/a2ui_protocol.md) explicitly describes prompt → generate → validate, then returning validation errors to the model for correction before rendering. Krypton can use that loop with its existing DSL compiler and ACP session rather than adopting A2UI's JSON transport.

### Alternatives considered

| Approach | Decision |
|---|---|
| Add a stronger “check syntax” sentence to `genUiPrompt()` | Insufficient: the model can still make the same mistake and the host learns of it only at seal. |
| Register a permanent `ui_check` MCP tool or require a local CLI command | Reject: permanent tool text violates spec 309's standing-cost rule; external/remote ACP lanes may not have this repo or CLI. |
| Let the renderer show the error, then repair in another visible row | Reject: the invalid answer has already been served and a sealed row must not be repainted. |
| Stage only `#ui` replies, preflight, then repair in the same session | Chosen: the host uses the exact renderer compiler and can publish only a final accepted outcome. |

## Prior Art

| App / protocol | Relevant behavior | Krypton choice |
|---|---|---|
| A2UI | Validates generated messages against the negotiated schema; validation errors can be sent to the agent for self-correction. | Reuse the validation-feedback loop, with `compile()` as the authority. |
| BB Gen UI | Validates its `ui` language in the host and reports diagnostics around rendering. | Keep a host-side compiler; add a bounded correction step before publication. |
| Krypton today | Compiles `krypton-ui` at row seal and preserves invalid source with a diagnostic. | Keep that fallback after repair is exhausted and for replies outside `#ui`. |

## Affected Files

| File | Change |
|---|---|
| `src/acp/genui/preflight.ts` and focused tests | Pure extraction/validation of a complete `#ui` reply; distinguish prose, one valid fence, and a diagnostic. |
| `src/acp/harness-prompts.ts` and tests | Build a repair prompt by reusing the generated catalog guidance and adding bounded compiler diagnostics; request one corrected fence or a brief prose explanation if a UI cannot be built. |
| `src/acp/acp-harness-view.ts` and focused Harness tests | Stage `#ui` output, run the gate at final stop, reserve/dispatch repair, release/fail once, clear state on cancel/reset/close. |
| `onLaneEvent()` publishing seam | Keep staged assistant chunks and intermediate stops out of SSE; trigger an authoritative snapshot after the final transcript result. |
| `docs/0309-harness-genui-catalog.md`, `docs/0310-harness-genui-inline-panel.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/README.md` | Update the complete `#ui` behavior contract, flow, and index after implementation. |

## Design

### State and APIs

```ts
type UiPreflight =
  | { kind: 'prose' }
  | { kind: 'valid'; source: string }
  | { kind: 'invalid'; diagnostics: readonly string[] };

interface UiGeneration {
  readonly spawnEpoch: number;
  readonly intent: string;
  attempt: number;                 // 0 = initial turn; 1–2 = repair turns
  segments: string[];              // top-level assistant text, in ACP order
  sourceChars: number;
  formatError: string | null;       // overflow or a non-text assistant block
  segmentOpen: boolean;
  messageId: string | null;
}

function preflightUiReply(text: string): UiPreflight;
function genUiRepairPrompt(intent: string, diagnostics: readonly string[]): string;
```

The view owns one `UiGeneration` per lane. It arms only after `#ui` passes the existing lane/client checks. It is tied to `spawnEpoch` so late events from a restarted adapter cannot publish an old attempt. Each new attempt clears only its staged segments and count; the original intent and attempt counter remain.

### Validation contract

1. Accept nonempty plain prose if it contains no fenced block, matching the current `#ui` opt-out. A fenced block must use exactly one complete top-level ` ```krypton-ui ` fence; wrong language, extra fence, missing closer, or an empty body is a format diagnostic. Inline backticks in prose are unaffected.
2. Extract the exact body, call `compile(source)`, and accept only a non-null program with no error-severity diagnostic. The 20,000-character source cap and catalog rules remain owned by `compile()`; the gate does not reimplement them.
3. Cap staged assistant text at 64,000 characters and 128 message segments. On overflow, stop accumulating and return a size diagnostic rather than retaining unbounded model output. A non-text assistant block is a format diagnostic and is not retained: the `krypton-ui` reply contract is text-only. A correction prompt repeats `genUiPrompt(intent)` so the catalog remains available even after context compaction, then adds at most the first three diagnostics, each capped at 240 characters. It never pastes the full invalid source back into the prompt.
4. Preflight is for the `#ui` command path only. Other `krypton-ui` fences still compile at seal and use the existing fail-closed error card.

### Turn and publication flow

1. `#ui` arms the gate, labels the lane `creating interactive UI`, then dispatches the existing catalog prompt. The user sees lane activity and can use `#cancel`; staged assistant text does not enter `lane.transcript`, Live Assist, or SSE.
2. While armed, `message_chunk` text is accumulated by message boundary; a non-text block marks the attempt invalid without retaining its payload. Tool, permission, thought and usage events continue through their existing paths. Do not call the normal assistant `appendStreaming()` or live-voice text hook for staged chunks.
3. On a normal final stop, combine the staged top-level assistant text in arrival order and run `preflightUiReply()`. On success or prose opt-out, append one **completed** assistant transcript item and let the normal cold `AssistantRow` paint compile/decorate it. Schedule its auto-expand only after that transcript commit has mounted the card; clear the gate and finish the lane turn. Mirror one final `stop` after the accepted item is in `lane.transcript`; the resulting idle `status` also prompts control clients to refresh their snapshot. Raw `message_chunk` and intermediate `stop` events are not mirrored.
4. On invalid output with attempts left, complete that attempt's usage/permission cleanup, keep the lane reserved as busy, set the label `repairing interactive UI (1/2)` or `(2/2)`, clear its staged output, and dispatch `genUiRepairPrompt()` in the same ACP session. Do this before any idle transition can drain peer mail or a queued user prompt. No invalid row or error card is sealed.
5. On a second repair failure, clear the gate and publish one final assistant failure row carrying a concise diagnostic and the last bounded source in a plain-text code fence, then take the normal idle transition. Never auto-send a third repair. On adapter error or failed repair dispatch, clear the gate and use the existing provider/transport error handling without an extra assistant row. On user cancellation, discard staged source; the existing cancellation row is the final outcome.

Every stop, including a repair attempt, still records its own usage and runs the existing turn-end hooks. The repair branch changes only the final status/drain decision. The final assistant item is never edited after `seal()`, so the sealed-row invariant holds. A stale gate is cleared on lane reset, close, Harness disposal, or `spawnEpoch` change.

### UI and configuration

No new window, panel, keybinding, TOML key, Rust command, or persistent tool. The existing busy chip shows creation/repair progress. Successful output uses the existing inline card and auto-expand behavior; the fallback uses the existing text-only diagnostic and source presentation.

## Edge Cases and Verification

- Tests: valid fence, prose opt-out, syntax/catalog error, wrong/unclosed/extra fence, source over limit, two failed repairs, correction success, cancelled/restarted lane, tool call between text segments, and independent `#ui` gates on two lanes.
- Integration tests: no staged text in transcript/SSE/Live Assist; only the accepted final item appears; peer mail and queued user prompts cannot interrupt a repair; each attempt records usage; no sealed row repaints; a valid final fence auto-expands as in spec 310.
- Run `npm run check`, focused Vitest, and `npm run build`. Native Tauri smoke should exercise `#ui` on both ACP lanes, Live Assist snapshot behavior, cancel, and keyboard focus; automated tests alone do not establish native rendering.

## Open Questions

None. The repair budget, prose opt-out, failure fallback, and staging boundary are fixed above.

## Out of Scope

- Fixing runtime errors caused by missing `Load()` files, unavailable remote paths, or later user input; existing panel diagnostics still handle these.
- Changing the DSL, component catalog, validator limits, ordinary reply rendering, or the draft-only action boundary.
- A permanent MCP validator tool, agent-side installation, or a standing policy instruction.

## Resources

- [A2UI protocol v1.0](https://github.com/a2ui-project/a2ui/blob/main/specification/v1_0/docs/a2ui_protocol.md) — validation-feedback loop before renderer delivery.
- [BB Gen UI source](https://github.com/ComicBit/bb-plugin-genui) — local reference checkout at `/Users/wk/Source/bb-plugin-genui`; host validation and diagnostics pattern. The checked-out code is the evidence; no code is copied.
- [Spec 309](./0309-harness-genui-catalog.md) and [spec 310](./0310-harness-genui-inline-panel.md) — current language, fail-closed, streaming, and sealed-row contracts.
