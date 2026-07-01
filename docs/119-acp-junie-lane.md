# Junie Lane (JetBrains Junie CLI Native ACP) — Implementation Spec

> Status: Proposed
> Date: 2026-05-26
> Milestone: M-ACP — Harness convergence

## Problem

Krypton's ACP harness already runs Codex, Claude, Gemini, OpenCode, Pi, Droid, and Cursor lanes side by side, but JetBrains' Junie CLI cannot join the same shared project harness. Users with a JetBrains subscription (or a Junie API key, or BYOK against Anthropic/OpenAI/Google) must either leave Krypton or run `junie` in a plain terminal, losing the harness transcript, lane switching, memory MCP, peering, permission rail, and resource metrics that the other lanes get for free.

## Solution

Add Junie as a built-in ACP backend using Junie CLI's native ACP mode: `junie --acp true`. Junie is a "regular" lane like Codex/Gemini/OpenCode/Droid/Cursor — it gets the `.mcp.json` bridge (Spec 83) when its `agentCapabilities.mcpCapabilities` advertise the matching server types, the per-lane `krypton-harness-memory` MCP server (Spec 73), existing `session/prompt` streaming, and the normal permission rail. No headless wrapper, no third-party adapter, no shim. The registration is one entry in `builtin_backends()`, one in `BACKEND_LABELS`, one accent in `laneAccentForLabel`, and a small `startup_hint` block for the Junie-specific auth/install errors.

## Research

