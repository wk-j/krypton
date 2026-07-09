# `/commands` — Built-in Hash-Command Reference Page — Implementation Spec

> Status: Implemented (rev 2 — adds system-prompt visibility, pivots to manifest-driven content)
> Date: 2026-07-04
> Milestone: M-ACP — Harness Multi-Agent
> Builds on: `docs/168-*` (lane-monitor dashboard), `docs/170-artifact-gallery-endpoint.md`, `docs/171-docs-browser.md`

## Problem

The harness has 23 built-in `#` commands but no place that explains them. The
composer palette (`src/acp/hash-commands.ts`) shows only a one-line hint per
command, three commands (`#docs`, `#console`, `#dispatch-github-issue`) are dispatch-only
and invisible in the palette, and — the part the palette can never show — ten
commands inject a **system prompt** into the lane that the user cannot read
anywhere today (`#goal set`, `#handoff`, `#resume`, `#wiki`, `#recall`,
`#directive`, `#review`, `#polly`, `#debby`, `#dispatch-github-issue`).

## Solution

Add a fourth read-only loopback surface: **`GET /commands`** serves a static
page shell (`src/acp/artifact-commands.html`, Binance-dark per
`DESIGN.binance.md`) that fetches **`GET /commands.json`** — a command
manifest the frontend builds from the *same* `HASH_COMMANDS` array and the
*same* exported prompt-builder functions the dispatch actually calls, and
pushes to the hook server once at harness register. A new `#commands` palette
entry opens the page like `#docs`.

**Layout (rev 2 — master/detail):** the page is a two-pane split rather than a
card grid, because the primary task is *reviewing a system prompt*, and a full
template read poorly inside a narrow grid card behind a `<details>` toggle. The
left pane is a searchable command list grouped by the three categories (each
entry carries a dot marking whether it has an injected prompt); the right pane
is a full-height detail view for the selected command: name, args grammar,
description, badges, alias, lanes, and workflow anatomy pinned above a
full-width **system prompt** panel that scrolls independently, with placeholder
`<token>`s accent-tinted and a copy button. Selection defaults to the first
prompt-backed command. Keyboard: `↑/↓` or `j/k` navigate, `/` focuses search,
`c` copies the prompt. No left-border rails, flat chrome (one surface per pane).

## Research

- **Serving pattern (spec 170/171):** fixed pages are standalone HTML in
  `src/acp/artifact-*.html`, `include_str!`-ed in `hook_server.rs`, paired
  with a JSON endpoint when data is needed (`/telemetry`, `/artifacts`). The
  manifest push mirrors `store_telemetry` (spec 168) but is a one-shot at
  register — the manifest is compile-time data, identical for every harness,
  so the store is a single global slot, not per-harness.
- **Prompt sources (all already pure/exported unless noted):**
  `goalSeedPrompt(text)`, `HANDOFF_WRITE_PROMPT`,
  `handoffResumePrompt(lane)`, `wikiIngestPrompt(hint)`,
  `wikiRecallPrompt(question)`, `directivePrompt(configPath, intent)` — all in
  `acp-harness-view.ts`; `reviewRequestPrompt` (`review.ts`),
  `pollyRequestPrompt` (`polly.ts`), `debbyRequestPrompt` (`debby.ts`);
  `buildFixPrompt(binding, body?)` is a **private method** and must be
  extracted as an exported pure function so the manifest can render it.
- **Content source — alternatives considered:**
  1. *Hand-authored static page + name-sync test* (rev 1 choice) — cannot
     carry the prompt texts without copying them; prompts change often
     (Polly is on rev 8), so copied text would rot immediately. Ruled out by
     the prompt-visibility requirement.
  2. *Manifest pushed from the frontend* (**chosen**) — zero drift for
     roster *and* prompt text: the manifest calls the very builders the
     dispatch uses, with placeholder args (`<task>`, `<question>`, `<lane>`,
     `<worker-1 (cursor)>`, …). Costs one Tauri command + one store slot +
     one JSON route.
  3. *Duplicate table in Rust* — worst of both; ruled out.
- **Roster metadata:** category/badges/anatomy notes move into the manifest
  entries (declared next to `HASH_COMMANDS`), so the page renders entirely
  from data and `hash-commands.ts` stays the single source of truth.
- **Route safety:** the axum route-conflict canary test (~`hook_server.rs:4837`)
  must gain both new routes.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| tmux | `list-commands` / `list-keys` print into the pane | text dump, no grouping, no prompt equivalent |
| Zellij | permanent status-bar keybinding hints | surface-level only |
| VS Code | "Keyboard Shortcuts Reference" cheat-sheet opened out-of-band | closest analogue for the reference surface |
| Claude Code / aider | publish their injected prompts only in source/docs | no in-product prompt transparency surface |

**Krypton delta** — matches the VS Code convention (dedicated read-only
reference opened out-of-band) and goes beyond market practice by exposing the
injected system prompts verbatim — prompt transparency as a first-class
observability feature, served from the already-running loopback hook server.
Keyboard-first: opened by typing `#commands`.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/artifact-commands.html` | **New.** Static shell (Binance dark); fetches `/commands.json`, renders the searchable master list + full-height detail/system-prompt pane (rev 2; see Overview) |
| `src/acp/hash-commands.ts` | Add `commands` entry; add manifest metadata (category, badges, anatomy) + `buildCommandManifest()` calling the prompt builders with placeholder args |
| `src/acp/acp-harness-view.ts` | Export `issueFixPrompt` (extracted from private `buildFixPrompt`); push manifest at register; `#commands` branch in `runHashCommand` (mirrors `#docs`) |
| `src-tauri/src/hook_server.rs` | `COMMANDS_HTML` const + `handle_commands` + manifest store + `acp_store_command_manifest` Tauri command + `/commands` + `/commands.json` routes + canary-test entries |
| `src/acp/hash-commands.test.ts` | **Extend** (file exists): manifest covers every palette name + dispatch-only names; every prompt-backed command carries non-empty prompt text |
| `DESIGN.binance.md` | Add the commands page to `appliesTo` surfaces |
| `docs/PROGRESS.md`, `docs/04-architecture.md` | Register the new surface |

