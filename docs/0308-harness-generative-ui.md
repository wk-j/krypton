# ACP Harness Generative UI — Implementation Spec

> Status: Superseded in part by [spec 309](./0309-harness-genui-catalog.md), [spec 310](./0310-harness-genui-inline-panel.md), and [spec 312](./0312-harness-genui-preflight-repair.md)
> Date: 2026-10-17
> Milestone: ACP Harness
> Scope: declarative, keyboard-driven UI in ACP assistant replies
>
> **Still current:** the host model — a validated fence becomes a static card in
> a sealed row, `f` + label opens one `GenUiPanel`, panel state is keyed
> `(lane, item, index, sourceHash)` in a 32-entry LRU, and an action can only
> load a visible composer draft.
>
> **Replaced by 309:** the `version 1` JSON wire format, the 9-node schema, the
> `add`/`multiply`/`formatNumber` expression set and the `draftButton` node.
> A v1 JSON fence is no longer accepted.
>
> **Replaced by 310:** the overlay host. The panel is no longer an
> `OverlayShell` over the dashboard; it is seated inline in the card inside the
> sealed row, so the reply it belongs to stays readable.
>
> **Replaced by 312 for explicit `#ui` turns:** reply text is staged and
> compiled before publication, with at most two repair attempts. The seal-time
> diagnostic fallback below still applies to fences in ordinary replies.

## Problem

The Harness can preview `svg` and `mermaid` fences, but an agent cannot present a small interactive calculation, chart, or choice without asking the user to read code or leave the conversation. BB's Gen UI shows the value of agent-composed controls, while Krypton's sealed transcript, keyboard routing, and Tauri webview require a different host design.

## Solution

Accept a versioned, data-only `krypton-ui` JSON fence in a sealed assistant reply. Replace a valid fence with a static, hintable card; `f` then its label (or a click) opens a focused `GenUiPanel` over the Harness dashboard. The panel renders a small allowlisted catalog with local reactive state and can load a generated follow-up into the owning lane's composer for the user to review and send. No agent-authored HTML or JavaScript runs, and no new Rust command, protocol message, file reader, or network access is required.

## Research

- [AssistantRow](../src/acp/components/assistant-row/index.ts) streams markdown into a parser-owned body, captures pure `markdownHtml` at seal, then decorates `svg`/`mermaid` fences. Decoration and hint updates must leave the cached HTML pure; a live control must not be placed in that body because it can be rebuilt or removed by the transcript tail window.
- [Transcript](../src/acp/components/transcript/index.ts) reconciles a tail window and disposes rows outside it. [OverlayShell](../src/acp/components/overlay-shell/index.ts) already provides one-at-a-time overlays, while the image viewer shows the `f` hint → focused viewer pattern. A panel owned by `AcpHarnessView`, outside the row, preserves interactive state without repainting a sealed transcript.
- [ACP prompt flow](./0072-acp-harness-view.md) routes submitted text starting `#` or `!` to commands. A generated action must therefore **load a visible draft**, never call `submitLanePrompt` or invoke an action directly. A nonempty draft is not overwritten.
- [Spec 292](./0292-harness-inline-html-visuals.md) is still a **draft** for a separate `visual` HTML fence; `src/acp/harness-html-visual.ts` is absent. The [Harness guide](./0072-acp-harness-view.md) formerly described it as present and is corrected alongside this spec. This spec neither implements nor supersedes spec 292.
- BB Gen UI uses an allowlisted declarative language, local input state, and message actions. Its parser is pure TypeScript, but its UI uses React and BB SDK surfaces; wholesale installation conflicts with Krypton's vanilla TypeScript constraint. Krypton v1 uses a smaller JSON schema and its own components rather than promising BB syntax compatibility.
- A2UI uses versioned declarative component catalogs. Its protocol and transport are broader than one local Harness fence, and its published versions are still evolving; v1 borrows the catalog boundary without claiming A2UI compliance.
- The main Tauri webview currently has `csp: null`. Agent HTML must never be inserted as executable DOM there. Data-only DOM construction with `textContent` and known attributes avoids a new iframe or IPC trust boundary.