- **ACP entry point.** The official Junie docs page (https://junie.jetbrains.com/docs/junie-cli-acp.html) states that ACP mode is enabled by `junie --acp true`. The documentation confirms ACP supports JSON-RPC over stdio for local setup. This is the critical finding: Junie can be spawned as a normal ACP subprocess like every other lane.
- **Local CLI baseline.** `junie --version` reports build `1668.54` (verified by Cursor-1 during peer review, 2026-05-26). `junie --help` confirms `--acp <text>` accepts a boolean and exposes the surface described below. This is the known-good baseline for v1.
- **Installation.** `curl -fsSL https://junie.jetbrains.com/install.sh | bash` on Linux/macOS (Homebrew/PowerShell variants on Windows). The executable is `junie`. Krypton does not need to install Junie — it only spawns the binary if present on `PATH`, same precedent as Cursor.
- **Authentication options.** Three methods, in increasing order of headless-friendliness:
  1. **JetBrains Account** — interactive browser redirect to the JetBrains Junie login page. Needs a graphical browser; Krypton's piped stdio is enough only if Junie completes the OAuth handshake without prompting on stdin (likely fine, the browser is the gate). Users on a fresh machine should run `junie` once outside Krypton to seed credentials.
  2. **`-a` / `--auth <token>` flag (CLI help-emphasized)** — `junie --help` foregrounds this token-based auth path more than the env-var form. Krypton does not wire it in v1; users wanting headless auth use it through their own automation.
  3. **`JUNIE_API_KEY` env var** — usage-based billing through JetBrains, available via env. Headless-friendly: Krypton's `cached_login_env()` already passes the full login-shell env into every ACP child, so `JUNIE_API_KEY` exported in `~/.zshrc`/`~/.bash_profile`/`~/.config/fish/config.fish` reaches the Junie process unchanged. (Note: the published docs page lists this; `junie --help` foregrounds `--auth` instead. If the env var is removed in a future Junie build, Krypton's auth story shifts to provider keys + interactive pre-auth.)
  4. **BYOK (per-provider keys)** — `junie --help` lists `--anthropic-api-key`, `--openai-api-key`, etc. The matching env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`) are also consumed via Krypton's login-env injection. No Krypton wiring needed.
- **Headless / TTY.** ACP children use piped stdio. Any first-run prompt that lands on stdin will block `initialize`; the 30-second timeout surfaces it as a visible lane error with the Junie auth hint instead of a silent hang.
- **JetBrains IDE companion.** Docs mention Junie integrates with JetBrains IDEs via `/ide` when the same project is open. This is orthogonal to ACP and works inside the agent itself; Krypton does not need to do anything about it.
- **MCP support — native loading risk.** Local `junie --help` exposes `--mcp-default-locations`, repeatable `--mcp-location`, and `--config-default-locations` (defaults at `~/.junie/config.json` and `<project>/.junie/config.json`). Junie may load MCP servers from these locations **independently** of what Krypton injects via `session/new mcpServers`. If a project defines both `~/.junie/config.json` (or `<project>/.junie/config.json`) and the Krypton-bridged `.mcp.json`, the same server can end up registered twice under different identities. This is the Junie analogue of Cursor's `.cursor/mcp.json` vs `.mcp.json` duplication risk. v1 ships the bridge unchanged (regular-lane defaults) and surfaces duplication as an Open Question + post-implementation verification step. A future spec may add a Junie-only `claude`-style skip, or a `--mcp-default-locations=false` spawn flag, **only after** the dupe is observed in practice — do not preempt.
- **MCP support — ACP path.** The official docs do **not** explicitly describe how Junie consumes `session/new mcpServers`. We assume the standard ACP capability handshake: `initialize` returns `agentCapabilities.mcpCapabilities` listing supported server types (stdio/http/sse), and `filterByCapability()` gates the bridge accordingly. If Junie advertises no MCP capability, the existing bridge logic silently emits an empty server list — no harm done.
- **Permission model.** Unknown without manual probing. Junie may emit `session/request_permission` for tool calls (like Claude/Codex/Gemini/Droid) or apply edits directly (like Pi). The `--brave` flag exists but is interactive-only per `junie --help`; Krypton does not pass it. Until verified, the lane shows a `⚠ permissions unverified` chip — a weaker signal than Pi's `⚠ unsandboxed` chip because Krypton passes no force/yolo/brave flag, but it keeps the safety assumption visible. (Cursor dropped its chip in 2026-07 without a recorded probe; Junie keeps the chip pending its own probe.)
- **Model selection — CLI flag exists, ACP behavior unverified.** Correction during peer review: `junie --help` **does** list a global `--model=<text>` flag (plus `--provider=<text>` and per-provider keys). The actual research gap is whether `--model` affects sessions started with `--acp true`, not whether the flag is absent. Krypton's existing `acp_prompt`/session code already supports `session/set_model` generically (used by OpenCode), so a manual probe should test both: spawn with `--model` and observe Junie's reported model, and call `session/set_model` mid-session and observe whether the agent honors it. v1 does not push either — `acp_harness.lane_models.junie.active` stays display-only through the generic `inferLaneModelName` path until the probe finishes.

### Alternatives ruled out

- **Third-party Junie-ACP wrapper.** None exists at the time of writing, and there is no need — native `junie --acp true` is the documented path.
- **Running Junie in a normal terminal pane.** Possible today, but not a harness lane: no memory MCP, no peering, no resource metrics, no session picker.
- **Auto-installing Junie.** Out of scope. Krypton expects `junie` on `PATH` (precedent: every other adapter).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Junie docs | `junie --acp true` over stdio | Native ACP server mode, single CLI flag. |
| Krypton Cursor lane (Spec 113) | `cursor-agent acp` as native ACP child. | Closest sibling — regular lane shape; MCP delivery revised via native `.cursor/mcp.json` overlay (spec 113); permission chip removed 2026-07 without recorded probe. |
| Krypton Droid lane (Spec 86) | `droid exec --output-format acp` as native ACP child. | Same "regular lane" archetype, but Droid's permission model was clearer at spec time. |
| Krypton Cursor + Droid | Capability-gated `.mcp.json` bridge + memory MCP. | Junie inherits this path until verification confirms otherwise. |

**Krypton delta** — match Krypton's existing built-in lane model (code-defined backend, visible in lane picker, shared bridge + memory MCP + permission rail) rather than introduce a new registry concept.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `("junie", AcpBackend { command: "junie", args: ["--acp", "true"], display_name: "Junie" })` to `builtin_backends()`. Add a `backend_id == "junie"` `startup_hint` block sitting **between** the existing Cursor block and the unconditional fallthrough arms (`/login`, `gemini auth`, `opencode`, npm `enoent`). Add `junie_startup_hint_*` unit tests mirroring the existing `cursor_startup_hint_*` tests. |
| `src/acp/acp-harness-view.ts` | Add `junie: 'Junie'` to `BACKEND_LABELS`. **Expand the `accents[]` palette in `laneAccent` from 7 to 8 entries** (today `laneAccent(8)` wraps to `accents[0]` = Codex blue, so a `Junie-1` label without a dedicated arm falls back through `-(\d+)$` to `laneAccent(1)` and collides with Codex). Add `/junie/i.test(label)` arm to `laneAccentForLabel` **before** the numeric `-(\d+)$` fallback (slot 8). Add `⚠ permissions unverified` chip in `renderSandboxChip` for `lane.backendId === 'junie'` until permission semantics are probed. Confirm Junie is **not** added to the `pi-acp` no-MCP skip or the `claude` native-MCP skip in `mcpServersForLane()` — defaults are correct for a regular lane. |
| `src/config.ts` | Update the `lane_models` comment to mention `junie` if helpful; no schema change. |
| `docs/04-architecture.md` | Add Junie to the ACP lane list as a regular lane (bridge active, memory MCP active, permission rail engaged; permission/MCP semantics unverified). |
| `docs/05-data-flow.md` | Update ACP Harness Flow backend enumeration if still listing supported lanes explicitly. |
| `docs/06-configuration.md` | Add Junie backend command, install URL, auth prerequisites (`JUNIE_API_KEY` or `--auth` token or `junie` first-run outside Krypton), and optional `lane_models.junie` note (display-only). |
| `docs/69-acp-agent-support.md` | Add Junie to the prior-art / supported-lane enumeration (currently lists Cursor but not Junie). |
| `docs/PROGRESS.md` | Record the Junie lane landing under M-ACP after implementation. |

No new Tauri commands, frontend event types, CSS files, or `krypton.toml` schema changes are required for v1.

## Design

### Backend Registration

```rust
(
    "junie",
    AcpBackend {
        command: "junie".to_string(),
        args: vec!["--acp".to_string(), "true".to_string()],
        display_name: "Junie".to_string(),
    },
),
```

Krypton already injects `cached_login_env()` and the current working directory into ACP subprocesses, which covers `JUNIE_API_KEY`, BYOK provider keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY`), `PATH`, and project-root behavior. No extra plumbing.

