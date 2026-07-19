# `#draw` Document-Script Support — Implementation Spec

> Status: Implemented
> Date: 2026-07-19
> Milestone: M-ACP — Harness Multi-Agent
> Builds on: `docs/196-tldraw-local-agent-command.md`

## Problem

`#draw` (spec 196) can only produce static canvas content: its prompt orders the agent to
"mutate only through `/api/doc/:id/exec`", and runtime JavaScript installed through
`/exec` does not persist — listeners, timers, and custom shapes disappear when the
document closes. The tldraw Offline build actually running (1.10.x, verified live) also
exposes **document scripts** (`/api/doc/:id/script-workspace`, `/api/doc/:id/script-status`):
durable `script/main.js` + `script/config.js` files embedded in the document that survive
reload and enable interactive documents such as `nn-digits.tldraw` — a live MNIST digit
recognizer built from a custom `agent-shape` type registered in `config.js`, wired with
arrows as dataflow. A `#draw` request like "make the button move the box" or "build an
interactive demo" is impossible under the current prompt even though the API supports it.

## Solution

Extend `tldrawDrawPrompt` with a second, explicitly-gated workflow branch: static drawing
keeps the existing `/exec` path unchanged; requests needing durable or interactive
behavior use the script-workspace loop (`script-workspace` → read matching `api.recipes`
→ edit files under `scriptDir` with normal file tools → wait for `script-status`
`state: "applied"` → verify once). The direct-file prohibition is narrowed from "never
touch any document file" to "never touch the packed `.tldraw` archive or `appOwned`
files" — the `editable` paths returned by `script-workspace` are the sanctioned
exception, by the app's own contract. No new tool, Rust, IPC, state, or CSS.

## Research

- **Verified against the running app.** `GET /readme` on the live instance documents
  `script-workspace`/`script-status`, the `state` field (`applied`/`pending`/`error`),
  `isDefaultScript`, the `editable` vs `appOwned` path lists, `api.recipes` (worked
  recipes for durable scripts, clickable UI, animation loops, custom shapes/overlays via
  `config.js`), `api.imports`, and `getDocs().hasScript`. Spec 196's prompt predates
  these runtime docs and now contradicts them — the very drift its "treat `/readme` as
  authoritative" clause was meant to absorb, except the categorical clauses 5–6 override it.
- **`nn-digits.tldraw` inspected live** (user opened it): `hasScript: true`,
  `manifest.author: "agent"`, 24 shapes / 2 pages. `config.js` (474 lines) registers an
  `AgentShapeUtil` — HTML/CSS-in-props nodes whose `<script>` runs against a synchronous
  `agent` API with arrow-label dataflow; `main.js` adds a presentation tweak. Page
  "MNIST digits 196-32-10" wires `draw-pad → nn-layer → nn-output` plus `nn-trainer`
  (weights) and `test-strip` (accuracy). This is exactly the workflow class the prompt
  must unlock, and proof an agent authored one through this API.
- **Persistence model** (from `/readme`): `/exec` JS is ephemeral; durable behavior
  belongs in document scripts. The watcher — not the agent — embeds the script bundle
  into the document, marks it unsaved, and reruns it; tldraw Offline still owns
  persistence and the save action. Editing `config.js` rebuilds the editor (undo history
  reset); editing `main.js` reruns without remount.
- **Prompt-size constraint.** `api.recipes` already contains the worked how-to for every
  durable pattern. The prompt should gate and point (recipes-first rule), not embed
  recipe content — same philosophy as spec 196's readme-first rule.
- **Doc targeting.** `api.getDocs({ name })` supports case-insensitive filename filtering,
  so a request that names a document can target it explicitly instead of relying on
  focus order.

## Prior Art

| System | Implementation | Lesson |
|--------|----------------|--------|
| tldraw Offline document scripts | App-owned watcher applies agent-edited `script/**` files, embeds them into the archive, reruns live | The sanctioned direct-edit surface is declared by the app (`editable`), not assumed |
| tldraw Offline `api.recipes` | Runtime-queryable worked recipes per durable pattern | Prompt points at recipes instead of embedding SDK detail that will drift |
| Obsidian Excalidraw scripts | Automation scripts live inside the vault and run in the host app | Keep script semantics in the owning editor process |
| VS Code extensions | Durable behavior = installed artifact watched/reloaded by host, not runtime eval | Same ephemeral-vs-durable split as `/exec` vs document script |
| Krypton `#draw` v1 (spec 196) | One-shot prompt, readme-first, token secrecy, no direct file writes | All boundaries carry over; only the mutation-surface clauses change |