### Alternatives considered

| Approach | Decision |
|---|---|
| Inline live controls inside `AssistantRow`, like BB | Reject: conflicts with sealed-row stability and tail-window disposal. **Reversed by [spec 310](./0310-harness-genui-inline-panel.md)** — the panel node stays owned by the view and is re-seated after each transcript commit, so neither hazard needs the row to own it. |
| Implement draft spec 292 first | Separate feature: arbitrary HTML needs iframe isolation, activation, and a performance budget; it does not provide trusted Krypton components or a controlled action path. |
| Port all 86 BB components and its expression language | Reject for v1: BB-specific project APIs, React renderers, and a much larger parser/evaluation surface. |
| Adopt full A2UI transport | Reject for v1: no ACP-side structured UI protocol is needed for a fenced reply. Revisit for cross-app interoperability. |

## Prior Art

| App | Implementation | Krypton consequence |
|---|---|---|
| BB Gen UI | Agent writes a `ui` fence; BB renders interactive chat cards. Inputs recompute locally; buttons/forms can send a message. | Keep local calculation, but use a static transcript card and an explicit composer draft handoff. |
| Claude Artifacts | A substantial generated tool opens in a dedicated surface beside the conversation; source can be viewed. | Use a focused in-app panel for interaction while the transcript remains stable. |
| Google A2UI | Agent supplies declarative component data from a renderer-approved catalog, with validation before rendering. | Use a versioned, allowlisted JSON tree; no agent code execution. |
| VS Code webviews | Extension content is urged to restrict local resources and use a CSP. | Avoid a new executable webview for data-only controls. |

**Krypton delta:** the transcript card is a durable pointer to a keyboard-controlled panel. The panel uses Krypton's theme tokens and native Harness components, so interaction cannot cause late transcript repaints or a second native window.

## Affected Files

| File | Change |
|---|---|
| `src/acp/genui/schema.ts`, `parse.ts`, `evaluate.ts`, tests | Validate version 1 JSON, bound tree/values, evaluate a small expression set, and expand draft templates. No `eval`/`Function`/HTML parser. |
| `src/acp/components/genui-card/` | Static fence card, stylesheet, scheme overrides, and component test; register in `components/registry.ts`. |
| `src/acp/components/genui-panel/` | `OverlayShell`-based renderer, keyboard handling, stylesheet, and component test; register in `components/registry.ts`. |
| `src/acp/components/assistant-row/index.ts` | Decorate valid sealed fences after `markdownHtml` capture, including cold row paints; detach card listeners on disposal. |
| `src/acp/harness-view-types.ts` | Add `UiFenceEntry` metadata to an assistant transcript item. |
| `src/acp/acp-harness-view.ts` | Extend `f` targets, own panel/state lifetime, route draft loading, and close on lane/reset/view transitions. |
| `src/acp/hash-commands.ts`, `harness-prompts.ts`, `components/help-overlay/`, `acp-harness-view.ts` | Add `#ui <request>` as a one-shot schema-guided request, including command discovery/help. Keep its prompt example checked by the parser tests. |
| `docs/0004-architecture.md`, `0005-data-flow.md`, `0072-acp-harness-view.md`, `README.md` | On implementation, document ownership, action routing, key use, and spec 292's separate draft status. |

## Design

### Wire format and validation

The fence's first info-string word is `krypton-ui`; other fences remain code. The body is one JSON object with `version: 1`, a nonempty `title`, and one `root` node. Unknown versions, node types, fields, or action types fail closed: leave the original code visible with a short, text-only error label. Validation runs after seal only; no partial UI is mounted during streaming.

