# `/tools` — Built-in MCP Tool Reference Page — Implementation Spec

> Status: Implemented
> Date: 2026-07-04
> Milestone: M-ACP — Harness Multi-Agent
> Builds on: `docs/0185-hash-command-reference-page.md` (commands page), `docs/0171-docs-browser.md`, `docs/0170-artifact-gallery-endpoint.md`

## Problem

The harness-memory MCP server exposes 12 built-in tools (`handoff_*`, `peer_*`,
`artifact_*`, `attention_*`, `review_outcome`, `mark_review_priority`,
`issue_progress`) that shape every lane's behavior, but the human has no place to
read what a lane can call, what each tool's contract is, or what the agent-facing
descriptions actually say. `#mcp` prints only a status line; the full
descriptions — which carry the real policy (peer_send lifecycle, attention
calibration, artifact style rules) — are visible only in source.

## Solution

Add a fifth read-only loopback surface: **`GET /tools`** serves a static shell
(`src/acp/artifact-tools.html`, Binance dark per `DESIGN.binance.md`) that
fetches **`GET /tools.json`**. Unlike spec 185 there is **no manifest push**:
the tool descriptors already live in Rust (`bus_tool_descriptors()` in
`hook_server.rs`) as the exact `tools/list` payload, so the JSON handler
serializes them directly and augments each with a `category` — zero drift by
construction, no Tauri command, no store slot, no frontend involvement beyond
a `#tools` palette entry that opens the page like `#commands`.

## Research

- **Source of truth is Rust, not TS.** `tools/list` returns
  `bus_tool_descriptors()` unconditionally (`hook_server.rs:1508`) — same 12
  tools for every lane, every harness, compile-time data. This inverts the
  spec-185 situation (roster lived in TS, needed a push); here the server can
  self-serve with a one-line handler.
- **Descriptors carry everything the page needs**: `name`, long agent-facing
  `description`, full JSON-Schema `inputSchema` with per-property
  `description`, `enum`, `default`, `required`, `maxLength`. The page renders
  the params table entirely from the schema.
- **Category augmentation must NOT touch `tools/list`.** The Kotlin MCP SDK
  (Junie) already proved strict about protocol shape (see the
  `protocolVersion` negotiation comment at `hook_server.rs:1480`), so the
  non-standard `category` field is injected only in `handle_tools_json`, never
  into the MCP response.
- **Serving pattern (specs 170/171/185):** standalone HTML in
  `src/acp/artifact-*.html`, `include_str!` const, paired JSON route, both
  added to the axum route-conflict canary test (~`hook_server.rs:4910`).
- **Palette:** `tools` is free in `HASH_COMMANDS`; dispatch mirrors the
  `#commands` branch (`acp-harness-view.ts:8026`). The spec-185 manifest
  metadata map gains a `tools: { category: 'surface' }` entry so the new
  command also appears on the `/commands` page.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| MCP Inspector (`modelcontextprotocol/inspector`) | Dev web UI: connects to a server, lists tools, renders schema-driven forms | closest analogue; requires launching a separate dev tool |
| Claude Code | `/mcp` TUI: per-server tool list, name + description, scrollable | in-product but terminal-bound, no schema table |
| Zed | context-server tools shown in agent panel settings | names only, no contract detail |
| VS Code (MCP) | server view lists tools with descriptions | no schema rendering |

**Krypton delta** — matches the Inspector's schema-rendered reference but
serves it from the already-running loopback hook server (no separate tool to
launch), read-only, opened keyboard-first by typing `#tools`. Continues the
spec-185 transparency theme: the *agent-facing* descriptions — the actual
behavioral contract — are shown verbatim to the human.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/artifact-tools.html` | **New.** Static shell (Binance dark, mirrors `artifact-commands.html` visual system); fetches `/tools.json`, renders category sections → tool cards → params table + description |
| `src-tauri/src/hook_server.rs` | `TOOLS_HTML` const + `handle_tools` + `handle_tools_json` (descriptors + category map) + `/tools` + `/tools.json` routes + canary-test entries + coverage test |
| `src/acp/hash-commands.ts` | Add `tools` palette entry + spec-185 manifest metadata for it |
| `src/acp/acp-harness-view.ts` | `#tools` branch in `runHashCommand` (mirrors `#commands`) |
| `src/acp/hash-commands.test.ts` | Extend: manifest covers the new `tools` entry |
| `DESIGN.binance.md` | Add the tools page to `appliesTo` surfaces |
| `docs/PROGRESS.md` | Register the new surface |

