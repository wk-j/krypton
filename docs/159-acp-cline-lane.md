# Cline ACP Lane — Implementation Spec

> Status: Implemented
> Date: 2026-06-14
> Milestone: M-ACP — external agent lanes

> **Revision 2026-06-14 (post-verification).** A live `cline --acp` handshake
> (cline 3.0.24, installed at `/opt/homebrew/bin/cline`) showed the `initialize`
> response advertises **no `mcpCapabilities`**. Servers injected via
> `session/new.mcpServers` are therefore dropped — the per-lane memory server
> never connects and the lane has no `peer_send`/`memory_*`/`attention_flag`
> tools. The "standard `session/new` MCP path" planned below is **not** viable;
> the implementation adopts the native-config overlay (the reversible fallback
> the Open Questions section pre-authorized). Sections below are annotated where
> the as-built design differs from the original plan.

## Problem

Cline ships a CLI that speaks the Agent Client Protocol (`cline --acp`), but Krypton's
ACP harness has no `cline` backend. Users who run Cline (a popular open-source coding
agent with its own Skills/Hooks/MCP stack) cannot spawn it as a lane alongside Claude,
Cursor, Junie, MiMo, etc.

## Solution

Add `cline` as a 13th built-in ACP backend following the exact pattern of the existing
twelve. It is a stdio JSON-RPC ACP server launched with `cline --acp`, registered in
`builtin_backends()`, given a startup-hint branch, a frontend label/logo/accent, and a
backend color. ~~It uses the standard ACP `session/new` MCP path.~~ **(As built:)** Cline
advertises no `mcpCapabilities`, so MCP is delivered through a **native-config overlay** —
a per-lane `cline_mcp_settings.json` pointed at by `CLINE_MCP_SETTINGS_PATH` at spawn, the
same family as the Junie `--mcp-location` overlay. No model spawn-flag in v1 (Cline selects
its model from its own auth/config; treated as display-only like Cursor/Codex).

## Research

- **Cline ACP launch** (docs.cline.bot/cli/acp-editor-integrations): install `npm i -g cline`;
  run as ACP agent server with `cline --acp` over stdio; authenticate with `cline auth`.
  All Cline features (Skills, Hooks, MCP) remain available in ACP mode. Editor examples
  (Zed/JetBrains/Neovim) all point at `cline --acp`.
- **Backend registry is data-driven.** `acp_list_backends` (`src-tauri/src/acp.rs:973`)
  derives the picker list from `builtin_backends()` — adding the entry surfaces it in the
  UI with no extra wiring. Sorted by id.
- **MCP delivery (verified).** Cline manages MCP via its own settings
  (`cline_mcp_settings.json`), not Anthropic's `.mcp.json`. The original plan assumed
  Cline would still accept ACP-injected servers; the live handshake disproved it —
  `initialize` returns `agentCapabilities` with `loadSession` + `promptCapabilities`
  only, **no `mcpCapabilities`**. Per ACP, with no advertised capability, http/sse
  servers in `session/new.mcpServers` are dropped (Krypton's own `filterByCapability`
  would also strip them, and the per-lane memory server — appended ungated — is http
  with nowhere to land). The fix is the native-config overlay: Cline's settings file
  supports a discriminated `type` union (`stdio` | `sse` | `streamableHttp`, with
  `http` aliased to `streamableHttp`, and a URL-only entry defaulting to **SSE**), so
  the memory server must be tagged `streamableHttp` explicitly. `CLINE_MCP_SETTINGS_PATH`
  overrides the full path to that file (default `~/.cline/data/settings/cline_mcp_settings.json`),
  letting Krypton give each lane its own file (each lane has a distinct memory URL) while
  the global `~/.cline` auth/providers stay shared.
