# Droid-1 Lane (Factory Droid Native ACP) — Implementation Spec

> Status: Implemented
> Date: 2026-05-07
> Milestone: M-ACP — Harness convergence

## Problem

The ACP harness currently runs five lanes (Codex-1, Claude-1, Gemini-1, OpenCode-1, Pi-1). Factory's Droid CLI is a popular keyboard-driven coding agent with first-party ACP support, but Krypton has no lane for it. A 6th "Droid-1" lane lets users compare Factory's hosted models (Claude, GPT, Gemini, etc., routed through Factory) against the existing lanes in the same multi-lane transcript.

## Solution

Adopt Droid's **native** ACP mode (`droid exec --output-format acp`) as the 6th harness backend. Factory ships ACP support in the official `droid` CLI — no third-party wrapper is required. The wire format is identical to the existing five lanes, so the registration is one entry in `builtin_backends()`, one in `DEFAULT_HARNESS_SPAWN`, and one in `laneAccentForLabel`. Droid is a full-featured agent (not "lean" like Pi): it has its own permission gate (autonomy levels), tool calls, slash commands, and accepts external MCP servers, so the Spec 83 `.mcp.json` bridge and the per-lane memory MCP both apply normally — Droid-1 is a "regular" lane in the Codex/Claude/Gemini/OpenCode mold.

## Research

### Native ACP (changed the design)

Source: https://docs.factory.ai/integrations/zed (verified 2026-05-07).

- **Droid has first-party ACP support** since the integration shipped for Zed. The Zed config is literally:
  ```json
  "agent_servers": {
    "Factory Droid": {
      "type": "custom",
      "command": "<path-to-droid>",
      "args": ["exec", "--output-format", "acp"]
    }
  }
  ```
  No npm adapter, no `--input-format stream-json`, no glue code.
