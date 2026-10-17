# Interactive Handoff Picker — Implementation Spec

> Status: Implemented
> Date: 2026-10-17
> Milestone: ACP Harness — handoff/resume
>
> Builds on: [293](0293-global-handoff-resume.md) (`#resume` forms, local ∪ Xenon merge),
> [301](0301-harness-ui-components.md) / [302](0302-harness-component-catalog.md) (component kernel,
> `OverlayShell` + `ListPicker`), [72](0072-acp-harness-view.md) (harness surfaces, key routing)
> Decisions kept: ADR-0022 (handoffs are the one resource pulled from Xenon, human-triggered only),
> ADR-0023 (a handoff belongs to a work thread, not a lane)
>
> **Reverses one line of spec 293.** `docs/0293-global-handoff-resume.md:177` lists "a picker
> overlay" under Out of Scope. That scoping was right while resume was being bootstrapped; it is
> what this spec revisits, and 293's Out of Scope line is edited to say so.

## Problem

`#resume list` is a dead end. It prints a static system transcript block of up to 10 rows
(`formatHandoffList`, `src/acp/xenon-push.ts:347-363`) and returns without touching the lane. To
actually resume, the user must read an opaque id out of that block (`ho-mv6qbxhh-85bcbb`), then type
`#resume <id>` by hand — a second command, a second ~5 s Xenon read, and a transcription step over
ids that differ only in their last six characters.

## Solution

`#resume list` opens a keyboard-driven overlay instead of printing text: `HandoffPicker`, built from
the existing `OverlayShell` + `ListPicker<MergedHandoff>` primitives, listing the same merged
local ∪ Xenon rows with a detail pane for the row under the cursor. `Enter` resumes the cursor row
through the resume tail that already exists (reserve → resolve → `handoff_bind` → inject). `Esc`/`q`
closes. `#resume` (newest) and `#resume <id>` are unchanged, so the zero-keystroke and scripted paths
stay exactly as they are.

## Research

- **The list and the action are already separate.** `resumeHandoff` (`acp-harness-view.ts:10638`)
  splits into (a) `collectHandoffs(lane)` → `{ merged, xenonCwd }` (`:10702`, ≈5 s Xenon budget,
  `src-tauri/src/xenon.rs:28 READ_TIMEOUT_SECS = 5`) and (b) reserve → `resolveHandoffDoc` →
  `handoff_bind` → `dispatchTurn(handoffResumePrompt(doc))` (`:10654-10693`). The picker needs (a) at
  open and (b) at `Enter`; only the reservation point moves.
- **`{ mode: 'id', reference }` already accepts an exact id.** `resolveHandoffDoc` (`:10733`) takes
  the request plus the merged rows, returns a `HandoffResumeDoc`, and fetches detail from Xenon when
  the winning copy is remote. The picker reuses it verbatim — no new resolution logic.
- **The overlay primitives are mature.** `OverlayShell` (`components/overlay-shell/index.ts:38`) owns
  a module-level single-open registry, so opening the picker auto-closes the memory drawer and fires
  its `onAutoClose`. `ListPicker<T>` (`components/list-picker/index.ts`) owns cursor math
  (`clampCursor`/`nextCursor`/`prevCursor`), the `--active` modifier and `scrollIntoView`. Six
  pickers already compose exactly this pair; `ModelPicker` is ~90 lines.
- **Components own no keys** (architecture constraint 1, restated in every picker header). `open` and
  `cursor` are props; `j`/`k`/`Enter`/`Esc` live in `acp-harness-view.ts`'s ordered key cascade
  (`:4185-4475`), which must claim the picker above the `Ctrl+N`/`Ctrl+P` lane switch at `:4333`.
- **The memory drawer is the near-miss, not the answer.** `⌘M` already lists handoffs with a cursor
  (`components/memory-drawer/index.ts`), but it is declared **read-only display**
  (`docs/0072:560`), it shows `HandoffEntry[]` from the local store only — no Xenon rows, no
  `source` column — and `Enter` is currently swallowed (`:13909-13931`). Wiring resume into it would
  turn an audit surface into an action surface and still leave `#resume list` printing text.
