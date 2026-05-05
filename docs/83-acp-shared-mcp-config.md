# Shared `.mcp.json` for ACP Harness Lanes — Implementation Spec

> Status: Implemented
> Date: 2026-05-05
> Milestone: M-ACP — Harness convergence

## Problem

Krypton's ACP harness runs four lanes (Claude-1, Codex-1, Gemini-1, OpenCode-1) over the same project, but each lane currently exposes a different set of MCP tools because each adapter loads its **own** native config file. A user who configures `serena`, `playwright`, etc. in `.mcp.json` for Claude Code gets those tools only on the Claude lane; the other three lanes are blind to them. Goal: let `.mcp.json` (the standard Anthropic project-scope MCP file) act as the single source of truth so every lane sees the same servers without per-adapter config duplication.

## Solution

Read `.mcp.json` from the harness `projectDir` on the frontend, translate its object-shaped `env`/`headers` into ACP's array-shaped `{name, value}` entries, expand `${VAR}` against the cached login env, and inject the resulting `McpServer[]` into `session/new` for **non-Claude lanes only** (Claude Code's adapter already loads `.mcp.json` natively — re-injecting would duplicate every server). Capability-gate `http`/`sse` types against `agentCapabilities.mcpCapabilities` advertised in the `initialize` response and skip incompatible servers per lane. The `krypton-harness-memory` server continues to be appended after the bridge list.

## Research

- **All four ACP adapters auto-load their own native MCP configs** when started — Claude reads `.mcp.json` + `~/.claude.json`, Gemini reads `~/.gemini/settings.json` + `.gemini/settings.json`, Codex reads `~/.codex/config.toml`, OpenCode reads `opencode.json`. Pushing the same server name via `session/new` on top of native loading risks duplicates only on the lane whose **native** format already lists it. For the cross-lane bridge to add value, the user is expected to put servers in `.mcp.json` and **not** repeat them in `~/.gemini/settings.json` etc. Document this contract.
- **Schema mismatch**: Claude's `.mcp.json` uses `env: { KEY: "value" }` and `headers: { "X-Foo": "bar" }` (objects). ACP's `session/new mcpServers` uses `env: [{ name, value }, ...]` and `headers: [{ name, value }, ...]` (arrays). Translation is mandatory.
- **Env var expansion**: Claude Code expands `${VAR}` and `${VAR:-default}` inside `command`, `args`, `env` values, `url`, and `headers` values. We must mirror this so a `.mcp.json` written for Claude works unchanged on other lanes. Source for env values: `cached_login_env()` already added to `pty.rs` for the Helix-env fix; promote it to a shared helper.
- **ACP capability negotiation**: Per the ACP schema, `stdio` MUST be supported by every agent; `http` and `sse` MUST only be sent if the agent advertised `agentCapabilities.mcpCapabilities.http` / `.sse` in its `initialize` response. Codex and OpenCode are stdio-first; Gemini varies by version. The bridge must filter.
- **Where today's bridge lives**: `src/acp/acp-harness-view.ts:637` (`memoryServerForLane`) is the single producer of `AcpMcpServerDescriptor[]` passed to `AcpClient.spawn` (line 604). The Rust side (`src-tauri/src/acp.rs:760-774`) blindly forwards whatever the frontend sends. Adding a second producer beside `memoryServerForLane` is the minimal change.
- **Alternatives ruled out**: (a) writing translated configs to `~/.gemini/settings.json` etc. — invasive, modifies user files outside Krypton, hard to clean up. (b) doing the translation in Rust — frontend already owns the `projectDir` and the per-lane spawn, keeping the bridge in TS keeps Rust agnostic of Claude's config format.

## Prior Art

| Tool | Implementation |
|------|----------------|
| Zed (multi-agent panel) | Each agent uses its own native config; no cross-agent bridging. Users edit per-agent config files. |
| Claude Code itself | `.mcp.json` (project) + `~/.claude.json` (user) + managed-settings (enterprise). Three-tier scope, env-var expansion, object-form `env`. |
| Gemini CLI | `mcpServers` block in `~/.gemini/settings.json` (user) and `.gemini/settings.json` (project). Object-form `env`. Loaded regardless of ACP mode. |
| Codex | `[mcp_servers.<name>]` in `~/.codex/config.toml`. TOML-tabled, stdio-only in mainline. |
| OpenCode | `mcp` block in `opencode.json` with `type: "local"` (= stdio) or `"remote"` (= http). Object-form `env`. |
| Cline / Continue / Roo Code | Each tool ships its own MCP-config file format. No cross-tool standard. |

