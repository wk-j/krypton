# Spec 204 — ACP Harness view file split

**Status:** implemented
**Scope:** pure module extraction from `src/acp/acp-harness-view.ts`. No behavior change, no interface change, no new state.

## Problem

`src/acp/acp-harness-view.ts` had grown to **16,020 lines** in one module. Roughly a quarter of that
(~3,900 lines) was not the view at all — it was module-private types, inline SVG symbol defs, markdown
plumbing, and a long tail of pure render/parse/format helpers sitting below the class. Reading or
reviewing any one concern meant paging past all the others, and every helper was reachable from every
other helper with no stated boundary.

## What this spec does

Extract **ten cohesive non-class concern groups** (listed below) into sibling modules. The
`AcpHarnessView` class itself is untouched — no method moved, no method signature changed, no state
relocated. Every extracted symbol kept its original body verbatim; the only edits were adding `export`,
adding the imports each new module needs, and re-exporting from `acp-harness-view.ts` so existing import
sites (tests included) keep working.

This is **not** "everything that is not the class". `acp-harness-view.ts` deliberately still owns the
class-adjacent top-level declarations above the class body — the leader-key table
(`ACP_HARNESS_LEADER_KEYS`), `LANE_DEFAULTS`, the view's own tuning constants
(`TRANSCRIPT_WINDOW_STEP`, `PROMPT_QUEUE_MAX`, `CANCEL_ESCALATION_MS`, `METRICS_POLL_MS`, …), the zen /
concise localStorage helpers, and the spec-180 orchestrator-console pure helpers
(`DISPATCH_PURPOSES`, `nextDispatchPurpose`, `dispatchDisabledReason`, `consolePermissionAction`,
`orchestratorInputHtml`, …). Those are the class's own vocabulary, not a separable concern.

### Modules

| Module | Lines | Owns |
|---|---|---|
| `harness-view-types.ts` | 605 | Lane / transcript / peek / ticket state shapes. Types only. |
| `lane-peek.ts` | 856 | Spec 109/118 peek rail: heat derivation, candidate ranking, peek card + composer peer strip. |
| `harness-tool-render.ts` | 626 | ToolCall inspection (label, command line, exit, raw output sections) + ToolPayload rendering incl. rich `git diff` / `git status`. |
| `harness-transcript-render.ts` | 603 | One transcript row → DOM: the dispatcher, per-kind bodies, render signature. |
| `harness-lane-chrome.ts` | 602 | Lane head/rail line, chip row, process-tree metrics, stats line, slash palette, status vocabulary. |
| `harness-permission-scan.ts` | 321 | Built-in harness-bus tool auto-allow decision, args preview, artifact/scratch path matching. |
| `harness-markdown.ts` | 313 | Shared `marked` instance, streaming-markdown parser plumbing, URL allowlist. |
| `harness-format.ts` | 197 | Leaf formatting/parsing primitives (path, time, count, `esc`). |
| `harness-lane-identity.ts` | 156 | Backend label / logo symbol id, directive role bucket, lane accent. |
| `harness-icons.ts` | 111 | Inline `<symbol>` defs (backend logos + lane-bar telemetry icons). |

`acp-harness-view.ts` is now **12,032 lines**, of which ~11,300 is the `AcpHarnessView` class itself
(685 → 12014). The file is now essentially "the class plus its imports".

### Dependency direction

Strictly one-way, no cycles:

```
harness-view-types ─┐
harness-format ─────┼─→ harness-tool-render ─┐
harness-icons ──────┤                        ├─→ harness-transcript-render ─┐
harness-lane-identity ─→ harness-lane-chrome ┤                              ├─→ acp-harness-view
harness-markdown ───┘                        └─→ lane-peek ─────────────────┘
harness-permission-scan ─────────────────────────────────────────────────────┘
```

`harness-format`, `harness-view-types`, `harness-icons`, and `harness-lane-identity` are leaves — they
import nothing from this family.

### Compatibility

`acp-harness-view.ts` re-exports every symbol that was public before the split, so `src/compositor.ts`,
`src/usage-view.ts`, `src/acp/index.ts`, `src/acp/harness-prompts.ts`, and all four test files that
import from it are unchanged. New code should prefer importing from the owning module directly.

## Deliberately NOT done

- **The class was not split.** Its ~330 methods lean on shared `this` state (`this.lanes`,
  `this.render()`, `this.appendTranscript()`) throughout, so pulling out sub-controllers
  (orchestrator console, built-in roles, review overlays, pickers, ticket/issue, control bridge,
  inter-lane bridge, artifacts — ~4,100 lines) needs a designed host interface, not a move. That is a
  separate spec, not a mechanical extraction.
- **No `noUnusedLocals`.** The repo does not enforce it (pre-existing dead imports live in
  `compositor.ts`, `acp-view.ts`, `extensions.ts`). It was run once to find imports this split made
  dead, and those were removed; the flag was not added to `tsconfig.json`.

## Incidental removal

`normalizeCwd()` (declared in the original file, never called and never exported) was dropped with the
block it sat in. Unreachable before and after.

## Verification

- `npm run check` (tsc --noEmit) — clean
- `npx vitest run` — 32 files / 526 tests pass (same as pre-split)
- `npm run build` — clean
- Declaration audit: every top-level `function`/`const`/`interface`/`type`/`class` and all 356 class
  methods from the pre-split file are still present, with `normalizeCwd` the single intentional exception.
