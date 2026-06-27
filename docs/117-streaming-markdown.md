# 117. Streaming Markdown Rendering for Assistant Rows

> Status: Implemented (rev 3 — Codex-1 review applied: seal-drain invariant, background-lane offscreen capture, RAF-only-write invariant, URL allowlist; stack-aware HTML skip dropped during implementation because streaming-markdown@0.2.15 has no HTML tokens)
> Date: 2026-05-23
> Milestone: ACP harness — reading UX
> Builds on: Spec 114 (append-only stream body, body-only RAF)
> Supersedes (for assistant kind, in-memory only): Spec 114 §1 "plain-until-seal" — see §"Spec 114 amendment" below

## Problem

Assistant message bodies stream as plain text and only render markdown after
`sealStreaming` (Spec 114 rev 4, `acp-harness-view.ts:3927`,
`updateStreamingTextBody` at `:4971`). For long replies this means headings,
lists, fenced code, bold/italic, and links all appear as literal source
characters until the turn ends. Users want formatting to materialize **as
the chunks arrive**, not at seal.

## Solution

Adopt the `streaming-markdown` parser (thetarnav) for the **assistant**
streaming path only. It is an optimistic, append-only DOM mutator: each
chunk is written via `parser_write`, the parser emits token events to a
renderer that **appends new elements** without touching prior DOM. Inline
emphasis, fenced code, lists, etc. render the moment their opening token
arrives. On seal we call `parser_end` to flush trailing partials; no
post-seal `marked.parse` reparse is needed because the DOM is already
correct.

Other streaming kinds (`thought`, `user`) keep the existing plain-text
`appendData` path until a follow-up spec extends coverage.

## Research

**Spec 114 explicitly rejected incremental parsing in rev 1–4** (`docs/114
:332-341`):

> Incremental markdown tokeniser (e.g. `marked.Lexer`) — peer review noted
> markdown is not append-stable (fences, list indentation, link references,
> table separators can reinterpret prior text), so a true incremental parser
> is not worth the correctness risk for V1.

What changes the calculus: `streaming-markdown` is **optimistic by design**.
It commits to a token interpretation the moment the opening marker arrives
and never rewrites past output. This trades absolute correctness (a
late-arriving `]: url` reference link won't retroactively rewrite earlier
text) for visual stability and zero churn. The user has selected option
**3 + (a)** which accepts that trade.

**Existing infrastructure that helps:**
- Fast-path branch in `renderActiveTranscript` at `:3090-3112` already
  bypasses the signature compare for streaming text rows. Adding a
  per-kind switch inside the fast path is mechanical.
- `sealStreaming` (`:3927`) already runs once per turn — the natural place
  to call `parser_end` and tear down the streaming parser.
- The 60-row tail window + 300-row transcript cap (Spec 103/114) bound the
  cost of full re-renders; the streaming parser only touches one row at a
  time so it does not interact with these.

**Library survey:**
- `streaming-markdown` (thetarnav, ~5 KB) — optimistic, custom-renderer
  interface, no DOM mutation of prior output, supports headings, lists,
  code, emphasis, links, tables, LaTeX, HTML tokens. **Selected.**
- `semidown` — semi-incremental, block-buffered. Matches our previously
  considered option (b). Rejected per user's explicit (a) selection.
- `markdown-parser` (npm) — block-emit incremental. Same buffering model
  as semidown.
- `solid-streaming-markdown` — Solid-specific renderer. Not applicable
  (vanilla TS, direct DOM).
- `marked.Lexer` incremental — Spec 114 already considered and rejected;
  marked itself is not append-stable.

**API confirmed via project research:**
```
const parser = smd.parser(renderer);
smd.parser_write(parser, chunk);   // can call many times
smd.parser_end(parser);            // flush + reset
smd.default_renderer(element);     // DOM appender
```

Renderer interface: `{ data, add_token, end_token, add_text, set_attr }`.

## Prior Art

| Product | Streaming markdown behaviour |
|---------|------------------------------|
| **ChatGPT** | Optimistic streaming. Inline emphasis, code fences, headings, lists render token-by-token as chunks arrive. Partial code fence shows highlighted code immediately. No post-seal reflow. |
| **Claude.ai** | Optimistic streaming with very mild buffering on fenced code (waits one short delay). Otherwise behaves like ChatGPT. |
| **Cursor (chat panel)** | Optimistic streaming via custom renderer; partial code blocks render as `<pre><code>` immediately. |
| **Zed (assistant panel)** | Block-buffered. Paragraphs render plain until newline; fenced code holds until close. Matches option (b). |
| **VS Code (Copilot chat)** | Optimistic per-token rendering, minimal flicker. |
| **Krypton today (Spec 114 rev 4)** | Plain text during stream, full markdown at seal — **no live formatting**. |

