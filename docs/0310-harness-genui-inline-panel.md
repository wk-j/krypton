# ACP Harness Generative UI — Inline Panel — Implementation Spec

> Status: Implemented (2026-10-17) · rev 2 (2026-10-17): the panel expands on seal
> Date: 2026-10-17
> Milestone: ACP Harness
> Reverses one decision of [spec 308](./0308-harness-generative-ui.md) (the modal overlay host); the wire format of [spec 309](./0309-harness-genui-catalog.md) is unchanged.

## Problem

A `krypton-ui` fence compiles to a card in the transcript, but interacting with it covers the whole dashboard: `GenUiPanel` is an `OverlayShell` that paints a dialog over the lane, hiding the reply the panel belongs to and every row around it. A spec is almost always *about* the surrounding turn — a comparison of the three options just discussed, a slider over the numbers in the paragraph above it — and the overlay makes it impossible to read both at once.

## Solution

Keep the card, drop the overlay. `GenUiPanel` renders itself as a plain inline block mounted in a slot inside the card it belongs to, so the panel expands in place in the sealed row and the transcript scrolls around it. The view keeps exactly what made the overlay safe: one panel open at a time, keyboard ownership while open (`Escape` closes, `Tab` rides the roving tabindex), the `(lane, item, index, sourceHash)` state LRU, and actions limited to Draft / Set / Copy / OpenUrl. Nothing in `src/acp/genui/` or the catalog renderer changes — this is a host swap.

**Rev 2 — the panel expands itself.** A fence compiles when its row seals, and the card it leaves behind is a one-line summary of something the user asked the agent to build: requiring a click made "never seen" the default outcome. `sealStreaming` therefore opens the row's last fence itself. An auto open is not a user gesture, so it takes neither of the two things a user open takes: no focus (the composer keeps every key until the user enters the panel) and no reveal scroll (a reader somewhere else in the transcript is not moved). Keyboard ownership follows focus rather than `isOpen`, and a pointer press on a control is what hands it over — WebKit does not focus a `<button>` on click, so the panel claims it explicitly.

## Research

- **The renderer is already host-agnostic.** `renderChildren(host, roots, ctx)` (`src/acp/components/genui-catalog/index.ts:69`) takes any element; the only overlay coupling is `OverlayShell` in `genui-panel/index.ts:25,57,78-80`. The catalog's shared rules are scoped to `.acp-genui`, so the inline host must keep that class on the content node.
- **Keyboard ownership does not come from the overlay.** `OverlayShell` enforces single-open visibility through a module-level `Set` and carries no key routing (`components/overlay-shell/index.ts:38,214-220`). Keys are routed by one hand-ordered branch at the top of the chain: `acp-harness-view.ts:4211` `if (this.genUiPanel?.isOpen) return this.genUiPanel.handleKey(e);`. That branch works identically for an inline host, as long as `isOpen` becomes view/panel state instead of `shell.isOpen`.
- **A focused in-row control already has a supported path.** `handleKey` returns `false` when the event target is inside the panel, so `InputRouter` never calls `preventDefault()` and the native control gets the key (`genui-panel/index.ts:137`; same trick as the annotation textarea at `acp-harness-view.ts:4319-4328`).
- **Sealed rows may be mutated outside `paint()`.** The dev dep-stability assert only fires when `readDeps()` changes across a `paint()`; `uiFences` is deliberately absent from `AssistantRow.bodyDeps()`, which is why `patchUiHints()` can already write into sealed DOM. An inline panel uses the same escape hatch.
- **Every sealed paint re-decorates.** `item.markdownHtml` caches pure markdown only; `paintSealed` does `body.innerHTML = markdownHtml` then re-runs `decorateUiFences` (`assistant-row/index.ts:221-249`). A mounted panel element is therefore detached by any later repaint of its row, and by the row leaving the tail window (`reconcile` disposes it). The host must re-mount after each transcript commit and close when the slot is gone.
- **Scroll anchoring exists.** `captureTranscriptScrollAnchor` / `restoreTranscriptScrollAnchor` (`acp-harness-view.ts:15276-15308`) plus a `ResizeObserver` over the body *and every row* (`:15310-15354`) already absorb an in-place row height change: sticky lanes re-pin to the bottom, non-sticky lanes keep the topmost visible row's offset. Expanding a panel needs no new anchoring machinery, only an explicit capture/restore around the mount and a bounded reveal scroll when the panel opens below the fold.
- Rejected: **a second `OverlayShell` docked to the row** (still steals the dashboard), and **one panel instance per card** (N live reactive trees, N focus rings, and the LRU would stop being the single owner of input state).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| OpenUI `GenUI` | Assistant messages render structured components **inline in the message stream**, from a frontend component library the model picks from | The inline default this spec moves toward |
| OpenUI `Artifacts` | Compact **inline preview** in the message that expands into a **side panel** when clicked | Two-surface split: preview inline, interaction elsewhere |
| Claude Artifacts / ChatGPT Canvas | A substantial generated document/app opens in a **dedicated surface beside** the conversation | Justified by a full editor; far heavier than a slider and a table |
| Cloudscape generative-AI chat | Message-level content blocks (charts, support prompts) render **inside the message bubble** | Confirms inline is the convention for small, reply-scoped UI |