- `droid exec --help` confirms: `-o, --output-format <format>` accepts `acp`. Default model is `claude-opus-4-7`. `--auto low|medium|high` controls autonomy. `--skip-permissions-unsafe` short-circuits the permission gate (we will NOT pass this flag).
- **Implication for the existing skeleton in this repo:** the previously-stubbed `("droid", AcpBackend { command: "droid-acp", args: [], display_name: "Droid" })` in `src-tauri/src/acp.rs` and the matching entries in `src/acp/acp-harness-view.ts` were targeting the third-party `droid-acp` npm wrapper (https://github.com/kingsword09/droid-acp). That wrapper is unnecessary now that native ACP exists. We replace `command: "droid-acp"` with `command: "droid", args: ["exec", "--output-format", "acp"]`. The third-party adapter is MVP-status with version-skew risk; the native CLI is maintained by Factory and ships with the rest of the product.

### Auth

- **API key (preferred for headless harness):** `export FACTORY_API_KEY=fk-...` in the user's shell. Krypton's ACP spawn block already injects the full login env via `cached_login_env()` (yesterday's fix), so no extra plumbing is needed.
- **Device-code OAuth flow:** interactive browser-based login. Like every OAuth flow we've integrated (Pi `/login`, Claude `/login`), this needs a TTY to print the device code and prompt for confirmation. Krypton gives the agent process pipes, not a TTY, so users on this path must run `droid` once outside Krypton to seed creds (Factory stores them under `~/.factory/`). Document this; do not try to wrap the device-code UX inside a transcript.
- **Account creation / billing** are out of scope per Factory's docs ("You cannot create a Factory account or manage billing from inside Zed.").

### MCP

- Droid's CLI accepts MCP servers (the `droid mcp` subcommand exists for managing them) and the ACP mode is expected to honor `session/new mcpServers` like Codex/Gemini/OpenCode. **Do not** add a `spawnLane` skip clause for Droid-1 — let `filterByCapability` handle gating from `agentCapabilities.mcpCapabilities` advertised in `initialize`. Same for `memoryServerForLane`: Droid-1 gets the per-lane HTTP memory server like the other "regular" lanes.
- Factory's docs reference Zed's `context_servers` section for MCP config; that's the Zed-side MCP setup. Krypton's bridge (`.mcp.json` translated into `session/new mcpServers`) is the equivalent path on our side.

### Permission model

- Droid uses a tiered autonomy system. Default is read-only; `--auto low|medium|high` widens it. Within ACP, this should surface as `permission_request` events for tool calls that exceed the current autonomy level — Krypton's existing permission rail consumes those events unchanged.
- We will **not** pass `--auto high` or `--skip-permissions-unsafe` by default. Users who want broader autonomy can configure it later (Out of Scope below). Krypton's permission popups remain the gate.

### Slash commands and UX

- Droid (the CLI) supports `/login`, `/help`, MCP management, sessions, etc. Whether each command is interpreted in ACP mode or treated as plain prompt text is determined by Droid; either way Krypton's harness passes the input verbatim through `session/prompt`. No special handling needed.
- Default model is `claude-opus-4-7`. Users can override via the `acp_harness.lane_models` TOML key (existing mechanism) — implementation detail in §`inferLaneModelName` below.

### Existing skeleton in this repo (not via this spec)

`src-tauri/src/acp.rs` and `src/acp/acp-harness-view.ts` already contain partial Droid wiring (`command: "droid-acp"` + `DEFAULT_HARNESS_SPAWN` entry + `laneAccentForLabel` arm). This spec **replaces** the command/args (native CLI, not npm wrapper) and adds the missing pieces: `inferLaneModelName` arm, CSS grid bump if needed for a 6th chip, doc updates.

### Alternatives ruled out

- **Third-party `droid-acp` npm wrapper** (current skeleton). Functional but adds a moving part, MVP-status, redundant given Factory's native support. Drop it.
- **`droid exec --input-format stream-json`** without `--output-format acp`. That's Factory's own multi-turn stream protocol, not ACP — would need a custom client; rejected.
- **In-process Droid** — no SDK distributed; not viable.

## Prior Art

| Tool | Implementation |
|------|----------------|
| Zed | `agent_servers."Factory Droid" → command: droid, args: ["exec", "--output-format", "acp"]`. Auth via `FACTORY_API_KEY` env or browser device-code flow. |
| Krypton (existing 5 lanes) | `builtin_backends()` hard-codes `(id, command, args, display_name)`. Permission rail + `.mcp.json` bridge + memory MCP for "regular" lanes (Codex/Claude/Gemini/OpenCode); skips for "lean" lanes (Pi). |
| Factory Droid CLI standalone | Interactive TUI with autonomy levels, sessions, MCP, worktrees. ACP mode is `--output-format acp` on the `exec` subcommand. |

**Krypton delta** — match the Zed config exactly (`droid exec --output-format acp`). Treat Droid-1 as a "regular" lane like Codex/Claude/Gemini/OpenCode: full bridge, full memory MCP, permission rail engaged. The only Krypton-specific concession is the OAuth-needs-TTY caveat shared with Pi-1 / Claude (document, do not wrap).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Update existing `droid` entry in `builtin_backends()`: `command: "droid"`, `args: vec!["exec".into(), "--output-format".into(), "acp".into()]`. |
| `src/acp/acp-harness-view.ts` | Add `droid` arm to `inferLaneModelName` (return `null` — Droid picks via `-m` flag if user sets `acp_harness.lane_models["droid"]`). Confirm `DEFAULT_HARNESS_SPAWN` and `laneAccentForLabel` already cover Droid (they do — keep). If `lane_models` override is set for `droid`, append `["-m", model_id]` to spawn args (parallel to how Gemini handles it). |
| `src/styles/acp-harness.css` | Bump lane-rail grid from 8-col to 9-col if the rail uses a fixed column count (verify; Spec 84 already widened to 8 for Pi). Leave alone if it's flex-based. |
| `docs/PROGRESS.md` | Record Spec 86 under M-ACP. |
| `docs/04-architecture.md` | Add Droid-1 to the lane list. Note: regular lane (bridge + memory MCP active); auth via `FACTORY_API_KEY` env; device-code OAuth needs TTY workaround. |
| `docs/06-configuration.md` | New subsection "Droid lane prerequisites": install Factory Droid CLI, set `FACTORY_API_KEY`, optional `acp_harness.lane_models["droid"] = "<model-id>"`. |

No changes to `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/mcp-bridge.ts`. No new Tauri commands.

## Design

### Data Structures

No new types.

### Backend Registration

```rust
// src-tauri/src/acp.rs (replace the current droid stub)
(
    "droid",
    AcpBackend {
        command: "droid".to_string(),
        args: vec![
            "exec".to_string(),
            "--output-format".to_string(),
            "acp".to_string(),
        ],
        display_name: "Droid".to_string(),
    },
),
```

### Lane Spawn Default

`DEFAULT_HARNESS_SPAWN` already contains `{ backendId: 'droid', displayName: 'Droid', count: 1 }` — keep as-is. Lane order: Codex → Claude → Gemini → OpenCode → Pi → Droid (slots 1..6).

### Model Override

```ts
// src/acp/acp-harness-view.ts inferLaneModelName
if (backendId === 'droid') {
  // Droid takes -m via CLI flag, applied at spawn time (not via session/set_model).
  // Returning null here means "no post-spawn override"; the spawn-time arg path
  // mirrors Gemini's --model handling.
  return null;
}
```

In the spawn-arg construction path (where Gemini's `--model` is appended for `lane_models["gemini"]`), add a parallel branch: if `backendId === 'droid'` and the user set `acp_harness.lane_models["droid"]`, append `["-m", model]` to the backend args before spawn. If unset, Droid uses its default (`claude-opus-4-7`).

### Permission & Tool-call Flow

Unchanged. Droid raises `permission_request` for tool calls beyond the current autonomy level; Krypton's existing rail handles it. No `--auto` flag passed at spawn — start at Droid's safe default.

### MCP Bridge

Unchanged. `spawnLane` calls `acp_set_mcp_servers` with the `.mcp.json`-derived list (Spec 83) capability-gated against `agentCapabilities.mcpCapabilities`. `memoryServerForLane` returns the per-lane HTTP memory descriptor (Spec 73). If Droid's ACP impl chooses to advertise no MCP capabilities, both lists become no-ops automatically.

### UI Changes

- Lane rail gains a 6th entry "Droid-1". Already wired via `DEFAULT_HARNESS_SPAWN` + `laneAccentForLabel` (slot 6).
- **No** `⚠ unsandboxed` chip — Droid has a permission gate.
- CSS grid for the lane chip header: verify that Spec 84's 8-col `grid-template-columns` at `src/styles/acp-harness.css:108` still fits a 6-lane rail. The lane rail is a separate grid (likely flex or `repeat(auto-fit, ...)`); confirm during implementation, widen if pinned.

### Configuration

No new TOML keys. Optional user-side prerequisites in `docs/06-configuration.md`:

```sh
# Install Factory Droid CLI (https://docs.factory.ai/cli/getting-started/overview)
brew install factory  # or per Factory's install docs

# Auth — preferred path: API key
export FACTORY_API_KEY=fk-...

# Or: run `droid` once outside Krypton to complete the device-code OAuth flow.

# Optional: pin a specific model for the Droid lane
# In ~/.config/krypton/krypton.toml
# [acp_harness.lane_models]
# droid = "gpt-5"
```

## Edge Cases

- **`droid` not on PATH** → ENOENT; lane → `error` with the spawn error string. User installs and restarts the lane.
- **Older `droid` without `--output-format acp`** → spawn succeeds but ACP handshake fails. Surfaces as initialize timeout. User upgrades.
- **No auth configured** → first prompt fails inside Droid; error surfaces in transcript.
- **Device-code OAuth path** → Krypton has no TTY; user runs `droid` once outside Krypton, then the cached creds in `~/.factory/` cover the harness lane.
- **User pastes an image** → only works if Droid advertises `promptCapabilities.image`. Existing image gating handles it.
- **Model override doesn't exist on Factory's hosted catalog** → Droid errors out at spawn or first call; user fixes the TOML.
- **Autonomy too restrictive for the user's workflow** → permission popups for every tool call. Document the existing autonomy ladder; do not auto-bump.

## Open Questions

1. **Should Droid-1 default to `--auto medium`** to reduce permission-popup fatigue, or keep the safest default (read-only ⇒ frequent popups)? **Recommendation: keep default.** Permission popups are Krypton's safety contract; users opt into broader autonomy explicitly.
2. **Where does Droid surface its current autonomy level in the lane chip?** Probably nowhere in v1 — same as Codex/Claude. If Factory exposes it via `agent_capabilities`, future spec.
3. **CSS grid bump** — needs visual verification at 6 lanes. Defer to implementation; widen `grid-template-columns` only if the rail wraps unintentionally.

## Out of Scope

- Wiring `--auto`, `--skip-permissions-unsafe`, `--worktree`, `--mission`, or other Droid CLI flags into Krypton config. Future spec if user demand surfaces.
- Mission mode (multi-agent worker pool inside a single lane). Architecturally interesting but doesn't fit the harness's one-lane-one-agent model.
- Custom slash-command palette/autocomplete for Droid commands.
- ACP Authenticate UI inside the harness (device-code OAuth).
- Replacing the current `droid-acp` (third-party) skeleton in a backwards-compatible way — we drop it outright since it isn't shipped yet (uncommitted skeleton).

## Resources

- [Factory Droid Zed Integration](https://docs.factory.ai/integrations/zed) — exact `agent_servers` config; verified native ACP via `droid exec --output-format acp`; auth modes
- [Factory CLI overview](https://docs.factory.ai/cli/getting-started/overview) — install, model catalog, autonomy ladder
- `droid exec --help` (local CLI v installed at `/opt/homebrew/bin/droid`) — confirmed `--output-format acp`, default model `claude-opus-4-7`, `--auto`/`-m` flags
- [Agent Client Protocol spec](https://agentclientprotocol.com/overview/introduction) — `mcpCapabilities`, `promptCapabilities`, `session/new`, `session/set_model`
- `docs/72-acp-harness-view.md` — existing harness architecture and `AcpClient` API
- `docs/83-acp-shared-mcp-config.md` — `.mcp.json` bridge (applies to Droid-1)
- `docs/73-acp-harness-mcp-memory.md` — per-lane memory MCP (applies to Droid-1)
- `docs/84-acp-pi-lane.md` — sibling lane spec; Droid-1 is the "regular lane" inverse of Pi-1's "lean lane"
- `src-tauri/src/acp.rs:46-90` — `builtin_backends()` (registration point 1)
- `src/acp/acp-harness-view.ts:138-143` — `DEFAULT_HARNESS_SPAWN` (registration point 2)
- Third-party `droid-acp` npm package (https://github.com/kingsword09/droid-acp) — considered and rejected in favor of native ACP
