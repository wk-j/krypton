# ACP Harness Inline HTML Visuals — Implementation Spec

> Status: Draft (rev 2)
> Date: 2026-10-13
> Milestone: ACP Harness
>
> Amends ADR-0002 with a **narrow exception** (this class only). Full-page
> HTML artifacts still open in the OS browser, still only on a hint keypress.
>
> **Rev 2** folds OMP-1 architecture review (Board
> `2026-10-13-inline-html-visuals-spec`). Locked: in-place DOM patch (not a
> portal); JS runs only after `f`+label (not IntersectionObserver); mount at
> seal-decorate only; Source is CSS on a live frame; cap is per assistant
> item; live-iframe budget is process-global.

## Problem

Asking a lane to "show me a chart" today yields either an inert ` ```svg `
image (spec 283) or an HTML artifact card the user must hint-open in the OS
browser (spec 133 / ADR-0002). Neither matches the Orca Chat loop: a compact
interactive dashboard, chart, or mini-app **in the reply itself**.

## Solution

Add a third visual class, **inline HTML visuals**, next to SVG fences and
artifacts.

A **sealed** assistant ` ```visual ` fence becomes a card. The preview starts
as a static placeholder. Lane JS runs only after the user activates with
`f` then the card's hint label, which mounts a **sandboxed `srcdoc` iframe**
(DOM iframe, not a Tauri child webview). Ordinary ` ```html ` stays a code
block. No new MCP tool, no second file store, no HTML bytes through the bus.
Artifacts remain the full-page, iterate-in-browser path.

Hint labels, Source/Preview, and activate/unmount **patch the existing card
DOM**. They are omitted from `transcriptRenderSignature`, so `f` / Source
must not hit the `body.innerHTML = markdownHtml` rebuild
(`harness-transcript-render.ts` / `acp-harness-view.ts` signature-miss
branch). Moving a detached iframe in the DOM reloads it; Source therefore
only CSS-hides the frame.

## Research

- **Orca ADE v1.4.224** (PRs 26103 / 26099 / 26071): `::orca-visual` +
  per-chat HTML folder + `sandbox="allow-scripts"` srcdoc shell. CDN
  allowlist is a disclosed exfil residual. Krypton uses a fence language
  instead of a second file store.
- **ADR-0002** rejected an inline iframe because it fights the **tail-window
  (spec 103)**, the **single-window** constraint, **and sandboxing** — not
  because full artifacts would auto-play. Rev 2 answers those three (see
  ADR amendment). Native child webviews (spec 102) paint above host DOM;
  a DOM iframe stays under chrome.
- **Row rebuild destroys iframes.** `renderActiveTranscript` rebuilds a row
  with `innerHTML = markdownHtml` whenever the signature changes. SVG puts
  `hintLabel`/`showSource` in the signature on purpose (`<img>` reload is
  cheap). An iframe reload re-runs scripts and drops widget state. Visual
  card state therefore stays out of the signature and is synced in place on
  the signature-hit path (same idea as `patchStreamingToolBody`).
- **Auto-mount on scroll drops the keypress gate** and shares the WKWebView
  web-content process / main thread with every xterm. A `while(true)` or a
  heavy rAF loop would stall keypress-to-render past 16ms; Krypton cannot
  kill that frame from the same thread. Activation is explicit.
- **`csp: null`.** Lane HTML must never hit the markdown DOM. Isolation is
  `sandbox="allow-scripts"` (no `allow-same-origin`) plus a CSP-first shell.
  Opaque origin plus `connect-src 'none'` is the IPC story; Tauri injects
  on the main frame and requires `__TAURI_INVOKE_KEY__`, but
  `webkit.messageHandlers.ipc` still exists on the content controller —
  tests must probe that a post from the frame is rejected.
- **CSP does not stop self-navigation** (`location=`, `<a target=_self>`).
  The main window is declared in `tauri.conf.json` with no `on_navigation`
  (the hook in `webview.rs` is child panes only and returns `true`). A GET
  can leave before retire-on-navigate. Residual, stated honestly: retire on
  the iframe's **second `load`** (first load is srcdoc). Phishing flash is
  bounded by that retire, not prevented on the wire.
- **Streaming HTML is unsafe.** smd has no fence-close signal;
  `decorateSvgFences` / `decorateHtmlVisuals` run only when `!streaming`.
  Seal captures pure markdown; a live iframe in that body would be serialised
  or torn down. Visuals mount **after seal**, and only on activation.
- **Policy budget (spec 289) ≤1700 chars.** Keep `SVG_FENCE_GUIDANCE`
  unchanged. Add one short sibling line.

### Alternatives considered

| Approach | Why not |
|----------|---------|
| Clone `::orca-visual` + per-chat folder | Second HTML store beside `.krypton/artifacts/` |
| Auto-iframe registered artifacts | Wrong size; hook-server origin inside the app webview |
| IntersectionObserver auto-mount | Drops ADR-0002 keypress gate; main-thread freeze |
| Portal layer over a placeholder | Heavier than in-place patch; chosen only if patch fails |
| Tauri child webview per card | Spec 102 z-order |
| Bare `s` for Source | No card-focus; `s` goes to the composer |

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Orca Chat 1.4.224 | `::orca-visual` + per-chat HTML + sandboxed iframe | Auto-mount. CDN allowlist. |
| Claude.ai Artifacts / ChatGPT Canvas | Side panel | Separate surface |
| Krypton today | ` ```svg ` → `<img>`; `artifact_new` → OS browser | Gap is interactive-in-reply after a keypress |

