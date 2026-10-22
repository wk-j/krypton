# Harness Follow-up Actions — Implementation Spec

> Status: Implemented (rev 3 — each button puts its command under its label)
> Date: 2026-10-22
> Milestone: ACP Harness — transcript
> Builds on: 0306 (assist sidecar) · 0322 (terminal-tab callback) · 0206/0283/0309 (`f` open-hint targets) · 0281/0286 (late sub-components on sealed rows) · 0301/0302 (component kernel)

## Problem

A lane's reply often ends with something for the human to do: run `make install`, run `npm test`, open `http://localhost:5173`. Today the human copies that text into a terminal or a browser by hand. The assist sidecar (0306) reads every finished turn, but it can only propose prompts for the agent. It cannot offer to run what the agent told the human to run.

**Rev 2 requirement (user, 2026-10-22):** the buttons render in the transcript area, so that the human can scroll back to any earlier reply and still use its buttons.

**Rev 3 requirement (user, 2026-10-22):** "I think follow up UI is not well oranized it hard to read". With the label and command on one line, each multi-line command hung at a different indent and the buttons had ragged widths. Each button now puts its command under its label.

## Solution

Add a second assist task, `follow-up`. When a turn ends it picks up to three actions from the reply. They appear as a **FOLLOW-UP** rail of buttons under that reply's row and stay there for as long as the row exists. Every earlier reply keeps its own buttons. An action is one of two kinds:

- **`run`** opens a terminal tab in the harness window at the project directory. The tab runs the command in the user's login shell and then stays open as an interactive shell.
- **`open`** opens an http(s) URL in the OS browser.

Nothing runs without the human. They click a button, or use the existing transcript keys: `Esc` to focus the transcript, `f` to enter open-hint mode, then the button's hint label.

**The assist model never writes the command.** Krypton pulls candidates out of the reply's markdown deterministically: shell fences, inline code spans and http(s) URLs. The model only picks candidate numbers and writes a short label for each. A reply with no candidates costs no model call.

## Research

- **Sidecar shape (0306).**
  - A task is `system` / `payload` / `parse`. The engine owns single-flight, the deadline and the breaker.
  - The surfaces today are `strip` and `panel` (`assist/types.ts:86`). Both keep one result per lane (`harness-assist-controller.ts:44-48`, `:70`), so neither can hold a result per reply.
  - 0306:262 says a new result shape "needs a new `surface` variant plus its own component". So this spec adds the `transcript` surface.
- **`parse` has no context.** `parse(raw, cfg)` (`assist/types.ts:98`) is called at `engine.ts:84`. Picking candidates by number needs the candidate list, so `ctx` becomes a third argument. The existing tasks ignore it.
- **Payload privacy (0306:225).** Tool `subject` and `command` values never leave the machine. Every candidate is a substring of the last assistant text, and next-prompt already sends that text (`next-prompt.ts:130`). No new kind of data leaves. `tool.command` is also unusable as a source: it is cut to 96 characters (`harness-tool-render.ts:138-141`, `:448`).
- **Source text.** An assistant item's `text` is its raw markdown (`acp-harness-view.ts:14630`). `message-resources.ts` deliberately never scans prose, so extracting candidates is new code.
- **The sealed-row rule (AGENTS.md constraint 10) allows this.**
  - The rule's text: "Late async state (Git refs, images, usage, memory) calls `update()` on the owning sub-component. Never reach into a sealed row's DOM from outside it." Follow-ups are late async state of exactly that kind.
  - Precedents exist on `AssistantRow`: the REFERENCES rail (`syncRail`, `assistant-row/index.ts:313-325`) and the annotation rail (`:334-346`). The image strip is a sibling of the row body (`transcript-row/index.ts:115-128`). GenUI hints are patched in place (`patchUiHints`, `assistant-row/index.ts:85-87`), and so are execution hints (`ToolRow.patchExecutionHint`, `tool-row/index.ts:187-189`).
  - Stateless buttons already sit in sealed rows: the SVG card's Source/Copy toolbar (0283), the GenUI card's open button (0309) and subagent rows (0282).
  - The GenUI clause ("do not give a row ownership of live controls") is about the movable panel and its live state. A follow-up button has no state, and a click changes nothing in the row. So this is not a second inline-panel exception.
