# The UI reads only canonical lane events; adapters own the ACP wire

> Status: accepted
> Date: 2026-11-11

## Context

ACP servers report the same action in different shapes. A command's exit code arrives as
`rawOutput.exit_code` (Codex), as an `exit: N` text prefix (Grok), as `_meta.terminal_exit` (Claude
and Codex under the terminal convention), or not at all. Subagent parents, thread state, usage
location and MCP tool names differ per vendor too. Before spec 380, about twenty modules read these
wire shapes, so the same work rendered differently per lane, and a new backend got whatever the
fallbacks produced.

## Decision

Every lane's traffic passes through one lane decoder in `AcpClient`. The decoder has a generic
adapter for the ACP spec and the shared `_meta` conventions, and one small adapter per backend that
deviates from them. It turns raw wire JSON into `LaneEvent`, `ToolView`, `LaneInit` and
`LaneSession`. Only `src/acp/adapters/**` and `src/acp/client.ts` read wire JSON. Every other module
decides what to show from those canonical fields, so the same data fills the same slot on every
lane. A field the server did not send stays null and paints nothing; no adapter invents one. Each
adapter publishes a supply matrix (`yes` / `no` / `unverified` per canonical field) in
`docs/0069-acp-agent-support.md`, so missing data is documented per backend rather than silently
absent. `src/acp/adapters/wire-boundary.test.ts` enforces the boundary.

## Considered Options

- **Adapters in Rust before `emit_event`.** Rejected: every interpreter and its tests are TypeScript,
  the outbound control path would still need a second schema, and Rust stays a byte forwarder
  (CLAUDE.md constraint 3).
- **Keep shape sniffing in each reader and tidy it.** Rejected: nothing would stop the next surface
  from reading `rawOutput` again, so sameness could not be guaranteed.
- **Rely on the `_meta` conventions alone, as Zed does.** Rejected: Krypton also runs vendors that
  follow no convention (Grok's typed `rawOutput`, OMP `details`), so it keeps an explicit adapter per
  backend.

## Consequences

- A new backend renders through the generic adapter with an all-`unverified` matrix until its wire is
  captured; a deviation gets a backend adapter, never a branch in a row or the view.
- `LaneEvent` carries no backend id. Components name the backend only for identity (logo, label, the
  session picker's target, the launch-trust chip); the guard test pins those uses by count.
- The decoder and `harness-transcript-items.ts` import nothing from `@tauri-apps`, so the spec 381
  gallery can run them in the browser.
- Spec 380 phases 1–4a moved every wire reader into `src/acp/adapters/`; captured-wire fixtures and the
  cross-backend contract test (phase 4b) still have to fill the matrix with `yes` / `no`.

## Rails

Applies to: `src/**/*.ts`

- No module outside `src/acp/adapters/**` and `src/acp/client.ts` reads `rawInput`, `rawOutput`,
  `_meta` or `sessionUpdate` from an ACP payload, or imports the wire `ToolCall`, `ToolCallUpdate` or
  `ToolCallContent` types. Tests are exempt.
- No harness component under `src/acp/components/**`, and no lane-event path of `AcpHarnessView`
  (`onLaneEvent`, `renderTool`, `addPermission`, `addAskUser`, `collectToolImages`,
  `noteToolActivity`), decides what to show from the backend id.
- Nothing under `src/acp/adapters/**` or in `src/acp/harness-transcript-items.ts` imports
  `@tauri-apps`.