**Krypton delta**: matches ChatGPT / Claude.ai / Cursor optimistic model.
Deliberately differs from Krypton's current "plain-until-seal" behaviour,
which prioritises perf and zero-flicker over reading fluency. Keyboard-first
selection (Cmd+A, Cmd+C) continues to work because the streaming parser
only appends — prior DOM is selectable mid-stream.

## Affected Files

| File | Change |
|------|--------|
| `package.json` | Add `streaming-markdown` dependency (~5 KB, no transitive deps) |
| `src/acp/types.ts` | Add transient `streamingMarkdownWritten?: number` to `HarnessTranscriptItem`; document that streaming parser handle lives on `HarnessLane`, not on the item |
| `src/acp/acp-harness-view.ts` | (1) Hold per-lane `streamingMarkdownParser` on `HarnessLane`. (2) Split fast-path: assistant → `updateStreamingAssistantMarkdownBody`, others → existing `updateStreamingTextBody`. (3) `renderTranscriptItem` streaming-assistant branch initialises the parser + writes initial text. (4) `sealStreaming` calls `parser_end` + tears down parser. (5) Backtrack guard: if `item.text.length < written`, rebuild row from scratch. |
| `src/styles/acp-harness.css` | Add `.acp-harness__msg-body--stream-markdown` selector to every existing `--markdown` typography rule (comma-extend) so the two classes share styles without a runtime class swap at seal |
| `docs/114-acp-harness-streaming-perf.md` | One-line amendment stub pointing at this spec for the new assistant-streaming behaviour |

No backend / Tauri changes. No protocol changes.

## Design

### Data Structures

In `src/acp/types.ts` extend `HarnessTranscriptItem`:

```ts
export interface HarnessTranscriptItem {
  // ...existing fields...

  /** Spec 117: chars already fed into the streaming-markdown parser.
   *  Distinct from `streamPlainLength` which counts chars in a TextNode.
   *  Cleared by sealStreaming. */
  streamingMarkdownWritten?: number;
}
```

In `HarnessLane` (same file, same module):

```ts
export interface HarnessLane {
  // ...existing fields...

  /** Spec 117: streaming-markdown parser bound to the active assistant
   *  row's body. Null between turns. */
  streamingMarkdownParser: SmdParser | null;
  /** Body element the parser is mutating. Kept to detect re-creation. */
  streamingMarkdownBody: HTMLElement | null;
  /** Item id the parser is rendering. Matches lane.currentAssistantId. */
  streamingMarkdownItemId: string | null;
}
```

`SmdParser` is the opaque return type of `smd.parser(renderer)`.

### Render Path

**Shared init helper** `initLaneStreamingMarkdown(lane, item, body)` — called
from both `renderTranscriptItem` (first paint) and the rebind branch of
`updateStreamingAssistantMarkdownBody`. Single source of truth for parser +
lane field setup so the two callers cannot drift:

```ts
function initLaneStreamingMarkdown(
  lane: HarnessLane,
  item: HarnessTranscriptItem,
  body: HTMLElement,
): void {
  body.replaceChildren();                              // wipe any prior content
  body.classList.remove(
    'acp-harness__msg-body--stream-plain',
    'acp-harness__msg-body--markdown',
  );
  body.classList.add('acp-harness__msg-body--stream-markdown');
  delete body.dataset.pretext;
  delete body.dataset.rawText;
  delete body.dataset.rowId;

  const renderer = makeSafeRenderer(body);             // see Sanitisation
  lane.streamingMarkdownParser = smd.parser(renderer);
  lane.streamingMarkdownBody = body;
  lane.streamingMarkdownItemId = item.id;
  item.streamingMarkdownWritten = 0;
  item.streamPlainLength = undefined;                  // assistant no longer uses it
}
```

`updateStreamingAssistantMarkdownBody(body, item, lane)` (new):