**Krypton delta** — Krypton has no room for a side panel: the Harness is one dashboard in one native window, and a side surface would cover the transcript exactly like the overlay does. So the card stays (it is the hint target and the collapsed state) and the panel expands *in place* under it, closer to OpenUI `GenUI` than to Artifacts. Unlike all four, interaction is keyboard-first: `f` + label expands, `Tab` moves between controls without leaving the panel, `Escape` collapses and returns focus to the composer.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/components/genui-panel/index.ts` | Drop `OverlayShell`; own an inline root (`head` / `main`), own `open` state, `onClose(restoreFocus)` callback, keep `handleKey` / roving tabindex / visibility watcher |
| `src/acp/components/genui-panel/genui-panel.css` | Replace the overlay backdrop + dialog frame with an inline frame seated inside the card |
| `src/acp/components/genui-panel/genui-panel.scheme.css` | Deleted — it existed only for the overlay backdrop |
| `src/acp/components/genui-card/index.ts` | Emit a mount slot per card, carry `aria-expanded`, and keep the slot through re-decoration |
| `src/acp/components/genui-card/genui-card.css` | Expanded card variant; empty slot collapses |
| `src/acp/acp-harness-view.ts` | `genUiOpen` target state, `syncGenUiMount()` after every transcript commit, toggle semantics, reveal scroll, close paths |
| `src/acp/components/registry.ts` | `genui-panel` no longer owns `acp-harness__genui-panel-overlay` |
| `docs/0004`, `docs/0005`, `docs/0308`, `docs/0309`, `docs/README.md` | Host-model text: overlay → inline |

## Design

### Data structures

```ts
// genui-panel/index.ts
export interface GenUiPanelProps {
  readonly open: boolean;
  readonly entry: UiFenceEntry | null;
  readonly state: UiState;            // mutated in place, owned by the view's LRU
  readonly views: GenUiViews;
  onDraft(text: string): string | null;
  onOpenUrl(url: string): void;
  onClose(restoreFocus: boolean): void;   // was onClose(): void
}

// acp-harness-view.ts
private genUiOpen: { itemId: string; index: number } | null = null;
```

The panel's root is `div.acp-genui-panel` (no overlay wrapper). `genUiStates` keeps its key and `UI_MAX_PANEL_STATES` cap.

### DOM

```
div.acp-genui-card[.acp-genui-card--open]
  button.acp-genui-card__open[data-genui-index][aria-expanded]
  div.acp-genui-card__panel[data-genui-slot]      ← empty ⇒ display:none
      div.acp-genui-panel                          ← the view moves this one node in
        div.acp-genui-panel__head  (key legend + the Source toggle, right-aligned;
                                    the card above carries the title and the summary)
        div.acp-genui-panel__main  (body.acp-genui · feedback · source)
