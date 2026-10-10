# Program Status Protocol (OSC 7501) — Implementation Spec

> Status: Implemented
> Date: 2026-10-09
> Milestone: M-VT — terminal protocol support

## Problem

Krypton has no way to know what a program in a terminal pane is doing. A build that finished, an agent waiting for permission, or a deploy that failed all look the same as an idle shell, and they are invisible in unfocused windows. The only signals today are heuristics (the foreground-process poller), a Claude-only HTTP hook integration, and OSC 9;4, which can say "busy" or "error" but not "waiting on you". OSC 7501 is ignored (no handler, xterm.js drops it).

## Solution

Implement OSC 7501 rev 0.3 as a terminal, frontend-only. Each terminal pane registers an xterm.js OSC handler that parses reports into a per-pane record set held by a new `ProgramStatusStore`. The store applies the spec's lifetime rules and publishes one summary per pane on the ViewBus (`view:program-status`). Chrome shows the summary on the tab dot, the window status dot and accent, and a titlebar chip. The workspace footer counts panes that need attention. `Leader !` jumps to the next one. A pane moving into `blocked`, `error` or `done` while unfocused puts one rate-limited message on the notification rail.

Parsing goes through xterm.js's VT parser rather than a Rust byte scanner. It already handles sequences split across chunks, it is how OSC 9/777/99 are handled (`notification.ts`), the feature-detection reply needs the same `onData` path as xterm's own DA1 replies, and RIS is visible there. It also follows the "no VT parsing in Rust" rule.

## Research

