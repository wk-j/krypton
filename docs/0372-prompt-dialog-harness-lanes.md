# Prompt Dialog → Harness Lanes — Implementation Spec

> Status: Implemented (approved 2026-11-08: "อนุมัติ docs/0372-prompt-dialog-harness-lanes.md แล้วลงมือแก้โค้ดตาม spec ได้เลย")
> Date: 2026-11-08
> Milestone: ACP Harness — input
> Builds on: 0061 (Smart Prompt Dialog) · 0063 (screen capture routing) · 0136 (prompt queue) · 0175 (control API) · 0247 (remote Harness)

## Problem

The Smart Prompt Dialog (`Cmd+Shift+K`) is Krypton's only full multi-line prompt editor: a real
`<textarea>` with `Shift+Enter`, `@path` and `@selection`, image paste and drop. It can only send
to a terminal whose foreground process is `claude`, because it writes to a PTY. ACP Harness lanes
are not PTYs, so the dialog shows `NO CLAUDE SESSION` even when lanes are running. The lane
composer itself edits multi-line text poorly: `↑`/`↓` do not move between lines, and
`Home`/`End`/`Ctrl+A`/`Ctrl+E` jump to the ends of the whole draft (`acp-harness-view.ts:15694-15695`).

## Solution

Every live Harness lane becomes a dialog target next to the `claude` terminals. A lane target is
sent through the existing control operation `lane.send`. That operation already queues for a
busy lane and is what Raycast, Live Assist, Telegram and the browser extension use. `lane.send`
learns one in-process caller, `prompt_dialog`. For that caller it accepts staged images and
treats the text as literal: a leading `@` is a file path, not a lane mention. When the dialog
opens from a Harness, it targets that Harness's active lane and goes straight to the textarea.

## Research

- **Dialog today** (`src/prompt-dialog.ts`): `TARGET_PROCESS = 'claude'` (:20). Targets come from
  `compositor.findSessionsByProcess` (:257). Submit wraps the text in bracketed paste and writes
  `\r` 30 ms later through `write_to_pty` (:712-724), then `flashWindow` and close. Images are
  saved by `save_temp_image` and inserted as `@<tmp path>` tokens with a thumbnail, at most 4 of
  5 MiB each (:816-844). `lastUsedSessionId` (:125) preselects a row. The picker auto-opens at
  ≥2 targets (:210).
- **Harness addressing**: `HarnessDirectory` (`harness-directory.ts:53-180`) is the only registry.
  `listHarnessEntries()`, `resolveDisplayName(name)` and `harnessEntry(id)` route to
  `entry.control(op, params, caller)`. The compositor sends diff reviews this way
  (`compositor.ts:3477-3489`). Lane display names are unique across all Harnesses
  (`control-bridge.ts:106-109`). `isFocused()` is `element.contains(document.activeElement)`
  (`acp-harness-view.ts:2054`).
- **`lane.send`** (`acp-harness-view.ts:2430-2458`): trims the text. It rejects empty text
  (`invalid_request`) and a lane with no client or in `starting`/`error`/`stopped`
  (`lane_not_ready`). It queues for `busy`/`needs_permission`/`awaiting_peer`, up to the cap of 10
  (`queue_full`). Otherwise it calls `sendUserPrompt(lane, text, [], { clearDraft: false })`. It
  never steers (spec 278 Out of Scope) and never touches the lane draft. It does not run `#`
  commands, `!shell` or `{{#verb}}`. It carries no images and records no prompt history.
- **Mention trap**: `sendUserPrompt` first calls `tryMentionFanOut` (:8769), which parses a
  *leading* `@` as a lane mention (`mention-parse.ts:17-77`). `@src/foo.ts explain` gives
  `unknown_lane '@src'` and nothing is sent, yet `lane.send` already replied `started`. A queued
  item is parsed again when it drains (:8885). Text in the dialog that starts with a file token
  would be dropped.
