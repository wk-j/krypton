# Harness Controller CLI — Implementation Spec

> Status: Implemented — core v1; SSE/prompt IDs, session resume, image/stdin send, and harness close deferred
> Date: 2026-06-11
> Milestone: M-ACP — Harness convergence

## Problem

Krypton's ACP Harness can only be controlled through its graphical, keyboard-driven interface. Shell scripts and users working in another terminal cannot inspect harness state, create lanes, submit prompts, wait for turns, resolve permissions, or manage sessions without switching into Krypton.

## Solution

Ship a macOS-first Rust binary named `kryptonctl` that controls the single running Krypton application instance through a typed, versioned loopback HTTP API. The CLI exposes a capability-advertised set of stable ACP Harness domain operations, while the TypeScript frontend remains the sole authority for live harness state. Core v1 uses request/response operations; `send --wait` polls typed lane state until the lane is idle and its queue is empty.

The CLI is a **Harness Controller**, not a lane, ACP agent, or standalone ACP client. It must never impersonate a lane or invoke UI keyboard/hash-command surfaces.

## Decisions

- v1 is Unix/scriptable, not an interactive TUI.
- `kryptonctl` is a separate Rust binary installed alongside the macOS app.
- Krypton is treated as a single running application instance; multiple simultaneous Krypton processes are out of scope.
- The control API is enabled by default and may be disabled with `[acp_controller].enabled = false`.
- The control API uses a dedicated `127.0.0.1` listener, separate from the unauthenticated hook/MCP server. As of doc 175/176 it binds a **fixed** configurable port (`[acp_controller].port`, default `8766`) with ephemeral fallback on conflict, so external clients have a stable URL; the descriptor still carries the resolved URL, so `kryptonctl` is unaffected.
- A permission-`0600` runtime descriptor contains PID, URL, API/app versions, and a random bearer token.
- The bearer token authenticates callers. There are no authorization roles or scopes; an authenticated caller may invoke every exposed operation.
- The frontend owns live state. Rust authenticates, parses, forwards typed operations through a Tauri round-trip, and times out if the owning view does not answer.
- Domain operations are typed endpoints. The API never simulates keys or submits hash commands.
- Pretty structured output is the default. `--json` explicitly selects the stable JSON form for scripts.
- Core v1 uses ordinary HTTP control requests; SSE was deferred here and later
  shipped for the web-app use case — see `docs/175-harness-web-control-api.md`
  (`GET /control/v1/events`). The `kryptonctl` CLI does not yet consume it.
- CLI mutations produce only their natural UI result; no CLI-specific audit cards or labels are added.
- v1 packages and supports macOS only. Protocol types should not deliberately prevent later Linux/Windows support.

Related decisions: ADR-0005, ADR-0006, ADR-0007.

## Command Surface

Representative stable operations:

```sh
kryptonctl acp capabilities
kryptonctl acp harnesses
kryptonctl acp harness create --cwd /project

kryptonctl acp lanes [--harness hm-3]
kryptonctl acp spawn codex --harness hm-3
kryptonctl acp close Codex-1 --yes
kryptonctl acp restart Codex-1
kryptonctl acp new Codex-1 [--clear-memory] --yes
kryptonctl acp model Codex-1 <model-id>
kryptonctl acp directive Codex-1 <directive-id>
kryptonctl acp directive Codex-1 --clear
kryptonctl acp goal Codex-1 <text>
kryptonctl acp goal Codex-1 --clear
kryptonctl acp permission-mode Codex-1 normal|acceptEdits|bypass

kryptonctl acp send Codex-1 "implement it" [--wait]
kryptonctl acp cancel Codex-1

kryptonctl acp permissions Codex-1
kryptonctl acp permission approve Codex-1 <permission-id>
kryptonctl acp permission reject Codex-1 <permission-id>

kryptonctl acp transcript Codex-1
kryptonctl acp memory list --harness hm-3
kryptonctl acp memory get Codex-1
kryptonctl acp memory clear Codex-1 --yes
kryptonctl acp peers
```

Lane-targeted commands use globally unique lane display names. Harness-level commands accept `--harness`; if more than one harness exists and no target is provided, the CLI fails with an ambiguity error.

Core v1 `send` accepts text from one argument. `@path` remains ordinary prompt text and never causes the CLI to read a file automatically.

## Explicitly Excluded Operations

- No interactive CLI TUI.
- No generic "invoke any operation" endpoint.
- No UI-only operations such as overlay layout, animation, or keyboard focus.
- No browser/CORS support.
- No agent-orchestrated workflow commands for `#review`, `#wiki`, or `#recall`.
- No `memory set`; harness memory remains lane-owned.
- No `peer send`; peering remains lane-to-lane and the CLI must not impersonate a lane.
- No raw ACP event/payload access.
- No multi-process Krypton discovery or cross-process lane addressing.
- No SSE/prompt-specific watch or cancellation in core v1.
- No session resume/load, image/stdin send, `--start-krypton`, or harness close in core v1.

## Runtime Discovery And Authentication

On startup, when `[acp_controller].enabled = true`, Krypton:

1. Starts a dedicated control listener on `127.0.0.1` with an OS-assigned port.
2. Generates a random bearer token.
3. Atomically writes `~/.config/krypton/runtime/controller.json` with permission `0600`.
4. Replaces any stale descriptor from a dead PID.
5. Removes the descriptor during graceful shutdown.

The descriptor contains:

```json
{
  "pid": 1234,
  "url": "http://127.0.0.1:49152/control/v1",
  "apiVersion": "1.0",
  "appVersion": "0.1.0",
  "token": "random-secret"
}
```

`kryptonctl` validates PID liveness and sends `Authorization: Bearer <token>` on every request. The token rotates on every Krypton start. Authentication failure reveals no control state.

