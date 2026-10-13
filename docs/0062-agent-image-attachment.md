# Agent Image Attachment — Implementation Spec

> Status: Implemented
> Date: 2026-04-15
> Milestone: M8 — Polish

## Problem

The AI agent windows only accept text input. Users cannot send screenshots, diagrams, or error images to the agent, limiting its usefulness for visual debugging and UI work.

## Solution

Extend the agent input to accept images via paste (Cmd+V) and drag-and-drop. Staged images are shown as thumbnails above the input line and sent alongside the text prompt as a multi-part `UserMessage`. The pi-ai layer already serializes `ImageContent` blocks to the ZAI vision API — the changes are confined to the input path, `AgentController`, and the Rust config struct.

## Research

**pi-ai layer (ground truth from source):**
- `UserMessage.content` accepts `string | (TextContent | ImageContent)[]`
- `ImageContent` is `{ type: "image"; data: string; mimeType: string }` — base64-encoded
- `openai-completions.ts:546–563` converts `ImageContent` → `image_url` data URLs; silently filters images for models where `model.input` doesn't include `"image"`
- ZAI models `glm-4.5v` and `glm-4.6v` have `input: ["text", "image"]` on the same coding API endpoint — full coding capability retained
- `agent.prompt()` accepts a raw `AgentMessage` (not just string) — passing a `UserMessage` with content array requires no new pi-agent-core API

**Browser image APIs:**
- `ClipboardEvent.clipboardData.items` — find `item.type.startsWith("image/")`, `item.getAsFile()` → `FileReader.readAsDataURL()` → strip prefix for raw base64
- `DragEvent.dataTransfer.files` — same `File` → base64 path
- No Tauri commands needed; images stay in-memory as base64 strings

**Prior art in codebase:**
- `agent-view.ts:142` — paste handler exists for text; image branch added alongside it
- `agent.ts:596` — `this.agent.prompt(text)` becomes `this.agent.prompt(userMessage)` when images present
- `agent.ts:488` — persisted user message; images stripped, placeholder appended to text
- `config.rs:397` — `AgentModelConfig` has no `vision` field; needs adding with `#[serde(default)]`

## Prior Art

| App | Implementation |
|-----|----------------|
| ChatGPT web | Paperclip + drag-drop. Thumbnail chips in composer, sent with text on Enter. |
| Claude.ai web | Paperclip + paste. Previews inline in composer. |
| Cursor | Paste image into chat, thumbnail preview, submit on Enter. |
| Warp terminal | Not supported — text-only AI input. |
| iTerm2 / WezTerm | No AI image input. |

**Krypton delta:** No paperclip button (keyboard-first). Paste and drag-drop only. Thumbnails above the input line, not inline with text. Vision capability declared explicitly in TOML config rather than auto-detected.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/config.rs` | Add `#[serde(default)] pub vision: bool` to `AgentModelConfig` |
| `src/agent/agent.ts` | `AgentModelPreset` gets `vision?: boolean`; `prompt()` gets `images?: ImageContent[]` param; build `UserMessage` with content array when images present; strip images before `persistMessage()`, append placeholder; add `supportsVision()` method |
| `src/agent/agent-view.ts` | Paste handler → detect image type; drag-drop handlers; staging state (`ImageContent[]`) + thumbnail DOM; `submit()` passes images + vision warning; `appendUserMessageDom()` renders thumbnails; Ctrl+C clears staged images |

## Design

### Data Structures

```typescript
// ImageContent imported from '@mariozechner/pi-ai' — used directly in both files:
// { type: "image"; data: string; mimeType: string }

// New field on AgentView:
private stagedImages: ImageContent[] = [];  // max 4

// AgentController.prompt() extended signature:
async prompt(
  text: string,
  onEvent: AgentEventCallback,
  commandArgs?: string,
  images?: ImageContent[],
): Promise<void>

// New method on AgentController:
supportsVision(): boolean {
  return this.activePreset?.vision ?? false;
}
```

```rust
// config.rs — AgentModelConfig
#[serde(default)]
pub vision: bool,
```

### Data Flow