- **The keyboard path for transcript elements already exists.** In transcript focus (`Esc` from the composer, `acp-harness-view.ts:4567`), `f` enters open-hint mode (`:15172-15176`). Every target in `activeLaneOpenTargets()` (`:9779-9800`) gets a label, and `handleOpenHintKey` dispatches on the target's shape (`:9834-9881`). 0283:168 states it plainly: "The only action surface for transcript elements is `f` open-hint mode."
- **Click delegation.** One transcript click handler matches `[data-…]` attributes and the owning `.acp-harness__msg[data-msg-id]` (`acp-harness-view.ts:6307-6370`). Rows hold no callbacks.
- **Windowing.** The transcript mounts the last 60 items; `Ctrl+H` widens the window (`TRANSCRIPT_WINDOW_STEP`, `:887`; `expandTranscriptWindow`, `:12598`). Because follow-ups live on the transcript item, a row mounted later paints them from data.
- **Running a command today.**
  - `openTerminalTabCb` (0322) calls `Compositor.createTab` in the focused window. It forces `cwd: null` (`compositor.ts:4962`), and `OpenTerminalTab` has no cwd field (`backend-updates.ts:22`). A remote harness gets `null` (`compositor.ts:5007`).
  - Lanes have no working directory of their own; every lane spawns in the view's `projectDir` (`acp-harness-view.ts:7845`).
  - A PTY whose process exits closes its tab (`compositor.ts:8276-8324`), so the wrapper must not exit after the command.
- **Ruled out for running:**
  - `!cmd` (`runShellCommand`, `:12343`) has no PTY, holds the lane's single shell slot and writes a transcript row.
  - Typing into a fresh interactive shell (`write_to_pty`) has no readiness signal; the only hook is OSC 133 (`compositor.ts:958`).
- **URLs.** `openExternalUrl(url, { external: true })` calls `open_url` (`external-url.ts:22-25`). Rust checks no scheme, and the frontend rules allow only http(s) (`harness-markdown.ts:76-78`, `genui/evaluate.ts:538-541`).

### Alternatives rejected

- **A bar in the composer (rev 1).** It shows only the latest turn. The user asked for every reply's buttons to stay reachable by scrolling.
- **A separate `follow_up` transcript row kind.** The result arrives seconds after the turn ends. If the human has already sent the next prompt, an appended row lands after it, under the wrong turn. A new kind also touches every switch over `HarnessTranscriptItem.kind`.
- **A slot inside the markdown body.** The body's `innerHTML` repaint (`paintSealed`, `assistant-row/index.ts:247`) detaches it, and annotation wrapping walks the body's text. A sibling of the body avoids both.
- **The model writes the command.** One hallucinated or prompt-injected reply would put a button on screen that runs something the agent never said. Picking by number rules this out.
- **Regex only, no model.** Every inline code span — paths, symbols, flags — would become a button.
- **A "ran" marker on a clicked button.** It would be a visual change to a sealed row. The terminal tab is the record that a command ran.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| JetBrains AI Assistant | A code-snippet toolbar inside each response: Copy, Insert Snippet at Caret, Create File, **Run Snippet** ("execute the generated command or code") | Closest match: run buttons stay in the history; every block gets one, with no selection |
| Warp | *Next Command* accepts with `→` / `Ctrl+F` into the input buffer, and `Enter` runs it. *Prompt Suggestions* are chips. Secret redaction applies to outbound content | Latest block only; nothing persists |
| VS Code Copilot Chat | `!cmd` runs in the session folder, with output in the transcript. `ChatFollowup` entries are prompts | No action buttons |
| Claude Code · Codex CLI · ChatGPT | Copy on code blocks at most | — |

**Krypton delta.**

