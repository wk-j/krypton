# ACP Harness Generative UI Catalog — Implementation Spec

> Status: Approved (2026-10-17, phase 1 in progress)
> Date: 2026-10-17
> Milestone: ACP Harness
> Supersedes the wire format of [spec 308](./0308-harness-generative-ui.md); keeps its host model (sealed card → panel), whose host surface [spec 310](./0310-harness-genui-inline-panel.md) then moved from an overlay to the card itself. The catalog and renderer are host-agnostic and unchanged by 310.
>
> **Revision (2026-10-17): a fence is collapsed while it streams.** See §Streaming.

## Problem

Spec 308 shipped a 9-node JSON fence whose expressions are `add`/`multiply`/`formatNumber` and whose only action loads a composer draft. Every value must be inlined by the model as a literal, so the panel can never show a test run, a diff, a coverage report or a chart of real numbers — the one thing that would justify opening it. The feature's reachable ceiling is a linear calculator, and nothing in `genUiPrompt()` stops a lane from opening a panel that merely restates a sentence.

## Solution

Replace the JSON wire format with a small expression language (lexer → parser → validator → tree-walking interpreter, no `eval`), drive it from a **catalog** that is the single source of truth for validation, rendering and prompt text, and let a spec name files instead of inlining numbers: `Load("…")` / `Snippet("…", from, to)` are collected statically and read by a confined Rust command before evaluation. Renderers become kernel `Component`s so one input repaints one node. The whole catalog is taught in the one-shot `#ui` turn and **nowhere else** — no standing policy line, no always-registered tool — so a lane that never runs `#ui` pays nothing and never emits a fence. Actions still only ever load a visible composer draft.

## Research

- **Krypton's current host is sound; its language and renderer are not.** The card→`f`-hint→`OverlayShell` path, the `(lane, item, index, sourceHash)` state key and the 32-entry LRU all survive unchanged (`acp-harness-view.ts:9484-9507`). But `GenUiPanel` is not a kernel component: no `readDeps`, no `DisposableBag`, `content.replaceChildren()` per open and a flat `bindings: Array<() => void>` where **every** input re-runs **every** binding (`genui-panel/index.ts:52,133-135`). At catalog scale that is O(tree) per keystroke against the 16 ms budget. The kernel's `Component`/`reconcile()`/`RenderScheduler` (`src/ui/`) is the in-repo answer and is currently unused by genui.
- **JSON cannot express what a catalog needs.** A table built from a loaded report needs iteration (`rows.map(r => …)`) and a conditional (`r.failed > 0 ? "bad" : "good"`). Encoding either as `{"op":…}` nodes inflates the fence past its own 16 KiB cap and is hostile to write. BB's `core/` is framework-free pure TypeScript (lexer/parser/validate/evaluate) and ports to vanilla TS cleanly; only its ~86 React renderers do not.
- **Data by reference is the whole value.** ~30 of BB's 86 components are useless without `Load` (`core/data.ts:34-95`, `data-source.ts:109-169`). Paths must be **literal strings** so the host can prefetch before evaluating — a computed path is a compile error (`core/validate.ts:467-496`). Reads are confined to workspace + thread storage + `/tmp`, `..` is refused before any read (`data-source.test.ts:69-75`), 2 MB cap, and loaded data is scrubbed of anything with `kind:"node"|"action"|"binding"` so a file cannot impersonate an interpreter value (`core/data.ts:313-333`).
- **The repaint rule is the hard boundary.** BB's `Changes/Commits/PullRequest/Threads` poll on a 4 s→60 s backoff and repaint **inside the transcript row** (`ui/components/projectKit.tsx:63-130`). Krypton forbids that in a sealed row — but the panel is not a row, so the same freshness is legal inside an open panel and nowhere else.
- **Prompt economics are the real constraint.** BB spends ~16 KB / ~4,000 tokens of standing instructions in four sections capped at 4,096 chars each (`instructions.test.ts:16-23`), generated from the catalog so the prompt cannot drift from the parser. Spec 0289 caps Krypton's solo-lane policy at ≤1,700 chars (measured 1,591) and 308 promised zero standing cost. Krypton keeps that promise absolutely: the catalog is delivered **only** inside the `#ui` system turn, which already bypasses the policy path (`enqueueSystemPrompt` → `dispatchTurn`, `acp-harness-view.ts:2363-2373`). A one-shot ~6 KB is affordable precisely because the user asked for it; the same 6 KB standing would be 3.5× the budget and resent every 20 turns.
- **Existing renderers to reuse, verified:** `chartGeometry()` and `sanitizeSvg()` are pure and host-free (`review-board/render.ts:226-291`, `:68-163`); `renderMermaid()` "never touches DOM", is cached 64-deep and already `securityLevel:'strict'` (`harness-mermaid-fence.ts`); `DiffBlock`, `StatList`, `Card`, `OverlayShell` take their BEM block as a prop and are directly reusable. `Meter`'s prefix is a per-mode constant (`meter/index.ts:70-75`) and would need a prop to serve the catalog. `review-board/render.ts`'s DOM builders use `innerHTML` + `krypton-review__*` and cannot be imported.