1. **Body re-creation / first-bind / item swap.** If
   `lane.streamingMarkdownBody !== body || lane.streamingMarkdownItemId !== item.id || lane.streamingMarkdownParser === null`,
   call `initLaneStreamingMarkdown(lane, item, body)` — do **not** call
   `parser_end` on the prior parser (it would flush stale tokens into a
   renderer still bound to the old/detached body). Drop the prior parser
   ref; GC will clean up. After init, `streamingMarkdownWritten` is 0,
   so the next step backfills the full `item.text`.
2. **Backtrack guard.** If `item.text.length < (item.streamingMarkdownWritten ?? 0)`,
   treat as a re-stream: re-run `initLaneStreamingMarkdown(...)` (full
   teardown + rebuild). Rare path (lane resume, retry). Dev assertion
   logs a `[spec117]` warning whenever this fires.
3. **Delta write.** `const delta = item.text.slice(item.streamingMarkdownWritten ?? 0);`
   If `delta.length === 0` return. Call
   `smd.parser_write(lane.streamingMarkdownParser, delta)`. Set
   `item.streamingMarkdownWritten = item.text.length`.

`renderTranscriptItem` streaming assistant branch (existing `:5014-5018`)
becomes:

```ts
if (streaming) {
  initLaneStreamingMarkdown(lane, item, body);
  smd.parser_write(lane.streamingMarkdownParser!, item.text);
  item.streamingMarkdownWritten = item.text.length;
}
```

The fast-path takes over from the second chunk onward. Note: this branch
needs `lane` in scope. `renderTranscriptItem` is currently a free function
(takes `item, isNew, streaming`); we change its signature to accept `lane`
(or thread it through a closure). Trivial mechanical change — all call
sites are in `renderActiveTranscript`.

`renderActiveTranscript` fast-path branch (`:3097-3112`):

```ts
if (current && streaming && streamingTextRow &&
    (item.kind === 'assistant' || item.kind === 'thought' ||
     (item.kind === 'user' && !(item.imageCount && item.imageCount > 0)))) {
  const body = current.querySelector<HTMLElement>('.acp-harness__msg-body');
  if (body) {
    if (item.kind === 'assistant') {
      updateStreamingAssistantMarkdownBody(body, item, lane);
    } else {
      updateStreamingTextBody(body, item);
    }
    current.dataset.renderSignature = 'stream';
    lane.seenTranscriptIds.add(item.id);
    previous = current;
    continue;
  }
}
```

### Seal Path

`sealStreaming` (`:3927`) — **load-bearing integration with Spec 114's
signature/cache mechanism, plus seal-drain invariant from Codex review**:

1. Capture `const assistantId = lane.currentAssistantId;` BEFORE nulling
   (already required by rev 4).
2. Null `lane.currentUserId / currentThoughtId / currentAssistantId` as
   today.
3. Locate the assistant `item` in `lane.transcript` (no-op if not found —
   guard against in-flight cleanup races).
4. **Branch on parser presence:**

   **A. Parser exists** (`lane.streamingMarkdownParser !== null &&
      lane.streamingMarkdownItemId === assistantId`):

      - `body = lane.streamingMarkdownBody` — **always use the
        parser-owned body**, never re-query through `activeTranscriptBody()`.
        For background lanes the parser-owned body is detached (left over
        from a prior foreground session); reading its `innerHTML` is
        safe, and writing more tokens via `parser_write` mutates only
        that detached subtree.
      - **Seal-drain (required).** `appendStreaming()` mutates
        `item.text` synchronously; `parser_write` runs only inside the
        RAF fast path or this seal step. If a final ACP chunk and the
        stop event land in the same task/frame,
        `item.streamingMarkdownWritten < item.text.length` at this
        point. Compute
        `delta = item.text.slice(item.streamingMarkdownWritten ?? 0)`;
        if `delta.length > 0` call
        `smd.parser_write(lane.streamingMarkdownParser, delta)` and set
        `item.streamingMarkdownWritten = item.text.length`. The same
        race applies to background lanes whose RAF was skipped — the
        drain catches every accumulated byte.
      - **Flush.** Call `smd.parser_end(lane.streamingMarkdownParser)`.
      - **Capture cache.** `item.markdownHtml = body.innerHTML;`
        `item.markdownSource = item.text;`. Cached HTML is the
        streaming-md DOM; see Out of Scope for the baseline implications.
      - **Stabilise signature (active lane only).** If the wrapper
        element is currently in the active transcript DOM
        (`activeLane()?.id === lane.id` AND
        `transcriptBody.querySelector('[data-msg-id="…"]')` returns it),
        set
        `wrapper.dataset.renderSignature = transcriptRenderSignature(item, false);`.
        Without this the next render mismatches `'stream' !== <real sig>`
        and rebuilds the row, calling `md.parse` despite the cache. For
        background lanes there is no wrapper to stabilise; the next time
        the lane activates, the rebuild hits the cache path
        (`markdownSource === text`) and uses `markdownHtml` verbatim.

   **B. No parser exists** (lane streamed entirely in background and was
      never foregrounded during the turn, so `renderTranscriptItem` /
      fast-path never ran):

      - **Cold-cache offscreen capture.** Create an offscreen `<div>`
        (not attached to document), build a `makeSafeRenderer(offscreen)`
        and `smd.parser(renderer)`, call
        `smd.parser_write(parser, item.text)` then
        `smd.parser_end(parser)`, set
        `item.markdownHtml = offscreen.innerHTML;
         item.markdownSource = item.text;`. The offscreen body and parser
        are dropped to GC immediately. The seal cost is one parse over the
        full message, but it runs once per seal and only on
        purely-background turns; no per-frame work.
      - This keeps the sealed-row baseline contract uniform: assistant
        rows that sealed in this session always render from streaming-md
        HTML, regardless of foreground/background timing.

