# YouTube Transcript Extraction — Implementation Spec

> Status: Implemented (code) — runtime verification on a real video pending
> Date: 2026-06-28
> Milestone: Harness browser extension (specs 175–178)

## Problem

When the user invokes the Krypton extension on a YouTube watch page, the
extracted content is only the video title + description — the **transcript is
missing**. Obsidian Web Clipper, by contrast, clips the full transcript. Users
want the same: send a video's transcript to a lane for summarize/translate/etc.

## Solution

Krypton already bundles the same engine Obsidian uses — **Defuddle** (`defuddle/full`,
v0.19.1) — and that version already ships a YouTube extractor that fetches the
transcript via YouTube's unofficial InnerTube API. The only reason Krypton
doesn't get it is that `content-extract.src.js` calls the **synchronous**
`new Defuddle(document).parse()`, while the YouTube extractor declares
`prefersAsync()` and only fetches the transcript on the **async** path
(`parseAsync()` → `extractAsync()`). The fix is to switch extraction to
`parseAsync()` and thread the resulting Promise through the existing
`executeScript` plumbing. No new transcript-fetching code of our own.

## Research

Verified by reading source (not assumed):

- **Krypton** (`extension/content-extract.src.js:11-13`): exposes
  `globalThis.__kryptonExtract = () => new Defuddle(document, {...}).parse()` —
  synchronous. `extension/popup.js:36-39` injects the bundle then calls the
  global via `executeScript({func})` in the **ISOLATED world**, `activeTab`
  permission (no static content script for non-github pages).
- **Defuddle 0.19.1, installed** (`extension/node_modules/defuddle/dist/`):
  `dist/index.full.js` contains `parseAsync` and `dist/extractors/youtube.js`
  contains the InnerTube path (`youtubei/v1/player`, Android client) plus
  `extractAsync` / `prefersAsync`. So the capability is already on disk — it is
  simply unreachable from the sync `parse()` call.
- **Defuddle youtube extractor** (`kepano/defuddle src/extractors/youtube.ts`):
  `extract()` (sync) returns only `extractTranscriptFromExistingDom()`;
  `extractAsync()` tries existing DOM → `fetchTranscript()` (InnerTube) →
  `extractTranscriptFromOpenedDom()` (clicks "Show transcript" and reads the
  panel). `prefersAsync()` returns `true`.
- **Obsidian Web Clipper** treats `transcript` as a Defuddle-produced variable
  (`src/utils/shared.ts` comment "defuddle variables like transcript";
  `reader-transcript.ts` only wires the reader-view scroll UI, it does not fetch).
  i.e. Obsidian's transcript = Defuddle's async extractor. Same engine we have.

Conclusion: this is a **sync→async** wiring change, not a reimplementation.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Obsidian Web Clipper | Defuddle async extractor → `{{transcript}}` template variable; reader-view scroll sync | Same library Krypton uses |
| Defuddle (library) | `src/extractors/youtube.ts`: InnerTube `youtubei/v1/player` for caption track URLs, with DOM-panel fallback | Bundled in `defuddle/full` |
| youtube-transcript npm libs | Scrape `ytInitialPlayerResponse` captionTracks → fetch `timedtext` | The manual approach we are NOT writing |

**Krypton delta** — we reuse Defuddle's extractor verbatim (no custom InnerTube
code to maintain). We surface the transcript as part of the existing `{page}`
body (doc 177 model), not a separate `{transcript}` variable, to avoid new
template surface in this pass.

## Affected Files

| File | Change |
|------|--------|
| `extension/content-extract.src.js` | Make `__kryptonExtract` async; call `parseAsync()` instead of `parse()` |
| `extension/popup.js` | Injected `func` returns the Promise so `executeScript` awaits it (already returns the call — confirm `ex` is the resolved object) |
| `extension/dist/content.bundle.js` | Rebuilt via `npm run build` (esbuild) |
| `extension/manifest.json` | Possibly add `https://www.youtube.com/*` host permission if the InnerTube fetch needs it (see Open Questions) |
| `docs/177-harness-extension-content-extraction.md` | Note the async parse + YouTube transcript behavior |
| `docs/PROGRESS.md` | Record the feature |

## Design

### Extraction change

Deviation from the original draft (post-approval): mirror obsidian-clipper's
`src/content.ts` exactly — race `parseAsync()` against an 8s timeout and fall
back to the sync `parse()` if it hangs. obsidian-clipper has no extraction code
of its own beyond this; both it and Krypton call the same Defuddle 0.19.x.