### Alternatives considered

| Approach | Decision |
|---|---|
| Keep JSON, add operators and ~50 node types | Reject: no iteration ⇒ every table row inlined ⇒ the starvation this spec exists to fix |
| Port BB's React renderers | Reject: constraint 6 (no frontend frameworks). Only `core/` ports |
| Ship all 86 components | Reject: Media (Map/ImageSearch/Gallery/Hotspots) needs network; Widgets (Quiz/Flashcards/Timer) has no use in a coding harness |
| Teach the catalog in standing policy, as BB does | Reject: 2.4× the 0289 budget, resent every 20 turns |
| Register `ui_catalog` / `ui_check` as MCP tools | Reject: an MCP tool's name and description are themselves standing text in every lane's tool index. "Only on `#ui`" means no permanent tool |
| Keep accepting the 308 JSON alongside the DSL | Reject: two grammars, two validators, two prompt texts. Clean cutover |

## Prior Art

| App | Implementation | Krypton consequence |
|---|---|---|
| BB Gen UI | ` ```ui ` DSL, 86 components in `core/catalog.ts`, 4 actions, `Load` prefetch, buttons auto-send | Take the language shape, the catalog-as-source-of-truth and data-by-reference; reject auto-send, network media, in-row polling |
| BB `app` fence | Whole HTML doc in `<iframe sandbox="allow-scripts">`, CSP `default-src 'none'` | Already specified separately as Krypton's ` ```visual ` fence (draft [spec 292](./0292-harness-inline-html-visuals.md)); out of scope here |
| Claude Artifacts | Generated tool in a dedicated surface, source viewable | Keep: panel + Source control |
| A2UI | Versioned, renderer-approved catalog validated before render | Keep the catalog boundary; add the version field BB lacks |

**Krypton delta.** The catalog is taught once, on request, and never stands. Actions produce a draft, never a message. Freshness lives in the panel, never in a sealed row. No network reachable from a spec.

## Affected Files

| File | Change |
|---|---|
| `src/acp/genui/catalog.ts` | **New.** Component/action/function tables: group, params, kinds, enums, `holds`, one-line summary. Source of truth for validator, renderers and prompt text |
| `src/acp/genui/lexer.ts`, `parser.ts`, `ast.ts` | **New.** Tokens, precedence, statements, 100-deep nesting cap |
| `src/acp/genui/validate.ts` | Replaces today's field-whitelist `parse.ts`: arity, enums, binding `holds`, literal-path rule, forbidden properties, limits, `Diagnostic[]` |
| `src/acp/genui/evaluate.ts` | Replaces the 3-op evaluator: interpreter with step/node/depth/string budgets, `UiNode[]` output, action construction |
| `src/acp/genui/data.ts` | **New.** `collectLoads()`, extension parsers (JSON, JSONL, CSV, TSV, JUnit XML), `kind:` scrub, loaded-list cap |
| `src/acp/genui/report/*.ts` | **New.** Tool-output readers: tests, coverage, findings, stack traces, logs, benchmark, dependencies, treemap |
| `src/acp/genui/markdown.ts` | **New.** `specToMarkdown()` for Live Assist / Telegram / copy |
| `src/acp/genui/schema.ts`, `parse.ts` | Removed; `UiFenceEntry` moves to `catalog.ts`-adjacent types |
| `src/acp/components/genui-catalog/` | **New.** One directory, block `acp-genui`, per-group modules (`layout.ts`, `content.ts`, `data.ts`, `inputs.ts`, `dev.ts`, `project.ts`, `manage.ts`) of kernel `Component`s + per-group sheets imported by its `index.ts` |
| `src/acp/components/genui-panel/index.ts` | Rewritten as a kernel component: node→`Component` map, `reconcile()` by node path, per-node `readDeps`, roving-tabindex focus ring covering `textarea`/grids |
| `src/acp/components/genui-card/index.ts` | Summary line from the catalog (`chart · table · 2 inputs`); error label carries the first `Diagnostic` |
| `src/acp/components/meter/index.ts` | `block` becomes a prop (keep current values as defaults) so the catalog can reuse it |
| `src-tauri/src/genui_data.rs`, `lib.rs` | **New command** `read_ui_data(lane_cwd, path, max_bytes)`: canonicalize, confine to lane cwd ∪ `.krypton/` ∪ `/tmp`, 2 MB cap, returns `{text, truncated}` |
| `src/acp/harness-prompts.ts` | `genUiPrompt` rewritten: syntax, the catalog signatures generated from `catalog.ts`, the selection criterion, and a prose opt-out. Sole delivery point |
| `src/acp/acp-harness-view.ts` | Panel data prefetch, `Set`/`Copy`/`OpenUrl`/`Draft` action routing, per-node view state in the existing LRU |
| `docs/0308-…md`, `docs/0072-…md`, `docs/README.md`, `AGENTS.md` | 308 marked superseded-in-part; data-flow step for `Load`; index row |

