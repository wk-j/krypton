# Grok Lane (xAI Grok Build Native ACP) — Implementation Spec

> Status: Implemented (code) — runtime verification pending a live Grok build
> Date: 2026-05-31
> Milestone: M-ACP — Harness convergence

## Problem

The ACP harness ships nine lanes (Codex, Claude, Gemini, OpenCode, Pi, Droid, Cursor, Junie, OMP). xAI shipped **Grok Build**, a terminal coding agent with first-party ACP support, on 2026-05-14. Krypton has no lane for it, so users can't compare Grok's `grok-build-0.1` (256K context) against the other lanes in the same multi-lane transcript.

## Solution

Adopt Grok Build's **native** ACP mode (`grok agent stdio`) as the 10th harness backend. xAI ships ACP in the official `grok` CLI — no third-party wrapper. The wire format (JSON-RPC 2.0 over stdin/stdout) is identical to the existing nine lanes, so registration is one entry in `builtin_backends()`, the built-in-id mirror, and the standard frontend touchpoints (label, logo glyph + tint, lane accent). Grok is a full-featured agent (permission gate, tool calls, slash commands, MCP), so it's a **"regular" lane** in the Codex/Droid mold: the Spec 83 `.mcp.json` bridge and the per-lane memory MCP both apply, gated by advertised capabilities. Because Grok is the 10th lane and the accent palette holds only 9 colors, the palette gains a 10th entry to avoid a color collision with Codex.

## Research

### Native ACP (shapes the design)

