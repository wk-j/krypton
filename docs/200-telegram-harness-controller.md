# Telegram Harness Controller — Implementation Spec

> Status: Core implemented (lane-picker callbacks implemented; remaining callback menus and live Bot API validation remain)
> Date: 2026-07-24
> Milestone: M-ACP — Harness convergence

## Decision Summary

Add a Telegram bot as a full remote-control surface for Krypton's running ACP
harnesses. The bot runs only while the Krypton desktop application is running,
uses Telegram Bot API long polling from Rust, reuses the existing authenticated
control dispatch and live control-event stream, and never becomes a second
harness authority.

The approved product contract is:

- authorized Telegram users can perform every operation advertised by the
  existing Harness Control API;
- private chats require an authorized numeric user ID;
- groups require both an authorized numeric sender ID and an authorized numeric
  group chat ID;
- each chat selects one process-local target lane, and selection also subscribes
  that chat to all observable activity from that shared lane;
- private-chat text is sent directly; group text is sent only through `/ask`, an
  `@bot` mention, or a reply to the bot;
- a Telegram-originated prompt always runs with a turn-scoped bypass policy:
  every permission request, including high-risk commands, is accepted
  automatically for that turn only;
- assistant output streams as a compact operational digest; thought/reasoning
  events are never forwarded;
- the bot token lives only in the operating-system credential vault;
- allowlists and enablement are managed in a dedicated keyboard-first Telegram
  Settings view;
- pairing is the recommended enrollment path, with manual numeric-ID entry as a
  fallback.

This document was approved before implementation began.

## Problem

Krypton's existing Harness Control API and `kryptonctl` can fully control a
running harness from the same machine, and its event stream can mirror live lane
activity. They do not provide a remote conversational surface that works from a
phone.

A Telegram integration looks simple if treated as “forward messages to a
lane,” but that framing misses the real safety and state problems:

1. a Telegram bot token exposes a public-cloud ingress into local command
   execution;
2. groups identify both a conversation and an acting person, so authorizing only
   one of them is insufficient;
3. a Telegram chat needs an explicit lane target and subscription lifecycle;
4. Telegram updates can be duplicated, delayed, retried, edited, or delivered
   after a local state transition;
5. long agent output must fit Telegram's message/edit limits without exposing
   private reasoning or raw tool payloads;
6. prompt queueing must preserve both trusted sender provenance and the
   Telegram-specific bypass policy until the queued turn actually starts;
7. Krypton's TypeScript frontend must remain the sole harness authority
   (ADR-0007).

## Goals

1. Give an authorized Telegram user full parity with the existing Harness
   Control API while Krypton is running.
2. Preserve one implementation of harness operations and one stream of harness
   events.
3. Fail closed on every authorization, identity, credential, and stale-target
   ambiguity.
4. Keep the Telegram token out of frontend memory, TOML, logs, transcripts, and
   control responses.
5. Make enrollment and ongoing administration possible without editing files.
6. Make the Telegram experience useful during a live turn without flooding the
   chat or exposing thought/reasoning.
7. Preserve Krypton's keyboard-first interaction model in the local Settings
   view.

## Non-goals

- Running the bot while the Krypton application is closed.
- Hosting a public webhook or asking the user to expose a local HTTP server.
- Persisting a Telegram chat's selected target lane across application restarts
  or ACP session replacement.
- Turning Telegram into an ACP lane, an inter-lane peer, or a replacement
  frontend authority.
- Exposing `peer_send` or other agent-only MCP capabilities by impersonating a
  lane. A Telegram user may ask a target lane to peer, but the controller itself
  does not become a peer.
- Forwarding thought/reasoning events.
- Media, voice, file, location, contact, reaction, or poll input in v1.
- Telegram Mini Apps or a general-purpose remote shell outside the typed harness
  operations. Native rich answer rendering is added by spec 201.
- Multiple Telegram bots in one Krypton process.
- Telegram forum-topic-specific target lanes in v1. A group has one shared
  target; direct replies remain in the triggering topic when Telegram supplies a
  thread ID, while unsolicited lane activity posts to the group's General topic.

## Research

### Existing Krypton substrate

- `src-tauri/src/control.rs` already authenticates and forwards typed operations
  to the frontend with the round trip
  `acp-control-request → acp_control_reply`.
- `src/acp/control-bridge.ts` resolves a harness/lane and routes the operation to
  the owning `AcpHarnessView`.
- `src/acp/acp-harness-view.ts` remains the state authority for lane lifecycle,
  transcript, prompt queue, permissions, memory, directives, goals, attention,
  artifacts, review data, and issue bindings.
- `src/acp/control-publish.ts` already serializes frontend-published live events
  and `ControlServer` fans them out to SSE subscribers.
- The prompt queue is FIFO, capped at 10, and drains one prompt per idle
  transition (spec 136). A Telegram submission must enter this same queue.
- `acceptAllForTurn` already proves turn-scoped auto-approval, but a new trusted
  prompt-origin envelope is needed so a queued Telegram prompt carries its
  policy and audit identity until drain.
