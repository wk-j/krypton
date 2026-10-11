# ACP Harness Reference Thumbnails — Implementation Spec

> Status: Implemented
> Date: 2026-10-11
> Milestone: ACP Harness

## Problem

The REFERENCES rail (spec 206) beneath a sealed assistant message is text-only: a `FILE`/`URL` badge, label, path, Git state (spec 207), and an open action. Nothing shows what a file is at a glance. An image reference also shows twice: as a text row in the rail and as a thumbnail in the separate image strip (spec 281 source 3). Its rail row opens Helix, which cannot display images.

## Solution

Replace the rail's `FILE`/`URL` kind badge with a 48×34 leading thumbnail (layout option (a) from the design discussion):

- **Image file references** reuse an object URL that spec 281 has already loaded. They add no IPC and no new bytes.
- **Other files** get a deterministic extension glyph.
- **URLs** get a globe icon.

An image covered by the rail drops out of the row's image strip, so each image appears once. Opening an image reference opens the image viewer. Path, Git state, and `+/−` stay in the row unchanged.

## Research

- `renderMessageResource` (`harness-transcript-render.ts:642`) builds each row as `hint | kind | content | git | action`. `.acp-harness__resource--hinted` adds a grid column for the hint label.
- `collectTextImagePaths` (`acp-harness-view.ts:13774`) already turns image-path `MessageResource`s into explicit `HarnessImage`s on the same row at seal. `renderImageStrip` then draws them below the row.
- **Per-turn dedupe** (`LaneImageState.turnPaths`) skips loading a path that another row already showed this turn.
  - This is the common GitHub-issue flow: `curl -o /tmp/x.png` → `Read` → reply mentions `/tmp/x.png`.
  - The reply row then has **no** image of its own. The thumbnail must therefore resolve against the whole lane, not only the row.
- The render loop (`acp-harness-view.ts:11846`) compares `transcriptRenderSignature` for every windowed row on each pass, and `syncImageStrip` schedules that pass. If the signature includes the resolved thumbnail state, a reply row rebuilds whenever an image it borrows from another row loads or is released. No extra repaint hook is needed.
- **Open targets** (`activeLaneOpenTargets`) push resources and images separately. Leaving this unchanged would give a rail-covered image two hint labels, one of which is invisible.
- No file-type icon helper exists in `src/`. The harness SVG sprite (`harness-icons.ts`) has no globe symbol.
- **Rejected alternatives:**
  - **QuickLook thumbnails for PDF/HTML/video** (`QLThumbnailGenerator` / `qlmanage -t`). Rejected because it needs a new Rust command and cache, works on macOS only, and adds a process spawn or latency per file.
  - **Force-reloading borrowed images onto the reply row.** Rejected because it duplicates up to 10 MiB per image inside the 64 MiB lane budget.
  - **A tile grid (option (b)).** Rejected because it loses the path and Git columns and wastes vertical space on code-file glyphs.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed agent panel | Edited-file and mention rows use `FileIcons::get_icon(path)` (`thread_view.rs:3268`), muted and small, with `IconName::File` as the fallback | Icon by file type; no image preview in the row |
| VS Code chat | `ChatResponseReferencePart(value, iconPath?)` renders references apart from prose; the icon comes from the file-icon theme or an explicit `iconPath` | Same typed-reference model as spec 206 |
| Krypton today | Text badge `FILE`/`URL`; image references duplicated in the image strip | — |

**Krypton delta:**
- **Matches:** a type icon leads each reference row (Zed, VS Code).
- **Differs:** image references show the actual image pixels, reusing spec 281 bytes. Glyphs are text-in-border, not an icon theme, which keeps the no-framework/no-asset rule. The hint label overlays the thumbnail, keeping `f` keyboard-first.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/message-resource-thumb.ts` (new) | `resourceGlyph(resource)` and `resolveResourceImage(lane, item, resource)`, both pure |
| `src/acp/message-resource-thumb.test.ts` (new) | Glyph classification, resolve precedence (same row > newest live in lane > newest released in lane), and rail coverage |
| `src/acp/harness-transcript-render.ts` | Thumbnail cell in `renderMessageResource`; `renderImageStrip` skips rail-covered images; the signature takes `lane` and includes the resolved thumbnail state |
| `src/acp/acp-harness-view.ts` | Pass `lane` to the signature/rail; drop rail-covered images from `activeLaneOpenTargets`; `openMessageResource` routes resolved images to `openImageViewer` |
| `src/acp/harness-icons.ts` | `krypton-icon-globe` symbol |
| `src/styles/acp-harness.css` | `.acp-harness__resource-thumb*`; drop the `--hinted` grid variant and the `__resource-kind` rules |
| `docs/206-*.md`, `docs/281-*.md`, `docs/72-acp-harness-view.md`, `docs/README.md` | Rail UI, image strip dedupe, open behaviour, index entry |

## Design

### Data Structures

```ts
// message-resource-thumb.ts
export type ResourceGlyphKind = 'code' | 'doc' | 'data' | 'web' | 'image' | 'dir' | 'file' | 'url';
export interface ResourceGlyph { kind: ResourceGlyphKind; text: string } // text ≤ 4 chars, e.g. 'TS', 'MD', 'JSON'
export function resourceGlyph(resource: MessageResource): ResourceGlyph;
/** The row's own image for the path (any state), else the newest live image in the lane
 *  with that path, else the newest reloadable (released) one. Failed images elsewhere are ignored. */