## Design

### Manifest (`buildCommandManifest()`)

```ts
interface CommandManifestEntry {
  name: string;            // 'polly'
  args: string;            // '<task>'
  description: string;
  category: 'session' | 'surface' | 'agent';
  badges: ('workflow' | 'agent' | 'hidden')[];  // hidden = not in palette
  alias?: string;          // 'console' on the orchestrator entry
  anatomy?: string;        // 'ensure workers → fan-out via peer_send → …'
  lanes?: string;          // '3 lanes' | '+1 lane' | 'same lane'
  prompt?: string;         // real template rendered with placeholder args
}
```

Placeholder args by convention: `<task>`, `<question>`, `<hint>`, `<intent>`,
`<lane>`, `<config-path>`, `<owner/repo#123>`, roster placeholders
`<worker-1 (cursor)>` / `<head-1 (claude)>`. Builders are called at manifest
build time; the output is the same text the lane receives modulo those
tokens.

### API / Commands

```rust
const COMMANDS_HTML: &str = include_str!("../../src/acp/artifact-commands.html");
async fn handle_commands() -> Response { html_response(COMMANDS_HTML) }
async fn handle_commands_json(...) -> Response { /* Json(store.command_manifest) , no-store */ }

#[tauri::command]
pub fn acp_store_command_manifest(manifest: Value, hook_server: State<Arc<HookServer>>) -> Result<(), String>
```

### Data Flow

```
1. Harness registers → frontend calls buildCommandManifest() once →
   invoke('acp_store_command_manifest', { manifest })
2. User types #commands → runHashCommand resolves get_hook_server_port →
   open_url http://127.0.0.1:{port}/commands (flashChip like #docs)
3. Page shell loads, fetches /commands.json, renders the searchable master
   list (grouped by the three categories) + a full-height detail pane; the
   selected command's template renders full-width in the scrolling system-prompt
   panel with anatomy/badges pinned above it
4. No polling — the manifest changes only with a new build
```

### UI

Binance-dark visual system. **Rev 2** replaces the rev-1 card grid with a
master/detail split (see Overview): a searchable left list (a green dot marks
prompt-backed commands) and a right detail pane whose scrolling system-prompt
panel (mono 11.5px, placeholder tokens tinted accent, copy button) gets the
full window height instead of a collapsed 300px `<details>` box. Header stat
tiles are computed from the manifest (29 commands · workflow badges · 15
prompts; `#console` is an alias on the `#orchestrator` entry, not its own
list row). Keyboard nav (`↑/↓`·`j/k`·`/`·`c`). No left-border rails, one flat
surface per pane, dark-only.

## Edge Cases

- **Page opened before any harness registered** — `/commands.json` returns
  `{ "commands": [] }`; the shell shows an empty-state hint covering both
  no-harness-yet and manifest-push-failed (the push is warn-only).
- **Hook server not ready** — `#commands` guards on port 0 like `#docs`.
- **Multiple harnesses** — manifest is compile-time identical; last write
  wins in the single global slot (harmless by construction).
- **Route conflict** — `/commands` + `/commands.json` added to the canary test.
- **Alias rendering** — `#console` shown as alias on the `#orchestrator` card.

## Open Questions

None — content source (manifest-driven), route names, palette entry, and the
`buildFixPrompt` extraction are decided above.

## Implementation Deviations

- **`src/acp/harness-prompts.ts` (new leaf module)** — the spec said "export
  the builders from `acp-harness-view.ts`", but `acp-harness-view.ts` imports
  `hash-commands.ts`, so the manifest importing the view back would create a
  module cycle. The six view-hosted builders plus the extracted
  `issueFixPrompt` moved to the leaf module; the view re-exports
  `wikiIngestPrompt` / `wikiRecallPrompt` / `directivePrompt` so existing
  import sites (tests) are untouched.
- **`docs/04-architecture.md` not edited** — the sibling loopback surfaces
  (dashboard/gallery/docs browser) are not registered there either; per-feature
  specs + `DESIGN.binance.md` + `docs/PROGRESS.md` carry the registration.
- **Extra coverage** — beyond the planned manifest tests, a smoke test evals
  the page's inline script with stubbed `document`/`fetch` against the real
  manifest, guarding the page↔manifest field contract without a browser. A
  Rust round-trip test covers the store + `/commands.json` slot.

## Out of Scope

- Adding `#docs` / `#dispatch-github-issue` to the composer palette (separate decision).
- Documenting agent-provided `/` slash commands, `@lane` mentions, or
  user-authored directives (config, not built-ins).
- Live per-lane prompt preview with real args (the page shows templates with
  placeholder tokens, not a lane's actual rendered turn).
- Localization of the page (loopback surfaces are English today).

## Resources

- N/A — purely internal change. Design draws on existing specs
  (`docs/168-*`, `docs/170-artifact-gallery-endpoint.md`,
  `docs/171-docs-browser.md`), `DESIGN.binance.md`, and the prompt builders in
  `src/acp/` listed under Research.
