# ACP Harness Inline Images — Implementation Spec

> Status: Implemented
> Date: 2026-10-09
> Milestone: ACP Harness

## Implementation Deviations

- **`o` opens in the OS default image app** (`open_url` with a `file://` URI, the same route as the HTML artifact cards). It does not use `openFileReferenceCb`, which opens files in Helix and cannot show images.
- **Lane state is `HarnessLane.imageState: LaneImageState`**, which holds the byte total, the live list, per-turn `turnPaths`, and the load queue. This replaces a lone `imageBytes` field.
- **`key=value` tokens** such as `--output=/tmp/x.png` are scanned using the part after the first `=`.
- **A whole string value with spaces counts as one path** only when it starts with `/`, `~/`, `./`, `../`, or `file://`. Its tokens are still scanned as well. This catches the case where a space-separated list of paths is mistaken for a single path; the wrong whole candidate then disappears silently.
- **The image strip is a sibling of the row body**, not inside it. Streaming rows have their strip patched in place; sealed rows rebuild when their image signature changes.

## Problem

Agents work with images all the time. They download screenshots from a GitHub issue, read image files, receive images from MCP tools, and generate images. The harness lane shows none of them:

- An image `ContentBlock` is dropped without a trace.
- An image path the agent or user works with (a download destination, a read, a write, or a path in a reply) appears only as a string.
- An image the user sent shows only as a `▧ N images` chip.

There is also no way to view, enlarge, or step through images.

## Solution

Every image that belongs to a row becomes a `HarnessImage`, backed by a `Blob` and an `object URL`. There are two sources:

1. **inline bytes**: base64 in an ACP block (`image`, or a `resource` blob). It is decoded once, synchronously.
2. **local file**: any local image path that appears in the lane. It may come from an explicit protocol field (a tool `locations` entry or a `resource_link`), or from a scan of tool input/output text, reply text, and prompt text, such as `curl -o /tmp/x.png`, `screencapture ~/Desktop/a.png`, or "saved to `/tmp/issue-42.png`". It is loaded through a new Rust command, `read_image_file`, which returns raw bytes only when the magic bytes show the file is an image. This covers files outside `$HOME`, such as `/tmp`.

Assistant, user, and tool rows show a strip of thumbnails. The `f` open-hint mode (spec 206) gains image targets that open a keyboard-driven image viewer overlay. Blob URLs keep base64 out of `markdownHtml` and leave the markdown sanitizer untouched.

## Research

- **Wire format (ACP = MCP).**
  - `{type:'image', data:<base64>, mimeType, uri?}`.
  - A `resource` can carry `blob` with an image `mimeType`.
  - `promptCapabilities.image` only governs prompts. Receiving images needs no capability.
- **The GitHub issue flow, in two steps.**
  - The skill `analyze-github-issue` says: `curl -sL -H "Authorization: token $(gh auth token)" <user-attachments url> -o /tmp/...` and then `Read` the file.
  - What the user wants is for that image to show in the chat at the second step.
- **How the adapters send it** (installed sources):
  - **claude-agent-acp:** `tool-calls/content.js:91-102` turns a tool-result image (from `Read` on a `.png`) into `{type:'image', data, mimeType}` inside the tool content. So the bytes arrive in a `tool_call_update`. A URL-sourced image becomes the text `[image: <url>]`.
  - **codex-acp:**
    - The `view_image` tool (`index.js:28229-28247`) sends **only** a `resource_link` with `uri: <path>` and `locations:[{path}]`, with no bytes. To render it, Krypton has to read the file itself.
    - Image generation (`index.js:28740-28749`) sends bytes plus `uri: savedPath`.
- **Where Krypton loses them today:**
  - Rust passes the `update` through unchanged (`acp.rs:1463-1490`).
  - `client.ts:292` applies `extractText` to `user_message_chunk`, so user images are lost on replay.
  - The harness drops agent image blocks at `acp-harness-view.ts:7876-7889`, because `resourceFromContentBlock` returns `null` for them.
  - In tool rows, `contentBlockText` returns `''` for images (`harness-tool-render.ts:252-257`). Retention then sets `data` to `''` (`harness-tool-retention.ts:52-55,73`). So the extraction must run **before** compaction.
  - `resource_link` and file references (spec 206) feed only the reference rail. Their `mimeType` is metadata only.
