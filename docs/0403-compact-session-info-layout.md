# Compact Session Info Layout — Implementation Spec

> Status: Implemented
> Date: 2026-11-15
> Milestone: ACP Harness — Session Info
> Builds on: 0401, 0402
> Approval: user approved HTML artifact `art-122-2bd86550` with “Ok, let implment”.

## Problem

The single-column label/value rows consume too much vertical space. The earlier sketch also mixed column widths and alignment. The user requires all Session Info data to remain visible without reducing font sizes or folding details.

## Solution

Use the approved artifact's shared two-column grid in every facts section. Labels sit above their values; long fields span both columns. Compact padding and paired fields replace the fixed 100px label column. Keep the existing theme tokens, icons, font sizes, keyboard behavior, and primitive snapshot update path.

## Research and Prior Art

- The production component already owns stable fact nodes and primitive `readDeps()`; layout requires no new view state, IPC, observers, or timers.
- The dock supplies inherited body font size and line-height, scrolling, and pane visibility. The component must retain its component-layer `[hidden]` rule.
- The previous `paintOptional()` hid missing fields and zero activity counts. The approved all-data preview instead retains every field: missing values use `—`, known zero counts remain `0`.
- The original Session Info research and VS Code/Zed comparisons remain in spec 401. This change is purely internal presentation, not a new session-data capability.
- Visual reference: approved HTML artifact `art-122-2bd86550`, preserving its aligned columns, not its hard-coded colors or fixture values.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/components/session-info/index.ts` | Reorder fields, mark full-width facts, retain missing fields, combine lane identity and status in one header. |
| `src/acp/components/session-info/session-info.css` | Shared two-column layout, compact context well and spacing, wrapping without font reduction. |
| `src/acp/components/session-info/session-info.test.ts` | Update missing-data contract and cover zero values and lane-switch clearing. |
| `docs/0401-harness-session-info-panel.md`, `docs/0402-harness-session-mcp-connection.md`, `docs/README.md` | Document and index the revised presentation. |

## Design

- Header: existing Session icon, full active lane name, status lamp. The dock tab already identifies Session; do not repeat a separate Session title row.
- Context: keep the percentage, token readout, accessible meter, and existing percentage/body sizes. Put the meter and readout in one compact well; allow the readout to wrap when needed.
- Every facts well: `repeat(2, minmax(0, 1fr))`, 16px column gap, 10px horizontal padding, 4px vertical field padding. Labels above values, all left-aligned.
- Details: Project / Backend, Model / Effort, then full-width Session ID.
- MCP: full-width Server and Contact; Initialize / Tools/list; Tools/call / Last method; full-width Last contact. Keep the historical-request warning visible.
- Usage: Cache hit / Turn input; Cache read / Cache write; Input / Output; full-width Cost.
- Activity: Tool calls / Transcript rows; Permissions / Questions; full-width Turn flags and Error.
- Keep all 25 fact fields visible. Missing Project, usage, MCP method/time, flags, and error show `—`; preserve `Pending` for an unassigned session and `Unknown` for missing model/effort. Known activity counters show `0` rather than disappearing.
- Long text wraps and stays selectable. No ellipsis, fixed field heights, disclosure controls, three-column rows, font-size breakpoint, or scaling transform.
- No API, `SessionInfoProps`, source-data conversion, keybinding, persistence, or transcript-rendering changes.

## Edge Cases

- Switching to a lane with missing data clears the previous lane's values without removing grid cells.
- At 280px and 352px host widths, both columns share the same positions in every section. Larger configured fonts wrap rather than shrink or clip.
- Only the selected dock pane is visible. Tab cycling and focus rescue remain owned by `HarnessDock`.
- Long identifiers, model names, methods, flags, and errors wrap within their cell; the UUID is never shortened.

## Verification

Run the focused component/dock/view tests and stylesheet ownership checks once, plus TypeScript checking. Mount production `SessionInfo` and `HarnessDock` with the real shell/material/reset styles in a temporary browser fixture. Verify dark/light, 280px/352px, increased body font, all fields visible, equal column starts, no horizontal overflow, and Session → Rails → Session visibility. Delete the fixture after verification.

Implementation verification: 383 tests passed across the focused Session Info, HarnessDock, harness-view, and stylesheet-ownership files; `npm run check` passed. A temporary browser fixture mounted production `SessionInfo` and `HarnessDock` with `src/styles/index.css`. All eight combinations of 280px/352px width, 13px/20px body font, and dark/light schemes passed: all 25 fact fields visible, matching column starts across sections, unchanged 11px chrome labels, no clipped field/header/readout text, and no pane/page horizontal overflow. Screenshots were inspected for the default dark layout and narrow light layouts, including long text with the larger font. Missing-data updates cleared old values while retaining fields and zero counters. Rails selection computed Session as `display: none`; `[` returned to visible Session through the production dock key handler. This is component-host verification, not a full native Tauri run.

## Open Questions

None; all-data visibility and unchanged fonts are explicit user requirements.

## Out of Scope

New telemetry, live MCP liveness, collapsible sections, font settings, dock width changes, and changes to sealed transcript rows.

## Resources

N/A — purely internal layout change. Local references: `DESIGN.md`, specs 401/402, and approved artifact `art-122-2bd86550`.
