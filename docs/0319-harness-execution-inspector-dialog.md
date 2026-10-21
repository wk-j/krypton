# Harness Execution Inspector Dialog — Implementation Spec

> Status: Implemented — 2026-10-21 (real-app check by the user pending; see Verification)
> Date: 2026-10-21
> Milestone: ACP Harness — execution observability
> Amends: [315](./0315-harness-execution-inspector.md) §Solution, §UI/keyboard/rendering, §Ownership and data flow. Recognition, normalization, status precedence, bounds and retention from 315 are unchanged.

## Problem

The spec 315 Inspector opens inline under the execution card, inside the transcript. It is one flat strip: a legend line, a `Code` toggle, `Copy`, an `Output` label, `Formatted`/`Raw`, and an `Activity` list. None of these is a titled section, there is no summary of status, runtime or exit code, and code and output share a 320px-tall area squeezed into the transcript column. The user wants the Inspector to open as a modal dialog with clearly organized sections.

## Solution

Replace the movable inline `ExecutionPanel` with one view-owned **`ExecutionDialog`**, an `OverlayShell` overlay mounted once in the Harness body like the image viewer and the review-thread dialog. The dialog has a fixed layout: a head (identity), a **summary** (status, runtime, exit code, background job), a **tab list** with three sections (`Code`, `Output`, `Activity`), one scrollable section body at full dialog height, and a key-hint foot. While open it owns the keyboard, like the image viewer. Opening it never touches the transcript row, so the 315 inline-panel exception in AGENTS.md constraint 10 is removed for the Inspector.

## Research

- **Current ownership** (`acp-harness-view.ts:9817-9864`): `openExecution()` captures a scroll anchor, seats `executionPanel.el` in `ExecutionCard`'s slot through `ToolRow.mountExecutionPanel()`, then restores the anchor and calls `revealInlinePanel()`. `syncExecutionMount()` re-seats the node after each transcript commit and closes the panel when the row leaves the mounted window. A modal needs none of this: no slot, no anchor, no reveal, and no dependency on the row being mounted.
- **Overlay prior art in the Harness.** `OverlayShell` (spec 302 §2.2) owns `hidden` and a single-open registry: opening one shell closes the others and notifies the owner through `onAutoClose`. `ReviewThreadDialog` (spec 302 §7.16) is a centered shell (`position:absolute; inset:0; display:grid; place-items:center`, scrim `rgba(0,0,0,0.72)`, panel `rgba(var(--krypton-bg-rgb),0.94)`, 1px border, radius token, no blur). `ImageViewer` (spec 281) opens from a transcript `f` hint, owns every key while open (`onKeyDown` line 4286), and closes on lane switch.
- **Live timer.** `tickToolTimers()` (`acp-harness-view.ts:13614`) queries `.acp-harness__tool-timer` only under `.acp-harness__dashboard`. Overlays are siblings of the dashboard inside `.acp-harness__body` (`:6193-6220`), so a timer node in the dialog would not tick unless the query root becomes the body.
- **Timing logic** for "runtime" vs "observed" provenance lives privately in `ExecutionCard.paintTimer()`. The summary needs the same answer, so it moves to a pure helper in `harness-execution.ts`, and both components use it.
- **Key return contract.** `input-router.ts:622` calls `preventDefault()` only when the content view returns `true`. The dialog returns `false` for Meta/Ctrl chords so native `Cmd+C` on selected output keeps working, which the image viewer does not need.
- **Alternatives ruled out.** (a) A modal holding all three sections stacked in one scroll: long source pushes Output below the fold, and the jump keys end up behaving like tabs anyway. (b) Two columns, Code | Output, with Activity below: this repeats the cramped split of 315 and fails for long lines below 900px. (c) Keeping the panel inline and adding headings: it does not meet the request for a modal.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Chrome DevTools — Network | Selecting a request opens a details pane with tabs (Headers, Payload, Preview, Response, Initiator, Timing). **Preview** is formatted and **Response** is raw. Only one tab is visible at a time. | Matches: one subject, tabbed sections, Formatted/Raw split. |
| WAI-ARIA APG — Dialog (Modal) | `role=dialog`, `aria-modal=true`, a visible title for `aria-labelledby`, Tab/Shift+Tab wrap inside the dialog, and Escape closes. Use `aria-modal` only when the outside is both inert and visually obscured. | Followed exactly. Background is a solid scrim and keys are owned by the dialog. |
| WAI-ARIA APG — Tabs | `tablist`/`tab`/`tabpanel`, `aria-selected` and `aria-controls`. ←/→ move between tabs with automatic activation when panels are preloaded. A panel without focusable content gets `tabindex=0`. | Followed. Panels are already in the DOM, so activation is automatic. |
| Krypton image viewer (spec 281) | Overlay opened by a transcript `f` hint. Owns every key while open, Esc closes, closes on lane switch. | Same open path, key ownership and teardown. |