- **Grok Build has first-party ACP support.** The ACP entry point is `grok agent stdio` — "runs Grok as an ACP agent over JSON-RPC on stdin/stdout" (xAI headless/scripting docs, verified 2026-05-31). This is the exact transport Krypton's `acp_spawn` already drives; no npm adapter, no glue.
- **Binary:** `grok`. Install: `curl -fsSL https://x.ai/cli/install.sh | bash` (macOS/Linux only — matches Krypton's macOS target; Windows is unsupported by Grok today, which is irrelevant here).
- **Model:** default `grok-build-0.1` (256K context). Headless mode documents `-m, --model <MODEL>`. In-session switching is `/model <name>`. **Open:** whether `grok agent stdio` accepts `-m` at spawn or expects ACP `session/set_model`; the docs demonstrate `-m` for the headless/print path, not explicitly for stdio. **v1 does not wire `-m`** — it relies on the existing generic `apply_session_model` (`session/set_model`) path, which needs no new code if Grok advertises model state at `initialize` (see Model Override). The spawn flag is a deferred follow-up, only if verification shows Grok ignores `session/set_model` over ACP.

### Auth

- **API key (preferred for headless harness):** `export XAI_API_KEY="xai-..."` in the login shell. Krypton's spawn block injects the full login env via `cached_login_env()`, so no extra plumbing.
- **Browser OAuth:** first `grok` launch opens a browser to authenticate. Like every OAuth flow we've integrated (Pi, Claude, Cursor, Junie), this needs a TTY; Krypton hands the agent pipes, not a TTY. Users on this path run `grok` once outside Krypton to seed creds, then the cached token covers the lane. Document; do not wrap.

### MCP

- Grok Build advertises MCP support and a Skills/Plugins marketplace. The ACP impl is **expected** to honor `session/new mcpServers` like Codex/Gemini/OpenCode/Droid. **Do not** add a `mcpServersForLane` skip clause for Grok — let `filterByCapability` gate from `agentCapabilities.mcpCapabilities` advertised at `initialize`. **Open:** Cursor regressed on exactly this (`session/new mcpServers` ignored, Spec 113), so the harness-memory delivery must be verified against a live Grok build; if Grok also ignores it, fall back to a native-config workaround (mirror of `prepare_cursor_mcp`). Until verified, assume the standard bridge works (the optimistic default the other regular lanes use).

### Alternatives ruled out

- **Third-party `superagent-ai/grok-cli`** (open-source coding agent for the Grok API). Functional but a separate project from xAI's official `grok`; native first-party ACP is maintained by xAI and ships with the product. Use native.
- **Headless `--output-format json/stream-json`** without ACP. That's Grok's batch/CI output, not ACP — would need a custom client. Rejected.

## Prior Art

| Tool | Implementation |
|------|----------------|
| Grok Build standalone | Interactive TUI, headless (`plain`/`json`/`stream-json`), or ACP via `grok agent stdio`. Auth `XAI_API_KEY` or browser. `-m/--model`, `/model` in session. |
| Krypton (9 existing lanes) | `builtin_backends()` hard-codes `(id, command, args, display_name)`. Regular lanes (Codex/Claude/Gemini/OpenCode/Droid) get the `.mcp.json` bridge + memory MCP + permission rail; lean lanes (Pi) skip it. Lanes are user-added via the lane picker (`acp_list_backends`); there is no default-spawn list. |
| Droid (Spec 86) | Native ACP `droid exec --output-format acp`; model via `-m` at spawn; regular lane. Closest sibling to Grok. |

**Krypton delta** — match xAI's documented invocation exactly (`grok agent stdio`). Treat Grok as a "regular" lane (full bridge, memory MCP, permission rail). The only Krypton concession is the OAuth-needs-TTY caveat shared with Pi/Claude/Cursor/Junie (document, don't wrap). Net-new vs. the Droid template: a 10th accent color, since the palette currently holds 9.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `("grok", AcpBackend { command: "grok", args: ["agent", "stdio"], display_name: "Grok" })` to `builtin_backends()`. Add `grok` arm to `startup_hint()` (install/auth/version hints). **No** model-flag arm in v1 — see Model Override. |
| `src-tauri/src/acp_harness_config.rs` | Add `"grok"` to `BUILTIN_BACKEND_IDS` (`:23`). Its doc comment states it mirrors the frontend `BACKEND_LABELS` keys; without this, directive management rejects `grok` as an unknown backend target (`:195`). |
| `src/acp/acp-harness-view.ts` | `BACKEND_LABELS`: add `grok: 'Grok'`. `backendLogoId`: add `case 'grok' → 'krypton-logo-grok'`. `BACKEND_LOGO_SVG_DEFS`: add a `krypton-logo-grok` `<symbol>`. `laneAccentForLabel`: add `if (/grok/i.test(label)) return laneAccent(10);`. `laneAccent`: append a 10th accent color. No `inferLaneModelName` change (Grok reports its model via `initialize`; config override already handled generically). No `mcpServersForLane` skip clause. |
| `src/styles/acp-harness.css` | Add backend palette token `--krypton-backend-grok` (`:31-39` block) + tint classes `.acp-harness__rail-logo--grok` (`:2387`) and `.acp-harness__directive-logo--grok` (`:3357`). The TS render path derives the class suffix from `BACKEND_LABELS[...] ? backendId : 'omp'`, so without these the Grok glyph renders but is **untinted**. This `--krypton-backend-*` system is separate from the positional `laneAccent` rail palette. |
| `src/acp/acp-harness-view.test.ts` | Add `laneAccentForLabel('Grok-1') === laneAccent(10)` + `!== laneAccent(1)`; `backendLogoId('grok') === 'krypton-logo-grok'`; update the existing "keeps the N-color palette" test to assert **10** distinct slots `[1..10]`. |
| `docs/PROGRESS.md` | Record Spec 135 under M-ACP. |
| `docs/04-architecture.md` | Add Grok to the lane list: regular lane (bridge + memory MCP), auth `XAI_API_KEY` / browser-OAuth-needs-TTY, command `grok agent stdio`. |
| `docs/06-configuration.md` | New "Grok lane prerequisites" subsection: install, `XAI_API_KEY`, optional `[acp_harness.lane_models.grok]`. |

No changes to `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/mcp-bridge.ts`. No new Tauri commands. Grok surfaces in the lane picker automatically once in `builtin_backends()` (picker reads `acp_list_backends`). Optionally refresh the supported-backend doc comments in `src-tauri/src/config.rs` / `src/config.ts` if they enumerate backends (cosmetic, non-blocking).