**Krypton delta** — `#draw` stays a workflow prompt, not a drawing engine. v2 widens the
sanctioned mutation surface to exactly what the running app's own contract declares
editable, and nothing more.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-prompts.ts` | Rework `tldrawDrawPrompt` clauses 5–7 (see Design) |
| `src/acp/hash-commands.ts` | Update `draw` `anatomy` string for the two-branch flow |
| `src/acp/acp-harness-view.test.ts` | Re-pin changed clauses; add script-workspace clause pins |
| `src/acp/hash-commands.test.ts` | No structural change expected (name/prompt drift guards already cover `draw`) |
| `docs/196-tldraw-local-agent-command.md` | Add superseded-in-part banner pointing here |
| `docs/72-acp-harness-view.md` | Update `#draw` command description |
| `docs/05-data-flow.md` | Extend the `#draw` flow note with the durable branch |
| `docs/PROGRESS.md` | Feature entry after implementation |

No Rust, Tauri IPC, CSS, config schema, MCP descriptor, or lane-state change.

## Design

### Prompt contract changes (`tldrawDrawPrompt`)

Unchanged clauses: discovery via skill/`tq`/`server.json` (1), sandbox-blocked loopback
diagnosis for issue #11 (2), readme-first + token secrecy (3), focused-document discovery
+ inspect-before-edit (4), verification + screenshot (7→renumbered), honest final report
+ save reminder (8→renumbered), JSON.stringify data boundary.

Changed/added clauses:

1. **Clause 4 (targeting), amended** — if the drawing request names a document or file,
   locate it with the documented docs-listing filter (e.g. `api.getDocs({ name })`)
   instead of assuming the focused document; name the chosen target in the final report.
   The filter is a case-insensitive substring match that may return several documents:
   mutation requires exactly one remaining match (exact file name preferred); on multiple
   matches the agent stops and asks which document to target. If the named document is
   not open, stop and ask the user to open it.
2. **Clause 5 (mutation surface), replaced** — two explicit branches:
   - *Static content* (shapes, diagrams, layout, text): keep v1 verbatim — batch through
     `/api/doc/:id/exec` with stable IDs, re-read before retry.
   - *Durable/interactive behavior* (anything that must survive reload: clickable UI,
     animation/simulation loops, run-on-open logic, reactive layout, custom shape types
     or overlays): do NOT build it with `/exec` (that runtime JS is ephemeral). Open
     `POST /api/doc/:id/script-workspace`; read the matching `api.recipes` entry BEFORE
     writing any script; honor `isDefaultScript` — when `false` a user/agent script
     already exists: read it and extend, never overwrite or regenerate it; edit only
     files under the returned `scriptDir`/`assetsDir` (`editable` list) with normal file
     tools; put editor-construction concerns (custom `ShapeUtil`, overlays, tools,
     components) in `script/config.js` and run-on-mount logic in `main.js`. The branches
     are not exclusive: a mixed request uses `/exec` for persistent canvas records and
     the document script for behavior.
3. **Clause 5b (apply verification), new** — after editing `script/**`, poll
   `script-status` and branch on the derived `state`: `applied` = success; `pending` =
   retry once; `error` = read `lastApplyError`/`errorLogPath` and fix; `not-watching` /
   `no-entry` = re-open `script-workspace` and re-check, reporting honestly if it
   persists — never report success while `state` is not `applied`. For behavior visible
   outside the canvas, verify with a `mode: 'window'` screenshot.
4. **Clause 6 (file prohibition), narrowed** — never write, unpack, patch, or replace the
   packed `.tldraw` archive or any path on the returned `appOwned` list (`db.sqlite` and
   its `-wal`/`-shm` siblings, `metadata.json`, `.lock`, `jsconfig.json`,
   `.script-workspace/`); the returned `editable`/`appOwned` lists are authoritative over
   the prompt's example set, and the `editable` paths are the only sanctioned direct file
   edits. tldraw Offline alone owns persistence and save.