- **File access limits.**
  - The asset protocol scope is `$HOME/**`, so `/tmp/*.png` cannot use `convertFileSrc` (it breaks with IMG BREACH).
  - `sniff_binary_kind` (`acp.rs:944`) already sniffs png, jpeg, gif and webp. It can be reused.
- **Markdown `![](path|https)`** already renders through `resolveLocalImageSrcs` and the https allowlist in `sanitizeSrc`. This spec does not touch it.
  - [INFERENCE] A remote image from a public repo already loads as `<img src=https>`, because CSP is `null`. I have not tested this at runtime.
- **Memory.** Transcripts are in memory and capped at 300 rows, with a render window of 60. A `Blob` holds binary, about 75% of the base64 size. `URL.revokeObjectURL` releases it.
- **Rejected alternatives:**
  - Widening the asset scope to `/tmp/**`. That exposes everything under `/tmp` to the webview without checking that a file is an image.
  - Putting `data:` URLs in markdown or `<img>`. This conflicts with the sanitizer in spec 117 and duplicates the string.
  - Krypton fetching the GitHub URL itself. It would need the user's `gh` token, and it would leak requests for every URL in the transcript. The agent already downloads the file.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed agent panel | `acp_thread.rs:1423` decodes an ACP `Image` into `ContentBlock::Image`, falling back to markdown if decoding fails. `render_image_output` (`thread_view.rs:10483`) draws tool images at `max_w_96`/`max_h_96` `ScaleDown`, plus "Go to File" when the tool has a `location`. | It also decodes `resource` blobs that are images. There is no zoom viewer. |