### Model Selection

v1 does **not** push any model flag at spawn time and does **not** call `session/set_model`. `inferLaneModelName(backendId, info, laneModels)` returns whichever active model the user configured in `[acp_harness.lane_models.junie]`, falling back to the agent-reported model from `agent_capabilities`, or `null` (chip hidden).

Two potential wire-up paths exist for follow-up verification:

1. **CLI flag.** `junie --help` lists `--model=<text>` as a global flag. Whether it propagates into `--acp true` sessions is unverified. If verified, extend `acp_spawn`:

   ```rust
   } else if backend_id == "junie" {
       backend.args.push("--model".to_string());
       backend.args.push(model.clone());
   }
   ```

2. **`session/set_model`.** The Rust client already supports it (used by OpenCode through `set_opencode_default_model`). If Junie honors mid-session `session/set_model`, the OpenCode pattern can be reused with a Junie-specific post-`session/new` hook.

Verify both during the follow-up probe; pick the more reliable path. Until then, the chip is display-only — matching Claude/Codex/Pi/Cursor.

### MCP And Memory

Junie is a regular lane:

- **Do not** add it to the `pi-acp` no-MCP skip — Junie is assumed to host MCP unless verification proves otherwise.
- **Do not** add it to the `claude` native-`.mcp.json` skip in v1 — Junie's native config locations (`~/.junie/config.json`, `<project>/.junie/config.json`) are a different file from `.mcp.json` and the duplication risk is unproven. Adding a skip preemptively would lose the bridge for users who only have `.mcp.json`.
- Let `filterByCapability()` gate stdio/HTTP/SSE servers off `agentCapabilities.mcpCapabilities` from `initialize`. If Junie advertises none, the bridge emits an empty list and only the harness memory MCP is forwarded.
- Always include the per-lane `krypton-harness-memory` server when harness memory is available (existing `memoryServerForLane` behavior).

