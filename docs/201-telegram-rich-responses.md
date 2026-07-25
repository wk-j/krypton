# Telegram Rich Responses — Implementation Spec

> Status: Implemented
> Date: 2026-07-24
> Milestone: M8 — Polish

## Problem

Krypton's Telegram controller currently sends assistant output as plain text, so
headings, lists, tables, links, quotations, and code from the ACP lane lose their
structure. Telegram now has native Rich Messages, including a streaming draft
method, but some Telegram clients still render accepted rich messages as
unsupported content.

## Solution

Add an operator-controlled **Native rich messages** setting, defaulting off for
client compatibility. When enabled, sanitize the lane's Markdown into
Telegram-supported rich HTML and deliver it through `sendRichMessageDraft`,
`sendRichMessage`, and rich `editMessageText`; on any rich-rendering or Bot API
failure, degrade that response to the existing plain-text path without losing
content. Keep tool/status summaries plain, and do not add Mini Apps, media
uploads, or agent-authored buttons in this increment.

## Research

- Telegram Rich Messages support headings, lists, task lists, tables, code,
  quotes, collapsible blocks, footnotes, formulas, and media. The documented
  limits are 32,768 UTF-8 characters, 500 total blocks including nested list
  items/table rows, 16 nesting levels, 50 media items, and 20 table columns.
- `sendRichMessageDraft` is private-chat-only, ephemeral for 30 seconds, and
  requires a later `sendRichMessage` to persist the answer. This is the direct
  rich counterpart of Krypton's current `sendMessageDraft` flow.
- `editMessageText` accepts `rich_message`, so group-chat previews can retain
  the existing one-message edit behavior.
- Passing raw model Markdown directly to Telegram is unsafe and unpredictable:
  raw HTML is accepted and remote media URLs may be fetched. Krypton already
  depends on `comrak`; it can parse GFM and emit escaped HTML so Telegram
  receives only a controlled tag subset. Using the Rich Message `html` field
  also keeps ordinary dollar amounts literal; formulas require explicit
  Telegram math tags, which this design never emits.
- Krypton's current `DigestDraft` already owns per-chat preview/final state and
  cleanly separates assistant text from the plain tool/status summary. Rich
  delivery belongs at this existing output boundary, not in the ACP frontend.
- Client support cannot be feature-detected from the Bot API. OpenClaw therefore
  keeps native Rich Messages opt-in even though it uses standard Telegram HTML
  by default.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| OpenClaw | Standard Telegram HTML by default; opt-in Bot API Rich Messages rendered from an internal Markdown representation | Defaults rich messages off because some Desktop, Web, Android, and third-party clients show unsupported content |
| Home Assistant | Formatted Telegram text plus optional inline keyboards and editable messages | Broadly compatible, but does not expose native Rich Messages or Mini Apps |
| Telegram Mini Apps | Launch an HTML5 application from bot/menu/inline buttons | Appropriate for a full interactive application, not for rendering an agent's outbound answer |

**Krypton delta** — Krypton uses Telegram's native rich document surface for
answer presentation, while preserving the current keyboard-first local Settings
view and current plain fallback. Unlike OpenClaw, this increment does not expose
rich-message authoring or inline-button actions to the agent; unlike a Mini App,
it requires no hosted web application.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/telegram.rs` | Persist/expose the setting, add the command, select delivery, and add Bot API methods plus pure payload builders |
| `src-tauri/src/telegram/rich.rs` | New isolated Markdown sanitizer, Telegram HTML renderer, chunker, and unit tests |
| `src-tauri/src/lib.rs` | Register `telegram_set_rich_messages` |
| `src/telegram-settings-view.ts` | Show and keyboard-toggle Native rich messages |
| `docs/200-telegram-harness-controller.md` | Amend the v1 plain-text decision and implementation notes |
| `docs/04-architecture.md` | Record the sanitized rich-delivery boundary |
| `docs/05-data-flow.md` | Document rich draft/final delivery and fallback |
| `docs/06-configuration.md` | Document `rich_messages` in app-managed `telegram.toml` |
| `docs/PROGRESS.md` | Record the completed capability and verification |

No new frontend style file is required; the Settings view reuses its existing
toggle and control styles.

## Design

### Data Structures

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TelegramSettings {
    pub schema_version: u8,
    pub enabled: bool,
    pub rich_messages: bool,
    pub authorized_user_ids: BTreeSet<String>,
    pub authorized_group_chat_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStatus {
    // existing fields...
    pub rich_messages: bool,
}

struct DigestDraft {
    // existing fields...
    rich_requested: bool,
    rich_active: bool,
}

pub(crate) enum TelegramOutputChunk {
    Rich { html: String, plain: String },
    Plain { text: String },
}
```

`rich_messages` defaults to `false`. Because `TelegramSettings` already uses
Serde defaults, existing schema-version-1 files load without migration and are
written with the new field on the next Settings mutation.

### Rich Renderer

`telegram/rich.rs` exposes:

```rust
pub(crate) fn render_rich_preview(markdown: &str) -> Result<String, String>;
pub(crate) fn render_rich_chunks(markdown: &str) -> Vec<TelegramOutputChunk>;
```

The renderer:

1. Parses the full answer with `comrak` using GFM tables, strikethrough, task
   lists, and autolinks.
2. Sets `unsafe = false` and `escape = true`; agent-authored raw HTML becomes
   literal text and can never become Telegram markup.
3. Allows links only for `https`, `http`, `mailto`, and `tel`. Relative paths,
   filesystem paths, `javascript:`, `data:`, and unknown schemes render as
   visible text rather than clickable links.
4. Replaces Markdown images with their alt text plus a safe visible URL. It
   never emits Telegram media blocks, so Telegram does not fetch an
   agent-selected URL in this increment.
5. Serializes only this explicit Telegram HTML mapping:

   | Comrak output | Telegram output |
   |---------------|-----------------|
   | Text | HTML-escaped text |
   | `h1`–`h6`, `p`, `br`, `hr` | Same tag |
   | `strong`, `em`, `del`, `code`, `pre` | Same tag |
   | `ul`, `ol`, `li`, `blockquote` | Same tag |
   | `a` with an allowed URL | Same tag and sanitized `href` |
   | `table`, `tr`, `th`, `td` | Same tag and supported alignment attributes |
   | `thead`, `tbody` | Wrapper removed; children retained |
   | Task-list `input` | Literal `☑` or `☐` prefix |
   | Raw HTML | Escaped literal text |
   | Image | Escaped alt text plus a visible safe URL, never an `img` tag |
   | Any other tag/node | Children retained as escaped visible text |

6. Counts **all nested Telegram blocks** represented by each Comrak subtree and
   calculates its maximum nesting depth. The chunker groups complete top-level
   nodes only while the candidate stays below 24,000 UTF-8 bytes, 450 total
   nested blocks, and 14 levels, leaving headroom below every documented limit.
7. When one list, ordered list, table, quotation, or other container is too
   large, recursively split it at child-block boundaries and preserve/recreate
   the wrapper. Split tables repeat their header row; split ordered lists carry
   the correct next `start` value. A subtree whose single child is still too
   large or deeper than the budget becomes one or more existing 4,000-character
   plain chunks rather than malformed rich HTML.
8. Sets `skip_entity_detection = true`; Comrak-created explicit links remain
   clickable, while incidental phone numbers, cards, `@mentions`, and bot
   commands do not gain unintended behavior.

The preview renderer parses at most the latest 8,000 UTF-8 bytes, cut only at a
character boundary, and returns the newest renderer chunk that satisfies the
same byte, total-block, and depth budgets. It may render a temporarily
incomplete Markdown construct. Final chunks always parse the complete answer.

### API / Commands

```rust
#[tauri::command]
pub fn telegram_set_rich_messages(service: State<'_, TelegramService>, enabled: bool)
    -> Result<TelegramStatus, String>;

impl BotApi {
    async fn send_rich_message(&self, chat_id: &str, html: &str)
        -> Result<i64, String>;
    async fn send_rich_draft(&self, chat_id: &str, draft_id: i64, html: &str)
        -> Result<(), String>;
    async fn edit_rich_message(&self, chat_id: &str, message_id: i64, html: &str)
        -> Result<(), String>;
}
```

All three methods send:

```json
{
  "rich_message": {
    "html": "<sanitized Telegram HTML>",
    "skip_entity_detection": true
  }
}
```

Pure request-body builders construct these payloads and are unit-tested without
network access. A rich body contains `rich_message` and omits `text`; a plain
body contains `text` and omits `rich_message`. The production methods pass those
bodies to the existing `BotApi::call`.

The Settings status payload adds `richMessages: boolean`. Pressing `m` in the
Telegram Settings view or changing the visible toggle invokes
`telegram_set_rich_messages`.

### Data Flow

```text
1. ACP Harness emits assistant message_chunk events as it does today.
2. On the first chunk, TelegramService samples the current setting with
   DigestDraft::new(private_chat, settings.rich_messages). A setting change
   never changes a response already in flight.
3. TelegramService appends raw Markdown to the chat's DigestDraft.
4. If rich_requested is false, the existing plain delivery path is unchanged.
5. If rich_requested is true in a private chat:
   a. Each one-second flush sanitizes the partial Markdown.
   b. sendRichMessageDraft updates one ephemeral animated draft.
   c. stop/error sends fresh persistent sendRichMessage chunk(s).
6. If rich_requested is true in a group:
   a. The first flush creates one persistent rich preview.
   b. Later flushes use editMessageText with rich_message.
   c. stop/error replaces the preview with the first final chunk and sends
      remaining chunks in order.
7. If preview rendering fails or Telegram rejects a rich preview/edit:
   a. rich_active becomes false for that DigestDraft;
   b. sent_text is cleared so deduplication cannot suppress the plain retry;
   c. a group reuses its existing message_id with plain editMessageText, sending
      a new message only if that edit fails;
   d. a private chat reuses the same draft_id with sendMessageDraft when
      possible, then follows the existing persistent-preview fallback.
8. During final multi-chunk delivery, every Rich chunk retains its plain source.
   If a rich chunk fails after earlier chunks succeeded, keep the accepted rich
   chunks and send that failed chunk plus all remaining chunks as plain text;
   never duplicate already accepted content.
9. ToolStatusDraft remains one edited plain-text message and is finalized before
   the persistent assistant answer, preserving current message order.
```

