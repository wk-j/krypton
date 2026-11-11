# Harness Remote Command Component — Implementation Spec

> Status: Implemented
> Date: 2026-11-11
> Milestone: ACP Harness — connected computers

## Problem

Connected Computer executions currently render through generic tool sections. The requested computer, remote command, remote exit code and stdout/stderr are not presented together as a dedicated command result. MCP transport success is not the same as a successful remote exit, and an unknown remote outcome must not look like success.

## Solution

Add a `RemoteCommandCard` owned by the existing `ToolRow`, backed by a typed, bounded payload decoded before generic output compaction. A view-owned `RemoteCommandDialog` exposes the retained command, directory, result and output through the existing keyboard hint flow. Reuse the component kernel, shared chrome and material tokens; do not create a second transcript row or change command execution or approval.

Support exact built-in `computer_exec` MCP calls and recognizable direct `kryptonctl computer exec` shell invocations. Compound scripts, code cells or wrappers whose remote invocation cannot be established remain in their existing renderer; do not extract speculative cards from arbitrary JSON or text containing `computer_exec`.

## Research

- `ToolCallDecoder.decode` builds the generic draft, lets the backend adapter refine identity, and only then compacts the retained wire call. Generic output is capped to 6/12 lines before the row sees it. Capture remote input/result from the merged wire update at that boundary, not from already-rendered sections.
- `ToolView.mcp` is adapter-decoded identity; Claude invalidates it when stated metadata disagrees. Argument fields are not evidence of MCP identity. Presentation must not add or modify permission auto-allow rules.
- `ConnectedComputerManager::exec` is shared by MCP and CLI. Completed results contain `computerId`, nullable `exitCode`, `stdout`, `stderr`, `truncated` and `outcome`. The MCP route wraps JSON in a text content block; `kryptonctl` unpacks `ControlReply` and prints the result. Failed requests are text errors, not uniformly structured results.
- Unknown outcome after timeout/disconnect can be an error string with an anchored backend prefix plus a serialized result. Failure while sending input has an unknown-outcome prefix without output. Preserve this distinction; never infer remote exit from the outer shell/tool exit.
- Results do not report resolved SSH identity, effective default directory, approval policy or remote runtime duration. Display only the requested computer ID and explicit request fields; no asynchronous profile lookup or BYPASS inference from lane mode.
- `ToolRow` already owns specialised execution, job and subagent components. Its terminal transition seals the row. The OMP code-cell `ExecutionCard` and `ExecutionDialog` establish the ownership pattern but have code-cell-specific payloads; do not overload those types with SSH data.
- `src/agent/bash-risk.ts` has private risk-tokenization helpers, not a reusable complete shell parser. Do not use the risk classifier as a command parser or widen its permission semantics for this presentation feature.
- The gallery uses the production `toolPayloadFromView` builder. Remote examples must use that same path.

## Prior Art

| App | Implementation | Decision |
|---|---|---|
| Warp | A Block groups one command and its output; nonzero exits are visually distinct. `Cmd+Up` selects a block and arrows navigate blocks; long output has block navigation. | Group the command and result. Keep Krypton's existing `f` hints instead of introducing Warp's shortcuts. |
| Krypton Execution Inspector | Compact execution summary opens a view-owned overlay; retained output and source do not expand a sealed row. | Reuse this ownership and navigation pattern, not the OMP payload. |

**Krypton delta:** an SSH computer ID is explicit, output streams stay separate, and transport failure or an unknown outcome never becomes a successful remote exit. No Warp-style red background/sidebar or extra nested card frame.

## Affected Files

| File | Change |
|---|---|
| `src/acp/adapters/remote-command.ts` (new), `src/acp/adapters/tool.ts`, `src/acp/adapters/types.ts` | Pure recognition/normalization, bounded immutable payload, merge preservation and exact identity checks. |
| `src/acp/harness-view-types.ts`, `src/acp/harness-transcript-items.ts` | Typed remote payload and open target; shared production item projection. |
| `src/acp/components/remote-command-card/` (new), `src/acp/components/remote-command-dialog/` (new), `src/acp/components/tool-row/index.ts`, `src/acp/components/registry.ts` | Component classes, owned layered styles, lifecycle and disposal. |
| `src/acp/acp-harness-view.ts` | View-owned detail overlay and delegated action/keyboard hint routing. |
| `src/loopback/surfaces/harness/examples/tools.ts`, `src/loopback/surfaces/harness/build.ts`, `src/loopback/surfaces/harness/stage.ts` | Gallery examples through the same item builder; a gallery-owned detail overlay outside preview rows. |
| Focused decoder/component/integration/gallery tests; `docs/0302-harness-component-catalog.md`, `docs/0311-connected-computer-commands.md`, `docs/0381-harness-component-gallery.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/README.md` | Contract, catalog, data flow, examples and index. |