### Manifest

`commandMeta().draw.anatomy` becomes:
`discover canvas → inspect shapes → static: batch /exec · durable: script-workspace + recipes → verify applied + screenshot`

`HASH_COMMANDS` description becomes `draw in an open tldraw Offline canvas (focused or
named)`, and the help-overlay row mirrors it (short-form palette rows; the reference page
shows the full prompt).

### Data flow (durable branch)

```
1. User: #draw make an interactive counter button (document open in tldraw Offline)
2. runHashCommand injects tldrawDrawPrompt (unchanged dispatch, label 'drawing in tldraw')
3. Agent discovers server.json, reads /readme, picks target doc (focused or named)
4. Agent opens script-workspace, reads api.recipes['clickable-card-or-button-ui']
5. Agent reads existing script (isDefaultScript false ⇒ extend), edits scriptDir files
6. Watcher embeds bundle, marks doc unsaved, reruns script; agent polls script-status
   until state:"applied", then verifies once (records / window screenshot)
7. Agent reports target doc, changes, verification, save reminder
```

### Tests

- Update the three v1 pins that change wording (mutation clause, file-prohibition clause,
  anatomy string if pinned).
- New pins: ephemeral-`/exec` warning, `script-workspace` + recipes-first,
  `isDefaultScript` extend-not-overwrite, `state: "applied"` gate, `appOwned`/`editable`
  boundary, named-document targeting.
- Dispatch tests unchanged (no dispatcher change).

### Review

Reviewed post-implementation by peer lane Codex-1 (lens: architecture & correctness) —
1 blocker, 3 warnings, 3 suggestions, all folded: unique-match gating for the substring
name filter (the blocker — first-recency selection could edit the wrong document), the
two missing `script-status` states, the returned-`appOwned`-list-as-authoritative rule,
the focused-only opening line, the mixed-surface note, palette/help-text wording, and
pins for each. Full suite re-verified green (497 tests).

## Edge Cases

- **Request is ambiguous static-vs-durable** — the prompt's branch rule is capability-based
  ("must it survive reload / respond to interaction?"); a plain diagram never pays the
  script cost.
- **`isDefaultScript: false` with an unrelated existing script** (the nn-digits case) —
  extend; if the request conflicts with the existing script's behavior, say so in the
  report instead of silently clobbering.
- **`script-status` stuck `pending`** — retry once, then report honestly; do not loop.
- **`state: "error"`** — read `lastApplyError`/`errorLogPath`, fix, re-verify; never
  report success.
- **`config.js` edit resets undo history** — mention in the report when `config.js`
  changed (user-visible consequence).
- **Older tldraw Offline without script endpoints** — `/readme` is authoritative; if it
  documents no script-workspace, the durable branch is unavailable: report the limitation,
  offer the static part only.
- **Named document not open** — stop with an open-this-file instruction; never claim work
  happened, never touch the closed file on disk.

## Open Questions

None. Branch gating, recipes-first, extend-not-overwrite, `state`-gated success,
narrowed prohibition, and name-targeting are decided above.

## Out of Scope

- Opening/creating/saving documents headlessly (no such endpoint; v1 boundary stands).
- Embedding recipe/SDK content in the prompt (lives in `api.recipes`, queried live).
- Parsing or generating native `.tldraw` archives (unchanged prohibition).
- A Krypton-side script template library, MCP tool, proxy, or token storage.
- Editing `.script-workspace/**` tooling or `jsconfig.json` (appOwned).

## Resources

- Live `GET /readme` of tldraw Offline 1.10.x on this machine (port 7236) — script-workspace,
  script-status `state`, `api.recipes`, `api.imports`, persistence model, `appOwned` list
- Live inspection of `nn-digits.tldraw` via `/api/search` (docs list, shape survey) and its
  script workspace (`config.js` AgentShapeUtil, `main.js`) — the target workflow class
- `docs/196-tldraw-local-agent-command.md` — v1 contract this spec amends
- [tldraw SDK](https://github.com/tldraw/tldraw) — `ShapeUtil` / editor API referenced by recipes
