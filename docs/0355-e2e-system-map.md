# E2E System Map — Check Pins on a Project-Authored Map — Implementation Spec

> Status: Implemented (revised 2026-11-14: inline map on valence's layout)
> Date: 2026-11-02
> Milestone: ACP Harness — e2e
> Builds on: 0328 (Adapter Contract v1, `e2e.rs`) · 0329 (`#e2e open` explorer) · 0341 (loopback app) · 0294 (mermaid → inert `<img>`)

## Problem

The user wants a diagram that makes each e2e case easy to understand, generated deterministically with no LLM call per run.

A diagram drawn from the call order only restates the log. Today a reader sees a flat list of checks. Nothing shows which part of the system a check proves, which parts no check touches, or where a failing run broke. Example: `control-api-roundtrip` says every operation "crosses the whole running app" (`e2e/cases/control-api-roundtrip.ts:1-4`), but only 3 of its 7 checks reach the frontend. `capabilities` is answered in Rust (`control.rs:377-385`), and `events` passes on the `ready` that Rust emits by itself (`:422-423`).

## Solution

- **The map.** A project draws its system once as a small TOML map: nodes, groups and edges. A case points at it with `Case.map`.
- **Where a check sits.** Each check may carry `at`: the id of the node the check is about.
- **The drawing.** The `#e2e open` run pane draws the map with one pin per `(at, group)`, coloured by the checks' worst status. A node that no pinned check reaches is grey.
- **Comparison.** A run that is not PASS also shows, on each pin that changed, the counts of the newest earlier PASS.
- **Deterministic, no LLM per run.** The same map and Result always give the same picture. A model or a person writes the map and the `at` tags once, at authoring time.

## Research

- **Contract room.**
  - `validate_case_list` (`e2e.rs:299-394`) and `validate_result` (`:431-542`) read only the keys they know and never reject others. The JSON Schema in `CONTRACT_MD` has no `additionalProperties: false`.
  - valence decodes Case and Check into Go structs and checks known keys only (`valence/internal/krypton/contract.go:118-227`).
  - So `Case.map` and `Check.at` are optional v1 additions. Old readers ignore them.
- **Data path.** `gather()` (`e2e.rs:1546`) feeds both `#e2e status` and the page's `/status`. `E2eStatus` is flattened into the page payload (`e2e_web.rs:86-92`), so a new `maps` field reaches the page with no new route.
- **Renderer.**
  - `renderMermaid` / `buildMermaidTheme` (`src/acp/harness-mermaid-fence.ts:118-230`): `securityLevel: 'strict'`, `htmlLabels: false`, async, LRU cache of 64.
  - The loopback GenUI `Diagram` already uses it and shows the SVG only as an `<img>` data URL (`src/acp/components/genui-catalog/data.ts:51,807-812`).
  - The e2e page is fixed dark and has none of the `--krypton-*` vars that `readSvgPalette` reads. Its palette must come from the loopback tokens (`src/loopback/styles/base.css`: `--fg --muted --border --accent --add --del --card --mono`).
- **Page.** The run pane paints its case and run panes in one task after `/run` answers (0329 "No loading frame on a switch"). Checks render grouped by `group` (`surfaces/e2e/index.ts:769-803`). Used keys: `/ j k ↑ ↓ Tab ⇧Tab Enter f l y r Esc ?`; `m` is free.
- **Krypton's own runner.** `Run.check(group, label, ok, detail)` (`e2e/lib/run.ts:116`). `list` spreads `meta` into each Case (`e2e/krypton-e2e.ts:43`), so a `map` on `CaseMeta` flows to `list` with no other change.
- **Alternatives rejected.**
  1. **Diagram from call order or evidence.** It restates the log. The 2026-11-02 prototype on run `20261024T020217510Z` was rejected by the user.
  2. **Derive the map from code or traces.** Code needs a parser per language and misses loops and helpers. Traces need OpenTelemetry in the system under test (Tracetest's model).
  3. **Mermaid text written by the project.** Krypton could not validate `at` against it without parsing mermaid, and project text would enter the source verbatim. A structured map lets Rust validate ids and lets Krypton generate every id and escape every label.
  4. **One map per project.** Unrelated cases would share one crowded picture. A path per case still lets cases share a file.
  5. **Grey means "no pin".** It greys nodes a check passes through on its way to its pin (`bridge` in a PASS of `control-api-roundtrip`). The path rule below greys only nodes no pinned check reaches.

## Prior Art

| Tool | Implementation | Notes |
|---|---|---|
| Tracetest | Test specs attach assertions to spans through selectors such as `span[tracetest.span.type="database"]`; the UI shows results on the trace | Results on the system's own structure; needs OpenTelemetry traces |
| Pact Broker | Graph of consumer → provider integrations; the docs say the built-in layout does not scale and suggest exporting to graphviz | Service graph; a small focused graph reads better |
| Structurizr DSL | Architecture as code: elements and relationships; elements are anonymous unless given an identifier | The id + relationship model this map borrows, minus views and levels |
| Mermaid flowchart | Subgraphs, shapes (`{{ }}`, `[( )]`), cross edges (`--x`), `classDef`, entity codes for escaping | The renderer Krypton already ships |

**Krypton delta.**
- **No instrumentation:** pins come from the test's own `at` tags, so it works for any stack.
- **Small and per case:** one case's map at a time, which avoids Pact's layout problem.
- **The map is plain data, not a drawing:** Rust validates it, and Krypton generates the mermaid.
- **Same page rules as 0329:** read-only and keyboard-first.

## Contract additions (v1, optional)

- `Case.map`: a repo-relative path to a map file. Same path rules as `files`.
- `Check.at`: a string, the id of the node the check is about.
  - On pass: the node whose behaviour the check proves.
  - On fail: the node where the failure was found. Example: `control-api-roundtrip` sets `bridge` on a 504.

Map file:

```toml
version = 1
direction = "LR"                       # LR (default) | TB

[[group]]                              # optional; drawn as a box; no nesting
id = "rust"
label = "Rust · control.rs"

[[node]]
id = "validate"                        # ^[a-z0-9][a-z0-9._-]{0,47}$, unique
label = "request check"                # "\n" breaks a line; ≤ 3 lines of ≤ 60 chars
group = "rust"                         # optional, must exist
shape = "box"                          # box (default) | gate | store | actor
source = "src-tauri/src/control.rs:264"  # optional; shown in the pin list

[[edge]]
from = "harness-directory"
to = "axum"
label = "acp_control_reply"            # optional
kind = "reply"                         # flow (default) | reply | refused
```

- **Limits:** file ≤ 64 KiB; ≤ 60 nodes, ≤ 120 edges, ≤ 20 groups. Unknown keys are warnings, as in `project.toml`.
- **Edge kinds:**
  - `flow` is a step a request takes.
  - `reply` is a response going back. It is drawn, but the reach rule does not follow it.
  - `refused` is a connection the system must refuse, drawn `--x`.

## Design

### Rust (`src-tauri/src/e2e.rs`)

```rust
pub(crate) struct Case { /* … */ pub map: Option<String> }        // is_relative_clean
pub struct E2eCaseInfo { /* … */ pub map: Option<String> }
pub struct E2eStatus { /* … */ pub maps: BTreeMap<String, E2eMapEntry> }  // key: map path

#[serde(rename_all = "camelCase")]
pub struct E2eMapEntry { pub map: Option<E2eMap>, pub errors: Vec<String>, pub warnings: Vec<String> }
pub struct E2eMap { pub direction: String, pub groups: Vec<E2eMapGroup>, pub nodes: Vec<E2eMapNode>, pub edges: Vec<E2eMapEdge> }
pub struct E2eMapGroup { pub id: String, pub label: String }
pub struct E2eMapNode { pub id: String, pub label: String, pub group: Option<String>, pub shape: String, pub source: Option<String> }
pub struct E2eMapEdge { pub from: String, pub to: String, pub label: Option<String>, pub kind: String }

pub(crate) fn load_map(root: &Path, rel: &str) -> Result<(E2eMap, Vec<String>), Vec<String>>;
```

- **`load_map`:**
  - Path rules: `is_relative_clean`, canonicalize, `strip_prefix(canonical root)` so a symlink cannot escape, regular file, ≤ 64 KiB.
  - Then it parses the TOML (`toml` crate, already a dependency) and checks ids, references, enums and limits.
  - Errors are `nodes[3].group: unknown group "rustt"`; warnings are `unknown key "colour"`.
- **`gather`:** loads each distinct `map` path once. Every error is also pushed to `status.errors` as `map <path>: <error>`, so `#e2e status` prints it too.
- **`validate_result`:** `at` must be a string (`optional_str`). Membership in the map is not checked there, so an old run never becomes `INVALID RESULT` after a map edit.
- **`adapter_check`:**
  - Errors for every listed case's map.
  - With `result_path`, if the case has a map, each `checks[i].at` must name one of its nodes; otherwise it is an error.
  - A Result with `at` for a case without a map gives a warning.
- **`CONTRACT_MD`:** the Case and Result schemas gain `map` and `at`, plus a "Map file" section with the block above. `BOOTSTRAP_MD` is unchanged; maps stay optional.

### Page (`src/loopback/surfaces/e2e/`)

**Pure module `map.ts`:**

```ts
export type PinTone = 'fail' | 'blocked' | 'pass' | 'skip' | 'info';    // precedence, worst first
export interface MapPin {
  readonly key: string;            // 'P1'… in order of first appearance among the checks
  readonly at: string; readonly group: string;
  readonly counts: StatusCounts; readonly tone: PinTone;
  readonly checks: readonly number[];                   // indexes into Result.checks
  readonly before: { runId: string; counts: StatusCounts } | null;  // newest earlier PASS, when tone differs
}
export function buildPins(checks: readonly Check[], map: E2eMap, before: PassRun | null): { pins: MapPin[]; unplaced: Unplaced[] };
export function litNodes(map: E2eMap, pins: readonly MapPin[]): ReadonlySet<string>;
export function mapSource(map: E2eMap, pins: readonly MapPin[], lit: ReadonlySet<string>, colours: PinColours): string;
```

- **Pin:** one per `(at, group)`. A check with no `at`, or with an `at` not in the map, is `unplaced` and listed under "not on the map", with the reason.
- **Reach rule (`litNodes`):** a node is lit when it has a pin, or lies on a directed path from an `actor` node to a pinned node over `flow` edges only. That is forward reach from actors ∩ backward reach from pins. Actors are always lit. Every other node is idle (grey).
- **`before`:**
  - Applies when the selected run's verdict is not PASS and the case has an earlier PASS in `status.runs` (newest first).
  - Compares by `group`, because a failing check may move its `at` (C below). A pin gets `before` when its tone differs from the worst tone of the same group in that PASS.
- **`mapSource`:**
  - Krypton generates every mermaid id (`n0…`, `g0…`, `p0…`). Project ids never enter the source.
  - Every project string passes through `mermaidText()`: `#` → `#35;`, `"` → `#quot;`, `<` → `#lt;`, `>` → `#gt;`, `` ` `` → `#96;`, newline → `<br/>`.
  - Shapes: box `["…"]`, gate `{{"…"}}`, store `[("…")]`, actor `("…")`, pin `(["…"])`.
  - Edges: `flow`/`reply` `-->`, `refused` `--x`, pin `-.->`.
  - Pin label, up to three lines: `P3 · <group>`; the counts as `✓×n ✗×n ⊘×n –×n i×n` (pass, fail, blocked, skip, info), zero counts dropped; `PASS <runId>: <counts>` when `before` is set.
  - Colours: one `classDef` per tone from the page tokens (pass `--add`, fail `--del`, blocked `--accent`, skip/info `--muted`), and `idle` (dashed stroke, `--muted` text). Each colour is resolved to `#rrggbb` first, because the commas in `rgb(…)` would break `classDef`.
  - Same input, same string.

**View (`index.ts`):**

- **Theme:** `buildMermaidTheme(palette, --mono, true)`, with the palette read from the loopback tokens (`fg muted border accent`, success = `--add`, error = `--del`, surface = `--card`).
- **When the map shows:** the run pane draws it when the case's `map` has a loaded entry and the run has a Result. It is the default view; `m` toggles to the 0329 grouped check list (since 0328 rev 5 it cycles map → by group → by step). The choice persists while the page is open.
- **Run switch, still one paint:** after `/run` answers, the page fetches the earlier PASS's `/run` (only when `before` applies) and awaits `renderMermaid`. Then it paints the case pane, the run pane and the map together.
  - `loading run…` keeps its 250 ms rule.
  - A render error shows an error `Banner` (`map could not be drawn: …`) and falls back to the check list.
- **Markup:**
  - `figure.lb-e2e__map > img.lb-e2e__map-img`: the SVG as a data URL, never inserted as markup, as in GenUI.
  - `div.lb-e2e__pins`: one block per pin. The head is key, node label, group, a status `pill`, and `source` when set. The pin's checks follow as the existing `.lb-e2e__check` rows. "not on the map" comes last.
  - Full 1px borders only: no left-edge accent rail (ADR 0027) and no corner brackets (constraint 9).
- **`f`:** filters the pin list to pins and unplaced checks with `fail`/`blocked`. The picture stays whole.
- **Map errors:** `status.maps[path].errors` show as an error `Banner` in the run pane, and the view falls back to the check list.

### Data Flow

```
1. The adapter's `list` gives Case.map; `run`/`history` give checks with `at`.
2. gather(): load_map() once per distinct path → E2eStatus.maps (+ status.errors).
3. The page loads /status (unchanged) and selects a run → GET /run.
4. Verdict ≠ PASS and an earlier PASS exists → GET /run for it.
5. buildPins → litNodes → mapSource → renderMermaid → one paint of case pane, run pane and map.
```

### Keybindings

| Key | Context | Action |
|---|---|---|
| `m` | e2e page, a case with a map | Toggle map / check list (listed by `?`); since 0328 rev 5, cycle map / by group / by step |

## Test cases

Fixtures live in `src/loopback/surfaces/e2e/fixtures/`: the parsed map JSON plus the Result, with `at` added. A and B are real runs; C's FAIL is synthetic, because the bridge cannot be made to stop answering without changing app code. Each row is asserted exactly: pin keys, `(at, group)`, counts, tone, lit/idle sets, unplaced.

**A: valence `push-and-browse`, run `20261102T160558061Z` (PASS, 16 checks).** Map transcribed from the 2026-11-02 example. valence later added the same map to its repo as `e2e/maps/push-and-browse.toml` ("valence report" under Implementation Notes). The fixture keeps its own copy, because Krypton's tests cannot read another repo.

- **Map:** actor `fixture` → `krypton-reader` → `push` → `ingest` (`HTTP + token`) → store `store` → `report` → `w-home`, `w-project`, `w-run`, `w-case`; `store` → `w-raw`, `w-other`. Groups: `cli`, `serve`.
- **`at`:** `serve`×2 → `w-home`; `push`×2 → `push`; the repo-name check → `push` (`identify`, `push.go:251-255`); the case-order check → `w-project`; `report`×2 → `w-run`; `evidence`×3 → `w-raw`; `restart` → `store`. The 3 precondition `info` checks and `build` have no `at`.
- **Pins:**
  - P1 `serve@w-home` ✓×2
  - P2 `push@push` ✓×2
  - P3 `report@push` ✓×1
  - P4 `report@w-project` ✓×1
  - P5 `report@w-run` ✓×2
  - P6 `evidence@w-raw` ✓×3
  - P7 `restart@store` ✓×1
- **Unplaced:** 4.
- **Idle:** exactly `w-case`, `w-other` (`internal/web/web.go:43,45-47`). `krypton-reader`, `ingest` and `report` are lit by reach.

**B: `loopback-api-authorization`, run `20261024T020217510Z` (PASS, 26 checks).** Also the real map `e2e/maps/loopback-auth.toml`.

- **Map:**
  - Actors `lan`, `web`, `local`.
  - Gates `bind-control`, `cors-control`, `bearer`, `lane-capability` (group `control`), and `bind-loopback`, `cors-loopback`, `json-only`, `capability-token` (group `loopback`).
  - Boxes `control-handlers`, `computer-handlers`, `doc-feedback`, `token-pages`.
  - Edges: `lan --x bind-*`; `web` → `cors-control`; `web` → `cors-loopback` → `json-only` → `doc-feedback`; `local` → `bearer` → `control-handlers`; `bearer` → `lane-capability` → `computer-handlers`; `local` → `capability-token` → `token-pages`.
- **`at`:** the positive control → `control-handlers`; 6 bearer rejections → `bearer`; 3 → `lane-capability`; CORS → `cors-control` / `cors-loopback`; 415 → `json-only`; 9 tokens → `capability-token`; exposure → `bind-control` / `bind-loopback`.
- **Pins:**
  - P1 `control API bearer@control-handlers` ✓×1
  - P2 `control API bearer@bearer` ✓×6
  - P3 `control API lane capability@lane-capability` ✓×3
  - P4 `cross-origin@cors-control` ✓×1
  - P5 `cross-origin@cors-loopback` ✓×1
  - P6 `cross-origin@json-only` ✓×1
  - P7 `capability tokens@capability-token` ✓×9
  - P8 `network exposure@bind-control` ✓×1
  - P9 `network exposure@bind-loopback` ✓×1
- **Unplaced:** 2 (precondition).
- **Idle:** exactly `computer-handlers`, `doc-feedback`, `token-pages`: the gates are tested only from the refusing side.

**C: `control-api-roundtrip`, PASS `20261023T172243445Z` and a synthetic FAIL.** Also the real map `e2e/maps/control-api.toml`.

- **Map:** actor `runner` → `axum` → `validate` → `bridge` (`Tauri event`) → `harness-directory`; `harness-directory` → `axum` (`reply`, `acp_control_reply`); `axum` → `sse`. Groups `rust` (`axum validate sse`), `frontend` (`bridge harness-directory`).
- **PASS:**
  - Pins: P1 `capabilities@axum` ✓×2, P2 `validation@validate` ✓×1, P3 `frontend round trip@harness-directory` ✓×3, P4 `events@sse` ✓×1.
  - Unplaced: 1 (precondition). Idle: none. `bridge` is lit by reach.
- **FAIL:**
  - The same checks, except the three `frontend round trip` checks are `fail`, with detail `status 504 — the frontend control bridge did not answer` and `at: "bridge"`.
  - Pins: P3 `frontend round trip@bridge` ✗×3, `before` `PASS 20261023T172243445Z: ✓×3`. P1, P2 and P4 are as in the PASS, with no `before`.
  - Idle: exactly `harness-directory`, because its only way back to a pin is a `reply` edge.

**Generic cases:**
- The same input gives an identical `mapSource` string twice.
- A label with a double quote, `#`, `<`, `>`, a backtick and a newline gives exactly the expected source: each of those characters as its entity code, the newline as `<br/>`.
- No project id appears in the source.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/e2e.rs` | `Case.map`, `E2eCaseInfo.map`, `E2eStatus.maps`, map types, `load_map`, `at` type check, `gather`, `adapter_check`, `CONTRACT_MD` |
| `src/loopback/surfaces/e2e/map.ts` + `map.test.ts` + `fixtures/` | **New.** Pure pins / reach / source; A, B, C |
| `src/loopback/surfaces/e2e/index.ts`, `e2e.css`, `e2e.test.ts` | Map view, `m`, PASS comparison fetch, pin list |
| `e2e/lib/run.ts`, `e2e/cases/*.ts`, `e2e/maps/{control-api,loopback-auth}.toml` (new), `e2e/README.md` | `at` on `check`/`info`/`skip`/`block`, `CaseMeta.map`, the two real maps, a "Map" section |
| `docs/0328-…`, `docs/0329-…`, `docs/README.md`, `DESIGN.binance.md` | Contract fields; map view and `m`; index; e2e surface row |

## Edge Cases

- **Map missing, too large, outside the project, invalid TOML or failing a rule:** status error plus run-pane banner; the check list shows.
- **Map edited after a run:** runs are drawn on today's map. An `at` that no longer exists becomes unplaced with `"x" is not a node of <path>`.
- **No `at` at all in the run:** the map draws with only actors lit, and every check is unplaced.
- **No Result** (NO RESULT, INTERRUPTED, INVALID RESULT): no map; the 0329 empty state.
- **Two cases share a map file:** loaded once per `gather`.
- **Earlier PASS missing from the history cache:** no `before`, no error.
- **More than 120 pins:** banner `too many pins`; the check list shows.
- **ext runs:** same as Krypton runs; `at` comes from `history`.

## Open Questions

None. Decided above:
- the map is per case, by path;
- it is TOML data, not mermaid text;
- grey means unreached (the reach rule), not unpinned;
- the comparison is by group;
- valence draws the same maps in its own report, built later in the valence repo ("valence report" under Implementation Notes).

## Out of Scope

- Rendering maps in the transcript or in `#e2e status`.
- Krypton generating maps or `at` by itself (from code, traces, evidence or a model), and any new `#e2e` subcommand. A lane may still write a map when the user asks, like any other file.
- Editing maps from the page; any POST route (0329 still holds).
- Other visualizations (input × target matrix, data-state, screenshot storyboard).
- Drawing a run on the map version it ran with.

## Implementation Notes

Where the shipped code adds to the design above:

- **Extra map errors.** Besides the listed rules, `load_map` reports:
  - `<path>.<key>: required` for a missing key, and `label: must not be empty` for an empty label;
  - `nodes: must be an array of tables` and `nodes[i]: must be a table`;
  - `source: must be a single line` and `source: longer than 200 characters`;
  - `toml: <message> (line N)` for a parse error, on one line.
- **Validation split.** `parse_map(text)` checks the content; `load_map` adds the path rules. `case_maps` loads each distinct path once, for both `gather` and `adapter_check`.
- **Krypton's own e2e.**
  - `Run.check/info/skip/block` take `at` as an optional last argument.
  - `e2e/maps/control-api.toml` and `e2e/maps/loopback-auth.toml` are the maps of C and B.
  - Live runs now carry 10 `capability tokens` checks: `termctrl-log` was added after run `20261024T020217510Z`. Fixture B keeps that run's 9.
- **Fixtures.** `src/loopback/surfaces/e2e/fixtures/` holds A, B and C as parsed maps plus checks.
  - B and C use the real map files; A transcribes the example map.
  - Fixture B replaces the LAN address in check details with `192.0.2.10`.
- **valence report.** Built after this spec at the user's request, in the valence repo (commit `ebf9558`, 2026-11-03). It reads the same `Case.map` and `Check.at` and keeps the pin, reach and comparison rules above. valence decided the rest:
  - `push` and `check` read each distinct `Case.map` with the `load_map` path rules and a Go port of `parse_map` (`internal/krypton/sysmap.go`: `ReadMap`, `ParseMap`). Map errors and unknown keys print as `map <path>: …` warnings. `push` sends the map files with the sync request (`maps`).
  - The server parses each map again and keeps the latest one per path. When `list` fails, it keeps the cases and maps it already has.
  - Every run is drawn on the latest map, as in Krypton; there is no map snapshot per run. The unplaced reason is `"x" is not a node of <path>`.
  - The run page draws the map as inline SVG, laid out on the server by a deterministic layered layout (`internal/report/maplayout.go`) and coloured by valence's theme tokens; no mermaid. Pins hang below their node (LR) or right of it (TB) instead of being separate nodes. Checks list by pin (default) or by group, with the All/Failures filter. A map that cannot be drawn shows a banner.
  - `valence check` reports an `at` that is not a node as a problem: `check "<label>": at "<x>" is not a node of <path>`. Unlike `adapter_check`, it gives no warning for `at` on a case without a map.
  - Fixtures A, B and C are copied to `internal/report/testdata/` and asserted to the same pins, unplaced checks, idle nodes and `before` as `map.test.ts`. valence's own `push-and-browse` case now has `e2e/maps/push-and-browse.toml` and an `at` on every check.

**Verified:**

- **Rust.**
  - `cargo test`: 629 lib tests pass, 32 of them `e2e`. The new tests cover `Case.map`, the `at` type check, every map rule, the path rules including a symlink escape and 64 KiB, and `gather` filling `maps` and errors. They also cover `adapter_check` reporting an unknown `at` as an error and `at` without a map as a warning.
  - `cargo clippy --all-targets -D warnings` is clean apart from the existing `bool_assert_comparison` at `timeline.rs:3225`, which this work did not touch.
- **Frontend.**
  - `npx vitest run`: 279 files and 3346 tests pass.
  - `map.test.ts` asserts A, B and C exactly as listed under Test cases: pins, unplaced checks, idle nodes, the `before` note on C's FAIL. It also asserts identical source twice and escaping.
  - `e2e.test.ts` adds 5 page cases: map by default and `m`; the earlier PASS fetched only for a failing run; `f` trims the list only; a broken map falls back to the check list.
  - `npm run check` exits 0.
- **Smoke.**
  - `node e2e/krypton-e2e.ts list` prints `map` for both cases.
  - Both cases ran against the running Krypton: `20261102T165805098Z` PASS with 7 checks, and `20261102T165805315Z` PASS with 25. Every check carries the specified `at`.
  - A throwaway server (since removed) served the real `e2e_web` router for this repo, with Vite for the page. In Chromium:
    - `control-api-roundtrip` showed 4 green pins and no grey node.
    - `loopback-api-authorization` showed 9 pins, with `computer-handlers`, `doc-feedback` and `token-pages` dashed grey.
    - `m` and `f` behaved as specified, and every `/e2e/api` request was a GET.
- **valence** (at `a73eefc`, which contains `ebf9558`).
  - `go test ./internal/krypton/ ./internal/report/ ./internal/push/ ./internal/web/...` passes, fixtures A, B and C included.
  - `go run ./cmd/valence check --root <this repo>` prints `problems: 0 current, 0 frozen; 0 warning(s)` over 2 cases and 7 runs: both maps parse in the Go port and every `at` names a node.
- **Not exercised:**
  - C's FAIL on a live run; only the fixture covers it.
  - `#e2e open` inside a rebuilt Krypton.
  - valence's report drawing a live run. Only valence's unit tests and `check` ran for this note; valence's own e2e covers its run page.

## Revision — inline map on valence's layout (2026-11-14)

**Problem.** Mermaid's SVG says `width="100%"`, so as an `<img>` it has no natural size and is stretched or squeezed to the column. A small map was blown up, a large one shrunk, and long labels broke mid-word. valence's report, which keeps the same pin, reach and comparison rules, draws the run inline on its own layered layout and reads better. Spec 0400's bug trail made the same move first.

**Change.**
- **Layout.** The map is laid out by the kit's `layoutMap` (`src/loopback/kit/sysmap/layout.ts`), a line-for-line port of valence's `internal/report/maplayout.go`. Goldens produced by the unmodified Go code are its tests, including one with e2e pins (group label, problem counts, a key-only pin, a truncated label).
- **Drawing.** `SysMap` (`kit/sysmap/index.tsx`) draws it as inline SVG from React elements, so every project string is a text node and nothing is parsed as markup. The 0294 reason for an `<img>` (mermaid output is markup built from project text) no longer applies.
- **Pins.**
  - `layoutPins` hands the layout one pin per `(at, group)`: key, check group (cut to 28 characters) and `problemsText` (`1 failed, 2 blocked`), as valence's pins do. The title carries `countsWords` and `Earlier PASS <runId>: …`.
  - `pinLook` colours by worst status: fail red and heavy, blocked accent, pass green, skip/info muted and dashed.
  - Idle nodes come from `litNodes` as before.
- **Removed.** `mapSource`, `mermaidText`, `hexColour`, `PinColours` and the page's mermaid theme. The run pane still paints the case pane, the run pane and the map together. The layout is synchronous; only the earlier PASS fetch is awaited.
- **Markup.** `figure.lb-e2e__map > div.lb-e2e__map-scroll > svg.lb-sysmap`. The SVG is drawn at its own size and shrinks to 75% at most, then scrolls.

**Verified.**
- `npx vitest run src/loopback/surfaces/e2e src/loopback/kit/sysmap src/loopback/surfaces/trail`: 66 tests pass.
  - `map.test.ts` keeps fixtures A, B and C (pins, unplaced checks, idle nodes, `before`). It adds the layout pins for C's FAIL (`P3`, `frontend round trip`, `3 failed`, the earlier-PASS title), plain project text in the drawing, and valence's count words.
  - `e2e.test.tsx` checks the inline SVG at its own width, two pins with one heavy red, the problems text and the earlier-PASS title.
- `npx tsc --noEmit` passes, and `npm run build` emits `dist/app/e2e.js` with no mermaid in it.
- In Chromium, the built bundle ran against a mock e2e API that served the real `tli-online` map and run `20261102T051516Z`'s checks. Two checks were set to fail and one to blocked, and the `at` tags were added by label, because that run's records carry none.
  - The page showed 8 pins under their nodes, 9 idle nodes dashed, and `2 failed` / `1 blocked` on their pins.
  - Thai group names were cut by cells, and the earlier PASS appeared in the pin titles.
- **Not exercised:** the page in a rebuilt Krypton against the real `#e2e open` API.

## Resources

- [Tracetest — Create Assertions](https://docs.tracetest.io/getting-started/create-assertions): assertions attached to trace spans by selector; results shown on the system's structure.
- [Pact Broker — Create a network graph](https://docs.pact.io/pact_broker/network_graph): the built-in service-graph layout does not scale; export to graphviz.
- [Structurizr DSL — Identifiers](https://docs.structurizr.com/dsl/identifiers): elements and relationships, anonymous unless given an identifier.
- [Mermaid — Flowcharts syntax](https://mermaid.js.org/syntax/flowchart.html): subgraphs, shapes, cross edges, `classDef`, entity codes.
- Internal: 0328, 0329, 0341, 0294, ADR 0027; `src/acp/harness-mermaid-fence.ts`; `src/acp/components/genui-catalog/data.ts`; `valence/internal/krypton/contract.go`.
