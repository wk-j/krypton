# Pi-1 Lane (pi-acp Adapter) — Implementation Spec

> Status: Implemented
> Date: 2026-05-05
> Milestone: M-ACP — Harness convergence

## Problem

The ACP harness currently runs four lanes (Codex-1, Claude-1, Gemini-1, OpenCode-1) but cannot include the `pi` coding agent (`@mariozechner/pi-coding-agent` — the same family as `pi-agent-core` already used in Krypton's standalone Agent View). Users who want pi's outputs in the same multi-lane comparison have no way to do so today, and the existing in-process Pi integration in `src/agent/` is a separate view with separate UI, no shared transcript with the other lanes, and no per-lane harness memory.

## Solution

Adopt the third-party `pi-acp` adapter (https://github.com/svkozak/pi-acp) as a 5th harness backend. It speaks ACP JSON-RPC over stdio and spawns `pi --mode rpc` internally. From Krypton's perspective the wire protocol is identical to the existing four backends — the registration changes are one entry in `builtin_backends()` and one entry in `DEFAULT_HARNESS_SPAWN`, plus an arm in `inferLaneModelName`.

However — and this is the part that diverges from the other four lanes — **pi explicitly has no MCP host, no permission popups, and no `fs/*`/`terminal/*` ACP delegation.** The Spec 83 `.mcp.json` bridge and the per-lane `krypton-harness-memory` server therefore do NOT apply to Pi-1; we deliberately skip them like we skip Claude (but for the opposite reason). Pi-1 is a "lean" lane — pi's own built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) run locally and bypass Krypton's permission rail entirely. Auth, model selection, providers, and tool config are owned by pi (`~/.pi/agent/settings.json`, `~/.pi/agent/auth.json`); Krypton does not touch them.

## Research

### Pi internals (changed the design materially)

Source: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent (local checkout at `/Users/wk/Source/pi-mono`).

- **Pi has NO MCP support, by design.** From the README's Philosophy section: *"No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."* This is **not** a missing feature pending implementation — it is an explicit project stance. Implications:
  - The Spec 83 `.mcp.json` bridge cannot reach Pi-1. Even if pi-acp were to forward `session/new mcpServers`, pi has no MCP client to consume them.
  - The `krypton-harness-memory` MCP server (Spec 73) is unreachable from Pi-1 by the same logic. Pi-1 cannot read or write harness memory in v1.
  - Capability gating (`mcpCapabilities` from `initialize`) will likely report no support; the existing `filterByCapability` would already return an empty list. We can rely on that for safety, but the cleaner design is to **explicitly skip the bridge for Pi-1** in `spawnLane`, mirroring the Claude skip but with a different rationale.
- **Pi has NO permission popups, by design.** README Philosophy: *"No permission popups. Run in a container, or build your own confirmation flow with extensions inline with your environment and security requirements."* Implications:
  - Pi will execute `bash`, `edit`, `write` tools immediately when the model invokes them. There is no `permission_request` event for Krypton to gate on.
  - Krypton's permission rail (`addPermission`, `respondPermission`) will never fire for Pi-1.
  - File touches still surface as `tool_call` events with `kind: 'edit'` so `observeFileTouch` and the recently-modified file index keep working, but the user cannot intercept a destructive edit before it happens.
  - **This is a real safety delta versus the other four lanes** — must be visible in the Pi-1 lane chip, not just in docs.
- **Built-in tools are local.** Pi ships `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. They execute in the pi process (a child of pi-acp, which is a child of Krypton). No `fs/*` or `terminal/*` ACP delegation — pi-acp does not implement either side.
- **Pi auto-loads `AGENTS.md` and `CLAUDE.md`.** Walks up from `cwd` to root + `~/.pi/agent/AGENTS.md`. Pi-1 will inherit project context for free, like Claude lane does.
- **Auth model.** Pi supports OAuth subscriptions (Anthropic Pro/Max, ChatGPT Plus, Copilot) via `/login` and many provider API keys via env vars or `~/.pi/agent/auth.json`. The OAuth flow is interactive in a TTY — pi-acp's `--terminal-login` is the wrapper that opens that. **Krypton's harness does not give the agent process a TTY**, so users must run `pi-acp --terminal-login` (or `pi /login`) once outside Krypton before the Pi-1 lane will work for OAuth providers. API-key providers work without this step if the env var is set.
- **Pi sessions are JSONL with branching.** `~/.pi/agent/sessions/` organized by cwd; entries have `id`/`parentId` for in-place branches. Pi-acp maps ACP session ids to pi session files at `~/.pi/pi-acp/session-map.json`. Krypton does not interact with either store.
- **Pi telemetry/update checks.** Pi pings `pi.dev/api/latest-version` and `pi.dev/api/report-install` by default. Disable with `PI_OFFLINE=1` (env var) or `enableInstallTelemetry: false` in settings. Document this — privacy-conscious users will want to know.
- **Pi RPC framing is strict LF-only JSONL.** The README explicitly warns: *"Clients must split records on `\n` only. Do not use generic line readers like Node `readline`."* This is pi-acp's problem, not Krypton's — but it explains why pi-acp re-implements framing rather than using `readline`. If we ever consider replacing pi-acp with our own wrapper, this is a concrete trap.
- **Pi has its own skills/extensions ecosystem.** `~/.pi/agent/skills/`, `~/.pi/agent/extensions/`. Pi-acp surfaces skills as `/skill:name` slash commands. Krypton's harness already passes user input as `session/prompt` text, so `/skill:foo` Just Works. No special handling needed in the harness.
- **Custom providers.** Users can plug in any OpenAI-/Anthropic-/Google-compatible endpoint via `~/.pi/agent/models.json`. This means Pi-1 can be configured for local Ollama, OpenRouter, etc. — useful for cost/locality differentiation across lanes.

### pi-acp wire layer

Source: https://github.com/svkozak/pi-acp.

- **Adapter status: MVP**, expect minor breaking changes — pin a version when distributing.
- Streams `agent_message_chunk`, `tool_call`, `tool_call_update` (with structured diffs for `edit`). Surfaces tool locations resolved against session cwd so Krypton's "open file from transcript" path still works.
- Slash commands: `/compact`, `/autocompact on|off|toggle`, `/export`, `/session`, `/name`, `/queue`, `/changelog`, `/steering`, `/follow-up` are interpreted inside `session/prompt`. `/model` and `/thinking` map to Zed selectors — they may render as plain content in Krypton's transcript; acceptable.
- Startup info banner is on by default. Suppress with `quietStartup: true` in `~/.pi/agent/settings.json`. Document; do not auto-write.
- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises `promptCapabilities.embeddedContext`. We do NOT set it — Krypton uses plain text + image blocks.
- ACP Registry "Terminal Auth" via `pi-acp --terminal-login`. Krypton has no Authenticate UI; out of scope.

### Krypton harness (no changes needed for the new lane)

- `src-tauri/src/acp.rs:64-102` — `builtin_backends()`: single registration point.
- `src/acp/acp-harness-view.ts:136-141` — `DEFAULT_HARNESS_SPAWN`: lane defaults.
- `src/acp/acp-harness-view.ts:603-653` — `spawnLane`: where the Spec 83 bridge callback lives. We add a Pi-1 skip here.
- `src/acp/acp-harness-view.ts:2083` — `inferLaneModelName`: needs a `pi-acp` arm.
- `src/acp/acp-harness-view.ts:2176` — `laneAccent`: must support index 4 (5th lane).

### Alternatives ruled out

- **In-process Pi-as-Lane** (use `pi-agent-core` directly inside the renderer) — needs an `AgentEvent → AcpEvent` translator, no process isolation (pi crash → renderer crash), duplicates work that pi-acp does. Reconsider only if pi-acp becomes unmaintained.
- **Krypton-owned ACP wrapper around `pi-agent-core`** — same outcome as in-process but with extra IPC. Strictly worse than adopting pi-acp.

## Prior Art

| Tool | Implementation |
|------|----------------|
| Zed (target client of pi-acp) | Adds adapters via `agent_servers` map in `settings.json`. ACP Registry auto-resolves. Permission UI handled by Zed; pi-acp does not need to delegate `fs/*`. |
| Krypton (existing 4 lanes) | `builtin_backends()` hard-codes `(id, command, args, display_name)`. Permission rail + memory MCP per lane. |
| pi-acp itself | npm package; users install globally or via `npx`. Reads pi config from `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json`. |
| pi (standalone CLI) | Interactive TUI with built-in tools, sessions, branching, AGENTS.md context, OAuth/API-key auth, no MCP, no permission gate. |

**Krypton delta** — match Krypton's existing convention (hard-coded backend, no registry, no per-user backend config). Diverge from the other four lanes by skipping the `.mcp.json` bridge and memory MCP for Pi-1, since pi has no MCP host. Surface the "no permission gate" caveat in the Pi-1 lane chip (e.g., a small `⚠ unsandboxed` marker). If pi-acp adoption sticks, a follow-up spec can add a generic backend registry à la Zed's `agent_servers`.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `("pi-acp", AcpBackend { command: "pi-acp", args: [], display_name: "Pi" })` to `builtin_backends()`. |
| `src/acp/acp-harness-view.ts` | Add `{ backendId: 'pi-acp', displayName: 'Pi', count: 1 }` to `DEFAULT_HARNESS_SPAWN`. In `spawnLane()` initialize callback, add a `pi-acp` skip clause alongside the existing `claude` skip (skip the `.mcp.json` bridge and the memory server). Add a `pi-acp` arm to `inferLaneModelName`. Confirm/extend `laneAccent` to color slot 4. Add a small `⚠ unsandboxed` marker to the Pi-1 lane chip (or equivalent visual). |
| `docs/PROGRESS.md` | Record Spec 84 under M-ACP. |
| `docs/04-architecture.md` | Add Pi-1 to the lane list. Document: (a) pi has no MCP host (memory MCP unreachable, `.mcp.json` bridge skipped); (b) pi has no permission gate (file edits run immediately); (c) `pi-acp --terminal-login` prerequisite for OAuth providers. |
| `docs/06-configuration.md` | New subsection "Pi lane prerequisites": install `@mariozechner/pi-coding-agent` and `pi-acp` globally, set provider env var or run `/login`, optional `quietStartup` and `PI_OFFLINE=1`. |

No changes to `src-tauri/src/acp.rs` beyond the `builtin_backends()` entry. No changes to `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/mcp-bridge.ts`. No new Tauri commands.

## Design

### Data Structures

No new types.

### API / Commands

No new Tauri commands. The new backend flows through existing `acp_list_backends`, `acp_spawn`, `acp_initialize`, `acp_set_mcp_servers` (called with empty list for Pi-1), `acp_session_new`, `acp_prompt`, `acp_cancel`.

### Backend Registration

```rust
// src-tauri/src/acp.rs (added to builtin_backends())
(
    "pi-acp",
    AcpBackend {
        command: "pi-acp".to_string(),
        args: vec![],
        display_name: "Pi".to_string(),
    },
),
```

Rationale for `command: "pi-acp"` (not `npx -y pi-acp`): three of the four existing backends (`gemini`, `codex-acp`, `opencode`) assume the adapter is on `PATH`; only `claude` uses `npx -y` because `@agentclientprotocol/claude-agent-acp` is rarely globally installed. `pi-acp` is small and documented for global install — match the dominant convention. Avoids `npx` cold-start latency on every lane spawn.

### Lane Spawn Default

```ts
// src/acp/acp-harness-view.ts
const DEFAULT_HARNESS_SPAWN: HarnessSpawnSpec[] = [
  { backendId: 'codex',    displayName: 'Codex',    count: 1 },
  { backendId: 'claude',   displayName: 'Claude',   count: 1 },
  { backendId: 'gemini',   displayName: 'Gemini',   count: 1 },
  { backendId: 'opencode', displayName: 'OpenCode', count: 1 },
  { backendId: 'pi-acp',   displayName: 'Pi',       count: 1 },
];
```

### `spawnLane` — bridge skip for Pi-1

```ts
const info: AgentInfo = await client.initialize(async (caps) => {
  // Claude: native loader → would duplicate.
  // Pi-acp: pi has no MCP host → bridge has nowhere to land.
  if (lane.backendId === 'claude' || lane.backendId === 'pi-acp') return undefined;
  // ...existing logic...
});
```

And in `memoryServerForLane`:

```ts
private memoryServerForLane(lane: HarnessLane): AcpMcpServerDescriptor[] {
  // Pi has no MCP host — emit nothing rather than an unreachable server.
  if (lane.backendId === 'pi-acp') return [];
  if (!this.harnessMemoryId || !this.harnessMemoryPort) return [];
  // ...existing http memory descriptor...
}
```

Skipping at this layer (rather than relying on `filterByCapability`) makes the intent explicit and avoids depending on pi-acp's capability advertisement, which is undocumented in the README.

### `inferLaneModelName`

```ts
function inferLaneModelName(backendId: string, info: AgentInfo, models: Record<string, LaneModelConfig>): string | null {
  // ...existing arms for claude, gemini, codex...
  if (backendId === 'pi-acp') {
    // Pi reports the active model in agent_capabilities or in its startup
    // banner. Defensive: read whatever is there; fall back to null.
    return extractModelFromAgentInfo(info) ?? null;
  }
  if (backendId === 'opencode') return OPENCODE_DEFAULT_MODEL;
  return null;
}
```

We do NOT call `session/set_model` for Pi-1. Pi owns model selection through `~/.pi/agent/settings.json` and the user's `/model` command inside the prompt. If the user wants to switch models for Pi-1, they type `/model` in the harness composer; pi-acp forwards it; pi pops its in-process model selector inside the transcript content. (Visual fidelity may be imperfect — acceptable for v1.)

### Permission & Tool-call Flow

Unchanged code. Behaviour is degraded: pi never raises `permission_request`, so Krypton's permission rail simply doesn't trigger for Pi-1. `tool_call` and `tool_call_update` events still flow, including structured diffs for `edit` (per pi-acp), so the transcript and `observeFileTouch` stay accurate.

### UI Changes

- **Lane rail** gains a 5th entry "Pi-1" (initial status `starting`, then `idle`).
- **Accent color**: ensure `laneAccent(4)` returns a distinct color. Read the function and either use a free slot or extend the palette by one entry.
- **Unsandboxed marker** on the Pi-1 chip: a small `⚠` or `‹unsandboxed›` annotation — TBD visual. Tooltip / help-overlay text: *"Pi-1 has no permission gate; edits and shell commands run immediately. Run inside a container or sandboxed cwd if untrusted."*
- **Lane-switch shortcuts (Cmd-1..5 or similar):** if the existing wiring iterates `this.lanes.length`, no code change. Confirm during implementation.

### Configuration

No new TOML keys. User-side prerequisites documented in `docs/06-configuration.md`:

```sh
# Install pi + adapter
npm install -g @mariozechner/pi-coding-agent
npm install -g pi-acp@<pinned-version>

# Configure provider — either:
#   (a) export ANTHROPIC_API_KEY=... (or OPENAI_API_KEY, GEMINI_API_KEY, etc.) before launching Krypton
#   (b) run `pi /login` once for OAuth subscriptions (Claude Pro/Max, ChatGPT Plus, Copilot)

# Optional: suppress pi-acp's startup banner
$EDITOR ~/.pi/agent/settings.json    # add { "quietStartup": true }

# Optional: disable pi.dev telemetry / update checks
export PI_OFFLINE=1
```

## Edge Cases

- **`pi-acp` not on PATH** → ENOENT; lane → `error` with the spawn error string. User installs and uses the lane's restart shortcut.
- **`pi` not installed** → `pi-acp` spawns but `pi --mode rpc` fails. Surfaces as JSON-RPC error or system message; same `error` state.
- **No provider configured** → first prompt fails inside pi. Error surfaces in transcript.
- **OAuth provider but never logged in** → similar; user runs `pi /login` outside Krypton, then restarts the lane.
- **User puts servers in `.mcp.json`** expecting Pi-1 to see them → it won't. Document explicitly. The skip in `spawnLane` makes it a no-op rather than a silent failure.
- **Memory drawer for Pi-1** → no memory entries because Pi-1 cannot reach the memory MCP. Show empty state with a tooltip explaining why. (Or: hide the memory-drawer entry for Pi-1 entirely. Decide during implementation.)
- **User invokes `/skill:foo` or `/compact`** in the Pi-1 composer → pi-acp interprets it; works.
- **User pastes an image** → only works if pi-acp/pi advertises `promptCapabilities.image`. Existing image gating handles it.
- **pi-acp version skew breaks the wire format** → MVP risk. Pin a version; bump explicitly.
- **Telemetry sensitive users** → set `PI_OFFLINE=1` per docs.

## Open Questions

1. **Adapter install command:** `pi-acp` (global install) vs `npx -y pi-acp@<pinned>`. Recommendation: global install matches `gemini`/`codex-acp`/`opencode`. Confirm.
2. **Memory drawer for Pi-1**: hide the entry, show empty with tooltip, or show "unsupported"? Recommendation: empty with tooltip — keeps the rail symmetrical.
3. **Visual marker for "no permission gate"**: which symbol/style fits the cyberpunk aesthetic? `⚠`, `‹›`, dimmed border, alternate accent? Defer to implementation but lock in before merge.
4. **Color slot 4** in `laneAccent()`: confirm the palette can host a 5th color without clashing.
5. **Should we ship a default `quietStartup: true` write to `~/.pi/agent/settings.json` on first Pi-1 launch?** Recommendation: **no** — modifying the user's pi config is invasive. Document only.

## Out of Scope

- Generic ACP backend registry (user-defined backends in TOML). Future spec.
- In-process `pi-agent-core` lane wiring `src/agent/` into the harness. Future spec.
- ACP Terminal Auth UI inside the harness.
- Wrapping pi's built-in tools with Krypton's permission rail (would require a pi extension, not a harness change).
- Mirroring pi's session JSONL files into harness memory.
- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` resource blocks.
- Custom slash-command palette/autocomplete for pi commands — they work as plain text.

## Resources

- [pi-acp README](https://github.com/svkozak/pi-acp) — adapter capabilities, install, slash commands, limitations
- [pi-coding-agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — pi internals, philosophy ("No MCP", "No permission popups"), built-in tools, sessions, AGENTS.md, providers, telemetry
- [pi RPC protocol docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) — strict LF-JSONL framing rationale
- [pi settings docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md) — `quietStartup`, `steeringMode`, `followUpMode`, telemetry opt-out
- [Agent Client Protocol spec](https://agentclientprotocol.com/overview/introduction) — `mcpCapabilities`, `promptCapabilities`, `session/new`, `session/set_model`
- `docs/72-acp-harness-view.md` — existing harness architecture and `AcpClient` API surface
- `docs/83-acp-shared-mcp-config.md` — `.mcp.json` bridge that this lane explicitly skips
- `docs/73-acp-harness-mcp-memory.md` — per-lane memory MCP that Pi-1 cannot use
- `src-tauri/src/acp.rs:64-102` — `builtin_backends()` (registration point 1)
- `src/acp/acp-harness-view.ts:136-141` — `DEFAULT_HARNESS_SPAWN` (registration point 2)
- `src/agent/agent.ts` — existing in-process pi integration, for future Pi-as-Lane spec
