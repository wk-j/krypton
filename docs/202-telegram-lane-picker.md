# Telegram Lane Picker — Implementation Spec

> Status: Implemented (live Telegram validation pending)
> Date: 2026-07-24
> Milestone: M8 — Polish

## Problem

Selecting a Telegram target currently requires typing an exact lane display name,
for example `/use Claude-1`. That is slow on a phone, easy to mistype, and
unnecessary when Krypton already has the live lane list.

## Solution

Publish Krypton's common commands into Telegram's native bot menu and turn bare
`/use` and `/lanes` into a paged inline lane picker. A user chooses `/use` from
the menu and taps a lane; the existing `/use <exact-lane>` form remains as a
power-user and compatibility fallback. Button presses use short-lived opaque
nonces, repeat the numeric user/chat authorization checks, and verify the exact
live lane snapshot before changing the chat target.

## Research

- Telegram's bot menu exposes registered commands near the message field, so
  users can choose `/use` without remembering or typing it. `setMyCommands`
  accepts up to 100 lowercase command descriptors.
- Inline keyboards are intended for changing settings or choosing options
  without sending another user-authored message into the chat. They work in
  private chats and groups, unlike Mini App buttons, which have private-chat
  constraints.
- Callback payloads are limited to 1–64 bytes and clients show a progress
  indicator until the bot calls `answerCallbackQuery`. The payload therefore
  cannot safely carry arbitrary lane names or full operation parameters, and
  acknowledgment must precede control dispatch.
- Telegram warns that callback data may be stale or client-supplied. A button is
  a convenience capability, not proof of authorization; Krypton must look up an
  opaque action, bind it to the originating chat, and re-check the clicking
  numeric user and group allowlists.
- Krypton already gets globally unique `displayName`, `harnessId`, `sessionId`,
  status, and model fields from `lane.list`. The TypeScript control bridge stays
  the live-state authority; the Telegram backend only retains a short-lived
  selection snapshot.
- `docs/200-telegram-harness-controller.md` already reserved an opaque,
  process-local callback-action design, but the shipped controller currently
  requests only `message` updates. This feature implements the first callback
  surface without exposing generic agent-authored buttons.

## Prior Art

| App | Implementation | Notes |
| --- | --- | --- |
| Telegram bot platform | Native command menu plus inline keyboards under the relevant bot message | Recommends editing the existing keyboard for smoother option navigation |
| OpenClaw | Registers Telegram commands and supports allowlist-scoped inline callback buttons | General agent-authored buttons are broader than Krypton's fixed lane picker |
| Home Assistant | Sends inline keyboard choices, receives callback events, answers the callback, and can edit the keyboard/message | Demonstrates the established choose-then-edit interaction |

**Krypton delta** — Krypton follows Telegram's familiar command-menu and inline
picker interaction, but buttons are generated only by the trusted controller
for live lanes. Button data never contains a lane name, operation, prompt, or
credential, and it never reaches an ACP agent as text.

## Affected Files

| File | Change |
| --- | --- |
| `src-tauri/src/telegram.rs` | Register the bot menu, render lane keyboards, receive and authorize callback queries, manage short-lived actions, and add Bot API request helpers/tests |
| `docs/200-telegram-harness-controller.md` | Mark the lane-picker callback slice implemented and reconcile command/transport behavior |
| `docs/04-architecture.md` | Record the backend-owned callback registry and live-snapshot validation boundary |
| `docs/05-data-flow.md` | Document command-menu discovery and callback selection flow |
| `docs/PROGRESS.md` | Record the completed capability and verification |

No frontend, Settings-view, CSS, configuration, database, or control-operation
change is required.

## Design

### User Interaction

After Krypton verifies the bot token, Telegram's bot menu contains `/use`
(choose target), `/lanes`, `/status`, `/ask`, `/cancel`, `/new`, `/restart`,
`/transcript`, and `/help`, each with a short plain-language description.

Advanced commands remain usable and listed in `/help`; they do not need to
crowd the primary menu. `setMyCommands` is best-effort: a failure is sanitized
and logged but does not stop long polling or make the controller unhealthy.

Bare `/use` and `/lanes` produce the same picker:

```text
Choose a target lane · 1/2
Current: Claude-1

Claude-1 · idle · claude-sonnet
Codex-1 · busy · gpt-5
...

[✓ Claude-1] [Codex-1]
[  Cursor-1] [  Pi-1]
[‹ Previous] [↻ 1/2] [Next ›]
```

- Pages contain at most eight lanes, in `lane.list` order.
- Lane buttons use two columns and display only `✓` plus the globally unique
  display name; status/model remain in the message where they do not make
  buttons too wide.