## Design

### `/tools.json` payload

```rust
/// Category per tool, page-only (never leaks into MCP tools/list).
fn tool_category(name: &str) -> &'static str {
    match name {
        "handoff_set" | "handoff_get" | "handoff_list" => "memory",
        "peer_send" | "peer_list" => "peering",
        "artifact_new" | "artifact_register" | "artifact_cancel" => "artifacts",
        "attention_flag" | "attention_resolve" => "attention",
        "timeline_record" | "timeline_list" | "timeline_merge" | "timeline_pending_resolve"
            | "timeline_conflict_list" | "timeline_conflict_record"
            | "timeline_conflict_checked" => "timeline",
        "review_outcome" | "mark_review_priority" => "review",
        "issue_progress" => "issues",
        _ => "other", // forward-compat: unmapped tools still render
    }
}

async fn handle_tools() -> Response { html_response(TOOLS_HTML) }
async fn handle_tools_json() -> Response {
    // bus_tool_descriptors() + injected "category" per entry, no-store
}
```

Payload shape: `{ "tools": [ { name, description, inputSchema, category } ] }`.

The page picks up contracts directly from Rust descriptors. Timeline's final category contains
`timeline_record`, `timeline_list`, `timeline_merge`, `timeline_pending_resolve` and the three
conflict tools; `timeline_suggest` is removed ([spec 316](0316-llm-managed-timeline.md)).
Record requires `topic_title`, `summary`, `made_by`, `evidence_kind`
(`user_statement`, `observed_outcome`, `agent_decision`) and `evidence_excerpt`, with optional
`topic_id`, `occurred_at`, `rationale`, `impact`, `source_ref`, `relation`, `related_event`;
`instruction_excerpt` has no alias. List supports topic discovery/events (default 20/max 50),
exclusive `event_id` detail, or exclusive `pending:true` intake (default 5/max 20, remaining
count and diagnostics). Resolver takes `pending_id`, `outcome`, `rationale` and outcome-specific
`record` or `event_id` for record/duplicate/discard. Merge takes `from`/`into` or `undo:true`
with required `rationale`. Descriptors carry autonomous ownership, read-only restrictions and
ordinary-turn legacy processing even when programmatic turns bypass lane policy. The page
is reference only, not mutation/approval UI. Rollout requires normally reconnected sessions
to obtain new schemas; displaying this reference does not migrate production backlog.

### Data Flow

```
1. User types #tools → runHashCommand resolves get_hook_server_port →
   open_url http://127.0.0.1:{port}/tools (flashChip like #commands)
2. Shell loads, fetches /tools.json (always available — compile-time data,
   no harness registration required, unlike /commands.json)
3. Page groups tools by category into sections; each card renders:
   name (mono), category badge, the full agent-facing description, and a
   params table from inputSchema: property · type · required · constraints
   (enum values, default, maxLength) · per-property description
4. No polling — descriptors change only with a new build
```

### UI

Same visual system as `/commands` (header stat tiles: 12 tools · 6 categories ·
N required-param counts; section headers; card grid). Tool descriptions are
long (peer_send ≈ 200 words) — render them in a collapsed `<details>`
("agent-facing description") with a 2-line plain excerpt always visible, so
the page scans as a reference and expands to the verbatim contract. Params
table always visible (that is the quick-reference half). Required properties
marked; enum values and defaults rendered as mono chips. No left-border
rails, no nested containers, dark-only.

