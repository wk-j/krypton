# Harness Follow-up Prompts — Implementation Spec

> Status: Implemented (rev 4 — paste is an icon inside the prompt card)
> Date: 2026-10-23
> Milestone: ACP Harness — transcript
> Builds on: 0323 (follow-up actions) · 0306 (assist sidecar) · 0136 (prompt queue) · 0278 (steer)

## Problem

User, 2026-10-23: "For follow up job, I should be able to interfact current harness lane by inject prompt like this, because this is not terminal command". The screenshot shows a `run` button labelled "post load-test review summary to #1329" whose command is `post-github-comment`, a skill name. The next step is work for the agent, not for a shell, and the rail has only two kinds: `run` (a terminal tab) and `open` (the browser). Since 0323 rev 5 a one-word span is never a candidate, so this button now disappears, but nothing replaces it.

**Rev 2 requirement (user, 2026-10-23):** "The UI should have option to direct send to lane and just paste into prompt input". Every prompt button offers both: send it to the lane now, or paste it into the composer to edit and send by hand.

**Rev 3 requirement (user, 2026-10-23):** "Make sense what? it try to inject after all commit there is nothing left to commit". A reply reported two finished commits and ended with a hedge: if the human would rather have spec 0323 rev 5 in its own commit, the agent could split `023845b`. The model turned that hedge into a prompt button ("split out spec 0323 rev 5 commit") in 3 of 3 real haiku calls. The human had just received the result they ordered, so the button offered to redo it. A prompt must now continue from the delivered result: an offer to redo, split, squash, revert or restructure the finished work never becomes a button, even when the reply makes it.

**Rev 4 requirement (user, 2026-10-23):** "REmove this ugly paste button move to the card with icon instead". Rev 2 drew paste as a second bordered button labelled `paste` beside the card. It is now a clipboard icon inside the prompt card's right edge.

## Solution

Add a third follow-up kind, **`prompt`**: a message for the lane that owns the reply. The assist model writes it, at most 240 characters, for a step the reply itself offered ("Want me to post this to #1329?") that continues from the result the turn delivered, never one that redoes that result another way. The button shows the full message and offers two options:

- **Send.** A click on the button or its `f` hint sends it through the composer's queue path. An idle lane starts a turn, and a busy lane queues the message.
- **Paste.** A click on its paste icon (a clipboard inside the card's right edge), or `Shift` + its hint, inserts it into the composer at the cursor, as `Cmd+V` does. Nothing is sent.

`run` and `open` do not change: their targets still come only from candidates.

## Research

- **The send path already exists.** `submitLanePrompt(lane, text, images, clearComposer?, delivery)` (`acp-harness-view.ts:8391-8463`) is the composer's shared tail. It handles, in order:
  - a leading `#` (hash command) and a leading `!` (shell);
  - the not-ready guard (`lane <status>` chip);
  - `{{#verb}}` expansion;
  - a busy lane: `steer`, or queue up to `PROMPT_QUEUE_MAX`;
  - otherwise `sendUserPrompt`, which appends the user row and starts the turn.

  Passing `clearComposer = undefined` leaves the draft and staged images alone, as the orchestrator seat does (`:6168`).
- **Delivery.** Composer `Enter` steers and `Cmd+Enter` queues (`:4601`). A follow-up must not redirect a running turn, so it always uses `'queue'`.
- **Mentions.** `resolveMentionTargets` (`:2451-2454`) only parses text that starts with `@`. A prompt that does not start with `@` cannot fan out to another lane.
- **Model-written prompts have a precedent.** `next-prompt` asks for `{"label","prompt"}` and keeps prompts of 8–240 characters (`next-prompt.ts:19-20`, `:154-159`). `Cmd+1..3` loads one into an empty draft (`harness-assist-controller.ts:157-168`). Its prompts are ideas for new work. A follow-up prompt is only a step the reply offered.
- **Eligibility.** `followUp.eligible` is true only when a candidate exists (`follow-up.ts:210-212`). A prompt needs no candidate. The controller already skips turns with fewer than 40 assistant characters (`harness-assist-controller.ts:39`, `:337-340`), and the remote gate (`:329`) stays.
- **Dispatch.** `runFollowUp` (`acp-harness-view.ts:9924-9947`) branches on `followUpKind`. The click handler (`:6365-6372`) and the hint dispatch (`:9872-9873`) already call it for every kind.
- **The paste path already exists.** `insertDraft(lane, text)` (`acp-harness-view.ts:15367-15379`) is what `Cmd+V` calls (`:4656`). It inserts at `lane.cursor` and keeps the existing draft. Its `setDraft` sets `focus = 'text'` (`:15465`) but does not re-sync the root classes. `syncRootClasses()` (`:12522-12523`) drops `acp-harness--transcript-focus`.
- **Shift on a hint label has a precedent.** An SVG card's `Shift+<label>` copies instead of zooming (`:9882`).

### Alternatives rejected

- **One option only.** The user asked for both. Send alone gives no way to edit the message, and paste alone costs a second keystroke for every use.
- **`next-prompt`'s draft path (`Cmd+1..3`).** It refuses while a draft exists ("assist: clear the draft first"). A paste inserts at the cursor instead, as `Cmd+V` does.
- **Paste only through a modifier (`Shift`+click).** A mouse user could not see that the option exists. The paste icon shows it, and `Shift`+hint is the keyboard path.
- **Send the picked span itself.** `post-github-comment` alone carries no target. `#1329` lives in the prose around it.
- **Classify one-word spans deterministically.** The same span could be a skill, a CLI, a branch or a symbol. Only the prose says which, and reading prose is the model's job.
- **Let the model also write `run` commands.** The reason in 0323 still holds: a shell command nobody wrote must never sit behind a button. A prompt goes to the agent, which reads it with its own context and permission mode.
- **Filter rework prompts by keyword (`split`, `revert`, `squash`).** The same words name forward steps a reply offers ("revert the bad deploy"). Only the reply says whether the step reworks what the turn just finished.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code chat API | `ChatFollowup { prompt, label?, participant?, command? }`: "The user can click the followup to send it to the chat." By default it goes to the same participant | Closest match: a click sends the prompt to the same conversation |
| Warp | *Prompt Suggestions* appear as chips (cited in 0323) | Latest block only; nothing persists |
| Krypton `next-prompt` (0306) | Strip above the composer; `Cmd+1..3` loads into the draft. Removed on 2026-10-23, after this spec shipped | Latest turn only; ideas, not offered steps |

**Krypton delta.** As in VS Code, a click sends to the same conversation (the owning lane). Unlike VS Code, the button shows the full message rather than only a label, because a click starts agent work. The message sits beside `run`/`open` buttons under the reply that offered it and stays reachable by scrolling.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/assist/types.ts` | `followUpKind: 'run' \| 'open' \| 'prompt'`; `target` doc names the message |
| `src/acp/assist/tasks/follow-up.ts` + test | `eligible`, `system`, `payload` (`(none)`), `parse` prompt entries |
| `src/acp/harness-assist-controller.test.ts` | The no-candidate case now makes a call; an empty answer paints no rail |
| `src/acp/acp-harness-view.ts` | `runFollowUp` `prompt` branch; `pasteFollowUp`; click branch for `[data-follow-up-paste]`; `Shift` on a prompt hint |
| `src/acp/components/follow-up-rail/index.ts`, `.css`, test | Prompt card: send button plus paste icon; `Send …` / `Paste into prompt: …` aria-labels; `--prompt` glyph colour |
| `src/acp/harness-icons.ts` | `krypton-icon-follow-up-prompt` and `krypton-icon-follow-up-paste` symbols |
| Docs | 0323 (eligibility, edge cases, Out of Scope "any kind beyond `run`/`open`"), 0306 addendum, 0004, 0005, 0006, 0072, 0206, `README.md` index |

## Design

### Data structures

```ts
export interface FollowUpAction {
  readonly followUpKind: 'run' | 'open' | 'prompt';
  readonly label: string;   // model-written, 1..40 characters
  /** `run`: command and `open`: URL, both copied from a candidate; `prompt`: the message sent to the lane. */
  readonly target: string;
  hintLabel: string | null;
}
```

### Task — `follow-up.ts`

- **`eligible(ctx)`** is `followUpReply(ctx) !== null`. A reply with no candidate now costs one call; the model answers `{"actions":[]}` when the reply offers nothing.
- **`payload`** is unchanged, except that an empty candidate list prints `(none)` under `--- candidates ---`.
- **`system(cfg)`:**

  > You read the final reply of a coding agent and a numbered list of candidates copied from it. Offer the human at most N next actions, most useful first. Reply with JSON only: `{"actions":[{"id":N,"label":"…"},{"prompt":"…","label":"…"}]}`. An `id` entry picks a candidate to run or open. Pick a candidate only if the reply tells the human to run or open it, or if it installs, builds, tests, starts or shows what the turn just made. A run candidate is typed into a shell exactly as written, so never pick one that is not a complete command. Never pick a file path, a symbol, an example, a command the reply says already ran, or a command the reply warns against. A `prompt` entry is a message sent to the agent itself, for a step the agent should take rather than a shell command, such as posting a comment, opening a pull request, committing or using a skill. Write one only when the reply offers that step or asks whether to take it, never an idea of your own. The step must continue from the result the turn delivered: never offer to redo, split, squash, revert or restructure what the turn just finished, even when the reply offers that. The prompt is one or two sentences in the reply's language, at most 240 characters. It names every target the reply gave (issue number, branch, skill), and it never starts with `#`, `!`, `/` or `@`. `label` is at most 40 characters, lower case, no trailing period, and says what the action does (for a candidate, what its exact text does), never an action it does not perform. If nothing qualifies, reply `{"actions":[]}`. No prose outside the JSON.

- **`parse(raw, cfg, ctx)`**, per entry and in order, sharing one `count` cap:
  - An entry with a non-null `id` takes the candidate path, which is unchanged; a `prompt` field on it is ignored. `"id": null` counts as no `id`.
  - An entry with no `id` and a string `prompt` takes the prompt path:
    - Whitespace is collapsed to single spaces and trimmed.
    - The prompt is dropped when it is outside 8–240 characters. It is never cut, because a cut request is a different request.
    - It is dropped when it starts with `#`, `!`, `/` or `@`. In `submitLanePrompt` those prefixes mean a hash command, the shell, an agent slash command or another lane.
    - It is dropped when it contains `{{#`, because verb expansion would send text the button never showed.
    - It is dropped when it repeats an earlier prompt.
    - The label rules are the existing ones.
    - The result is `{ followUpKind: 'prompt', label, target: prompt, hintLabel: null }`.

### Execution — `AcpHarnessView`

```
Send: a click on the button, or its hint label → runFollowUp(action), kind 'prompt'
1. lane = activeLane(): the rail is only on the active lane's rows, so this is the owner
2. submitLanePrompt(lane, action.target, [], undefined, 'queue')
   idle                     → sendUserPrompt: user row appended, turn starts
   busy / needs_permission  → queued, chip `queued (n)`; drains on the next idle
   starting / error / stopped → chip `lane <status>`; nothing sent
3. The draft, staged images, prompt history and the 0285 word log are untouched
   (the human did not type it).

Paste: a click on the paste icon, or Shift + the hint label → pasteFollowUp(action)
1. insertDraft(lane, action.target): inserted at the cursor, existing draft kept
2. syncRootClasses(); element.focus({ preventScroll: true }), so typing and
   Enter go to the composer
3. Nothing is sent; any lane status is fine
```

Neither option changes the row or its rail.

### UI

```
FOLLOW-UP
╭────────────────────────────────────────────────────╮
│ (≡) post load-test review summary to #1329     [P] │
│     Post the load-test review summary to #1329     │
│     with the post-github-comment skill.            │
╰────────────────────────────────────────────────────╯
```

`(≡)` stands in for the speech-bubble icon and `[P]` for the clipboard icon.

- **DOM.** A `run` or `open` action stays one `button` in the list. A button cannot contain a button, so a `prompt` action is a `div.acp-harness__followups-item`, the card, holding two buttons:
  - the send button: the same `button.__btn.__btn--prompt[data-follow-up-index=N]` as the other kinds;
  - `button.__paste[data-follow-up-index=N][data-follow-up-paste][title="Paste into prompt"]`, containing a `span.__hint` and a `span.__paste-glyph` with the clipboard icon. It has no text.
- **Hint.** In hint mode the paste icon's hint reads `⇧<label>`, the send button's label with Shift. Outside hint mode it is empty and hidden. Each prompt action takes one hint label.
- **Layout.** The card is a flex row as wide as the list. It carries the 1px border and the hover tint, so send and paste read as one action. The send button has no border and grows (`flex: 1`). The paste icon sits inside the right edge on the label's row, muted (`--krypton-ink-3`) until hovered, when it brightens over an 18% accent tint. The right edges of every action still line up.

- **Icon.** `krypton-icon-follow-up-prompt`: a speech bubble with a tail at the bottom left and two text lines inside. It uses the same 16×16 frame, `1.35` stroke and round caps as the run and open icons:

  ```
  M3.8 3 H12.2 A1.4 1.4 0 0 1 13.6 4.4 V9.2 A1.4 1.4 0 0 1 12.2 10.6 H7.2 L4.6 13 V10.6 H3.8 A1.4 1.4 0 0 1 2.4 9.2 V4.4 A1.4 1.4 0 0 1 3.8 3 Z
  M5.2 5.9 H10.8
  M5.2 7.9 H9
  ```

  `krypton-icon-follow-up-paste`, in the same frame and stroke: a clipboard with its clip at the top and two text lines inside.

  ```
  M5.6 3.3 H4.3 A1.2 1.2 0 0 0 3.1 4.5 V12.7 A1.2 1.2 0 0 0 4.3 13.9 H11.7 A1.2 1.2 0 0 0 12.9 12.7 V4.5 A1.2 1.2 0 0 0 11.7 3.3 H10.4
  rect x=5.6 y=2.1 width=4.8 height=2.4 rx=0.7
  M5.7 7.6 H10.3
  M5.7 10 H8.9
  ```

- **Colour.** `.acp-harness__followups-btn--prompt .acp-harness__followups-glyph` uses `rgb(var(--krypton-info-rgb, …))`. That is distinct from the run icon (window accent) and the open icon (`--krypton-special-rgb`).
- **Text.** The send button's aria-label is `Send <target>`. The paste icon's aria-label is `Paste into prompt: <target>`, and its tooltip is `Paste into prompt`. The deps and the click/hint contract are the same as for the other kinds. The message is shown in full in `code.__target`.

### Keybindings

No new chord.

| Key | Context | Action |
|-----|---------|--------|
| `<label>` | open-hint mode, prompt follow-up | Send it to the lane |
| `Shift+<label>` | open-hint mode, prompt follow-up | Paste it into the composer |
| click | prompt card / its paste icon | Send / paste |

`run` and `open` ignore `Shift`, as before.

### Configuration

No new key. `count` caps all three kinds together. The cost note in 0006 changes: with `mode = "auto"`, every finished reply of 40 characters or more costs one cheap-model call, not only replies with a candidate.

## Edge Cases

- **The reply offers nothing:** the call returns `[]`, and no rail appears.
- **The model writes a prompt the reply never offered:** the full message is on the button, and nothing is sent without a click.
- **The reply offers to redo the finished work another way** ("if you'd rather have these as separate commits, I can split it"): no prompt. The human already has the result they asked for, and a different shape is theirs to ask for.
- **A prompt from an old reply:** it is sent now, into the lane's current session. The text says what it asks.
- **The lane is in `bypass` mode:** the agent acts as if the human had typed the prompt.
- **`@name` or `#1329` inside the text:** sent to this lane as text. Only a leading `@` or `#` is routed, and parse rejects those.
- **The queue is full:** the existing `queue full (N)` chip; nothing is sent.
- **Paste with a draft already typed:** inserted at the cursor, as `Cmd+V` does. The existing text stays.
- **Paste while the lane is busy or not ready:** allowed. It only edits the draft, and sending it later goes through the composer's own rules.
- **An entry has both `id` and `prompt`:** the candidate wins.
- **A Thai reply:** the prompt is in Thai. Its length is counted in UTF-16 code units.
- **Remote harness:** no follow-ups of any kind, because the 0323 gate stays.

## Verification Plan

- Unit tests for parse:
  - valid prompts;
  - prompts that are too short or too long;
  - each forbidden prefix;
  - `{{#`;
  - duplicates;
  - the shared `count` cap with mixed kinds;
  - `eligible` without candidates.

  Also the rail: a prompt card has the send button and the paste icon with their aria-labels and the `⇧` hint. And the updated controller case.
- Real `claude -p --model haiku` calls with the new prompt:
  - a reply ending "Want me to post the load-test review summary to #1329 with `post-github-comment`?" gives one `prompt` action naming #1329;
  - the `make install` / docs URL reply gives `run`/`open` actions and no invented prompt;
  - "All done, nothing else to do." gives `[]`;
  - the rev 5 reply "Pushed to `origin/main` as `b6c2b6d3`. You can review the change in that commit." gives `[]`: the reply offers the human a review, not an agent step.
- In-app, run `npx tauri dev`:
  - Click a prompt follow-up on an idle lane: a user row appears and a turn starts.
  - Click one on a busy lane: the `queued (n)` chip appears, and the prompt is sent when the turn ends.
  - Click the paste icon, or press `Shift`+hint: the text lands at the composer cursor, the composer has focus, and nothing is sent.

## Implementation Notes

- **Label clause.** The label sentence keeps the 0323 rev 5 wording for candidates ("what its exact text does"), so the hash fix does not depend on new phrasing. The draft's shorter clause would have dropped it.
- **`"id": null`.** The model may write `"id": null` on a prompt entry. That entry takes the prompt path, not the candidate path.
- **Paste icon (rev 4).** Rev 2 drew paste as a second bordered ghost button labelled `paste`, centred beside the card. The user found it ugly. The border moved from the send button to the item, so send and paste are one card, and the paste control became a muted clipboard icon on the label's row.

**Verified:**

- `npx vitest run src/acp`: 161 files, 2115 tests passed; `npm run check` exited 0. The new tests cover:
  - prompt parsing (whitespace, shared cap, `"id": null`, each routed prefix, `{{#`, length, repeats, `id` wins);
  - `eligible` and `(none)` without candidates;
  - the rail's prompt item (indices, aria-labels, `⇧` hint);
  - the controller writing a prompt onto a candidate-less reply.
- Real `claude -p --model haiku`, 3 calls per reply:
  - the #1329 reply gave one `prompt` each time, naming #1329 and `post-github-comment`;
  - the `make install` reply gave `run`/`open` only;
  - the "All done" and `b6c2b6d3` replies gave `[]`;
  - a Thai reply offering a PR gave a Thai prompt each time.
- A throwaway Chromium render of the real `FollowUpRail` with the real stylesheet and icon defs (rev 4):
  - the prompt card spans 64–894px, the same as the `run` and `open` buttons;
  - the send button spans 65–866px and the paste icon 866–889px; the icon's box (147–162px) matches the label's row;
  - the card has the 1px border and the send button has none;
  - the paste icon computed to `rgba(216, 232, 240, 0.55)`, and on hover to `0.95` over an 18% accent tint while the card took the 8% tint and the 55% border;
  - hint mode painted `d` / `⇧d`;
  - `closest('[data-follow-up-index]')` resolved the icon's `svg` and `use` to the paste button, and the message and glyph to the send button.
- A throwaway vitest called the real `runFollowUp`, `pasteFollowUp`, `submitLanePrompt`, `insertDraft` and `handleOpenHintKey` against a stub host:
  - an idle lane sent the text and left the draft alone;
  - a busy lane queued it with `queued (1)` and did not steer;
  - a `starting` lane flashed `lane starting`;
  - paste inserted at cursor 5 of `hello world`, then synced the root classes and focused the view;
  - `Shift+A` pasted, and `a` sent.
- Rev 3, real `claude -p --model haiku` with the real `system` and `payload`:
  - the two-commit report that ends with the split offer: the rev 2 prompt gave a split prompt 3 of 3 times; the rev 3 prompt gave `[]` 2 of 2;
  - a reply that squashed three fixes and offers to split them back: rev 2 gave a split prompt 2 of 2; rev 3 gave `[]` 2 of 2;
  - forward offers still give a prompt with rev 3: the #1329 reply 2 of 2, "Want me to push the branch and open a PR against `main`?" 2 of 2, and a Thai reply offering a PR 6 of 6 (5 in Thai, 1 in English);
  - the "All done" and `b6c2b6d3` replies gave `[]` 2 of 2 each.
- **Not exercised:** a click inside the running Tauri app. It needs a rebuilt app with `#assist follow-up auto` and a lane turn.

## Open Questions

None.

## Out of Scope

- Editing the message on the button itself.
- Agent slash commands, `#` commands and backend-specific skill syntax.
- Steering a running turn.
- Sending to any lane other than the reply's owner.
- Prompt follow-ups on a remote harness.
- A "sent" mark on the button.
- Removing `next-prompt`. The user ordered that separately on 2026-10-23; the 0306 addendum records it.

## Resources

- [VS Code API — `ChatFollowup` / `ChatFollowupProvider` (vscode.d.ts)](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts): "The user can click the followup to send it to the chat." By default a follow-up goes to the same participant.
- [Warp — Active AI Recommendations](https://docs.warp.dev/agents/local-agents/active-ai/): prompt-suggestion chips (already cited by 0323).
- `docs/0323-harness-follow-up-actions.md`, `docs/0306-harness-assist-sidecar.md`, `docs/0136-acp-harness-prompt-queue.md`, `docs/0278-acp-harness-steering.md`, `docs/0285-harness-word-autocomplete.md`: Krypton precedents.
