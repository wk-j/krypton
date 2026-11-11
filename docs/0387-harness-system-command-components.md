# Harness System Command Components — Implementation Spec

> Status: Implemented (2026-11-11)
> Date: 2026-11-11
> Milestone: ACP Harness — transcript presentation

## Problem

Harness-generated `system` transcript rows still show many command results as unstructured text under `sys`. The `#mcp` status table in the reported screenshot is one example: endpoint, per-lane counts and last activity are flattened into a single text node. Long lines wrap without a usable column structure, and status is not distinguishable at a glance.

## Solution

Interpret “all sys command” as **all system-origin transcript output in the ACP Harness**, including built-in command results, lifecycle/status lines and errors; not arbitrary PTY output or every `#` command's separate browser/overlay surface. Keep one shared `SystemRow` for short messages, and add typed, source-owned presentations for the three currently text-only multi-entry command results (`#mcp`, `#bg`, bare `#assist`). Preserve the existing typed `UsageRow`, `HarnessNotice`, directive diff and hidden-rows indicator. Unstructured system output still renders through the shared row, never through heuristic text parsing.

## Research

- `acp-harness-view.ts:12781-12812` builds `#mcp` and `#bg` as line arrays and appends one `system` item; `:12131-12140` appends one item per `#assist` task. `harness-background-tasks.ts:163-179`, `harness-assist-controller.ts:198-207` and `types.ts:240-247` expose the source data already available before formatting.
- `components/system-row/index.ts:76-123` handles plain messages, notices, events and the synthetic hidden-row indicator. It paints plain text as one node; `gridifyText()` only runs for `shell`, not `system`. `transcript/rows.ts:49-103` already routes typed usage, notices and diffs ahead of plain rows. Preserve this precedence.
- `harness-view-types.ts:144-149` and spec 371 establish the invariant: a structured payload paints the in-app UI while `item.text` remains a complete portable fallback for Live Assist, orchestrator and control API. Do not replace or remove the fallback.
- The gallery's `examples/turn.ts` already previews usage, stop and error states through the production item builder. Components live under `src/acp/components/<name>/` with owned layered styles and tests; sealed transcript rows do not repaint.
- Alternative: parse `item.text` for `mcp endpoint:` or error prefixes in the renderer. Rejected: arbitrary diagnostic text and future wording changes would become a presentation protocol. Alternative: a separate component for every lifecycle sentence. Rejected: the existing plain `SystemRow` already covers these without multiplying row kinds.

## Prior Art

