# Copilot Lane (GitHub Copilot CLI Native ACP) — Implementation Spec

> Status: Implemented (code) — `initialize` handshake verified live against GitHub Copilot CLI 1.0.60; `session/new.mcpServers` honoring still to be confirmed with a live session
> Date: 2026-06-08
> Milestone: M-ACP — Harness convergence

## Problem

The ACP harness ships ten lanes (Codex, Claude, Gemini, OpenCode, Pi, Droid, Cursor, Junie, OMP, Grok). GitHub Copilot CLI now exposes a first-party **ACP server** (`copilot --acp --stdio`, public preview). Krypton has no lane for it, so users can't run GitHub Copilot side-by-side with the other agents in the same multi-lane transcript.

## Solution

Adopt GitHub Copilot CLI's **native** ACP mode (`copilot --acp --stdio`) as the 11th harness backend. The CLI ships ACP first-party — no third-party wrapper. The wire format (JSON-RPC 2.0 over stdin/stdout) is identical to the existing ten lanes, so registration is one entry in `builtin_backends()`, the built-in-id mirror, and the standard frontend touchpoints (label, logo glyph + tint, lane accent). Copilot is a full agent (permission gate, tool calls, MCP), so it's a **"regular" lane** in the Codex/Droid/Grok mold: the Spec 83 `.mcp.json` bridge and the per-lane memory MCP both apply, capability-gated by what Copilot advertises at `initialize`. Copilot is the 11th lane and the accent palette holds only 10 colors, so the palette gains an 11th entry to avoid a collision with Codex's accent.

## Research

### Native ACP (shapes the design)

- **GitHub Copilot CLI has first-party ACP support.** The ACP entry point is `copilot --acp --stdio` — runs the CLI as an ACP server over JSON-RPC on stdin/stdout (GitHub Copilot CLI ACP-server reference, verified 2026-06-08). This is the exact transport `acp_spawn` already drives; no npm adapter, no glue. (A `--port` TCP mode also exists; the harness only uses stdio, matching every existing lane.)
- **Binary:** `copilot`. Install: `npm install -g @github/copilot` (Node.js 22+). The status is **public preview, subject to change**.
- **Per-session flags applied by the ACP server:** tool-filtering (`--available-tools`, `--excluded-tools`) and reasoning effort (`--effort`, `--reasoning-effort`) are applied to *each session* the ACP client starts. v1 passes none of these (default behavior). They are a future opt-in, not a baseline requirement.
- **Model:** the ACP-server reference documents **no model-selection flag**. v1 therefore wires no spawn-time `-m`; it relies on the existing generic `apply_session_model` (`session/set_model`) path, which needs no new code if Copilot advertises model state at `session/new`. If it doesn't, the chip is display-only and Copilot runs its default.

### Auth

- **OAuth device flow (recommended, interactive):** run `copilot`, then `/login` — generates a one-time code and opens the browser. Like every OAuth flow already integrated (Pi, Claude, Cursor, Junie, Grok), this needs a TTY; Krypton hands the agent pipes, not a TTY. Users on this path run `copilot` / `/login` once outside Krypton to seed creds, then the cached token covers the lane. Document; do not wrap.
- **Token env var (headless-friendly):** a fine-grained PAT with the **Copilot Requests** permission, exported as `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` (in that order of precedence). Krypton's spawn block injects the full login env via `cached_login_env()`, so no extra plumbing — export it in the login shell that launches Krypton.

### MCP

- Copilot CLI advertises MCP support, and the ACP-server reference shows sessions created with an `mcpServers` parameter. The ACP impl is **expected** to honor `session/new mcpServers` like Codex/Gemini/OpenCode/Droid/Grok. **Do not** add a `mcpServersForLane` skip clause for Copilot — let `filterByCapability` gate from `agentCapabilities.mcpCapabilities` advertised at `initialize`. **Open:** Cursor regressed on exactly this (`session/new mcpServers` ignored, Spec 113), so the harness-memory delivery must be verified against a live Copilot build; if Copilot also ignores it, fall back to a native-config workaround (mirror of `prepare_cursor_mcp`). Until verified, assume the standard bridge works (the optimistic default every regular lane uses).

### Alternatives ruled out

- **Legacy `gh copilot` extension** (`gh copilot suggest`/`explain`). That's a command-suggestion helper, not an interactive coding agent and has no ACP transport. Rejected — the new standalone `copilot` CLI is the agent.

## Prior Art