5. Null `lane.streamingMarkdownParser / streamingMarkdownBody /
   streamingMarkdownItemId`. Clear `item.streamingMarkdownWritten` and
   (defensive) `item.streamPlainLength`.
6. **Class.** Body retains `--stream-markdown` only. CSS rule for
   typography uses a comma selector covering both `--markdown` and
   `--stream-markdown` (cheaper than runtime class swap). The non-
   streaming render path in `renderTranscriptItem` keeps its existing
   `--markdown` class assignment for cold-loaded rows; both classes share
   typography.

`renderTranscriptItem` non-streaming assistant branch (`:5019-5034`)
needs **no functional change**: its existing
`if (item.markdownSource !== item.text || item.markdownHtml === undefined)`
guard already skips `md.parse` when the cache is warm. After seal we
populate that cache with streaming-md HTML, so any rebuild reuses it
verbatim. (Previously `sealStreaming` deliberately CLEARED
`markdownSource` to force a reparse; this spec reverses that decision for
assistant rows by populating the cache instead.) Cold-loaded transcripts
(disk replay, transcript reload) arrive with no cache and **do** go
through `marked` — see "In-memory vs cold-load contract" below.

### Sanitisation

**Implementation discovery (`streaming-markdown@0.2.15`).** The library
does **not** emit HTML tag tokens — its Token enum covers markdown block
/ inline kinds only (DOCUMENT, PARAGRAPH, HEADING_1..6, CODE_BLOCK,
CODE_FENCE, CODE_INLINE, ITALIC_*, STRONG_*, STRIKE, LINK, RAW_URL,
IMAGE, BLOCKQUOTE, LINE_BREAK, RULE, LIST_*, CHECKBOX, TABLE_*,
EQUATION_*). Raw HTML in markdown source is passed through to
`add_text(data, text)`, which writes via
`document.createTextNode(text)` — already XSS-safe (verified in
`node_modules/streaming-markdown/smd.js:1616-1618`). The
"stack-aware HTML suppression" from earlier spec revs is therefore
unnecessary and was removed. The remaining vector is URL attributes on
`LINK` / `RAW_URL` / `IMAGE` tokens — `default_set_attr` calls
`setAttribute(name, value)` verbatim (`smd.js:1620-1623`).

The `makeSafeRenderer(body)` factory used by `initLaneStreamingMarkdown`
wraps `default_renderer(body)` with a proxy that overrides only
`set_attr`:

1. **URL scheme allowlist (not denylist) in `set_attr`.**
   - Triggered when `type === smd.HREF || type === smd.SRC`.
   - Normalisation: strip leading/trailing whitespace and ASCII control
     characters (0x00–0x1F and 0x7F), including `\t`, `\n`, `\r`, and
     embedded control bytes — these are the classic bypass vectors.
   - Then extract the scheme prefix (everything before the first `:`,
     lowercased).
   - **`href` allowlist:** empty (relative), `'#…'` (anchor),
     `'/…'`, `'./…'`, `'../…'`, plus schemes `http`, `https`, `mailto`.
   - **`src` allowlist:** empty (relative), `'/…'`, `'./…'`, `'../…'`,
     plus schemes `http`, `https`. No `data:` even for images
     (acceptable: assistant-streamed images are vanishingly rare; a
     follow-up can add a strict `data:image/(png|jpe?g|gif|webp);base64,…`
     pattern with a length cap).
   - **Protocol-relative `//host/path`:** allow (browser resolves
     against current page scheme; this is `https:` for the Tauri
     webview).
   - On reject, replace value with `'#'` (for `href`) or drop the
     attribute entirely (for `src`).
   - Fixture cases the implementation MUST cover:
     `javascript:alert(1)`,
     `JavaScript:alert(1)`,
     `java	script:alert(1)`,
     ` javascript:alert(1)` (leading space),
     `java\nscript:alert(1)`,
     `data:text/html,<script>`,
     `vbscript:msgbox(1)`,
     `file:///etc/passwd`,
     `//host.example`,
     `/relative/path`,
     `#anchor`,
     `https://example.com`,
     `mailto:foo@bar`.