- **Alternatives ruled out.** (1) Keep the text block and add `#resume 3` positional picking —
  cheapest, but the positions are stale the moment an agent writes a handoff, and it still costs a
  second command. (2) Make the drawer actionable — see above. (3) Reuse `InlinePalette` in the
  composer — inline palettes complete text, they can't show a detail pane, and the rows need the
  ≈5 s Xenon read before the first paint.

## Prior Art

| App | Implementation | Notes |
|---|---|---|
| Claude Code `/resume`, `claude --resume` | Interactive picker: `↑`/`↓` or `k`/`j` navigate, `Enter` resumes, `1`–`9` resume by position, `Space` previews, `/` filters, `Ctrl+A`/`Ctrl+W` widen scope, `Esc` exits. `--continue` resumes newest with no picker | The "newest by default, pick if needed" split spec 293 already copied; this spec adopts the picker half |
| Codex CLI `codex resume` | Interactive session picker over `~/.codex/sessions`; the exit hint now reads "run `codex resume`, then select `<thread-name>`" rather than printing an id (openai/codex#41505). `Ctrl+P`/`Ctrl+N` navigation was requested in openai/codex#18179 | Confirms both the direction (don't make the human carry an id) and the Ctrl+N/P expectation |
| tmux `choose-tree` (`prefix s`) | Full-screen chooser; `j`/`k` or arrows, `Enter` attaches, `/` filters, `Ctrl+X` kills the highlighted entry | The j/k + Enter + Esc vocabulary Krypton's six pickers already use |
| Zellij session manager (`Ctrl+o w`) | Plugin overlay listing live and resurrectable sessions; arrows move, `Enter` attaches | Same shape, mouse-free |

**Krypton delta** — matches convention on `j`/`k`/arrows + `Enter` + `Esc`, and adds `Ctrl+N`/`Ctrl+P`
because the ticket picker and memory drawer already bind them. Deliberately diverges by **not**
taking `1`–`9` positional picks (a mistyped digit would bind the lane to a work thread and start an
agent turn — not reversible by `Esc`) and by **not** shipping type-to-filter in v1 (rows are capped
by the store at 50, and `#resume <id>` remains for a direct hit).

## Affected Files

| File | Change |
|---|---|
| `src/acp/components/handoff-picker/index.ts` | **New.** `HandoffPicker extends Component<HandoffPickerProps>` = `OverlayShell` + `ListPicker<MergedHandoff>` + detail pane; `def = { id: 'handoff-picker', blocks: ['acp-harness__handoff'] }` |
| `src/acp/components/handoff-picker/handoff-picker.css` | **New.** All rules inside `@layer krypton.component`, every selector gated on `acp-harness__handoff*`, plus `.acp-harness__handoff-picker[hidden] { display: none }` |
| `src/acp/components/handoff-picker/handoff-picker.test.ts` | **New.** Paint behaviour: rows, active modifier follows `cursor`, detail pane tracks the cursor, remote row shows the deferred-detail note, empty state, hidden when closed |
| `src/acp/components/registry.ts` | One import + one layer-7 entry |
| `src/acp/acp-harness-view.ts` | Picker state + open/close/key handler; `resumeHandoff` list branch opens the picker; resume tail extracted to `applyResume`; render in the `overlay` region; modal predicates; dispose |
| `src/acp/xenon-push.ts` | Delete `formatHandoffList` and its now-unreachable helpers `HANDOFF_LIST_LIMIT`, `HANDOFF_LIST_SUMMARY_CHARS`, `oneLine` — the picker truncates summaries with CSS, not by slicing text. `formatHandoffAge`, `mergeHandoffs` and `matchHandoffReference` all stay. (`collectHandoffs` itself lives in `acp-harness-view.ts`; its return gains `remote` for the live re-merge and `reason` for the picker's `note`.) |
| `src/acp/xenon-push.test.ts` | Delete the `formatHandoffList` describe block |
| `src/acp/hash-commands.ts` | `resume` description: `list` opens the picker |
| `src/acp/components/help-overlay/index.ts` | `#resume list` row + the picker's keys |
| `docs/0293-global-handoff-resume.md` | `#resume list` table row; Out of Scope drops "a picker overlay" and points here |
| `docs/0072-acp-harness-view.md` | Command table row, keybinding table rows, a picker paragraph beside the memory drawer section |
| `docs/0005-data-flow.md` | `#resume list` step in the `#handoff`/`#resume` flow (`:946-963`) |
| `docs/0302-harness-component-catalog.md` | New layer-7 row |
| `docs/README.md` | Spec index + count |

## Design

### Data Structures

```ts
// src/acp/components/handoff-picker/index.ts
export interface HandoffPickerProps {
  readonly open: boolean;
  readonly laneName: string | null;   // the lane the resume will run in
  readonly rows: readonly MergedHandoff[];
  readonly cursor: number;
  readonly boundId: string | null;    // handoff this lane is already bound to → `bound` marker
  readonly now: number;               // Date.now() from the caller, for formatHandoffAge
  readonly note: string | null;       // e.g. 'xenon unreachable - local handoffs only'
  onAutoClose?(): void;
}
```

```ts
// acp-harness-view.ts — picker state (one field, cleared on close)
private handoffPicker: {
  laneId: string;
  rows: MergedHandoff[];
  remote: RemoteHandoff[];          // snapshot, for re-merge on memory change
  xenonCwd: string | null;
  cursor: number;
  note: string | null;
} | null = null;
```

Row text reuses the existing vocabulary: `id · age · host · author · summary · source`
(`formatHandoffAge` stays). The detail pane shows `summary` then `detail`; a row whose winning copy
is remote (`detail === null`) shows `detail lives on xenon - fetched on resume`.

### API / Commands

No new Tauri command, no IPC change, no MCP tool. `collectHandoffs` widens its return:

```ts
private async collectHandoffs(lane: HarnessLane): Promise<{
  merged: MergedHandoff[]; remote: RemoteHandoff[]; xenonCwd: string | null;
}>
```

The resume tail is extracted unchanged except for one line:

```ts
private async applyResume(
  lane: HarnessLane,
  request: { mode: 'newest' } | { mode: 'id'; reference: string },
  precollected: { merged: MergedHandoff[]; xenonCwd: string | null } | null,
): Promise<void>
```

`precollected === null` keeps today's order — reserve, *then* read Xenon — so a typed `#resume` still
cannot lose its lane to peer mail mid-resolve. The picker passes its snapshot, so `Enter` reserves and
resolves without a second list read.

### Data Flow

```
1. User types #resume list in lane L (guards unchanged: memory store present, L idle/awaiting_peer).
2. collectHandoffs(L): refreshMemory() → local; xenon_handoff_list (≤5 s) → remote; merge by id.
   A named Xenon failure still appends the existing "xenon: <reason> - local handoffs only"
   system line AND becomes the picker's `note`.
3. No rows → flashChip('no handoffs in this project'), nothing opens.
4. handoffPicker = { laneId: L.id, rows, remote, xenonCwd, cursor: 0, note }; invalidate('overlay').
   OverlayShell's single-open registry closes the memory drawer if it was open.
5. Keys are claimed by the picker branch in onKeyDown, above the Ctrl+N/P lane switch.
6. Enter: close the picker, then
   a. the lane is gone               → flashChip('lane is gone')
   b. lane.status not idle/awaiting_peer → flashChip('lane busy - #cancel first')
   c. otherwise applyResume(lane, { mode: 'id', reference: row.id },
                            { merged: rows, xenonCwd })
      → reserveCommandTurn('resuming') → resolveHandoffDoc (fetches a remote detail)
      → handoff_bind(harnessId, lane, id)
      → system line "resumed <id> · <author>@<host> · <age> · <source>"
      → dispatchTurn(handoffResumePrompt(doc)).
7. While the picker is open, acp-harness-memory-changed re-merges the refreshed local entries with
   the remote snapshot and re-anchors the cursor BY ID; a cursor row that vanished snaps to the
   nearest index. The row under the cursor never moves out from under the user.
```

### Keybindings

| Key | Context | Action |
|---|---|---|
| `#resume list` | Composer, lane idle/awaiting_peer | Open the handoff picker |
| `j` / `↓` / `Ctrl+N` | Picker open | Next row (wraps, `nextCursor`) |
| `k` / `↑` / `Ctrl+P` | Picker open | Previous row (wraps, `prevCursor`) |
| `Home` / `End` | Picker open | First / last row |
| `Enter` | Picker open | Resume the cursor row in the lane that opened the picker |
| `Esc` / `q` | Picker open | Close; composer draft unchanged, no lane touched |

### UI Changes

Root `.acp-harness__handoff-picker` (block `acp-harness__handoff`), `parts.panel: null`, three
stacked panels exactly as `DirectivePicker` lays them out (`directive-picker.css:27-34`): head, list,
preview. Head is title left (`// handoff · <lane>`), hints right (`j/k move · enter resume · esc
cancel`); the row count and the Xenon `note` ride in the hints span. Width
`clamp(480px, 62vw, 860px)` — the same as the directive picker, because a handoff row carries six
fields. List `max-height: 52vh`; preview is a fixed `height: 22vh` `extras` sibling so moving the
cursor never resizes or re-centres the panel.

The cursor row takes the **picker family's** active treatment — `background: rgba(accent, 0.12)` +
`outline: 1px solid rgba(accent, 0.5); outline-offset: -1px` (`directive-picker.css:71-76`,
`model-picker.css:69-74`) — **not** the 2px left bar `DESIGN.md:285` prescribes for list rows.
`directive-picker.css:10` states the family rule verbatim: "No left-border rails: state via full
outline, tint, and badges." A seventh picker that alone grew a left rail would read as a different
control. The row bound to the active lane carries a `--bound` modifier (success tint, like
`acp-harness__directive-assigned`); a `source: xenon` row carries a dimmed `xenon` tag.
No corner brackets, no `backdrop-filter`, no hard-coded colors outside the existing
`var(--krypton-*, fallback)` pattern these sheets already use.

### Configuration

None. No new TOML keys.

## Edge Cases

| Case | Behaviour |
|---|---|
| No handoffs at all | Nothing opens; `flashChip('no handoffs in this project')` — one message, not an empty overlay |
| Xenon off | Silent, as today; picker shows local rows, `note` is null |
| Xenon unreachable / `missing_scope` | Existing system line is still appended; picker opens with local rows and shows the reason as `note` |
| Remote harness tab (`remoteRuntimeId`) | Unchanged — `#resume` is not in `REMOTE_UNSUPPORTED_HASH_COMMANDS`; `xenonCwd` is null, so the picker lists the local ephemeral store only |
| Lane goes busy while the picker is open (peer mail, queued prompt) | `Enter` closes the picker and flashes `lane busy - #cancel first`; nothing is bound |
| Lane closed/restarted while the picker is open | `Enter` closes and flashes `lane is gone`; the existing `laneUnchanged()` epoch guard still covers a lane that dies mid-resolve |
| Handoff deleted (`#mem clear`) while the picker is open | Re-merge drops the row; cursor snaps to the nearest index |
| New handoff written while the picker is open | Row appears in `updatedAt` order; cursor stays on its id |
| Xenon-only row (`detail === null`) | Detail pane says the detail is fetched on resume; `Enter` goes through `xenon_handoff_fetch`, and a failure bails with the existing `handoff fetch failed: …` after releasing the reservation |
| Another overlay opens (`⌘M`, palette) | `OverlayShell`'s single-open registry closes the picker and `onAutoClose` clears `handoffPicker` |
| `#resume list` while the memory store is unavailable | Unchanged guard: `memory unavailable - use #new`, picker never opens |

## Out of Scope

Type-to-filter and fuzzy search · positional `1`–`9` picks · renaming/deleting a handoff from the
picker · making the `⌘M` memory drawer actionable (it stays read-only display per spec 72) ·
cross-project resume · a palette action or leader key for the picker (`#resume list` is the only
entry point) · any change to `#resume` (newest) and `#resume <id>` · control-API ops for resume.

## Resources

- [Claude Code — Manage sessions](https://code.claude.com/docs/en/sessions) — the `/resume` session
  picker's exact key table, and the `--continue` vs `--resume` split this design mirrors.
- [openai/codex#41505](https://github.com/openai/codex/issues/41505) — Codex moved its exit hint from
  "run `codex resume <thread-id>`" to "run `codex resume`, then select": evidence that handing the
  human an id is the regression, not the feature.
- [openai/codex#18179](https://github.com/openai/codex/issues/18179) — `Ctrl+P`/`Ctrl+N` expected in a
  resume picker.
- [tmux `choose-tree` key behaviour](https://groups.google.com/g/tmux-users/c/wrMYQjhrJDo) — chooser
  vocabulary (`j`/`k`, `Enter`, `/`, `Ctrl+X`).
- [Zellij session management](https://zellij.dev/tutorials/session-management) — overlay session
  chooser with resurrectable entries.