## Design

### Wire format

Fence info word stays `krypton-ui`. An optional first line `version 2` is stripped before parsing — recommended in generated specs, never required, because a missing marker must not discard an otherwise valid panel. A body whose first non-whitespace character is `{` is rejected with `krypton-ui v1 JSON is no longer accepted` and stays visible as code; that check is what separates the two formats unambiguously.

```
program   := statement (NEWLINE | ';')*
statement := '$' IDENT '=' expr        # input state, top level only, initialised in order
           | IDENT '=' expr            # named value, or an arrow = named function
           | expr                      # a root: renders
```

Children are list arguments, not nesting syntax: `Card("Estimate", [Row([…]), Metric("Total", fmt(total))])`. Arguments are positional then named (`label: "Seats"`). Comments are `//`.

**Expressions.** `?? || && == != < <= > >= + - * / % **`, unary `! -`, `cond ? a : b`, `obj.key`, `obj[expr]`, `` `tpl ${x}` ``. Functions: `round fmt sum min max abs floor ceil pow keys values entries len Load Snippet`. Methods: list `map filter find some every join slice includes indexOf`, string `includes slice split trim toUpperCase toLowerCase startsWith endsWith`, number `toFixed`. Arrows are allowed only as the first argument of `map/filter/find/some/every` or as a named function; max 2 params; no recursion. `__proto__`, `prototype`, `constructor` are rejected at compile **and** at runtime.

**Actions** (4, same shape as a value): `Draft(text)` loads the composer draft — the user's Enter sends it, exactly as in 308; `Set($name, value)`; `Copy(text)`; `OpenUrl(url)` (`http(s)` only, re-checked at run, routed through the existing `open_url`). **There is no `Send`.** A button with no action drafts its own label.

### Catalog

`catalog.ts` holds every component with its params; the validator reads it, the renderer registry is keyed by it (a catalog entry with no renderer fails a CI assertion), and the prompt generator emits one signature line per entry so the prompt can never drift from the parser. Delivered set — **57 components, 8 groups**:

| Group | Components |
|---|---|
| Layout (7) | Card · Row · Stack · Grid · Tabs · Details · Divider |
| Content (7) | Text · Callout · Metric · Badge · KeyValue · List · Sources |
| Data (13) | Table · Chart (bar\|line\|area\|pie\|scatter\|funnel\|heatmap) · Sparkline · Progress · Gauge · SegmentedBar · Steps · Timeline · Tree · Code · Snippet · Diff · Diagram |
| Inputs (12) | Slider · Stepper · Toggle · Choice · Radio · Select · Checklist · Input · TextArea · Rating · EditableTable · Button |
| Form (2) | Form · FollowUps |
| Dev (8) | Logs · StackTrace · Findings · Coverage · Dependencies · Pipeline · Benchmark · Treemap |
| Project (3) | Tests · Json · Changes |
| Manage (5) | Board · Roadmap · Status · Plan · Decision |

`Diagram` reuses `renderMermaid()` verbatim. `Diff` reuses `DiffBlock`. `Chart` reuses `chartGeometry()`. `Changes` reads the lane's diff through the existing harness state — **panel only, no timer**: a Refresh control, never a poll.

### Data by reference

