# Directive Management Without Dedicated MCP Tools — Implementation Spec

> Status: Implemented
> Date: 2026-06-15
> Milestone: M8 — Polish

## Problem

The four directive-management MCP tools (`directive_list`, `directive_preview`, `directive_apply`, `directive_remove`) are advertised to **every lane on every turn**, costing **~1,224 tokens** of always-on context (`directive_apply` alone is ~940). Creating/editing/deleting a directive is **rare** (a directive is set up once and reused), so the schemas are dead weight in the vast majority of sessions — yet there is no way to make MCP tools on-demand (`tools/list` is global+static, no `tools/list_changed`, backends cache it at init).

## Solution

**Stop shipping dedicated tools for a job the agent can already do.** A directive is just a TOML entry in a known Krypton-managed file (`~/.config/krypton/acp-harness.toml`). An ACP lane is a coding agent that already has `read`/`edit`/`write` file tools. So:

1. **Remove all four directive MCP tools** → −1,224 tokens/turn, always, for every lane.
2. **Add a `#directive` one-shot command** (same mechanism as `#wiki`/`#handoff`: a prompt injected via `enqueueSystemPrompt`, costing tokens only when invoked) that tells the agent the config path, the TOML schema, and the safety/validation rules, then lets it author directives with its **own existing file tools**.

No file watcher, no new UI, no new Tauri command. The keyboard picker (`Cmd+P → .`) already calls `refreshDirectives()` — a fresh disk read — **every time it opens** (acp-harness-view.ts:5023) and already shows `no directives — edit ~/.config/krypton/acp-harness.toml` when empty (:5025). So after the agent edits the file, the next picker open simply shows the new directive. Assigning a directive stays on that picker. This mirrors how `#wiki` manages the code wiki with zero dedicated tools.

## Research

- `tools/list` (hook_server.rs:1143) is a single **global, static** `bus_tool_descriptors()`; no per-lane context, no `notifications/tools/list_changed`, backends call it once at init. → Per-turn dynamic tool exposure is infeasible; removing the tools outright is the only way to reclaim the tokens.
- **`#wiki` is the proven precedent** (acp-harness-view.ts:500 `wikiIngestPrompt`): no dedicated MCP tool — it injects a prompt describing the `docs/wiki/` layout + schema + safety rules and the agent edits files with its normal tools. `#handoff`/`#recall` follow the same one-shot `enqueueSystemPrompt` pattern. `#directive` slots into the existing `#`-command dispatcher (acp-harness-view.ts:4196).
- **The picker already reloads from disk on open** — `openDirectivePicker()` → `await refreshDirectives()` (:5023) reads `acp-harness.toml` fresh each time, so a file watcher is unnecessary: a directive the agent just wrote appears the next time the picker opens. (The existing `acp-harness-directives-changed` event, emitted by the old MCP path, becomes dead once the tools are removed; the listener can stay harmless or be dropped.)
- The picker assign path `assignDirectiveToLane()` (acp-harness-view.ts:5048) is frontend-only and independent of the MCP tools — unaffected by their removal.
- The config file lives **outside the project cwd** (`~/.config/krypton/`). Editing it needs the backend's file tools to accept an absolute path outside the workspace — fine for Claude Code/Codex (may prompt once for permission); sandboxed backends may refuse (edge case below).

### Alternatives considered (this conversation)

- **File watcher for live refresh** — unnecessary: the picker re-reads on open. Dropped.
- **Gate the tools behind a load-time flag** — still forces hand-editing TOML for authoring and keeps the tool code; removing the schemas entirely is simpler.
- **Frontend overlay editor / new Tauri `upsert_directive` command** — builds UI and a Rust command for something the agent's file tools already cover. More code, no token win.
- **`#directive` that drives the agent's *MCP tool*** — chicken-and-egg: the agent would still need the tool loaded. Rejected.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Krypton `#wiki` | One-shot prompt injection; agent edits `docs/wiki/` with its own file tools; no dedicated tool | Exact pattern reused here |
| VS Code Copilot | Prompt files / agent files are plain Markdown the user (or agent) edits directly | Config-as-file, no bespoke mutation API |
| Zed | Agent profiles editable by hand in `settings.json` | File-backed; editing is just editing the file |