- The current target receives `✓` only when its harness, display name, and
  session snapshot still match.
- The center navigation button refreshes the current page from live state.
- A single page omits navigation controls.
- No live lanes produces `No live lanes.` with no keyboard.
- `/use <exact-display-name>` keeps its current direct-selection behavior.

On successful selection, Krypton edits the picker message in place, removes the
keyboard, and shows the existing compact confirmation:

```text
Target selected: Claude-1
State: idle
Telegram turns: BYPASS ALL
```

If editing fails, Krypton sends that confirmation as a new plain message.
Picker and confirmation messages stay on the plain Bot API path regardless of
the optional rich-answer setting.

### Data Structures

```rust
const TELEGRAM_ACTION_TTL_SECS: u64 = 300;
const TELEGRAM_ACTION_CAP: usize = 512;
const LANE_PICKER_PAGE_SIZE: usize = 8;

#[derive(Debug, Clone)]
struct TelegramAction {
    chat_id: String,
    expires_at: u64,
    claimed_by_update: Option<i64>,
    kind: TelegramActionKind,
}

#[derive(Debug, Clone)]
enum TelegramActionKind {
    SelectLane {
        harness_id: String,
        lane: String,
        session_id: Option<String>,
    },
    ShowLanePage {
        page: usize,
    },
}

struct TelegramInner {
    // existing fields...
    actions: Mutex<HashMap<String, TelegramAction>>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramUpdate {
    update_id: i64,
    message: Option<TelegramMessage>,
    callback_query: Option<TelegramCallbackQuery>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramCallbackQuery {
    id: String,
    from: TelegramUser,
    message: Option<TelegramCallbackMessage>,
    data: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramCallbackMessage {
    message_id: i64,
    chat: TelegramChat,
}
```

Action nonces contain 96 random bits encoded as `lp:<24 lowercase hex chars>`,
well below Telegram's 64-byte limit. They are unpredictable and process-local.
The first callback update atomically claims an action; only a retry of that same
update ID may use it again.

Before issuing a picker, prune expired actions. When the cap is reached after
pruning, remove the action with the earliest expiry before inserting another.
Clear all actions on controller restart/shutdown and when all targets are
invalidated after a user-allowlist removal. Removing a group clears actions
bound to that chat.

### Bot API

`BotApi` gains:

```rust
async fn set_commands(&self) -> Result<(), String>;
async fn send_keyboard(
    &self,
    chat_id: &str,
    text: &str,
    keyboard: Value,
) -> Result<i64, String>;
async fn edit_keyboard(
    &self,
    chat_id: &str,
    message_id: i64,
    text: &str,
    keyboard: Option<Value>,
) -> Result<(), String>;
async fn answer_callback(
    &self,
    callback_query_id: &str,
    text: Option<&str>,
) -> Result<(), String>;
```

Pure builders produce `setMyCommands`, `sendMessage`, `editMessageText`, and
`answerCallbackQuery` bodies. Keyboard bodies use only:

```json
{
  "reply_markup": {
    "inline_keyboard": [
      [{ "text": "Claude-1", "callback_data": "lp:..." }]
    ]
  }
}
```

`edit_keyboard(..., None)` sends an empty `inline_keyboard` to remove the old
buttons. `getUpdates.allowed_updates` changes from `["message"]` to
`["message", "callback_query"]`.

### Callback Admission and Selection

Callback handling is separate from ordinary message intent parsing:

1. Read `callback_query`; ignore inline-mode callbacks without an originating
   chat message, but still answer them so Telegram clears the progress state.
2. Call `answerCallbackQuery` without notification text before authorization,
   action lookup, or any `ControlServer::dispatch`.
3. Canonicalize `from.id` and the message's `chat.id`.
4. Re-read Telegram settings. Require an authorized numeric user; for a group
   or supergroup, also require the numeric chat allowlist. An unauthorized
   callback receives no chat message and performs no lookup or mutation.
5. Atomically claim the nonce for this update ID. Require an unexpired action
   whose `chat_id` equals the callback message's chat. Unknown, claimed by a
   different update, expired, or cross-chat actions produce
   `Picker expired. Send /use again.` only for an authorized click.
6. `ShowLanePage` dispatches a fresh `lane.list`, clamps the requested page
   after additions/removals, creates replacement action nonces, and edits the
   originating message with the refreshed picker.
7. `SelectLane` dispatches a fresh `lane.list` and matches all three snapshot
   fields: `harnessId`, `displayName`, and `sessionId` (including `null`).