| Tool | Implementation |
|------|----------------|
| GitHub Copilot CLI | Interactive TUI (`copilot`), single-prompt (`copilot -p "..."`), or ACP server via `copilot --acp --stdio` (also `--acp --port N`). Auth `/login` device flow or `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`. Per-session `--available-tools`/`--excluded-tools`, `--effort`. |
| Krypton (10 existing lanes) | `builtin_backends()` hard-codes `(id, command, args, display_name)`. Regular lanes (Codex/Claude/Gemini/OpenCode/Droid/Grok) get the `.mcp.json` bridge + memory MCP + permission rail; lean lanes (Pi) skip it. Lanes are user-added via the lane picker (`acp_list_backends`); there is no default-spawn list. |
| Grok (Spec 135) | Native ACP `grok agent stdio`; no `-m` at spawn (generic `session/set_model`); regular lane; needed an 11th-slot... actually 10th accent color. Closest sibling to Copilot. |

**Krypton delta** — match GitHub's documented invocation exactly (`copilot --acp --stdio`). Treat Copilot as a "regular" lane (full bridge, memory MCP, permission rail). The only Krypton concession is the OAuth-needs-TTY caveat shared with Pi/Claude/Cursor/Junie/Grok (document, don't wrap). Net-new vs. the Grok template: an 11th accent color, since the palette currently holds 10.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `("copilot", AcpBackend { command: "copilot", args: ["--acp", "--stdio"], display_name: "Copilot" })` to `builtin_backends()`. Add a `copilot` arm to `startup_hint()` (install/auth/preview hints). **No** model-flag arm — see Model Override. |
| `src-tauri/src/acp_harness_config.rs` | Add `"copilot"` to `BUILTIN_BACKEND_IDS` (`:23`). Mirrors the frontend `BACKEND_LABELS` keys; without it, directive management rejects `copilot` as an unknown backend target (`:195`). |
| `src/acp/acp-harness-view.ts` | `BACKEND_LABELS`: add `copilot: 'Copilot'`. `backendLogoId`: add `case 'copilot' → 'krypton-logo-copilot'`. `BACKEND_LOGO_SVG_DEFS`: add a `krypton-logo-copilot` `<symbol>`. `laneAccentForLabel`: add `if (/copilot/i.test(label)) return laneAccent(11);`. `laneAccent`: append an 11th accent color. No `inferLaneModelName` change. No `mcpServersForLane` skip clause. |
| `src/styles/acp-harness.css` | Add backend palette token `--krypton-backend-copilot` (`:41-42` block) + tint classes `.acp-harness__rail-logo--copilot` (`:2535`) and `.acp-harness__directive-logo--copilot` (`:3507`). Without these the Copilot glyph renders **untinted** (the render path derives the class suffix from `BACKEND_LABELS[...] ? backendId : 'omp'`). |
| `src/acp/acp-harness-view.test.ts` | Add `laneAccentForLabel('Copilot-1') === laneAccent(11)` + `!== laneAccent(1)`; `backendLogoId('copilot') === 'krypton-logo-copilot'`; update the "keeps the N-color palette" test to assert **11** distinct slots `[1..11]`. |
| `src-tauri/src/acp.rs` (tests) | Add `copilot_startup_hint_*` tests mirroring the Grok set (missing CLI / not-authenticated / empty-stderr / no-leak-to-other-backends). |
| `src/config.ts`, `src-tauri/src/config.rs` | Refresh the enumerated-backend doc comments to include `copilot` (cosmetic). |
| `docs/PROGRESS.md` | Record Spec 150 under M-ACP. |
| `docs/04-architecture.md` | Add Copilot to the lane list: regular lane (bridge + memory MCP), auth token env / OAuth-needs-TTY, command `copilot --acp --stdio`. |
| `docs/06-configuration.md` | New "Copilot lane prerequisites" subsection: install, token env vars, optional `[acp_harness.lane_models.copilot]`; add `copilot` to the backend-id list, command table, and model-selection list. |
| `CLAUDE.md` | (Optional) bump the lane count if it enumerates lanes — currently it does not, so likely no change. |

No changes to `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/mcp-bridge.ts`. No new Tauri commands. Copilot surfaces in the lane picker automatically once in `builtin_backends()` (picker reads `acp_list_backends`).

## Design

### Backend Registration

```rust
// src-tauri/src/acp.rs — append to builtin_backends()
(
    "copilot",
    AcpBackend {
        command: "copilot".to_string(),
        args: vec!["--acp".to_string(), "--stdio".to_string()],
        display_name: "Copilot".to_string(),
    },
),
```

