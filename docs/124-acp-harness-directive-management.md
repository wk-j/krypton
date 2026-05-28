# ACP Harness Directive Management — Implementation Spec

> Status: Implemented
> Date: 2026-05-28
> Milestone: M8 — Polish

## Problem

ACP Harness settings currently live inside the global `krypton.toml`, and the harness has no workspace UI for applying reusable directives tied to a backend and task. Users who want directives such as "Codex implementation", "Claude review", or "Cursor exploration" must either paste the same system-style instructions manually or manage a config file themselves. The desired ownership is user-first: users pick predefined directives from Harness config into the active workspace/lane, while lanes can still propose, create, update, list, and assign directives through MCP tools when asked.

## Solution

Add a dedicated Harness config file at `~/.config/krypton/acp-harness.toml` that stores only reusable predefined directives. Krypton loads those directives into the Harness workspace and gives the user a keyboard-accessible directive picker for assigning a config-defined directive to the focused lane. Expose a small directive-management MCP surface on the existing lane-scoped Harness MCP server so agents can list, preview, create, update, delete, or assign directives when asked. Krypton renders the picker, the active composer directive chip, and transcript audit/approval cards for directive assignments or persistent directive mutations. A directive contains one reusable system-style prompt for a specific backend and task; Krypton injects it after the built-in lane-context stub and before the user's prompt. v1 deliberately avoids directive inheritance, presets, defaults, modifiers, and tool ACLs.

Prototype: [`docs/prototypes/124-acp-harness-directive-management.html`](prototypes/124-acp-harness-directive-management.html)

## Research

- Krypton's global config is Rust-owned, TOML-backed, hot-reloaded, and serialized through `KryptonConfig`; adding frequently edited multiline prompts there would make the already-large global file noisier and risk comment-stripping churn.
- `AcpHarnessView` already loads `cfg.acp_harness.lane_models` and injects a short lane-context resource/text block in `buildPromptBlocks()`. The natural extension point is after `renderPromptMemoryPacket()` and before user blocks, where a selected directive can behave as an adapter-agnostic "system prompt" layer.
- Existing model selection stays in `krypton.toml`; Directive Management intentionally does not move or merge `lane_models` in v1.
- VS Code separates reusable prompt files from always-on custom instructions. Prompt files are Markdown, can live at workspace or user scope, and are invoked manually; custom agents are persistent personas with their own instructions and tool lists.
- Zed Agent Panel exposes custom profiles that can be edited either in the UI or by hand in settings, but Krypton should not require this path for v1. Directive management is primarily an MCP capability so the active AI lane can set up or refine the directive library as part of programming work.
- Claude Code supports project/user settings and recommends `CLAUDE.md` or append-system-prompt paths for custom instructions, but backend-specific direct system prompt replacement is adapter-specific and not portable across ACP lanes.
- Existing Harness primitives already cover lane spawn, active-lane prompt routing, permission cards, memory MCP, and peer MCP. Directive Management should stay narrow: reusable directive prompts plus runtime lane assignment.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code Copilot | Prompt files are reusable Markdown files invoked from chat; custom agents are Markdown files with frontmatter, tools, and body instructions. | Clear split between task prompts and persistent agents; supports workspace and user scopes. |
| Zed | Agent profiles can be created or edited in a modal and are stored under `agent.profiles` in settings. | Good precedent for UI-first editing with file-backed settings. |
| Claude Code | Uses global/project settings plus `CLAUDE.md` and append-system-prompt for custom behavior. | Powerful but backend-specific; Krypton should not depend on one adapter's flags. |