2. **Default-renderer pass-through** for `data`, `add_token`, `end_token`,
   `add_text`; no other modification.

The proxy is created per-stream and dropped when the lane parser is
nulled. No global state. `marked` v17 elsewhere in the codebase has no
auto-sanitise (`markdown-view.ts:48` does not configure one); fixing
that broader gap is out of scope here — this spec **does not regress**
the existing baseline, and the new vector (streaming-markdown) is
sealed by the wrapper.

### Invariants (Codex review)

These two invariants protect the perf and correctness story; **the
implementation must enforce them and the test plan must assert them**.

1. **RAF-only write invariant.** `parser_write` is called from exactly
   two places: (a) `updateStreamingAssistantMarkdownBody` invoked from
   the RAF fast path in `renderActiveTranscript`, and (b) the seal-drain
   step in `sealStreaming`. **Never** from `appendStreaming()` or any
   ACP event handler. This means many small ACP chunks in a single
   frame coalesce into one `delta` write — bounding parser work to
   animation frames + one seal, matching Spec 114's keypress-to-render
   intent.

2. **Tail-window invariant (debug-build assertion).** `currentAssistantId`
   must always be inside `itemsToRender` for the active lane whenever
   `lane.streamingMarkdownParser !== null`. If a future spec ever
   appends rows after a still-current assistant such that the 60-row
   tail window slides past it, the streaming row's wrapper would be
   removed and the parser would keep mutating a detached subtree.
   Dev-build assertion in `renderActiveTranscript` after building
   `itemsToRender`: `if (lane.streamingMarkdownParser !== null && !itemsToRender.some(i => i.id === lane.streamingMarkdownItemId)) console.warn('[spec117] streaming row outside tail window');`
   and degrade gracefully by tearing down the parser (treat the row as
   sealed-from-disk).

### In-memory vs cold-load contract

This is the precise correctness contract for sealed assistant rows:

- **In-memory (this session).** Any assistant row that streamed during
  the current process lifetime — foreground or background — exits seal
  with `item.markdownHtml` populated from streaming-md output (foreground
  path captures the live body; background path uses the offscreen
  capture in §Seal Path branch B). All subsequent renders of that row
  use the cache; **`marked.parse` is never called** for it.
- **Cold-loaded (next session / transcript reload).** Loaded items
  arrive with no `markdownHtml` cache. `renderTranscriptItem`'s
  non-streaming branch parses them with `marked` exactly as today. This
  means a row's HTML may differ between the session it was streamed in
  and a later session that reloads it from disk.

Persisting `markdownHtml` to disk to make the contract fully uniform
would require trusting the streaming-md output as a security boundary
across restarts (the cached HTML is already-sanitised at write time,
but a downgrade in the sanitiser between versions could let stale
unsafe HTML come back to life). Out of scope for V1; the asymmetry is
acceptable and documented.

### Data Flow

```
1. Model streams chunk C_n; arrives at lane.appendStreamingText().
2. item.text += C_n; lane is marked dirty; scheduleRender() RAFs.
3. renderActiveTranscript() iterates items. The streaming assistant
   row's existing wrapper is in `existing`; fast-path branch fires.
4. updateStreamingAssistantMarkdownBody(body, item, lane):
   - delta = item.text.slice(item.streamingMarkdownWritten)
   - smd.parser_write(lane.streamingMarkdownParser, delta)
     -> renderer appends new tokens / text into body
   - item.streamingMarkdownWritten = item.text.length
5. Next chunk repeats (3)-(4). Prior DOM untouched; user selection holds.
6. Model finishes turn; ACP `stop` event -> sealStreaming(lane).
7. sealStreaming: smd.parser_end(parser); null out lane.streamingMarkdown*;
   class swap to --markdown alias (typography unchanged).
8. Subsequent renders go through the signature-compare path which sees
   the row's `dataset.renderSignature` set to the sealed signature and
   no-ops.
```