### Model Override

**v1 baseline: no spawn-time model flag.** The ACP-server reference documents none. The backend's generic, non-fatal post-`session/new` path — `apply_session_model` — sends `session/set_model` for any ACP-native backend that advertises model state. If `acp_harness.lane_models.copilot.active` is set and Copilot advertises models at `initialize`, that override applies through the existing path with **no new Rust code**. If not, the chip is display-only and Copilot runs its default.

### Startup Hint

A `copilot` arm in `startup_hint()` (mirrors Grok):
- missing CLI / ENOENT → "Install GitHub Copilot CLI: `npm install -g @github/copilot` (Node 22+), then restart Krypton so the login-shell PATH cache includes `copilot`."
- unknown `--acp` flag → "Your Copilot CLI predates ACP mode (`copilot --acp --stdio`). Update via `npm install -g @github/copilot`."
- not authenticated / unauthorized → "Run `copilot` then `/login` once in a terminal to complete GitHub auth, or export `GH_TOKEN` / `GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` (fine-grained PAT with Copilot Requests) in the login shell used to launch Krypton."
- empty stderr → "Copilot did not return an initialize response and no stderr was captured. First-run `/login` or install input is a likely cause; run `copilot` once in a terminal, then retry."

### Logo Glyph

A new `krypton-logo-copilot` `<symbol>` (16×16 viewBox, `currentColor`, in `BACKEND_LOGO_SVG_DEFS`) so the rail recolors via CSS like the others. Proposed motif per `docs/132` brand-glyph conventions (Copilot's rounded-goggle/visor identity), distinct from the existing ten glyphs.

### Accent Palette Extension

Two color systems each need a Copilot entry:

1. **Backend logo tint** — the `--krypton-backend-copilot` CSS token + `--copilot` tint classes. Colors the glyph in the rail and directive list.
2. **Positional lane-rail accent** — `laneAccent(index)` holds 10 colors; `laneAccent(11)` currently wraps (`(11-1) % 10 = 0`) to Codex's accent → collision. Append an 11th color (a hue distinct from the existing ten). `laneAccentForLabel` maps `/copilot/i → laneAccent(11)`.

Scope note (identical to Grok): `laneAccentForLabel` only fixes the **backend-label** collision used by memory-source chips. The lane's actual `lane.accent` is positional by lane slot — not a blocker.

### MCP Bridge & Permissions

Unchanged code paths. `mcpServersForLane` applies the `.mcp.json` bridge + per-lane memory MCP for Copilot, capability-gated against `mcpCapabilities`; no skip clause. Permission requests for tool calls flow through the existing rail. No autonomy/skip-permission flags at spawn.

### Configuration

No new TOML keys. Optional prerequisites doc:

```sh
# Install GitHub Copilot CLI (Node.js 22+)
npm install -g @github/copilot

# Auth — interactive: run `copilot`, then `/login`
# Or headless: export a fine-grained PAT (Copilot Requests permission)
export GH_TOKEN="github_pat_..."   # or GITHUB_TOKEN / COPILOT_GITHUB_TOKEN

# Optional: pin a model for the Copilot lane — ~/.config/krypton/krypton.toml
# [acp_harness.lane_models.copilot]
# active = "..."
```

## Edge Cases

- **`copilot` not on PATH** → ENOENT; lane → `error` with spawn error + `startup_hint` install line.
- **Older `copilot` without `--acp`** → handshake fails / unknown flag; `startup_hint` points to upgrade.
- **No auth** → first prompt fails inside Copilot; error surfaces in transcript; hint covers `/login` + token env.
- **OAuth device flow** → no TTY in Krypton; user runs `copilot` + `/login` once outside; cached creds cover the lane.
- **Configured model not honored** → no spawn flag, so a bad model id surfaces non-fatally via `apply_session_model` (logged), not a spawn crash; lane still starts on Copilot's default.
- **Copilot ignores `session/new mcpServers`** (Cursor-style) → memory MCP silently absent; detected during verification → native-config fast-follow.
- **Public-preview drift** — the ACP server is "subject to change"; flag/transport changes are caught at the registration layer (one tuple) without touching the harness.

## Open Questions — Partially resolved (peer-reviewed by Codex-1)

Verified live against **GitHub Copilot CLI 1.0.60** (`/opt/homebrew/bin/copilot`) by piping a JSON-RPC `initialize` into `copilot --acp --stdio` and reading the response:

```json
{"protocolVersion":1,
 "agentCapabilities":{"loadSession":true,
   "mcpCapabilities":{"http":true,"sse":true},
   "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
   "sessionCapabilities":{"list":{}}},
 "agentInfo":{"name":"Copilot","title":"Copilot","version":"1.0.60"},
 "authMethods":[{"id":"copilot-login","name":"Log in with Copilot CLI", …}]}
```

1. **MCP injection — capability advertised, honoring UNVERIFIED.** Copilot advertises `mcpCapabilities {http: true, sse: true}`, so the per-lane HTTP `krypton-harness-memory` server **passes `filterByCapability`** and is forwarded in `session/new.mcpServers`. **But advertising a capability is not proof the agent honors the servers** — Cursor advertised MCP yet ignored `session/new.mcpServers` (spec 113), so the regression must be ruled out by exercising a live `session/new` + an MCP tool call, not by the handshake alone. **Correction (Codex-1 review):** an earlier draft claimed stdio servers in the project `.mcp.json` bridge "are dropped by `filterByCapability`" — that is wrong. `filterByCapability` (`src/acp/mcp-bridge.ts:244`) **always retains stdio servers**; only `http`/`sse` entries are capability-gated. So any stdio `.mcp.json` server is still forwarded to Copilot regardless of its advertised caps. No `mcpServersForLane` skip clause is needed; the native-config workaround (mirror of `prepare_cursor_mcp`) remains the fallback **only if** the live session/new check shows Copilot ignores the servers.
2. **Model state at `session/new` — RESOLVED (chip-only).** `initialize` carries no model list, and the ACP-server reference documents no model flag. The lane chip is display-only; the generic `session/set_model` path auto-engages with no new code if a future Copilot build advertises model state at `session/new`. Matches the v1 baseline.
3. **Logo glyph geometry — RESOLVED.** `krypton-logo-copilot` = a rounded goggle/visor head + antenna (Copilot mascot), 16×16 `currentColor`, distinct from the existing ten.

`loadSession: true` and `sessionCapabilities.list` also confirm Copilot supports the resume/list paths the harness already drives. `authMethods` exposes `copilot-login` (run `copilot login`) — handled by the existing auth surface; the `initialize` handshake succeeds regardless of login state.

**Not yet exercised live:** a full `session/new` → `session/prompt` round-trip (requires consuming Copilot auth + quota). It rides the exact code path all ten existing lanes use; the handshake + capability advertisement above is the registration-level verification.

## Out of Scope

- Wiring Copilot's per-session `--available-tools` / `--excluded-tools` / `--effort` into a Krypton UI (future opt-in; v1 uses defaults).
- TCP (`--acp --port`) transport — harness is stdio-only, like every lane.
- Custom slash-command palette/autocomplete for Copilot commands (input passes verbatim via `session/prompt`).
- ACP Authenticate UI inside the harness (OAuth device flow).
- Legacy `gh copilot` extension support.

## Resources

- [GitHub Copilot CLI — ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) — `copilot --acp --stdio` / `--port`; per-session `--available-tools`/`--excluded-tools`/`--effort`; `mcpServers` on session create; public preview
- [Authenticating GitHub Copilot CLI — GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) — `/login` device flow, fine-grained PAT with Copilot Requests, `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` precedence
- [@github/copilot — npm](https://www.npmjs.com/package/@github/copilot) — install `npm install -g @github/copilot`, Node 22+, binary `copilot`
- [github/copilot-cli — GitHub](https://github.com/github/copilot-cli) — source, usage, MCP support
- [Agent Client Protocol](https://agentclientprotocol.com/overview/introduction) — `mcpCapabilities`, `promptCapabilities`, `session/new`, `session/set_model`
- `docs/135-acp-grok-lane.md` — closest sibling (native ACP, regular lane, no `-m`, palette extension)
- `docs/83-acp-shared-mcp-config.md` — `.mcp.json` bridge (applies to Copilot)
- `docs/113-acp-cursor-lane.md` — native-config MCP fallback pattern, if Copilot regresses on `session/new mcpServers`
- `src-tauri/src/acp.rs:36-132` — `builtin_backends()`; `:2018` Grok `startup_hint` arm (template)
- `src/acp/acp-harness-view.ts:755` `BACKEND_LABELS`; `:832` `backendLogoId`; `:873` `BACKEND_LOGO_SVG_DEFS`; `:10157` `laneAccent`; `:10173` `laneAccentForLabel`