**Krypton delta** — Use one Harness-owned TOML file rather than scattering Markdown files into projects. Directives are adapter-agnostic system-style context blocks, not backend-native system prompt replacements, because ACP backends do not share one portable system-prompt API. Directive creation and assignment are exposed to agents through MCP, with user-visible audit/approval in the Harness transcript.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp_harness_config.rs` | New module for loading, validating, and saving `acp-harness.toml`, plus directive mutation helpers used by MCP. |
| `src-tauri/src/lib.rs` / `main.rs` | Register new Tauri commands and module. |
| `src-tauri/src/commands.rs` / `src-tauri/src/hook_server.rs` | Add `directive_list`, `directive_preview`, and `directive_apply` bus tools to the existing lane-scoped `krypton-harness-bus` MCP endpoint. Read-only tools answer from Rust; `assign` and persistent `upsert`/`delete` block on a frontend round-trip (same pattern as `peer_send`). |
| `src/config.ts` | Add frontend types and helpers for `AcpHarnessUserConfig`. |
| `src/input-router.ts` | Add the focused Harness leader binding (`Cmd+P → R`) through the existing focused-leader mechanism. No new global `Mode`. |
| `src/acp/acp-harness-view.ts` | Load directives, handle the directive picker as an internal overlay (same pattern as the lane picker / memory drawer), bind selected directives to lanes at runtime, render directive audit cards, apply active directive in prompt blocks, answer directive MCP round-trips, and support directive mutation events. |
| `src/styles/acp-harness.css` | Add directive picker, directive mutation cards, and composer assignment chip styles. |
| `docs/06-configuration.md` | Document `acp-harness.toml`, migration behavior, and examples. |
| `docs/72-acp-harness-view.md` | Update Harness flow and keybinding surface. |
| `docs/PROGRESS.md` | Record implementation after landing. |

## Design

### Data Structures

Rust and TypeScript mirror the same TOML shape:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AcpHarnessUserConfig {
    pub version: u32,
    pub directives: Vec<HarnessDirective>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HarnessDirective {
    pub id: String,
    pub title: String,
    pub icon: String,          // short glyph or 1-2 character label for picker scanning
    pub description: String,
    pub backend: String,       // empty = all backends
    pub task: String,          // free-form task key, e.g. implementation/review/research
    pub system_prompt: String, // reusable system-style prompt block
    pub enabled: bool,
}
```

Default implementations must be hand-written `impl Default` blocks, **not** `#[derive(Default)]`: derive would resolve `version` to `0` and `enabled` to `false`, so under `#[serde(default)]` a hand-written directive missing `enabled` would silently deserialize as disabled. The explicit impls return `AcpHarnessUserConfig { version: 1, directives: [] }` and `HarnessDirective { enabled: true, .. }` with empty strings elsewhere. Missing or empty `icon` falls back to a deterministic glyph derived from `task` or `backend`.

Frontend-only lane state:

```ts
interface HarnessLane {
  // existing fields...
  activeDirectiveId: string | null;
  // Deferred lane-scope change while the lane is busy; promoted to
  // activeDirectiveId before the next prompt. The wrapping object disambiguates
  // "no change queued" (`null`) from "queued clear" (`{ directiveId: null }`),
  // which would be impossible to express if the field itself were a nullable id.
  pendingDirectiveChange: { directiveId: string | null } | null;
  // MCP scope = "next_turn"; used for one prompt then cleared. Same sentinel
  // structure as `pendingDirectiveChange` so a one-shot clear can be expressed.
  turnDirectiveOverride: { directiveId: string | null } | null;
  previousDirectiveId: string | null; // restored after a next-turn override completes
}
```

Config file example:

```toml
version = 1

[[directives]]
id = "codex-implementation"
title = "Codex Implementation"
icon = "⌘"
description = "Scoped code changes and narrow verification."
backend = "codex"
task = "implementation"
enabled = true
system_prompt = """
You are the implementation lane. Make scoped edits, follow existing patterns, and run the narrowest useful checks before reporting changed files.
Do not repeat Harness memory or peering instructions; Krypton already provides them before this directive block.
"""

[[directives]]
id = "claude-review"
title = "Claude Review"
icon = "◇"
description = "Read-only review for regressions and missing tests."
backend = "claude"
task = "review"
enabled = true
system_prompt = """
You are the review lane. Do not edit files. Prioritize bugs, regressions, risky assumptions, and missing tests.
"""
```

### API / Commands

```rust
#[tauri::command]
pub fn get_acp_harness_config() -> Result<AcpHarnessUserConfig, String>;

#[tauri::command]
pub fn get_acp_harness_config_path() -> Result<String, String>;
```

Directive bus tools exposed on the existing lane-scoped `krypton-harness-bus` MCP endpoint:

```ts
directive_list(): { directives: HarnessDirectiveSummary[] };
directive_preview({ directive_id, sample_user_text? }): { text: string; estimated_tokens?: number };
directive_apply({
  action: 'upsert' | 'delete' | 'assign',
  directive?: HarnessDirective,
  directive_id?: string,
  lane?: string,
  scope?: 'next_turn' | 'lane',
  reason: string,
}): {
  action: string;
  approval: 'auto' | 'approved' | 'rejected';
  directive?: HarnessDirective;
  deleted?: boolean;
  assigned?: boolean;
  lane?: string;
};
```

**Ownership and the approval gate.** The bus MCP tools execute inside Krypton's Rust HTTP handler (`handle_bus_tool_call`) the moment the endpoint is hit. The ACP `session/request_permission` flow is backend-initiated and not every adapter raises it before calling an MCP tool, so it cannot gate a persistent config write. Directive tools therefore split by ownership:

- `directive_list` and `directive_preview` are read-only. Rust answers them directly from the loaded `acp-harness.toml` (like `memory_list` / `memory_get`). `approval: "auto"`.
- `directive_apply({ action: "assign" })` mutates **frontend runtime lane state** (`activeDirectiveId`, etc.), which Rust does not own. The handler blocks on a frontend round-trip (the `peer_send` pattern: emit an event, await the coordinator's reply with a timeout). The frontend validates backend/enabled compatibility against live lane state, applies the binding, and returns `assigned`/`lane`. Same-lane assignment (omitted `lane` = caller's lane) resolves with `approval: "auto"`; cross-lane assignment requires explicit user approval in the frontend round-trip and returns `approved` or `rejected`.
- `directive_apply({ action: "upsert" | "delete" })` mutates **persistent config**. Rust validates the payload up front and rejects malformed input as a tool error before any round-trip, so the approval card only ever shows a valid proposal. The handler then blocks on the same frontend round-trip so the user sees the approval card and decides before Rust writes the file. On approval Rust writes atomically and returns the normalized directive; on rejection nothing is written and the tool returns `approval: "rejected"`. This is a real gate, not a best-effort one that depends on the backend choosing to ask.
- For `directive_apply({ action: "assign" })`, omitted `lane` means the caller's own lane and omitted `scope` means `"lane"`.
- A round-trip that times out or finds no frontend coordinator returns a tool error (same failure shape as `peer_send`); no config is written and no binding changes.
- Future config may add trusted auto-allow for directive mutations, but v1 keeps persistent writes and cross-lane assignment user-visible.

Validation rules:

- `id` must be non-empty, unique, lowercase kebab-case (`[a-z0-9][a-z0-9-]*`).
- `icon` is optional and should be one visible glyph or a short 1-2 character label; trim whitespace and fall back when empty.
- `backend` is empty or one of the built-in backend ids.
- `task` is empty or lowercase kebab-case (`implementation`, `review`, `research`, `planning`, etc.).
- `system_prompt` is trimmed for storage but may contain newlines.
- `system_prompt` has a hard cap of 16 KiB.
- Save is atomic: write `<path>.tmp`, then rename.
- `estimated_tokens` from `directive_preview` is an approximation (≈ characters / 4); Rust ships no tokenizer, so it is labeled as a rough estimate, not an exact count.

### Data Flow

```
1. User opens ACP Harness.
2. AcpHarnessView calls get_acp_harness_config().
3. Missing file creates a default `acp-harness.toml` with no directives.
4. Harness renders the config-defined directives in a workspace directive picker.
5. User opens the picker from the focused lane/composer directive chip.
6. User selects a directive and spawns a new lane initialized with that directive.
7. Harness creates a new lane (backend from `directive.backend`, or a fallback when empty), sets that lane's `activeDirectiveId`, focuses it, and renders an audit event.
8. Each spawned lane also receives MCP directive tools alongside memory/peer tools when Harness MCP is available.
9. An agent can call `directive_list` to inspect reusable directives (Rust answers directly).
10. An agent can call `directive_preview` to inspect the exact context block when needed (Rust answers directly).
11. An agent can call `directive_apply` with `action = "upsert"`, `"delete"`, or `"assign"` when the user asks it to manage directives.
12. A `directive_apply` call blocks in the Rust handler on a frontend round-trip. The frontend renders an approval card (for persistent or cross-lane changes) or auto-approves same-lane assignment, then replies.
13. For approved `upsert`/`delete`, Rust validates fully and writes `acp-harness.toml` atomically before returning normalized config; for `assign`, the frontend applies the runtime binding and returns `assigned`/`lane`. Rejected or timed-out round-trips write nothing and change no binding.
14. Harness updates the directive list and any affected chip immediately without respawning lanes.
15. New lanes start with no active directive unless a runtime assignment already exists in the current Harness session.
16. On submit, buildPromptBlocks() emits:
   a. one leading context packet containing the lane-context stub plus active directive block, if any
   b. images and user text
```

