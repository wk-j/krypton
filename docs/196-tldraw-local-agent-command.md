# `#draw` — tldraw Offline Local-Agent Command — Implementation Spec

> Status: Implemented (amended in part)
> Date: 2026-07-17
> Milestone: M-ACP — Harness Multi-Agent
> Builds on: `docs/144-harness-wiki-command.md`, `docs/185-hash-command-reference-page.md`
> Amended by: `docs/197-tldraw-document-script-support.md` — prompt clauses 5–6
> (exec-only mutation and the blanket direct-file prohibition) are superseded by
> the durable document-script branch; discovery, token, and issue #11 clauses stand.

## Problem

tldraw Offline exposes a local, authenticated agent API for inspecting and editing the
document currently open in its desktop app. Krypton agents can already reach local tools
through their normal shell capability, but the user must currently explain discovery,
authentication, canvas inspection, mutation, and verification on every turn. That makes a
simple request such as “draw this architecture” verbose and easy to execute unsafely.

Writing a `.tldraw` file directly is not a sound shortcut. tldraw Offline's native file is
an app-owned SQLite-based archive with assets and metadata, and its documentation warns
that an open document does not merge external changes. A direct writer would duplicate a
private persistence contract and could corrupt or silently race the document the user is
viewing.

## Solution

Add a built-in ACP-harness command:

```text
#draw <drawing request>
```

Like `#wiki` and `#directive`, `#draw` injects one purpose-built system prompt into the
active lane. The prompt tells the agent to discover the running tldraw Offline instance,
read the instance's version-matched `/readme`, find the focused open document, inspect its
current shapes, edit it through the authenticated `/api/doc/:id/exec` endpoint, and verify
the result through records plus a screenshot.

The command adds no always-on MCP tool, Rust proxy, Tauri IPC command, persistent token,
lane state, or file-format implementation. The agent uses its existing shell tool under
the existing permission policy. tldraw Offline remains the sole owner of the document,
local server, bearer token, save action, and native `.tldraw` representation.

Version 1 intentionally edits the **focused document already open in tldraw Offline**. It
does not promise headless document creation or save-as because those operations are not
part of the currently exposed local-agent API.

## Research

- **The installed app is a live, local editor surface.** tldraw Offline 1.10.0 starts a
  loopback HTTP server (default port `7236`) and writes connection metadata containing the
  actual port and a per-launch bearer token to a platform-specific `server.json`.
- **Runtime documentation is the compatibility contract.** `GET /readme` is available
  without authentication and describes the endpoints supported by the running build. The
  prompt therefore requires the agent to read it before acting rather than relying only on
  API details baked into Krypton.
- **The API is document-scoped.** `POST /api/search` can discover the focused document and
  inspect shapes/bindings; `POST /api/doc/:id/exec` evaluates JavaScript against that
  document's live tldraw `Editor`. The editor supports normal operations such as
  `editor.createShapes([...])` and tldraw module imports.
- **Mutation was verified against the installed app.** A focused untitled document was
  discovered, its records were read, then a card and a connected 15-shape architecture
  diagram were created through `/exec` and checked visually. The integration is therefore
  based on a working local path rather than an assumed API.
- **The API does not currently expose a reliable create/save-as workflow.** The inspected
  search API exposes open-document discovery and live editing, but not a public
  `createDoc` or `saveAs`. The user must open a document and save it in tldraw Offline.
- **An optional tldraw helper may exist.** tldraw Offline can install a `tq` helper and an
  agent skill. `#draw` may use them when present, but the command must also work by reading
  `server.json` and `/readme` directly so it has no undeclared installation dependency.

## Prior Art

| System | Implementation | Lesson for Krypton |
|--------|----------------|--------------------|
| tldraw Offline | Desktop app owns local files and exposes a bearer-protected loopback agent API for open canvases | Use the live editor API; never become a second file writer |
| tldraw Agent template | An agent produces structured actions that mutate a tldraw editor and can inspect the result | Inspect → mutate → verify is the right workflow boundary |
| Obsidian Excalidraw | Automation scripts run inside the host app through ExcalidrawAutomate / command-palette workflows | Keep document semantics in the owning editor process |
| Mermaid CLI | Headless text input renders SVG/PNG/PDF | Useful for exported static diagrams, but not an editable live whiteboard |
| Krypton `#wiki` / `#directive` | Rare workflows are one-shot prompt commands using the lane's existing tools | Avoid permanent tool-schema cost and a parallel permission system |