```

### Data flow

```
0. `sealStreaming` sealed the assistant row ⇒ its fences compiled and their cards
   exist ⇒ autoOpenGenUi(lane, itemId) → openGenUi(itemId, last fence, 'auto').
   Active lane only, and only when nothing is open — a panel in use is never displaced
1. `f` + label (or a click on the card) → openGenUi(itemId, index, 'user')
2. Same target already open → collapse (toggle). Otherwise close the previous one.
3. Resolve/create the LRU entry, capture the transcript anchor
4. Seat the node FIRST (`mountGenUiPanel`), then `update({ open: true, takeFocus })`:
   a `user` open focuses the first control with `preventScroll` — the reveal below is
   the only scroll the panel is allowed to cause — and focus() on a detached node
   is a no-op. No card claimed the fence ⇒ drop the open target and do nothing
5. Restore the anchor, then reveal (a `user` open only): if the card's bottom is
   below the lane body,
   scroll by the smaller of (overflow, card top offset) inside a programmatic-scroll
   token, and record the landing position as `savedScrollTop` / `savedScrollAnchor`
   (an unstuck lane only; a stuck one keeps a null anchor). A programmatic scroll's
   own event is swallowed, so without this the lane's bookkeeping still describes
   the pre-reveal position and the next ResizeObserver tick — the user's first
   input inside the panel — restores it, undoing the reveal
6. Input → ctx.setInput → evaluate() → renderChildren patches only changed nodes
7. Draft action → view validates (lane active, fence unchanged, composer empty) → setDraft → collapse
8. Escape / the card head / draft loaded → panel.close(true) → onClose(true) → detach,
   clear genUiOpen, focus the composer
9. Transcript commit → syncGenUiMount(): no card claims it (row disposed, lane switched,
   fence changed) ⇒ close(false); the card was re-decorated ⇒ re-append the same node
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `f` + label | Transcript focus | Expand the card's panel (collapse if it is the open one) |
| `Tab` / `Shift+Tab` | Panel focused | Move between the panel's controls |
| `Escape` | Panel focused | Collapse, focus returns to the composer |
| printable / navigation | Panel focused, target outside the panel | Swallowed, as with the overlay |
| anything | Panel open but not focused (auto-expanded) | Goes to the composer; the panel is visible, not modal |

**Precedence.** `AcpHarnessView.onKeyDown` is a flat ordered chain, and 308 put the panel at the very top because an `OverlayShell` is modal. Inline, it is not: the branch moves **below** every summon-on-demand surface (dictation, image viewer, hint mode, help/pickers/metrics/triage/console, memory drawer, annotation overlay) and **above** the lane chords, transcript navigation and the composer catch-all. An overlay drawn over the panel therefore owns the keyboard — the `OverlayShell` registry used to close the panel on our behalf and no longer can — while a focused control inside the panel still receives its key, because `handleKey` returns `false` for its own subtree.

**Ownership follows focus (rev 2).** The branch is `isOpen && hasFocus`, not `isOpen`: an auto-expanded panel is open and unfocused, and the keys of someone typing their next message belong to the composer. Focus enters on a `user` open, or on a pointer press inside the panel — the panel focuses the pressed control itself (`pointerdown`, `preventScroll`) because WebKit does not focus a `<button>` on click, and the roving ring continues from there. `f` + label on an auto-expanded card still toggles it collapsed, and the next `f` opens it as a `user` open, with focus.

### UI