- As in JetBrains, the buttons live in the history beside the reply that named them, and what runs is text the agent wrote.
- Unlike JetBrains, a cheap model chooses at most three per reply instead of one per block. Each button shows its full command, and the keyboard path is the same `f` hints every other transcript target uses.
- It never runs anything automatically, and commands run in a real PTY tab rather than in the transcript.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/assist/types.ts` | `FollowUpAction`, `TranscriptAssistTask` (`surface: 'transcript'`), widened `RegisteredAssistTask`; `parse(raw, cfg, ctx)` |
| `src/acp/assist/engine.ts` | Pass `ctx` to `task.parse` |
| `src/acp/assist/tasks/follow-up.ts` + `.test.ts` | **New.** `followUpCandidates`, `system`, `payload`, `parse`, `eligible` |
| `src/acp/assist/registry.ts` | `ASSIST_TASKS = [nextPrompt, followUp, grammar]` |
| `src/acp/harness-view-types.ts` | `HarnessTranscriptItem.followUps?: FollowUpAction[]` |
| `src/acp/harness-assist-controller.ts` + test | `runTranscript` path, remote gate, write to the owning reply item |
| `src/acp/harness-view-host.ts` | `HarnessAssistHost.patchFollowUps(lane, itemId)` |
| `src/acp/components/follow-up-rail/` | **New.** `index.ts`, `follow-up-rail.css`, `follow-up-rail.test.ts` |
| `src/acp/components/assistant-row/index.ts` | Owns a `FollowUpRail` as the row's last child; `syncFollowUps()`; `paint()` override keeps the rail last |
| `src/acp/components/registry.ts` | Entry beside `resource-rail` |
| `src/acp/follow-up-run.ts` + `.test.ts` | **New.** `followUpShellArgs(command)` and the wrapper script |
| `src/acp/backend-updates.ts` | `OpenTerminalTab` options gain `cwd?: string \| null` |
| `src/compositor.ts` | Local harness callback passes `cwd: options.cwd ?? null` |
| `src/acp/acp-harness-view.ts` | `patchFollowUps` host member; `runFollowUp`; click delegation; open-hint targets, dispatch, label reset and patch loop |
| `src/acp/hash-commands.ts` | `#assist` description names both tasks |
| Docs | 0306 (surfaces, `parse` signature, registry), 0072 (transcript features), 0206 (hint target list), 0004, 0005 (turn-end flow), 0006 (task config), `README.md` index |

## Design

### Data structures

```ts
// src/acp/assist/types.ts
export interface FollowUpAction {
  readonly followUpKind: 'run' | 'open'; // a field no other open-hint target has
  readonly label: string;                // written by the model, 1..40 chars
  readonly target: string;               // command or URL, copied from the candidate — never from the model
  hintLabel: string | null;              // `f` open-hint label (spec 206 target contract)
}
export type TranscriptAssistTask = AssistTask<FollowUpAction[]> & { readonly surface: 'transcript' };
export type RegisteredAssistTask = StripAssistTask | PanelAssistTask | TranscriptAssistTask;
// AssistTask<T>.parse gains ctx; nextPrompt and grammar keep their two-parameter bodies.
parse(raw: string, cfg: AssistTaskConfig, ctx: AssistContext): T | null;

// src/acp/harness-view-types.ts — on HarnessTranscriptItem
followUps?: FollowUpAction[];             // spec 323; set only on assistant items

// HarnessAssistHost — one new member
patchFollowUps(lane: HarnessLane, itemId: string): void;
```

### Candidate extraction — `followUpCandidates(text)`

The input is the last assistant item of the turn, the same text next-prompt reads.

1. **Fences.** A fence opens with ```` ``` ```` or `~~~` and an info string, and closes on the same fence. Only shell fences produce a candidate: an info string that is empty, `sh`, `bash`, `zsh`, `fish`, `shell`, `console`, `terminal` or `shellsession`.
   - If any line starts with `$ ` or `% `, keep only those lines and strip the prompt; otherwise keep every line. Trim the result.
   - The whole block is **one** `run` candidate. It is dropped if it is empty, over 6 lines or over 400 characters.
   - A non-shell fence produces nothing, and its contents are not scanned.
2. **Inline code spans** outside fences (`` `…` ``, one line) become a candidate when 2–200 characters after trimming. A span that is exactly an `http(s)://` URL is `open`; any other span is `run`.
3. **Bare URLs** outside fences and spans match `https?://[^\s<>()\`"']+`, with trailing `.,;:!?]` stripped. They are `open`. No other scheme is ever a candidate.
4. Deduplicate on `kind + target`, keeping the **last** occurrence, and keep the last 20.