**Krypton delta** — no other harness today uses one project-scope MCP file as the source of truth for multiple heterogeneous agents. Krypton picks `.mcp.json` because (a) it is already the file users keep version-controlled in their repos, (b) Anthropic publishes a stable schema, (c) the Claude lane is the most common case so zero-config for that lane is desirable. Other lanes opt in by virtue of being in the harness with a project that has `.mcp.json`.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/mcp-bridge.ts` | NEW — read & translate `.mcp.json` to `AcpMcpServerDescriptor[]`. |
| `src/acp/acp-harness-view.ts` | Call bridge alongside `memoryServerForLane`; merge & dedupe by `name`; skip bridge for `claude` backend. |
| `src/types.ts` | Extend `AcpMcpServerDescriptor` only if needed (likely already covers stdio/http/sse). |
| `src-tauri/src/lib.rs` | Register new command `read_mcp_config_file`. |
| `src-tauri/src/acp.rs` | Add `read_mcp_config_file(path) -> Result<String, String>` and `acp_get_login_env() -> Result<HashMap<String,String>, String>` (or expose existing cached env). |
| `src-tauri/src/pty.rs` | Promote `cached_login_env()` from private to `pub(crate)` so `acp.rs` can reuse without a second shell spawn. |
| `docs/73-acp-harness-mcp-memory.md` | Cross-link to this spec. |
| `docs/PROGRESS.md` | New row under M-ACP. |

No new TOML config keys. The feature is implicit: if `.mcp.json` exists in the project, lanes see it; if not, behaviour is unchanged.

## Design

### Data Structures (TypeScript)

```ts
// .mcp.json file shape (Claude Code format)
type ClaudeMcpServerStdio = {
  type?: 'stdio';                      // omitted = stdio
  command: string;
  args?: string[];
  env?: Record<string, string>;        // object form
};
type ClaudeMcpServerHttp = {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;    // object form
};
type ClaudeMcpFile = {
  mcpServers: Record<string, ClaudeMcpServerStdio | ClaudeMcpServerHttp>;
};
```

`AcpMcpServerDescriptor` (existing in `src/types.ts`) already supports the three ACP variants — verify it has the `command`/`args`/`env: {name,value}[]` stdio shape; extend if missing.

### Tauri commands (Rust)

```rust
#[tauri::command]
fn read_mcp_config_file(path: String) -> Result<Option<String>, String>;
// Reads UTF-8. Returns Ok(None) if the file does not exist (NOT an error).
// Returns Err only on permission/IO errors. No JSON parsing in Rust.