**Krypton delta** — `#draw` is not a drawing engine. It is a safe, discoverable workflow
that teaches the active agent how to control the user's already-running local editor while
keeping authentication and persistence inside tldraw Offline.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-prompts.ts` | Add exported pure `tldrawDrawPrompt(intent)` builder |
| `src/acp/hash-commands.ts` | Register `#draw` in the palette and manifest using the real prompt builder |
| `src/acp/acp-harness-view.ts` | Add the guarded `#draw` dispatch branch and help-overlay entry |
| `src/acp/hash-commands.test.ts` | Extend roster/manifest drift coverage and prompt-backed-command coverage |
| `src/acp/acp-harness-view.test.ts` | Add prompt contract, input-neutralization, validation, and dispatch tests |
| `docs/05-data-flow.md` | Register the local hash-command flow and its external-app boundary |
| `docs/72-acp-harness-view.md` | Document command behavior, failure states, and status label |
| `docs/PROGRESS.md` | Add the completed feature entry after implementation and verification |

No Rust, Tauri IPC, CSS, configuration schema, MCP descriptor, or lane-state change is
required.

## Design

### Command contract

```ts
export function tldrawDrawPrompt(intent: string): string;
```

```text
#draw <drawing request>
```

- Empty input shows `usage: #draw <drawing request>` and sends no turn.
- The active lane must be `idle` or `awaiting_peer`, matching other prompt-backed
  commands. A busy lane keeps the existing busy/queue behavior rather than bypassing it.
- The composer draft is cleared before validation, matching `#wiki` and `#directive`.
- Dispatch uses `enqueueSystemPrompt(lane, prompt, undefined, 'drawing in tldraw')` so the
  existing status chip reports the workflow without adding state.
- The request is embedded with `JSON.stringify(intent)` under an explicit untrusted-data
  label. Text inside the request cannot override the workflow or safety instructions.

### Prompt contract

The generated prompt contains these load-bearing requirements:

1. Operate only through the local tldraw Offline agent API; do not edit a `.tldraw` file,
   its unpacked `db.sqlite`, assets, metadata, or sidecars directly.
2. Prefer the installed tldraw Offline skill / `tq` helper when available, but do not
   require it. Otherwise locate `server.json` at the documented platform locations:
   - macOS: `~/Library/Application Support/tldraw/server.json`
   - Linux: `~/.config/tldraw/server.json`
   - Windows: `%APPDATA%\\tldraw\\server.json`
3. If `server.json` exists but a loopback request fails, do not conclude the app is down
   from that failure alone — a sandboxed execution environment may be blocking localhost
   (issue #11). Check for a live listener on the discovered port first (e.g.
   `lsof -nP -iTCP:<port> -sTCP:LISTEN`); if one exists, retry through an execution path
   allowed to reach the local network, requesting that permission through the normal
   approval flow if needed, and report the real outcome. Report the app as not running
   only when no listener is present.
4. Read `GET /readme` from the discovered port before invoking authenticated endpoints.
   Treat those runtime instructions as authoritative for the installed version.
5. Read the token only for the current request. Never echo it into the transcript, write
   it to the repo, copy it into generated scripts, or persist it after the operation.
6. Discover the focused document through the search API. If the app, server metadata,
   focused document, or required endpoint is unavailable, stop and tell the user exactly
   what to open; never claim the drawing was made.
7. Inspect existing shapes and bindings before mutation. Preserve user content and place
   new work in a clear region unless the request explicitly asks to modify existing
   objects.
8. Use the focused document's authenticated `/api/doc/:id/exec` endpoint and the normal
   tldraw `Editor` API. Batch related records into as few editor operations as practical,
   using valid shape IDs and bindings.
9. When revising work created earlier in the same turn, reuse stable IDs or inspect before
   creating replacements so retries do not spray duplicate shapes.
10. Fit or zoom the viewport to a useful final view, verify the resulting shape records,
   and request a screenshot. If screenshot capture is unavailable, state that limitation
   and perform explicit record-level verification instead.
11. Report the focused document name, what changed, and the verification result. Remind
    the user that tldraw Offline owns saving and that they should save the document.

The prompt describes capabilities and invariants, not a fixed shell script. This keeps the
command portable across agent backends and lets it follow `/readme` when tldraw Offline
changes its request/response details.

### Manifest and command reference

`HASH_COMMANDS` gains:

```ts
{
  name: 'draw',
  args: '<request>',
  description: 'draw in the focused tldraw Offline canvas',
}
```

`commandMeta()` gains the same name with:

- category: `agent`
- badges: `workflow`
- lanes: `same lane`
- anatomy: `discover canvas → inspect shapes → batch edit via /exec → verify screenshot`
- prompt: `tldrawDrawPrompt('<drawing request>')`

Because `/commands` is manifest-driven, this automatically exposes the exact injected
prompt in the existing command-reference page. The name-equality and prompt-backed tests
remain the drift guard.