Directive block construction:

```
1. Resolve activeDirectiveId (or the active turn override) to a directive.
2. Use that directive's `system_prompt` directly; no directive inheritance or composition.
3. Append the directive block to the existing single packet produced by `renderPromptMemoryPacket()`, separated by a heading, so `buildPromptBlocks()` still emits exactly one leading resource/text block. This keeps adapters that only respect the first resource/text block seeing both the lane-context stub and the directive; do not emit the directive as a second block.
```

Assignment scope behavior:

- User picker selection spawns a new lane initialized with the chosen directive. The new lane's `activeDirectiveId` is set at creation; because the lane starts fresh and idle, no `pendingDirectiveChange` deferral applies on its first prompt. The picker does not modify any existing lane's `activeDirectiveId` — to clear the focused lane's directive use `Backspace` in the picker, and to reassign a directive on an existing lane use MCP `directive_apply` with `action = "assign"`.
- MCP `scope = "lane"` binds the directive to the target lane (defaults to the calling lane). It sets `activeDirectiveId` immediately when the lane is idle, or queues `pendingDirectiveChange = { directiveId }` (with `directiveId: null` for a clear) when the lane is busy; the queued change is promoted into `activeDirectiveId` just before the next user prompt is sent. A queued clear is preserved as `{ directiveId: null }` so it cannot be confused with "no change queued".
- MCP `scope = "next_turn"` stores `previousDirectiveId = activeDirectiveId`, sets `turnDirectiveOverride = { directiveId }`, uses that override (including a one-shot clear when `directiveId` is `null`) for exactly one prompt, then clears `turnDirectiveOverride` and restores `activeDirectiveId = previousDirectiveId`.