- **Model (verified).** `cline --help` does expose `-m, --model <id>` and `-P, --provider <id>`,
  contrary to the original "no `--model` flag" note. v1 still applies no spawn-time model
  flag (Cline binds provider+model through `cline auth`/config); `lane_models.cline.active`
  is chip-only. If Cline's `session/new` later advertises `models{...}`, the generic
  model-picker path handles it with zero extra code (same as MiMo's inheritance).

## Prior Art

This is internal pattern-replication, not a novel UX. The closest reference is every
existing ACP lane. Most relevant prior specs:

| Lane | Quirk handled | Relevance |
|------|---------------|-----------|
| Cursor (113) | ignores `session/new` mcpServers → native `.cursor/mcp.json` | same defect class; Cline differs (advertises *no* capability vs. advertise-then-ignore) |
| Junie (119) | native `--mcp-location` overlay (per-lane dir under `runtime/`) | **the adopted pattern** — Cline's overlay reuses this shape (per-lane file + spawn-time pointer) |
| MiMo (most recent) | generic model path via `session/set_model` | template for a clean, low-quirk new lane |
| Copilot (150) | stdio ACP, env-var/`/login` auth, startup hints | template for startup-hint branch + auth messaging |

**Krypton delta** — Cline joins with a native-config MCP overlay (`CLINE_MCP_SETTINGS_PATH`),
the Junie-family pattern, because it advertises no `mcpCapabilities`. No model flag in v1. It
matches the harness's existing keyboard-first lane lifecycle with no new affordances.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | `cline` entry in `builtin_backends()`; `cline` `startup_hint()` branch; `cline_overlay_lane_dir` + `write/remove/gc_cline_mcp_overlay` commands; `cline_mcp_settings_path` param on `acp_spawn` (sets `CLINE_MCP_SETTINGS_PATH`); rename `sanitize_junie_path_component` → `sanitize_overlay_path_component` |
| `src-tauri/src/lib.rs` | Register the three `*_cline_mcp_overlay*` commands |
| `src/acp/mcp-bridge.ts` | `toClineMcpFile` (explicit `type`); `write/remove/gcClineMcpOverlay(s)` |
| `src/acp/client.ts` | `clineMcpSettingsPath` param on `AcpClient.spawn` → `acp_spawn` |
| `src/acp/acp-harness-view.ts` | `BACKEND_LABELS.cline`; `backendLogoId` case; `BACKEND_LOGO_SVG_DEFS` symbol; 13th `laneAccent` color; `laneAccentForLabel` `/cline/i` branch; skip `cline` in `mcpServersForLane`; `clineOverlayServersForLane`; `spawnLane` cline branch; `clineMcpOverlayDir` lane field; close-cleanup; gc-on-init |
| `src/styles/acp-harness.css` | `--krypton-backend-cline` color var; `.acp-harness__rail-logo--cline`; `.acp-harness__directive-logo--cline` |
| `src/config.ts` | Add `cline` to the backend-id doc-comment list |
| `docs/06-configuration.md` | `cline` row + prereqs (native-overlay note) |
| `docs/04-architecture.md`, `docs/PROGRESS.md` | List the new backend; native-overlay design |

## Design

### Data Structures

No new types. New `builtin_backends()` tuple (insert after the `mimo` entry):

```rust
(
    "cline",
    AcpBackend {
        command: "cline".to_string(),
        // Cline CLI native ACP server over stdio (`npm i -g cline`).
        // MCP is delivered via a native cline_mcp_settings.json overlay
        // (CLINE_MCP_SETTINGS_PATH) because Cline advertises no mcpCapabilities
        // and drops session/new mcpServers. Model comes from `cline auth`/config.
        args: vec!["--acp".to_string()],
        display_name: "Cline".to_string(),
    },
),
```

### startup_hint branch (mirrors copilot/grok structure)

```rust
if backend_id == "cline" {
    if s.contains("command not found") || s.contains("enoent") || s.contains("no such file") {
        return "Install the Cline CLI: `npm i -g cline`, then restart Krypton so the login-shell PATH cache includes `cline`.".to_string();
    }
    if s.contains("unknown option") || s.contains("unrecognized option")
        || s.contains("unrecognized argument") || s.contains("unexpected argument")
        || s.contains("invalid option") {
        return "Your Cline CLI predates ACP mode (`cline --acp`). Update via `npm i -g cline`.".to_string();
    }
    if s.contains("not authenticated") || s.contains("please log in")
        || s.contains("please login") || s.contains("authentication required")
        || s.contains("unauthorized") || s.contains("/login") {
        return "Run `cline auth` once in a terminal to authenticate, then retry.".to_string();
    }
    if s.contains("invalid api key") || s.contains("bad token") || s.contains("api key") {
        return "Cline reports an API/token problem. Re-run `cline auth` or re-check your provider key in the login shell used to launch Krypton.".to_string();
    }
    if stderr.is_empty() {
        return "Cline did not return an initialize response and no stderr was captured. First-run `cline auth` or install input is a likely cause; run `cline auth` in a terminal, then retry.".to_string();
    }
}
```

### Frontend touchpoints

- `BACKEND_LABELS`: `cline: 'Cline'`.
- `backendLogoId()`: `case 'cline': return 'krypton-logo-cline';`.
- `BACKEND_LOGO_SVG_DEFS`: add a `krypton-logo-cline` `<symbol>` (16×16, currentColor —
  e.g. a stylized "C" or terminal-bracket mark, consistent with the existing minimal line set).
- `laneAccent()`: append a 13th color (proposed `#56d6c0` — teal-cyan, distinct from
  existing accents).
- `laneAccentForLabel()`: `if (/cline/i.test(label)) return laneAccent(13);` (placed before
  the `-\d+$` fallback).

### MCP / Data Flow (as built — native-config overlay)

`cline` is added to the `mcpServersForLane` skip list (returns `[]`, alongside junie/cursor)
so nothing is forwarded via `session/new`. At spawn, `spawnLane` builds the lane's servers
via `clineOverlayServersForLane` (per-lane `krypton-harness-memory` + ungated spec-83 project
servers — Cline's native config reads all transports directly, so no ACP capability gating),
serializes them with `toClineMcpFile` (explicit `type`; http → `streamableHttp`), and writes
`cline_mcp_settings.json` via the `write_cline_mcp_overlay` Tauri command under
`~/.config/krypton/runtime/cline/<harness>/<lane>/`. The returned file path is passed to
`AcpClient.spawn` as `clineMcpSettingsPath` → `acp_spawn`, which sets the `CLINE_MCP_SETTINGS_PATH`
env on the child process. The overlay is removed on lane close (`remove_cline_mcp_overlay`) and
GC'd on harness start (`gc_cline_mcp_overlays`). This mirrors the Junie overlay; the shared
path-sanitizer was renamed `sanitize_junie_path_component` → `sanitize_overlay_path_component`.

### Configuration

No new TOML keys in v1. `lane_models.cline` is accepted by the generic schema but applies
no CLI flag (documented as inert until/unless Cline advertises ACP model state).

## Edge Cases

- **Cline CLI not installed** → `startup_hint` ENOENT branch → "npm i -g cline".
- **Not authenticated** → `cline auth` hint.
- **Old CLI without `--acp`** → unknown-option branch.
- **Cline drops `session/new` mcpServers** (verified: no `mcpCapabilities`) → handled by the
  native-config overlay; without it the lane would have no peer/memory tools.
- **Two Cline lanes at once** → each gets its own overlay file under
  `runtime/cline/<harness>/<lane>/`, so their distinct memory URLs don't collide.
- **CSS color var missing** → rail/directive logo falls back to currentColor (no crash).

## Open Questions

**(Resolved by verification)** *Does `cline --acp` honor MCP servers passed via ACP
`session/new`?* **No.** A live handshake against cline 3.0.24 showed `initialize`
advertises no `mcpCapabilities`, so injected http/sse servers are dropped. The
pre-authorized fallback — skip list + native `cline_mcp_settings.json` overlay — was
implemented (via `CLINE_MCP_SETTINGS_PATH`, not `prepare_cursor_mcp`'s project-local
`.cursor/mcp.json`, since Cline's settings are global and need per-lane isolation).

**(Open, needs live tool call)** *Does Cline actually load and call the overlay's
`streamableHttp` memory server in ACP mode?* The overlay path and transport tagging are
verified against the binary's schema, but an end-to-end `peer_send`/`memory_set` from a
running Cline lane has not yet been exercised. If it fails, candidates are: Cline requires
`autoApprove` for the server's tools, or it surfaces MCP tools differently in ACP mode.

## Out of Scope

- ~~Native MCP-config overlay for Cline (only if runtime verification requires it).~~
  **Now in scope / implemented** — verification required it.
- `lane_models.cline` CLI model application / model picker wiring (Cline has `-m`/`--provider`,
  but v1 leaves the model to `cline auth`/config).
- Cline usage/credit telemetry in the subscription-usage view.
- Cline Skills/Hooks surfacing in the harness UI.

## Resources

- [Cline ACP / editor integrations](https://docs.cline.bot/cli/acp-editor-integrations) — `cline --acp`, `npm i -g cline`, `cline auth`, stdio ACP, MCP/Skills/Hooks availability.
- `docs/150-acp-copilot-lane.md` — template for stdio lane + startup-hint structure.
- `docs/113-acp-cursor-lane.md` / `docs/119-acp-junie-lane.md` — native-config MCP workarounds (the fallback path).
- `docs/83-acp-shared-mcp-config.md` — `.mcp.json` bridge / `session/new` injection policy.