```ts
type UiExpr = string | number | boolean
  | { state: string }
  | { op: 'add' | 'multiply'; args: UiExpr[] }
  | { op: 'formatNumber'; value: UiExpr; digits?: number };

type UiNode =
  | { type: 'card'; title: string; children: UiNode[] }
  | { type: 'row' | 'stack'; children: UiNode[] }
  | { type: 'text'; value: UiExpr }
  | { type: 'metric'; label: string; value: UiExpr }
  | { type: 'table'; columns: string[]; rows: UiExpr[][] }
  | { type: 'barChart'; labels: string[]; values: UiExpr[] }
  | { type: 'slider'; id: string; label: string; min: number; max: number; step: number; initial: number }
  | { type: 'choice'; id: string; label: string; options: string[]; initial: string }
  | { type: 'draftButton'; label: string; template: string };

interface UiSpecV1 { version: 1; title: string; root: UiNode }
interface UiFenceEntry { index: number; source: string; sourceHash: string; title: string; hintLabel: string | null; spec: UiSpecV1 }
```

`{state: id}` refers only to an `id` declared by one slider or choice in the same tree. IDs are unique. `add` and `multiply` take 2–8 finite numbers; `formatNumber` uses 0–2 digits. An expression tree has at most 64 nodes and depth 8. A `draftButton` expands only `{{id}}` placeholders for declared input IDs, in one nonrecursive pass, assigns the result as text, and limits the final draft to 4,000 characters. A chart requires equal-length labels/values and nonnegative finite values; table rows must match the column count. Each input has a visible label. Sliders require finite `min < max`, `step > 0`, and an in-range initial value; choices require 1–12 unique options and a listed initial value. Validation copies accepted fields into typed objects; parsed JSON objects and their prototype-related keys are never spread into DOM props or application state.

Hard caps: 16 KiB fence source, 2 candidate UI fences per assistant item, 80 nodes, depth 8, 10 inputs, 200 table cells, 40 bars, 120 characters per title/label/option, 2,000 characters per text value, and 32 retained panel states per Harness view. Later UI fences in the same item remain code. Parsing/evaluation is synchronous but bounded; exceeding any cap fails to code view. The validator rejects URL, path, style, HTML, script, image, and file-load fields. The renderer creates DOM with `el`/`textContent`, never with model text in `innerHTML`.

Example:

````markdown
```krypton-ui
{"version":1,"title":"Seat estimate","root":{"type":"card","title":"Monthly cost","children":[{"type":"slider","id":"seats","label":"Seats","min":1,"max":50,"step":1,"initial":10},{"type":"metric","label":"Total","value":{"op":"multiply","args":[{"state":"seats"},29]}},{"type":"draftButton","label":"Use this estimate","template":"Plan for {{seats}} seats at $29 each"}]}}
```
````

### Ownership and data flow

