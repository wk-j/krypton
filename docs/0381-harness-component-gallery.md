# Harness Component Gallery (Loopback Page) — Implementation Spec

> Status: Approved (2026-11-10) — phase 1 implemented (2026-11-11); phases 2 and 3 open
> Date: 2026-11-10
> Milestone: ACP Harness — one rendering for every lane
> Builds on: [380](./0380-acp-lane-adapters.md) (lane adapters), [313](./0313-genui-component-gallery.md) (GenUI gallery), [341](./0341-loopback-app.md)/[361](./0361-loopback-app-react.md) (loopback app), [301](./0301-harness-ui-components.md)/[302](./0302-harness-component-catalog.md) (components), [379](./0379-connected-transcript-sources.md) (connected sources)

## Problem

Spec 380 sends every lane's output through one canonical model, but nothing shows what that model finally looks like. The components that paint agent output exist only inside a running lane, one state at a time. A state such as `exit 1`, "no exit reported" or a failed read can drift or look wrong, and nobody sees it until a lane happens to hit it. The user wants every final generic component the harness shows for agent output organized in one gallery on the loopback app, so the final UI can be reviewed and controlled in one place.

## Solution

Add a loopback surface, **Harness components** (`/harness-gallery`), built on the GenUI gallery's shell, keys and theme path:
- **Layout:** an index rail, and one entry at a time with a separate Krypton-window preview per state, painted with the app's live theme. Each state title sits above and outside its preview.
- **Organization:** entries follow the canonical data that feeds them (spec 380 `LaneEvent` / `LaneSession`). Each entry stacks all its named states.
- **Previews:** every preview is the production component fed by the production item builder, so the gallery shows exactly what a lane shows.
- **Backends view:** shows one scenario decoded from each backend's captured wire fixture through its adapter, side by side, so any difference between lanes is visible on one screen.
- **Coverage test:** fails the build when an adapter-fed row kind, tool kind or painted field has no example.

## Research

- **The GenUI gallery** (`src/loopback/surfaces/genui/`, spec 313) already solves the hard parts:
  - The production renderer is mounted in a kit `Island`, so React never owns component DOM (spec 361).
  - `theme.json` is applied to `:root` through `themeCssProperties()` plus the font properties, and re-applied on window focus (rev 3).
  - The `.krypton-window` stage sits over an opaque desktop stand-in and carries the `--agent-*` aliases and a scoped `krypton.reset`. Without the reset, border-box markup overflowed by up to 20px (rev 4).
  - The krypton-dark fallback must be scoped to `html[data-surface=…]`, because release builds merge every surface sheet into one `app.css`.
  - `examples.test.ts` fails when a catalog component has no example.
- **Rows mount standalone.** `createTranscriptRow(props)` (`transcript/rows.ts:65`) takes `RowProps {item, isNew, streaming, lane, projectDir, resolveLocalImages}`, and `lane: null` is allowed. Rows must be direct siblings in `.acp-harness__lane-body` for the spec 379 connector to draw.
- **Harness sheets are safe in the merged bundle.** They are BEM-scoped (`.acp-harness*`) inside `krypton.*` layers. `harness-shared.css` has 1,685 lines, and component sheets arrive with their component imports. Merged into the loopback `app.css`, they match nothing outside the stage. `materials.css` is already bundled through GenUI.
- **Lane chrome needs a whole lane.** `LaneHead` and `LaneStats` take a `HarnessLane`, and lane builders exist only as private copies in five test files. `PlanPanel` takes only `{entries, collapsed}`.
- **Item payloads must come from shared builders.** Before spec 380 they were built inside `AcpHarnessView` (`renderTool`, `describePermission`). A gallery that built them itself would show its own idea of a row. Spec 380 moved the tool and permission builders into pure functions in `harness-transcript-items.ts` (`toolPayloadFromView`, `permissionPayloadFromRequest`). Question rows already came from the pure `createAskUserCardState` / `payloadFromCard` in `ask-user-question.ts`. The gallery reuses all of them.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed | `crates/component_preview`, opened by the `OpenComponentPreview` action. Each component implements `Component` with a `scope()` (`Agent`, `Status`, …), a `name()`, a `description()`, and a `preview()` that returns named example groups. For example, `TerminalToolHeader` shows "Running" and "Finished (long-running)" in `agent_ui/src/ui/terminal_tool_header.rs`. | Named states per component, grouped by area, rendered by the real component. |
| Krypton GenUI gallery (313) | Rail, one live example, a source toggle and the app theme, on the loopback app. | Same shell, keys, theme route and stage exception. |