1. `validate.ts` requires a literal string path for `Load`/`Snippet` and records every request.
2. Before the panel opens, `AcpHarnessView` resolves each request once through `read_ui_data`, keyed `load:<path>` / `raw:<path>:<from>-<to>`, into a per-panel map. Resolution is awaited **before first paint** — the panel never paints short and grows, so no height-reservation machinery is needed.
3. Rust confines the read: `canonicalize()` then prefix-match against the lane cwd, the project `.krypton/` directory, or `/tmp` (`/private/tmp` first on macOS). Anything else, any symlink leaving the root, and any read over 2 MB returns a typed error. `..` fails before the open.
4. Text is parsed in TypeScript by extension (`.json/.sarif/.har` → JSON, `.jsonl/.ndjson` → list, `.csv/.tsv` → objects keyed by header, `.xml` → JUnit only, else raw string), then scrubbed: any object carrying `kind: "node" | "action" | "binding"` at any depth is rejected.
5. A missing or failed file renders that one node as a labelled placeholder with the reason. It is never a block-level failure.

### Prompt economics

**Standing cost: zero characters.** No policy line, no registered tool, no fence guidance beside the existing svg/mermaid lines. A lane learns the language exactly once, in the turn the user triggers with `#ui <request>`, which `enqueueSystemPrompt` dispatches outside the lane-context path so it carries no policy at all.

| Part of the `#ui` turn | Size | Content |
|---|---|---|
| Syntax | ~800 chars | Statements, expressions, the action rule, one worked example |
| Catalog signatures | ~5,000 chars | One generated line per component: `Chart(type: bar\|line\|…, labels, series, unit?, stacked?)` — emitted from `catalog.ts` by the same table the validator reads |
| Selection criterion + opt-out | ~400 chars | Build a UI only for a value that recomputes, a comparison, a distribution, or a file-backed report. Otherwise answer in prose and emit no fence |
| Total | **~6 KB (~1,500 tokens), once per `#ui`** | |

Consequences, stated plainly: a lane never produces a `krypton-ui` fence on its own initiative, the panel exists only where the user asked for one, and a long `#ui` conversation re-pays the 6 KB on each new `#ui` (the guidance is one-shot, not sticky). `genui.test.ts` asserts that every catalog entry appears in the generated prompt, that every embedded example compiles and evaluates clean, and that the assembled prompt stays under 8 KB.

### Panel

`GenUiPanel` becomes a `Component<GenUiPanelProps>`. Each `UiNode` maps to a catalog `Component` keyed by node path; `reconcile()` patches in place. Re-evaluation on input produces a new `UiNode[]`; each component's `readDeps()` is its own evaluated props, so an untouched subtree early-returns. The scheduler coalesces an input burst into one frame. Interactive state stays in the existing `(lane, item, index, sourceHash)` LRU; per-component view state (open tab, expanded rows, Decision weights) is stored beside it under the node path and dies with the entry. Focus: a roving tabindex over `[data-genui-focusable]` so grids, editable tables and text areas are reachable; `Escape` closes; the panel keeps swallowing every other key while open.

### Limits

Source 20,000 chars · parse nesting 100 · eval depth 1,000 · 200,000 steps · 2,000 nodes · list produced/iterated 1,000 · list inside a loaded file 20,000 · string 100,000 · data file 2 MB · snippet 400 lines · 2 fences per assistant item · 32 retained panel states. Exceeding any limit is a compile or runtime diagnostic, never a crash.

### Failure behaviour

Block-level **fail-closed**: any error-severity diagnostic ⇒ no panel, the fence stays visible as code, and the card is replaced by a one-line error carrying the first diagnostic. Node-level **fail-soft**: a runtime error inside one component renders that node as an error chip; its siblings still render. A limit stops evaluation of the remaining roots. Validation runs only after `seal()` — nothing is mounted while streaming.

### Streaming