The function is pure. `eligible`, `payload` and `parse` each call it on the same `ctx`, so the numbers the model sees are the numbers `parse` resolves.

### The task — `src/acp/assist/tasks/follow-up.ts`

`{ id: 'follow-up', summary: 'offer to run or open what the reply tells you to', surface: 'transcript', onTurnEnd: true, defaults: { mode: 'off', options: { count: 3 } } }`

- **`eligible(ctx)`** is true only when there is at least one candidate. A reply with no command and no URL makes no call.
- **`system(cfg)`:**

  > You read the final reply of a coding agent and a numbered list of candidates copied from it. Pick the candidates the human should run or open next. Reply with JSON only: `{"actions":[{"id":N,"label":"…"}]}`. At most N entries, most useful first. Pick a candidate only if the reply tells the human to run or open it, or if it installs, builds, tests, starts or shows what the turn just made. Never pick a file path, a symbol, an example, a command the reply says already ran, or a command the reply warns against. `label` is at most 40 characters, lower case, no trailing period, and says what the action does. If nothing qualifies, reply `{"actions":[]}`.

- **`payload(ctx, budget)`** puts the candidates **before** the reply, so the engine's head-slice backstop (`engine.ts:53`) can only cut reply text:

  ```
  project: krypton
  lane: OMP-1 (omp · claude-opus-5)
  --- candidates ---
  1. run: make install
  2. open: http://localhost:5173/docs
  3. run: npm test
  --- agent replied ---
  <last assistant text, tail-kept, ≤ 55% of max_input_chars>
  ```

  The candidate section is capped at 35% of `max_input_chars`, dropping the oldest candidates first. A multi-line candidate indents its continuation lines.

- **`parse(raw, cfg, ctx)`** strips a ```` ```json ```` fence, takes the outermost `{…}` and runs `JSON.parse`.
  - An empty `actions` array → `[]`. That is a valid, quiet answer and does not feed the breaker.
  - For each entry: `id` must be an integer (or a digit string) naming a candidate and must not repeat, and `label` must be non-empty after collapsing whitespace. A label over 40 characters is cut at a word and ends in `…`. Invalid entries are dropped. The result is capped at `count`, clamped to 1–3.
  - `target` and `followUpKind` always come from the candidate, and `hintLabel` starts as `null`.
  - A non-empty array with no valid entry, or malformed JSON → `null`, which the engine records as `'invalid'`.

### Controller — `runTranscript`

- **Owner.** When the run is enqueued, the controller snapshots the turn (`turnItems(lane)`) for a `transcript` task, and the run's context is built from that snapshot. The **owner** is the last non-empty `assistant` item in it. Read later, the turn would be the next prompt's if the human sent one while the run was queued. The result belongs to the owner, wherever the transcript has moved since.
- **Remote gate.** A `transcript` task is ineligible when `host.remoteRuntimeId !== null`: the commands and `localhost` would refer to the remote machine.
- **While pending,** nothing is painted. A live placeholder in a sealed row would break constraint 10.
- **Result.** The stale-drop checks (`epoch`, `spawnEpoch`, active lane) are identical to `runStrip`. The owner must also still be in `lane.transcript`.
  - Success with a non-empty list → `owner.followUps = actions`. `[]` → `owner.followUps = undefined`.
  - In both cases the controller then calls `host.patchFollowUps(lane, owner.id)`.
  - Failures go through `flashChip(FAILURE_TEXT[…])`, as the strip's do.
- **Re-asking.** `#assist follow-up now` uses the existing `request(lane, taskId)`. It re-asks for the latest reply and replaces that reply's follow-ups. Older replies are never re-asked.
- **Turn end never clears follow-ups.** Each reply keeps its own until the transcript drops the item (`/clear`, lane close).