#[tauri::command]
fn acp_login_env() -> Result<HashMap<String, String>, String>;
// Returns the cached login env from pty::cached_login_env(). Used by the
// frontend bridge for ${VAR} expansion. Cached after first call.
```

Both registered in `lib.rs`'s `invoke_handler`.

### Bridge module — `src/acp/mcp-bridge.ts`

```ts
export async function loadProjectMcpServers(
  projectDir: string,
): Promise<AcpMcpServerDescriptor[]>;
```

Steps performed:

1. Resolve path: `${projectDir}/.mcp.json`. Skip if `projectDir` is empty/null.
2. Invoke `read_mcp_config_file`. Return `[]` on `null` (file missing) or any IO/parse error (log warning).
3. Parse JSON; reject if `mcpServers` field is missing or not an object.
4. Lazy-load login env via `acp_login_env` once per harness lifetime.
5. For each `(name, server)` pair:
   - Detect type (default `stdio` if `type` absent).
   - For stdio: expand `${VAR}` in `command`, each `args[i]`, and each `env` value.
   - For http/sse: expand `${VAR}` in `url` and each `headers` value.
   - Translate object → array of `{name, value}` for `env`/`headers`.
   - On expansion of an undefined `${VAR}` with no `:-default`: log warning, skip server (do **not** crash whole list).
6. Return descriptors in source order. Empty array on any fatal error (never throw — bridge must be resilient).

### Capability gating

In `acp-harness-view.ts` `connectLane()`, after `client.initialize()` populates `lane.agentCapabilities`:

```ts
const projectServers = await loadProjectMcpServers(this.projectDir);
const filtered = projectServers.filter((s) => isSupportedByLane(s, lane));
const memory   = this.memoryServerForLane(lane);
const merged   = dedupeByName([...filtered, ...memory]);
```

`isSupportedByLane`:
- `stdio` → always allowed.
- `http`/`sse` → only if `lane.agentCapabilities.mcpCapabilities?.[type]` is truthy.

`dedupeByName` keeps first occurrence (so the bridge wins over memory only if names collide; in practice they won't because memory uses `krypton-harness-memory`).

### Lane skip

`if (lane.backendId === 'claude') return memoryServerForLane(lane);` — Claude Code's adapter already loads `.mcp.json` natively. We still inject the memory server (it isn't in `.mcp.json`).

### Spawn-time vs initialize-time

`AcpClient.spawn` currently takes `mcpServers` and stores them in Rust before `initialize` runs. But capability-gating needs the `initialize` response. Options:

- **(A) Re-call `session/new` with merged servers after init.** Wrong — `session/new` is the call that triggers init flow; can't be deferred separately on this code path.
- **(B) Pass everything optimistically and let the agent reject.** Rejection is opaque and per-agent.
- **(C) Pre-fetch capabilities by sending `initialize` first, then issue `session/new` with the gated server list.** Already the structure of `acp_initialize` in `src-tauri/src/acp.rs:705-797` — `initialize` happens first (line 723), capabilities are stored (line 748), THEN `session/new` reads `mcp_servers` from `client.mcp_servers` (line 760) and sends. Currently the frontend uploads `mcp_servers` via `acp_spawn` BEFORE init. We can add a second command `acp_set_mcp_servers(session, servers)` that updates `client.mcp_servers` between `acp_spawn` and `acp_initialize`, and have the frontend call it after deciding the gated list.

**Decision: (C).** Frontend flow becomes:

```
1. spawn(backendId, cwd, [])           // empty list at spawn
2. initialize() → returns capabilities  
   ↑ but session/new is inside initialize and uses mcp_servers...
```

Re-inspection of `acp.rs:705-797`: `acp_initialize` does `initialize` then `session/new` in one Tauri call. To gate by capability we must split this. Two sub-options:

- **(C1) Split `acp_initialize` into `acp_initialize` (just the JSON-RPC `initialize`) and `acp_session_new` (the `session/new`).** Frontend calls `initialize`, computes gated server list, calls `acp_set_mcp_servers`, calls `session_new`. Cleaner but breaks the existing single-call API used by `client.ts`.
- **(C2) Keep `acp_initialize` monolithic but add a frontend-side hook: pre-spawn we don't know capabilities, so we pass servers optimistically; for stdio-only lanes (codex, opencode) we statically know they don't support http/sse and skip those server types up-front; Claude's adapter is already skipped; only Gemini is "unknown" and we accept the optimistic-send risk.** Pragmatic, but couples logic to per-backend assumptions.

**Decision: C1.** Split is cleaner and matches the ACP protocol shape (initialize and session/new are separate JSON-RPC calls anyway). Update `client.ts` to call them in sequence. The cost is one extra Tauri command and a small refactor in `acp.rs`.

### Data Flow

```
1. User opens ACP harness on project P
2. For each lane L:
   2a. acp_spawn(L.backendId, P, [])         # spawn child, empty mcpServers
   2b. info ← acp_initialize(L.session)       # JSON-RPC initialize only;
                                              # capabilities cached in client
   2c. projectServers ← loadProjectMcpServers(P)   # frontend reads .mcp.json
   2d. gated ← projectServers
              .filter(s => isSupportedByLane(s, L))   # using info.capabilities
   2e. final ← dedupe([...gated, ...memoryServerForLane(L)])
   2f. if L.backendId === 'claude': final ← memoryServerForLane(L) only
   2g. acp_set_mcp_servers(L.session, final)
   2h. acp_session_new(L.session) → sessionId