export function resolveResourceImage(lane: Pick<HarnessLane, 'imageState' | 'transcript'> | null, item: HarnessTranscriptItem, resource: MessageResource): HarnessImage | null;
/** A sealed row's image whose path is one of its own file references. */
export function railCoversImage(item: HarnessTranscriptItem, image: HarnessImage): boolean;
```

There are no new persisted fields. Resolution is computed at render time; it scans at most 32 resources against `lane.imageState.live` and the row's images.

**Glyph map** (extension, lower-cased):

| Kind | Extensions | Color |
|------|-----------|-------|
| `code` | ts tsx js jsx mjs cjs rs py go swift kt java c h cpp cs rb sh zsh fish lua | lane accent |
| `doc` | md mdx txt rst adoc pdf | `--krypton-special` |
| `data` | json jsonc toml yaml yml xml csv lock ini env | `--krypton-warning` |
| `web` | html htm css scss svg | `--krypton-success` |
| `image` | png jpg jpeg gif webp (fallback when no pixels) | `--agent-user` |
| `dir` | target ends with `/` → text `DIR` | muted |
| `file` | anything else → upper-cased extension (≤4 chars), or `FILE` when there is none | muted |
| `url` | `kind:'url'` → globe symbol, no text | `--agent-user` |

### Data Flow (GitHub issue screenshot)

```
1. Bash `curl … -o /tmp/issue-42.png` completes → spec 281 loads it onto the Bash row (turnPaths owner)
2. Reply seals with resource /tmp/issue-42.png → collectTextImagePaths skips the load (shown this turn)
3. Render: resolveResourceImage → Bash row's live image → rail row draws <img src=blob:…>
4. Budget evicts that image → state 'released' → signature moves → rail row shows the IMG glyph
5. `f` → label on the rail row → openImageViewer(imageId) (reloads a released path image, spec 281)
```

When the reply row owns the image itself (no earlier row showed it), the image is resolved from the same row. `renderImageStrip` omits it, because the rail shows it.

### Open Behaviour

| Resource | Resolved image | Action |
|----------|---------------|--------|
| file, image path | `live` or `released` | `openImageViewer(imageId)`; `o` in the viewer still opens the OS app (spec 281) |
| file, image path | `loading` / `missing` / `rejected` / none | Unchanged: `openFileReferenceCb` (Helix) |
| file, other | — | Unchanged: Helix |
| url | — | Unchanged: `openExternalUrl` |

`activeLaneOpenTargets` excludes any image whose `path` matches a file resource **on the same row**. The resource keeps the single hint label. Images borrowed from another row keep their own label in that row's strip.

### UI Changes

```html
<button class="acp-harness__resource acp-harness__resource--file">
  <span class="acp-harness__resource-thumb acp-harness__resource-thumb--image">
    <img src="blob:…" alt="" decoding="async" loading="lazy">
    <span class="acp-harness__resource-hint">a</span>          <!-- f mode only -->
  </span>
  <!-- or: <span class="acp-harness__resource-thumb acp-harness__resource-thumb--glyph" data-glyph="code">TS</span> -->
  <span class="acp-harness__resource-content">…label / target…</span>
  <span class="acp-harness__resource-git">…</span>
  <span class="acp-harness__resource-action">OPEN TAB ↗ | VIEW ↗</span>
</button>
```

- **Grid:** `thumb | content | git | action`, with a fixed thumbnail cell of 48×34. Row height grows from about 30px to about 46px.
- **Pixels:** `<img>` uses `object-fit: cover`. The cell has a full 1px `--krypton-*` border, no corner brackets, and no `backdrop-filter`.
- **Glyph:** text centred, 0.72em, weight 700, coloured per the glyph map. A `missing`/`rejected` image renders the `IMG` glyph in danger colour, with the reason in `title`.
- **Hint label:** absolutely positioned at the thumbnail's top-left, so there is no extra grid column.
- **Action text:** `VIEW ↗` when the click opens the image viewer.
- **Narrow lanes** (≤680px): the action drops as it does today. The thumbnail stays.
- `alt` is empty, because the row's `aria-label` already names the file. Content is set only via attributes and `textContent`.

### Keybindings

No new keys. `f`, then the label, opens the resource as described in the Open Behaviour table.

### Configuration

None.

## Edge Cases

- **Remote runtime:** no path images exist, so every file row shows a glyph.
- **Image still `loading`:** `IMG` glyph. The signature changes when the image goes live, and the row rebuilds.
- **Two rows reference the same image:** both rail rows show the same blob URL, and only one byte copy exists.
- **Owner row evicted** (300-row cap): its images are disposed, `resolveResourceImage` returns null, and the glyph shows.
- **Reference to a `.png` that is not an image:** spec 281 marks it `rejected` → danger `IMG` glyph. Clicking falls back to Helix.
- **More than 8 image references in one row:** the extras stay unloaded (spec 281 cap) → `IMG` glyph. The `+N more` strip tile still counts them.
- **Streaming rows:** the rail renders only at seal (spec 206), so streaming is unaffected.

## Out of Scope

- QuickLook or rendered previews of PDF, HTML, video, or SVG files.
- Thumbnails for references in user or tool rows; only the assistant REFERENCES rail changes.
- Image strip behaviour for scanned or tool images.
- Favicons for URLs, which would mean network fetches (spec 206 forbids these).

## Resources

- [VS Code API — ChatResponseReferencePart](https://vscode-api.netlify.app/classes/vscode.chatresponsereferencepart): references rendered apart from content, with an optional per-reference icon.
- Zed `crates/agent_ui/src/conversation_view/thread_view.rs:3268` (local source): `FileIcons::get_icon` with a muted small icon and a generic file fallback.
- Krypton spec 206 (rail), spec 207 (Git state), and spec 281 (image loading, turn dedupe, viewer).
