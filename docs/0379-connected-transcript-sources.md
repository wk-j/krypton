# Connected Transcript Sources — Implementation Spec

> Status: Implemented (2026-11-10)
> Date: 2026-11-10
> Milestone: Krypton Console — transcript scanning
> Builds on: 301/302 (Harness components), 378 (Guardian row), DESIGN.md 2.3.3

## Problem

A run of tool calls repeats `TOOL` in every transcript row. The repeated label draws attention away from the actions and makes one uninterrupted source look like many separate blocks. The user wants one source label followed by a vertical connector through the later rows in that run.

## Solution

Keep every transcript item and its row component. Give groupable rows a stable source key, then use CSS sibling selectors to replace each *later* label with an etched groove in the existing label gutter. The first row keeps its label and starts the groove beneath it when a matching row follows. A different source or a non-groupable row ends the run. This avoids group wrappers, row reparenting, a collapse control, and layout measurement.

## Research

- `Transcript` calls one keyed `reconcile()` over direct child rows in the lane body. The reconciler preserves node identity and removes only rows outside the tail window. `rowFor(id)` and scroll anchors rely on those direct rows (`src/acp/components/transcript/index.ts`, `src/ui/list.ts`, `src/acp/acp-harness-view.ts`).
- `TranscriptRow` owns the label and wrapper. Its `readDeps()` already includes the rendered label, and `LiveComponent.seal()` is the live-to-static transition. A source key can be stamped during the row's normal paint without a separate update path. A later row must never patch the previous sealed row.
- The visible tail can start in the middle of a source run. CSS adjacency makes that first visible row show its label because its predecessor is no longer a sibling; no row DOM write is needed. The source label remains in `textContent` on continuation rows for selection and assistive technology; only its ink is transparent.
- `DESIGN.md` uses flat transcript rows, a 7.5ch label gutter, theme source ink, and no repeated-row shadows or gradients. The connector belongs inside the label gutter, not on the row's left edge as a selection rail. It reuses the faceplate's vertical etched-divider recipe: a 1px dark cut (`--mat-groove-lo`) beside a 1px light lip (`--mat-groove-hi`), softened together to 65% opacity. Labels retain source ink; the groove is neutral material, with no glow, gradient, shadow, animation, or click target.
- Live Assist already compacts consecutive internal activity into a summary (`groupLiveAssistTranscript`). Reusing that behavior here would hide individual actions, contrary to the requested connected transcript.
- CSS's next-sibling combinator matches only an immediately following sibling. Together with `:has(+ …)`, it identifies both the start and continuation of a run from stable source keys without a JavaScript grouping pass or new list hierarchy.

## Prior Art

| App | Behavior | Krypton choice |
|-----|----------|----------------|
| VS Code Chat | Compact and Conversation views group completed tool calls into expandable summaries; Verbose keeps tool calls expanded. | Keep every action visible and mark continuity in the gutter. |
| GitHub Actions logs | `::group::` nests log lines under one expandable title. | Keep the one-title scan cue without a collapse interaction. |
| Krypton Live Assist | Consecutive thought/tool/file activity becomes one compact activity block. | Keep the full Harness row detail and its existing keyboard navigation. |

## Affected Files

| File | Change |
|------|--------|
| `src/acp/components/transcript-row/shared.ts` | Pure `sourceConnectorKey(item)` for eligible row kinds. |
| `src/acp/components/transcript-row/index.ts` | Stamp `data-source-connector` during normal row paint. |
| `src/styles/harness-shared.css` | Adjacent-key selectors, transparent continuation label ink, and gutter line. |
| `src/acp/components/harness-integration.test.ts` | Verify keys, boundaries, row identity, and no previous-row mutation on append. |
| `DESIGN.md`, `docs/0302-harness-component-catalog.md`, `docs/0005-data-flow.md`, `docs/0366-console-faceplate-ui.md`, `docs/0378-codex-guardian-review-row.md` | Describe the connector's appearance and row lifecycle. |

## Design

### Source key

```ts
export type SourceConnectorKey = 'tool' | 'guard' | 'agent' | 'user' | 'fs';
export function sourceConnectorKey(item: HarnessTranscriptItem): SourceConnectorKey | null;
```