- **Images in the Harness** travel as ACP `image` blocks built from
  `StagedImage { data, mimeType, path }` (`harness-view-types.ts:374-377`, `buildUserBlocks`
  :8919-8930). The limits are `MAX_STAGED_IMAGES = 4` and `MAX_IMAGE_BYTES = 5 MiB`
  (:718-719). A lane that does not advertise image support gets a warning chip but still sends
  (`canStageImage` :15815-15828). A remote Harness refuses local images (:4863, :5393, spec 247
  §Project operations).
- **Caller trust**: `ControlCaller` is created by Rust (`control.rs:107-138`). It is only ever
  `control_api`, `telegram` or `live_assist`, and HTTP callers cannot supply it. A frontend-only
  source therefore cannot be forged over the control API.
- **Window lookup**: `HarnessEntry` holds no window. `ContentView.getLaneMarks?()` (`types.ts:301`)
  lists a pane's lanes, and the compositor walks panes the same way in `closeContentViewHost`
  (`compositor.ts:6705-6724`).
- **Repo prior art**: Raycast "Send Prompt" is a textarea form posting `lane.send`
  (`docs/0205-raycast-extension.md:193`). Live Assist picks a lane in this order: retained, then
  the focused Harness's active lane, then the first (`control-bridge.ts:63-89`).
- **ACP**: every agent must accept `text` and `resource_link` prompt blocks; `image` needs the
  `image` prompt capability.
- **Found while reading**: spec 0063 documents a global `Ctrl+Shift+K`, but `lib.rs:479-509`
  registers only `Ctrl+Shift+S`, `Cmd+Ctrl+Shift+0` and `Ctrl+Shift+I`. The `KeyK` handler branch
  (:138) is never reached. This spec does not touch it.

**Alternatives considered**
- *Fill the lane draft instead of sending*: the draft lands back in the weak composer this
  feature exists to avoid. Rejected.
- *A new control op or a new `HarnessEntry` method*: `lane.send` already owns "deliver a user
  prompt to lane X". A second path would fork queue semantics. Rejected.
- *Steer a busy lane*: the dialog hides the running turn, and spec 278 keeps every external
  sender queue-only. Rejected.
- *`@path` as ACP `resource_link` blocks*: correct protocol, but the composer has no file
  references either. That belongs to its own spec, for both surfaces. Deferred.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Desktop (macOS) | Double-tap `Option` (or `Option+Space`) opens a quick-entry box from any app; Enter sends; the box lists the five most recent conversations | Global composer that dispatches into the main app |
| VS Code | Quick Chat (`workbench.action.quickchat.toggle`) is a light panel at the top of the editor with the same `#`/`@` mentions; "Open in Chat view" continues the thread | Composer separate from the conversation view |
| Zed | `agent: add selection to thread` adds the editor selection as context to the agent panel thread | Context sent into an existing thread from elsewhere |
| tmux | `send-keys -t <target-pane>` types text into a named pane | The PTY path the dialog already uses |

**Krypton delta**: like Claude Desktop and VS Code, the composer is separate from the
conversation. Unlike them, it targets an existing live lane chosen from one keyboard picker that
also lists `claude` terminals, it never starts a new chat, and it does not move focus. The lane
flashes its window and the queue rail shows a queued prompt.

## Affected Files

| File | Change |
|------|--------|
| `src/prompt-dialog.ts` | `DialogTarget` union; enumerate lanes from `HarnessDirectory`; focused-Harness snapshot; picker, chip, footer and error line for lanes; per-target file index; lane submit branch |
| `src/acp/acp-harness-view.ts` | `lane.send` accepts `images` and literal text from `prompt_dialog`; `sendUserPrompt` gets a `literal` option; queue drain passes it on; `controlLaneList` rows gain `remote` |
| `src/acp/harness-view-types.ts` | `QueuedPrompt.literal?: true` |
| `src/acp/control-types.ts` | `ControlCaller.source` gains `'prompt_dialog'` (frontend-only; Rust never emits it) |
| `src/compositor.ts` | `findWindowIdForLane(displayName): WindowId \| null` |
| `src/styles/overlays.css` | `__chip-meta` / `__picker-meta` readouts, `__error` line |
| `src/acp/components/prompt-dialog-send-integration.test.ts` | `lane.send` cases from Edge Cases against a real `AcpHarnessView` (under `components/` for the DOM test project) |
| `docs/0061-…`, `docs/0154-…`, `docs/0005-data-flow.md`, `docs/README.md` | Amended-by line; `prompt_dialog` caller, dialog-only `lane.send` params and `lane.list` `remote` in the trusted-caller contract; data-flow entry; index |