## Design

### Canonical Data

Define the payload alongside the existing transcript payload types and expose `remoteCommand?: RemoteCommandPayload` on both `ToolView` and `ToolPayload`:

```ts
interface RemoteCommandPayload {
  readonly source: 'mcp' | 'cli';
  readonly computerId: string;
  readonly command: string;               // requested remote command, not a local wrapper
  readonly cwd: string | null;           // explicit request only; null = not reported
  readonly result: null | {
    readonly exitCode: number | null;
    readonly outcome: 'completed' | 'unknown';
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;        // backend output cap
  };
  readonly error: string | null;
  readonly outcomeUnknown: boolean;      // includes input-send failures without a result
  readonly displayTruncated: readonly ('computerId' | 'cwd' | 'command' | 'stdout' | 'stderr' | 'error')[];
}
interface RemoteCommandOpenTarget {
  remoteCommandItemId: string;
  hintLabel: string | null;
}
```

No new Rust event, HTTP endpoint, MCP argument, execution registry or profile setting. Extend the existing hint target collection with a distinct remote-command target rather than treating SSH data as an OMP code cell.

### Recognition and Merge

1. Run normalization after the lane adapter has cross-checked identity and before wire retention. For MCP, require exact `mcp.tool === 'computer_exec'` paired with one of the existing exact built-in bus/memory server names. Foreign/conflicting identity and lookalikes stay generic. A rejected MCP-qualified title never falls through to CLI recognition based on its arguments. Read input argument fields only after this identity match.
2. For CLI, recognize only one complete direct invocation beginning with `kryptonctl` or the exact quoted `"$KRYPTONCTL_PATH"`, followed by `computer exec <id>`, supported `--cwd` / `--timeout` options, `--`, and command words. A small display-only lexer must consume all input, honour POSIX single/double quotes and escapes, preserve empty quoted words, reject unclosed quotes, shell operators, redirection, substitutions or expansions other than that exact executable token. Mirror `run()`'s removal of the first exact `--json` argument and then the first exact `--yes` argument anywhere in argv, before `computer_command` parses options; join the remaining command words after `--` with spaces, just as the CLI does. This can change the requested command from the shell's original spelling; show the request actually sent, not a verbatim slice of the local wrapper. Do not reuse this recognizer for approval or execute anything it parses. Other executable paths and wrapper forms remain generic.
3. Accept a completed result only after validating the complete result schema and equality of the result's `computerId` with the recognized request. Examine known top-level raw-output or MCP content text envelopes and the CLI's production `_meta.terminal_output` channel; no recursive search for a plausible object. Claude's whole response and Codex's appended chunks are captured before the generic terminal preview cap. Conflicting/malformed/partial JSON does not clear valid prior state or fabricate success.
4. Handle the exact backend unknown-outcome error prefixes only for a recognized remote call. For CLI errors, first strip the exact `kryptonctl: computer_exec_failed: ` wrapper emitted by the CLI; never search arbitrary output for an embedded prefix. Validate any trailing JSON result using the same schema. Other text errors stay errors without claiming the remote process did or did not run. The exact `Remote command declined or approval expired` error may say `Not run`; do not claim which of those two causes occurred.
5. Preserve the same payload reference for status-only or no-op updates. Return a fresh immutable payload when a rendered field changes; do not mutate arrays or objects that dependency tuples compare by identity. Keep a previously captured request when later updates omit it. Explicit contradictory identity removes specialization and falls back to the generic row.
6. Bound retained command to 16 KiB, computer ID and directory to 1 KiB each, each output stream to 16 KiB, and error to 4 KiB before storing it. Cap on UTF-8 boundaries and mark UI truncation separately from the backend `truncated` flag. Compare request/result IDs before bounding. Decode before wire compaction; never parse truncated generic preview text as if it were a complete result.