**Krypton delta** — Directive *authoring* becomes "edit a known config file with the tools you already have, on demand," not an always-resident MCP capability. *Assignment* stays a keyboard picker that reloads on open.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Remove the four `directive_*` descriptors from `bus_tool_descriptors()` and their `tools/call` routing (return a "use #directive" error for any stray call). |
| `src/acp/acp-harness-view.ts` | Add `directivePrompt()` builder + `#directive` dispatch in the `#`-command handler (mirror `#wiki`). Remove the now-dead directive-MCP round-trip handlers (`acp-directive-apply-requested` listener, approval card path) — or leave inert. Picker/`refreshDirectives` unchanged. |
| `docs/06-configuration.md`, `docs/124-acp-harness-directive-management.md` | Document `#directive`; mark the MCP directive surface as removed/superseded. |
| `docs/PROGRESS.md` | Record after landing. |

## Design

### `#directive` prompt (one-shot, à la `wikiIngestPrompt`)

Injected via `enqueueSystemPrompt` when the user types `#directive <free-text intent>`. Carries:
- The absolute config path (`acp_harness_config_path()`, already surfaced to the frontend via `commands.rs:283`).
- The TOML schema: a `[[directives]]` array, each with `id` (kebab-case, unique), `title`, `icon`, `description`, `backend` (empty = all), `task`, `system_prompt` (multi-line), `enabled`, `triage_equipped` (legacy).
- Rules: **Read the file first**, preserve existing entries, edit in place, validate `id` uniqueness/format, never touch unrelated directives, treat the user's intent text as the spec.
- The user's intent text (`#directive add a security-review directive for the codex backend`).

### Data Flow (authoring)

```
1. User: #directive create a "security review" directive for codex
2. enqueueSystemPrompt injects the schema + path + intent prompt
3. Agent reads acp-harness.toml, adds a [[directives]] entry, writes it back (its own file tools)
4. User opens the picker (Cmd+P → .) → refreshDirectives() re-reads disk → new directive listed
5. User assigns it as usual
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `#directive …` | Harness composer | Inject the directive-authoring prompt (one-shot) |
| `Cmd+P → .` | Harness | Assign existing directive to focused lane (unchanged; reloads on open) |

## Edge Cases

- **Agent writes invalid TOML / bad `id`:** `acp_harness_config::load()` must tolerate a bad entry (skip + warn) rather than fail the whole config. The `#directive` prompt instructs validation; the next picker open surfaces the result. Confirm `load()` is lenient (or make it so).
- **File outside cwd / sandboxed backend refuses the path:** the agent reports it can't reach the file; the user falls back to hand-editing — the picker reloads on open regardless. The empty-state message already names the path.
- **Lost capability — agent-initiated cross-lane *assign*:** `directive_apply action:assign` let one lane bind a directive to another. Removed with the tools. The keyboard picker covers user-driven assign; cross-lane agent assign is dropped (rare; note in docs).

## Open Questions

None blocking. (Resolved during research: picker reloads on open → no watcher; picker assign independent of the tools; `#wiki` confirms the pattern.)

## Out of Scope

- A file watcher on `acp-harness.toml` (unnecessary — picker reloads on open).
- A graphical/overlay directive editor.
- Per-turn dynamic MCP tool exposure (infeasible).
- Re-adding agent-initiated cross-lane assignment.
- Condensing other tool descriptions (separate change).

## Resources

- N/A — purely internal. Derived from `src-tauri/src/hook_server.rs`, `src-tauri/src/acp_harness_config.rs`, `src/acp/acp-harness-view.ts` (`wikiIngestPrompt`, `#`-dispatch, `openDirectivePicker`/`refreshDirectives`), and `docs/124-acp-harness-directive-management.md`.