**Native-MCP duplication risk (post-implementation verification, not a launch blocker).** Junie's `--mcp-default-locations` / `--mcp-location` / `--config-default-locations` flags suggest the CLI loads MCP servers from disk independently of `session/new mcpServers`. Verification procedure: open a Junie lane with harness memory enabled and a non-trivial `.mcp.json` in the project root; observe the lane's `mcp` chip and the tool list reported via Junie's first turn. If the same server appears twice (once from `.mcp.json`, once from Junie's native loader), a follow-up spec adds either a Junie skip clause in `mcpServersForLane()` or a `--mcp-default-locations=false` spawn flag. Do not preempt either.

**Streamable HTTP GET requirement.** Junie's Kotlin MCP client opens the modern "Streamable HTTP" transport by issuing a `GET` against the server URL to attach an SSE stream for server-initiated messages. The MCP spec permits the server to answer that `GET` with `405 Method Not Allowed` (meaning "I don't push server-initiated messages"), but Junie treats 405 as a hard transport failure and falls through to a non-existent legacy SSE endpoint, also failing. To make `krypton-harness-memory` reachable from Junie, the hook server in `src-tauri/src/hook_server.rs` answers `GET /mcp/harness/{harness_id}/lane/{lane_label}` with a valid `text/event-stream` response that emits only keepalive comments (pending stream + 15s `KeepAlive`). `POST` retains the JSON-RPC request/response handler. Claude/Cursor/Codex MCP clients only `POST`, so the added `GET` arm is invisible to them.

**Protocol version negotiation.** The Kotlin MCP SDK that Junie 1668.54 ships throws `Server's protocol version is not supported: 2025-06-18` and falls back to the (also failing) legacy SSE transport if the server unconditionally returns a `protocolVersion` newer than what the client requested. Cause: `Client.connect` in `io.modelcontextprotocol.kotlin.sdk.client.Client` checks the server-reported version against a hardcoded supported set that does not yet include `2025-06-18`. Fix: `handle_harness_memory_mcp` echoes the client's `params.protocolVersion` back when it falls within `SUPPORTED_PROTOCOL_VERSIONS` (`2024-11-05`, `2025-03-26`, `2025-06-18`); otherwise defaults to `2025-06-18`. Our handler only implements `tools/list` and `tools/call`, both unchanged across these versions, so the downgrade is safe for older clients. Claude/Cursor/Codex MCP clients already request `2025-06-18` and continue to get it.

### Permissions

No `--force` / `--yolo` / `--trust` / `--auto` / `--brave` flags are passed by default. (`--brave` exists in `junie --help` but is interactive-only — irrelevant to ACP children.) Until Junie ACP write-permission behavior is manually verified, the lane chrome shows a `⚠ permissions unverified` chip.

**Tooltip wording.** Communicate that the *write autonomy* is unverified, not that Junie lacks a permission UI. Krypton's permission rail may still light up if Junie emits `session/request_permission`; the chip warns about the *unknown*, not a confirmed absence. Concrete copy: "Junie ACP write-permission behavior has not been verified yet. Krypton does not pass force/yolo/brave flags, but use a trusted cwd until verified."

Follow-up verification probe (deferred, not a launch blocker): in a scratch directory, ask Junie ACP to edit a file and observe whether it emits ACP `session/request_permission` before the write, denies internally, or applies edits directly. If it gates writes, drop the unverified chip. If it applies directly, upgrade to a Pi-style `⚠ unsandboxed` chip and document the autonomy delta.

### Startup Diagnostics