| App | Implementation | Krypton choice |
|---|---|---|
| [Warp Blocks](https://docs.warp.dev/terminal/blocks/block-basics.md) | Groups each command with its output; `Cmd+Up` selects a block; nonzero commands get a red block background/sidebar. | Group related status fields in one row but retain Krypton's flat repeated-row chrome and existing transcript keyboard navigation. |
| [Zellij](https://zellij.dev/documentation/keybinding-presets.html) | Status bar shows mode-specific shortcuts; default `Ctrl+P` enters Pane mode. | Keep existing harness composer `#` palette and `f` hint conventions; do not add a new mode or shortcuts for read-only output. |

**Krypton delta:** the transcript is not a general shell block editor. Status is explicit source data, not inferred from raw terminal bytes; color marks state, not a whole repeated row.

## Affected Files

| File | Change |
|---|---|
| `src/acp/harness-view-types.ts` | Optional tagged system-command payload on `HarnessTranscriptItem`. |
| `src/acp/acp-harness-view.ts` | Attach payloads at the `#mcp`, `#bg`, and bare `#assist` producers while retaining their existing portable `text`; leave other command/lifecycle producers on the common system row. |
| `src/acp/harness-assist-controller.ts` | Expose an immutable snapshot of the task facts currently formatted by `describe()`; do not reparse its strings. |
| `src/acp/components/system-row/index.ts`, `system-row.css`, `system-row.test.ts` | Shared plain message layout and truthful error/notice presentation; preserve existing variants and indicator. |
| `src/acp/components/system-command-row/` | One typed component for the three multi-entry command presentations, with owned CSS, scheme rules and tests. |
| `src/acp/components/transcript/rows.ts`, `src/acp/components/registry.ts` | Route typed command results ahead of plain system text; register one component. |
| `src/loopback/surfaces/harness/examples/turn.ts`, gallery coverage tests | Preview `#mcp` available/unavailable, `#bg` empty/populated, `#assist` modes and plain system lines through the production row builder. |
| `docs/0302-harness-component-catalog.md`, `docs/0381-harness-component-gallery.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/README.md` | Document actual ownership and visible behavior after implementation. |

## Design

### Data Structures

```ts
type SystemCommandPayload =
  | { readonly command: 'mcp'; readonly endpoint: string | null;
      readonly warning: string | null; readonly lanes: readonly {
        readonly name: string; readonly initialized: number; readonly listed: number;
        readonly called: number; readonly lastSeenAt: number | null;
      }[] }
  | { readonly command: 'bg'; readonly capturedAt: number;
      readonly tasks: readonly {
        readonly id: string; readonly state: string; readonly startedAt: number;
        readonly endedAt: number | null; readonly bytes: number;
        readonly command: string; readonly outputPath: string;
      }[] }
  | { readonly command: 'assist'; readonly task: {
        readonly id: string; readonly mode: 'off' | 'manual' | 'auto';
        readonly summary: string; readonly pausedUntil: number | null;
      } };
// HarnessTranscriptItem.systemCommand?: SystemCommandPayload
```

Snapshot data at command execution; timestamps render against `capturedAt`/the item's `createdAt`, not a ticking current time. Payload objects are not mutated after append. Use the existing task/assist types or map to these presentation fields at the producer; no new Rust API, persisted schema or MCP tool.

### Data Flow

1. User invokes `#mcp`, `#bg`, or bare `#assist` in the existing composer.
2. The producer obtains its current snapshot, formats the *same complete text* for non-UI consumers, then attaches `systemCommand` to that transcript item. Bare `#assist` retains one row per task and attaches the corresponding task payload to each row.
3. `rowKindFor` routes `systemCommand` after usage/notices/diffs and before plain `SystemRow`; no string-content classifier. `SystemCommandRow` paints an endpoint plus a real per-lane table, task state/elapsed/output rows, or task mode/summary rows respectively. Empty/unavailable states use source facts; no fake zeros for an unavailable server.
4. Other `system` text — errors, turn/session transitions, queue/permission messages, command diagnostics, and fallback strings — stays in `SystemRow`, with multiline text preserved. Existing typed notice, usage, directive-diff and hidden indicator are unchanged.
5. Live Assist, orchestration and control API continue reading the portable `text` field. No new keyboard mode; read-only rows use existing transcript navigation. Endpoint and output paths remain selectable text, not clickable remote actions.

### UI

Keep the transcript source label `sys` for every `system` row, typed or plain. Show `MCP`, `BG`, or `ASSIST` as a small recessed command-kind readout in the body, with the same blue name ink, 6px LED cell, geometry and material as `TOOL EXECUTE`; the LED stays unlit because these are snapshots without a live execution status. The assist task ID, mode and summary remain flat text, not a second kind badge. Use semantic `<table>` headers for the MCP lane counts and task list. Tables take intrinsic content width, not `min-width: 100%`: sparse results keep adjacent columns together, while a horizontal overflow container inside the body handles narrow viewports without truncating lane names or commands. Seat each `#mcp`/`#bg` result in one `--mat-well` readout below its kind, with its endpoint, warning and “listed tools” meaning inside the same recess. No nested per-cell frames, left rail, animation or whole-row fault background; state ink follows `DESIGN.md` and both theme schemes. Errors remain actual text, not a green success state.

## Edge Cases

- MCP unavailable: no lane table or implied counts; show the existing reason and continuation note.
- MCP lane with no stats: show explicit zero counts and `—` for last activity; don't claim tools were listed.
- No background tasks: show an empty-state line; no assist tasks: keep the existing no-row result.
- Long names, Thai combining marks, narrow transcript: avoid `padEnd` as UI layout; use CSS table/grid and selectable full strings. The portable line remains unchanged for other readers.
- A command result is a point-in-time snapshot. Later stats updates never repaint a sealed row.
- Synthetic hidden indicator and existing notices/usage/diffs retain priority. Never treat a shell `!command` as a harness `system` command.

## Verification

Focused producer and row tests cover all three payload variants, unavailable/empty/narrow data, text fallback equality and unchanged precedence. Gallery coverage checks each named state. Run `npm run check` and focused Vitest; inspect actual gallery in dark/light at narrow and wide viewport. No Rust changes expected.

Verification: `npm run check` and `npm run build` passed. Focused Vitest passed: five
component/controller/gallery/style files (56 tests), then the Harness view
producer and gallery tests (361 tests). The production gallery entry was
mounted through its Vite entry in Chromium: `#mcp` and `#bg` rendered at 1200px
and 600px; the 600px MCP table scrolled inside its row (591px content in a
431px viewport) without widening the page. The temporary dev harness was
removed. An installed Krypton build and a resolved light theme were not
exercised; the gallery dev theme request had no loopback theme endpoint.

The follow-up visual check for a sparse MCP table reproduced the reported
1300px-wide column spread with `min-width: 100%`. After removing it, the
production gallery table measured 607px with a long-name fixture at a 1500px
viewport; headers remained adjacent. At 600px the same table stayed within
its 431px scroll container and page width remained 600px.

The earlier faceplate pass confirmed the `#mcp` material well and a small
`#assist` task-name badge, but mixed source and command labels. The current
layout instead keeps `sys` in the source column, places the command kind in
one recessed readout, and leaves assist task names flat. The resolved light
theme remains unverified.

The label correction passed 17 focused component/style/gallery tests and
`npm run check`. The production gallery in Chromium showed `sys` on both MCP
states and both assist states, with `MCP`/`ASSIST` command-kind readouts using
the same computed material, shadow and font size as `TOOL`'s kind. At 600px
the MCP table remained 607px wide inside a 409px scroller without widening
the 600px document; assist task names stayed flat at 1500px and 600px.

The subsequent parity correction matched computed blue ink (`rgb(74, 158, 255)`),
6px LED gap, 10.08px label type and well material against `TOOL EXECUTE`.
The snapshot LED is unlit rather than falsely indicating an in-progress tool.
Chromium gallery checks covered MCP at 1500px and 600px and assist at both
widths; the 600px page stayed 600px with the 607px MCP table inside a 409px
scroller. `npm run check` and 13 focused component/style tests passed.

## Resolved Scope

The user confirmed on 2026-11-11 that only ACP Harness `system` transcript
results are in scope; other `#` command surfaces and shell output are excluded.

## Out of Scope

Redesigning `#` commands that open browser pages, overlays or separate docks; PTY/xterm output; changing command execution, approvals or status polling; rewriting past transcript text or adding output-copy actions.

## Resources

- [Warp Terminal Block Basics](https://docs.warp.dev/terminal/blocks/block-basics.md) — command/output grouping and keyboard navigation.
- [Zellij Keybinding Presets](https://zellij.dev/documentation/keybinding-presets.html) — status/shortcut presentation without changing shell command output.
- [Krypton component catalog](./0302-harness-component-catalog.md), [notice rows](./0371-harness-notice-rows.md), [gallery](./0381-harness-component-gallery.md) — internal payload and rendering contracts.