When Krypton is not running, commands fail. Automatic GUI launch is deferred.

## State Ownership And Round-Trips

The frontend remains authoritative for harnesses, lanes, prompt queues, transcripts, pending permissions, permission modes, sessions, directives, goals, models, and lifecycle transitions.

```text
kryptonctl
  → authenticated Rust control listener
  → typed Tauri event with requestId + operationId
  → frontend control coordinator
  → owning AcpHarnessView
  → typed reply through Rust pending-reply registry
  → HTTP response
```

Rust must not maintain a competing copy of live harness state. A missing/disposed owner or unresponsive webview returns a timeout/error.

## Prompt Lifecycle And Waiting

- Sending to a busy lane enters the existing per-lane prompt queue.
- `send --wait` polls `lane.list` until that lane is idle and its prompt queue is empty.
- Disconnecting or pressing `Ctrl+C` stops the CLI only; it does not cancel the lane.
- Prompt-specific IDs, reconnect, SSE/NDJSON streaming, and prompt-specific cancellation remain deferred because the current Harness queue has no prompt identity.

## Permissions

The CLI supports:

- Explicit approval/rejection by permission ID.
- Persistent per-lane permission modes: `normal`, `acceptEdits`, `bypass`.

Persistent modes are stored on each Harness Lane and survive turn boundaries until changed or the lane closes. `acceptEdits` auto-accepts edit and file-write review surfaces; `bypass` auto-accepts all permission requests, including high-risk operations. The CLI exposes the selected mode in lane output, but the API adds no authorization scopes.

## Transcript And Memory Boundaries

Transcript reads expose the same rendered/redacted information visible in the Harness UI: user/assistant text plus tool, permission, provider, and system summaries after existing redaction. Raw ACP events and hidden payloads remain inaccessible.

Memory commands preserve the lane-owned memory model:

- `memory list` and `memory get` are read-only.
- `memory clear` is allowed as an explicit destructive operation.
- There is no `memory set`; callers instruct a lane through `send` if they want it to write memory.

`peer list` is read-only. There is no CLI-originated `peer send`.

## Concurrency And Idempotency

UI and CLI operations serialize through the frontend authority.

- Every mutation carries an `operationId`; replaying the same ID must not repeat the mutation.
- Operations may carry explicit preconditions such as `ifIdle`.
- If state changes before execution, return a typed conflict such as `lane_not_idle`, `session_replaced`, or `harness_closed`.
- Never silently retry destructive operations.
- Session-reset operations clear the existing prompt queue, matching current Harness behavior.

## Confirmation And Exit Codes

Destructive CLI commands ask for confirmation when stdin is a TTY. In non-interactive contexts they require `--yes`; otherwise they fail without mutation.

`send --wait` returns:

- `0` when the prompt reaches normal completion, regardless of whether the assistant's prose describes success or failure.
- Non-zero for control/protocol failure, lane error/stopped state while waiting, conflict, cancellation, or timeout. A rejected permission does not force failure when the agent continues and the lane completes normally.

The CLI never interprets assistant prose as a machine success verdict.

## Versioning And Capabilities

The runtime descriptor advertises API and application versions. `kryptonctl` validates the descriptor's API major version before invoking operations; callers can inspect the complete operation set with `acp capabilities`.

- Incompatible API major versions fail.
- Minor-version differences are handled through advertised capabilities.
- Unsupported operations return `unsupported_operation`.
- The CLI never falls back to keyboard/hash-command simulation.

New Harness features are not automatically CLI features. Stable domain operations should be considered for capability-registry exposure; UI-only features remain UI-only.

## Error Shape

Every error response uses a stable machine code plus human-readable detail:

```json
{
  "error": {
    "code": "lane_not_idle",
    "message": "Codex-1 is busy",
    "retryable": false
  }
}
```

Representative codes: `krypton_not_running`, `controller_disabled`, `authentication_failed`, `unsupported_api_version`, `unsupported_operation`, `ambiguous_harness`, `unknown_harness`, `unknown_lane`, `lane_not_idle`, `session_replaced`, `permission_not_found`, `conflict`, `timeout`.

## Affected Areas

| Area | Change |
|------|--------|
| Rust shared control types | Add versioned request/response/event/error/capability types shared by app and `kryptonctl`. |
| Rust control server | Dedicated authenticated loopback listener, runtime descriptor lifecycle, pending frontend round-trips, capability registry. |
| `kryptonctl` Rust binary | Discovery, PID validation, authentication, commands, destructive confirmation, structured JSON output, lane-state wait, exit codes. |
| Frontend control coordinator | Register live harness views, route typed operations, serialize mutations, enforce preconditions/idempotency, publish rendered events. |
| `AcpHarnessView` | Expose stable domain-operation methods without routing through keyboard/hash-command handlers. |
| Configuration | Add `[acp_controller].enabled`, default `true`. |
| macOS packaging | `make install` installs `kryptonctl` to `~/.local/bin` by default; override with `CLI_INSTALL_DIR=/desired/path`. |
| Tests | Auth/discovery, stale descriptor, routing, conflicts, idempotency, queue/watch/reconnect, permissions, redaction, destructive confirmation, version negotiation. |
| Documentation | Update architecture, data flow, configuration, functional requirements, progress, and build/install instructions during implementation. |

## Verification

- Rust unit tests cover reply shape and PID liveness; the full auth/descriptor lifecycle matrix remains to be added.
- Frontend type-check and existing test suite cover integration regressions; focused control-operation tests remain to be added.
- Cargo builds and lints both the GUI backend and `kryptonctl`; CLI integration and installed-app end-to-end tests remain deferred.

## Open Questions

- Prompt identity + SSE/watch/cancel semantics.
- Session resume/load and explicit image/stdin prompt input.