- Krypton's main `krypton.toml` is intentionally read-only from the application.
  Telegram's app-managed settings therefore belong in a separate file rather
  than weakening that invariant.

### Telegram Bot API

The official [Telegram Bot API](https://core.telegram.org/bots/api) establishes
the protocol constraints used here:

- `getUpdates` long polling and webhooks are mutually exclusive;
- a positive polling timeout is recommended for long polling;
- text messages are limited to 4,096 characters;
- callback data is limited to 1–64 bytes;
- callback queries must be answered so Telegram clears the client's progress
  indicator;
- messages can be updated with `editMessageText`;
- rate-limit responses may include `retry_after`;
- update IDs support ordered acknowledgement through the next `offset`.

Long polling is the smallest and safest fit: no public ingress, certificate, DNS
name, or webhook secret is required.

### Prior art

| Product | Relevant behavior | Krypton consequence |
| --- | --- | --- |
| [Home Assistant Telegram Bot](https://www.home-assistant.io/integrations/telegram_bot) | Long polling without public ingress; explicit chat allowlists; message editing and callback handling | Use a local settings surface and treat Telegram identities as configured data |
| [OpenClaw Telegram channel](https://docs.openclaw.ai/channels/telegram) | Numeric allowlists; pairing; separate group/sender checks; mention gating; per-chat sequencing; streamed previews; one poller per token | Adopt the same fail-closed identity and sequencing shape, while routing into Krypton's existing controller |
| Krypton Harness Control API (spec 175) | Typed operations plus a normalized event stream; frontend remains authority | Telegram is an adapter over this boundary, not a new harness implementation |
| Omnigent native harness | External channel lifecycle separated from the underlying agent session | Keep transport/session lifecycle separate and let the existing harness own the ACP process |

## Architecture

### Component boundary

```text
Telegram cloud
    │ getUpdates / sendMessage / editMessageText
    ▼
TelegramService (Rust)
    ├─ credential vault
    ├─ telegram.toml allowlists
    ├─ telegram-state.json update watermark
    ├─ admission + pairing
    ├─ per-chat target/subscription map
    ├─ command parser + digest renderer
    │
    ├─ ControlServer::dispatch(..., ControlCaller::Telegram)
    │       │ acp-control-request
    │       ▼
    │   control-bridge.ts
    │       ▼
    │   AcpHarnessView (sole harness authority)
    │
    └─ ControlServer::subscribe()
            ▲
       acp_control_publish
            ▲
       AcpHarnessView event sink
```

There is no localhost HTTP loopback from `TelegramService` back into
`ControlServer`. Rust calls a shared internal dispatch method directly, so it
does not handle or duplicate the control server's bearer token.

### Shared control dispatch

Refactor the existing HTTP operation handler's Tauri round trip into:

```rust
pub enum ControlCaller {
    ControlApi,
    Telegram(TelegramCaller),
}

pub struct TelegramCaller {
    pub update_id: i64,
    pub user_id: String,
    pub display_name: String,
    pub chat_id: String,
    pub chat_kind: TelegramChatKind,
}

impl ControlServer {
    pub async fn dispatch(
        &self,
        app: &AppHandle,
        request: ControlRequest,
        caller: ControlCaller,
    ) -> ControlReply;

    pub fn subscribe(&self) -> broadcast::Receiver<ControlStreamEvent>;
}
```

The public HTTP JSON body cannot set `caller`; the HTTP handler always creates
`ControlCaller::ControlApi`. `TelegramService` creates
`ControlCaller::Telegram` only after admission succeeds. The trusted caller
context is emitted to `control-bridge.ts` beside the operation and params, never
inside caller-controlled params.

`ControlServer::publish` continues to assign sequence numbers. Its broadcast
frame retains a typed `ControlStreamEvent` for internal subscribers and a
pre-serialized representation for SSE, preserving one event source.

### Telegram service state

```rust
pub struct TelegramService {
    settings: RwLock<TelegramSettings>,
    health: RwLock<TelegramHealth>,
    poller: Mutex<Option<PollerHandle>>,
    bot: RwLock<Option<BotIdentity>>,
    targets: Mutex<HashMap<ChatId, TelegramTarget>>,
    pair_code: Mutex<Option<PairCode>>,
    pending_pair: Mutex<Option<PendingPairing>>,
    actions: Mutex<ActionRegistry>,
    delivery: TelegramDeliveryCoordinator,
    control: Arc<ControlServer>,
}

pub struct TelegramSettings {
    pub schema_version: u8,
    pub enabled: bool,
    pub authorized_user_ids: BTreeSet<String>,
    pub authorized_group_chat_ids: BTreeSet<String>,
}

pub struct TelegramTarget {
    pub harness_id: String,
    pub lane: String,
    pub session_id: Option<String>,
}
```

Telegram identifiers are decimal strings across the Tauri boundary and
frontend. They must never pass through JavaScript `number`, which cannot
represent every Telegram 64-bit identifier exactly. Rust validates canonical
signed decimal form; user IDs must be positive, group IDs must be negative.

`targets`, pairing codes, pending pairings, callback actions, stream buffers,
and rate-limit state are process-local. They are never persisted.

## Persistence and Credentials

### App-managed settings

Store non-secret settings in:

```text
~/.config/krypton/telegram.toml
```

```toml
schema_version = 1
enabled = false
authorized_user_ids = ["123456789"]
authorized_group_chat_ids = ["-1001234567890"]
```

The file is owned by the application, written atomically
(`telegram.toml.tmp → rename`), and mode `0600` on Unix. The Telegram Settings
view is its primary editor. Krypton does not modify the user's `krypton.toml`.

An empty user allowlist admits no control traffic. An empty group allowlist
disables all group control while still allowing authorized private chats.

### Bot credential

Store the Bot API token through a `CredentialStore` abstraction backed by the
operating-system credential vault:

- macOS: Keychain;
- Windows: Credential Manager;
- Linux: Secret Service.

Use a stable service/account pair such as
`com.krypton.telegram / bot-token`. The frontend can read only
`credentialState: "configured" | "missing" | "unavailable"` and can invoke
set/replace/remove commands; no command returns the token.

If the platform vault is unavailable, Telegram remains disabled with an
actionable health error. There is no plaintext or environment-variable
fallback.

### Update watermark

Store non-secret delivery state in:

```text
~/.config/krypton/runtime/telegram-state.json
```

```json
{
  "schemaVersion": 1,
  "botId": "987654321",
  "lastHandledUpdateId": 1234567890
}
```

The file is atomic and `0600`. `botId` prevents an offset from one bot being
applied to another after token replacement. A new bot identity resets the
watermark.

The service advances and persists `lastHandledUpdateId` only after an update is
fully classified:

- ignored or rejected updates are handled once the decision is complete;
- a control update is handled once the frontend returns a terminal
  `started`, `queued`, successful, or non-retryable error result;
- a retryable control timeout is not acknowledged and is retried with the same
  deterministic operation ID.

Control operation IDs use `telegram:<bot-id>:<update-id>`, so the existing
completed-operation cache makes retry safe within the process.

## Transport Lifecycle

1. On application startup, load `telegram.toml` and query credential presence.
2. Start the poller only when `enabled`, a token exists, and the credential vault
   is available.
3. Call `getMe` before polling. Cache the bot ID and username for command
   parsing and watermark selection.
4. If a webhook exists, surface `webhook_conflict`; do not delete it silently.
   The Settings view offers an explicit “Remove webhook and use long polling”
   action.
5. Call `getUpdates` with `offset = lastHandledUpdateId + 1`,
   `timeout = 30`, and the minimal allowed update kinds:
   `message` and `callback_query`.
6. Process updates serially in update-ID order. Per-chat outgoing work is also
   serialized, while different chats may deliver concurrently.
7. On network/5xx failures, use capped exponential backoff with jitter
   (1 s → 2 s → 4 s … max 60 s).
8. Honor Telegram `429 retry_after` exactly.
9. On `401`, stop polling and report `invalid_token`. On `409`, stop and report
   `another_poller_active`.
10. Disabling Telegram, removing/replacing the token, or exiting Krypton
    cancels long polling and all pending Telegram deliveries.

Only one poller may exist for one service generation. Reconfiguration increments
a generation token; stale tasks may not publish health or messages after a new
generation starts.

## Admission and Authorization

### Private chat

Admit a message or callback only when:

- `chat.type == "private"`;
- `from.id` exists, is not a bot, and its canonical numeric ID is in
  `authorized_user_ids`.

The private chat ID is not separately allowlisted because Telegram private chats
are bound to that user identity.

### Group or supergroup

Admit a message or callback only when:

- `chat.type` is `group` or `supergroup`;
- `from.id` exists, is not a bot, and is in `authorized_user_ids`;
- `chat.id` is in `authorized_group_chat_ids`;
- the message is intentional: `/ask`, an `@botusername` mention, or a reply to a
  message sent by this bot.

Channel posts, anonymous-admin messages without an attributable user ID,
forwarded-channel identity, edited messages, and all other update types are
ignored. Telegram usernames and display names never grant authority.

Every callback re-runs the same user-and-chat authorization checks. Inline
buttons are capabilities for convenience, not credentials.

### Rejection behavior

- Unauthorized private users receive no response, avoiding an oracle that
  confirms a valid controller.
- Unauthorized groups receive no response.
- An authorized user in an unauthorized group receives one rate-limited
  “group not authorized” response only to an explicit bot command; ordinary
  chatter remains silent.
- Authorization changes take effect before processing the next update.

## Pairing and Manual Enrollment

The recommended onboarding path is local pairing:

1. In Telegram Settings, press `p` / choose **Start pairing**.
2. Rust creates one cryptographically random, single-use code valid for five
   minutes and displays it locally.
3. The user sends `/pair <code>` to the bot in the intended private chat or
   group.
4. `/pair` is the only pre-authorization command parsed. A structurally valid
   match consumes the code immediately and creates one pending pairing request.
5. Telegram Settings shows the numeric user ID, display name, chat ID, chat
   title/type, and expiry.
6. Local accept adds:
   - private: the user ID;
   - group: both the user ID and group chat ID.
7. Local reject grants nothing. A new attempt requires a new code.

The bot never grants authority solely because a code was supplied; the local
confirmation is the authority boundary. Manual add/remove by numeric ID remains
available for recovery and automation-minded users.

Pairing codes, pending requests, and displayed identity details are process-only
and redacted from logs.

## Chat Target and Subscription

The target map is keyed by Telegram `chat.id`; all authorized members of one
group share the same target.

- `/use` and `/lanes` show the live lane list with inline selection buttons;
  `/use <lane-display-name>` remains the exact-name fallback.
- Selection stores harness ID, globally unique lane display name, and the
  current ACP session ID.
- Selection immediately returns a compact lane snapshot.
- There is no implicit default lane, even when only one lane exists.
- A chat without a target can list/select lanes but cannot send lane-scoped
  operations.
- Selecting a lane also subscribes the chat to every observable event from that
  lane, including work initiated locally or from another control client.
- Multiple chats may subscribe to the same lane.

Clear the target and tell the chat to select again when:

- its lane closes;
- its harness closes;
- the lane's ACP session ID changes;
- Krypton exits or restarts.

Never silently retarget to another lane or a same-named replacement.

To make local lifecycle changes observable, add control stream events:

- `lane_opened`;
- `lane_closed`;
- `lane_session_changed`;
- `harness_closed`;
- `permission_resolved`.

These events improve every control-stream consumer; they do not move authority
into Rust.

## Telegram Command Surface

Bot command parsing is deterministic and does not ask an LLM to interpret
control syntax.

### Core commands

| Command | Behavior |
| --- | --- |
| `/start`, `/help` | Show admission-safe help and current authorization state |
| `/status` | Show bot health, selected lane, session, status, queue depth, model, goal, and explicit `TELEGRAM BYPASS` warning |
| `/harnesses` | `harness.list` |
| `/harness_new <absolute-cwd>` | `harness.create` |
| `/lanes` | `lane.list` with inline target picker |
| `/use [lane]` | List lanes or change this chat's target |
| `/ask <text>` | Send a prompt to the target; required for ordinary group text |
| `/spawn [backend]` | `lane.spawn` |
| `/cancel` | `lane.cancel` |
| `/restart` | `lane.restart` |
| `/new [--clear-memory]` | `lane.new`; successful session replacement clears the chat target |
| `/close` | `lane.close`; successful close clears the chat target |
| `/model [id]` | List or set `lane.model` |
| `/directive [id\|clear]` | List or set `lane.directive` |
| `/goal [text\|clear]` | Read/set/clear `lane.goal` |
| `/mode [normal\|acceptEdits\|bypass]` | Read/set the lane's persistent permission mode; separate from Telegram turn bypass |
| `/transcript [count]` | Pull a bounded recent `lane.transcript` snapshot |
| `/permissions` | List pending permissions from other-origin turns and provide accept/reject buttons |
| `/memory`, `/attention`, `/artifacts` | Access the corresponding controller operations |
| `/metrics`, `/commands`, `/models` | Read lane metadata |
| `/pair <code>` | Submit a local-confirmation pairing request |

The existing diff/review/GitHub operations are exposed through discoverable
submenus. A power-user escape hatch provides parity for newly advertised
controller operations without waiting for a dedicated command:

```text
/ctl <advertised-operation> <single-line-json-object>
```

`/ctl` accepts only operations returned by the local capability registry, applies
the selected target when appropriate, validates that params are a JSON object,
and uses the same typed control dispatcher. It is not a shell and cannot invoke
agent-only MCP tools.

### Ordinary messages

- In a private authorized chat, non-command text is equivalent to `/ask`.
- In a group, only `/ask`, an `@botusername` mention, or a reply to the bot is
  converted to a prompt. The trigger text is removed before sending.
- Empty text after trigger removal is rejected locally.
- Unsupported attachments return a concise “text only in v1” response only when
  the update was otherwise admitted.
- Forwarded text is treated as text authored by the acting sender; original
  forward metadata is not trusted provenance.

### Inline callbacks

Telegram callback data contains only a 96-bit random `lp:<hex>` nonce, not a
lane name, operation, token, or JSON params. The process-local registry maps it
to a typed `SelectLane` or `ShowLanePage` action, its originating chat, five
minute expiry, and optional claiming update ID.

Every callback is answered immediately, then re-authorized against the numeric
user ID and (for groups) numeric chat ID. The first update atomically claims the
action; only redelivery of that same update ID may retry it. Lane selection
re-runs `lane.list` and requires the exact harness ID, display name, and session
ID snapshot before changing the chat target. Successful selection edits the
picker into a button-free confirmation. Stale buttons refresh the live picker
instead of silently selecting a replacement lane.

## Prompt Provenance, Queueing, and Bypass

### Trusted prompt envelope

Extend control events and prompt submission with a trusted envelope:

```ts
interface PromptSubmission {
  origin:
    | { kind: 'local' }
    | { kind: 'control-api' }
    | {
        kind: 'telegram';
        updateId: string;
        userId: string;
        displayName: string;
        chatId: string;
        chatKind: 'private' | 'group' | 'supergroup';
      };
  permissionPolicy: 'inherit' | 'bypass-turn';
}
```

`lane.send` derives this envelope from `ControlCaller`; params cannot supply or
override it. `QueuedPrompt` stores the envelope with text and images. Immediate
and drained prompts call the same `sendUserPrompt` path.

The user transcript row receives structured Telegram provenance displayed as a
small metadata label. `lane.transcript` includes the same structured metadata.
The agent receives provenance in the trusted leading context block, separate
from the user-authored text. Display names are escaped, line-normalized, bounded,
and explicitly informational; numeric user ID is the audit identity.

### Turn-scoped bypass

When a Telegram prompt actually starts:

1. stamp the lane's active prompt submission;
2. set the Telegram-specific active turn policy to `bypass-turn`;
3. append the provenance-bearing user row;
4. transition the lane to busy and call the ACP prompt.

While this turn is active:

- every ACP permission request is auto-accepted, including commands classified
  as high risk;
- every pending filesystem write review is auto-accepted;
- no permission card is sent to Telegram;
- resolution records and transcript labels identify
  `telegram-bypass:<user-id>` as the automatic reason.

Reset the active Telegram policy on every terminal path: normal stop,
cancel, provider error, transport error, force restart, restart, new session,
lane close, and harness dispose.

This policy never mutates `lane.permissionMode`, never arms
`acceptAllForTurn` for another source, and never transfers to the next queued
prompt. Each queued item carries its own policy.

If a Telegram prompt is a mention fan-out consumed without starting a local
turn, no bypass policy is armed on the source lane.

### Queue response

`lane.send` retains the existing FIFO cap of 10:

- idle target → reply `started`;
- busy / needs-permission / awaiting-peer target → enqueue and reply immediately
  `queued #N`;
- full queue → return `queue_full`;
- queued Telegram provenance and bypass policy survive until that exact item
  drains;
- cancelling, restarting, replacing, or closing the lane clears the queue using
  existing lifecycle semantics.

There is no Telegram mid-turn steering in v1.

## Operational Digest

### Included

- live assistant text;
- compact tool title and status;
- plan/status changes;
- queue/start/idle/cancel/restart/error state;
- provider errors;
- permission auto-approval status for Telegram-origin turns;
- pending permission prompts from non-Telegram turns, with authorized callbacks;
- attention count and other compact lane alerts.

### Excluded

- `thought_chunk`;
- raw tool arguments;
- raw shell command text;
- raw tool output;
- credential data;
- artifact feedback tokens;
- internal control request IDs;
- full transcript history unless requested.

### Streaming behavior

Maintain one output coordinator per `(chat_id, harness_id, lane)`:

1. Collect `message_chunk` events in order.
2. At most once per second, update the current preview.
3. In private chats, prefer `sendMessageDraft` when supported; if Telegram
   rejects or does not support it, fall back to a normal placeholder plus
   `editMessageText`.
4. In groups, always use a placeholder plus `editMessageText`.
5. On stop/error, finalize a persistent message.
6. Plain output splits at 4,000 characters, leaving headroom below Telegram's
   4,096 limit. Prefer paragraph, newline, then whitespace boundaries; hard-split
   only as a last resort.
7. The spec-201 opt-in rich path parses Markdown with Comrak, emits an explicit
   safe Telegram HTML subset, budgets UTF-8 bytes plus nested blocks/depth, and
   falls back to this plain path without dropping or duplicating content.
8. If an edit fails because the message is gone or too old, send a new message
   and continue from there.
9. Treat `message is not modified` as success.

Tool progress uses a separate compact message edited in place:

```text
Codex-6 · running
tool: cargo test · completed
queue: 2
```

No more than one assistant preview and one tool/status preview are live per chat
subscription. A lane event is fanned out to every subscribed chat through
independent per-chat delivery queues, so one rate-limited chat cannot block
another.

`/transcript [count]` returns a snapshot rather than replaying missing stream
events. On a control stream gap, TelegramService re-snapshots lane status and
transcript, seals the current preview, and posts a concise resynchronization
notice.

## Telegram Settings UI

Add a dedicated `TelegramSettingsView` opened from the command palette or the
ACP harness's exact built-in `#telegram` command. It is a normal DOM content
view inside Krypton's single native window. The hash command accepts no
arguments; credentials and allowlists remain confined to the masked Settings
UI rather than entering the lane transcript or prompt history.

### Information architecture

Use one flat vertical surface, not a dashboard of nested cards:

1. **Connection**
   - enabled/disabled;
   - token configured/missing/unavailable;
   - bot identity;
   - poller state and last successful poll;
   - current error/backoff;
   - test connection;
   - set/replace/remove token;
   - explicit `TELEGRAM TURNS: BYPASS ALL PERMISSIONS` warning.
2. **Authorized users**
   - numeric ID;
   - optional last-seen display name as informational metadata;
   - add/remove.
3. **Authorized groups**
   - numeric chat ID;
   - optional last-seen title as informational metadata;
   - add/remove.
4. **Pairing**
   - start/cancel code;
   - remaining expiry;
   - one pending identity request;
   - accept/reject.

The token is never rendered, even immediately after entry. Token input is a
one-use masked field whose value is sent directly to Rust and then cleared.

### Keyboard contract

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Move between sections/actions |
| `j` / `k` | Move within the active allowlist/pairing table |
| `Enter` | Activate focused action or submit inline input |
| `Space` | Toggle Telegram enabled |
| `a` | Add an ID in the active allowlist |
| `d` | Remove selected ID with an inline, keyboard-confirmable row |
| `p` | Start/cancel pairing |
| `t` | Test Bot API connection |
| `r` | Refresh health |
| `q` / `Escape` | Close view or cancel the current inline edit first |

All actions have visible text labels; keys are accelerators, not the only
discovery mechanism.

### Visual contract

Follow Krypton's default `DESIGN.md`:

- existing color and typography tokens;
- flat, sharp surfaces with at most 2 px radius;
- no `backdrop-filter`;
- no decorative animation;
- full borders/background tints rather than left-only accent rails;
- text plus icon/state label, never color alone;
- visible `:focus-visible`;
- compact rows and terminal-like status language;
- reduced-motion compliance;
- skeleton/status rows only while loading, with no layout shift.

The view should read as a secure control panel, not a friendly consumer bot
wizard. Pairing is the only guided flow.

## Tauri Commands and Events

Frontend-facing commands:

```text
telegram_get_status
telegram_set_enabled
telegram_set_token
telegram_remove_token
telegram_test_connection
telegram_add_user
telegram_remove_user
telegram_add_group
telegram_remove_group
telegram_start_pairing
telegram_cancel_pairing
telegram_accept_pairing
telegram_reject_pairing
```

All commands return sanitized DTOs with IDs as strings. Mutation commands
validate in Rust, persist first, then update the running service. Failed
persistence leaves the previous runtime settings active.

Frontend events:

```text
telegram-status-changed
telegram-pairing-changed
```

Events contain no token, pairing code after consumption, raw Telegram update, or
full message text.

## Data Flows

### Authorized prompt

```text
1. getUpdates returns a new private message or intentional group message.
2. Rust validates sender ID + chat ID before parsing the command.
3. Chat target is resolved and session identity revalidated via lane.status.
4. TelegramService dispatches lane.send with ControlCaller::Telegram.
5. control-bridge routes to the owning AcpHarnessView.
6. AcpHarnessView derives trusted provenance + bypass-turn policy from caller.
7. Idle lane starts; busy lane stores the same envelope in its FIFO queue.
8. Control reply becomes "started" or "queued #N".
9. Frontend events flow through the existing ControlServer broadcast.
10. TelegramService filters subscribed lane events and updates the digest.
11. On turn end, the frontend clears the Telegram policy and emits idle/stop.
```

### Permission during a Telegram turn

```text
1. ACP emits permission_request or fs_write_pending.
2. AcpHarnessView records it in the transcript.
3. Active prompt policy is telegram bypass-turn.
4. Existing resolve path accepts immediately, including high-risk commands.
5. Frontend publishes permission_resolved with reason telegram-bypass:<user-id>.
6. Telegram digest shows a compact auto-approved status, never action buttons.
```

### Local turn permission observed from Telegram

```text
1. A locally-originated turn enters needs_permission.
2. Telegram subscription receives permission_request.
3. Digest shows bounded tool/command context and accept/reject callbacks.
4. Clicking user and chat are re-authorized.
5. Callback dispatches permission.resolve through the same controller.
6. Frontend owns and records the actual decision.
```

### Pairing

```text
1. Local user starts pairing in Telegram Settings.
2. Rust displays a 5-minute code locally.
3. Telegram receives /pair code before normal admission.
4. Exact code match consumes it and creates a pending request.
5. Local Settings receives telegram-pairing-changed.
6. Local accept atomically updates telegram.toml.
7. The next Telegram update uses the new allowlist.
```

## Error and Edge-case Contract

- **No token / vault unavailable:** no poller; Settings explains the condition.
- **Invalid token:** stop on `401`; do not expose any token fragment.
- **Another poller/webhook:** stop and show a specific recovery action; never
  race or silently remove another integration.
- **No target / stale target:** reject the operation and show `/use`; never
  select automatically.
- **Lane or harness closes locally:** lifecycle event clears every affected chat
  target.
- **Session changes locally:** compare session ID, clear target, seal previews.
- **Duplicate update:** deterministic operation ID returns the prior result;
  consumed callbacks/pairing actions remain idempotent.
- **Out-of-order update:** serial update processor handles by update ID; anything
  at or below the persisted watermark is ignored.
- **Krypton crashes after dispatch but before acknowledgement:** Telegram may
  redeliver; deterministic IDs and target/session validation prevent silent
  retargeting, though a process restart clears the target and requires `/use`.
- **Queue full:** return `queue_full`; do not drop an older prompt.
- **Telegram message deleted/edited:** already-adopted operations are not
  revoked. Edited updates are ignored in v1.
- **Bot blocked or removed:** `403` updates health; target remains process-local
  but delivery pauses until access returns or the service is reconfigured.
- **Output over limit:** split at 4,000 characters and keep part numbering.
- **Output flood:** one-second edit throttle plus per-chat delivery queue.
- **Slow chat:** cannot backpressure another chat or the harness event publisher.
- **Callback after expiry/restart:** answer callback and ask the user to reopen
  the command; never reconstruct an action from callback text.
- **Authorization removed mid-turn:** the already-running ACP turn is not
  cancelled automatically, but future callbacks/messages and future digest
  deliveries to that chat stop immediately.
- **Group privacy mode:** supported because v1 requires commands, mentions, or
  replies; users do not need to disable BotFather privacy mode.

## Security Invariants

1. The Telegram token is backend-only and never serialized to the frontend.
2. Every command and callback is authorized by immutable numeric IDs.
3. Group authority requires both sender and destination authorization.
4. Trusted caller/provenance metadata is generated by Rust, not accepted in
   operation params.
5. Telegram bypass belongs to one prompt turn and is reset on every terminal
   path.
6. A queued prompt retains its own origin and policy; no lane-global mode is
   changed.
7. Callback data is opaque, short-lived, single-use, and chat-bound.
8. No thought/reasoning or raw tool payload is forwarded.
9. No untrusted Telegram string becomes HTML, a shell command, a filesystem
   path, or an operation name without validation.
10. Long polling creates no inbound listening socket.
11. Logs may contain bot ID, numeric chat/user IDs at debug level, update ID,
    operation name, and result class; never token, message text, callback nonce,
    pairing code, tool arguments, or transcript text.
12. Removing an allowlist entry stops future delivery as well as future control.

## Affected Files

| File | Planned change |
| --- | --- |
| `src-tauri/Cargo.toml` | Add credential-vault dependency if no existing platform abstraction covers it |
| `src-tauri/src/telegram.rs` | New settings, vault, Bot API client, poller, admission, pairing, command routing, delivery coordinator, persistence, and unit tests |
| `src-tauri/src/control.rs` | Extract shared internal dispatch; add trusted caller; expose typed event subscription |
| `src-tauri/src/commands.rs` | Register sanitized Telegram Settings commands |
| `src-tauri/src/lib.rs` | Construct/manage `TelegramService`; register commands; shut down poller |
| `src/acp/control-bridge.ts` | Carry trusted caller context through routing |
| `src/acp/control-publish.ts` | Add lifecycle and permission-resolution event kinds |
| `src/acp/acp-harness-view.ts` | Prompt submission metadata, queued provenance, Telegram bypass, transcript metadata, lifecycle events, and exact `#telegram` Settings opener |
| `src/acp/hash-commands.ts` | Register `#telegram` as a local surface command with no arguments |
| `src/telegram-settings-view.ts` | New keyboard-first Settings content view |
| `src/styles/telegram-settings.css` | Flat secure-control-panel styling |
| `src/types.ts` | Add `telegram_settings` content type |
| `src/compositor.ts` | Open/close Telegram Settings content tab |
| `src/command-palette.ts` | Add “Open Telegram Settings” command |
| `src/main.ts` | Import Settings styles / wire sanitized status as required |
| `CONTEXT.md` | Telegram domain vocabulary (already drafted with this spec) |
| `docs/04-architecture.md` | Telegram adapter and authority boundary |
| `docs/05-data-flow.md` | Admission, dispatch, stream, and pairing flows |
| `docs/06-configuration.md` | Document app-managed `telegram.toml` and credential-vault behavior |
| `docs/154-harness-controller-cli.md` | Record trusted caller metadata shared by control adapters |
| `docs/175-harness-web-control-api.md` | Record internal typed subscribers and new lifecycle events |
| `docs/PROGRESS.md` | Record implementation only after verification |
| `docs/adr/0013-*.md` | Full controller authority and turn-scoped bypass |
| `docs/adr/0014-*.md` | Numeric user + group allowlists |
| `docs/adr/0015-*.md` | OS credential vault |

Existing unrelated worktree changes must not be modified while implementing this
feature.

## Test Plan

### Rust unit tests

- canonical signed-decimal Telegram ID validation;
- private/group admission matrix;
- intentional group message detection (`/ask`, mention, reply);
- anonymous admin, bot sender, channel, edited update rejection;
- pre-authorization `/pair` is the sole exception;
- pairing expiry, single use, accept/reject, private vs group grants;
- settings load, schema rejection, atomic write, Unix file mode;
- credential DTO never serializes token;
- bot change resets watermark; same bot restores it;
- update acknowledgement only after terminal handling;
- deterministic operation ID on retry;
- one-poller generation cancellation;
- backoff, `429 retry_after`, `401`, `403`, `409`;
- callback nonce length, expiry, chat binding, same-update retry,
  cross-update rejection, and re-authorization;
- message split boundary and hard-split fallback;
- one-second coalescing and per-chat isolation;
- thought/raw tool payload suppression;
- secret/message redaction in error formatting.

Bot API tests use a local fake HTTP server and an injected base URL; they never
call Telegram.

### TypeScript unit tests

- `ControlCaller` cannot be forged through params;
- immediate and queued Telegram prompts retain provenance;
- queued policy applies only when that item drains;
- Telegram turn auto-accepts high-risk permissions and filesystem writes;
- local/control-api turns remain unchanged;
- every finish/error/restart/new/close/dispose path clears Telegram policy;
- mention fan-out does not arm bypass on the source lane;
- transcript and agent context carry structured provenance separately from text;
- lifecycle events fire with stable harness/lane/session identity;
- existing `lane.send` and local composer behavior remain unchanged.

### Settings view tests

- token value never appears in DOM, status DTO, event, or console output;
- all actions are keyboard reachable;
- focus restoration after inline add/remove/pairing;
- ID strings remain exact beyond JavaScript safe integer range;
- loading, empty, vault-unavailable, invalid-token, conflict, and backoff states;
- pairing identity review and accept/reject;
- enable/disable and mutation errors leave visible, recoverable state;
- focus-visible, semantic labels, and reduced-motion behavior.

### Integration verification

1. `npm run check`
2. focused Vitest suites for control bridge, harness queue/permissions, and
   Settings view
3. `cargo fmt -- --check`
4. `cargo clippy -- -D warnings`
5. `cargo test`
6. manual Telegram sandbox bot:
   - private authorization and ordinary prompt;
   - authorized user in unauthorized group;
   - unauthorized user in authorized group;
   - `/ask`, mention, reply, and ignored chatter;
   - select lane, local activity fan-out, stale target;
   - queue depth and ordered drain;
   - high-risk permission auto-approval for Telegram turn only;
   - non-Telegram permission callbacks;
   - long output split/edit/finalize;
   - rate limit and reconnect;
   - token replace/remove;
   - app exit stops polling.

No real bot token is committed to fixtures, snapshots, recordings, or logs.

## Acceptance Criteria

- An authorized private user and an authorized member of an authorized group can
  control every operation advertised by the Harness Control API.
- Unauthorized user/chat combinations cannot control or receive lane data.
- Telegram messages use the same frontend-owned operations and event stream as
  existing control clients.
- Each chat has one explicit non-persistent target and observes all activity from
  that lane until invalidation.
- A busy lane returns `queued #N`, preserves FIFO order, and retains the correct
  Telegram sender and bypass policy for each item.
- Every Telegram-originated turn auto-accepts all permissions, including
  high-risk operations, without changing persistent lane permission mode or the
  next non-Telegram turn.
- Thought/reasoning and raw tool details never reach Telegram.
- The token remains backend-only in the OS credential vault.
- Allowlist and pairing administration is fully keyboard operable inside
  Krypton.
- Polling stops when Telegram is disabled or Krypton exits.
- All automated checks above pass and documentation matches the implementation.

## Implementation Verification

Implemented on 2026-07-24 with:

- one Rust `TelegramService` using Bot API long polling, the OS credential
  vault, atomic `telegram.toml`/watermark persistence, numeric user and group
  allowlists, local-confirmed pairing, per-chat lane targets, and event digests;
- shared `ControlServer::dispatch` and a typed internal event subscription;
- trusted caller metadata forwarded beside, never inside, caller-controlled
  operation params;
- queued Telegram provenance and one-turn permission/filesystem-write bypass in
  the existing `AcpHarnessView` prompt path;
- lifecycle and permission-resolution control events;
- ephemeral `sendMessageDraft` streaming in private chats, followed by a fresh
  persistent final message, plus one edited tool/status summary per chat that
  merges partial ACP updates by call ID and shows the latest six named tools;
- opt-in native `sendRichMessageDraft`/`sendRichMessage` answer rendering with a
  sanitized Markdown boundary and per-response plain fallback (spec 201);
- a keyboard-first Telegram Settings content view, command-palette entry, and
  exact `#telegram` ACP harness command.

The shipped core uses deterministic text commands plus `/ctl` for complete
advertised-operation parity. Spec 202 adds the first fixed callback surface:
best-effort `setMyCommands` registration plus paged `/use` and `/lanes` lane
buttons backed by authorized, expiring opaque actions. The poller requests both
`message` and `callback_query`; every callback is acknowledged before control
dispatch. Generic agent-authored buttons and other controller submenus remain
follow-up work. Live Bot API validation likewise requires an operator-owned
token.

Automated evidence: `npm run check`, production `npm run build`, 511 full
Vitest tests (including 172 focused control/harness tests), 201 Rust library
tests plus 3 `kryptonctl` tests, `cargo fmt
-- --check`, and `cargo clippy --all-targets -- -D warnings` all pass. The manual
Telegram sandbox checklist remains intentionally unexecuted because no real bot
token is stored in the repository or test environment.

## Open Questions

None. The unresolved pairing detail is fixed here as **local-confirmed pairing
plus manual numeric-ID fallback**, and group targeting remains one shared target
per Telegram chat. Any change to those choices should happen during spec
approval, before implementation begins.
