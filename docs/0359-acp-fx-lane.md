# ACP fx Lane — Implementation Spec

> Status: Implemented
> Date: 2026-11-04
> Milestone: ACP Harness — backends

## Problem

[fx](https://github.com/vercel-labs/fx) (Vercel Labs) is a native Zig coding agent with a first-party ACP server (`fx acp`). Krypton's ACP harness has no `fx` backend, so it cannot run as a lane next to the other thirteen.

## Solution

Register `fx` as a PATH backend launched as `fx acp`. That is exactly what fx documents for ACP clients. After spawn, everything runs on the generic lane path: sessions, resume/load, `#new`, the `.mcp.json` bridge, the memory MCP server, permissions and images. A live `fx acp` 0.0.16 handshake confirmed this (see Research). fx exposes three backend-agnostic gaps, and all are fixed here:

1. Model selection takes the first `category: "model"` config option. For fx that option is the **provider** select (`gateway`/`codex`/`grok`), so the chip, the picker and `lane_models` all target the wrong option. The fix prefers the `category: "model"` select whose `id` is `"model"`.
2. The generic `startup_hint` fallback gives Claude/npm advice. An fx branch replaces it.
3. Harness auto-allow does not recognize fx's `mcp_<server>_<tool>` tool qualification, so every built-in harness tool call would wait on the human. Found during implementation; see Implementation Notes.

## Research

**Live probe** (`fx acp`, fx 0.0.16 signed in via Codex subscription, temp cwd, 2026-11-04):

- `initialize` returned:
  - `protocolVersion: 1`, `loadSession: true`, `authMethods: []`;
  - `promptCapabilities {image: true, audio: false, embeddedContext: true}`;
  - `mcpCapabilities {http: true, sse: false, acp: false}`;
  - `sessionCapabilities {list, resume, close, systemPrompt}`;
  - `agentCapabilities._meta.fx.steering: true`.
- `session/new` returns no `models` object. It returns `configOptions` in this order:
  1. `provider` (category `model`);
  2. `model` (category `model`, 8 ids, current `gpt-6.1-sol`);
  3. `mode` (category `mode`: `auto`/`ask`/`full-access`);
  4. `effort` (category `thought_level`);
  5. `fast` (category `model`, select `"false"`/`"true"`).

  It also returns a legacy `modes` object (current `auto`).
- One prompt turn produced `available_commands_update` (empty), `agent_message_chunk` (with `messageId`), `session_info_update` (title), `usage_update {used, size}`, then `{stopReason: "end_turn", usage}`. The harness already consumes all of these.
- `session/set_config_option {configId: "model"}` succeeds.
- A second `session/new` on the same connection succeeds, so the `#new` path works.
- `session/load` replays `user_message_chunk` and `agent_message_chunk`.
- **Not signed in** (`HOME` pointed at an empty dir): `initialize` itself fails with `-32600 "fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY."` and stderr is empty. `acp.rs:2616-2621` already puts that message first. The hint appended after it currently reads "Adapter `fx` failed to start."
- **Old fx without the subcommand:** stderr is `fx: unknown subcommand: <name>`.

**fx docs** ([ACP server](https://fx.sh/docs/using-fx/acp)):

- Client `mcpServers` merge with the approved servers from the project `.mcp.json`. A client entry wins over a project entry with the same name, so Krypton's bridge creates no duplicates.
- `~/.fx/mcp.json` profile servers are inherited only when the client sets `_meta.fx.profileMcpServers: true`.
- Steering is `session/prompt` with `_meta.fx.steer: true`.

**Krypton defaults an unlisted backend gets**, confirmed in code:

- `readTextFile` is advertised (`acp.rs:1510`).
- The initialize timeout is 30 s (`acp.rs:2582`).
- The memory server and capability-gated `.mcp.json` servers are passed via `session/new`. fx's `http: true` keeps the HTTP memory server (`acp-harness-view.ts:8077-8117`, `mcp-bridge.ts:314`).
- The computer capability is reached through the in-process MCP header.
- Resume/load/list are gated by capabilities only (`harness-format.ts:167`).
- Permission auto-allow is decided by tool-name shape.
- Remote harnesses work when `fx` is on the remote `PATH`. fx ships for macOS and Linux, x86_64 and arm64.

**The model-option bug.** `parse_config_model_option` (`acp.rs:571`) is shared by `session/new`, resume/load and `config_option_update`. It uses `.find()` on the first `category: "model"` select. For fx this means:

- the chip shows `codex`;
- the picker lists the three providers;
- `lane_models.fx.active = "gpt-6-luna"` is sent as `configId: "provider"`, rejected, and the chip turns amber.

ACP does say to break category ties by array order. But a provider is not a model, and ACP's own example uses `id: "model"`.

**Steering mismatch.** Spec 278 reads the top-level `_meta.steering.supported` and sends `_session/steering`. fx advertises steering under `agentCapabilities._meta.fx` instead. fx lanes therefore get `supportsSteering = false` and keep the existing non-steering path. That is correct, just not the best fx can do.

**Alternatives ruled out:**

- Pass `fx acp --model <id>` at spawn (the Droid path). This loses the in-lane picker and live switching.
- Keep a per-backend table mapping backend to config id. The generic `id == "model"` preference covers fx with less code and leaves OpenCode unchanged (its only model select is already `id: "model"`).

## Prior Art

| Client | Implementation | Notes |
|--------|---------------|-------|
| Any ACP client (Zed, etc.) | fx docs: `{"command": "/abs/path/fx", "args": ["acp"]}`, server cwd = project | `--model`, `--permission-mode`, `--provider` flags optional |
| Krypton MiMo / Cline | PATH entry in `builtin_backends()`, `startup_hint` branch, label/logo/palette/CSS | Same shape as fx |
| Krypton OpenCode | Model via `configOptions` select + `session/set_config_option` | The path fx uses after the fix |

**Krypton delta.** Krypton uses the documented command with no flags, so fx keeps the user's saved provider and permission mode (default `auto`). There is no sandbox chip, because fx has its own permission gate and runs commands in a sandbox in every mode except `full-access`.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | `fx` entry in `builtin_backends()`; `parse_config_model_option` prefers `id == "model"`; `fx` arm in `startup_hint` (before the generic `/login` fallback); tests |
| `src-tauri/src/config.rs` | Add `fx` to the `lane_models` doc comment |
| `src/config.ts` | Add `fx` to the `lane_models` doc comment |
| `src/acp/harness-lane-identity.ts` | `BACKEND_LABELS.fx = 'fx'`; `backendLogoId` case; `/^fx(-|$)/i` → slot 15; 15th entry in `laneAccent` and `LANE_ACCENT_PALETTE` |
| `src/acp/harness-icons.ts` | `krypton-logo-fx` symbol; count comment |
| `src/styles/harness-shared.css` | `--krypton-backend-fx` (dark + light scheme) |
| `src/acp/components/rail-entry/rail-entry.css` | `.acp-harness__rail-logo--fx` |
| `src/acp/components/inter-lane-row/inter-lane-row.css` | `.acp-harness__lane-mail-logo--fx` |
| `src/acp/components/assistant-instances/assistant-instances.css` | `.acp-assistant-instances__logo--fx` |
| `src/acp/harness-permission-scan.ts` | Recognize fx's `mcp_<server>_<tool>` form for built-in harness tools (auto-allow + timeline); a foreign `mcp_`-qualified title cannot borrow timeline privileges |
| `src/acp/acp-harness-view.test.ts` | Palette tests 14 → 15 (incl. `pickLaneAccent` last-index cases); fx accent + logo cases; fx permission auto-allow cases |
| `docs/0006-configuration.md` | Backend id list, command table, auth list, "fx lane prerequisites", spec cross-ref, lane_models keys + model bullet |
| `docs/0004-architecture.md` | Supported backend list (`:200`) |
| `docs/README.md` | Index row 359 |

No new Tauri commands, TS client changes, or MCP overlay.

## Design

### Backend registration

```rust
(
    "fx",
    AcpBackend {
        // Vercel Labs fx: native ACP server over stdio (docs/0359-acp-fx-lane.md).
        command: "fx".to_string(),
        args: vec!["acp".to_string()],
        display_name: "fx".to_string(),
    },
),
```

The picker sorts fx by id after the five pinned backends. `HARNESS_BACKEND_ORDER` is unchanged.

### Model option selection

```rust
fn parse_config_model_option(config_options: Option<&Value>) -> Option<SessionModelState> {
    let selects: Vec<&Value> = config_options?.as_array()?.iter()
        .filter(|o| category == "model" && type == "select")
        .collect();
    // fx lists `provider` and `fast` under category "model" ahead of/after the
    // real model select; ACP's own example names it `model`. Prefer that id,
    // else keep the agent's ordering (first match).
    let option = selects.iter().find(|o| id == "model").or_else(|| selects.first())?;
    …unchanged…
}
```

This applies to every caller: `session/new`, resume/load, `config_option_update`, and the live `acp_set_lane_model` switch through `ModelControl::ConfigOption("model")`.

### Startup hint (`startup_hint`, `backend_id == "fx"`)

| stderr match | Hint |
|---|---|
| `command not found` / `enoent` / `no such file` | Install fx: `curl -fsSL https://fx.sh/setup.sh \| bash` (installs to `~/.local/bin`), then restart Krypton so the login-shell PATH cache includes `fx`. |
| `unknown subcommand` | Your fx predates ACP mode (`fx acp`). Run `fx upgrade`. |
| empty | fx wrote no diagnostics. Run `fx doctor` in a terminal to check sign-in (`fx login`) and setup, then retry. |

The empty-stderr row is the not-signed-in case. fx's own `-32600` message comes before it, so the lane reads: fx's reason, then the next step.

### Identity and chrome

- Label `fx`, so lanes are named `fx-1`, `fx-2`. The regex is anchored, like Pi and OMP, so labels such as `gfx-1` do not match.
- 15th palette slot is lime `#c6f05a` / rgb `198, 240, 90`. It is distinct from the 14 existing slots.
- `--krypton-backend-fx` is `#c6f05a` on dark and `#5f7f12` on the light scheme.
- `krypton-logo-fx` is a 16×16 stroke glyph: a hooked script `f` (stem with a top hook and a crossbar) plus a small `x` at the lower right. It uses the same `currentColor` stroke style as its siblings.

### Data flow

```
1. Cmd+P → + → picker lists "fx" → spawnLane(fx)
2. acp_spawn: `fx acp` with login env, cwd = project
3. initialize → caps (http MCP, image, loadSession, resume)
4. session/new {cwd, mcpServers: memory + gated .mcp.json}
5. parse_session_model_state → ConfigOption("model"); chip = current model
6. lane_models.fx.active set → session/set_config_option {configId: "model"}
7. prompts / tool calls / permissions on the generic path
```

### Configuration

No new keys. Optional:

```toml
[acp_harness.lane_models.fx]
active = "gpt-6-luna"   # must be in the model list of fx's saved provider
```

## Implementation Notes

Deviations from the approved design:

- **Permission auto-allow (gap 3).** A live smoke (fx 0.0.16, Krypton's exact `initialize` params, an HTTP MCP stand-in for `krypton-harness-memory` passed through `session/new.mcpServers`) showed the following:
  - fx connects to the server lazily, on the first tool use. It POSTs `server/discover`, `initialize`, `tools/list` and `tools/call`, carries the `x-krypton-computer-capability` header, and tolerates a 405 on the SSE `GET`.
  - Every MCP call raises `session/request_permission`, even in `auto` mode. The toolCall `name`/`title` is `mcp_krypton-harness-memory_<tool>`, there is no server key, and the options are `allow_once`/`allow_always`/`reject_once`.
  - `harnessAutoAllowToolName` returned `null` for that shape, because it only knew the `mcp__<server>__<tool>` and `<server>/<tool>` forms. Every `handoff_set`, `peer_send`, `attention_flag` and `timeline_*` call would therefore have waited on the human.

  `harness-permission-scan.ts` now matches the `^mcp_<harness server>_<tool>$` form, with the server anchored to `krypton-harness-(bus|memory)` and the tool restricted to the auto-allow set. The timeline guard also treats any `mcp_`-prefixed title as a foreign qualified name, so another fx server's tool cannot claim timeline privileges through its content text.
- **Empty-stderr hint wording.** It now reads "fx wrote no diagnostics", because in the not-signed-in case fx *does* answer `initialize` (with an error).
- **Live model switch** through `session/set_config_option {configId: "model"}` was confirmed against fx 0.0.16. The smoke did not launch the Krypton app itself; the lane UI (logo, accent, picker) is covered by unit tests only.
- **Lane-context as text (post-ship, user-reported).** Lanes that advertise `embeddedContext` get the lane-context packet as a `resource` block with `uri: krypton://acp-harness/lane-context.md`. fx treats every resource URI as a target for scoped `AGENTS.md` loading and accepts only absolute local `file://` URIs. For any other URI it posts `[context] project instructions action=omitted reason=unsafe target …` once per session. Krypton has no `session.notices` capability, so fx falls back to sending this as an agent message, and it rendered as an AGENT row. fx inlines the resource text into the prompt either way (`File: <uri>\n<text>`), so `buildPromptBlocks` now sends fx the packet as a plain `text` block. The model sees the same content, minus the `File:` header. Verified live: no notice, and the model answers from the packet.

## Edge Cases

- **`fx` not on PATH** → the spawn fails; the fx install hint is shown.
- **Not signed in** → `initialize` errors with fx's message plus the `fx doctor` hint, and the lane goes to `error`.
- **`active` model not offered by the saved provider** → `set_config_option` is rejected (non-fatal), the chip turns amber, and the lane runs fx's current model.
- **Provider switching** is not exposed. The model list follows fx's saved provider (`fx login …` / `/model` in fx). A `config_option_update` that changes the list is re-parsed by the same function.
- **Global fx MCP servers** (`~/.fx/mcp.json`) are not loaded in lanes. Lanes get the memory server and the project `.mcp.json`, the same as other lanes.
- **SSE MCP servers** in `.mcp.json` are dropped by `filterByCapability` (`sse: false`).
- **Remote harness** → the backend is offered and needs `fx` on the remote PATH. The missing-CLI hint applies.
- **Mid-turn input** → `supportsSteering` is false, so input takes the existing non-steering path.

## Open Questions

None.

## Out of Scope

- fx steering (`_meta.fx.steer`): a separate adapter for spec 278's steering contract.
- Surfacing fx `mode` / `effort` / `fast` / `provider` options in lane chrome.
- fx in the backend update check (spec 322). fx checks for updates itself, and `fx upgrade` installs them.
- A usage meter for fx (`usage-store.ts` `providerForBackend`).
- `_meta.fx.profileMcpServers` and session `systemPrompt` injection.
- Fixed rosters (`#polly`, `#debby`, `#salty`).

## Resources

- [vercel-labs/fx](https://github.com/vercel-labs/fx): install, `fx acp`, `fx ask`, permissions overview, platforms.
- [fx ACP server docs](https://fx.sh/docs/using-fx/acp): launch command, supported methods, config options, MCP merge rules, steering `_meta`.
- [ACP Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options): category semantics and the ordering tie-break that the `id == "model"` preference departs from.
- Local `fx acp` 0.0.16 probe (`initialize`, `session/new`, one prompt, `set_config_option`, a second `session/new`, `session/load`, unauthenticated `initialize`, unknown subcommand).
- `docs/0159-acp-cline-lane.md`, `docs/0287-acp-antigravity-lane.md`: sibling backend specs (registration checklist, palette growth).
- `docs/0278-acp-harness-steering.md` (steering), `docs/0127-acp-lane-model-picker.md` (model picker): contracts this spec relies on.
