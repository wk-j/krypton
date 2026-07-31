# Assistant Response Resources — Implementation Spec

> Status: Implemented
> Date: 2026-07-31
> Milestone: M-ACP — Harness convergence

## Problem

ACP assistant output is rendered as Markdown, but useful references inside a
finished message remain mixed into prose. External URLs are clickable inline,
local file links are suppressed, and the ACP `resource_link` content type is
currently discarded because `AcpClient` reduces every assistant chunk to text.
Users cannot quickly scan or keyboard-open the files and URLs an agent handed
back.

## Solution

Add a deterministic, structured-first post-processing pass for sealed ACP
harness assistant messages. Krypton will preserve ACP `resource_link` and
embedded-resource chunks, then merge them with explicit links found in the
already-rendered Markdown DOM. The resulting deduplicated `MessageResource[]`
is rendered as a compact flat reference rail below the message, with the
existing transcript `f` hint mode generalized to open both resources and HTML
artifacts.

## Research

- ACP v1 defines `ContentBlock` as the structured display format for both
  prompts and model output. `resource_link` carries a URI, human name, optional
  title/description/MIME type, and size. Krypton's wire type already includes a
  reduced version, but `client.ts::extractText()` drops every non-text assistant
  block.
- ACP defines the `session/prompt` response as the reliable end-of-turn signal.
  Krypton already maps it to `AcpEvent { type: 'stop' }`, while
  `sealStreaming()` is also called before tool/plan/permission boundaries. That
  makes sealing the correct post-processing boundary without delaying streamed
  Markdown.
- ACP now supports optional `messageId` on message chunks. Preserving it avoids
  combining consecutive assistant messages that happen to have no intervening
  tool call. The resource rail must belong to the same message as its source.
- The sealed assistant body already contains the Markdown parser's final DOM.
  Scanning `a[href]` there is cheaper and more faithful than lexing the message
  a second time: only explicit links that the user can see become fallback
  resources.
- Zed keeps ACP `ResourceLink` as a distinct content variant. It renders a
  compact link control, resolves `file://` targets against the project, opens
  files in the editor, and marks non-file targets as external.
- VS Code chat exposes Markdown, anchors, references, buttons, and file trees as
  separate typed response parts. Its reference API accepts both editor
  locations and external URLs. This validates keeping resource semantics out of
  arbitrary prose.

### Alternatives rejected

- **A second AI extraction pass:** nondeterministic, adds latency/cost, and can
  invent resources that were not in the response.
- **Regex over all prose and inline code:** catches more path-like strings but
  misclassifies commands, examples, package names, and code snippets.
- **Prompted JSON/XML trailer:** depends on every adapter/model obeying a custom
  output contract, pollutes copied Markdown, and competes with ACP's existing
  typed content contract.
- **Typed ACP blocks only:** cleanest contract, but current adapters commonly
  stream links as Markdown text. The explicit-link fallback gives immediate
  value without guessing from prose.
- **A separate resources overlay:** removes message association and adds another
  mode. An inline rail keeps each reference beside the response that produced
  it.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Zed | ACP `ResourceLink` remains a distinct block; files open in-project and other URIs use an external-link action | Closest protocol-level precedent |
| VS Code | Chat responses have typed anchor, reference, button, and file-tree parts alongside Markdown | References are data, not inferred prose |
| Krypton today | Markdown URLs open externally; relative/local anchors are suppressed; typed assistant resources are dropped | Resource meaning is partially present but not retained |

**Krypton delta:** follow Zed and VS Code's typed-reference model, while adding a
strict Markdown-link compatibility pass for adapters that emit text only. Keep
Krypton's keyboard-first behavior by extending the existing hint interaction
instead of introducing mouse-only buttons or another overlay.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/types.ts` | Preserve full resource metadata; add assistant chunk content + optional message id to `AcpEvent` |
| `src/acp/client.ts` | Forward the original `ContentBlock` and `messageId` instead of collapsing assistant chunks to text only |
| `src/acp/message-resources.ts` | New pure classification, path parsing, normalization, merge, dedupe, and cap logic |
| `src/acp/message-resources.test.ts` | Unit tests for typed blocks, DOM links, line/column parsing, unsafe schemes, ordering, and dedupe |
| `src/acp/harness-view-types.ts` | Add `MessageResource`, per-item resource state, and current assistant message id |
| `src/acp/harness-markdown.ts` | Retain inert `file:` hrefs for post-processing while keeping direct anchor navigation suppressed |
| `src/acp/harness-transcript-render.ts` | Render the flat resource rail and include it in transcript render signatures |
| `src/acp/acp-harness-view.ts` | Route typed chunks, run post-processing at seal, generalize hint mode, and dispatch file/URL actions |
| `src/styles/acp-harness.css` | Resource rail, item, hint, hover, focus-visible, and narrow-lane styles |
| `src/compositor.ts` | Pass the harness a callback that opens a file reference in a new Helix tab at line/column |
| `docs/04-architecture.md` | Record the structured assistant-resource stage |
| `docs/05-data-flow.md` | Add the sealed-message resource flow |
| `docs/72-acp-harness-view.md` | Document the reference rail and generalized `f` hint mode |
| `docs/PROGRESS.md` | Record implementation completion |

## Design

### Data Structures

`ContentBlock.resource_link` is expanded to match ACP's useful metadata while
remaining tolerant of older agents:

```ts
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'resource_link';
      uri: string;
      name?: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    }
  // existing image, audio, and resource variants