```
1. User presses Cmd+V with an image in clipboard
2. paste event: iterate clipboardData.items, find item.type.startsWith("image/")
3. item.getAsFile() → FileReader.readAsDataURL() → strip "data:<mime>;base64," prefix
4. If stagedImages.length >= 4: show system hint "Max 4 images per message"
5. If base64 size > 5MB: show system message "Image too large (max 5MB)"
6. Otherwise: push ImageContent to stagedImages[]; renderStagingArea() shows thumbnail row
7. User types text (optional) and presses Enter
8. submit(): if !text && stagedImages.length === 0 → return early
9. If stagedImages.length > 0 && !controller.supportsVision():
     show system message "Current model doesn't support vision — image will be ignored.
     Switch to a vision model with /model."  (submit still proceeds)
10. controller.prompt(text, onEvent, undefined, stagedImages)
11. stagedImages cleared; renderStagingArea() hides thumbnail row
12. AgentController.prompt(): build UserMessage:
      content = [{ type:'text', text }, ...images]  (text block omitted if text is empty)
13. persistMessage(): strip ImageContent blocks, append "[N images attached]" to text
14. agent.prompt(userMessage) — pi-agent-core sends multi-part content to API
15. appendUserMessageDom(text, images) renders thumbnails + text in conversation
```

### UI Changes

**Staging area** — `div.agent-view__staging`, always in DOM, hidden via `display:none` when empty. Shown between `.agent-view__messages` and `.agent-view__input-row`:
```
┌─────────────────────────────────────────────────────┐
│ [48px thumb] [48px thumb]   Ctrl+C to clear         │
├─────────────────────────────────────────────────────┤
│ ❯ type your message…                                │
└─────────────────────────────────────────────────────┘
```
Thumbnails: `<img class="agent-view__staged-thumb">` max-height 48px, border using `--krypton-accent` color.

**User message with images:**
```
YOU  [48px thumb] [48px thumb]
     describe this error
```
Images rendered before text. If image-only message, no text line shown.

**Drag-drop** — `.agent-view` gets `dragover` + `drop` listeners. `agent-view--drag-over` class shows a dim overlay with centered "DROP IMAGE" label (cyberpunk all-caps, accent color).

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| Cmd+V | Input state, image in clipboard | Stage image (accumulates up to 4) |
| Cmd+V | Input state, text in clipboard | Existing text paste — unchanged |
| Ctrl+C | Input state, agent idle | Clear input text AND all staged images |
| Enter | Input state | Submit text + staged images (text may be empty if images present) |

### Configuration

New field in `krypton.toml` agent model preset:

```toml
[[agent.models]]
name = "zai-vision"
provider = "zai"
model = "glm-4.6v"
base_url = "https://api.z.ai/api/coding/paas/v4"
api_key_env = "ZAI_API_KEY"
context_window = 128000
max_tokens = 8192
vision = true          # enables image attachment for this preset
```

`vision` defaults to `false` via `#[serde(default)]` — existing configs unaffected.

## Edge Cases

- **Paste with multiple image items**: only the first image item taken; remaining ignored silently.
- **Paste accumulation**: user can paste up to 4 times to stage multiple images.
- **Non-image paste**: existing text path runs unchanged.
- **Drag-drop non-image file**: silently ignored.
- **Image > 5MB**: system message shown, image not staged.
- **4 images already staged**: system hint shown on 5th paste attempt, image not staged.
- **Agent running when image pasted**: stage normally — sent on next submit.
- **Non-vision model with staged images**: system warning shown at submit; submit proceeds; pi-ai drops image content before API call.
- **Session restore**: user messages show `[N images attached]` placeholder where images were; thumbnails not restored.
- **Image-only message (no text)**: submit allowed; `UserMessage.content` contains only `ImageContent` blocks (no empty text block).

## Out of Scope

- File picker / paperclip button
- Per-image keyboard removal (Ctrl+C clears all)
- Image from path (`/path/to/img.png` typed in input)
- Vision model auto-switching
- Image display in the ContextView inspector
- Image persistence in session files

## Resources

- pi-mono: `packages/ai/src/types.ts` — `UserMessage`, `ImageContent` definitions
- pi-mono: `packages/ai/src/providers/openai-completions.ts:546–563` — image serialization and filtering
- pi-mono: `packages/ai/src/models.generated.ts:14080–14140` — ZAI vision model definitions
- MDN: [ClipboardEvent.clipboardData](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardEvent/clipboardData)
- MDN: [DataTransfer.files](https://developer.mozilla.org/en-US/docs/Web/API/DataTransfer/files)