Keep the original computer ID privately for exact request/result matching across compaction, capped at 16 KiB UTF-8. An ID above that internal cap stays generic; the displayed ID still caps at 1 KiB. Do not replace exact equality with a hash or retain an unbounded original.

CLI terminal chunks use a private per-payload capture, bounded to 4M UTF-16 units, sufficient for the backend's two 256 KiB streams even when JSON-escaped. It is not an execution registry or a second event bus. Release the capture after a validated result/error; overflow stays undecodable with ordinary diagnostics, never a guessed exit. A terminal-exit update settles pending plain diagnostics but supplies only the outer shell exit, not the remote exit. Status-only frames preserve an already decoded result without reparsing its compacted preview.

### State Rules

- Pending/in-progress without a result: `Pending` / `In progress`, not a claim that SSH has started; the approval wait is part of that call.
- Structured `outcome: 'unknown'` or an exact unknown-outcome error: `Outcome unknown`, regardless of outer success status or an included exit value.
- Completed result with exit 0: `Done · exit 0`; nonzero: `Failed · exit N`; null: `Completed · exit not reported`.
- Terminal failed/canceled tool without conclusive remote result: `Tool failed` / `Cancelled · remote outcome unconfirmed`. Missing remote exit is never zero.
- Transport/tool failure outranks a prior success snapshot on a contradictory final update. A stale in-progress frame must not reopen a settled card.

### Summary Component

`RemoteCommandCard extends Component<RemoteCommandCardProps>`; props carry payload, tool status, existing observed start/end times and hint label. `ToolRow` owns and disposes it, just as it owns `ExecutionCard`. It replaces the generic header/output for a recognized remote call; there is no additional duplicate row or JSON dump. Artifact redaction and existing subagent/code-cell ownership retain precedence.

Both component prop shapes also accept optional retained generic `diagnostics`, separate from remote stdout/stderr. Malformed JSON without an explicit tool-error signal remains a diagnostic, not a newly inferred command failure. The card previews it within the same four-line budget; Result exposes the retained diagnostic in Details.

Show a compact REMOTE readout, computer ID, state/exit and a one-line command preview. Keep command width flexible (`minmax(0, 1fr)`); bound the computer ID to `min(14ch, 25%)`, state/exit to 18ch and action to its one-line button. Use ellipsis and a full-value title; the detail view exposes complete retained values to keyboard users. At narrow widths move metadata to a second line rather than squeeze away the command. No new capsule group, frame, glow or animation.

Show up to four output-preview lines total, prioritising stderr for failures, plus a plain truncation/extra-output note. Use existing cell-grid rendering and text nodes; never render command output as HTML. Preserve significant whitespace. Empty stdout/stderr is a valid result, not a missing card. Observed call time may use the existing shared ticker, labelled as call elapsed rather than remote execution duration; replay without timing shows none.

### Detail Component and Keys

`AcpHarnessView` owns one `RemoteCommandDialog` assembled from `OverlayShell`, `TabStrip`, `KeyHintBar` and cell-grid output. It is never mounted inside a transcript row. Sections: **Command** (computer ID, requested command, explicit cwd or `Not reported`), **Output** (separate stdout/stderr), **Result** (remote exit/outcome, error, output-limit notes).

The existing `f` hint flow opens Details for a remote card; clicking its one-line **Details** button does the same. Inside the overlay, `Tab` / `Shift+Tab` switch sections and `Esc` closes with existing focus restoration. Arrow keys scroll the active panel on both axes; PageUp/PageDown scroll a page and Home/End go to its vertical ends, so long retained values are keyboard-accessible without tabbing into the panel. Shift-selection, existing text selection and Cmd/Ctrl copy remain native. No retry, rerun, approval, disconnect or bypass control is added.

Updating/opening/closing Details updates only its owning component. On row removal, lane replacement or view disposal, close it without taking focus. Terminal card settlement uses the existing `LiveComponent.seal()` path; a late result from replay updates the owning card/dialog, never reconstructs the sealed row. Repeated updates preserve node identity and scroll position. No polling, filesystem read, extra timer or global repaint is introduced.

### Gallery and Verification

