# Cursor Lane (Cursor Agent Native ACP) — Implementation Spec

> Status: Implemented (permission/model verification follow-ups remain)
> Date: 2026-05-20
> Milestone: M-ACP — Harness convergence

## Problem

Krypton's ACP harness can compare Codex, Claude, Gemini, OpenCode, Pi, and Droid lanes, but cannot run Cursor Agent in the same shared project harness. Users with an existing Cursor subscription or Cursor Agent setup need to leave Krypton or run Cursor in a plain terminal, losing the harness transcript, lane switching, memory, peering, and permission UI.

## Solution

Add Cursor as a built-in ACP backend using Cursor Agent's native ACP server mode: `cursor-agent acp`. Cursor is a "regular" lane like Codex/Gemini/OpenCode/Droid: it gets the `.mcp.json` bridge when advertised, the per-lane `krypton-harness-memory` MCP server, existing session/prompt streaming, and the normal permission rail. No headless NDJSON wrapper or third-party adapter is needed for the primary path.

## Research

- Local CLI check: `/Users/wk/.local/bin/cursor-agent` exists; `cursor-agent --version` returns `2026.05.16-0338208`. This is the known-good baseline for the v1 spec.
- Local CLI check: `cursor-agent acp --help` reports "Start the Cursor Agent as an ACP (Agent Client Protocol) server". This is the critical finding: Cursor can be a normal ACP subprocess.
- Local CLI check: `cursor-agent status` fails in this shell with `ERROR: SecItemCopyMatching failed -50`, so startup/auth errors may be Keychain-specific on macOS GUI/sandboxed launches. The lane should surface stderr as normal and docs should recommend `cursor-agent login` or `CURSOR_API_KEY`.
- Cursor docs describe headless mode via `cursor-agent -p --output-format stream-json`, with NDJSON system/user/assistant/tool/result events. That path is useful for scripts but is not ACP and would require a custom adapter. Rejected for v1.
- Cursor docs say the CLI reads `AGENTS.md` and `CLAUDE.md` at the project root, alongside `.cursor/rules`, so Krypton's repo instructions should flow into the Cursor lane naturally.
- Cursor CLI exposes `--model`, `--force`, `--sandbox`, `--trust`, `--approve-mcps`, and `--workspace` as global options. For v1, Krypton should pass only `acp`; model/autonomy flags stay out unless already supported by the generic lane model mechanism after verification.
- Zed's ACP ecosystem and forum reports confirm Cursor is available through ACP clients. This validates the native-ACP direction and argues against building a one-off headless bridge.

Alternatives ruled out:

- **Headless NDJSON pseudo-lane**: `cursor-agent -p --output-format stream-json` can stream events, but it is single-turn scripting, not ACP. It would lose native session lifecycle, permission request semantics, and MCP injection.
- **Third-party `cursor-agent-acp` npm adapter**: useful before native ACP was available, but redundant if `cursor-agent acp` works. Adds install/version risk.
- **Running Cursor in a normal terminal pane**: already possible, but not a harness lane and cannot participate in memory/peering/session UI.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed | Installs Cursor through the ACP Registry and runs it as an external ACP agent. | Confirms Cursor works in ACP-oriented editor surfaces. |
| Cursor CLI headless | `cursor-agent -p --output-format stream-json` emits NDJSON events for scripts. | Structured, but not ACP; fallback research only. |
| Third-party Cursor adapter | `cursor-agent-acp` wraps Cursor Agent for ACP over stdio. | Rejected for v1 because native `cursor-agent acp` is present locally. |
| Krypton existing lanes | `builtin_backends()` hard-codes backend id, command, args, and display name. | Cursor fits the same registration path as Gemini/OpenCode/Droid. |

**Krypton delta** — match Krypton's existing lane model instead of adopting Zed's registry. The backend is code-defined, visible in the existing lane picker, and uses the same MCP bridge, memory MCP, permission rail, resource metrics, session picker attempt, and peering behavior as other regular ACP lanes.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `("cursor", AcpBackend { command: "cursor-agent", args: ["acp"], display_name: "Cursor" })` to `builtin_backends()`. Add Cursor-specific startup hint for auth/keychain errors. |
| `src/acp/acp-harness-view.ts` | Add `cursor` to `BACKEND_LABELS`; add a distinct lane accent if current palette mapping does not already cover the extra backend cleanly; confirm Cursor is not skipped by `memoryServerForLane()` or `.mcp.json` bridge; update or explicitly accept the default behavior in `inferLaneModelName()`. |
| `src/config.ts` | Update lane-model comment to mention `cursor` if needed. No schema change. |
| `docs/04-architecture.md` | Add Cursor to the ACP lane list and document it as a regular lane. |
| `docs/05-data-flow.md` | Update ACP Harness Flow backend list if still enumerating supported lanes. |
| `docs/06-configuration.md` | Add Cursor backend command, auth prerequisites, and optional `lane_models.cursor` note if model flag support is implemented. |
| `docs/PROGRESS.md` | Record the Cursor lane landing after implementation. |