## Design

### Data Structures

```typescript
// src/prompt-dialog.ts — replaces TargetEntry and lastUsedSessionId
type DialogTarget =
  | { kind: 'pty'; key: `pty:${SessionId}`; sessionId: SessionId; windowId: WindowId;
      pid: number; cwd: string | null }
  | { kind: 'lane'; key: `lane:${string}`; harnessId: string; displayName: string;
      backendId: string; status: HarnessLaneStatus; cwd: string | null; remote: boolean;
      queueDepth: number; active: boolean };

let lastUsedTargetKey: string | null = null;   // app-run scoped, like today
private focusedHarnessId: string | null = null; // snapshot taken in open(), cleared in close()

// src/acp/harness-view-types.ts
interface QueuedPrompt { /* existing fields */ literal?: true }
```

### API / Commands

`lane.send` params, unchanged for every caller except `{ source: 'prompt_dialog' }`:

```typescript
{ lane: string; text: string;
  images?: Array<{ data: string /* base64 */; mimeType: string; path: string | null }> }
```

- `images` from any other caller → `invalid_request` "images are accepted only from the prompt
  dialog". The public HTTP contract does not change.
- More than `MAX_STAGED_IMAGES` images, a non-`image/*` type, or data over
  `MAX_IMAGE_BYTES * 1.34` → `invalid_request`. On a remote Harness → `invalid_request`
  "local images are unavailable in a remote Harness". A lane without image support gets the
  existing warning chip and the send goes ahead.
- Empty text is allowed when `images` is non-empty.
- Dialog text is literal: `sendUserPrompt(…, { clearDraft: false, literal: true })` skips
  `tryMentionFanOut`, and a queued item stores `literal: true` so the drain skips it too.
- `lane.list` rows gain `remote: boolean` (`remoteRuntimeId !== null`). The field is additive.

`Compositor.findWindowIdForLane(displayName)` walks `windows` → tabs → panes and returns the
window whose pane's `getLaneMarks?.()` contains `displayName`.

### Data Flow

```
1. Cmd+Shift+K → PromptDialog.open().
2. Before the overlay takes focus, open() snapshots the terminal selection (existing) and
   focusedHarnessId = listHarnessEntries().find((e) => e.isFocused?.())?.harnessId ?? null.
3. refreshTargets() (on open, on process-changed, on picker open):
   a. PTY rows: findSessionsByProcess('claude'), unchanged.
   b. Lane rows: for each listHarnessEntries() entry, await entry.control('lane.list', {});
      narrow each row, drop status 'stopped'.
   c. Order: PTY rows, then lanes in Harness registration order, lane order within.
4. Initial target, first match wins: the active lane of focusedHarnessId; lastUsedTargetKey;
   the first row. When the first rule picked the target, focus goes straight to the textarea.
   Otherwise the picker auto-opens at ≥2 targets, as in 0061.
5. File index for a lane target: loadFileIndex(cwd) when !remote; remote → [] (the @ popup
   offers only @selection).
6. Enter on a lane target:
   a. Expand @selection (0061, unchanged).
   b. images = imageThumbs whose `@<path>` token is still in the text, as {data, mimeType, path}
      with data taken from the data URL; remove each token and its trailing space.
   c. Trimmed text empty and no images → shake (existing).
   d. resolveDisplayName(name) → harnessEntry(id) → entry.control('lane.send',
      { lane, text, images }, { source: 'prompt_dialog' }). A null resolve counts as
      unknown_lane.
   e. 'started' | 'queued' → lastUsedTargetKey = target.key; flashWindow(findWindowIdForLane);
      close().
   f. Any error → keep dialog and text; the footer shows the error message; shake;
      refreshTargets().
7. Harness: idle → sendUserPrompt adds the user row with image thumbnails; busy → the queue rail
   shows the item, which drains on idle (0136).
```