**Krypton delta** — single-key section switching (`1`–`3`), `c`/`r` actions and `j`/`k` scrolling, because the dialog owns the keyboard. The section the user last chose is kept between opens, as DevTools does. There are no execution controls.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/components/execution-dialog/` (new: `index.ts`, `execution-dialog.css`, `execution-dialog.test.ts`) | `ExecutionDialog` on `OverlayShell`: head, summary, tabs, section bodies, foot, key handling, focus trap. |
| `src/acp/components/execution-panel/` | Deleted (clean cutover). The source-highlight, output-append and view rendering code moves into the dialog unchanged. |
| `src/acp/components/execution-card/` | Remove `slot`/`mountPanel()`. Inspector button gets `aria-haspopup="dialog"` instead of `aria-expanded`. Export `paintExecutionTiming()`, which the card and the dialog both use to write time and provenance. |
| `src/acp/components/tool-row/index.ts` | Remove `mountExecutionPanel()`. |
| `src/acp/harness-execution.ts` | Export `EXECUTION_STATE_LABEL`, `isExecutionLive()` and `executionTiming()` (moved from the card). |
| `src/acp/acp-harness-view.ts` | Mount the dialog in the body. Simplify `openExecution()` and rename `syncExecutionMount()` → `syncExecutionDialog()`. Route keys like the image viewer. `tickToolTimers()` scans the Harness root. |
| `src/acp/components/registry.ts` | `executionPanel` → `executionDialog`. |
| `src/acp/components/execution-integration.test.ts`, `execution-card.test.ts` | Adjust to dialog ownership (see Verification). |
| `AGENTS.md` constraint 10, `docs/0002`, `0004`, `0005`, `0072`, `0301`, `0302`, `0315` (status note), `docs/README.md` | Replace "inline panel / card slot" with the dialog contract and index spec 319. |

## Design

### Data structures

```ts
// harness-execution.ts
export const EXECUTION_STATE_LABEL: Readonly<Record<ExecutionState, string>>;
export function isExecutionLive(payload: ExecutionPayload, state: ExecutionState): boolean;
export interface ExecutionTiming {
  readonly visible: boolean;
  readonly live: boolean;                    // ticking via shared ticker
  readonly durationMs: number;               // frozen value when !live
  readonly source: 'runtime' | 'observed';
}
export function executionTiming(payload: ExecutionPayload, status: string,
  startedAt?: number, endedAt?: number): ExecutionTiming;

// components/execution-card
export function paintExecutionTiming(timer: HTMLElement, source: HTMLElement,
  timing: ExecutionTiming, startedAt?: number, endedAt?: number): void;