No new Tauri commands, frontend event types, or CSS files are required for v1.

## Design

### Backend Registration

```rust
(
    "cursor",
    AcpBackend {
        command: "cursor-agent".to_string(),
        args: vec!["acp".to_string()],
        display_name: "Cursor".to_string(),
    },
),
```

Krypton already injects the cached login-shell environment and current working directory into ACP subprocesses. That covers `CURSOR_API_KEY`, `PATH`, and project-root behavior.

### Model Selection

V1 does not special-case Cursor model selection unless implementation verification confirms `cursor-agent acp --model <id>` affects ACP sessions. If verified, extend the existing spawn-time CLI model branch:

```rust
if backend_id == "cursor" {
    backend.args.push("--model".to_string());
    backend.args.push(model.clone());
}
```

If not verified, `acp_harness.lane_models.cursor.active` remains display-only like Claude/Codex/Pi.

### MCP And Memory

Cursor is a regular lane:

- Do not add it to the `pi-acp` no-MCP skip.
- Do not add it to the `claude` native `.mcp.json` skip unless Cursor's ACP server is proven to load project `.mcp.json` itself.
- Cursor's documented native MCP file is `.cursor/mcp.json`; if a project has both `.cursor/mcp.json` and `.mcp.json`, implementation verification should confirm Krypton's injected `.mcp.json` servers do not duplicate Cursor-loaded native servers under different names.
- Let `filterByCapability()` gate HTTP/SSE/stdio MCP servers from `agentCapabilities.mcpCapabilities`.
- Always include the per-lane `krypton-harness-memory` server when harness memory is available.

### Permissions

No `--force`, `--yolo`, `--trust`, or `--approve-mcps` flags are passed by default. Until Cursor ACP write-permission behavior is manually verified, the lane chrome shows a `⚠ permissions unverified` chip. This is intentionally weaker than Pi's `⚠ unsandboxed` chip because Krypton is not opting Cursor into force/yolo behavior, but it keeps the safety assumption visible.

Follow-up verification should run a scratch-directory probe that asks Cursor ACP to edit a file and verify whether it emits ACP permission requests, denies internally, or applies edits directly. If it emits permission requests or denies before writes, remove the unverified chip. If it applies edits directly, upgrade the v1 UI to an explicit unsandboxed Cursor warning comparable to other autonomy warnings.

### Startup Diagnostics

Cursor lane startup relies on `cursor-agent acp` taking the non-interactive ACP path. Clean machines may need `cursor-agent login` before Krypton can spawn Cursor successfully; if Cursor starts an installer/auth wizard or waits for stdin, Krypton will not provide an interactive TTY because ACP children use piped stdio. Krypton reuses the initialize timeout so this becomes a visible lane error with a Cursor-specific hint instead of a silent hang. When no stderr is captured, the hint is intentionally phrased as a likely cause rather than a diagnosis.

Extend the existing stderr hint function with Cursor cases:

| stderr substring | Suggested action |
|------------------|------------------|
| `SecItemCopyMatching failed` | "Cursor credential lookup failed. Run `cursor-agent login` in a terminal, or set `CURSOR_API_KEY` before launching Krypton." |
| `not authenticated`, `authentication required`, `please log in`, `please login`, `api key`, `unauthorized` | "Run `cursor-agent login`, or export `CURSOR_API_KEY` in your login shell." |
| `cursor-agent: command not found`, `ENOENT` | "Install Cursor Agent CLI: `curl https://cursor.com/install -fsS | bash`." |

Match specific Keychain strings such as `SecItemCopyMatching failed` before generic auth substrings like `api key`, so macOS credential failures receive the correct hint. Do not match the bare word `login`; Cursor can mention login in non-diagnostic log lines.

### Data Flow

```
1. User opens ACP Harness and presses Cmd+P then +.
2. Lane picker lists `Cursor` from `acp_list_backends()`.
3. User selects Cursor.
4. Rust spawns `cursor-agent acp` in the harness project directory.
5. AcpClient sends `initialize`.
6. Frontend capability-gates `.mcp.json` servers, appends memory MCP, then calls `session/new`.
7. User prompts Cursor lane.
8. Cursor streams ACP `session/update` events; Krypton renders assistant chunks, tools, plan/mode updates, and permissions through existing harness code.
```

### UI Changes