```js
// content-extract.src.js
globalThis.__kryptonExtract = async () => {
  try {
    const defuddle = new Defuddle(document, { markdown: true, removeImages: true });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('parseAsync timeout')), 8000));
    const r = await Promise.race([defuddle.parseAsync(), timeout])
      .catch(() => defuddle.parse());
    return { markdown: r.content || '', title: r.title || document.title || '',
             author: r.author || '', description: r.description || '',
             wordCount: r.wordCount || 0 };
  } catch { return null; }
};
```

### Data Flow

```
1. User clicks extension on a youtube.com/watch page (no text selected)
2. popup.js injects dist/content.bundle.js (ISOLATED world, activeTab)
3. popup.js calls executeScript({ func: () => __kryptonExtract() })
4. __kryptonExtract awaits Defuddle.parseAsync()
5. Defuddle picks the YouTube extractor (prefersAsync) → fetchTranscript()
   hits youtubei/v1/player (same-origin on youtube.com) → caption track →
   transcript markdown; falls back to opening the transcript panel DOM
6. executeScript resolves the returned Promise; popup gets { markdown, ... }
   with the transcript embedded → flows into {page}/{selection} body as today
```

Non-YouTube pages are unaffected: `parseAsync()` runs the normal article
extractor and returns the same shape as `parse()` did.

## Edge Cases

- **Video has no captions** → extractor returns no transcript; we get
  title/description only (current behavior). No error.
- **InnerTube fetch blocked / times out** (`FETCH_TIMEOUT_MS = 4000` in extractor)
  → extractor falls back to opening the transcript panel; if that fails, body is
  title/description. Popup's existing try/catch keeps URL-only as last resort.
- **Very long transcript** → consistent with doc 177 "no length cap" decision;
  large prompt is the accepted trade-off.
- **Not on a YouTube page** → normal article extraction, unchanged.
- **executeScript returning a Promise** → MV3 `chrome.scripting.executeScript`
  awaits a Promise returned by the injected `func` and yields its resolved
  value; `popup.js` already reads `result`, so no shape change.

## Open Questions

1. **Host permission for the InnerTube POST.** The fetch runs in the ISOLATED
   world, which uses the page origin — on `youtube.com` that is same-origin, so
   `activeTab` should suffice and YouTube's own CSP permits `youtubei/v1`. If a
   runtime test shows the request is blocked, add `https://www.youtube.com/*`
   to `host_permissions` (and possibly `https://*.googlevideo.com/*` for caption
   hosts). **Resolve by running the real extension on a YouTube video before
   merge** — do not assume it works.
2. **Surface as `{page}` body vs. a dedicated `{transcript}` variable.** This
   spec uses `{page}` (no new template surface). A `{transcript}` action
   template could come later — out of scope here.

## Follow-up — X/Twitter (added post-approval)

The same sync→async switch also reaches Defuddle's X extractors: `twitter`
(tweet/thread, sync) and `x-article` (sync) already worked under `parse()`; the
`x-oembed` fallback is async and fetches `https://publish.twitter.com/oembed`,
a cross-origin host. Added `https://publish.twitter.com/*` to `host_permissions`
so that cross-origin fetch from the injected script is not CORS-blocked. Same
runtime-verification caveat as YouTube — not tested on a live X page in CI.

## Out of Scope

- A dedicated `{transcript}` template variable / new actions.
- Reader-view transcript scroll-sync UI (Obsidian's `reader-transcript.ts`).
- Timestamp formatting options, language selection UI.
- Upgrading Defuddle beyond the installed 0.19.1.
- Any non-YouTube site-specific extractor.

## Resources

- [obsidianmd/obsidian-clipper `src/utils/reader-transcript.ts`](https://github.com/obsidianmd/obsidian-clipper/blob/main/src/utils/reader-transcript.ts) — confirmed Obsidian only wires reader UI; transcript itself is a Defuddle variable.
- [kepano/defuddle `src/extractors/youtube.ts`](https://github.com/kepano/defuddle/blob/main/src/extractors/youtube.ts) — InnerTube fetch + async-only transcript path (`extractAsync`/`prefersAsync`).
- [Obsidian Forum — Web Clipper YouTube transcript](https://forum.obsidian.md/t/web-clipper-youtube-video-transcript-for-yts-ui-feb-2026-update/111550) — confirms current DOM-scrape + InnerTube approach.
- [obsidian-clipper#316 — Enable YouTube Transcript Download](https://github.com/obsidianmd/obsidian-clipper/issues/316), [#274 — transcription variable](https://github.com/obsidianmd/obsidian-clipper/issues/274) — design discussion incl. official Data API alternative.
- Chrome `chrome.scripting.executeScript` MV3 — injected `func` returning a Promise is awaited (to verify at test time).