### Data flow

```text
1. User opens a document in tldraw Offline and types #draw <request> in Krypton.
2. runHashCommand validates the request and injects tldrawDrawPrompt into the active lane.
3. The agent's normal tool permission flow governs local shell/API access.
4. Agent discovers server.json, reads /readme, and finds the focused document.
5. Agent inspects existing records, then batches mutations through /api/doc/:id/exec.
6. Agent verifies records + screenshot and reports the result with a save reminder.
7. tldraw Offline remains open and owns persistence; Krypton stores no credential or
   document state.
```

### Security and permission boundary

- `#draw` does not auto-approve shell commands, change a lane's permission mode, or add a
  bypass rule. Any permission request follows the normal ACP lane flow.
- Krypton never receives, logs, caches, or proxies the tldraw token. Only the executing
  agent process reads `server.json` under the user's existing tool permissions.
- The server is addressed through loopback as documented by the running app. The prompt
  does not send canvas content or credentials to another network service.
- User-provided drawing text and content read from the canvas are treated as data. Neither
  may override system instructions or request unrelated filesystem/network actions.
- Direct native-file writes are prohibited even when the API is unavailable. Failure is
  visible and recoverable: launch tldraw Offline, open/focus a document, then retry.

### Verification

Implementation is complete when:

- `#draw` appears in the hash palette, help overlay, and `/commands` manifest.
- Empty, busy, and unavailable-app paths produce honest user-visible outcomes.
- Prompt tests pin runtime `/readme` discovery, focused-document use, token secrecy,
  direct-file prohibition, inspect-before-edit, batch mutation, verification, and save
  reminder clauses.
- Injection-laden multiline drawing text remains JSON-stringified data.
- Dispatcher tests prove exactly one labeled system turn is enqueued for valid input and
  none for invalid input.
- `npm run check` and the focused Vitest suites pass; then run the full `npm test` suite.
- A manual smoke test against tldraw Offline creates a small connected diagram in the
  focused document and verifies it via screenshot without exposing the token.

Verification completed 2026-07-17: focused prompt/manifest/dispatcher suites passed
(176 tests), `npm run check` passed, and the full frontend suite passed (491 tests). The
live local-API mutation path was smoke-tested during design research against tldraw
Offline 1.10.0 with record and visual verification.

## Edge Cases

- **tldraw Offline is not running** — stop with a launch instruction; never fall back to
  native file generation.
- **Loopback blocked by a sandbox (issue #11)** — `server.json` exists and `lsof` shows a
  live listener, but the first request fails from a network-restricted execution
  environment. The agent must not report the app as down from that single failure; it
  checks the listener, retries through a permitted execution path (normal approval flow),
  and reports the real outcome.
- **`server.json` is stale or the app restarted** — rediscover metadata and retry once
  with the current token; do not persist the old token.
- **No focused/open document** — ask the user to open and focus a document, then retry.
- **Multiple documents are open** — use `getFocusedDoc`; include its title in the final
  report so the target is auditable.
- **Existing canvas is crowded** — inspect bounds and place the new group in a clear
  region; do not cover existing work.
- **Partial editor failure** — re-read the affected records before retrying. Never blindly
  replay the entire create batch when some records may already exist.
- **Screenshot endpoint unavailable** — verify shape IDs/types/bounds/bindings and disclose
  that visual verification could not be completed.
- **Agent backend lacks a usable shell tool or permission is rejected** — report the
  limitation without mutation or fabricated success.
- **User asks for a new saved file** — explain the v1 boundary: they must create/open the
  destination in tldraw Offline; `#draw` then fills the focused document.

## Open Questions

None. The command name, focused-document scope, one-shot-prompt architecture, credential
boundary, verification contract, and no-direct-file rule are decided above.

## Out of Scope

- A Krypton-native drawing canvas or tldraw renderer.
- Creating, opening, saving, renaming, or exporting documents headlessly.
- Parsing, generating, patching, or migrating native `.tldraw` files.
- A permanent tldraw MCP server, always-on tool schema, Tauri proxy, or token vault.
- Live bidirectional canvas events, collaborative cursors, or automatic synchronization.
- Bundling or installing tldraw Offline, `tq`, or its optional agent skill.
- Selecting an arbitrary background document; v1 targets the focused open document only.

## Resources

- [tldraw Offline](https://github.com/tldraw/tldraw-offline)
- [tldraw SDK](https://github.com/tldraw/tldraw)
- [tldraw Agent template](https://github.com/tldraw/agent-template)
- [Obsidian Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin)
- [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli)
- `docs/144-harness-wiki-command.md`
- `docs/185-hash-command-reference-page.md`