### Row — `FollowUpRail` on `AssistantRow`

- **Placement.** `AssistantRow` owns `followUpRail: FollowUpRail | null` and keeps it as the row element's **last child**: a sibling after the body and the image strip, never inside the body. The body's `innerHTML` repaint and annotation wrapping therefore never touch it. The row is a two-column grid (`harness-shared.css` `.acp-harness__msg`), so the rail takes `grid-column: 2`, as the image strip does.
- **Sync.** `syncFollowUps()` creates, updates or removes the rail from `this.current.item.followUps`. A live row never shows one. It runs:
  - at the end of `AssistantRow.paint()`, after the base has synced the image strip, so a row mounted later — after a window widen, a lane switch or a scroll — paints its buttons from data;
  - when the view's `patchFollowUps(lane, itemId)` calls `this.rowFor(itemId)?.syncFollowUps()`, but only for the active lane. An unmounted row simply paints on mount.
- **Dependencies.** `followUps` is **not** in `bodyDeps()` or the row's dependency tuple, so its arrival never repaints the reply body. The rail is a plain `Component` whose `readDeps()` is `[signature, hints]`:
  - `signature` joins each action's `followUpKind`, `target` and `label`;
  - `hints` joins the `hintLabel`s.
- **Hints.** The same `syncFollowUps()` re-runs the rail's `update()`, so hint labels appear and clear without a row repaint, as `patchUiHints` does for GenUI cards.

### Open-hint and click — `AcpHarnessView`

- **Targets.** `HarnessOpenTarget` gains `FollowUpAction`. `activeLaneOpenTargets()` pushes `...(item.followUps ?? [])` after the item's other targets, and only when `this.transcript?.rowFor(item.id)` is mounted — the `uiFences` / `executionTarget` rule, since a label that is not on screen cannot be typed.
- **Dispatch.** `handleOpenHintKey` adds a branch for `'followUpKind' in exact` that calls `this.runFollowUp(exact)`.
- **Hint lifecycle.** `exitOpenHintMode` resets `hintLabel` on every follow-up. `patchGenUiHints` also calls `row.syncFollowUps()` on every mounted `AssistantRow`.
- **Click.** The transcript click delegation gains a `[data-follow-up-index]` branch. It resolves the owning `.acp-harness__msg[data-msg-id]` and the item's `followUps[index]`, then calls `runFollowUp`.

### Execution — `AcpHarnessView.runFollowUp(action)`

- **`open`:** check `/^https?:\/\//i` again, then `openExternalUrl(action.target, { external: true })`.
- **`run`:** call `openTerminalTabCb({ title: 'ACP // ' + action.label, shell: '/bin/sh', shellArgs: followUpShellArgs(action.target), cwd: this.projectDir })`.
  - A `null` callback → `flashChip('follow-up: no terminal here')`.
  - A `null` session id (no focused window) → `flashChip('follow-up: no window to run in')`.

`followUpShellArgs(command)` returns `['-c', FOLLOW_UP_SCRIPT, 'krypton-follow-up', command]`, where:

```sh
trap : INT
printf '\n$ %s\n\n' "$1"
"${SHELL:-/bin/sh}" -lc "$1"
printf '\n[krypton] exit %s\n' "$?"
exec "${SHELL:-/bin/sh}" -l
```

- The command travels as `argv` (`$1`) and is never spliced into script text.
- It runs in the user's own login shell and syntax (zsh, bash or fish), in `projectDir`, with the PTY's login environment.
- `trap : INT` lets `Ctrl+C` stop the command but not the wrapper. A caught signal resets to its default in children, whereas `trap '' INT` would be inherited. The tab keeps its output and becomes an interactive shell, and it closes only when the user exits that shell.

### Keybindings

No new chord.

| Key | Context | Action |
|-----|---------|--------|
| `Esc` | composer | Transcript focus (existing) |
| `f` | transcript focus | Open-hint mode (existing); follow-up buttons on mounted rows get labels in transcript order |
| `<label>` | open-hint mode, follow-up button | Run or open that action, then exit hint mode |
| `Ctrl+H` | harness | Widen the transcript window (existing), to reach older replies |
| click | follow-up button | Run or open that action |