## Design

### Data Structures

No new types.

### Backend Registration

```rust
// src-tauri/src/acp.rs — append to builtin_backends()
(
    "grok",
    AcpBackend {
        command: "grok".to_string(),
        args: vec!["agent".to_string(), "stdio".to_string()],
        display_name: "Grok".to_string(),
    },
),
```

### Model Override

**v1 baseline: no spawn-time `-m` flag arm.** The backend already has a generic, non-fatal post-`session/new` path — `apply_session_model` (`acp.rs:1355`) sends `session/set_model` for any ACP-native backend that advertises model state. If `acp_harness.lane_models.grok.active` is set and Grok advertises models at `initialize`, that override is applied through this existing path with **no new Rust code**. If Grok doesn't advertise model state, the chip is display-only and Grok runs its default (`grok-build-0.1`).

The CLI `-m` flag is documented for Grok's *headless/print* path, not verified for `agent stdio`. Adding an `else if backend_id == "grok"` arm to the model-flag block (mirroring Gemini/Droid) is deferred to a follow-up **only if** verification shows Grok ignores `session/set_model` over ACP. If wired later, the implementer must confirm exact arg order (`grok agent stdio -m X` vs `grok -m X agent stdio`) before landing — an unverified spawn-failing flag is worse than the working generic path.

### Logo Glyph

A new `krypton-logo-grok` `<symbol>` (16×16 viewBox, `currentColor`, in `BACKEND_LOGO_SVG_DEFS`) so the rail recolors via CSS like the others. Proposed motif: a hard-edged angular slash/bolt (Grok/X identity) — final geometry per `docs/132` brand-glyph conventions. Distinct from existing nine glyphs.

### Accent Palette Extension

Two color systems exist and both need a Grok entry:

1. **Backend logo tint** — the `--krypton-backend-grok` CSS token + `--grok` tint classes (see Affected Files). This is what colors the glyph in the rail and directive list.
2. **Positional lane-rail accent** — `laneAccent(index)` holds 9 colors; `laneAccent(10)` currently wraps (`(10-1) % 9 = 0`) to Codex's accent → collision. Append a 10th color (a hue distinct from the existing nine). `laneAccentForLabel` maps `/grok/i → laneAccent(10)`.

Scope note: `laneAccentForLabel('Grok-1') → laneAccent(10)` only fixes the **backend-label** collision. The lane's actual `lane.accent` is positional — `createLane()` uses `laneAccent(index)` by lane slot — so a Grok lane created in slot 3 still takes slot 3's accent. That's identical to existing Junie/OMP behavior and is **not** a blocker; the palette extension exists so `laneAccentForLabel` (used by the memory-source chips) doesn't alias Codex.

### MCP Bridge

Unchanged code path. `mcpServersForLane` applies the `.mcp.json` bridge + `memoryServerForLane` (per-lane HTTP memory) for Grok, capability-gated against `mcpCapabilities`. No skip clause. If a live Grok build ignores `session/new mcpServers` (Cursor-style regression), follow up with a native-config workaround in a fast-follow — not in this spec's baseline.

### Permission & Tool-call Flow

Unchanged. Grok raises permission requests for tool calls; Krypton's existing rail consumes them. No autonomy/skip-permission flags passed at spawn.

### Configuration

No new TOML keys. Optional prerequisites in `docs/06-configuration.md`:

```sh
# Install Grok Build CLI (macOS/Linux)
curl -fsSL https://x.ai/cli/install.sh | bash

# Auth — preferred: API key
export XAI_API_KEY="xai-..."
# Or run `grok` once outside Krypton to complete browser OAuth.

# Optional: pin a model for the Grok lane — ~/.config/krypton/krypton.toml
# [acp_harness.lane_models.grok]
# active = "grok-build-0.1"
```