| VS Code Copilot Chat | MCP tool images show inside the tool section with a download button, and are not carried into the final reply ([vscode#254283](https://github.com/microsoft/vscode/issues/254283)). | Tool-scoped rendering is the norm. |
| Krypton `AcpView` | `acp-view.ts:395-410`: `data:` thumbnails of sent images. | The only ACP surface showing images today. |

**Krypton delta**
- **Matches the norm:** images render inline in the row that owns them, tool images stay inside the tool row, and thumbnails are scaled down.
- **Differs:**
  - Images can come from a local path, so Codex `view_image` and the download→Read flow both show.
  - The viewer is keyboard-first: `f`-hint, then `n`/`p`/`=`/`-`/`0`/`1`/`hjkl`. Zed and VS Code have no zoom or pan.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | New command `read_image_file(path) -> tauri::ipc::Response`. |
| `src-tauri/src/acp.rs` | Make `sniff_binary_kind` `pub(crate)` for reuse. |
| `src-tauri/src/lib.rs` | Register the command. |
| `src/acp/harness-images.ts` (new) | Decode, sniff, allowlist, the `findImagePaths` scanner, path loader, per-turn dedupe, byte budget, and the create/release lifecycle. |
| `src/acp/harness-image-viewer.ts` (new) | Viewer overlay, zoom/pan state, and keys. |
| `src/acp/harness-view-types.ts` | `HarnessImage`. `images?: HarnessImage[]` on the row (replaces `imageCount`). `HarnessLane.imageBytes`. |
| `src/acp/types.ts`, `src/acp/client.ts` | `user_message_chunk` carries a normalized `content: ContentBlock`. |
| `src/acp/acp-harness-view.ts` | Attach images from every source. Add open targets. Give viewer keys precedence before L4037. Release images on eviction, remove, `#clear`, and lane close. |
| `src/acp/harness-steer-controller.ts`, `harness-view-host.ts` | Steer rows carry `images`. |
| `src/acp/harness-tool-render.ts` | `extractToolImages(call)` returns byte sources and path sources. |
| `src/acp/harness-transcript-render.ts` | `renderImageStrip(item)` for assistant, user and tool rows. Replaces `renderImageAttachmentChip`. Image state goes in the signature. |
| `src/styles/acp-harness.css` | `.acp-harness__images`, `__image-thumb`, `__image-tile`, `__image-viewer*`. Drop `__msg-attachment`. |
| `docs/72-acp-harness-view.md`, `docs/206-assistant-response-resources.md`, `docs/04-architecture.md` | Keys, image targets, and the new IPC command. |

## Design

### Data Structures

```ts
// harness-view-types.ts
export type HarnessImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export interface HarnessImage {
  imageId: string;                       // discriminator for open targets
  origin: 'bytes' | 'path';
  path: string | null;                   // absolute; set for origin 'path' (and bytes with file uri)
  discovery: 'explicit' | 'scanned';     // scanned = found by the path scanner (below)
  state: 'loading' | 'live' | 'released' | 'rejected' | 'missing';
  mimeType: HarnessImageMime | null;     // null until loaded / when rejected
  bytes: number;
  objectUrl: string | null;              // non-null only in 'live'
  label: string;                         // basename(path|uri) | `image n`; set via textContent
  source: 'agent' | 'user' | 'tool';
  hintLabel: string | null;
}
```

```ts
// harness-images.ts
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;     // per image, decoded
export const LANE_IMAGE_BUDGET = 64 * 1024 * 1024;   // live bytes per lane
export const IMAGE_PATH_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
export const MAX_PATH_IMAGES_PER_ROW = 8;
export function findImagePaths(text: string): { paths: string[]; overflow: number };   // ordered, deduped, paths ≤ MAX_PATH_IMAGES_PER_ROW
export function imageFromBlock(block: ContentBlock, source: HarnessImage['source'], n: number): HarnessImage | null;
export function imageFromPath(path: string, source: HarnessImage['source'], discovery: HarnessImage['discovery']): HarnessImage; // 'loading'
export async function loadPathImage(lane: HarnessLane, image: HarnessImage): Promise<void>;   // invoke + retain
export function retainImage(lane: HarnessLane, image: HarnessImage): void;  // releases oldest live while over budget
export function releaseImages(lane: HarnessLane, images: HarnessImage[] | undefined): void;
export function releaseAllImages(lane: HarnessLane): void;
```

### Byte sources

- **Blocks:**
  - `{type:'image', data}`.
  - `{type:'resource', resource:{blob, mimeType:'image/*'}}`.
- **Decoding:** `Uint8Array.fromBase64` if available, otherwise an `atob` loop.
- **Sniff:** check PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF8` and WEBP `RIFF....WEBP`. The sniffed type wins.
- **Rejected:** SVG, other MIME types, and anything over `IMAGE_MAX_BYTES` are marked `rejected`.
- **Empty `data` with a file `uri`** (e.g. Claude URL-source images) falls through to a path source.

### Path sources (only when `remoteRuntimeId` is unset)

**Explicit** (`discovery:'explicit'`). These come from protocol fields, so the agent definitely meant to point at the file:
1. **Tool `content`:** a `resource_link` whose `uri`/`name` matches `IMAGE_PATH_EXTENSIONS` or has `mimeType:'image/*'` (Codex `view_image`).
2. **Tool `locations[].path`:** every `kind` (read, edit, write, execute, and so on) whose path matches `IMAGE_PATH_EXTENSIONS`.
3. **Assistant `MessageResource`s** (spec 206) of `kind:'file'` whose `target` matches `IMAGE_PATH_EXTENSIONS`.

**Scanned** (`discovery:'scanned'`). `findImagePaths` runs over text:
4. **Tool `rawInput`:** every string value, walked recursively, including `command`, `file_path`, `path`, `output`, and so on. Example: Bash `curl -sL … -o /tmp/issue-42.png`.
5. **Tool output text:** text `content` blocks and string `rawOutput`, such as `screencapture` / `ls -d /tmp/*.png` output or "Saved image to …".
6. **Assistant reply:** the sealed markdown source (`item.text`), plain text and code spans alike. Example: "I downloaded it to `/tmp/issue-42.png`".
7. **User prompt:** the text of the user row. Example: "look at ~/Desktop/bug.png".

**`findImagePaths` rules:**
- **Tokenization:** a shell-like tokenizer that respects `'…'` and `"…"` quotes and backslash-escaped spaces. After that, each token is trimmed of trailing `` ` ``, `)`, `]`, `>`, `,`, `;`, `:`, and `.`.
  - A JSON string value that is itself a path counts as a single token, even if it contains spaces.
- **What a token must look like:** it must end in `IMAGE_PATH_EXTENSIONS`, and its form must be one of:
  - an absolute path (`/…`)
  - `~/…`
  - `file://…`
  - `./…` or `../…`
  - a relative path containing at least one `/` (`docs/shot.png`)
  - A bare file name (`shot.png`) does not count, because there is not enough to resolve it, and it is the main source of false positives in `ls` output.
  - `-o/tmp/x.png` style tokens are not split. Only a whole token is read as a path.
- **Tokens that are skipped:**
  - URLs (`http(s)://`, `data:`, `blob:`). They are not local files.
  - Tokens containing a glob (`*`, `?`, `[`) or `$`, which need shell expansion.
- **Input bound:** at most 64 KB of text per source, the same as tool retention.

**Normalization and dedupe:**
- `file://` is stripped.
- `~` is expanded **in Rust**, because the frontend does not know HOME for sure.
- A relative path is joined to the lane's `projectDir`, as `resourceFromContentBlock` already does.
- Within a row, images are deduped by absolute path. Explicit wins over scanned, and bytes win over path: if a Claude `Read` sends both the bytes and `locations`, it shows once.
- **Within a turn** (one prompt to the next `idle`), the same path shows a thumbnail only in the first row that touched it. Example: `curl -o` shows it; the following `Read` and the reply that mentions the same path do not repeat it.
  - Exception: if a later row in the same turn writes the file again (an explicit `edit`/`write` location), the path loads again so the current content is shown.

**When loading happens:**
- **Tool:** when the call reaches `completed`/`failed`, because the file may not exist until a download finishes. Explicit `read` locations load immediately.
- **Assistant:** at seal.
- **User:** at send, or when a replayed user row seals.
- Loads run one at a time per lane.

**When a load fails:**
- **Explicit:** show a tile (`missing`/`rejected`/`too large`).
- **Scanned:** the image is dropped silently. A scanner hit that turns out not to be a real image file is noise and should leave no trace.

### API / Commands

```rust
/// Raw bytes of an image file for the harness image strip (spec 281).
/// Errors: "not found", "too large", "not an image". Never returns non-image bytes.
#[tauri::command]
pub async fn read_image_file(path: String) -> Result<tauri::ipc::Response, String>
```

1. Expand a leading `~/` with `dirs::home_dir`. The result must be absolute (the frontend has already joined relative paths to `projectDir`). Then `canonicalize`.
2. Check `metadata.len() ≤ 10 MiB`, otherwise return `"too large"`.
3. Read the file with `tokio::fs::read`.
4. Sniff the head **by magic bytes only**. Extension fallback is not used here.
   - The result must be one of the 4 image types, otherwise return `"not an image"`.
5. Return `Response::new(bytes)`. The frontend receives an `ArrayBuffer`, builds `new Blob([buf], {type})`, then calls `createObjectURL`.

### Data Flow (GitHub issue screenshot)

```
1. Agent runs Bash `curl -sL -H "Authorization: …" <url> -o /tmp/issue-42.png`
2. tool_call (pending) → findImagePaths(rawInput.command) → ['/tmp/issue-42.png'] held in pendingImagePaths (scanned)
3. tool_call_update status completed → loadPathImage → invoke('read_image_file')
   → Blob → objectUrl → 'live' → retainImage → re-render the Bash row (thumbnail appears)
4. Agent reads the file:
   Claude: tool_call_update content image bytes + locations [/tmp/issue-42.png]
   Codex:  view_image resource_link '/tmp/issue-42.png'
   → same path already shown this turn → no duplicate thumbnail
5. Agent replies "…the screenshot at `/tmp/issue-42.png` shows…" → seal → scanned → dedupe → skip
6. `f` lists the Bash row's thumbnail as a target → viewer
```

- **Scan hooks** in `extractToolImages(call)` run **before** `compactToolCallForRetention`, and so do the explicit sources. The candidate list for a tool (`pendingImagePaths`) is stored on the row until the call reaches terminal status.

- **Agent `agent_message_chunk` image block:**
  1. `appendAssistantImage` → `appendStreaming(lane,'assistant','')`, the same way `appendAssistantResource` does.
  2. Push the image into `item.images`, then do a full row render.
  3. The strip sits below the markdown body.
- **Assistant file paths (sources 3 and 6):** created when the row seals (`resourcesScanned`), or when a protocol `resource_link` arrives.
- **User prompt paths (source 7):** scanned at send time and loaded right away.
- **User send:** built from `StagedImage.data` when `buildUserBlocks` runs. Steer does the same.
- **User replay** (session picker `session/load`): an image in a `user_message_chunk` attaches to the current streaming user row. Restart replay stays muted, as before.
- **Tool update replacing content:** an image whose key is the same keeps its URL.
  - Byte image key: `mime + bytes + first/last 32 base64 characters`.
  - Path image key: the path.
  - Images that are no longer present are released.
- **Release:**
  - Rows evicted by `appendBoundedTranscriptItem` and rows removed by `removeTranscriptItem` → `releaseImages`.
  - `#clear`, lane close, and dispose → `releaseAllImages`.
  - Over the budget, the oldest `live` images become `released`.
  - A `released` path image reloads on demand when it is opened in the viewer. A byte image shows the tile.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `f` | Transcript focus | Open-hint mode. Every `live` or `released` image is a target, listed in transcript order. |
| `<label>` | Open-hint mode, image target | Open the viewer on that image |
| `Esc` | Viewer | Close, returning to transcript focus |
| `n` / `p` | Viewer | Next/previous openable image in the lane (wraps) |
| `=` / `-` | Viewer | Zoom ×1.25 / ÷1.25 (range 0.1–8) |
| `0` / `1` | Viewer | Fit / 100% |
| `h` `j` `k` `l` | Viewer, zoomed past fit | Pan 10% (`Shift` = 50%) |
| `o` | Viewer, image with `path` | Run `openFileReferenceCb(path)`, the same path as 206 file references |

- The viewer check `if (this.imageViewer) return this.imageViewer.handleKey(e)` sits right before L4037. It takes precedence over every harness key, and unbound keys are swallowed.
- Mouse is secondary: click a thumbnail to open it, click the backdrop to close.

### UI Changes

```html
<div class="acp-harness__images">                    <!-- after msg-body / tool body -->
  <figure class="acp-harness__image-thumb" data-image-id="…">
    <img src="blob:…" alt="issue-42.png" decoding="async" loading="lazy">
    <figcaption>issue-42.png · 312 KB</figcaption>
    <span class="acp-harness__hint-label">a</span>  <!-- f mode only -->
  </figure>
  <div class="acp-harness__image-tile">IMG LOADING // issue-42.png</div>
</div>
<div class="acp-harness__image-viewer">              <!-- absolute fill of harness root -->
  <div class="acp-harness__image-viewer-stage"><img></div>
  <div class="acp-harness__image-viewer-meta">2/5 · issue-42.png · 1920×1080 · 100%</div>
</div>
```

- **Tile text:** `IMG LOADING`, `IMG RELEASED`, and, for explicit sources only, `IMG REJECTED // <mime> <size>` and `IMG MISSING // <path>`. A remote runtime shows no path tiles at all.
- **Thumbnails:** `max-height: 240px; max-width: min(100%, 480px); object-fit: contain`, in a strip that wraps.
- **Style:**
  - Full 1px `--krypton-*` border, with no corner brackets and no `backdrop-filter`.
  - The viewer backdrop is a solid rgba fill.
  - Zoom and pan use `transform: translate() scale()`.
- **Text content:** `alt` and `figcaption` are set only through attributes and `textContent`.
- **Viewer status chip:** `image viewer · n/p next · =/- zoom · 0 fit · o open · Esc close`.

### Configuration

None. The limits are constants.

## Edge Cases

- **An image block arrives before any text:** `appendStreaming(lane,'assistant','')` creates the row.
- **An image arrives mid-stream:** the row gets one full render. Image events are rare, so the spec 114 budget is still met.
- **The file is deleted before it loads:** `"not found"`. Explicit → `missing`; scanned → dropped.
- **A non-image file has a `.png` name:** `"not an image"`. Explicit → `rejected`; scanned → dropped. No bytes reach the webview.
- **Many paths in one row** (e.g. `ls` listing 200 png files): `findImagePaths` keeps the first `MAX_PATH_IMAGES_PER_ROW = 8` and the strip shows a `+N more` tile, where N is `overflow`.
- **A scanner false positive** (e.g. `const out = './dist/logo.png'` in code being shown): the file probably exists and really is an image, so it shows. This is acceptable, because it is a real local image the agent touched.
- **Paths with spaces:** found only when the text quotes them (`"/tmp/my shot.png"`) or escapes them (`my\ shot.png`), or when the path is a whole JSON string value.
- **A Bash command that fails** (`failed`) still loads candidates. A file may exist from an earlier run; if it does not, it is dropped silently.
- **The row is evicted while a load is in flight:** when the load resolves, it sees the row is gone and revokes its URL immediately.
- **The viewer is open while its image is released or evicted:** move to the next openable image, or close if there are none.
- **The lane switches or `#clear` runs:** the viewer closes.
- **Remote runtime:** byte images work. Path sources (explicit or scanned) are skipped entirely, because the files are on another machine.
- **Live Assist and control SSE:** unchanged, raw events only.
- **Privacy and performance of the scanner:** reads go only to local files and only through magic-byte checks. Nothing goes to the network. The 64 KB bound per source and running only at terminal status/seal keep the cost off the streaming hot path (spec 114).

## Open Questions

None.

## Out of Scope

- Krypton fetching remote image URLs itself (with or without the `gh` token). The agent downloads them, and Krypton renders the local file.
- Image paths without a `/` (a bare `shot.png`), glob patterns, or paths that need `$VAR` expansion.
- Running the image strip again when a file changes after the turn ends (there is no watcher).
- Images inside `agent_thought_chunk`.
- SVG, frame control for animations, and audio.
- Copying to the clipboard or saving.
- Path images on remote runtimes. That needs a remote-protocol file proxy.
- Changes to markdown `![](…)` and the sanitizer (spec 117/137).

## Resources

- [ACP Content](https://agentclientprotocol.com/protocol/v1/content): the `image`/`resource` blob shapes; prompt capability applies to prompts only.
- [vscode#254283](https://github.com/microsoft/vscode/issues/254283): Copilot Chat renders MCP images in the tool section.
- Zed `crates/acp_thread/src/acp_thread.rs:1390-1458`, `crates/agent_ui/src/conversation_view/thread_view.rs:10483-10521`: decode with a fallback, bounded tool image, Go to File.
- `@agentclientprotocol/claude-agent-acp` `dist/tool-calls/content.js:80-102`: tool-result image → ACP image block.
- `@agentclientprotocol/codex-acp` `dist/index.js:28229-28247, 28740-28749`: `view_image` sends only a `resource_link` path; image generation sends bytes plus `savedPath`.
- Skill `analyze-github-issue` (Workflow step 1): the download-to-`/tmp`-then-`Read` flow for GitHub `user-attachments`.
- [Tauri v2 `ipc::Response`](https://docs.rs/tauri/latest/tauri/ipc/struct.Response.html): returns raw bytes as an `ArrayBuffer` without JSON or base64.
- [MDN URL.createObjectURL](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static): the object-URL lifecycle.