// components/execution-dialog
export type ExecutionSection = 'code' | 'output' | 'activity';
export interface ExecutionDialogProps {
  readonly open: boolean;
  readonly targetId: string | null;          // item id; a new target resets per-target state
  readonly payload: ExecutionPayload | null;
  readonly status: string;                   // ACP tool-call status
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly takeFocus: boolean;
  onClose(restoreFocus: boolean): void;
}
```

`ExecutionDialog` exposes `isOpen`, `handleKey(event): boolean` and `close(restoreFocus)`. It passes its own `close(false)` to the shell's `onAutoClose`, so another overlay opening reaches the owner as `onClose(false)`; there is no separate auto-close prop. The selected `ExecutionSection` is instance state. It starts as `output` and survives close/reopen for the dialog's lifetime. Output mode (Formatted/Raw), output nodes and scroll positions reset on close or on a new `targetId`.

### UI

```
┌ .acp-harness__execution-overlay (scrim; click outside panel closes) ───────────┐
│ ┌ .acp-execution-dialog__panel [role=dialog aria-modal aria-labelledby] ─────┐ │
│ │ head:    ◐ Python  Krypton spec timeline                     [Close · Esc] │ │
│ │ summary: Status Done · Time 4.1s runtime · Exit code 0                     │ │
│ │ tabs:    [1 Code · 14 lines] [2 Output · 5 lines] [3 Activity · 2]         │ │
│ │ section: (one tabpanel, fills remaining height, scrolls)                   │ │
│ │   Code      toolbar [Copy code · c] · notice · numbered highlighted source │ │
│ │   Output    toolbar [Formatted|Raw · r] (only with views) · notice · output│ │
│ │   Activity  ordered phase/log list, latest phase emphasized · notice       │ │
│ │ feedback (role=status) · foot KeyHintBar                                   │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Panel size**: `width: min(1120px, 100%)`, `height: min(820px, 100%)`. Overlay padding is `clamp(8px, 2.5%, 24px)`. Head, summary, tabs and foot are fixed. Only the section body scrolls, and `pre` blocks scroll horizontally inside it. The Output bar is hidden, taking no row, when there are no table/JSON views.
- **Summary** is a `<dl>` row that wraps when narrow:
  - **Status** uses `EXECUTION_STATE_LABEL` (`Background · last reported` carries `Job <id> · <state>`).
  - **Time** comes from `executionTiming()`. A live value is a `.acp-harness__tool-timer[data-started-at]` node. The source word is `runtime` or `observed`, and the field is hidden when `visible` is false. A closed dialog freezes its timer node so the ticker skips it.
  - **Exit code** appears only when non-null.
  - No field shows a synthetic zero.
- **Tab labels**:
  - `Code · N lines`.
  - `Output · N lines`, or `Output` alone when output is null or empty.
  - `Activity · N`.
  - All three tabs always exist, so `1`–`3` never renumber. An empty Activity section says `No activity reported.`
- **Section bodies** reuse the 315 rendering rules verbatim: highlight only on source change, `acp-execution-dialog__syntax-*` classes, append-preserving output, follow only when at bottom, and a rich view only for unambiguous spans.
- **Visual**: the scrim and panel treatment of `ReviewThreadDialog`, with a 1px border in `--acp-execution-accent` falling back to `--krypton-window-accent`. Head and summary use 315's typography and color contract, and controls keep the quiet 315 button style. The selected tab is accent text plus a full 1px low-alpha border. There is no underline-only or two-side border, no blur, no shadow, and no animation. The stacking order is the same as the review-thread overlay.
- **CSS** lives in `krypton.component`, gated on the blocks `acp-harness__execution-overlay` and `acp-execution-dialog`, with component-scoped `[hidden] { display: none }`.

### Keyboard

| Key | Context | Action |
|-----|---------|--------|
| `f` + label / click `Inspector` | Transcript | Open the dialog for that item and focus the selected tab |
| `1` / `2` / `3` | Dialog | Select Code / Output / Activity |
| `←` / `→` | Tab focused | Previous / next tab (wraps, automatic activation) |
| `j` / `k`, `g` / `G` | Dialog | Scroll the section 60px down/up; top/bottom |
| `c` | Dialog | Copy retained source (`Copy shown code` when truncated) |
| `r` | Dialog, output has views | Toggle Formatted / Raw |
| `Tab` / `Shift+Tab` | Dialog | Cycle tabbables inside the panel (wraps) |
| `Enter` / `Space` | Focused button | Activate |
| `Esc` | Dialog | Close and return focus to the composer |
| `Cmd`/`Ctrl` chords | Dialog | Not consumed (`handleKey` returns `false`), so native copy works |

Every other key is consumed while the dialog is open. The `pointerdown` focus fix for WKWebView buttons from 315 is kept.

### Data flow

```
1. Click [data-execution-inspector] or an f-hint target → openExecution(itemId)
2. View checks: active lane, item in lane.transcript, item.tool.execution present
   (the row does not need to be mounted). Stores executionOpen = { laneId, itemId }.
3. executionDialog.update({ open: true, payload, status, startedAt, endedAt,
   takeFocus: true, … }) → OverlayShell closes any other open shell
4. Each transcript commit → syncExecutionDialog():
   lane changed, or item no longer in lane.transcript → close(false)
   otherwise → update props from the item (payload identity unchanged → no repaint)
5. tickToolTimers() (Harness-root scoped) advances the summary time while the call is active
6. Esc / Close / scrim click → close(true) → executionOpen = null, focus composer
   Lane switch, reset, restart, hidden tab, view dispose → close(false)
```