Junie lane startup relies on `junie --acp true` taking the non-interactive ACP path. Clean machines may need `junie` to be run once outside Krypton for JetBrains Account OAuth, or need a provider key / `JUNIE_API_KEY` exported in the login shell. ACP children use piped stdio, so any installer/wizard waiting on stdin will block `initialize` and surface as a 30-second timeout with the Junie-specific hint instead of a silent hang.

**Placement is load-bearing.** The current `startup_hint()` has unconditional fallthrough arms after the Cursor block: `not authenticated` → Claude `/login` hint, `npm err` / `enoent` → npm adapter install hint, etc. The Junie block must sit **immediately after** the Cursor block and **before** those generic fallthroughs, and every Junie substring must be gated on `backend_id == "junie"` (like the Cursor block does). Otherwise a Junie ENOENT prints "install the Claude adapter via npm".

**Within the Junie block, mirror Cursor's ordering:**

1. Specific failures first (e.g. ENOENT / unknown CLI flag).
2. Explicit auth strings.
3. Empty-stderr + timeout fallback.

| Order | stderr substring (lowercased, `backend_id == "junie"`) | Suggested action |
|-------|--------------------------------------------------------|------------------|
| 1 | `junie: command not found`, `enoent`, `no such file` | "Install Junie CLI: `curl -fsSL https://junie.jetbrains.com/install.sh \| bash`." |
| 2 | `unknown option --acp`, `invalid value for --acp`, `unrecognized argument` | "Your Junie CLI predates ACP mode. Run `junie --version` (known-good baseline: build 1668.54) and update via the install script." |
| 3 | `not authenticated`, `please log in`, `please login`, `authentication required`, `unauthorized` | "Run `junie` once in a terminal to log in with your JetBrains Account, pass `--auth <token>` for headless setups, or export `JUNIE_API_KEY` / a provider key (`ANTHROPIC_API_KEY`, etc.) in your login shell." |
| 4 | `api key`, `invalid api key`, `bad token` | Same hint as row 3. (Bare `api key` is a known false-positive risk — Cursor lesson — so keep it after the explicit auth strings, never as the only trigger.) |
| 5 | `subscription`, `quota`, `rate limit`, `billing`, `forbidden` | "Junie reports a subscription/quota issue. Check your JetBrains account or BYOK provider status." |
| 6 | `config`, `~/.junie`, `~/.junie/config.json` (parse/IO errors) | "Junie failed to load its config (likely `~/.junie/config.json` or `<project>/.junie/config.json`). Inspect the file or remove it to fall back to defaults." |
| 7 | empty stderr + initialize timeout (no substring match) | "Junie did not return an initialize response and no stderr was captured. First-run JetBrains login or install input is a likely cause; run `junie` in a terminal once, then retry." |

**Do not match bare `login`** (Cursor lesson — `login` appears in non-diagnostic log lines).

**Do not** copy Cursor's `secitemcopymatching failed` row speculatively. If Junie emits a Keychain error in practice, add it then; do not prebake a row for a failure mode we have not observed.

Add `junie_startup_hint_*` unit tests next to the `cursor_startup_hint_*` tests in `acp.rs` — same coverage shape (ENOENT, explicit auth, false-positive-safe `login` substring, empty stderr).

### Data Flow

```
1. User opens ACP Harness and presses Cmd+P then +.
2. Lane picker lists `Junie` from `acp_list_backends()`.
3. User selects Junie.
4. Rust spawns `junie --acp true` in the harness project directory with cached login env.
5. AcpClient sends `initialize`; Junie returns protocol version, capabilities, available modes (if any).
6. Frontend capability-gates `.mcp.json` servers via Spec 83 bridge, appends the per-lane memory MCP, then calls `session/new`.
7. User prompts Junie lane.
8. Junie streams ACP `session/update` events; Krypton renders assistant chunks, tools, plan/mode updates, and permissions through existing harness code.
```

### UI Changes

