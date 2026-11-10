# Tool Name Readouts — Implementation Spec

> Status: Implemented (approved and implemented 2026-11-11)
> Date: 2026-11-11
> Builds on: [302](./0302-harness-component-catalog.md), [366](./0366-console-faceplate-ui.md), [381](./0381-harness-component-gallery.md), DESIGN.md

## Problem

Before this change, tool names were flat ink while the composer’s `BYPASS` label was a compact recessed readout. The user asked for all tool-name labels to use that readout style, including the filesystem `write` label beside a diff.

## Solution

Apply the existing BYPASS readout material and compact typography to every existing standalone tool-name/operation label. Keep the tool’s identity, existing kind colors, status meaning, subject, output, timing and interactions intact. This changes the label only, never the whole row or output well.

## Research

- `composer-meta.css` defines the reference: inline-flex, center alignment, 6px gap, `1px 7px` padding, material radius (8px fallback), `--mat-well` and `--mat-well-shadow`. Its type inherits the composer chrome’s `0.72em` body scale and meta run’s uppercase / `0.08em` tracking.
- `ToolRow` uses `Chip` with a leading `Spinner` node styled as a status LED. One `.acp-harness__tool-kind` recipe covers generic tool kinds, including agents/wait. Specialized execution and Guardian cards do not paint this generic tool-name label.
- Before implementation, `FsActivityRow` painted a separate emoji icon and verb, and `FsWriteReviewRow` printed `✏️ write`. Both are separate production renderers, so changing only `ToolRow` would have missed the user’s third arrow.
- `PermissionHead` has a standalone `.acp-harness__perm-tool` only when the tool name differs from its subject. Its decision label is not a tool name.
- Before implementation, the embedded `AgentView` had `.agent-view__tool-name`, a separate header LED, and a spinner/result glyph updated by existing selectors. The name now owns the readout and LED; those status-update selectors remain intact.
- Live Assist projects a source label plus plain transcript text; it has no separate tool-name element to restyle. Tool references and command prose are not execution labels.
- DESIGN.md previously required flat transcript labels and forbade gradients/shadows on repeated rows. This spec introduces a named exception for the small tool-name readout only; rows, subjects, output lines and all other transcript labels remain flat.

## Prior Art

The requested reference is Krypton’s existing BYPASS readout, not a new external aesthetic. Spec 235 records Zed’s tool-kind label plus muted body and ripgrep/bat’s separation of structure from content. This change keeps that separation but uses Krypton’s existing instrument readout for tool identity. No new upstream tool API or external visual recipe is needed.

## Scope and Rendering

| Surface | Target | Behavior |
| --- | --- | --- |
| Harness generic tools | `.acp-harness__tool-kind` | Recessed readout around the existing LED and tool kind, for every kind including unknown kinds; keep current kind ink and status mapping |
| Filesystem activity | `.acp-harness__fs-activity-verb` | Recessed verb with a 6px LED inside; remove the separate emoji icon; preserve read/wrote/failed text, paths and errors |
| Gated write review | `.acp-harness__fs-review-verb` | Recessed `WRITE` with a 6px LED inside instead of the pencil emoji; keep diff and resolution/actions untouched |
| Permission request | `.acp-harness__perm-tool` | Same readout material and typography when this existing tool tag is present; keep duplicate-name suppression and decision labels intact |
| Embedded Agent view | `.agent-view__tool-name` | Same readout material and typography; move the existing header LED into the name readout via its pseudo-element; preserve name text and all status-update selectors |
| Harness gallery | Production rows above | No gallery-only rendering fork; existing examples inherit production changes |

Generic execution-card language names, Guardian outcomes, permission decisions and source-gutter labels (`TOOL`, `WRITE`, `GUARD`, etc.) are not tool names and do not acquire a readout. The user’s `write` arrow targets the inner operation label, not the source gutter.

## Design

### Shared Visual Recipe

Reuse existing material tokens in each owning BEM stylesheet; do not borrow composer classes or introduce a new rendering abstraction:

```css
display: inline-flex;
flex: none;
align-items: center;
gap: 6px;
padding: 1px 7px;
border: 0;
border-radius: var(--krypton-border-radius, 8px);
background: var(--mat-well);
box-shadow: var(--mat-well-shadow);
font-size: calc(var(--krypton-font-size, 13px) * 0.72);
letter-spacing: 0.08em;
text-transform: uppercase;
text-shadow: none;
white-space: nowrap;
```

Use the root body-size token rather than multiplying each local parent: filesystem heads already shrink locally, and applying another `0.72em` there would make their labels smaller than BYPASS. Preserve existing label ink instead of making every tool warning amber. Do not uppercase paths, commands, arguments or outputs.

This is an 8px readout well, not a 999px status capsule, raised button or colored outline. No click handler, focus target or `aria-pressed` state is added. Narrow layouts keep the readout intact; subjects retain their existing wrapping/ellipsis and timers remain non-shrinking. Remove the filesystem verb’s fixed 6ch width so the readout contains its full text.

A permission tool name can itself contain a path (for example, `Edit src/...`). Its readout is capped to the available width, with an inner ellipsizing text span and full text retained in DOM/title. The permission head opts out of grid min-content sizing (`min-width: 0`) so this cap works in narrow columns. This preserves the one-line readout without parsing or rewriting the canonical tool name.

### LEDs and State