The transcript row is never written to by opening, updating or closing the dialog. Hint labels are still patched only through `ExecutionCard.setHint()`.

### AGENTS.md constraint 10

The bullet becomes: "The named inline-panel exception is GenUI (spec 310)…". A separate line says the Execution Inspector (spec 319) is a view-owned modal overlay that never writes row DOM, and execution summary updates go through the owning `ExecutionCard`.

## Edge Cases

- **Item leaves the mounted tail window but stays in `lane.transcript`**: the dialog stays open, because it no longer depends on the row.
- **Item evicted by the 300 cap**: close without taking focus.
- **Another overlay opens** (help, memory, image viewer): `OverlayShell` hides the dialog and calls its `close(false)`, so `onClose(false)` clears `executionOpen`. Focus belongs to the new overlay.
- **Live output while the user selects or scrolls output**: same preservation as 315. `j`/`k` scrolling clears follow until the user is back at the bottom.
- **Error state**: the Status reads `Error`, and the dialog keeps the last section the user chose; it does not jump to Output on its own.
- **Concurrent calls**: one dialog. Opening another item replaces the payload, with no stale output nodes, because `release()` runs on target change.
- **Terminal-only replay**: runtime is hidden, not zero.
- **Background snapshot**: static `Background · last reported`, no ticking.

## Verification

1. `npm run check`, the dialog/card/integration/CSS-ownership suites and the full ACP test directory.
2. Tests for consumer-visible behavior:
   - the open path and focus;
   - the item and sibling rows show zero DOM mutations while the dialog opens, updates and closes;
   - snapshot replacement stays inside the dialog;
   - the section key/click/ARIA state and section persistence across reopen;
   - focus wrap, Esc focus return, and Meta chords not consumed;
   - close on lane switch, hidden tab and eviction, but not on tail-window shift;
   - the summary timing provenance.
3. Browser smoke with the real `AcpClient` → `AcpHarnessView` → components and captured OMP frames:
   - 390/900/1440 widths;
   - `krypton-dark`, `krypton-light` and `legacy-radiance`;
   - live timer tick, then a static summary after seal;
   - no idle DOM writes.
   - Then the user checks the real app UI with an `eval` call.

### Implementation smoke — 2026-10-21

- `npm run check` passes. `npx vitest run src/acp`: 155 files, 2039 tests pass, including the dialog (14), card, integration and CSS-ownership suites.
- Chromium, real `AcpHarnessView` → components. Throwaway page: Tauri IPC stubbed, themes resolved by the Rust `ThemeEngine` and applied through `themeCssProperties()`. Fixture OMP frames covered Python live → complete, JS `console.table` with a table view, and JS failure.
  - **Default open**: Output tab focused; overlay not inside any row.
  - **Live state**: `Time` ticked as `observed` while running. After completion while open it froze at `4.1s runtime`. The latest phase was emphasized; the sibling row had 0 mutations.
  - **Error**: Status `Error`, Exit code 1, red output.
  - **Close**: Esc returned focus to the Harness root. The closed overlay computes `display: none` and has no live timer node.
  - **Widths and themes**: at 390 px the panel spans 10–380 px with no document overflow. Checked `krypton-dark` and `krypton-light`.
  - **Computed checks**: `backdrop-filter: none`; hidden facts/panels compute `display: none`; the only infinite animation is the composer caret.
- Not exercised: `legacy-radiance`, the 900 px width, native WKWebView, and the packaged app. The user's real-app check covers the last two.
- Fix carried over from 315: numeric table cells now right-align. The old `[data-numeric='true']` selector never matched the bare `data-numeric` attribute that `el()` writes.

## Open Questions

None.

## Out of Scope

Stepping between executions inside the dialog (`n`/`p`), editable or rerunnable code, new execution data, persistence of section choice across app restarts, and changes to the GenUI inline panel.

## Resources

- [WAI-ARIA APG — Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) — roles, focus wrap, Escape, when `aria-modal` is honest.
- [WAI-ARIA APG — Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) — tab roles, arrow keys, automatic activation, `tabindex=0` panels.
- [Chrome DevTools — Network features reference](https://developer.chrome.com/docs/devtools/network/reference) — per-request tabbed details, Preview vs Response.
- Internal: spec 315, spec 302 §2.2 `OverlayShell`, §7.14 `ImageViewer`, §7.16 `ReviewThreadDialog`; `input-router.ts:622` key return contract.