**Krypton delta.** In-reply interactive HTML, fence grammar, no CDN, explicit
activation, in-place card sync, DOM iframe.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-html-visual.ts` | **New.** Grammar, CSP shell (nonce in closure), `decorateHtmlVisuals`, `syncHtmlVisualCards`, activate/unmount, height governor, second-`load` retire, theme srcdoc |
| `src/acp/harness-html-visual.test.ts` | **New.** Caps, sandbox/CSP strings, nonce not in DOM, `isTrusted`, second load, signature omission, no iframe until activate, global live cap |
| `src/acp/harness-view-types.ts` | `HtmlVisualEntry`; `item.htmlVisuals?` |
| `src/acp/harness-markdown.ts` | Streaming placeholder `visual · drawing…`; no iframe |
| `src/acp/harness-transcript-render.ts` | `decorateHtmlVisuals` after SVG; **omit** htmlVisuals from `transcriptRenderSignature`; signature-hit calls `syncHtmlVisualCards` |
| `src/acp/acp-harness-view.ts` | Seal decorate; `f` hint includes visuals (activate / focus / Source-return); unmount on workspace/lane hide, `visibilitychange`, `#new`; theme `postMessage`; shell chords |
| `src/acp/transcript-annotation.ts` | `.acp-harness__visual-card-bar` in `SKIP_WRAP` |
| `src/acp/harness-svg-fence.ts` | Export `SVG_FENCE_GUIDANCE` unchanged; visual line lives in the new module |
| `src/acp/acp-harness-view.ts` `renderLanePolicy` | Push `VISUAL_FENCE_GUIDANCE` after the SVG line |
| `src-tauri/src/hook_server.rs` | `artifact_new` text: compact charts/widgets → ` ```visual ` / ` ```svg `; artifact_new for full pages / multi-turn edit / feedback |
| `src/styles/acp-harness.css` | `.acp-harness__visual-card` — SVG card chrome (1px border, no L-ticks, no `backdrop-filter`) |
| `docs/adr/0002-html-artifacts-open-in-os-browser.md` | Narrow exception answering tail-window, single-window, sandbox |
| `docs/0072-acp-harness-view.md` | Data-flow step 13d |
| `docs/0133-harness-html-artifacts.md` | Cross-link: when to use which surface |
| `docs/0283-harness-svg-fence-preview.md` | SVG guidance stays; sibling visual line |
| `docs/0289-lane-context-delta.md` | Policy example gains the visual line |

## Design

### When to use which surface

| Surface | Agent produces | User sees |
|---------|----------------|-----------|
| ` ```svg ` | Static diagram / chart / mockup | Inert image card |
| ` ```visual ` | Compact interactive HTML | Placeholder, then sandboxed iframe after `f`+label |
| `artifact_new` | Full page, multi-turn edit, spec 149 feedback | Hintable card → OS browser |