- Lane picker shows `Junie`.
- Lane display names follow existing numbering: `Junie-1`, `Junie-2`, etc.
- Lane chip shows `⚠ permissions unverified` until probed; tooltip uses the "unverified write autonomy" wording, not "no permission UI".
- Model chip is hidden unless Junie reports a model name in `agent_capabilities` or the user sets `acp_harness.lane_models.junie.active`.
- Session picker (`Cmd+P → 0`) attempts `session/list` like other lanes; if Junie does not implement it, the existing "does not support session/list" path handles it gracefully.
- **Accent palette expansion is mandatory.** `laneAccent`'s `accents[]` array currently has 7 entries, so `laneAccent(8)` evaluates `(8-1) % 7 = 0` and wraps to `accents[0]` (Codex blue) — Junie would visually collide with Codex. Steps:
  1. Add an 8th entry to `accents[]` (a JetBrains-leaning hue distinct from the seven existing slots — e.g. a violet or teal not already used).
  2. Add `if (/junie/i.test(label)) return laneAccent(8);` to `laneAccentForLabel`, placed **before** the `label.match(/-(\d+)$/)` numeric fallback (without this, a label like `Junie-1` matches the numeric tail and returns `laneAccent(1)` = Codex).
  3. Future-proofing: any further new lane (slot 9+) must extend `accents[]` before it can claim its own color. The numeric-tail fallback only does the right thing when a backend has both a dedicated label arm and a palette slot.

### Configuration

No new TOML keys. Existing optional model config shape may be used (display-only in v1):

```toml
[acp_harness.lane_models.junie]
active = "claude-opus-4-5"   # or "gpt-5", "gemini-2.5-pro", etc., depending on BYOK
models = ["claude-opus-4-5", "gpt-5", "gemini-2.5-pro"]
```

## Edge Cases