```

Assistant events retain backward-compatible `text` for control-stream
consumers, plus the source block and optional ACP message id:

```ts
type AcpEvent =
  | {
      type: 'message_chunk';
      text: string;
      content: ContentBlock;
      messageId?: string;
    }
  // existing variants
```

The harness stores normalized resources on the assistant transcript item:

```ts
export interface MessageResource {
  key: string; // stable normalized identity, also used by event delegation
  kind: 'file' | 'url';
  target: string; // absolute file path or normalized external URI
  label: string;
  source: 'protocol' | 'markdown';
  line?: number;
  column?: number;
  mimeType?: string;
  size?: number;
  description?: string;
  hintLabel: string | null; // transient, only while hint mode is active
}

export interface HarnessTranscriptItem {
  // existing fields
  resources?: MessageResource[];
  resourcesScanned?: boolean;
}

export interface HarnessLane {
  // existing fields
  currentAssistantMessageId: string | null;
}
```

### Resource Sources and Precedence

Resources are merged in first-appearance order with a hard cap of 32 unique
items per assistant message.

1. `resource_link` chunk: classify `uri` directly and retain all metadata.
2. Embedded `resource` chunk: classify `resource.uri`; do not duplicate or
   display embedded text/blob content in the rail.
3. At seal, inspect the final assistant body for `a[href]` in DOM order.
4. Accept `http:`, `https:`, and `mailto:` as URL resources.
5. Accept `file:`, absolute paths, `./`, `../`, and other relative Markdown
   destinations as file resources. Resolve relative paths lexically against
   the harness project directory.
6. Ignore empty destinations, `#fragment`-only links, unknown schemes, and
   unsafe schemes such as `javascript:` or `data:`.
7. Parse file locations in `path:line[:column]` and `path#Lline[:column]`
   forms. The stored target excludes the location suffix.
8. Dedupe by normalized external URI or normalized
   `absolute-path + line + column`. When Markdown repeats a typed resource, the
   protocol resource wins because it carries better metadata; its original
   position is preserved.

The cap is a rendering and abuse bound. If more than 32 unique resources are
present, the rail shows `32 · +N hidden`.

### Message Boundaries

`AcpClient` forwards `update.messageId`. For a text or resource chunk:

- same id as `lane.currentAssistantMessageId`: append/merge into the current
  assistant item;
- changed non-empty id: seal the current assistant item, then start another;
- absent id: retain today's boundary behavior, using tool/plan/permission/stop
  events as separators.

This is backwards-compatible with agents that have not adopted message ids.

### Post-processing Flow

```text
1. Agent streams agent_message_chunk(ContentBlock).
2. Text blocks continue through streaming-markdown unchanged.
3. Typed resource blocks are normalized into the current assistant item but
   remain visually deferred while the message is streaming.
4. A message boundary calls sealAssistantStreamingMarkdown().
5. The final Markdown DOM is scanned once for explicit anchors.
6. Typed and Markdown resources are merged and deduplicated.
7. markdownHtml is cached without the resource rail.
8. The resource rail is appended beneath the cached Markdown body.
9. The final render signature includes resource keys and hint labels.
```

Keeping the rail out of `markdownHtml` prevents cached rerenders from nesting or
duplicating it.

### UI

The rail is part of the assistant message body, after the prose. It is one flat
ruled list, not cards nested inside the transcript row:

```text
agent  Implemented the parser in `client.ts` and documented the ACP contract.

       REFERENCES  2 files · 1 link
       [A] FILE  src/acp/client.ts:254                 OPEN HX
       [S] FILE  docs/206-assistant-response-resources.md
       [D] LINK  agentclientprotocol.com/protocol/v1/content
```

- The heading uses the existing label typography and compact count summary.
- File labels prefer project-relative display, retaining line/column.
- URL labels prefer explicit Markdown/ACP titles; otherwise show host + path.
  The full target is available in `title`/accessible text.
- Rows use a quiet background tint and separators; no nested card, side accent
  rail, blur, or decorative animation.