A lane asked "show me a chart" uses ` ```visual ` or ` ```svg `.

### Grammar

Info-string **first word** is `visual` (smd `visual`; marked `language-visual`).
Match SVG: any `pre > code` in an **assistant** row (lists and quotes
included). ` ```html ` is never a visual. A fence nested inside another fence
is not a DOM case — ignore that wording.

Caps: **64 KiB** source (string length); **2** visuals **per assistant
transcript item** (`VISUAL_MAX_PER_ITEM`). A turn that splits across several
assistant rows (tool calls in between) gets a fresh cap per item. Empty /
over-cap / non-assistant → code.

### Data structures

```ts
export interface HtmlVisualEntry {
  index: number;
  hintLabel: string | null;   // patched; not in the render signature
  showSource: boolean;        // CSS on the card; iframe stays in DOM
  activated: boolean;         // user has asked this card to run
  source: string;
  lastHeight: number;         // 80–720, default 240
}

export const VISUAL_MAX_CHARS = 64 * 1024;
export const VISUAL_MAX_PER_ITEM = 2;
export const VISUAL_HEIGHT_MIN = 80;
export const VISUAL_HEIGHT_MAX = 720;
export const VISUAL_HEIGHT_DEFAULT = 240;
export const VISUAL_LIVE_MAX = 4;        // process-global, all harness views
```

`markdownHtml` stays pure markdown. `decorateHtmlVisuals` runs on row
**build** only: wrap each qualifying `pre > code`, placeholder pane, no
iframe. If the fresh body has no iframe, set `activated = false` (a rebuild
clears the keypress grant).

`syncHtmlVisualCards(row, item)` runs on **every** pass, including
signature-hit: hint badge, `--source` class, mount/unmount iframe to match
`activated`. `transcriptRenderSignature` **omits** `htmlVisuals`.

Annotation or markdown changes still rebuild the row (existing signature
inputs). Residual: that drops widget state; the user activates again.

### Isolation

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
```

Set `iframe.srcdoc` as a **property**, never an escaped attribute. No
`allow-same-origin`, `allow-forms`, `allow-popups`, `allow-modals`,
`allow-top-navigation`.

Shell is Krypton-authored. First parsed bytes: CSP meta, then an inline
`:root{…}` style built from `readSvgPalette()` / `readSvgFontFamily()`
(tokens in place before first paint). `postMessage` `krypton-visual-theme`
is for later updates only — it must not reload the frame.

CSP:

```
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data: blob:;
font-src 'none';
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

No CDN, no `http(s)` images, no fonts, no `fetch`/`XHR`/`WebSocket`. Charts
are inline JS and/or inline SVG. Height messages are rate-limited and
clamped to `VISUAL_HEIGHT_MAX`. Cards above the viewport must not jump
scroll (overflow-anchor / restore `scrollTop`). Growing a card unmounts
nothing; widget state is lost only when the iframe is destroyed.

**Nonce.** The shell `<script>` IIFE holds a random nonce in a **closure**,
binds `parent.postMessage`, installs height/link/key listeners, then
`document.currentScript.remove()`. Lane bytes follow that script in the
srcdoc so they never see the nonce in markup. Parent ignores payloads with
the wrong nonce.

**`isTrusted`.** The shell posts `krypton-visual-key` / `krypton-visual-link`
only when `event.isTrusted`. Forward **Escape** and the leader key (`Cmd+P`)
only. Do not forward `Cmd+W` or `Cmd+1..9`.

| `type` | Direction | Meaning |
|--------|-----------|---------|
| `krypton-visual-height` | child → parent | clamped height |
| `krypton-visual-link` | child → parent | `http(s)`; parent `open_url` only if the frame is focused, ≤1 / 5 s |
| `krypton-visual-key` | child → parent | `Escape` (blur to composer) or `Cmd+P` |
| `krypton-visual-theme` | parent → child | palette + font, no reload |

**Retire.** First `load` is srcdoc. A second `load` (self-navigation)
unmounts the frame and shows `visual unavailable`. Residual: the HTTP GET
may already have left; wry has no main-window `on_navigation` in v1.

**IPC smoke.** A srcdoc probe that posts to `webkit.messageHandlers.ipc`
must not reach Tauri. Assert sandbox is exactly `allow-scripts` and CSP
contains `connect-src 'none'`.

### Activate / unmount

Placeholder until `activated`. `f` then `<label>`:

- placeholder → set `activated`, `sync` mounts, then focus the iframe
- live preview → focus the iframe
- Source showing → CSS back to preview (mount if not yet activated)

Unmount (destroy iframe, `activated = false`, keep `lastHeight`) when: the
row leaves the tail window; the workspace or this harness/lane is not
visible; `visibilitychange` hidden; `#new` / lane close; live count would
exceed `VISUAL_LIVE_MAX` (drop the oldest activation, process-global).
State that widget state is lost.