Add production-builder examples for pending, approval-in-progress, exit 0, nonzero with stderr, empty output, missing exit, declined/expired, unknown with partial output, unknown without output, transport failure, cancellation, backend truncation, UI truncation, long computer/command and narrow/light/dark layouts. Include both recognized MCP and direct CLI data.

During implementation, run focused decoder tests for exact identity and foreign/lookalike/conflicting metadata; supported CLI quoting/empty words and rejected compound scripts; complete/malformed/partial result envelopes; remote-versus-outer exit; unknown precedence; retained request/payload identity and late terminal updates. Component/integration tests cover the visible state transitions, whitespace and stream separation, limit notes, sealed-row stability, Details keyboard handling, node/scroll preservation and disposal. No source-text or copy/wiring-only assertions.

The browser gallery owns its own dialog outside the preview row DOM and delegates Details clicks to that same production dialog. Close/dispose it on entry changes and stage disposal. Gallery controls must actually open readable details, not merely paint a decorative Details button. React owns only the existing Island host, not the component nodes.

Verify actual production components in the browser gallery: both summary and detail, narrow and wide, light and dark, including long metadata. Run frontend type check and CSS-ownership coverage after integration. Use a temporary script to exercise normalization through the production item builder and real card; no SSH execution is needed for this presentation-only change. Report that browser fixtures do not prove live SSH transport.

## Edge Cases

- The requested command can differ from the re-quoted script used for read-only auto-approval (spec 318); label it requested command. Effective defaults, resolved SSH target and actual approval policy are not supplied and must not be invented.
- A shell tool can call more than one command or wrap `kryptonctl` in a script. Keep that whole tool in its existing renderer rather than associate unrelated output with a made-up remote invocation.
- Rendering CLI result data grants no authority; approval remains solely in Rust under specs 311/318/385. No card is permission evidence.
- A result belonging to another computer, unrelated JSON with the same field names, or an unrecognized executable stays generic. A recognized call whose result cannot be decoded retains a generic diagnostic section, not a blank detail panel or fabricated success.
- Output truncation does not mean the remote command failed. Unknown outcome does not mean the remote command stopped; detached remote processes may survive.

## Open Questions

None. The user approved the drafted scope on 2026-11-11, including generic fallback for indirect scripts and no new backend lifecycle bus.

## Out of Scope

Changing remote execution/approval, Rust/HTTP/MCP schemas, arbitrary shell parsing, detecting calls hidden inside code cells/scripts, live PTY output streaming, remote profiles lookup, raw-output export, retry/rerun controls or redesigning OMP's Execution Inspector.

## Resources

- [Warp — Terminal Block Basics](https://docs.warp.dev/terminal/blocks/block-basics.md) — command/output grouping, exit-state distinction and keyboard navigation.
- [Harness UI Components](./0301-harness-ui-components.md), [Component Catalog](./0302-harness-component-catalog.md) — component ownership, dependency and seal invariants.
- [Harness Component Gallery](./0381-harness-component-gallery.md) — shared production builders and browser verification.
- [Connected Computer Commands](./0311-connected-computer-commands.md), [Read-Only Auto-Approval](./0318-connected-computer-read-only-auto-approval.md), [Command Bypass](./0385-connected-computer-command-bypass.md) — unchanged backend contracts.

## Implementation Verification — 2026-11-11

- Focused adapter, component, Harness integration, gallery, CSS-ownership and tool-trim suites: 254 tests across 12 files passed, including scoped reruns after corrections. Frontend `npm run check` passed.
- Production gallery checked in Chromium at wide/narrow sizes and light/dark schemes: bounded metadata, readable Details, separate streams, unknown outcome, malformed-result diagnostics, keyboard navigation/scrolling and native copy handling.
- A temporary browser fixture fed real Codex terminal chunks through `createLaneDecoder`, the production item builder, `ToolRow` and Details. A response larger than the generic 16 KiB terminal preview retained remote exit 7 separately from shell exit 0, preserved significant whitespace and reported UI truncation.
- The generic tool-row trim regression was reproduced and checked at 1120px and 480px: one header row, no added soft-wraps, preserved source lines/whitespace and unchanged column-grid alignment.
- Temporary fixtures/services were removed. No live SSH command, installed Tauri app, native WKWebView validation, build or installation was performed for this presentation change.