The PTY send path (bracketed paste, `\r`, `flashWindow`) is unchanged.

### Keybindings

No new keys. With a lane target the footer reads `Enter send` (idle) or `Enter queue`
(`busy`/`needs_permission`/`awaiting_peer`), then `⇧Enter newline · ⌘, switch target · Esc close`.

### UI Changes

- Chip, lane target: lit lamp, display name, backend, abbreviated cwd, status label
  (`idle`, `needs permission · queue 2 · remote`). Empty state: `⚠ no target`. Picker empty
  text: "Start `claude` in a tab or open an ACP Harness, then reopen this dialog."
- Picker header: `Select target`. Lane row (`.krypton-prompt-dialog__picker-row--lane`): hotkey,
  display name, backend, abbreviated cwd, the same status label. PTY rows are
  unchanged. Hotkeys `1–9` run across the combined list.
- `.krypton-prompt-dialog__error`: one line in the foot, fault tone (DESIGN.md: colour only for a
  fault). It replaces the hints until the next input or target change.

## Edge Cases

- **Leading file token** (`@src/foo.ts explain`, idle or queued): reaches the agent verbatim; no
  fan-out, no `unknown lane` chip. Covered by a permanent test.
- **Leading `#`, `!`, `{{#verb}}`**: sent to the agent as text, as every `lane.send` does. An
  advertised `/command` stays an agent command (`sendUserPrompt` :8801).
- **Lane closed or Harness disposed after open**: `unknown_lane` / `harness_closed` error line;
  the rows refresh.
- **Lane `starting` or `error`**: listed with its status; send → `lane_not_ready` error line.
- **Queue full**: `queue_full` error line; the text stays.
- **Pending permission or question on the lane**: status is `needs_permission` → queued.
  `lane.send` never answers a prompt or touches the draft.
- **Remote Harness**: no file autocomplete. Images → error line; text alone sends.
- **Image token deleted by the user, or thumbnail ×**: that image is not sent.
- **`images` from the control API, Telegram or Live Assist**: `invalid_request`. Covered by a
  permanent test.
- **Dialog opened from a Harness with no live lanes**: step 4 falls through to
  `lastUsedTargetKey`, then the first row, and the picker rule applies.
- **Opened from a terminal or other view**: `@selection` works as today. A Harness transcript
  selection is not captured (`getFocusedSelection` reads terminals only).
- **Harness still initializing**: not registered in the directory yet → no rows from it.

## Open Questions

None.

## Out of Scope

- Steering a running turn from the dialog.
- Harness `#` commands, `!shell`, `{{#verb}}` expansion and lane-mention fan-out from the dialog.
- Writing into a lane draft instead of sending.
- Recording dialog prompts in the lane's `↑` history or the word-autocomplete log (no other
  `lane.send` caller does).
- `@path` as ACP `resource_link` / embedded resource blocks.
- `@selection` from a Harness transcript or any non-terminal pane.
- Live lane-status updates while the dialog is open, beyond the refreshes in step 3.
- Images over the public control API.
- Registering the global `Ctrl+Shift+K` that spec 0063 describes.
- Better multi-line editing in the lane composer itself.

## Resources

- [ACP — Content](https://agentclientprotocol.com/protocol/content) — `text` and `resource_link` are mandatory for agents; `image` needs the prompt capability; embedded resources are the preferred form for @-mentions.
- [Claude Desktop quick entry](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac) — global composer that dispatches into the main app.
- [VS Code inline chat and Quick Chat](https://code.visualstudio.com/docs/chat/inline-chat) — light composer separate from the chat view, with handoff to the full view.
- [Zed actions — `agent: add selection to thread`](https://zed.dev/docs/all-actions) — sending context into an existing agent thread from the editor.
- [tmux(1) `send-keys`](https://man7.org/linux/man-pages/man1/tmux.1.html) — dispatching text to a named pane target.