## Edge Cases

- **First chunk creates the row.** Handled by `renderTranscriptItem`
  initialising parser + writing initial text.
- **Lane re-activation mid-stream.** Background lanes don't RAF
  (`scheduleLaneRender` no-ops, Spec 114 caveat). When the lane becomes
  active, the next render rebuilds the row via the non-streaming path —
  but the row may still be streaming (currentAssistantId === item.id).
  Fast-path will fire and create a fresh parser bound to the new body
  via step (1)'s body re-creation check. Backfills the full
  `item.text` in one `parser_write`. Selection state in the old
  background body is lost (acceptable; the body was never visible).
- **Resume from disk.** Transcript reload assigns items with sealed
  text; streaming flag is false; existing seal-or-cached marked render
  applies. No interaction with the new streaming parser.
- **Aborted turn.** Cancel/error path also calls `sealStreaming` for
  cleanup (`:1836` neighbourhood). Same teardown as normal seal.
- **Partial code fence at seal.** `parser_end` will flush the dangling
  fence as a code block. Matches sealed-row baseline (marked closes
  unterminated fences silently).
- **Lane disposal mid-stream.** `dispose()` nulls
  `lane.streamingMarkdownParser / streamingMarkdownBody /
  streamingMarkdownItemId`. **Do not** call `parser_end` — the body may
  already be detached or the renderer may hold refs to soon-GC'd DOM,
  and `parser_end` flushes tokens into the renderer. Nulling alone
  releases all parser-side state; the renderer + DOM are dropped to GC
  together. (`parser_end` is only safe when the body is still attached
  AND we want a final flush — that combination is unique to
  `sealStreaming`.)
- **Backtrack (`item.text` shrinks).** Treat as re-stream; rebuild parser
  via `initLaneStreamingMarkdown`. Dev-build `console.warn` on entry to
  this path so we notice if it fires unexpectedly during stream.
- **Full `render()` mid-stream on active lane** (e.g. permission overlay
  triggers a full render, not just the streaming RAF path). Body
  identity preserved by Spec 95; fast-path's body-recreation check
  keeps the parser bound. No duplicate backfill because
  `streamingMarkdownWritten === text.length` after the most recent
  fast-path tick, so the next delta is empty until the next chunk
  arrives.

## Open Questions

None. User selected option 3 + (a) explicitly. Codex / Cursor reviews
applied; sanitisation, seal-drain, background-lane capture, and
in-memory/cold-load contract are all locked.

## Out of Scope

- Streaming markdown for `thought` and `user` rows (V2).
- Streaming markdown for `inter_lane` rows (rendered post-receipt, not
  streamed).
- Streaming KaTeX / Mermaid live render. `streaming-markdown` supports
  LaTeX tokens; rendering them with KaTeX during stream is a separate
  follow-up. For V1 they render as raw `$…$` tokens until seal, then
  inherit whatever post-seal pipeline handles them today.
- Per-lane configuration of throttle or buffering (none required —
  optimistic mode has no throttle to configure).
- Removing the marked + marked-highlight dependency. Other views
  (markdown-view, agent-view) continue to use it.
- **Sealed-row HTML parity with `marked`.** The new sealed baseline for
  assistant rows is the streaming-markdown parser's DOM — captured into
  `item.markdownHtml` at seal time and reused by the cache path on
  subsequent renders. This will visibly differ from today's
  `marked.parse` output in places: no hljs syntax highlight in fenced
  code, possibly different table cell handling, different list/loose
  semantics, no GFM autolink heuristics, no inline footnote rendering.
  Accepted under the user's "option (a) optimistic" selection. Project
  -wide HTML sanitisation, and unifying assistant sealed output with the
  marked-based renderers used by `markdown-view`, are tracked as
  separate follow-ups.

## Spec 114 amendment

Spec 114 rev 4 documents "markdown deferred until seal" as the assistant
streaming model. This spec **supersedes that decision for the assistant
kind only** — thought / user remain on the plain `appendData` path. A
one-line amendment stub should be added to `docs/114-acp-harness-streaming-perf.md`
on implementation, pointing at this spec for the new assistant behaviour.

## Test Plan