### UI

Under the reply, after its REFERENCES rail:

```
FOLLOW-UP
╭──────────────────────────────╮
│ ▶ install the app            │
│   make install               │
╰──────────────────────────────╯
╭──────────────────────────────╮
│ ↗ open the docs page         │
│   http://localhost:5173/docs │
╰──────────────────────────────╯
```

- **Structure.** Block `acp-harness__followups`: a small header `follow-up`, then a column of buttons. The list is `width: fit-content; max-width: 100%`, so every button is as wide as the widest one. The commands share one left edge and the right edges line up.
- **Buttons.** Each is a `<button type="button" tabindex="-1" data-follow-up-index="N">` containing:
  - `span.__hint` — the open-hint label; empty, and not displayed (`:empty`), when null; same treatment as `.acp-genui-card__hint`;
  - `span.__glyph` — `▶` for run, `↗` for open;
  - `span.__label`;
  - `code.__target` — shown in full with `white-space: pre-wrap` and no ellipsis, because the human must see exactly what will run.
- **Layout.** A button is a grid with columns `auto auto minmax(0, 1fr)`. Row 1 holds the hint, the glyph and the label. Row 2 holds the target in the label's column, so a multi-line command reads as one block aligned with its label. Each part is placed explicitly because the hint is `display: none` outside hint mode. Spacing comes from margins rather than `column-gap`, so the empty hint track leaves no gap.
- **Styling.**
  - Ghost buttons (DESIGN.md:291) with a full 1px border at the window accent's low tier (`--krypton-window-accent` at 28%) and a hover tint. No corner brackets, and no hex outside a `var()` fallback.
  - **No animation of any kind**, including no entrance animation when the rail first appears, so the row stays static.
  - One `@layer krypton.component` block plus `.acp-harness__followups[hidden] { display: none; }`. The rail inherits the row's font, as the REFERENCES rail does; its head matches the REFERENCES head.
- **Height change.** The rail adds height to a sealed row once. The existing per-row `ResizeObserver` keeps a bottom-stuck transcript stuck, as it does for a late image decode (0283:169).

### Configuration

```toml
[acp_harness.assist.tasks.follow-up]
mode = "auto"   # default "off": each eligible turn costs one cheap-model call
count = 3       # 1..3
```

No `config.rs` change: 0306 passes task options through opaquely.

## Edge Cases

- **No backticked command or URL in the reply:** no candidate, so no call and no rail.
- **`{"actions":[]}`:** no rail; not a failure.
- **The human sends the next prompt before the result arrives:** the rail still lands under the reply that named the actions, because the turn was snapshotted at enqueue.
- **Running an action from an old reply:** it runs the command as written then, in today's `projectDir`. The full command is on the button, and the human decides.
- **A command the reply scopes to a subdirectory** ("from src-tauri/ run `cargo clippy`"): the button runs the bare candidate in `projectDir`, because only the span is a candidate. The button shows exactly what runs.
- **The model picks a command the turn already ran:** shown in full; the human decides.
- **A destructive command in the reply (`rm -rf build`):** it may be offered. It runs only on a click or hint label, with the command shown in full. No allow/deny classification exists.
- **Multi-line fence:** one action, handed whole to `$SHELL -lc`.
- **Dev server or watcher:** it runs in the tab until `Ctrl+C`, then the tab becomes a shell. Closing the tab does not kill the PTY (existing `disposePaneTree` behaviour, 0322), so stop it with `Ctrl+C` first.
- **Reply outside the 60-item window:** not mounted, so it has no hint label. `Ctrl+H` widens the window and the row paints its rail.
- **Lane switch:** the rows of the other lane mount with their own follow-ups. A result still in flight is dropped (0306 stale rule), so that reply gets none; `#assist follow-up now` re-asks for the latest reply.
- **App restart or `session/load`:** follow-ups live in memory on the transcript item and are not persisted, so a reloaded transcript shows none.
- **Remote harness:** the task never runs, so there is no rail.
- **`file:`, `javascript:` or other schemes:** never candidates.
- **The same command as both a fence and a span:** deduplicated.
- **A URL or command inside a non-shell fence (e.g. a `ts` block):** ignored.
- **Space-aligned comments in a command** (`cmd   # note`): the comments line up only when every glyph comes from the monospace font. A script the font lacks (Thai under `Share Tech Mono`, for example) falls back to a proportional font, and the columns drift. The target is shown verbatim, so the rail does not realign it.