### Keyboard

| Key | Action |
|-----|--------|
| `f` then `<label>` | Activate / focus / return from Source (above) |
| `Shift+<label>` | Copy original source |
| `Escape` (iframe focused) | Blur; composer keeps harness input |
| `Cmd+P` (iframe focused) | Forwarded to the compositor |

No bare `s`. Source/Preview is the card toolbar (mouse) plus the
Source-showing `f`+label return path, matching SVG's "label on Source
returns to Preview". Keyboard path to the source text is `Shift+<label>`.

### UI

Copy `.acp-harness__svg-card` chrome: 1px border, kind `visual`, Source /
Preview / Copy. Preview is the placeholder or the iframe (width 100%,
height `lastHeight`). No L-ticks, no `backdrop-filter`.

Unavailable: muted `visual unavailable`; fence stays as source.

### Guidance (policy, both memory branches)

Keep `SVG_FENCE_GUIDANCE` as today. Push this sibling:

```
```visual fences render as HTML cards after f-hint (self-contained, no network/storage/forms/alerts; not ```html). Same theme vars as svg. Full pages use artifact_new.
```

Opaque origin: `localStorage` / `sessionStorage` / `document.cookie` throw;
`alert`/`confirm`, form submit, and `target=_blank` are dead. The line
names those traps.

### Configuration

None. Always on, like SVG fences.

## Edge Cases

- **Third ` ```visual ` on one item:** stays code.
- **Theme switch:** `postMessage`; no iframe reload.
- **Copy / Live Assist / Telegram / Pi-agent / markdown viewer:** source
  text only.
- **Remote / SSH harness (spec 247):** source is in the transcript.
- **Malformed HTML:** after activation, the browser paints what it can.
- **`<base>`, meta-refresh, `location=`:** second `load` retires.

## Open Questions

None. Locked in rev 2: ` ```visual ` fence; no CDN; no new MCP tool;
in-place patch; explicit `f`+label activation; seal-only decorate;
per-item cap of 2; process-global 4 live frames; ADR-0002 exception is
this class only; harness-only; navigation residual disclosed.

## Out of Scope

- Phone / Live Assist iframe
- Bundled chart library or pinned CDN
- Main-window `on_navigation` rewrite (follow-up if phishing flash matters)
- Progressive script on a partial fence
- Auto-run on scroll
- Rendering artifacts inline
- Mermaid / Vega languages
- Pi-agent view
- Portal layer

## Resources

- [Orca native chat](https://www.onorca.dev/docs/agents/native-chat), [1.4.224](https://www.onorca.dev/changelog/1-4-224)
- [stablyai/orca#26103](https://github.com/stablyai/orca/pull/26103), [#26099](https://github.com/stablyai/orca/pull/26099), [#26071](https://github.com/stablyai/orca/pull/26071)
- [Orca tweet](https://x.com/orca_build/status/2109720160345182587)
- `docs/adr/0002-html-artifacts-open-in-os-browser.md`
- `docs/0133-harness-html-artifacts.md`, `docs/0283-harness-svg-fence-preview.md`, `docs/0103-acp-harness-transcript-window.md`, `docs/0102-webview-windows.md`
- Review Board `2026-10-13-inline-html-visuals-spec`