**Krypton delta:** like Zed, previews are the real components with named states. Unlike Zed, entries are grouped by the canonical data that feeds them, because the question is "what does a failed command look like in every lane", not "what props does `ToolRow` take". The Backends view has no equivalent in either app: it exists because Krypton renders many vendors.

## Affected Files

| File | Change |
|------|--------|
| `src/loopback/entries/harness.ts` (new) | `bootPage('harness', HarnessGalleryPage)` |
| `src/loopback/surfaces/harness/index.tsx` (new) | Rail, search, stage, Canonical/Backends views, Source toggle, keys |
| `src/loopback/surfaces/harness/stage.ts` (new) | Framework-free host: mounts rows/chrome into an `Island`, disposes them on switch |
| `src/loopback/surfaces/harness/examples/{messages,tools,requests,files,turn,session}.ts` (new) | Entries and their states |
| `src/loopback/surfaces/harness/backends.ts` (new) | Loads spec 380 fixtures, decodes per backend, projects the scenario |
| `src/loopback/surfaces/harness/harness.css` (new) | `lb-harness__*`, stage exception, scoped reset, fallback scoped to `html[data-surface='harness']` |
| `src/loopback/surfaces/harness/{harness.test.tsx,examples.test.ts}` (new) | Page keys and views; coverage guard |
| `src/loopback/surfaces.ts` | `harness` surface in the `reference` group |
| `src/loopback/surfaces/genui/theme.ts` → `src/loopback/kit/lib/krypton-theme.ts` | `applyKryptonTheme(url)`, shared by both galleries |
| `src/acp/harness-lane-fixture.ts` (new) | `laneFixture(overrides)`, which replaces the five test-local lane builders |
| `src-tauri/src/hook_server.rs` | `GET /harness-gallery`; `/harness-gallery/theme.json` on the existing theme handler; CSP constants renamed `COMPONENT_GALLERY_CSP{,_DEV}`; route tests |
| `docs/0302-harness-component-catalog.md`, `docs/0341-loopback-app.md`, `docs/0380-acp-lane-adapters.md`, `docs/README.md` | Link the gallery; list the surface |

## Design

### Data Structures

```ts
// src/loopback/surfaces/harness/examples/types.ts
export type GalleryGroup = 'messages' | 'tools' | 'requests' | 'files' | 'turn' | 'session';

/** Canonical data for one preview. Rows always go through the production builders. */
export type GalleryInput =
  | { readonly kind: 'item'; readonly item: HarnessTranscriptItem }   // plain-data rows
  | { readonly kind: 'tool'; readonly view: ToolView; readonly elapsedMs: number | null }
  | { readonly kind: 'permission'; readonly event: Extract<LaneEvent, { type: 'permission_request' }> }
  | { readonly kind: 'question'; readonly event: Extract<LaneEvent, { type: 'ask_user_question' | 'elicitation_request' }> }
  | { readonly kind: 'plan'; readonly entries: readonly PlanEntry[] }
  | { readonly kind: 'lane'; readonly session: LaneSession; readonly usage: UsageInfo | null };

export interface GalleryState {
  readonly label: string;                  // "exit 1", "no exit reported", "run of three"
  readonly inputs: readonly GalleryInput[]; // >1 renders as consecutive rows (spec 379 run)
  readonly streaming?: boolean;            // paints the live legend; default sealed
}

export interface GalleryEntry {
  readonly id: string;                      // hash fragment: #tool-execute
  readonly title: string;                   // "Command"
  readonly group: GalleryGroup;
  readonly components: readonly string[];   // registry ids exercised: ['tool-row', 'diff-block']
  readonly states: readonly GalleryState[];
  readonly scenario: string | null;         // spec 380 fixture scenario for the Backends view
}
```