3. Lane is live; tool-list event from agent now includes both .mcp.json
   servers and the memory server.
```

Steps 2c-2f can be hoisted out of the loop and computed once per harness boot for efficiency (one read of `.mcp.json`, four filter passes). Memoize `loadProjectMcpServers(projectDir)` for the harness lifetime; invalidate on project change.

### Permissions

Servers loaded from `.mcp.json` will trigger `permission_request` events for each tool call. The harness's existing auto-allow only matches `krypton-harness-memory` (per Codex-1's review). Bridged servers will prompt the user normally. **Do not** attempt to auto-allow them in this spec — that is a separate trust decision (see Out of Scope).

## Edge Cases

- **`.mcp.json` malformed JSON**: log warning to console, return `[]`, harness continues.
- **`.mcp.json` exists but `mcpServers` empty `{}`**: return `[]`, no error.
- **Server with `${UNDEFINED_VAR}`** and no `:-default`: log warning, skip that server, keep the rest.
- **Server name collides between `.mcp.json` and `memoryServerForLane`**: dedupe keeps the bridge entry — but we control the memory name (`krypton-harness-memory`), so this is unlikely; document the reservation.
- **Same name appears twice in `.mcp.json`** (only possible if it's an array, but it's keyed object): JSON object semantics — last wins; nothing for us to do.
- **Project-dir change at runtime**: harness re-spawns lanes (existing behaviour); cache key is `projectDir` so new dir → fresh read.
- **Claude lane on a project with `.mcp.json` AND user also lists same server in `~/.gemini/settings.json`**: Gemini lane will see duplicate via native + ACP injection. Mitigation: documentation note "if you bridge via `.mcp.json`, remove from per-agent native configs". Detecting this from outside is impractical.
- **HTTP/SSE server, lane doesn't advertise the capability**: skip with one-line log; no error toast (would be noisy when 3 of 4 lanes silently filter).
- **Lane respawn from harness (`#new!`)**: re-runs the same pipeline — no extra plumbing.

## Open Questions

None. (Initially: should the harness watch `.mcp.json` for changes? Resolved → no, lane respawn is the trigger; matches existing config-reload mental model.)

## Out of Scope

- **User-scope MCP** (`~/.claude.json`): not bridged in v1. Add later if requested; same translation logic.
- **Auto-allow for bridged servers**: every bridged server will prompt for permission per call. Auto-allow is a separate trust/UX decision; this spec keeps the existing memory-only auto-allow.
- **Hot-reload** of `.mcp.json` without lane respawn.
- **Writing/editing** `.mcp.json` from inside Krypton.
- **Native-config dedupe** (detecting that the user also listed a server in `~/.gemini/settings.json` etc.). Documented as user contract.
- **Claude `.mcp.json` field extensions** that don't exist in ACP (`disabled`, `alwaysAllowed`): ignored on read.

## Resources

- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) — `.mcp.json` schema, env-var expansion, three-tier scope (project/user/managed).
- [ACP protocol schema](https://agentclientprotocol.com/protocol/schema) — `McpServer` variants and `agentCapabilities.mcpCapabilities` gating.
- [claude-agent-acp repo](https://github.com/agentclientprotocol/claude-agent-acp) — confirms Claude adapter loads `.mcp.json` itself.
- [Gemini CLI ACP mode](https://geminicli.com/docs/cli/acp-mode/) and [Gemini MCP servers](https://geminicli.com/docs/tools/mcp-server/) — Gemini reads `~/.gemini/settings.json` `mcpServers` regardless of ACP.
- [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) — Codex loads `~/.codex/config.toml`; stdio-first.
- [OpenCode ACP](https://opencode.ai/docs/acp/) and [OpenCode MCP](https://opencode.ai/docs/mcp-servers/) — `opencode.json` `mcp` block; `local`/`remote` types map to stdio/http.
- Internal: `docs/69-acp-agent-support.md`, `docs/72-acp-harness-view.md`, `docs/73-acp-harness-mcp-memory.md`, `src-tauri/src/pty.rs` `cached_login_env()`.