- **`junie` not on PATH** — spawn fails; lane enters error state with the install hint.
- **JetBrains Account login required but never completed outside Krypton** — `junie --acp true` may exit immediately or block on stdin. Timeout fires after 30s and surfaces the Junie auth hint.
- **`JUNIE_API_KEY` set but invalid** — Junie should emit an auth error on stderr at `initialize` time; the stderr buffer feeds into the auth hint.
- **BYOK environment** — user has `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set but Junie is not configured to consume them. This is a Junie-side config issue, not a Krypton bug; the lane error surfaces Junie's own error message.
- **Junie tries to open a browser at spawn time** — typical OAuth path. Browser opens out-of-band; ACP child does not need a TTY. Should work; if it doesn't, user runs `junie` once in a terminal first.
- **Junie does not implement `session/list`** — session picker shows the existing unsupported message; not a regression.
- **Junie advertises no MCP capabilities** — `.mcp.json` bridge silently emits an empty list; only the harness memory MCP is forwarded; lane works fine.
- **Junie emits noisy stderr** — rolling 64KB stderr buffer caps it; startup hint extracts the relevant tail.
- **JetBrains IDE companion mode** — orthogonal to ACP; user can `/ide` inside Junie's session like in any other context. Not a Krypton concern.
- **Concurrent JetBrains subscription throttling** — if Junie hits a server-side rate limit, the lane gets a normal ACP error response; no special handling.

## Open Questions

- ~~Does `junie --acp true` honor `session/new mcpServers`?~~ **Resolved (2026-05-26):** No — Junie does not call `tools/list` on ACP-injected servers (`mcp —` chip). Krypton injects harness memory + bridged `.mcp.json` via a per-lane native overlay: `~/.config/krypton/runtime/junie/<harnessId>/<laneLabel>/mcp.json` + spawn flag `--mcp-location <overlayRoot>`. `mcpServersForLane()` skips Junie for `session/new`. **Layout correction (2026-05-26):** Junie 1668.54's `--mcp-location <folder>` reads `<folder>/mcp.json` *directly*, **not** `<folder>/.junie/mcp/mcp.json` as initially assumed. Verified by probing with both layouts; only the flat `<folder>/mcp.json` triggers `Registering MCP command: name=krypton-harness-memory`. The default-locations scan still uses `<projectRoot>/.junie/mcp/mcp.json` and `~/.junie/mcp/mcp.json`, but `--mcp-location` does not.
- Does Junie natively load MCP servers from `~/.junie/config.json` and/or `<project>/.junie/config.json` via `--mcp-default-locations`, **and** consume `session/new mcpServers` at the same time? If both, identical servers can appear twice — confirm in a project that defines both `.mcp.json` (Krypton-bridged) and a `.junie/config.json` entry for the same server. Outcome decides whether a follow-up spec adds a Junie skip in `mcpServersForLane()`, a `--mcp-default-locations=false` spawn flag, or neither.
- Does Junie ACP emit `session/request_permission` before file writes, deny internally, or mutate directly? (Scratch-dir probe still open for Junie — outcome decides whether the `⚠ permissions unverified` chip stays, is dropped, or is upgraded to `⚠ unsandboxed`. Cursor's chip was removed in 2026-07 without a recorded probe; see spec 113.)
- Does Junie respect a CLI `--model <id>` flag when running under `--acp true`, **or** does it honor mid-session `session/set_model`, **or** both? (Verification picks the more reliable wire-up path; until then `lane_models.junie.active` is display-only.)
- Does Junie support `session/resume` and `session/load`? (Session picker behavior depends on this; existing fallback path handles either outcome.)
- Does the `-a` / `--auth <token>` headless-auth parameter unlock anything Krypton should wire for CI scenarios? (Out of scope for v1; revisit if users request it.)
- Is `JUNIE_API_KEY` still a supported env var? The Junie docs page lists it; `junie --help` foregrounds `--auth` instead. If the env var is removed in a future Junie build, the auth hint copy needs to shift toward provider keys + interactive pre-auth.

## Out of Scope

- Auto-installing Junie CLI.
- Implementing a JetBrains-Account OAuth dance inside Krypton (browser flow is Junie's job).
- Wiring Junie-specific `--auth`, `--workspace`, or model flags into `krypton.toml`.
- Detecting / surfacing JetBrains IDE companion state in the lane chrome.
- Building Junie-specific slash command UI (existing slash-palette consumes Junie's `available_commands_update` notifications generically).

## Resources

- [Junie CLI ACP docs](https://junie.jetbrains.com/docs/junie-cli-acp.html) — the canonical reference for `junie --acp true`.
- [Junie CLI install/auth docs](https://junie.jetbrains.com/docs/junie-cli.html) — install script, JetBrains Account / `JUNIE_API_KEY` / BYOK paths.
- [Agent Client Protocol](https://agentclientprotocol.com) — referenced by Junie docs for the wire format.
- Local command: `junie --version` — known-good baseline `build 1668.54` (2026-05-26).
- Local command: `junie --help` — exposes `--acp <text>`, `--auth <token>`, `--model <text>`, `--provider <text>`, per-provider keys (`--anthropic-api-key`, `--openai-api-key`, ...), `--mcp-default-locations`, `--mcp-location`, `--config-default-locations`, `--brave`.
- `docs/113-acp-cursor-lane.md` — closest sibling spec; regular lane shape (MCP overlay revised 2026-05-29; permission chip removed 2026-07 without recorded probe).
- `docs/86-acp-droid-lane.md` — earlier "regular lane" precedent with clearer permission semantics at spec time.
- `docs/83-acp-shared-mcp-config.md` — `.mcp.json` bridge that Junie inherits unchanged.
- `docs/73-acp-harness-mcp-memory.md` — per-lane memory MCP that Junie inherits unchanged.
- `docs/69-acp-agent-support.md` — supported-lane enumeration; needs a Junie row.
- `src-tauri/src/acp.rs` — `builtin_backends()` registration point; `startup_hint` function (placement note in §Startup Diagnostics); `cursor_startup_hint_*` tests as a template.
- `src/acp/acp-harness-view.ts` — `BACKEND_LABELS`, `laneAccentForLabel`, `laneAccent` palette (mandatory expansion in §UI Changes), `renderSandboxChip`, `mcpServersForLane`, `inferLaneModelName`.