- Generic tools retain the existing status LED node and mappings: pending/running amber, completed success without bloom, failed fault, canceled unlit.
- Filesystem activity derives its LED from the existing `ok`: success without bloom or fault on failure. The operation text continues to describe failure explicitly.
- Write review uses its existing `resolved`: pending amber, accepted success without bloom, rejected fault. A label-local state attribute is written during the existing paint; `resolved` is already a row dependency. Do not mutate a sealed row externally or recompute its diff to update the label.
- Permission requests do not gain another status indicator. When a real tool tag exists on a pending request, move its existing pending LED inside that tag. When the tool tag is suppressed, retain the existing pending head LED. Resolved decision LEDs stay with their decision labels; a separate tool-name readout does not duplicate them.
- Embedded Agent view retains its current running/done/error LED semantics. Move the LED recipe from the header pseudo-element to the name pseudo-element. The existing spinner/✓/✗ text node and selectors remain for updates and accessibility, but its visual cell is clipped so it does not add a second visible status mark beside the readout.

No new animation, timer, observer or backend state is introduced. At most one small inset readout is added per existing tool-name label; no whole-row or per-output-line effects.

### Contract Amendment

Update DESIGN.md’s repeated-row prohibition, Chips/Readouts parts and Harness surface description to name this bounded exception. Other transcript labels remain flat. Update specs 72, 235, 302 and 366 where they describe tool-name styling, and sweep those whole documents for the old claim before marking implementation complete. Historical changelog entries remain historical.

## Affected Files

| Files | Change |
| --- | --- |
| `src/acp/components/tool-row/tool-row.css` | Readout skin and typography; keep existing kind/status colors |
| `src/acp/components/fs-activity-row/{index.ts,fs-activity-row.css}` | Group verb/LED in the readout; remove obsolete emoji/icon styling |
| `src/acp/components/fs-write-review-row/{index.ts,fs-write-review-row.css}` | Write readout and resolved-state LED without changing diff ownership |
| `src/acp/components/permission-row/{index.ts,permission-row.css}` | Tool-tag readout and conditional placement of the existing pending LED |
| `src/styles/agent.css` | Name readout; relocate existing LED and clip redundant visible glyph cell |
| Existing tests for affected rows, only if needed | Keep behavioral/state/diff-identity assertions; delete obsolete wording or source-style pins rather than repinning them |
| `DESIGN.md`, `docs/{0072,0235,0302,0366}-*.md` | Named visual exception and current tool-label contract |
| `docs/README.md` | Index this spec |

No API, keybinding, configuration, adapter, permission-policy or upstream Pi event changes. The upstream tool lifecycle supplies tool names and completion/error state already; the view’s existing classes continue to carry them.

## Verification

Use the actual production gallery and embedded Agent tool-row rendering in a browser/runtime smoke. Compare readout geometry/materials with a production BYPASS chip at the same body size, in dark and light schemes. Cover every generic tool kind and pending/running/completed/failed/canceled states, filesystem read/write/failure, and write-review pending/accepted/rejected. Check permission requests with a visible tool tag, a suppressed duplicate tag, and resolved decisions: no duplicated lamp. Exercise narrow columns, long commands/paths and enlarged body fonts; output text, source grouping and timers must remain correct. Confirm resolve preserves the existing diff node and repeated terminal updates leave sealed row DOM untouched. No permanent screenshot/source-text tests.

### Verified implementation (2026-11-11)

- Browser smoke mounted production gallery rows and used the actual `AgentView.appendToolRowDom` / `finalizeToolRow` methods. All 54 readouts matched the production BYPASS material, padding, radius, gap, font size and tracking at 14px/24px body sizes in dark/light material schemes.
- Generic coverage included execute/read/edit/delete/move/search/fetch/think/other/agents/wait plus an unknown kind, and pending/in-progress/completed/failed/canceled states. Filesystem activity covered read/write/failure; write review covered pending/accepted/rejected.
- Ten permission decision/tag combinations retained exactly one LED. Visible pending tags own it; suppressed tags leave it at the head; resolved rows keep it only in the decision.
- Write-review accepted → rejected → pending updates preserved every diff node. Repeating each unchanged update produced zero observed DOM mutations. Agent running/done/error kept their existing glyph updates and one visible LED.
- At a 352px column and 14px/24px body sizes, name readouts fit, timers remained non-shrinking/nowrap, and whole headers stayed flat. Permission titles containing paths use the documented ellipsizing text span without losing DOM/title text.
- Targeted row, gallery and style-ownership tests passed; the final permission/style-ownership follow-up passed after the narrow-layout adjustment. `npm run check`, final permission-row LSP diagnostics and `DESIGN.md` lint passed. Obsolete emoji/markup snapshot assertions were removed instead of repinned.
- Verification used browser rendering and production methods, not a relaunched native Tauri window, live provider turn or live theme endpoint.

## Open Questions

None. Matching BYPASS means its readout material, geometry and compact typography, not replacing each tool’s identity/status colors with permission-warning amber.

## Out of Scope

- Restyling source gutters, permission decisions, Guardian outcomes, execution-language labels, subjects or output bodies.
- Parsing Live Assist’s plain transcript text into new tool-name nodes or changing its projection payload.
- Changing BYPASS itself, tool execution, permission behavior, adapters, keybindings or shortcut caps.
- Introducing a shared badge framework, new theme tokens or animation.

## Resources

- `src/acp/components/composer-meta/composer-meta.css` — the user-selected BYPASS readout recipe.
- `src/acp/components/{tool-row,fs-activity-row,fs-write-review-row,permission-row}/` — production operation-name renderers and state ownership.
- `src/agent/agent-view.ts`, `src/styles/agent.css` — embedded tool-name DOM and existing status selectors.
- `/Users/wk/Source/pi-mono/packages/agent/src/types.ts` — tool lifecycle events already carry `toolName` and terminal `isError`; no upstream change.
- `docs/0235-harness-tool-output-palette.md` — existing structure-versus-content prior-art comparison.
- DESIGN.md — material recipes and the flat-transcript rules this spec explicitly amends.