- Lane picker shows `Cursor`.
- Lane display names follow existing numbering: `Cursor-1`, `Cursor-2`, etc.
- Cursor shows a `⚠ permissions unverified` chip until a scratch-directory permission probe confirms Cursor ACP emits permission requests or denies before writes. Cursor is not treated as unsandboxed solely because we do not pass `--force`/`--yolo`.
- Session picker (`Cmd+P → 0`) should attempt `session/list` like other lanes. If Cursor does not support it, the existing unsupported-session message is enough.

### Configuration

No new TOML keys. Existing optional model config shape may be used:

```toml
[acp_harness.lane_models.cursor]
active = "gpt-5"
models = ["gpt-5", "sonnet-4", "sonnet-4-thinking"]
```

Whether `active` is passed as `--model` depends on implementation verification above; otherwise it only drives the lane model chip.

## Edge Cases

- **`cursor-agent` not on PATH**: spawn fails; lane enters error state with install hint.
- **Authenticated in a terminal but not visible to GUI launch**: cached login env may not fix Keychain access. Error hint points to `cursor-agent login` and `CURSOR_API_KEY`.
- **Older Cursor Agent without `acp` command**: spawn may print unknown-command help or exit; initialize timeout/error surfaces. User updates Cursor Agent. Version `2026.05.16-0338208` is the known-good baseline verified during research.
- **Interactive first-run prompt**: installer/auth prompts that wait on stdin can block `initialize` forever unless Krypton times out startup and shows the Cursor login/install hint.
- **Cursor loads `.cursor/rules`, `AGENTS.md`, and `CLAUDE.md`**: expected. Krypton should not duplicate these as extra prompt blocks. When running inside the Krypton repo itself, Cursor may also consume Krypton's Tauri-specific `CLAUDE.md`; this is acceptable but should be remembered during manual verification.
- **Project defines both `.cursor/mcp.json` and `.mcp.json`**: Cursor may load `.cursor/mcp.json` natively while Krypton injects `.mcp.json` servers through ACP. Verify duplicate server handling before changing the `claude`-only skip rule.
- **Cursor rejects injected MCP servers**: capability gating should prevent unsupported types; if the agent still rejects a server, lane startup error is surfaced.
- **Cursor supports ACP but not `session/list`**: session picker shows the existing "does not support session/list" path.
- **Cursor stderr is noisy**: Cursor may emit logs or ANSI on stderr. Krypton's rolling stderr buffer should still preserve the terminal startup error; if real errors are buried, add a narrow Cursor hint/filter follow-up.
- **User wants force/yolo behavior**: out of scope for v1; use Cursor's own config or a future explicit Krypton setting.

## Open Questions

- Does `cursor-agent acp --model <id>` affect ACP sessions? If yes, wire `acp_harness.lane_models.cursor.active` into the spawn args. If no, keep Cursor model config display-only and document that behavior.
- Does Cursor ACP emit `session/request_permission` before file writes, deny internally, or mutate directly? Verify with a scratch-directory write probe before deciding that the lane needs no warning chip.

## Out of Scope

- Implementing a headless NDJSON adapter.
- Installing Cursor Agent or `cursor-agent-acp` automatically.
- Adding a generic Zed ACP Registry installer to Krypton.
- Wiring Cursor-specific `--force`, `--yolo`, `--trust`, `--approve-mcps`, `--sandbox`, `--worktree`, or `--plugin-dir` settings into `krypton.toml`.
- Building Cursor-specific slash command UI.

## Resources

- [Cursor CLI headless docs](https://docs.cursor.com/en/cli/headless) — documented `-p/--print`, `--force`, and script-oriented usage.
- [Cursor CLI output format docs](https://docs.cursor.com/en/cli/reference/output-format) — NDJSON event schema for the rejected headless pseudo-lane path.
- [Cursor CLI parameters docs](https://docs.cursor.com/en/cli/reference/parameters) — model, force, sandbox, trust, MCP, workspace flags.
- [Cursor CLI usage docs](https://docs.cursor.com/en/cli/using) — `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, and `--output-format` behavior.
- [Cursor forum: ACP with Zed](https://forum.cursor.com/t/acp-how-to-connect-cursor-cli-to-zed/154031) — confirms Cursor availability through ACP client workflows and the Zed registry.
- [Zed ACP Registry announcement](https://zed.dev/blog/acp-registry) — prior art for registry-distributed ACP agents.
- [Zed ACP ecosystem page](https://zed.dev/acp) — confirms Cursor appears in aggregated ACP agent usage/registry ecosystem.
- [Third-party Cursor Agent ACP adapter](https://github.com/blowmage/cursor-agent-acp-npm) — considered and rejected because native `cursor-agent acp` is available.
- Local command: `cursor-agent acp --help` — confirmed native ACP server command on this machine.
- Local command: `cursor-agent --help` — confirmed global flags and headless modes.
- Local command: `cursor-agent status` — exposed Keychain auth failure to document as startup edge case.