### Keybindings And Commands

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+P` then `.` | Focused ACP Harness | Open the directive picker overlay for the focused lane |
| Click | Composer directive chip | Open the directive picker for the focused lane (secondary, mouse-only) |
| `ArrowUp` / `ArrowDown` (or `j`/`k`) | Directive picker | Move through predefined directives loaded from `acp-harness.toml` |
| `Enter` | Directive picker | Spawn a new lane initialized with the selected directive |
| `Backspace` | Directive picker | Clear directive from the focused lane |
| `Esc` (or `q`) | Directive picker | Close without changing assignment |

The keyboard path to open the picker is `Cmd+P → .`. Note: spec originally proposed `R`, but every letter is a reserved global leader key and `/` `;` `?` are taken by the markdown/pencil views, so `.` is the free non-reserved key. The composer directive chip is a visible status indicator and a mouse click target, not a keyboard focus target (the composer keeps text focus, and `Tab` continues to cycle lane tabs).

Directive Management does not add custom composer commands in v1. Users primarily pick predefined directives from the workspace directive picker. Users can also ask an active lane in normal language to inspect, create, update, delete, or assign directives; the lane performs that work through `directive_list`, `directive_preview`, and `directive_apply`. Multi-lane coordination continues to use the existing `peer_send` tool only.

Implementation adds the directive picker as an internal harness overlay handled inside `AcpHarnessView.onKeyDown` — the same way the existing lane picker (`handlePickerKey`) and memory drawer are handled — **not** as a global `input-router` `Mode`. Opening the picker closes other harness overlays, captures keys for the picker list, and blocks composer text input until `Enter`, `Backspace`, or `Esc` resolves it. `input-router` only contributes the focused-leader binding `Cmd+P → R`, registered through the same focused-leader mechanism as `Cmd+P → +/_/=/0`.

### UI Changes

Keep UI minimal:

- Composer status line shows a compact selectable chip: `directive codex-implementation` or `directive none`.
- Directive picker lists predefined directives from `acp-harness.toml` in a flat list: compatible enabled directives first, then disabled or incompatible directives.
- Picker rows show a directive icon, title, id, backend/task, enabled state, and a one-line description.
- Picker detail pane previews the injected directive block before assignment and may show `estimated_tokens` when available.
- Directive picker, rows, preview panes, and audit cards must not use left-border rails; state is communicated with text, full outlines, tint, and chip color.
- Selecting a predefined directive spawns a new lane (backend from `directive.backend`, or fallback when empty) with that directive active. No persistent config is written.
- Directive MCP mutations render transcript cards with requested action, directive id, backend/task, requesting lane, reason, and approval decision.
- For `upsert`, the approval card shows a compact before/after diff of `system_prompt` when updating an existing directive.

No manual text editor ships in v1. Users can still edit `acp-harness.toml` directly, but the primary in-app workflow is: select a predefined config directive in the workspace picker, spawn a new lane initialized with it, then observe the directive chip on the new lane. Agent-assisted persistent directive creation or edits remain available through MCP permission cards.

### Configuration

New file: `~/.config/krypton/acp-harness.toml`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `version` | int | `1` | Schema version for future migrations |
| `[[directives]]` | array | `[]` | Reusable Harness directives |

Existing `[acp_harness]` settings in `krypton.toml`, including `lane_models`, remain where they are in v1. Directive Management does not migrate model config.

## Edge Cases

- **Malformed TOML:** return a validation error to MCP calls; keep the last in-memory config for active lanes.
- **Directive deleted while assigned:** active lanes fall back to `null` directive and show `directive none`.
- **Directive has `enabled = false`:** show it disabled in the picker with reason `disabled`; reject assignment from UI and MCP.
- **Directive backend mismatch:** a Codex-only directive cannot be assigned to a Claude lane unless `backend = ""`.
- **Directive task mismatch:** allowed by explicit assignment; task is descriptive in v1 and does not drive defaults.
- **Active lane already busy:** changing its directive affects the next prompt only.
- **Directive edited mid-turn:** existing turn keeps the old prompt context; composer shows `directive changes next send`.
- **Agent tries to edit another lane's active assignment:** the frontend round-trip renders a cross-lane approval card; the binding changes only if the user approves, otherwise the tool returns `approval: "rejected"`.
- **Agent directive mutation spam:** one outstanding directive round-trip per lane; a second `directive_apply` from the same lane while one is pending fails immediately with a clear reason (mirrors `peer_send`'s one-outstanding-per-target rule) rather than queueing approval cards.
- **Harness MCP unavailable:** directive tools are unavailable to agents; existing file-backed directives still load for prompt injection.
- **No Harness memory:** directive system prompt still applies; lane-context stub already explains memory unavailability.
- **Large prompt:** cap directive block at 16 KiB to avoid accidental huge context injection.
- **Two resources risk:** directive text is concatenated into the same leading lane-context packet instead of emitted as a second resource, because some adapters may only preserve the first resource-like context block.
- **Concurrent edit on disk:** v1 uses last-save-wins; overlay can show a dirty warning if save fails.

## Open Questions

None. This spec assumes directives are injected as ACP prompt context, not backend-native system prompts.

## Out of Scope

- Replacing backend-native system prompts.
- Per-project `acp-harness.toml` discovery.
- Restricting tools per directive.
- Directive inheritance or directive composition.
- Spawn presets / lane kits.
- Backend/task/default directive resolution.
- Directive modifiers, suggested memory tags, readonly auditing, or generated directive hints.
- Manual directive editor UI.
- Directive observer drawer.
- Directive import/export UI.
- Prompt templating variables beyond the built-in lane-context stub.
- Workflow graph execution, automatic task scheduling, or broadcast prompting.
- Live hot-reload for external edits.

## Resources

- [VS Code prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files) — Prompt files are task-specific Markdown, manually invoked, and can be created/edited from an in-app customization editor.
- [VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents) — Custom agents are persistent Markdown-defined personas with metadata and body instructions.
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) — Custom agent profiles can be edited in a modal or by hand in settings.
- [Claude Code settings](https://code.claude.com/docs/en/settings) — Custom instructions are handled through settings, `CLAUDE.md`, or append-system-prompt, reinforcing that backend-native system prompt control is adapter-specific.