## Implementation Notes

Where the shipped code differs from the draft, and why:

- **Over-long labels are shortened, not dropped.** In a real run against `claude -p --model haiku`, the model labelled the reply's main action with 41 characters. Dropping it would have lost the action the reply cared about most, so `parse` cuts the label at a word and adds `…`.
- **The turn is snapshotted at enqueue.** The draft captured only the owner. The context must come from the same snapshot, or a prompt sent while the run waits behind next-prompt makes the turn look reply-less and the task skips.
- **One row method.** `AssistantRow.syncFollowUps()` covers both the late result and hint labels, so there is no separate `patchFollowUpHints()`.
- **Grid column.** The rail needs `grid-column: 2` because rows are a two-column grid; without it, the first browser check showed the rail squeezed into the label column.
- **Label over command (rev 3).** The first layout put label and command on one line in a wrapping row. In a user screenshot of three multi-line commands, each command hung at an indent set by its own label's width, and each button had a different width. The button became a two-row grid, and the list became a single column of equal-width buttons. The change is CSS-only: the DOM, the deps and the click/hint contract are unchanged.

**Verified:**

- Unit tests cover candidate extraction, parse, the controller (owner after the next prompt, remote gate, no-candidate skip, re-ask clearing, a reply leaving the transcript), the rail, and the row (no body mutation, mount from data, no rail on a live row). `follow-up-run.test.ts` runs the wrapper under `/bin/sh`.
- A PTY run of `sleep 30`: `Ctrl+C` printed `[krypton] exit 130` and left a working login shell.
- A Chromium render of two rows checked the rail's column, the hint badges and the hover state. Rev 3 rendered the screenshot's three multi-line commands with the real `FollowUpRail`. In every button, the label and the target start at the same x, and all three buttons have the same width. At a 560px stage, long lines wrap inside the target column without overflowing the rail.
- Two real haiku calls each picked `make install`, `cargo clippy` and the docs URL. They skipped the file paths, the command the reply said already ran, and the `git push --force` it warned against.
- **Not exercised:** the full in-app path (a Tauri lane turn → rail → terminal tab). It needs a rebuilt app.

## Open Questions

None.

## Out of Scope

- A composer bar or any second surface for the same actions.
- Running in the transcript (`!cmd`) or in a split pane beside the harness.
- Command risk classification, allowlists or a confirm dialog.
- A "ran" marker or any other state painted on a button after a click.
- Actions taken from tool calls (`tool.command`).
- Backfilling replies from before the task was enabled, or re-asking any reply but the latest.
- Persisting follow-ups across restarts.
- Any kind beyond `run` / `open`.
- Running anything automatically, and execution on a remote harness.

## Resources

- [JetBrains AI Assistant — Chat with AI: Process responses](https://www.jetbrains.com/help/ai-assistant/chat-mode.html) — Run Snippet on each code block, kept in the chat history.
- [Warp — Active AI Recommendations](https://docs.warp.dev/agents/local-agents/active-ai/) — Next Command accept-then-run flow, prompt-suggestion chips, outbound secret redaction.
- [VS Code — Use chat: Run terminal commands from chat](https://code.visualstudio.com/docs/copilot/chat/copilot-chat) — `!cmd` runs in the session folder; follow-ups remain prompts.
- `docs/0306-harness-assist-sidecar.md`, `docs/0206-assistant-response-resources.md`, `docs/0283-harness-svg-fence-preview.md`, `docs/0281-harness-inline-images.md`, `docs/0322-acp-backend-update-check.md`, `docs/adr/0002-html-artifacts-open-in-os-browser.md` — Krypton precedents.