8. On an exact match, store the existing `TelegramTarget`, edit away the
   keyboard, and show confirmation. On mismatch, do not retarget; replace the
   picker with fresh live lanes and state that the lane changed.
9. Remove the action after a terminal result. If `lane.list` returns the
   existing retryable control timeout, retain the same-update claim and leave
   the watermark unchanged; Telegram redelivery can safely repeat that read.

The callback's `update_id` remains part of `ControlCaller::Telegram`, so
`lane.list` keeps the existing deterministic operation ID and retry behavior.
Button selection changes only Rust's per-chat target; it does not create a new
control operation or move lane authority out of the frontend.

### Data Flow

```text
1. Bot startup verifies getMe and best-effort publishes setMyCommands.
2. User chooses /use from Telegram's native command menu.
3. TelegramService dispatches lane.list through the existing control boundary.
4. Rust creates five-minute opaque actions and sends a plain inline keyboard.
5. User taps Claude-1; Telegram delivers callback_query.
6. Rust immediately answers the callback, then repeats user/chat authorization.
7. Rust consumes the nonce and dispatches a fresh lane.list.
8. Exact harness + display-name + session match becomes the chat target.
9. Rust edits the picker into a button-free target confirmation.
```

## Edge Cases

- **Picker older than five minutes or application restarted:** acknowledge the
  click, do not mutate state, and ask the authorized user to send `/use` again.
- **Lane closed, renamed, or started a new session after rendering:** refresh
  the picker; never select a same-named replacement silently.
- **Another authorized group member clicks:** allowed; the group intentionally
  shares one target, matching the existing chat-keyed target contract.
- **Unauthorized member clicks a visible group button:** clear only that user's
  callback spinner; send no chat response and change no state.
- **Two users click the same button concurrently:** claiming the nonce is
  atomic; only the first update proceeds.
- **Navigation page becomes empty:** clamp to the last existing page.
- **Keyboard send/edit failure:** remove newly issued actions for that response
  where possible and fall back to the current text lane list or confirmation.
- **Command-menu registration failure:** keep polling and retain typed command
  compatibility.
- **Rich messages enabled:** control pickers remain plain and compatible.

## Verification

- Unit-test command descriptors against Telegram's lowercase/name/length
  constraints.
- Unit-test keyboard payloads, two-column/page layout, selected marker,
  navigation controls, and removal markup.
- Unit-test nonce length, randomness shape, expiry, same-update retry,
  cross-update rejection, chat binding, cap pruning, and concurrent claiming.
- Deserialize representative private and group `callback_query` updates.
- Unit-test private/group allowlist decisions independently from message
  `group_intentional` rules.
- Unit-test exact snapshot matching, including session changes and `null`
  session IDs.
- Use a local fake Bot API server to assert request shapes for
  `setMyCommands`, callback-enabled `getUpdates`, keyboard send/edit, and
  `answerCallbackQuery`; no real token or network is required.
- Run `cargo fmt -- --check`, focused Telegram tests, full `cargo test`, and
  `cargo clippy --all-targets -- -D warnings`.
- Manually verify on an operator-owned bot: command-menu discovery, private
  selection, group selection by two authorized members, stale picker, and an
  unauthorized group-member click.

## Open Questions

None. Approval of this spec chooses the native command menu plus inline picker
as the primary flow, with exact typed `/use <lane>` retained as fallback.

## Out of Scope

- Generic agent-authored Telegram buttons or arbitrary callback operations
- Permission accept/reject, model, directive, or other controller submenus
- Reply keyboards that replace the user's phone keyboard
- Mini Apps, hosted web UI, inline-bot mode, deep links, or media
- Persisting picker actions across Krypton restarts
- Changing the shared-target semantics of group chats
- Replaying a prompt that was attempted before a target was selected

## Resources

- [Telegram Bot Features](https://core.telegram.org/bots/features) — command menus, inline keyboards, and edit-in-place UX guidance
- [Telegram Bot API — InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton) — callback payload shape and 1–64 byte limit
- [Telegram Bot API — CallbackQuery](https://core.telegram.org/bots/api#callbackquery) — stale-data warning and mandatory acknowledgment behavior
- [Telegram Bot API — answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery) — clears the client progress indicator
- [Telegram Bot API — setMyCommands](https://core.telegram.org/bots/api#setmycommands) — native command-menu registration contract
- [OpenClaw Telegram channel](https://docs.openclaw.ai/channels/telegram#inline-buttons) — command registration and allowlist-scoped button prior art
- [Home Assistant Telegram Bot](https://www.home-assistant.io/integrations/telegram_bot) — inline keyboard, callback, and edit-message prior art
