# Oh My Pi Lane (OMP Native ACP) — Implementation Spec

> Status: Implemented
> Date: 2026-05-26
> Milestone: M-ACP — Harness convergence

## Problem

Krypton's ACP harness runs Codex, Claude, Gemini, OpenCode, Pi (`pi-acp`), Droid, Cursor, and Junie lanes side by side, but cannot include [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) — a Pi fork with hash-anchored edits, LSP, Python/Bun kernels, subagents, and a first-class ACP server. Users who prefer OMP's tool harness must run `omp` in a plain terminal, losing the harness transcript, lane switching, memory MCP, peering, permission rail, and resource metrics.

## Solution

Add Oh My Pi as a built-in ACP backend using OMP's **native** ACP mode: `omp acp`. OMP is a regular ACP lane like Codex/Cursor/Junie for process lifecycle, prompt streaming, peering, memory, and permission UI. OMP accepts `session/new mcpServers` but also native-loads project root `.mcp.json`, so Krypton must skip the project `.mcp.json` bridge for OMP while still injecting the per-lane `krypton-harness-memory` MCP server. OMP routes destructive tools through `session/request_permission` under Krypton's advertised capabilities, so no OMP warning chip is required in v1. Lanes should be labeled `OMP-1`, `OMP-2`, … (not `Oh My Pi-1`).

Use `Oh My Pi` only when referring to the upstream project/product in prose. Krypton identifiers use `omp` for the backend id and `OMP` for picker labels, lane labels, accent matching, config keys, and docs examples.