- **Spec rev 0.3** (2026-10-07). Body: `key=value` pairs joined by `:`. `state` is required. Unknown state → ignore the report. Malformed pair → skip that pair. Limit, base64 or control-char violation → discard the whole report. Each report replaces its record completely. Hierarchical `id` with `/`. `clear` removes a subtree, or every record when it has no id. `working`/`blocked` MUST be dropped on process exit and on a new prompt (OSC 133 `A`); `idle` MAY be dropped. `done`/`error` survive both, and the terminal decides when to stop showing them. The query `OSC 7501;? ST` MUST be answered with the same body. RIS clears everything and DECSTR does not. Records are independent of the alternate screen.
- **xterm.js 6.0.0** (installed) exposes `parser.registerOscHandler(7501, cb)`, `parser.registerEscHandler({ final: 'c' }, cb)` for RIS (return `false` so the default reset still runs) and `terminal.input(data, false)`. The last one emits through `onData` and so reaches `write_to_pty` through `wirePaneInput`, including the pre-spawn `pendingInput` buffer that fish's DA1 query already relies on. Because the reply goes through the same queue as DA1 replies, a `OSC 7501;?` followed by `CSI c` gets its replies in order, which is the detection trick the spec recommends.
- **Krypton has no OSC 133.** No handler and no shell integration is injected. The prompt-start drop only works when the user's shell or prompt emits `OSC 133;A` (fish 4 does natively; zsh/bash need integration). To still drop stale `working`/`blocked` records, Krypton also uses the existing `process-changed` poller (`lib.rs:713`). `process: null` means the foreground process group is the shell again (`pty.rs:587`), and Krypton treats a `non-null → null` transition as "the program exited".
- **Existing bus plumbing.** `view:state` is declared and consumed (`chrome-signals.ts`, `workspace-footer.ts`), but no terminal publishes it, and it only tints the focused window. The new signal has to reach unfocused windows, so it is a separate kind. The `pane:focus` intent (`compositor.ts:1214`) already focuses any pane by `viewId`.
- **Leader keys.** `!` is not in `GLOBAL_LEADER_KEY_IDS` (`leader-keys.ts`) and no local view binds it. `Leader 1`–`9` match on `e.key`, so `Shift+1` (`!`) is distinct.
- **Alternatives ruled out:**
  - **Rust scanner in `pty.rs`** (like OSC 9;4). It would duplicate a VT state machine, break the Rust-role constraint, and still need a frontend round-trip for the reply.
  - **Raw scan in `pty-bridge.ts`** (like OSC 7). It would be a second parser beside xterm's and cannot see RIS reliably.
  - **Mapping onto `view:state`.** That only covers the focused window and loses `kind`/`msg`.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Ghostty (libghostty, PR #14560) | The VT layer parses and forwards to an embedder callback. The embedder keeps the records and applies lifetime. RIS reports clear-all. The query is answered only while a handler is installed. | The Ghostty app has no UI for it yet and no terminfo `Pst`. |
| Rex (Superlogical) | Indicators in the session picker for completed or blocked work. Unfocused tab headers show a spinner while working and symbols for blocked. A Lua event `terminal.program_status_changed`. | Reference implementation by the spec author. |
| Herdr | TOML "detection manifests" match the window title or screen regexes per agent (16 rules for Claude Code). | The heuristic approach the protocol replaces. |
| cmux | Out-of-band `cmux notify` CLI. | A per-app API that does not work over SSH. |
| Krypton today | `claude-hooks.ts` (Claude-only HTTP hooks), OSC 9;4 gauge, process poller. | Nothing generic. |

**Krypton delta.** Like Ghostty, the parser and store are separate and the query is answered only where records are kept. Like Rex, the status shows on tab and window chrome and is visible while unfocused. On top of that, Krypton adds a keyboard jump (`Leader !`) to the pane that needs you, because the UI must be keyboard-first, and a footer count instead of a mouse-driven picker. Status colors reuse the existing semantic tokens (warning/danger/success). No new aesthetic is introduced.

## Affected Files

| File | Change |
|------|--------|
| `src/program-status.ts` *(new)* | `parseProgramStatus()` (pure, every limit and validation), `ProgramStatusStore` (per-view records, lifetime, LRU, summaries, attention order, transition callback) |
| `src/program-status.test.ts` *(new)* | Parser limits and validation; store replace, clear-subtree, LRU, lifetime drops, ack, summary priority |
| `src/view-bus-types.ts` | Add `'view:program-status': { viewId; summary: ProgramStatusSummary \| null }` |
| `src/compositor.ts` | Owns the store (`programStatus`). `createPane` generates the `viewId` first and calls `wireProgramStatus()` (OSC 7501, OSC 133 and RIS handlers plus `onKey` ack). Disposes the view on pane close. Publishes the signal, paints the tab, window and chip (`paintProgramStatus`, also after `rebuildTabBar`), announces on the rail. Adds `focusNextProgramAttention()` and `programStatusCounts()`. Extracts `focusPaneByViewId()` from the `pane:focus` intent handler |
| `src/pty-bridge.ts` | New `onShellForeground(viewId)` dep, fired on `process-changed` with `process === null && previous !== null` |
| `src/workspace-footer.ts` | Global `▲n ✕n ✓n` segment (pulled from `programStatusCounts()`); the focused pane's `app: msg` as a `p3 detail` center segment |
| `src/input-router.ts`, `src/leader-keys.ts`, `src/which-key.ts`, `src/command-palette.ts` | `Leader !` → `focusNextProgramAttention()`; reserve `!`; which-key entry in all three Windows groups; palette command `program-status.next` |
| `src/main.ts` | Wire `onShellForeground` → `compositor.programStatus.dropTransient` |
| `src/styles/window.css`, `src/styles/workspace-footer.css` | `[data-program-status]` rules for tab dot, window border/glow/status dot, `.krypton-window__program-status` chip; footer count colours |
| `docs/02-functional-requirements.md`, `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/README.md` | FR-VT-010, module entry, data flow, index row |

**Deviation from the draft.** Painting moved from `chrome-signals.ts` into the compositor. `rebuildTabBar` recreates tab elements, and a closed pane is gone before any bus subscriber could look up its window. Only the compositor sees both moments, so it repaints from the store directly. The bus signal stays a change trigger for the footer.

## Design

### Data Structures

```ts
export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

export interface ProgramStatusRecord {
  id: string;               // '' = root record
  state: ProgramState;
  kind: BlockedKind | null; // blocked only
  progress: number | null;  // working|blocked only; null = indeterminate
  app: string | null;       // as reported; inheritance resolved at read time
  title: string | null;     // decoded
  msg: string | null;       // decoded
  updatedAt: number;
}

export type ProgramStatusReport =
  | { type: 'query' }
  | { type: 'clear'; id: string | null }          // null = every record
  | { type: 'set'; record: Omit<ProgramStatusRecord, 'updatedAt'> };

/** null = report discarded or ignored (limit, base64, control char, bad id, missing/unknown state). */
export function parseProgramStatus(body: string): ProgramStatusReport | null;

export interface ProgramStatusSummary {
  state: ProgramState;            // highest-priority record in the pane
  kind: BlockedKind | null;
  app: string | null;             // inherited from the nearest ancestor
  msg: string | null;
  progress: number | null;
  attention: number;              // records in blocked|error|done
}
```

Summary priority is `blocked > error > done > working > idle`. Ties go to the most recently updated record. A pane with no records publishes `null`.

### Store API

```ts
class ProgramStatusStore {
  constructor(onChange: (viewId, prev: Summary | null, next: Summary | null) => void, now?: () => number);
  apply(viewId: string, report: ProgramStatusReport): void; // query handled by caller
  dropTransient(viewId: string): void;   // prompt start / program exit: drop working|blocked|idle
  acknowledge(viewId: string): void;     // user keypress in pane: drop done|error
  reset(viewId: string): void;           // RIS
  dispose(viewId: string): void;         // pane closed
  summary(viewId: string): ProgramStatusSummary | null;
  nextAttention(afterViewId: string | null): string | null;
}
```

`onChange` fires only when a pane's summary actually changes, and the compositor then publishes `view:program-status`. Records are kept in a `Map` per view in update order: an update deletes the key and sets it again, and when the 64-record cap is exceeded the first key is evicted. That cap is the minimum the spec allows.

### Data Flow

```
1. Program writes ESC ] 7501 ; state=blocked:kind=permission:app=terraform:msg=… ESC \
2. pty-output → xterm.js parser → OSC handler(7501) for that pane (bound viewId)
3. parseProgramStatus(body):
   - query → terminal.input('\x1b]7501;?\x1b\\', false) → onData → write_to_pty
   - null → drop; clear/set → store.apply(viewId, report)
4. Store recomputes the pane summary; if changed → compositor.handleProgramStatusChange:
   publishSignal('view:program-status', address ?? SYSTEM_SOURCE, { viewId, summary })
5. Compositor paints tab dot + window border/status dot + titlebar chip (aggregate over panes);
   workspace-footer re-pulls counts and the focused pane's app/msg
6. Pane not focused and next.state ∈ {blocked, error, done}, entered from a different
   state → notification rail: "W2·<tab> — <msg or phrase>" labelled <APP> (1 per pane per 5 s)
7. Lifetime: OSC 133;A or process-changed (non-null → null) → dropTransient
             onKey in pane → acknowledge;  ESC c → reset;  pane close/pty-exit → dispose
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader !` | Compositor | Focus the next pane needing attention: `blocked`, then `error`, then `done`, oldest first, cycling after the current one. If none, show a rail message "no program needs you". Also the palette command "Focus Next Program Needing You" |

### UI Changes

- `.krypton-tab[data-program-status]`: the `.krypton-tab__dot` turns warning (`blocked`), danger (`error`) or success (`done`), and pulses for `working`. The value aggregates every pane in that tab.
- `.krypton-window[data-program-status]`: aggregates across the window's tabs. `blocked`/`error`/`done` set `--krypton-program-status-rgb`, which colours the border, glow and status dot. A dedicated variable is used rather than `--krypton-window-accent-rgb`, so other tabs' dots keep the window accent. `working` only pulses the status dot. `[visual] window_border = false` still hides the border.
- `.krypton-window__program-status`: a titlebar-end chip before `pty-status` showing the window's top summary: `40%`/`···` (working), `PERMISSION`/`QUESTION`/`AUTH`/`BLOCKED`, `DONE`, `ERROR`, prefixed with `app` when present. Hidden for `idle` or no records.
- Footer: a segment `▲2 ✕1 ✓3` (counts of views, not records), shown only when non-zero. In detail density the focused pane's `app: msg` is also shown.
- Any `msg`/`title` shown outside the grid goes through `textContent` with bidi and invisible formatting characters stripped (U+200E/F, U+061C, U+202A–202E, U+2066–2069).

### Configuration

None. Answering the query and showing status are always on. Rail messages are only produced for unfocused panes and are rate-limited.

## Edge Cases

1. **Report split across PTY chunks.** xterm's parser buffers it, so nothing extra is needed.
2. **Limits.** UTF-8 length of the body + 8 > 4096, key > 16, `msg` > 2732 encoded or 2048 decoded, `title` > 256/192, `id` > 128 chars, more than 8 segments, or a segment > 32 → discard the whole report. Every pair is validated before the store is touched.
3. **Malformed pair** (no `=`, empty key, or a byte outside the value set) → skip that pair. **Unknown key** → ignore it. **Repeated key** → the last one wins. **Bad `kind`/`progress`/`app`** → treated as absent. **Bad `id`** → the report is ignored and never falls back to the root.
4. **`clear:id=build`** removes `build` and `build/*`, not `builder`. `clear` with no id removes every record.
5. **No OSC 133 and the program is killed with Ctrl-C.** The poller drops its records within one poll interval (500 ms by default). If `[extensions] enabled = false`, the poller is off and the record lasts until the next report, a `clear`, RIS or pane close. This is documented as a limitation.
6. **SSH.** Reports pass through. The poller sees `ssh` as the foreground process the whole time, so only a remote `OSC 133;A` drops `working`/`blocked`.
7. **A program reports, then its child runs in the foreground.** The poller only drops records on a transition back to the shell, so a program running a child process keeps its records.
8. **A tab moves to another window, or a pane is split or closed.** The aggregates are recomputed on `system:relayout`.
9. **Quick Terminal and non-terminal views** (agent, harness, vault…) do not register a handler. The query gets no reply there, so a program correctly concludes the protocol is unsupported.
10. **Flood of transitions.** The store publishes only on summary change, and the rail allows one message per pane per 5 s.
11. **Alternate screen (vim, TUI).** Records are unaffected. **DECSTR** has no effect.
12. **`done` in the focused pane.** It still shows until the first keypress in that pane. Focusing alone does not acknowledge it, so cycling windows does not eat results.

## Out of Scope

- Terminfo `Pst` capability (Krypton ships no terminfo entry; Ghostty also omitted it).
- Mapping OSC 9;4 onto the root record (spec MAY). The OSC 9;4 gauge stays as it is.
- Full OSC 133 shell integration (command blocks, exit codes). Only `A` is observed.
- Quick Terminal, ACP harness lanes and the Agent view. Lanes already have ACP status.
- OS-level notifications, sounds, and per-state configuration.
- A records-tree inspector UI for multi-record programs (only the summary is shown).

## Resources

- [A Terminal Protocol for Program Status (OSC 7501)](https://mitchellh.com/writing/program-status-osc7501) — motivation, the heuristics-vs-protocol argument, the rsync shell example.
- [Program Status Protocol spec rev 0.3](https://www.superlogical.com/rex/docs/build/program-status) — normative grammar, states, lifetime, limits, security, feature detection; Rex presentation.
- [ghostty-org/ghostty#14560](https://github.com/ghostty-org/ghostty/pull/14560) — parser/embedder split, RIS → clear-all, query answered only when a handler exists, no terminfo.
- `node_modules/@xterm/xterm/typings/xterm.d.ts` (6.0.0) — `registerOscHandler`, `registerEscHandler`, `input(data, wasUserInput)`.