- `:focus-visible` uses the existing solid lane-accent outline and glow.
- Long targets truncate visually but retain their full accessible label.
- At narrow lane widths, the action label drops before the target truncates.
- Mouse click is supported as a secondary path through event delegation.

### Keyboard and Actions

| Key | Context | Action |
|-----|---------|--------|
| `f` | Transcript command mode | Enter unified follow/open hint mode for visible resources and available artifacts |
| hint label | Hint mode | Open the matching resource/artifact, then exit hint mode |
| `Esc` | Hint mode | Exit without opening |

Hint targets are assigned in transcript order, so resources stay associated
with their message and existing artifact cards retain the same interaction.

- File resource: callback to `Compositor.openHelixTab(path, line, column)`;
  failure reports through the harness status chip.
- `http`/`https` resource: `openExternalUrl(..., { external: true })` in the OS
  browser.
- `mailto` resource: the same external handler, allowing the OS default mail
  application.
- No target opens automatically when extracted or rendered.

Inline Markdown URL clicks continue to work as today. Inline local/file anchors
remain inert; the reference rail is their explicit, keyboard-safe open path.

### Failure and Security Behavior

- Malformed URLs and percent-encoding failures are ignored without failing the
  message render.
- Unknown schemes remain plain Markdown and never become actions.
- `file:` is retained in the sealed DOM only as inert metadata. The root click
  interceptor continues to suppress direct file-anchor navigation.
- Path normalization is lexical and side-effect free. Opening is explicit and
  user-triggered; Helix reports missing/unreadable files normally.
- Resource processing never reads target files, fetches URLs, performs DNS, or
  mutates the project.
- A renderer or extractor failure leaves the assistant Markdown intact and logs
  one scoped warning; it must not convert the whole turn into an error.

### Performance

- No processing on text deltas beyond today's append-only Markdown path.
- One `querySelectorAll('a[href]')` pass per sealed assistant item.
- O(n) merge with a `Map`, capped at 32 unique resources.
- No new timers, observers, network requests, or per-frame work.

## Validation

- Unit tests cover classification, path locations, normalization, metadata
  precedence, deterministic ordering, unsafe schemes, duplicates, and cap
  reporting.
- Focused unit tests cover sealed-DOM anchor inputs, resource-only typed chunks,
  metadata precedence, ordering, unsafe schemes, locations, and cap behavior.
- Client tests prove non-text `ContentBlock` and `messageId` survive the ACP
  event bridge.
- Existing streaming-Markdown, URL sanitization, artifact hint, transcript cap,
  and control-stream tests remain green.
- Run `npm run check`, targeted Vitest files, full `npm test`, and
  `npm run build`.
- Run `/perf-checklist acp-harness` after implementation because this changes a
  transcript render path.

## Edge Cases

- A message containing only a typed resource still renders one assistant row
  with a reference rail and no empty prose placeholder.
- The same URL with different visible labels is one resource; first position is
  retained and typed metadata may upgrade the label.
- The same file at two different lines is two actions.
- URL fragments are retained; file `#L...` fragments become editor locations.
- Query strings are retained for external URLs and never interpreted as file
  metadata.
- Resources split around a tool call attach to the assistant message on the
  correct side of that tool.
- Session replay follows the same chunk/seal path, so loaded resources are not a
  separate renderer case.
- If an agent sends an image/audio block, existing behavior is unchanged; this
  spec does not coerce it into a resource.

## Open Questions

None. The initial scope and fallback policy are fully specified for approval.

## Out of Scope

- Arbitrary path inference from prose, inline code, shell commands, or code
  fences
- A second AI classifier or custom structured-output prompt
- Fetching URL titles, favicons, previews, or Open Graph metadata
- Reading file metadata/content for previews
- Inline image/audio/PDF preview in the resource rail
- New ACP adapter behavior that forces agents to emit `resource_link`
- Standalone `AcpView`, embedded `AgentView`, Telegram, or browser dashboard
  rendering; v1 is scoped to the ACP Harness
- Persistent/cross-session resource indexing or a global resources overlay

## Resources

- [ACP v1 Content](https://agentclientprotocol.com/protocol/v1/content) —
  `ContentBlock`, embedded-resource, and `resource_link` contract.
- [ACP v1 Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) —
  assistant chunk, message id, and prompt completion lifecycle.
- [VS Code Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat) —
  typed anchors, references, file trees, buttons, and Markdown response parts.
- [Zed ACP thread content handling](https://github.com/zed-industries/zed/blob/3d9852ae04/crates/acp_thread/src/acp_thread.rs) —
  local-source-verified structured `ResourceLink` retention and merging.
- [Zed resource-link rendering](https://github.com/zed-industries/zed/blob/3d9852ae04/crates/agent_ui/src/conversation_view/thread_view.rs) —
  local-source-verified file/project resolution and external-link affordance.