(Shape matches the existing Gemini/OpenCode entries: a `[acp_harness.lane_models.<id>]` table with an `active` key — Rust reads `lane_models.get(id).map(|m| m.active)`.)

## Edge Cases

- **`grok` not on PATH** → ENOENT; lane → `error` with the spawn error + `startup_hint` install line.
- **Older `grok` without `agent stdio`** → handshake fails / unknown subcommand; `startup_hint` points to upgrade.
- **No auth** → first prompt fails inside Grok; error surfaces in transcript.
- **Browser-OAuth path** → no TTY in Krypton; user runs `grok` once outside, cached creds cover the lane.
- **Configured model not honored** → v1 has no spawn flag, so a bad model id surfaces non-fatally via `apply_session_model` (logged `session/set_model failed`), not a spawn crash; the lane still starts on Grok's default.
- **Grok ignores `session/new mcpServers`** (Cursor-style) → memory MCP silently absent; detected during verification → native-config fast-follow.
- **Image paste** → only if Grok advertises `promptCapabilities.image`. Existing gating handles it.

## Open Questions

1. **Model selection transport** — v1 relies on the generic `apply_session_model` (`session/set_model`) path, which needs no new code. Whether `grok agent stdio` *also* accepts a `-m` spawn flag is a follow-up question, not a v1 requirement. Not blocking.
2. **MCP injection** — does Grok honor `session/new mcpServers`, or regress like Cursor (Spec 113)? **Concrete verification gate before marking Implemented:** spawn a live Grok lane and confirm `krypton-harness-memory` is actually reachable (memory MCP tools resolve / appears in `peer_list`-style introspection). Only then close the spec. If absent, the Cursor-style native-config workaround is a fast-follow.
3. **Logo glyph geometry** — final `krypton-logo-grok` path per `docs/132` brand spec. Defer exact SVG to implementation; requirement is a distinct 16×16 `currentColor` symbol.

These are verify-at-implementation items, not design forks — the baseline (regular lane, generic `session/set_model`, standard MCP bridge) is the documented-default path; each has a defined fallback. None block the registration itself.

## Out of Scope

- Wiring Grok's subagents / multi-agent ("mission"-style) features into Krypton — doesn't fit one-lane-one-agent.
- Grok Skills/Plugins marketplace integration.
- Custom slash-command palette/autocomplete for Grok commands (input passes verbatim via `session/prompt`).
- ACP Authenticate UI inside the harness (browser OAuth).
- `superagent-ai/grok-cli` (third-party) support.

## Resources

- [Introducing Grok Build | xAI](https://x.ai/news/grok-build-cli) — launch, ACP support, multi-agent, CLAUDE.md support
- [Headless & Scripting | xAI Docs](https://docs.x.ai/build/cli/headless-scripting) — `grok agent stdio` ACP mode; `-m/--model`; `XAI_API_KEY`; output formats
- [Getting Started | xAI Docs](https://docs.x.ai/build/overview) — install script, browser auth, `/model`, default model + 256K context
- [Agent Client Protocol](https://agentclientprotocol.com/overview/introduction) — `mcpCapabilities`, `promptCapabilities`, `session/new`, `session/set_model`
- `docs/86-acp-droid-lane.md` — closest sibling (native ACP, regular lane, `-m` at spawn)
- `docs/83-acp-shared-mcp-config.md` — `.mcp.json` bridge (applies to Grok)
- `docs/73-acp-harness-mcp-memory.md` — per-lane memory MCP (applies to Grok)
- `docs/113-acp-cursor-lane.md` — native-config MCP fallback pattern, if Grok regresses on `session/new mcpServers`
- `src-tauri/src/acp.rs:36-124` — `builtin_backends()`; `:972-981` model-flag block; `:1921` `startup_hint`
- `src/acp/acp-harness-view.ts:607` `BACKEND_LABELS`; `:672` `backendLogoId`; `:711` `BACKEND_LOGO_SVG_DEFS`; `:8955` `laneAccent`; `:8970` `laneAccentForLabel`