`item` inputs are used only for rows whose item is plain data: assistant, thought, user, fs activity, fs write review, provider error, usage and system notices. Tool, permission and question previews always come from the functions `AcpHarnessView` calls: `toolPayloadFromView` and `permissionPayloadFromRequest` (`harness-transcript-items.ts`), and `payloadFromCard(requestId, questions, createAskUserCardState(questions), wire)` (`ask-user-question.ts`).

### Entries

| Group | Entries (states) |
|-------|------------------|
| Messages | Agent message (prose, code fence, table, svg/mermaid fence, image, streaming); Thought (short, clamped, effort meter, streaming); User prompt (text, image) |
| Tools | Command (running, exit 0, exit 1, no exit reported, long output trimmed, git status, git diff, background task, run of three); Read, Edit (diff, new file), Delete, Move, Search (grep hits), Fetch, Think, Other (each: running, completed, failed); Agents (subagent card: running, mixed, done); Wait (job list); Code cell (execution card); Guardian review; Tool images |
| Requests | Permission (command, edit, MCP tool, resolved); Question (single, multi-select); Form elicitation |
| Files | File activity (read, write, failed); Write review (pending, accepted, rejected) |
| Turn | Usage; Stop and cancel notices; Error; Provider error (rate limit, auth, overloaded) |
| Session | Lane head (model and mode chips, busy, error); Lane stats (usage meter); Plan panel (mixed, collapsed) |

Only components that paint agent-originated data are in scope. Components that render Krypton's own UI look the same in every lane already and are excluded: composer, pickers, overlays, inter-lane mail, artifact/review cards and directive diffs.

### Stage

`stage.ts` mounts each state into its own block. A block is a caption in loopback gallery typography, then a `.lb-harness__stage` preview wrapping a `.acp-harness` root holding one `.acp-harness__lane-body` whose direct children are the state's rows. The caption and optional source JSON are siblings outside the preview bezel, never part of its themed contents. Every row is built with `createTranscriptRow({ item, isNew: false, streaming, lane: null, projectDir: null, resolveLocalImages: false })`. Lane chrome uses `LaneHead` / `LaneStats` over `laneFixture()`, and `PlanPanel` uses `{entries, collapsed}`. Switching entry disposes every component through `dispose()`. Each preview is `.krypton-window` by value over the desktop stand-in, with the GenUI rev 4 reset scoped to `.lb-harness__stage`.

The stage-scoped margin/padding reset lives in `lb.reset`, below both the gallery's `lb.surface` spacing and every production `krypton.*` rule, so it cannot override the preview inset. State titles, separation and source margins use loopback styles outside that reset.

### Backends view

For an entry with a `scenario`, `backends.ts` loads `src/acp/adapters/fixtures/*/<scenario>.jsonl` (bundled with `import.meta.glob(…, { query: '?raw' })`). It decodes each fixture with `createLaneDecoder(backend)` and projects the result: the last `ToolView` per tool id, permission and question events, and the assistant and thought text joined per message. These go through the same builders into one column per backend. Each column header names the backend and lists its spec 380 supply-matrix `'no'` fields in plain text ("exit code: not reported"). Backends without a fixture are named in one line under the grid. Streaming and sealing are not simulated: columns show the final state.

### Data Flow