- Stream a long assistant response containing all common markdown
  features (headings, bold, italic, inline code, fenced code with
  language, ordered list, unordered list, nested list, link, blockquote,
  table). Verify each formatting appears the moment its opening token
  arrives, with no flicker on subsequent chunks.
- **Chunk-boundary matrix.** For a small fixture set (5–10 representative
  markdown samples covering fences, links, lists, tables, inline emphasis),
  split each sample at every byte offset and feed the two halves to a
  fresh parser. Assert the resulting `body.innerHTML` is invariant
  across all split points. Catches "escapes/backticks split across chunk
  boundaries" and "tables split around separator rows" regressions.
- Mid-stream, select-and-copy a fragment of already-streamed text.
  Verify selection holds as new chunks arrive.
- Mid-stream, scroll up. Verify the scroll anchor holds and the stream
  continues to render in the background without yanking the viewport.
- Force a partial fenced code block at end of stream (model emits
  `\`\`\`ts\nfoo` then errors). Verify seal closes the block cleanly via
  `parser_end`.
- Verify keyboard shortcuts (Cmd+A, Cmd+C, Ctrl+J/K) continue to work
  on a streaming row.
- Verify lane background → foreground transition mid-stream rebuilds
  cleanly (parser bound to new body).
- Dispose a lane while it is streaming. Verify no console errors and no
  detached parser leaking.
- Smoke: a 30 KB assistant response — keypress-to-render budget < 16 ms
  per Spec 114's existing target. The streaming parser is O(delta) per
  chunk so this should comfortably hold.