The panel is seated in the card: no shadow, no backdrop, a single hairline rule between the card head and the panel body, and the expanded card drops its accent tint so the fill does not wash the whole panel. The card head keeps the title, the summary and the `f` badge, so the panel head carries only the key legend (`Tab moves between controls · Esc closes`) — repeating the title under it read as two headings for one thing — plus the `Source` toggle, right-aligned. That toggle is the ` ```svg ` fence card's bar button (`.acp-harness__svg-card-btn`: transparent, 1px/6px, border only on hover), not the dialog-weight button the overlay had; the panel is a fence preview like the svg card, so it reads as one. **There is no Close button**: the card head is the toggle that opened the panel and closes it again, `Escape` does the same, and a dedicated button repeated that in a heavier control. Focus order is the catalog controls first and the `Source` toggle last, so opening still focuses the spec's first input even though the toggle sits above it in the DOM. No animation on expand — the row is sealed (CLAUDE.md constraint 10) and the panel is a user-driven mutation, not a repaint.

**The outermost `Card` is the panel frame, not a box inside it.** `cardTitle()` already takes the card head's title from that root, so painting the root's own `.acp-genui__card` nested a second border under a repeated heading — the same "two headings for one thing" the panel head avoids, one level further in. `GenUiPanel.unframe()` therefore renders that root's children in its place when `props.title` equals the entry title the head is printing; a computed title (the head falls back to the component name `Card`), a first root that is not a `Card`, or an empty child list keeps its box, because dropping it would drop a heading nothing else prints. Later roots are untouched. The unwrap makes `.acp-genui-panel__body` the spec's top-level stack, so its gap is the catalog's 8px (`__card-body`, `__stack`), not the 12px `__main` uses between chrome blocks.

## Edge Cases

- **Row leaves the tail window / lane switch / lane reset / view dispose** — the slot disappears; `syncGenUiMount` closes with `restoreFocus = false`. Input state survives in the LRU, so re-expanding the same fence resumes.
- **Row repaints** (annotation added, provenance change) — `paintSealed` rebuilds the card and an empty slot; `syncGenUiMount` re-appends the live panel node, which keeps its DOM and therefore its scroll/focus-ring position.
- **Fence source changed by a re-stream** — the open target's `sourceHash` no longer matches; treated as slot-missing and closed.
- **Tab or window hidden** — the existing `MutationObserver` closes with `restoreFocus = false`.
- **Expanded panel taller than the lane body** — the reveal scroll is bounded so the card head never leaves the viewport; the rest is reached by normal transcript scrolling after `Escape`, or with the mouse wheel while open.
- **Sticky lane** — `lane.stickToBottom` wins: the `ResizeObserver` re-pins to the bottom, matching every other in-place height change.
- **Several fences in one reply (rev 2)** — the auto open takes the last, the one nearest what the agent said last; the others stay cards and open with `f` or a click, which collapses the auto-expanded one as any other open does.
- **Row seals mid-turn (rev 2)** — a tool call seals the text row, so a fence written before a tool is expanded while the turn continues. It scrolls away under the new rows like any other content; nothing re-opens or re-focuses it.
- **Background lane finishes (rev 2)** — the panel is one node owned by the view, so `autoOpenGenUi` is a no-op for a lane the user is not looking at. Switching to that lane does not retro-expand: the card is there to open.
- **Turn ends while the user is typing (rev 2)** — the panel expands but takes no focus and no scroll, so the keystroke after the seal still lands in the composer.

## Out of Scope

- Rendering a panel while the reply streams: unchanged from 309, decoration still happens at seal.
- More than one panel open at a time.
- Keyboard transcript scrolling while a panel is open (`Escape` first). The overlay had the same rule.
- Any change to the language, validator, catalog, action set, or caps in `src/acp/genui/`.
- Persisting panel state across Harness close or app restart.

## Resources

- [OpenUI — GenUI](https://www.openui.com/docs/chat/genui) — inline structured UI in assistant messages as the default chat pattern.
- [OpenUI — Artifacts](https://www.openui.com/docs/chat/artifacts) — the inline-preview → side-panel split this spec deliberately does not copy.
- [Cloudscape — Generative AI chat patterns](https://cloudscape.design/gen-ai/patterns/generative-ai-chat) — message-level content blocks rendered inside the message.