1. `#ui <request>` injects a one-turn schema example into the selected lane using the existing hash-command path. A normal agent reply may also contain a valid `krypton-ui` fence; rendering does not depend on how it was requested. The standing lane policy stays unchanged.
2. `AssistantRow` streams the fence as code. At `LiveComponent.seal()`, it caches pure markdown, scans `pre > code` in document order, validates at most two `krypton-ui` fences, and inserts static `GenUiCard` nodes. Cold rows repeat decoration from the cached source. No iframe or control is mounted in the transcript.
3. The card becomes an `f` open target only while its row is in the visible transcript window. `f` then label, or a card click, resolves `(lane.id, item.id, fence index, sourceHash)` and compares the current source with the entry before opening the panel; a stale target does nothing.
4. `AcpHarnessView` owns one `GenUiPanel` outside the transcript and a bounded state map keyed by that tuple. The panel uses `OverlayShell`, renders the validated tree, and recalculates dependent nodes on local input. State survives closing/reopening the panel and row remounts, but not lane reset/close or Harness close. *(Spec 310: the view still owns the one panel and the LRU, but the node is seated in the card's slot rather than in an `OverlayShell`.)*
5. A `draftButton` expands its template using current input state. If the owning lane is no longer active or its composer already has a nonempty draft, the panel displays a reason and leaves both unchanged. Otherwise it sets the lane draft, closes, and focuses the composer. **Only the user's later Enter submits**, through normal permission, queue, and command routing.

### Configuration and protocol

There is no new TOML key, Tauri IPC command, ACP message type, or persisted file format. The parser runs for every sealed assistant reply; only `#ui` injects the longer schema guidance, so ordinary turns pay no standing instruction cost. Remote ACP lanes can use the same fence because the payload is reply text and the panel requires no local file reads.

### Keyboard and UI

| Key | Context | Action |
|---|---|---|
| `#ui <request>` + Enter | Harness composer | Ask the active lane for a UI card with one-turn schema guidance. |
| `f` then hint label | Harness transcript | Open the card's panel. |
| `Tab` / `Shift+Tab` | Panel | Move among inputs and actions. |
| Arrows, `Space`, `Enter` | Focused slider/choice/button | Operate the control using native keyboard behavior. |
| `Escape` | Panel | Close and restore focus to the composer. |

The card shows title, `interactive UI`, and a compact summary (e.g. `chart · 2 inputs`), with a full 1px border and no animation. The panel is inside the existing native workspace window, covers only the Harness dashboard, leaves the composer visible, and owns focus while open *(spec 310: it covers nothing — it expands inside the card, and still owns focus while open)*. A labeled Source control in the panel reveals the exact JSON fence without executing it. Its components use `@layer krypton.component` and `@layer krypton.scheme`, existing theme tokens, and the style-ownership test. Chart bars are DOM/CSS with text labels and values; no new chart library, canvas loop, or network assets. Accessibility uses labeled native inputs, button elements, visible focus, and a dialog label; values remain readable without color.

Accent discipline, after the first pass gave every border `--krypton-accent` at full strength and a dense spec rendered as nested neon rectangles: structure (panel edge, head rule, card edge, table rules, chart track, source block) is a hairline or low-alpha tint derived from `--krypton-fg-rgb` / `--krypton-accent-rgb`, the scale `metrics-overlay` and `help-overlay` already use; saturated `--krypton-window-accent` is spent only on the title, metric values, chart fills, the primary draft action and the focus ring. The transcript card follows the `acp-harness__msg--artifact` document cards it sits among: accent tint, radius, and a filled hint badge that is hidden while unlabeled. Controls inherit the harness font (a native `select` otherwise falls back to the system UI font), a table's first column takes its content width so a key column cannot be squeezed to one character per line, and the draft button sizes to its label instead of stretching to the card width.

### Lifecycle and acceptance

- A sealed assistant row's markdown/body node identity and scroll position remain unchanged by panel input; no scheduler transcript invalidation occurs for a slider, choice, or draft action.
- Closing, switching lanes/workspaces, opening another overlay, resetting a lane, or disposing the Harness closes the panel and restores focus appropriately. State belonging to a deleted lane is discarded. A changed fence source hash starts fresh state.
- Invalid JSON, unknown components, broken references, nonfinite arithmetic, oversized trees, malformed tables/charts, and unsupported versions remain inspectable as source and never execute code.
- Tests cover validation limits and hostile strings, reactive calculations, keyboard-only operation, stale lane/item targets, nonempty composer drafts, tail-window remount, seal behavior, focus restoration, and theme updates. Run `npm run check`, targeted Vitest, and `npm run build`; manually smoke-test the native Tauri Harness for focus/scroll and keyboard behavior before calling the feature complete.

## Open Questions

None for v1. The exact catalog, activation surface, action boundary, and persistence lifetime are fixed above.

## Out of Scope

- BB `ui` syntax compatibility, the complete BB catalog, A2UI protocol compliance, and streamed partial UI rendering.
- Executable HTML/JS `visual` fences (draft spec 292), full-page artifacts, remote images, file loading, live tool reports, and extra Rust/ACP commands.
- Direct message sending, tool execution, writing files, or changing app configuration from a generated control.
- UI state persistence across Harness tab closure, app restart, or external control clients such as Live Assist.

## Resources

- [BB Generative UI plugin](https://github.com/ComicBit/bb-plugin-genui) — fenced specs, local interactions, component catalog, and BB-specific rendering constraints.
- [Claude Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) — dedicated interactive surface and keyboard-accessible artifact workflow.
- [A2UI project](https://github.com/a2ui-project/a2ui/blob/main/docs/public/index.md) — versioned declarative component catalogs and validation boundary.
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview) — limit webview capabilities and content sources.
- [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox) — constraints that would apply to the separate HTML-visual design.