### Keybindings

None — opened by typing `#tools` in the composer (palette autocomplete).

## Edge Cases

- **No harness registered** — irrelevant: descriptors are compile-time; the
  page is fully populated as soon as the hook server runs.
- **Hook server not ready** — `#tools` guards on port 0 like `#commands`.
- **Future tool without a category mapping** — falls into `other` and still
  renders (coverage test asserts every descriptor name has a non-`other`
  category, so the omission is caught at test time, not hidden at runtime).
- **Route conflict** — `/tools` + `/tools.json` added to the canary test.
- **Non-string schema constants** (`maxLength: MEMORY_DETAIL_MAX` etc.) —
  already serialized as numbers in the descriptors; the page prints them as-is.

## Open Questions

None — content source (Rust descriptors, page-only category injection), route
names, palette entry, and description-collapse rendering are decided above.

## Implementation Deviations

- **`tools_json_payload()` extracted** — the handler body moved into a pure
  function so the Rust coverage test pins the actual served payload (including
  the injected `category`) rather than re-deriving it; the test also asserts
  the MCP-facing descriptors stay category-free.
- **Extra coverage** — beyond the planned manifest-entry test, a page smoke
  test in `hash-commands.test.ts` evals the tools page's inline script with
  stubbed `document`/`fetch` against descriptor-shaped fixtures (mirrors the
  spec-185 commands-page smoke test), guarding the schema-traversal rendering
  (required stars, constraint chips, array-item shapes, zero-param fallback).

## Out of Scope

- Documenting *agent-provided* MCP tools from user-configured `.mcp.json`
  servers (dynamic, per-lane; this page covers built-ins only).
- Per-lane tool availability views (tools/list is unconditional today).
- Merging the page into `/commands` (different audience: what the user can
  type vs what the lane can call; cross-links may come later).
- Localization (loopback surfaces are English today).

## Resources

- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — prior
  art for schema-driven tool reference UI.
- [MCP spec — tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) —
  tool descriptor shape (`name`/`description`/`inputSchema`) the page renders;
  confirms extra fields on descriptors are non-standard, motivating the
  page-only category injection.
- Internal: `docs/0185-hash-command-reference-page.md`, `docs/170-*`,
  `docs/171-*`, `DESIGN.binance.md`, `bus_tool_descriptors()` /
  `attention_tool_descriptors()` in `src-tauri/src/hook_server.rs`.

## Revision — spec 341 loopback app

`src/acp/artifact-tools.html` is deleted. `GET /tools` now returns `AppPage::new("tools", "MCP tools", Scheme::Dark)`; the page is the Vite entry `src/loopback/entries/tools.ts` mounting `ToolsView` from `src/loopback/surfaces/tools/` (`index.ts`, `tools.css`, `tools.test.ts`). One `fetchJson('/tools.json')`, no polling. Sections are now derived from the categories present in the payload (`toolSections()`): known categories keep a preferred order (memory, lessons, peering, artifacts, attention, timeline, review, issues, e2e, other) and any unknown category is appended under its own name. This fixes the old hardcoded `SECTIONS` list, which silently dropped the `timeline_*` tools and `e2e_adapter_check`. Each tool is a kit `card` (`article`) with a `DataTable` params table (param / type / description; required `*`, muted `chip(text, { muted: true })` constraint chips for enum / default / bounds, array-of-object item shapes inline), the clamped excerpt and the full description behind `<details>` (now `white-space: pre-wrap`). `StatBar` shows tools / categories / parameters; `emptyState` covers loading, no descriptors and load failure. Visual normalisation: the brand header and `.nav` link bar are gone (the shell switches surfaces), the blue/purple/green/red category hues are dropped (the category is a muted text label), headings are no longer uppercase. The `artifact-tools.html render` test is replaced by DOM tests of `ToolsView` with a descriptor fixture that includes a `timeline_*` tool, `e2e_adapter_check` and an unknown category.