Do **not** use the third-party [`omp-acp`](https://github.com/nealol/omp-acp) npm adapter for v1. That wrapper spawns `omp --mode rpc`, executes tools locally (no `fs/*` / `terminal/*` delegation), and does not wire MCP servers through to OMP — the same degraded surface as `pi-acp`.

## Research

- **Native ACP entry point.** Local `omp acp --help` reports "Run Oh My Pi as an ACP (Agent Client Protocol) server over stdio". OMP README documents four entry points (interactive, one-shot, RPC, ACP) and maps OMP tools to ACP routes (`read` → `fs/read_text_file`, `bash` → `terminal/*`, `edit`/`write`/`bash` → `session/request_permission`). This is the critical finding: OMP can be spawned as a normal ACP subprocess like Cursor/Junie.
- **Local CLI baseline.** `omp --version` reports `omp/15.4.1` (verified 2026-05-26). Config lives under `~/.omp/agent/` (sessions, MCP, auth). Known-good baseline for v1.
- **Installation.** OMP ships an install script at [omp.sh](https://omp.sh). The executable is `omp` (Bun-based). Krypton does not install OMP — it only spawns the binary if present on `PATH`, same precedent as Cursor/Junie.
- **Authentication.** OMP consumes standard provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) via Krypton's cached login-shell env injection. OMP also ships `omp auth-broker` / OAuth flows that may need a TTY on first run — users should complete auth once outside Krypton if a lane stalls on `initialize`.
- **MCP support — native discovery.** OMP auto-discovers MCP servers from `.omp/mcp.json`, `~/.omp/agent/mcp.json`, root `mcp.json` / `.mcp.json`, and several third-party tool configs (`.cursor/`, `.claude/`, etc.). See [docs/mcp-config.md](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md). This creates a stronger duplication risk than Junie: Krypton's regular-lane bridge also forwards root `.mcp.json`, so a normal Krypton project may register the same root MCP server twice if `omp acp` keeps native root discovery enabled.
- **MCP support — ACP path.** Native `omp acp` honors `session/new mcpServers` per the ACP spec, but it also auto-loads root `.mcp.json` in ACP mode. Because Krypton cannot dedupe servers that OMP loads natively inside the child process, v1 skips the project `.mcp.json` bridge for OMP and injects only the per-lane `krypton-harness-memory` server.
- **Permission model.** OMP ACP mode routes `edit`, `ast_edit`, `write`, and `bash` through `session/request_permission` when Krypton advertises `fs.readTextFile`, `fs.writeTextFile`, and `terminal: false`. OMP does **not** get `⚠ unsandboxed` or `⚠ permissions unverified` in v1.
- **Relationship to existing Pi lane.** Krypton already has `pi-acp` → `@mariozechner/pi-coding-agent`. OMP is a separate fork with different config dir (`~/.omp/` vs `~/.pi/`), different tools (LSP, Python, subagents, hashline edits), and native ACP. Both lanes can coexist in the picker; users choose per session.
- **Model selection.** OMP exposes `--model=<value>` on the CLI and `session/set_model` in the third-party adapter's feature matrix. Whether native `omp acp` honors spawn flags or mid-session `session/set_model` is unverified. v1 does not push model at spawn; `acp_harness.lane_models.omp.active` is display-only through `inferLaneModelName` until verified.

### Alternatives ruled out

- **Third-party `omp-acp` npm adapter.** Spawns RPC mode, no fs/terminal delegation, MCP not wired. Strictly worse than native `omp acp` for Krypton, which already implements the full ACP client surface.
- **In-process OMP SDK embed.** Would duplicate harness plumbing and forfeit process isolation. Out of scope.
- **Replacing the existing `pi-acp` lane with OMP.** Different products; keep both.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| OMP README | `omp acp` over stdio | Native ACP with fs/terminal/permission routing through the client. |
| Zed + `omp-acp` | Third-party adapter wrapping RPC mode | Useful when native ACP was unavailable; not needed in Krypton. |
| Krypton Cursor lane (Spec 113) | `cursor-agent acp` as native ACP child | Closest precedent — regular lane, bridge + memory MCP. |
| Krypton Pi lane (Spec 84) | `pi-acp` third-party adapter | Lean lane — no MCP host, no permission gate. OMP is the opposite archetype. |
| Krypton Junie lane (Spec 119) | `junie --acp true` + native MCP overlay workaround | OMP should consume `session/new mcpServers` directly — no overlay needed unless verification fails. |

**Krypton delta** — match Krypton's existing built-in lane model (code-defined backend, lane picker entry, memory MCP + permission rail), with an OMP-specific project `.mcp.json` bridge skip to avoid duplicate native MCP registration. Display name `OMP` in the picker so lanes label as `OMP-1`, `OMP-2`, …; backend id `omp` matches the CLI binary.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `("omp", AcpBackend { command: "omp", args: ["acp"], display_name: "OMP" })` to `builtin_backends()`. Add `backend_id == "omp"` `startup_hint` block between the Junie block and the unconditional fallback hints, so OMP auth/API-key errors are not misreported as Claude/Gemini/OpenCode setup. Cover missing CLI, old CLI without `acp`, auth/API-key errors, and empty stderr. Add `omp_startup_hint_*` unit tests mirroring Junie/Cursor patterns, including a non-leakage test for other backends. |
| `src/acp/acp-harness-view.ts` | Add `omp: 'OMP'` to `BACKEND_LABELS`. Expand `laneAccent` palette from 8 to 9 entries. Add `/^omp(-|$)/i` arm to `laneAccentForLabel` (slot 9) before the numeric `-(\d+)$` fallback. Keep lane labels `OMP-1`, `OMP-2`, … everywhere. In `mcpServersForLane()`, skip the project `.mcp.json` bridge for OMP and return memory servers only, matching the native-root-discovery policy below. Do not add an OMP sandbox/warning chip in v1. |
| `src/config.ts` | Update `lane_models` comment to mention `omp`. No schema change. |
| `docs/04-architecture.md` | Add Oh My Pi to the ACP lane list as a regular lane. |
| `docs/05-data-flow.md` | Update ACP Harness Flow backend enumeration if still listing supported lanes explicitly. |
| `docs/06-configuration.md` | Add OMP backend command, install URL, auth prerequisites, optional `lane_models.omp` note. |
| `docs/69-acp-agent-support.md` | Add OMP to supported-lane enumeration. |
| `docs/PROGRESS.md` | Record the OMP lane landing under M-ACP after implementation. |

No new Tauri commands, frontend event types, CSS files, or `krypton.toml` schema changes are required for v1.

## Design

### Backend Registration

```rust
(
    "omp",
    AcpBackend {
        command: "omp".to_string(),
        args: vec!["acp".to_string()],
        display_name: "OMP".to_string(),
    },
),
```

Krypton already injects `cached_login_env()` and the current working directory into ACP subprocesses, covering provider API keys, `PATH`, and project-root behavior.

### Model Selection

v1 does **not** push `--model` at spawn time and does **not** call `session/set_model`. `inferLaneModelName` returns configured `lane_models.omp.active`, agent-reported model from `agent_capabilities`, or `null`. Model spawn-flag or `session/set_model` wiring is out of scope for v1 until a later probe proves native `omp acp` honors one of those paths.

### MCP And Memory

OMP starts from the regular-lane design, with an OMP-specific MCP bridge exception:

- **Do not** add it to the `pi-acp` no-MCP skip.
- **Do** skip the project `.mcp.json` bridge for OMP, because OMP already native-loads root `.mcp.json` in ACP mode.
- Do not call `loadProjectMcpServers()` for OMP in `mcpServersForLane()`.
- Do not attempt cross-boundary dedupe. Krypton cannot see the server set OMP loads natively inside the child process unless OMP exposes a disable-native-discovery flag or reports native server names through a protocol surface Krypton can query.
- Always include the per-lane `krypton-harness-memory` server when harness memory is available.

### Permissions

No force/yolo/trust flags. OMP routes destructive `edit`, `write`, and `bash` behavior through `session/request_permission` under Krypton's actual capabilities (`fs` enabled, `terminal` disabled), so Krypton's existing permission rail handles the safety gate. Do not add an OMP sandbox or permissions-unverified chip in v1.

### UI Changes

- Lane picker gains **OMP** entry; spawned lanes display as `OMP-1`, `OMP-2`, …
- Accent color slot 9 (extend palette by one entry).
- Existing slash-command palette, mode chip, session picker, peering, and review flows inherit unchanged.

### Configuration

No new TOML keys. User-side prerequisites documented in `docs/06-configuration.md`:

```sh
# Install OMP (see https://omp.sh for current instructions)
curl -fsSL https://omp.sh/install | sh

# Configure provider — export in login shell, e.g.:
export ANTHROPIC_API_KEY=...

# Optional: run `omp` once interactively to complete OAuth / auth-broker setup
```

Verify the installer URL against the upstream README while updating `docs/06-configuration.md`. If `https://omp.sh/install` is a redirect or marketing-host shortcut, prefer the canonical GitHub-hosted installer URL in docs.

### Startup Hints

The OMP `startup_hint` block must run before generic fallback hints such as `/login`, `gemini auth`, OpenCode auth, and npm `ENOENT`. Otherwise OMP stderr containing words like `login` or `api key` can surface an unrelated "Run `claude /login`" hint.

Suggested hint copy:

| Signal | Hint |
|--------|------|
| `command not found`, `ENOENT`, `no such file` | "Install OMP from https://omp.sh, then restart Krypton so the login-shell PATH cache includes `omp`." |
| `unknown command acp`, `unrecognized subcommand acp`, `invalid command acp` | "Your OMP CLI predates native ACP mode. Run `omp --version` (known-good baseline: `omp/15.4.1`) and update OMP." |
| `not authenticated`, `please log in`, `authentication required`, `unauthorized` | "Run `omp` once in a terminal to complete auth, or export a provider API key such as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` before launching Krypton." |
| `invalid api key`, `bad token`, `api key` | "OMP reports an API key problem. Re-check your provider key in the login shell used to launch Krypton." |
| empty stderr during initialize timeout | "OMP did not return an initialize response and no stderr was captured. First-run auth-broker/OAuth or install input is a likely cause; run `omp` once in a terminal, then retry." |

## Edge Cases

- **`omp` not on PATH** → ENOENT; lane → `error` with install hint.
- **`omp` predates `acp` subcommand** → unknown command error; startup hint suggests updating OMP.
- **No provider configured** → first prompt fails inside OMP; error surfaces in transcript.
- **OAuth/auth-broker needs TTY** → `initialize` may block or fail; startup hint recommends running `omp` once outside Krypton.
- **User expects `omp-acp` npm package** → not used; document that Krypton calls native `omp acp`.
- **Coexistence with `pi-acp` lane** → both appear in picker; distinct config dirs and capabilities.
- **Native MCP + bridge duplication** → handled by skipping Krypton's project `.mcp.json` bridge for OMP while still injecting `krypton-harness-memory`.

## Out of Scope

- Third-party `omp-acp` npm adapter as an alternate backend.
- In-process OMP SDK lane.
- Replacing or removing the existing `pi-acp` lane.
- Auto-installing OMP.
- OMP-specific MCP overlay (Junie-style) unless verification shows `session/new` injection fails.
- Custom slash-command palette for OMP-specific commands beyond existing ACP `available_commands_update` plumbing.
- Model spawn-flag or `session/set_model` wiring for OMP.

## Resources

- [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) — native ACP mode, tool routing table, four entry points
- [OMP MCP config](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md) — native MCP discovery paths
- [nealol/omp-acp](https://github.com/nealol/omp-acp) — third-party adapter (ruled out for v1; documents RPC-mode limitations)
- [Agent Client Protocol spec](https://agentclientprotocol.com/overview/introduction) — `session/new`, `mcpServers`, permission requests
- `docs/84-acp-pi-lane.md` — existing Pi (`pi-acp`) lane; contrast for MCP/permission behavior
- `docs/113-acp-cursor-lane.md` — regular native-ACP lane precedent
- `docs/119-acp-junie-lane.md` — native MCP duplication risk pattern
- `src-tauri/src/acp.rs:36-109` — `builtin_backends()` registration point
- Local probe: `omp --version` → `omp/15.4.1`; `omp acp --help` confirms stdio ACP server