Changing the setting affects new responses. It does not restart polling, clear
lane targets, or convert messages already sent.

### UI Changes

Telegram Settings adds a second checkbox-style control:

```text
[x] ENABLE CONTROLLER
[ ] NATIVE RICH MESSAGES
    Headings, tables, lists, code, and quotes.
    Some older or third-party Telegram clients may show unsupported content.
```

The footer hint becomes:

```text
r refresh · m rich messages · j/k scroll · q close
```

The control is keyboard reachable, clickable as a secondary path, disabled
while a mutation is running, and reports failures through the existing notice.

### Configuration

App-managed `~/.config/krypton/telegram.toml` gains:

```toml
schema_version = 1
enabled = false
rich_messages = false
authorized_user_ids = ["123456789"]
authorized_group_chat_ids = ["-1001234567890"]
```

No `krypton.toml` key, environment variable, or per-chat override is added.

## Edge Cases

- **Unsupported client:** the Bot API may accept a rich message that an old
  client cannot display. The explicit default-off setting and warning are the
  only reliable mitigation because Bot API calls do not reveal client support.
- **Unsupported Bot API method or invalid rich HTML:** degrade the current
  response to plain text, log only a sanitized error, and retry rich delivery on
  the next response.
- **Toggle during a response:** `rich_requested` was captured when the
  `DigestDraft` was created, so the response completes in its original mode.
- **Partial Markdown while streaming:** tolerate incomplete syntax in the
  ephemeral preview; the final answer is reparsed from the complete source.
- **Oversized block/table/deep nesting:** emit that content as plain chunks
  rather than dropping it or violating Telegram limits.
- **Raw HTML or dangerous links:** render visibly as text; never pass through as
  markup or a clickable unsafe scheme.
- **Images and local files:** show alt text/path only. No file read, upload, or
  Telegram-side fetch occurs.
- **Rich final after a plain fallback preview:** send the complete plain final;
  never switch back to rich inside one response.
- **Empty assistant output:** retain the current behavior and send no answer.
- **Tool summary:** remains plain and independent of answer rendering.

## Verification

- Rust unit tests for settings backward compatibility and status serialization.
- Renderer tests covering headings, nested lists, task lists, tables, fenced
  code, links, literal dollar amounts, raw HTML, images, unsafe schemes,
  oversized/deep blocks, nested-block accounting, UTF-8 byte budgets, and
  Unicode.
- Pure payload-builder tests for `sendRichMessage`, `sendRichMessageDraft`, and
  rich `editMessageText`, including the exactly-one-of-`text`/`rich_message`
  invariant.
- Delivery-state tests prove mode capture, dedup reset, and one-way plain fallback.
  The final-delivery loop preserves group message reuse and advances past accepted
  chunks so a later fallback cannot duplicate them.
- `cargo fmt -- --check`
- `cargo test`
- `cargo clippy --all-targets -- -D warnings`
- `npm run check`
- `npm run build`
- Manual private-chat test on a current Telegram client with a heading, table,
  checklist, quotation, link, and fenced code block.
- Manual compatibility test with rich messages disabled, proving byte-for-byte
  preservation of the current plain output behavior.

## Open Questions

None. Native Rich Messages are opt-in and answer-only; buttons, media, and Mini
Apps require separate interaction and trust designs.

## Out of Scope

- Telegram Mini Apps or any hosted web UI
- Inline keyboards, callback actions, or agent-authored buttons
- Photos, video, audio, voice, local-file upload, or remote-media fetching
- Rich formatting for tool/status summaries, command help, pairing, or errors
- Per-chat presentation preferences
- Exposing Telegram-specific markup instructions to the ACP agent
- Standard `parse_mode=HTML` as a third presentation mode

## Resources

- [Telegram Bot API — Rich Messages](https://core.telegram.org/bots/api#rich-messages) — native formats, supported elements, and limits
- [Telegram Bot API — sendRichMessage](https://core.telegram.org/bots/api#sendrichmessage) — persistent rich delivery and reply markup
- [Telegram Bot API — sendRichMessageDraft](https://core.telegram.org/bots/api#sendrichmessagedraft) — private-chat ephemeral streaming contract
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps) — establishes why a hosted HTML5 UI is a separate product surface
- [OpenClaw Telegram channel](https://docs.openclaw.ai/channels/telegram#rich-message-formatting) — opt-in compatibility precedent and safe intermediate rendering
- [Home Assistant Telegram Bot](https://www.home-assistant.io/integrations/telegram_bot) — formatted-message, editable-message, and inline-keyboard prior art
- [Comrak](https://docs.rs/comrak/0.49.0/comrak/) — existing Rust GFM parser used for sanitized conversion