A spec is a program, and streaming one paints tens of lines of source into the
reply for the seconds before seal replaces it with a one-line card — pushing
the prose it belongs to off screen to show the user something they have no use
for. So the source is never painted: after each `parser_write`,
`updateLiveUiFences()` stands one **strip** in front of each of the first two
` ```krypton-ui ` fences (`interactive UI · receiving spec · N lines`, the
count being the liveness signal — no `infinite` animation to leak into a
sealed row), and the component sheet hides that fence's own `pre` while the
body carries `--stream-live`.

This changes what is *painted*, not what is *run*: nothing is compiled, no
control is mounted, and no partial prefix is evaluated — the strip is text.
The strip is a **sibling inserted before** the parser-owned `pre`, never a
wrapper, because `streaming-markdown` only ever appends into the nodes it
holds; the `pre` stays in the tree and keeps receiving output behind it. This
is the spec 283 live-svg-card mechanism applied to a fence that has no
preview. At seal, `clearLiveUiFences()` removes every strip **before**
`markdownHtml` is captured, so the cache stays pure markdown and decoration
sees a bare `pre`. The strip carries the card's border, radius and margin, so
the swap does not move the rows under it (measured: both 35px).

## Edge Cases

- **A v1 JSON fence in scrollback** renders as code with the version error. Accepted: fences are chat-scoped and the feature is days old.
- **A third fence in one item** stays code (unchanged cap) — and is not collapsed either: the same cap governs the strip, so what the user sees streaming is what seal leaves behind.
- **A fence that does not compile** is collapsed like any other while it streams; seal drops the strip, and the `pre` comes back carrying the one-line diagnostic. Source appears exactly when it is worth reading.
- **A reply that never streams in the foreground** (cold load, lane switched away) paints sealed and never has a strip to clear.
- **File written after the panel opened** — Refresh re-resolves; successes only are cached, so a later write is picked up.
- **Loaded CSV with 50,000 rows** — refused by the loaded-list cap with a diagnostic naming the file.
- **Lane closed while the panel is open** — existing `dropGenUiLane` path closes it and drops state.
- **Remote/SSH lane** — `read_ui_data` runs on the machine hosting the webview; a path that resolves only on the remote returns `file not found`. Stated, not worked around.
- **`OpenUrl` while the panel is not focused** — ignored, like the visual-fence link rule.
- **Theme switch with a panel open** — components read `--krypton-*` tokens; `Diagram` re-renders through the existing theme-keyed mermaid cache.

## Open Questions

None. The language, the 57-component set, `#ui` as the sole injection point, the draft-only action boundary and the confinement roots are fixed above.

## Out of Scope

- The ` ```app ` / ` ```visual ` escape hatch — that is draft [spec 292](./0292-harness-inline-html-visuals.md), unchanged by this spec.
- Network of any kind from a spec: no image search, no geocoding, no map tiles, no `https` images. `Map`, `ImageSearch`, `Gallery`, `Hotspots`, `Image`, `Entity` are **not** in the catalog.
- Widgets (Timer, Quiz, Flashcards, Walkthrough), Media, and the Evidence group (Acceptance, Compare, Transcript, Provenance).
- Sending a message, running a tool, or writing a file from a control. Drafts only.
- Rendering while the reply streams; partial-prefix compilation. The §Streaming strip is a text place-holder, not a render: nothing is compiled or mounted before `seal()`.
- Polling anything on a timer, in a row or in a panel.
- Persisting panel state across Harness close or app restart.
- Any standing instruction, policy line, or permanently registered tool teaching the fence. `#ui` is the only path.

## Delivery phases

| Phase | Contents | Done when |
|---|---|---|
| 1 | Language core, catalog, panel rework, Layout/Content/Data/Inputs/Form — **40 components** (Data minus the file-backed `Snippet`), the generated `#ui` prompt | A lane writes a spec with a slider, a conditional and a chart; the panel recomputes one node per input; `npm run check`, Vitest, `cargo clippy` clean |
| 2 | `read_ui_data`, `Load`, parsers, report readers, `Snippet` + Dev + Project — **12 components** | A lane runs vitest to a JSON file and the panel shows the failures from that file, with the file unreadable from outside the roots |
| 3 | Manage (5), `specToMarkdown`, gallery examples, docs | Every catalog entry has an example that compiles and evaluates in CI; Live Assist shows the markdown rendering |

## Resources

- `/Users/wk/Source/bb-plugin-genui` — the reference implementation: `core/catalog.ts` (86 components), `core/validate.ts`, `core/evaluate.ts`, `core/data.ts`, `data-source.ts`, `instructions.ts`, `ui/AppBlock.tsx`, `docs/architecture.md`. Apache-2.0; the language shape and limit values are taken from it, no code is copied.
- [BB Gen UI marketplace listing](https://getbb.app/marketplace/genui) — the stated cost (~4,000 tokens), network surface and BB-coupling fragility.
- [spec 301](./0301-harness-ui-components.md) / [302](./0302-harness-component-catalog.md) — the kernel contract every catalog renderer implements.
- [spec 289](./0289-lane-context-delta.md) — the standing-policy budget this design must not spend.