- Visual regression: sealed assistant rows look like the **streaming-md
  output** (not today's marked output) — this is the new baseline per
  Out of Scope. Typography matches via shared CSS rule.
- **Post-seal signature stability.** Immediately after `sealStreaming`,
  trigger another `renderActiveTranscript()` (e.g. by appending an
  unrelated row). Assert: the streaming row's wrapper is **not**
  replaced and `md.parse` is **not** called. Inspect via a dev-build
  counter or `MutationObserver`.
- **Lane switch-back signature cache.** Stream an assistant row on
  lane A, switch to lane B mid-stream (background growth), switch back
  to lane A. Assert the wrapper rebuilds via the cache path (uses
  captured `item.markdownHtml`, no `md.parse`) and the visible content
  matches the latest `item.text`.
- **Permission overlay full-render mid-stream.** Trigger a permission
  card while assistant is streaming. Assert no duplicate backfill
  (parser still bound, `streamingMarkdownWritten === text.length` at
  tick start) and no detached body left over.
- **Malicious URL in stream.** Stream a markdown link with
  `javascript:alert(1)` href. Assert the rendered `href` is `'#'`.
- **Dispose mid-stream.** Dispose a lane while it is streaming. Assert
  no console errors, no `parser_end` call (verifiable by spying), and
  parser fields nulled.
- **Seal-drain race.** Synthetic test: in one task, call
  `appendStreaming(lane, '…final chunk')` immediately followed by
  `sealStreaming(lane)` (no intervening RAF). Assert the cached
  `item.markdownHtml` contains the final chunk's rendered token. Without
  seal-drain this would lose the tail.
- **Background-only stream + cold-cache offscreen capture.** Stream a
  full assistant turn on a background lane (never foreground it during
  the turn). After seal, activate the lane and assert `item.markdownHtml`
  is populated, no `marked.parse` was called, and the rendered DOM
  matches the streaming-md offscreen output.
- **Background-then-foreground seal.** Lane goes foreground mid-stream
  (parser bound to live body), then backgrounded again before seal.
  Assert seal-drain runs against the parser-owned (now detached) body
  and cache capture succeeds.
- **30 KB single-frame backfill.** Background lane accumulates 30 KB
  then activates. Measure the `parser_write` cost in the activation
  frame; flag if it misses 16 ms but do not block V1.
- **RAF-only-write invariant.** Spy on `parser_write` while emitting 100
  one-byte chunks within a single frame. Assert `parser_write` is
  called at most once (one coalesced delta) plus zero or one at seal.
- **Sanitiser stack balance.** Stream `*<script>alert(1)</script>foo*`
  (HTML inside emphasis). Assert: emphasis open/close still balance,
  `<em>` contains literal `<script>alert(1)</script>foo` as text, no
  attributes leak onto the `<em>`, no `<script>` element in DOM.
- **URL allowlist matrix.** Drive each fixture in §Sanitisation (2)
  through a stream containing `[x](URL)` and `<URL>` autolinks. Assert
  the resulting `href` matches the expected allow/deny outcome.
- **Tail-window edge.** The streaming row is always the last item, so
  it cannot fall out of the 60-row tail window today. Enforced by the
  dev-build assertion in §Invariants (2). Note that
  `appendTranscript()` can also shift rows out at the 300-row cap; a
  300-row turn that pushes the streaming row off the front is currently
  impossible (the cap is per-lane and the streaming row is only added
  once per turn), but the assertion catches any future regression.
- **Cold-cache background-only stream.** A lane streams entirely while
  backgrounded and is sealed before the user ever activates it. No
  parser was created. Seal Path branch B handles this via an offscreen
  parser + capture; cost is one full parse of `item.text` at seal time.
- **Seal-drain catches synchronous final chunks.** ACP can deliver a
  final text chunk and the stop event in the same task. `appendStreaming()`
  mutates `item.text`; the RAF that would write the delta has not yet
  fired. Seal-drain (Seal Path step 4A) writes the residual before
  `parser_end`.
- **Backfill on lane activation mid-stream.** A 30 KB+ accumulated
  `item.text` flushed in a single `parser_write` may exceed the 16 ms
  budget for one frame. Acceptable for V1; smoke test measures it. If it
  misses, follow-up can chunk the backfill across frames at the cost of
  partial-paint UX during activation.

> Note on `highlight.js`: today's `marked` instance uses `markedHighlight`
> + `highlight.js` for fenced code (`markdown-view.ts:48`). The
> streaming-markdown library has its own code block rendering and does
> not call `highlight.js`. V1 will render fenced code as
> `<pre><code class="language-X">…</code></pre>` without syntax highlight
> during streaming; on seal the body remains as the streaming parser
> wrote it (no post-seal swap to `marked`-highlighted output). If syntax
> highlighting during stream is required, wire `highlight.js` into the
> custom renderer's `end_token('code_block')` callback to highlight that
> block when it closes. Flagged as a possible polish follow-up.

## Follow-up: table seal re-render (table guard)

The original V1 note above ("on seal the body remains as the streaming parser
wrote it — no post-seal swap to `marked`") held a latent bug for **GFM tables**.
streaming-markdown is single-pass and cannot backtrack; its table state machine
desyncs when a stream chunk boundary lands mid-table (`smd.js` `table_state`
flips to `0`), after which the remaining `| … |` rows render as literal paragraph
text — and that broken DOM was frozen at seal.

Fix (`acp-harness-view.ts`): seal now does a **guarded post-seal swap to `marked`**.
`hasMarkdownTable(item.text)` detects a GFM delimiter row (`|---|---|`, ≥2 cols);
only then does `sealAssistantStreamingMarkdown` re-render the message with
`md.parse` (full two-pass GFM, correct tables) — Branch A rewrites the live body
(`rerenderAssistantMarkdownWithMarked`, preserving a leading lane-mail provenance
node), Branch B parses straight to the offscreen cache. Messages **without** a
table keep the cheaper streaming-markdown seal output untouched, so the common
path pays no extra cost. The re-render is one-shot per message at turn-end, off
the per-token streaming hot path, so the 16 ms budget is unaffected. Live
streaming still shows the (briefly broken) smd table until it self-corrects at
seal. Covered by `hasMarkdownTable` unit tests in `acp-harness-view.test.ts`.

## Resources

- [streaming-markdown (thetarnav, GitHub)](https://github.com/thetarnav/streaming-markdown) — selected library; readme confirms API + optimistic model.
- [streaming-markdown demo](https://thetarnav.github.io/streaming-markdown/) — visual reference for token-by-token rendering used in the prior-art comparison.
- [Best practices to render streamed LLM responses (Chrome for Developers)](https://developer.chrome.com/docs/ai/render-llm-responses) — confirmed that "streaming markdown parser" is the established pattern; informed Krypton delta framing.
- [semidown (chuanqisun, GitHub)](https://github.com/chuanqisun/semidown) — block-buffered reference; what option (b) would have used.
- [HN: Preventing Flash of Incomplete Markdown when streaming AI responses](https://news.ycombinator.com/item?id=44182941) — community discussion of optimistic-vs-buffered trade; aligned with user's (a) choice.
- `docs/114-acp-harness-streaming-perf.md` — prior decision rationale for plain-until-seal; this spec deliberately reopens that decision under the constraints stated above.