```
1. GET /harness-gallery → app_page_response(AppPage::new("harness", "Harness components", Scheme::Dark).with_csp(..)).
2. entries/harness.ts boots HarnessGalleryPage; applyKryptonTheme('/harness-gallery/theme.json')
   paints :root before the first mount.
3. The rail lists ENTRIES by group; location.hash names the open entry.
4. The Canonical view: stage.ts builds each state's items through the production builders and mounts rows.
5. b: backends.ts decodes fixtures through the adapters → same builders → one column per backend.
6. s: under each state, a <pre> shows the canonical input (ToolView / event / item) as JSON.
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `/` | Page | Focus search |
| `[` / `]` | Page | Previous / next entry |
| `↑` / `↓` | Rail, or `↓` from search | Move selection |
| `Enter` | Rail item | Open entry |
| `Esc` | Page, outside an input | Clear a non-empty search |
| `b` | Page, entry has a scenario | Toggle Canonical ↔ Backends |
| `s` | Page | Toggle canonical-input source under each state |

All keys go through the page `useKeymap`, so `?` lists them.

### Coverage guard (`examples.test.ts`)

The test fails when any of these has no example:
- a `rowKindFor` kind that adapter output can produce (every kind except `interLane`, `docCard` and `directiveDiff`);
- a `ToolView.kind`, or one of the payloads `subagents`, `jobs`, `execution`, `guardianReview`;
- one of the five `status` values;
- an `exit` that is `null`, `0` or non-zero;
- a non-empty `diffs`, a tool event whose `images` carries a block, or a non-null `background`;
- a spec 380 fixture scenario, which some entry's `scenario` must reference.

Every id in `components` must exist in `HARNESS_COMPONENTS`. `harness.test.tsx` covers keys, hash routing and both views, and renders every entry once with `invoke` stubbed to throw, which proves the gallery never reaches Tauri.

### Phases

1. Page, stage, theme, and the Messages, Tools, Requests, Files and Turn entries. Lands after spec 380 phase 2, which ships `ToolView` and the shared item builders.
2. Session entries, after `laneFixture()` replaces the five test-local lane builders.
3. The Backends view. Lands after spec 380 phase 4, which ships the fixtures and the supply matrix.

### Phase 1 — Implemented (2026-11-11)

- **Page:** `GET /harness-gallery` → `AppPage::new("harness", "Harness components", Scheme::Dark)`. The surface is in the `reference` group. `/harness-gallery/theme.json` is served by the GenUI theme handler, renamed `handle_component_gallery_theme`. The CSP is `COMPONENT_GALLERY_CSP{,_DEV}` through `component_gallery_csp()`. A route test checks both galleries' entry and CSP.
- **Theme:** `src/loopback/kit/lib/krypton-theme.ts` `applyKryptonTheme(url)`, shared with GenUI. It is imported directly, not through the kit barrel: it reaches `src/theme.ts`, which no other page needs.
- **Shared builders:** `harness-transcript-items.ts` gains `toolItemText` and `permissionItemText`. They are the rows' text lines, moved out of `renderTool` and the permission path, and the view calls them too. `build.ts` turns each input into an item through these builders, `toolPayloadFromView`, `permissionPayloadFromRequest`, `payloadFromCard` / `createAskUserCardState` and `parseElicitationForm`.
- **Images:** decoded by the production `imageBytesSource` / `createBytesImage`. The Blob URL is then swapped for a `data:` URL, because the CSP allows only `data:` images.
- **Stage:** `stage.ts` mounts each state as a caption outside its own `.lb-harness__stage` preview, followed by optional source JSON outside the preview. Inside each preview, a `.acp-harness` root and its `.acp-harness__lane-body` hold the rows as direct siblings. `harness.css` resets the preview inside `lb.reset`, below gallery spacing and production component rules. In `krypton.base`, with higher specificity, it lets the root and lane body grow to their rows instead of filling a lane box. It also copies the `kbd` key-cap rule (spec 369), scoped to the stage, because `src/styles/kbd.css` styles bare `kbd` and would restyle every loopback page in the merged `app.css`.
- **Entries:** 26 entries with 83 states in five groups.
  - Beyond the Entries table: Command `pending` and `canceled`, because the coverage guard needs all five statuses. Also Edit, Search and the other file kinds `running`/`failed`, Permission `high-risk command`, Question `answered`, and Usage `recording off`, which is the notice row.
  - Assistant and user images are image strips (`imageBlocks`).
- **Coverage guard:**
  - `examples.test.ts` checks row kinds against the newly exported `ROW_KINDS`.
  - A "tool kind" is the ACP `ToolKind` plus `agents` and `wait`. A type-level check fails the build when `ToolKind` or `ToolState` gains a member that has no example.
  - The fixture-scenario check reads `src/acp/adapters/fixtures/` and passes trivially until spec 380 phase 4b adds fixtures.
- **Page test:** `harness.test.tsx` mocks `invoke` to throw and asserts it was never called after rendering every entry. It also covers the keys (`/`, `[`/`]`, ↑/↓, Enter, Esc, `s`), hash routing and the source toggle.
- **Deviations from the design:**
  - `GalleryGroup` has no `session`, and `GalleryInput` has no `plan` or `lane` member. Both land with phase 2.
  - `GalleryEntry` gains `summary`.
  - Permission and question inputs carry an optional `resolved`, the decision the view records on the row.
  - Tool inputs carry `images` (`ToolImageUpdate`).
  - `b` is not bound until phase 3.
- **Verified:** `npm run check`, `npm run build`, the full `npx vitest run`, `cargo fmt -- --check`, `cargo clippy`, `cargo test` and `git diff --check`. The page has not yet been opened in a browser against a running Krypton (it needs `npx tauri dev`, or `make install` and a relaunch).

### Configuration

None.

## Edge Cases

- **Theme fetch fails:** the krypton-dark fallback, scoped to `html[data-surface='harness']`, applies and the rail says so (as in GenUI).
- **Images:** examples use `data:` URLs only, which the CSP's `img-src 'self' data:` allows.
- **Running states:** the spinner is the shared frame counter. No new `infinite` animation is added (CLAUDE.md constraint 10).
- **Fixture for an unknown backend:** decoded by the generic adapter and labelled with its directory name.
- **Adapters in the browser:** `src/acp/adapters/**`, `harness-transcript-items.ts` and `ask-user-question.ts` reach nothing from `@tauri-apps`, directly or through any import. The spec 380 guard test enforces this, so the Backends view decodes in the page.
- **Fixture size:** spec 380's contract test caps each fixture at 64 KB, so the gallery chunk stays small. The chunk loads only on this surface.
- **A row reaching for lane data** (thumbnails, Git refs): with `lane: null` and `projectDir: null` it paints without them, as a cold row would. The `invoke` stub test catches any regression.

## Open Questions

None. Scope is the components that paint agent-originated data. The Krypton-only components listed under Entries look the same in every lane already.

## Out of Scope

- Krypton-originated components (composer, pickers, overlays, inter-lane mail, artifact/review cards, directive diffs).
- Acting on a preview (approving a permission, answering a question), editing examples in the browser, and a scheme toggle separate from the app theme.
- Screenshot diffing or visual regression tests.
- Simulating streaming, sealing or the tail window in the Backends view.

## Resources

- Zed source, `/Users/wk/Source/zed` @ `93d7456688`: `crates/component/src/component.rs` (`Component`, `ComponentScope`), `crates/component_preview/`, `crates/agent_ui/src/ui/terminal_tool_header.rs` (named example states). This is the per-component named-state model.
- Krypton spec 313 and `src/loopback/surfaces/genui/`: shell, theme route, stage exception, scoped reset and the coverage-test pattern reused here.