`tool` means a tool item with a `tool` payload but no `guardianReview`; `guard` means a tool item with that payload. `agent` is an assistant row without lane-mail provenance. `user` is a user row without steer or voice state. `fs` is a successful file-activity row with an `fsActivity` payload. Other kinds return `null`: thought has an effort meter; system notices use their source labels, typed system-command snapshots retain `SYS`, and shell fallback rows use `SH`; permission, question, file-write review, failed file activity, provider error, document cards, and lane mail keep their individual labels or direction/state cues. A `null` row breaks the run.

### Row and CSS flow

1. A row's normal paint sets or removes `data-source-connector` from the pure key after body paint. Assistant body paint can attach coordinator mail provenance to the item, so the key must see that final state. No tool payload, ACP event, or transcript model changes.
2. CSS matches each of the five exact `row[data-source-connector=X] + row[data-source-connector=X]` pairs and their `:has(+ …)` counterparts. The first row keeps its existing source label and color; if another matching row follows, its pseudo-element starts at `top: calc(5px + 1.36em)`, below the label strut with clearance for the tool head's baseline offset. Continuation labels stay in the DOM but paint transparent, with their groove starting 3px above the row to bridge the lane body's gap. Every segment ends at its row's bottom, at `left: calc(6px + 5.25ch)` inside the 7.5ch label track. Two 1px borders form the dark cut and light lip at 65% opacity. Existing groove tokens adapt to graphite or aluminium and custom themes; no source-colour connector variables remain. The groove does not cover the body or change row dimensions.
3. A different key, `null` row, hidden-rows indicator, or lane boundary breaks the line. When the tail window slides, the first remaining row automatically shows its label because it has no matching adjacent predecessor.
4. Appending a same-source row makes CSS connect the preceding row to it without mutating sealed row DOM or invoking row paint. A previously solitary row gains its under-label segment. At a tail-window boundary, CSS reveals the newly first visible row's label and starts its connector below it if the run continues. These are contextual style changes, not component repaints.

### Interaction and accessibility

No keybinding or focus target is added. The connector is `pointer-events: none`. Each continuation row keeps its source label text in the DOM and remains a separate transcript item for navigation, selection, hints, and assistive technology.

## Edge Cases and Verification

- Single rows retain their label and have no line. A run of two or more shows one label, a segment beneath that label, and a connected segment per subsequent row. A different source restarts the label.
- GUARD never joins TOOL despite sharing `item.kind === 'tool'`; a provider error never joins AGENT. Pending permission and question rows always show their labels.
- Long or wrapped tool bodies extend the connector through the first and continuation rows without measuring them. Narrow windows keep the existing 7.5ch gutter and body width.
- Tail-window clipping or `Ctrl+H` reveal gives the first visible row a label; list order and item identities remain unchanged.
- Test the pure source-key mapping, DOM order, append-only mutation boundary, and tail-window boundary. Run component style ownership, frontend type-check/build, and `git diff --check`. Inspect dark/light computed styles on a running app when available; source/tests alone cannot prove native line alignment.

## Implementation Verification

- `harness-integration.test.ts`: 16 tests passed, including matching-source continuation, GUARD/TOOL boundaries, tail clipping, lane-mail provenance, and a mutation observer on the preceding sealed row.
- Component style ownership and Guardian row suites: 10 tests passed.
- `npm run check`, `npm run build`, and `git diff --check` passed.
- Chromium smoke using production `ToolRow` components confirmed continuous etched segments at 11/13/18/24px in a narrow fixture under dark/light scheme selectors, distinct groove token colours in each scheme, all five source keys and their boundaries, singleton/tail clipping, and zero preceding-row DOM mutations on append. Computed width was 2px (two 1px borders), opacity 65%, with no shadow or background image. Both scheme fixtures were visually inspected. Integration and style-ownership suites passed (23 tests). Native WKWebView alignment has not been observed.
- The `DESIGN.md` linter is not installed locally. A no-install invocation produced no output and was stopped; design consistency was reviewed against the document directly.

## Open Questions

None.

## Out of Scope

- Collapsing or merging tool calls; changing the ACP model, Live Assist, or text-only projections.
- Connecting permission, question, failed file-activity, or provider-error rows, or adding an option to toggle grouping.
- Recoloring source labels or replacing the existing status LEDs.

## Resources

- [VS Code Chat view modes](https://code.visualstudio.com/updates/v1_145) — grouped and verbose tool-call presentations.
- [GitHub Actions log grouping](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands) — one title for a run of log lines.
- [Selectors Level 4, next-sibling combinator](https://www.w3.org/TR/selectors-4/#adjacent-sibling-combinators) — immediate sibling matching used by the connector.
