# 302. Harness Component Catalog

> Status: Implemented
> Date: 2026-10-15
> Kind: **Reference**, not a spec. Companion to [301 — Harness UI Components](./0301-harness-ui-components.md),
> which owns the problem statement, the kernel design, and the migration phases. This document is the
> inventory: component contracts, example DOM, and historical cutover sites, with current registry counts below.
>
> [0316](./0316-llm-managed-timeline.md) removes TimelineCapture from runtime and catalog,
> its registration, form stylesheet, pending badge, and Timeline-only focus/key gates.
> Historical slot **7.15** stays reserved below; later entries are not renumbered.
> Timeline writes belong to the working lane's MCP tools. History stays in the read-only browser;
> `ReviewThreadDialog` / **Start Review** is a separate feature and remains.
> Rendered sheets preserve the original migration illustrations, not the current registry;
> the Layer 7 sheet's TimelineCapture illustration is retired.

## How to read an entry

Every entry has four parts:

- **Props** — the typed input. This *is* the change contract (spec 301: props equality replaces `transcriptRenderSignature`).
- **Example UI** — what it renders, using the literal strings and glyphs the current code emits.
- **Emits** — the BEM markup, unchanged from today. No visual redesign is in scope.
- **Replaces** — the call sites it deletes, with `path:line`.

Preview boxes use `╭╮╰╯` only as a page device to show a component's bounds. They are **not** UI chrome —
real surfaces keep a full 1px border or none (`CLAUDE.md` constraint 9), and nothing here adds a border
that does not exist today.

Every layer also has a **rendered sheet** in [`images/`](./images/), linked under its heading: one labelled
panel per entry, drawn from the same strings as the `Example UI` blocks. The sheets carry their own palette
and follow the reader's light/dark preference.

`L` = live component (`LiveComponent`, refuses structural repaint while the agent is writing into it).

**Packaging.** Each entry becomes one directory `src/acp/components/<name>/` holding its class, its own
stylesheet, its scheme overrides and its test — add by creating it, remove by deleting it. Each entry's
`Emits` block names the BEM block(s) it owns, and those are its private styling surface: no
other sheet may declare selectors for it, and everything tunable is a custom property on the block root.
See §Packaging, style ownership, and theming at the end of this document, and spec 301
§UI changes and style ownership. Entries that **share** a block today are flagged ⚠ and get their own.

Eight primitives (`Chip`, `Card`, `OverlayShell`, `ListPicker`, `TabStrip`, `KeyHintBar`, `StatList`,
`EmptyState`) take `block` as a **prop** and so own no block of their own — they paint into whichever
block their caller owns. Each directory therefore exports `blocks: readonly string[]`, and that list, not
the directory name, is what `styles-ownership.test.ts` checks.

---

# Layer 0 — Layout

Not a visual component. `LayoutHost` is what makes every component below *placeable*: it owns the named
containers, and one declarative table says which container each panel mounts into. Spec 301 §Layout has
the rationale and the pinned-surface list.

![Layer 0 — LayoutHost slot map](./images/0302-layer0-layout.svg)

## 0.1 `LayoutHost` / `Slot`

```ts
type HarnessSlot = 'lane.head' | 'lane.understats' | 'rail.top' | 'rail.bottom' | 'dock.right' | 'composer.above' | 'composer.below';
interface Slot { readonly el: HTMLElement; mount(id: string, c: Component<unknown>, order: number): void; unmount(id: string): void }
```

**Example UI** — the slot map, with today's default table in place

```
╭─ lane.head ──────────────────────────────────────────────────────────╮
│ ⠙ claude-1  busy   sonnet-4-6  mcp ✓ 14  12.4% 843M                  │
│ sess 4f2a9c · krypton · ⌁128.4k/200.0k (64%) · $0.4412 USD           │
├─ lane.understats ────────────────────────────────────────── (empty) ─┤
│                                         ╭─ rail.top ───────────────╮ │
│   transcript  (PINNED — never reparented)│ plan      4/9           │ │
│                                          │ peek      codex-1  5m+  │ │
│                                          │ thought   thinking…     │ │
│                                          │ annotation ANNOTATED 3  │ │   ╭─ dock.right ─╮
│                                          ╰─────────────────────────╯ │   │ active ticket│
│                                          ╭─ rail.bottom ────────────╮ │   │ KR-301  open │
│                                          │ omp-1     ⏎ QUEUE 3      │ │
│                                          ╰──────────────────────────╯ │
├─ composer.above ─────────────────────────────────────────────────────┤
│ ⇆ awaiting codex · 5m+ · #cancel drops pending lane-mail wait        │
│ claude-1  ⠋  convert the UI into reusable comp_onents                │
╰─ composer.below ──────────────────────────────────────────── (empty) ─╯
```

**Switching a position** is one type-checked line, no CSS and no renderer edit:

```ts
-  plan: { slot: 'rail.top',        order: 10 },
+  plan: { slot: 'lane.understats', order: 10 },
```

**Replaces** the three places a position is pinned down today: `appendChild` order in
`acp-harness-view.ts:6467-6490` · absolute positioning + fixed `320px` + `margin-top:auto` in
`acp-harness.css:1103-1148` · the four private fields `planSlotEl` / `peekSlotEl` / `thoughtSlotEl` /
`queueSlotEl` that every rail renderer addresses by name.

**Pinned (not movable):** the transcript body (reparenting zeroes `scrollTop` — spec 94/95), the composer
(keyboard-first escape hatch), and inline permission / question / write-review rows (transcript content,
not panels — the line spec 251 already drew).


# Layer 1 — Leaf primitives

Pure, stateless, no listeners. These are the ones duplicated most.

![Layer 1 — leaf primitives: Chip, Spinner, Meter, StatList, EmptyState, ActionButton, KeyHintBar, TabStrip, Caret](./images/0302-layer1-leaf.svg)

## 1.1 `Chip`

```ts
interface ChipProps { text: string; tone?: 'neutral' | 'warn' | 'on' | 'off' | 'hot'; icon?: IconId; title?: string; block?: string }
```

**Example UI**

```
 Code   polly-bypass   ⚠ bypass   claude-sonnet-4-5   mcp ✓ 14   12.4% 843M
```

**Emits** `<span class="${block}" title="${title}">${icon?}${text}</span>` — `block` keeps the existing
class so CSS is untouched: `acp-harness__lane-mode`, `acp-harness__lane-sandbox`, `acp-harness__lane-model`,
`acp-harness__lane-mcp`, `acp-harness__lane-metrics`, `acp-harness__rail-metric`, `acp-harness__lane-peek-chip`,
`acp-harness__tool-kind`, `acp-ticket__badge`, `acp-priority__tag`.

**Replaces** `harness-lane-chrome.ts:320-406` (7 builders) · `acp-harness-view.ts:13062-13069,13100-13107` ·
`lane-peek.ts:512-541` · `harness-tool-render.ts:553-587` · `harness-ticket-controller.ts:663,729-733` ·
`review-priority-overlay.ts:38-40` · `harness-subagents.ts:353-357`. **15 sites → 1.**

## 1.2 `Spinner` L

```ts
interface SpinnerProps { running: boolean; terminalGlyph?: string }   // frames owned by the component
```

**Example UI**

```
⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏      sealed: ✓   failed: ✗
```

**Emits** `<span class="acp-harness__spinner">⠋</span>`; drops the class and swaps to `terminalGlyph` when
`running` goes false.

**Replaces** `harness-lane-chrome.ts:51,626-640` (lane symbol) · `harness-tool-render.ts:29-45` (tool glyph) ·
`acp-harness-view.ts:13284-13287` (composer prompt) · `tickSpinner` `:13439-13450`.
**Deletes the `liveSpinnerGlyph` module global** (`harness-tool-render.ts:32-39`), which exists only because
the spinner has no owner and a parent rebuild snapped it to frame 0.

## 1.3 `Meter`

```ts
interface MeterProps { value: number; max: number; label?: string; valueText?: string; tone?: 'cpu'|'rss'|'plus-minus'; mode: 'track' | 'glyph' | 'segments' }
```

**Example UI**

```
track     12.4%  ████████░░░░░░░░░░░░
glyph     ▰▰▰▱▱ deep
segments  Cache hit  93%  ▓▓▓▓▓▓▓▓▓▓▓▒▒▒░░
diffstat  src/acp/lane-peek.ts   42  ███████▂▂
```

**Emits** track → `.acp-harness__metrics-meter > -value + -track > -fill[style=width:N%]`;
glyph → `.acp-harness__thought-effort > -glyph + -tier` (`▰`/`▱`, tiers `brief · considered · deep ·
extended · exhaustive`); segments → `.acp-harness__usage-cache-track > -segment[style=flex-grow]`;
diffstat → `.acp-harness__tool-stat-bar[--stat-plus-width/--stat-minus-width]`.

**Replaces** `harness-lane-chrome.ts:295-304` · `harness-transcript-render.ts:92-107,156-176` ·
`harness-tool-render.ts:901-929`. **4 builders, 3 different percentage conventions → 1.**

## 1.4 `StatRow` / `StatList`

```ts
interface StatRowProps { label: string; value: string | Node; title?: string; icon?: IconId; tone?: string }
interface StatListProps { rows: readonly StatRowProps[]; block: string; layout: 'inline' | 'dl' | 'grid' }
```

**Example UI**

```
inline   sess 4f2a9c · krypton · ⌁128.4k/200.0k (64%) · cache 93% · in 12.4k out 3.1k · $0.4412 USD · ⚒37 · ≡412
dl       Turns 14   Input 182.0k   Output 12.4k   Cost $0.44
peek     tool   Edit · lane-peek.ts
         plan   4/9  wire composer meta segments
```

**Emits** `inline` → bare sibling `<span title>`s (lane stats, unchanged);
`dl` → `.acp-harness__usage-metric > dt + dd`; `grid` → `.acp-harness__lane-peek-row > -prefix + -value`.

**Replaces** `harness-lane-chrome.ts:468-537` · `lane-peek.ts:419-427` ·
`harness-transcript-render.ts:180-191,217-230` · `attention-overlay.ts:141-158` ·
`review-priority-overlay.ts:35-58` · `harness-ticket-controller.ts:629-646`. **7 label+value builders → 1.**

## 1.5 `EmptyState`

```ts
interface EmptyStateProps { text: string; block: string; tag?: 'div' | 'li' | 'p' }
```

**Example UI**

```
lane transcript will appear here
no ACP lanes            no sessions for this project        No judgement pending. 3 items in the silent pile.
no handoffs yet         No reading priority reported.       no matching tickets
```

**Emits** `<${tag} class="${block}">${text}</${tag}>`.

**Replaces** **18 sites across 9 class names**: `acp-harness-view.ts:5318,12107,12695,12852,12861,12884,12919,13153,13161` ·
`attention-overlay.ts:176-183` · `review-priority-overlay.ts:90-92` · `harness-ticket-controller.ts:641,643,648,652,655,714`.

## 1.6 `ActionButton`

```ts
interface ActionButtonProps { label: string; keyHint?: string; disabled?: boolean; disabledReason?: string; data?: Record<string,string>; block: string; modifier?: string }
```

**Example UI**

```
[ Enter  Set ticket ]  [ ⌘1  Analyze ]  [ ⌘2  Post comment ]  [ ⌘3  Fix here ]
[ Source ]  [ Copy ]            [ send 2 ]  [ sent ]  [ del ]
```

**Emits** `<button type="button" class="${block}${modifier}" ${data} ${disabled} title="${disabledReason}"><span class="${block}-key">${keyHint}</span> ${label}</button>`.

**Historical cutover sites** — `harness-svg-fence.ts:276-300` · `harness-ticket-controller.ts:770-779` ·
`transcript-annotation.ts:340-363` · `acp-harness-view.ts:3154-3167` · `remote-harness-picker.ts:102-106`.
The original seven-site count included two builders in the now-removed Timeline capture form;
those are no longer call sites or style owners.

## 1.7 `KeyHintBar`

```ts
interface KeyHintBarProps { hints: readonly { keys: readonly string[]; label: string }[]; note?: string; style: 'kbd' | 'plain'; block: string }
```

**Example UI**

```
kbd     [h] [l] switch lane   [j] [k] select round   [enter] [space] expand findings   [esc] close   read-only — observation, not a score
plain   j/k move · enter spawn · esc cancel
plain   ↑↓ / ⌃n⌃p select · Enter/Tab insert · Esc dismiss
```

**Emits** `kbd` → `<span><kbd>h</kbd> <kbd>l</kbd> switch lane</span>` inside `.${block}__foot`;
`plain` → one `<span>` of `·`-joined text inside the picker header.

**Replaces** `acp-harness-view.ts:5412-5429,12705-12710,12770-12774,12807-12811,12838-12892,15081-15084` ·
`review-priority-overlay.ts:121-127` · `attention-overlay.ts:122-131` ·
`harness-ticket-controller.ts:780-783` · `harness-lane-chrome.ts:463`. **9+ sites → 1.**

## 1.8 `TabStrip`

```ts
interface TabStripProps { tabs: readonly { id: string; label: string; count?: number; disabled?: boolean }[]; activeId: string; block: string; activeClass: 'is-active' | `${string}--active` }
```

**Example UI**

```
 codex-1 · 4    grok-1 · 2         ← review matrix / review priority (span, `is-active`)
[ Open 7 ] [ Closed 23 ]           ← ticket picker (button, `acp-ticket__tab--active`)
```

**Emits** `<div class="${block}__lanes|__tabs">` + per tab `<span|button class="${block}__lane|__tab${active}">`.

**Replaces** `acp-harness-view.ts:5327-5342` · `review-priority-overlay.ts:98-108` (character-for-character
the same loop, different prefix) · `harness-ticket-controller.ts:700-707`.


## 1.9 `Caret` ⚠

```ts
interface CaretProps { blink?: boolean }
```

**Example UI** (`_` marks the cell the underline sits under; it consumes no cell of its own)

```
convert the UI into reusable comp_onents      composer draft / dictation preview
redirect →  tell codex to re-check the deps_   triage redirect
```

**Emits** `<span class="acp-harness__caret"></span>` — an UNDERLINE painted by `caret.css`,
never a typed glyph: the host span is `width: 0` and an `::after` bar (`1ch` wide,
`max(2px, 0.1em)` tall, `background: currentColor`) overlays the cell to its right. Two bugs
are why. A `█` text node is one cell wide only in a font that *has* `U+2588`; `[font] family`
starting at `Share Tech Mono` sends that one character to the next font in the stack, measuring
1.148 cells wide and 20.1px tall against a 19.2px line box. And a cursor that *occupies* a cell
splits the word it sits in: with the spec-285 ghost, `pend` + caret + ghost `ing` rendered as two
fragments one cell apart instead of one `pending` (measured: the ghost started 9.63px — one cell —
further right than with no caret; with the underline it starts exactly where it does with no caret).

**Replaces** `acp-harness-view.ts:13257` · `harness-dictation-controller.ts:50` ·
`harness-ticket-controller.ts:758`, queried by `harness-composer-bloom.ts:156,176`.
⚠ The attention overlay needed a narrower glyph and **forked the rule** rather than parameterising it
(`acp-triage__caret`, `attention-overlay.ts:120`, `attention-triage.css:274`). An underline has no
glyph to narrow, so the fork collapses with no prop at all; only its window-accent colour survives,
as a context rule in `caret.css`.

## 1.10 `DockActionButton` (spec 344)

```ts
type DockActionState = { kind: 'idle'; detail?: string } | { kind: 'running' | 'done'; badge: string; detail: string };
interface DockActionProps { state: DockActionState; disabledReason: string | null }
new DockActionButton({ label, icon, data })   // label, icon and data-* fixed for the button's life
```

**Example UI**

```
[ ◇ Analyze ] [ ◇ Fix here ] [ ◇ Comment ]     ← Ticket Panel issue actions (spec 342), 3 columns
[  ✓ 10-27  ] [    ✓ PR    ] [  ✓ 14:02  ]
[ ▷ Run              ] [ ➚ Send              ]  ← Rails dock Actions bar (spec 344), 2 columns
[  check 2/3 tsc     ] [  ✓ 14:02            ]
```

**Emits** `<button type="button" class="acp-dock-action[ acp-dock-action--running|--done]" ${data} ${disabled} title="${disabledReason ?? detail}">`
holding `<span class="acp-dock-action__head">` (icon + `__label`) and, while running or done, the
badge `<span class="acp-dock-action__state">`. A done button stays enabled; a running button keeps
its colour while disabled. No click listener: each dock routes clicks through one delegated handler
that reads the `data-*` attribute. Deps `[dockActionKey(state), disabledReason]`.

**Replaces** the Ticket Panel's private `IssueActionButton` (spec 342) and its
`.acp-ticket-dock__action*` rules. **2 docks → 1.**

---

# Layer 2 — Composite primitives

![Layer 2 — composite primitives: Card, OverlayShell, ListPicker, InlinePalette, DiffBlock](./images/0302-layer2-composite.svg)

## 2.1 `Card` ⚠

```ts
interface CardProps { head: { glyph?: string; hint?: string; title: string; meta?: string; toolbar?: ActionButtonProps[] }; body?: Node; action?: string; block: string; modifiers?: readonly string[] }
```

**Example UI**

```
╭──────────────────────────────────────────────────────╮
│ f   ◫  Render path comparison                        │   ← artifact card (hint `f`, glyph ◫)
│ 184.2 KB · a91f3c2                                   │
│ press f to open in browser                           │
╰──────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────╮
│ g   ▤  Review Board — spec 301                       │   ← review card (glyph ▤)
╰──────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────╮
│ svg                               [Source]  [Copy]   │   ← svg/mermaid fence card
│ <preview>                                            │
╰──────────────────────────────────────────────────────╯
```

**Emits** `.acp-harness__artifact-head > -hint + -glyph + -title`, `.acp-harness__artifact-meta`,
`.acp-harness__artifact-action`; fence variant `.acp-harness__svg-card > -bar > -kind + -hint + buttons, -preview`.
⚠ The review card borrows `acp-harness__artifact-head` today (`harness-tool-render.ts:729-770`), so restyling
the artifact card silently restyles the Review Board card. `Card` takes `block` as a prop; the review card
gets `acp-harness__review-card` and its own sheet.

**Replaces** `harness-tool-render.ts:675-689,691-727,729-770` · `harness-transcript-render.ts:125-249` ·
`harness-svg-fence.ts:287-310,525-545` · `attention-overlay.ts:59-138` · `lane-peek.ts:553-568` ·
`harness-subagents.ts:360-431`. **9 head+body+action builders → 1.** Note `renderReviewCardBody` already
reuses `acp-harness__artifact-head` with different strings — the duplication is admitted in the CSS too
(four mirror comments on the tool-head family: `acp-harness.css:3555` → `.acp-harness__tool-head`, `:3566` → `tool-glyph`, `:3582` → `tool-kind`, `:3601` → `tool-subject`).

## 2.2 `OverlayShell`

```ts
interface OverlayShellProps { open: boolean; title: string; sub?: string; body: Node; hints?: KeyHintBarProps; empty?: string; block: string }
```

**Example UI**

```
╭──────────────────────────────────────────────────────────────────────╮
│ Review quality matrix        this session · in-memory · not persisted│
│ ──────────────────────────────────────────────────────────────────── │
│  codex-1 · 4    grok-1 · 2                                           │
│  round    subject                     reviewers  block  warn         │
│  12:04    ▸ spec 301 diff                     3      1     4         │
│ ──────────────────────────────────────────────────────────────────── │
│ [h][l] switch lane  [j][k] select round  [esc] close                 │
│ read-only — observation, not a score                                 │
╰──────────────────────────────────────────────────────────────────────╯
```

**Emits** `<aside class="acp-harness__${name}-overlay" hidden>` > `<div class="${block}__panel">` >
`header.${block}__head > .${block}__title + .${block}__sub`, body, `.${block}__foot`.
Owns the `hidden` toggle, the `replaceChildren` body swap, and the mutual-exclusion contract
(`helpOpen = false; memoryDrawerOpen = false;` repeated at 7 sites today: `acp-harness-view.ts:5083,5263,5544,9903,10016,10153,10199`).

**Replaces** 12 bespoke shells: `acp-harness-view.ts:5297-5330,12669-12712,12715-12777,12779-12818,12820-12894,13143-13188,13573-13589,13625+` ·
`review-priority-overlay.ts:72-127` · `attention-overlay.ts:161-198` · `harness-ticket-controller.ts:752-783` ·
`remote-harness-picker.ts:69-170`. **Deletes the three CSS files' "Mirrors …" shells**
(`review-quality.css:1-5`, `review-priority.css:1-6`, `orchestrator-console.css:1-5`).

## 2.3 `ListPicker<T>`

```ts
interface ListPickerProps<T> { items: readonly T[]; cursor: number; renderRow(item: T, index: number): Node; block: string; filter?: string; followCursor?: boolean }
// owns: cursor math, `--active` modifier, scrollIntoView({block:'nearest'}), data-index attrs
// does NOT own: which keys open it, or what Enter does — the owner keeps that (keyboard-first)
```

**Example UI**

```
// add lane                                   j/k move · enter spawn · esc cancel
▸ Claude Code        claude-code      ·2 running
  Codex              codex
  Oh My Pi           omp              ·1 running
```

**Emits** `<ul class="${block}__list">` + `<li class="${block}__row${active}" data-${name}-index="${i}">`.

**Replaces the 8 verbatim `(x+1)%n` / `(x-1+n)%n` cursor handlers**: `acp-harness-view.ts:5159-5168,5496-5512,9963-9972,10052-10061,10174-10183` ·
`harness-ticket-controller.ts:335-346` · `remote-harness-picker.ts:150-157` · `ask-user-question.ts:259-268`.
Also unifies the **three** selection-state conventions in use today (view instance fields, per-`HarnessLane`
fields, plain state objects) and gives every picker the `scrollIntoView` only the model picker has
(`acp-harness-view.ts:12814-12817`).

## 2.4 `InlinePalette` ⚠

```ts
interface InlinePaletteProps<T> { variant: 'slash' | 'mention' | 'hash' | 'verb'; matches: readonly T[]; cursor: number; hint: string; row(item: T): { name: string; hint?: string; desc?: string }; zeroState?: string }
```

**Example UI**

```
↑↓ / ⌃n⌃p select · Enter/Tab insert · Esc dismiss
▸ /resume      <session>     resume a previous session
  /compact                   compact the context window
```
```
inject verb · ↑↓ / ⌃n⌃p select · Tab insert · Esc dismiss
▸ {{#review}}               fan the diff out to reviewer lanes
```

**Emits** one shell for all four: `.acp-harness__slash-palette[data-count][data-palette] > -meta + -row(--selected) > -name + -hint + -desc`.
⚠ Today all four emit the same class with no discriminator, so the mention palette cannot be restyled
without changing `/`, `#` and `{{#`. `data-palette="${variant}"` makes each addressable inside the one
block that owns the sheet. The block's rules are also **declared twice** today
(`acp-harness.css:5604-5700` ≡ `:5815-5911`) — editing the first copy does nothing.

**Replaces 4 identical renderers and 4 identical 30-line key handlers**:
render `harness-lane-chrome.ts:457` (`/`), `acp-harness-view.ts:4473-4490` (`@`), `:4583` (`#`), `:4665` (`{{#`);
keys `:4436-4466`, `:4497-4529`, `:4536-4561`, `:4645-4672`. Only the commit key (`Enter|Tab` vs `Tab`-only)
and the insert callback differ — both become props.

## 2.5 `DiffBlock`

```ts
interface DiffBlockProps { mode: 'paired' | 'unified' | 'raw'; rows: readonly DiffRow[]; path?: string; context?: number; lineCap?: number; prefix: string }
```

**Example UI**

```
paired    12  12     const next = renderTranscriptItem(item, …)
          13      −  current.replaceWith(next);
              13  +  current.replaceChildren(...next.childNodes);
                 ⋯   context omitted
                     … 7 more lines
unified   src/acp/lane-peek.ts
          @@  @@ -412,6 +412,9 @@
           +  export function patchPeekActiveTool(…)
raw       + the raw unified line, sign included
```

**Emits** paired → `.${prefix}__diff-line--add|del|ctx|hunk > -num -num -mark -text` (mark `+` / `−` U+2212 / ` ` / `⋯`);
unified → `.acp-harness__tool-diff-line--${tone} > -mark + -text` (mark `@@` / `·` / `+` / `-`);
raw → `.acp-harness__directive-diff-add|del|ctx`.

**Replaces** `harness-tool-render.ts:608-623,931-953` · `harness-transcript-render.ts:397-419`, built on the
existing prefix-parameterised precedent `diff-render.ts:17-102`. **Resolves the mark inconsistency**:
paired diffs use `−` (U+2212), unified uses `-` (ASCII) for the same meaning today.

---

# Layer 3 — Transcript rows

`TranscriptRow` is the base; one subclass per `item.kind`. Spec 301's `LiveComponent` applies to the four
rows the agent writes into.

![Layer 3 — transcript rows 1/2: base row, AssistantRow, ThoughtRow, UserRow, ToolRow, SubagentCard, PermissionRow, QuestionRow](./images/0302-layer3a-transcript.svg)

## 3.0 `TranscriptRow` (base)

```ts
interface RowProps { item: HarnessTranscriptItem; isNew: boolean; projectDir: string | null; resolveLocalImages: boolean }
```

**Example UI**

```
agent    <body>
tool     <body>
perm     <body>
```

**Emits** `<div class="acp-harness__msg acp-harness__msg--${kind}[--${status}][--enter][--streaming]" data-msg-id>` >
`.acp-harness__msg-label` + `.acp-harness__msg-body` + optional image strip.

Owns: the `--enter` class and its `animationend` release (replacing the rescue at `acp-harness-view.ts:12219-12221`),
and **`data-render-signature` disappears entirely** — deps live on each subclass.

Label vocabulary (`harness-lane-chrome.ts:536-551`), unchanged:
`sys · user · agent · thought · tool · perm · ask · mem · sh · fs · write · mail · html · review · restart`,
plus the in-renderer overrides `usage` and `event`.

## 3.1 `AssistantRow` L

**Props** `{ item, lane, streaming, projectDir, resolveLocalImages }` · **Deps** `[item.markdownHtml, item.replyingToLaneMail, item.resources, item.gitRefs, item.annotations]`

**Example UI**

```
agent  ▰▰▰▱▱
       The reconciler keeps node identity, so a sealed row never repaints.

       REFERENCES   src/acp/list.ts  ·  main@a91f3c2
```

**Emits** `.acp-harness__msg-body--markdown[data-annotatable=1]`, optional
`.acp-harness__lane-mail-provenance`, resource rail, SVG/mermaid fence cards, annotation marks.

**Live contract** — `appendChunk()` wraps `smd.parser_write` into the body node the component owns;
`seal()` drains the parser, calls `parser_end`, caches `item.markdownHtml`, drops `--streaming`, re-syncs deps.
**Replaces** `harness-transcript-render.ts:299-347` + `acp-harness-view.ts:12156-12183` (pre-signature fast path)
+ `:14491-14580` (`sealAssistantStreamingMarkdown`) + `:7637-7651` (`patchReferenceRails`).

## 3.2 `ThoughtRow` L

**Example UI**

```
thought ▰▰▰▰▱ extended
        Considering whether the tail window can slide past a live row…
```

**Emits** label gets `.acp-harness__msg-label--thought` + the `Meter` glyph child; body is a single text node
(`appendData` path). `seal()` must not touch `body.firstChild` identity (spec 114 rev 19).
**Replaces** `harness-transcript-render.ts:287-296` · `acp-harness-view.ts:14456-14477`.

## 3.3 `UserRow` L

**Example UI**

```
user       refactor harness view into reusable components
steer…     also check the scroll anchor
user · voice   open the model picker
```

**Emits** label modifiers `--steer`, `--steer-pending`, `--voice`.
**Replaces** `harness-transcript-render.ts:277-290`.

## 3.4 `ToolRow` L

**Props** the shared `RowProps` (`{ item, … }`, no tool-only field — every caller that holds a `TranscriptRow` may pass the same props, including late image/Git patches and seals) · Generic **Deps** `[statusBucket, kind, subject, command, result, exitCode, sections, diffs, subagents, expandedKey]`, where `expandedKey` is read from `item.subagentExpanded`.
Spec-315 execution rows instead compare `[statusBucket, title, language, cellStatus, durationMs, detached, diffs]`;
both include the image-strip signature and streaming flag. Output and Inspector presentation state are not structural row deps.

**Example UI**

```
tool  ⠙  execute  npm run check                                    1.4s
         exit  0
         ╭────────────────────────────────────────────────────╮
         │ stdout                                             │
         │ > tsc --noEmit                                     │
         ╰────────────────────────────────────────────────────╯
tool  ✓  edit     src/acp/list.ts                     +42 −8    0.3s
```

**Emits** `.acp-harness__tool-head > -glyph(Spinner) + -kind[data-kind] + -subject + -result + -timer`,
then `.acp-harness__tool-output > -section > -label + <pre> -text`, `.acp-harness__tool-exit[data-status]`,
`.acp-harness__tool-diffs` (`DiffBlock`), `.acp-harness__tool-rich--diffstat|--unidiff|--gitstatus`.

**Live contract** — generic `appendChunk()` updates only `.acp-harness__tool-output`; recognized executions update their owning `ExecutionCard`. Render precedence is artifact redaction → subagent card → execution → generic. Diffs and the base row's image strip remain available.
**Replaces** `harness-tool-render.ts:551-673,776-860,862-1060` and `patchStreamingToolBody` `:635-664`
(including its `body.dataset.toolStreamSig` / `subagentLiveSig` dedupe keys — the component's deps do that job).

## 3.4a `ExecutionCard` (spec 315)

**Props** `{ payload: ExecutionPayload, status, startedAt?, endedAt?, hintLabel }`.
Owns the compact summary and stable panel slot, not the panel's lifetime.

**Example UI**

```text
tool  ✓  Python  Inspect records                  Done  200ms runtime  Inspector
          fixture started
```

**Emits** `.acp-execution-card`, `__head`, `__language`, `__title`, `__state`,
`__timer`, `__timing-source`, `__button[data-execution-inspector][aria-haspopup=dialog]`, `__activity`.
Uses the existing `Spinner` and shared tool ticker. A terminal-only replay has no observed timer;
detached running state is static `Background · last reported`, not job tracking.
`setHint()` is the owning component's mutation boundary after row seal. `paintExecutionTiming()`
is exported so the card and `ExecutionDialog` write the same time and provenance.

**Replaces** the generic header/source echo only for validated current OMP code cells.

## 3.4b `ExecutionDialog` (spec 319, replaces the spec 315 inline `ExecutionPanel`)

**Props** `{ open, targetId, payload: ExecutionPayload | null, status, startedAt?, endedAt?, takeFocus, onClose }`.
One `OverlayShell` modal owned by `AcpHarnessView`, mounted once in `.acp-harness__body`. A new
`targetId` resets per-target state (output nodes, Raw mode, scroll); the selected section survives.
It never touches a row, so no row deps, slot or re-seat are involved.

**Example UI**

```text
✓ JavaScript  Recent commits table                              Close · Esc
Status Done   Time 200ms runtime   Exit code 0
1 Code · 7 lines   [2 Output · 8 lines]   3 Activity · 0
                                                          Formatted  Raw
(index)  sha      spec  area
      0  7357cfb   318  computers
1–3 section  j/k scroll  g/G top/bottom  c copy code  r raw/formatted  Esc close
```

Only validated backend table/JSON metadata can replace an unambiguous output span.
Source syntax classes are `acp-execution-dialog__syntax-*`, never global `.hljs-*`.

**Emits** `.acp-harness__execution-overlay[data-state]` > `.acp-execution-dialog__panel[role=dialog][aria-modal=true]`
with `__head`, `__title`, `__summary` (`__fact`), `__tabs[role=tablist]` > `__tab[role=tab]`,
`__section[role=tabpanel]`, `__source` / `__output` / activity `__scroll[role=region]`, `__table`,
`__events`, `__event--current`, `__feedback[role=status]`, `__foot`.
`handleKey()` owns every key while open; Cmd/Ctrl chords and native control/scroll keys return `false`.
Tab/Shift+Tab wrap inside the panel; pointer-pressed buttons retain focus on macOS WebKit.
Output appends preserve selection and follow only from the bottom.
Another overlay opening, hidden tab, lane/reset and disposal close without taking focus.

**Theme hooks** for both components: `--acp-execution-fg` → `--krypton-fg`,
`--acp-execution-accent` → `--krypton-window-accent`. Font, radius, semantic state and syntax colors
use existing `--agent-*` / `--krypton-*` properties. No private palette or unlayered CSS.

**Replaces** no execution/runtime API; this is a new read-only presentation of retained tool data.

## 3.5 `SubagentCard` L

**Example UI**

```
         ● scout-1    explore   reading src/acp/lane-peek.ts   14 tools · 8k tok · 42s
           ↳ Grep · Read · Read
         ✓ scout-2    review    done                            9 tools · 4k tok · 31s
         +2 more
```

**Emits** `.acp-harness__subagents[data-background] > .acp-harness__subagent--${status} > -line > -hint -glyph -name -agent -activity -stats`, `-tools`, `-detail > -label + <pre> -text`, `-more`.
Status glyphs `○ ● ✓ ✗ –`.
**Replaces** `harness-subagents.ts:353-455`, including `morphSubagentCard` — the morph becomes `appendChunk()`.

## 3.6 `PermissionRow`

**Example UI**

```
perm   Bash   git push origin main
       a accept · A all · r reject · R all
perm ✓ accepted · auto (harness bus)
```

**Emits** `.acp-harness__perm`; one row carries the whole pending→accepted/rejected/auto_allowed/failed
lifecycle (spec 107), never a second row.
**Replaces** `harness-transcript-render.ts:952-1018`.

## 3.7 `QuestionRow`

**Example UI**

```
ask    Which reconciler should phase 3 use?                        1/2
       1  keyed reconcile      node identity preserved
       2  morph                diff against a fresh tree
       z  Other
       1–9 pick · Enter · x skip · z other
```

**Emits** `.acp-harness__question-row > -glyph -decision -subject -pos`, `-detail`,
`-options > -option(--focus|--on) > -key -label -desc`, `-actions`.
**Replaces** `harness-transcript-render.ts:1020-1137` + the cursor handler at `ask-user-question.ts:259-268`
(now `ListPicker`).

![Layer 3 — transcript rows 2/2: fs rows, InterLaneRow, DocCardRow, UsageRow, SystemRow, ImageStrip, Transcript](./images/0302-layer3b-transcript.svg)

## 3.8 `FsActivityRow` · 3.9 `FsWriteReviewRow` · 3.10 `ProviderErrorRow`

**Example UI**

```
fs     read   src/acp/list.ts
fs     write  src/ui/component.ts                                   ✗ EACCES
write  src/ui/list.ts    +18 −0    [ apply ]  [ reject ]
agent  ⚠ rate_limited · 429 — retry in 32s
```

**Emits** `.acp-harness__fs-activity(--err)`, `.acp-harness__fs-review(--resolved)` (uses `DiffBlock`),
`.acp-harness__provider-error`.
**Replaces** `harness-transcript-render.ts:827-852,854-907,909-950`.

## 3.11 `InterLaneRow`

**Example UI**

```
mail ←  codex-1          please check the deps tuple in ToolRow
mail →  grok-1  done     ack — looks right
```

**Emits** wrapper modifiers `--mail-in|--mail-out|--mail-done`; body `.acp-harness__lane-mail-*`.
**Replaces** `harness-transcript-render.ts:371-377,640-700`.

## 3.12 `DocCardRow` (artifact + review)

**Example UI** — see `Card` (2.1). One component, two `kind` values; today they are two near-identical
builders sharing the same CSS class.
**Replaces** `harness-tool-render.ts:691-727,729-770` + wrapper logic `harness-transcript-render.ts:388-398`.

## 3.13 `UsageRow`

**Example UI**

```
usage  2026-10-15                                                 14 turns
       Cache hit  93%   ▓▓▓▓▓▓▓▓▓▓▓▒▒▒░░
       Model              Turns   Input    Output
       claude-sonnet-4-5     11   182.0k    12.4k
       gpt-5-codex            3    24.1k     3.0k
       $0.4412 USD
```

**Emits** `.acp-harness__usage-card > -head > -date + -turns`, `-cache` (`Meter`), `-metrics` (`StatList` `dl`),
`-models`, `-foot`. `contain: content`, no `animation:` (pinned by `harness-transcript-render.test.ts:6-31`).
**Replaces** `harness-transcript-render.ts:125-249`.

## 3.14 `SystemRow` + `HiddenRowsIndicator`

**Example UI**

```
sys    lane restarted — session 4f2a9c
sys    ↑ 142 earlier rows hidden — Ctrl+H show 60 more
event  reviewer-1 finished round 2
```

**Emits** `.acp-harness__msg--system`, indicator variant adds `--hidden-indicator`,
event variant adds `--harness-event` + `.acp-harness__harness-event-body`.
**Replaces** `harness-transcript-render.ts:383-387` · `acp-harness-view.ts:12120-12129`.

## 3.15 `ImageStrip` · 3.16 `ResourceRail`

**Example UI**

```
        [▣][▣][▣]   3 images
        REFERENCES   docs/0301-harness-ui-components.md · src/ui/list.ts
```

**Emits** `.acp-harness__msg-images > -image[data-image-id]`; `.acp-harness__resources > -item[data-response-resource]`.
Late Git/thumbnail state patches **only this component** — spec 301's structural replacement for
`patchReferenceRails`.
**Replaces** `harness-transcript-render.ts:1139-1203,700-826` · `message-resource-thumb.ts`.

## 3.17 `Transcript` (list container)

```ts
interface TranscriptProps { lane: HarnessLane; window: number; projectDir: string | null; stickToBottom: boolean }
```

Owns `reconcile()` over the tail window, scroll-anchor capture/restore, the `ResizeObserver`, sticky-bottom
and the smooth-follow glide. Disposing a row component tears down its streaming parser — the structural
replacement for the spec-117 `console.warn` guard (`acp-harness-view.ts:12136-12145`).
**Replaces** `acp-harness-view.ts:12092-12252` + the scroll block `:15732-16104`.

---

# Layer 4 — Lane chrome

![Layer 4 — lane chrome: LaneShell, LaneHead, LaneSymbol, LaneStats, RailEntry, LaneRail](./images/0302-layer4-lane-chrome.svg)

| # | Component | Props | Example UI | Replaces |
|---|---|---|---|---|
| 4.1 | `LaneShell` | `{ lane, active, zen }` | lane `<section>` holding head · stats · body · rail slots | `acp-harness-view.ts:12945-12994`. **Never rebuilt** → both halves of the `prevScrollTop` dance (capture `:12908-12915`, write-back `:13001-13006`) are deleted — in **phase 4**, the phase that lands this component, never earlier |
| 4.2 | `LaneHead` | `{ lane, active, mcp, metrics, inboxDepth, pendingPeers, isOrchestrator, runs }` | `⠙ claude-1 busy  #handoff · 0:42  ◆ orch  sonnet-4-6  mcp ✓ 14  12.4% 843M  ⚒ Edit src/acp/lane-peek.ts` — spec 343: running built-ins lead the chip strip (two at most, then `+N`) | `harness-lane-chrome.ts:86-130` + the per-head `innerHTML` on the 2 s metrics tick (`acp-harness-view.ts:13550`) |
| 4.3 | `LaneSymbol` | `{ status }` | busy `⠋` · perm/peer/error/starting → icon · idle → empty | `harness-lane-chrome.ts:612-652`. Status vocabulary unchanged: `starting · idle · busy · action required · awaiting peer · error · stopped` |
| 4.4 | `LaneStats` | `{ lane, projectDir }` | `sess 4f2a9c · krypton · ⌁128.4k/200.0k (64%) · cache 93% · $0.4412 USD · ⚒37 · ≡412` | `harness-lane-chrome.ts:464-537` (`StatList` inline) |
| 4.5 | `RailEntry` | `{ lane, active, peerHint, directive, reviewCount, runs }` | `● [logo] claude-1 ⇆ 37 128.4k` / `impl  harness UI refactor · next send`; spec 343: a running built-in replaces the status word (`#e2e run login +1`) or the directive title | `acp-harness-view.ts:13024-13141` |
| 4.6 | `LaneRail` | `{ lanes, activeId }` | zen-mode left rail, `reconcile` over `RailEntry` | `acp-harness-view.ts:12930-12943,12660-12667` |

---

# Layer 5 — Right rail

![Layer 5 — right rail: PeekCard, ReviewLoopRows, HeatPanel, ThoughtCard, QueueCard, PlanPanel, TicketDock, AnnotationRail](./images/0302-layer5-right-rail.svg)

| # | Component | Example UI | Replaces |
|---|---|---|---|
| 5.1 | `PeekCard` | `codex-1   awaiting peer · locked   5m+` <br> `▸ approve Bash` · `git push origin main` <br> `tool  Edit · lane-peek.ts` <br> `plan  4/9  wire composer meta segments` <br> `sonnet-4-6  128.4k/200.0k  92% 1.4G  mcp 14` | `lane-peek.ts:349-606` + `patchPeekActiveTool` `:363-390` |
| 5.2 | `ReviewLoopRows` | `review  pass 2/4 · reviewing` <br> `replies codex PASS · salty pending` <br> `rounds  3 → 0` | `lane-peek.ts:455-497` + `patchPeekReviewLoop` |
| 5.3 | `HeatPanel` | `heat  [tools][5m] ·  active ████████  peek ███░░░░░  0.62` | `acp-harness-view.ts:12427-12545`. **Fixes the clearest listener-leak site** — today heat controls re-attach on every mount even when the card is reused |
| 5.4 | `ThoughtCard` L | `claude-1   thinking` <br> `the tail window can slide past a live row…` | `lane-peek.ts:608-642` + `patchLaneThoughtCard` |
| 5.5 | `QueueCard` | `omp-1                        ⏎ QUEUE 3 · HELD` <br> `▸1  rerun the type check against the whole` <br> `    workspace and report what it covers` <br> `    →codex-2 +1   img×2` <br> `2   open the model picker` <br> `#unqueue · #queue clear` | `acp-harness-view.ts:11982-12026` |
| 5.6 | `PlanPanel` | `plan 4/9` <br> `✓ extract kernel` · `▸ wire composer meta segments` · `· delete signature` | `acp-harness-view.ts:14668-14726` |
| 5.7 | `TicketDock` | `active ticket` <br> `Harness UI refactor                 ›` <br> `open  KR-301` <br> `GitHub  wk/krypton  #301 · open` <br> `Worker  codex-1` <br> `ISSUE ACTIONS  run in codex-1 · idle` <br> `[Analyze ✓ 10-27] [Fix here ✓ PR] [Handle]` (spec 342; `DockActionButton` §1.10) | `harness-ticket-controller.ts:603-676` |
| 5.8 | `AnnotationRail` | `ANNOTATED  3 · 2 unsent              [ send 2 ]` <br> `deps tuple needs the lane arg            [ del ]` | `transcript-annotation.ts:329-370` |

---

# Layer 6 — Composer

![Layer 6 — composer: Composer, ComposerMeta, DraftLine, StagingStrip, PeerStrip, DictationControl, LiveVoiceStrip, DecisionComposer](./images/0302-layer6-composer.svg)

| # | Component | Example UI | Replaces |
|---|---|---|---|
| 6.1 | `Composer` | root; owns `--command` / `--memory` / `--dictating` modifiers and slot order | `acp-harness-view.ts:13190-13296`. **Deletes the 1 Hz full `innerHTML` rebuild** (`:13409`) — only `ComposerMeta` ticks |
| 6.2 | `ComposerMeta` | `reviewing · 2:14 · 3 queued      auto-edit   directive 0301-impl   ⟨branch icon⟩ main        ? help` (the branch mark is the `krypton-icon-branch` symbol, geometry shared with the workspace footer — `src/chrome-icons.ts`) | `harness-composer-meta.ts:48-68` + `composerStatusChip` `:13410-13460` (`Chip` + `StatList`) |
| 6.3 | `DraftLine` | `claude-1  ⠋  convert the UI into reusable comp_onents` (underline caret over the next cell, ghost text inline) | `acp-harness-view.ts:13246-13293,15417-15420` |
| 6.4 | `StagingStrip` | `[▣ screenshot.png  x] [▣ diagram.png  x]   2 images · Esc to clear` | `acp-harness-view.ts:13228-13245` |
| 6.5 | `PeerStrip` | `⇆ awaiting codex · 5m+ · #cancel drops pending lane-mail wait` / `▼3 lane mails queued` | `lane-peek.ts:731-779` |
| 6.6 | `DictationControl` | `[● REC th  ⌘D]` (phases `MIC · MIC en · REC th · FINALIZING…`) | `harness-dictation-controller.ts:37-82` |
| 6.7 | `LiveVoiceStrip` | `LIVE  muted  alloy  ░░░░░░░░ ██░░░░░░  you: refactor the composer   ⌘⇧L stop · hold left ⌥ to talk` | `harness-live-voice-controller.ts:461-499` |
| 6.8 | `DecisionComposer` | `perm      a accept · A all · r reject · R all` | `acp-harness-view.ts:13299-13313` |

`LiveVoiceStrip` keeps `LiveVoiceSessionProps.muted: boolean`. The microphone starts muted;
the muted hint is `⌘⇧L stop · hold left ⌥ to talk`, changing to
`⌘⇧L stop · release left ⌥ to mute` while bare Left Option is held. Release or focus
loss closes the microphone without stopping playback/session; see
[spec 314](./0314-harness-live-push-to-talk.md) for cancellation and safety behavior.

---

# Layer 7 — Overlays

Each is `OverlayShell` + one body. The six pickers are additionally `ListPicker`; nothing below keeps its own
cursor math, its own shell, or its own empty state.

![Layer 7 — overlays 1/2: LanePicker, DirectivePicker, ModelPicker, SessionPicker, TicketPicker, RemotePicker, TriageOverlay, ReviewMatrixOverlay](./images/0302-layer7a-overlays.svg)

![Historical Layer 7 overlay sheet 2/2 — TimelineCapture illustration retired by spec 0316; remaining examples include ReviewPriorityOverlay, OrchestratorConsole, MemoryDrawer, HelpOverlay, MetricsOverlay, ImageViewer, ReviewThreadDialog](./images/0302-layer7b-overlays.svg)

| # | Component | Composition | Example UI (head line) | Replaces |
|---|---|---|---|---|
| 7.1 | `LanePicker` | Shell + ListPicker | `// add lane · directive: 0301-impl` | `acp-harness-view.ts:12669-12712` |
| 7.2 | `DirectivePicker` | Shell + ListPicker + preview pane | `// directive · claude-1` | `:12715-12777` |
| 7.3 | `ModelPicker` | Shell + ListPicker | `// model · claude-1` | `:12779-12818` |
| 7.4 | `SessionPicker` | Shell + ListPicker, 4 phases (`backend · loading · error · list`) | `// claude-code sessions` | `:12820-12894` |
| 7.5 | `TicketPicker` | Shell + TabStrip + filter + ListPicker + ActionButton row | `local tickets + GitHub   target: codex-1 · idle` | `harness-ticket-controller.ts:678-783` |
| 7.6 | `RemotePicker` | Shell + ListPicker | `remote harness` | `remote-harness-picker.ts:69-170` |
| 7.7 | `TriageOverlay` | Shell + Card(judgement) + StatList + KeyHintBar | `Judgement queue    2 / 5` | `attention-overlay.ts:59-198` |
| 7.8 | `ReviewMatrixOverlay` | Shell + TabStrip + table + KeyHintBar | `Review quality matrix` | `acp-harness-view.ts:5297-5480`. **Deletes the inline-style findings block** (`:5434-5480`, no classes today) |
| 7.9 | `ReviewPriorityOverlay` | Shell + TabStrip + grouped rows + KeyHintBar | `Review priority` | `review-priority-overlay.ts:35-128` |
| 7.10 | `OrchestratorConsole` | Shell + seat card grid + feed + dispatch form | `orchestrator · seat codex-1` | `acp-harness-view.ts:5741-5999`. **Deletes the per-keystroke full `innerHTML`** (`:5806` rebuilt at `:6128-6134,6159-6165`) |
| 7.11 | `MemoryDrawer` | Shell + ListPicker | `Memory` | `acp-harness-view.ts:13143-13188` |
| 7.12 | `HelpOverlay` | Shell + KeyHintBar grid | `// help` | `acp-harness-view.ts:13625+` |
| 7.13 | `MetricsOverlay` | Shell + per-lane `Meter` rows (process tree) | `Process  PID  CPU  Mem` | `acp-harness-view.ts:13573-13612` + `harness-lane-chrome.ts:146-303` |
| 7.14 | `ImageViewer` | Shell (full-bleed) | `image viewer · n/p next · =/- zoom · 0 fit · 1 100% · o open · Esc close` | `harness-image-viewer.ts:53-71+` |
| 7.15 | **Retired — TimelineCapture** | Removed by [0316](./0316-llm-managed-timeline.md) | No runtime/catalog form, registration, or form styles | Historical number reserved; no replacement overlay |
| 7.16 | `ReviewThreadDialog` | Shell + preview `<pre>` + ActionButton row | `Start Review · Enter` / `Cancel · Esc` | `acp-harness-view.ts:3110-3170` |
| 7.17 | `HandoffPicker` | Shell + ListPicker + preview | `// handoff · <lane>` | `acp-harness-view.ts` `#resume list` branch (replaces `formatHandoffList`, `xenon-push.ts:347-363`) |

---

# Component tree

```
HarnessView
├─ LaneRail ──────────── reconcile → RailEntry[] ── Chip, Spinner
├─ LaneShell (active)
│  ├─ LaneHead ───────── LaneSymbol(Spinner), Chip[]
│  ├─ LaneStats ──────── StatList(inline)
│  ├─ Transcript ─────── reconcile → TranscriptRow[]
│  │                     ├─ AssistantRow L ── ResourceRail, ImageStrip, Card(fence)
│  │                     ├─ ThoughtRow L ──── Meter(glyph)
│  │                     ├─ UserRow L
│  │                     ├─ ToolRow L ─────── Spinner, DiffBlock, Meter(diffstat), SubagentCard L, ExecutionCard
│  │                     ├─ PermissionRow · QuestionRow(ListPicker) · FsActivityRow
│  │                     ├─ FsWriteReviewRow(DiffBlock) · ProviderErrorRow · InterLaneRow
│  │                     ├─ DocCardRow(Card) · UsageRow(Meter, StatList)
│  │                     └─ SystemRow / HiddenRowsIndicator
│  └─ RightRail ──────── LayoutHost slots `rail.top` / `rail.bottom` / `dock.right`
│                        PlanPanel · PeekCard(ReviewLoopRows, HeatPanel) · ThoughtCard L
│                        QueueCard · TicketDock · AnnotationRail
├─ ExecutionDialog ───── view-owned OverlayShell modal (spec 319); never row-owned
├─ Composer ──────────── ComposerMeta(Chip, StatList) · DraftLine · StagingStrip
│                        PeerStrip · InlinePalette ×4 · DictationControl · LiveVoiceStrip
└─ Overlays ──────────── current registry: 20 components; no TimelineCapture
```

# Totals

Current registry counts come from `HARNESS_COMPONENTS` in `src/acp/components/registry.ts`.
The registry has **79 component definitions**; `LayoutHost` is a separate layout entry, so
the inventory total is **80**. The historical numbered catalog predates later additions:
the transcript registry also includes `GenuiCard`, `DirectiveDiffRow` and `FollowUpRail` (spec 323);
overlays include `BackgroundTasks`, `ExecutionDialog`, `GenuiPanel`, and `GenuiCatalog`. The composer's
`AssistStrip` (spec 306) was removed on 2026-10-23 with the `next-prompt` task.
`TimelineCapture` is absent. Historical cutover-site counts below are not a new removal tally.

| Layer | Components | Call sites deleted |
|---|---|---|
| 0 — layout | 1 | 4 hardcoded `*SlotEl` fields + their CSS pinning |
| 1 — leaf | 9 | ~75 |
| 2 — composite | 5 | ~45 (incl. 8 cursor handlers, 4 palette handlers, 12 overlay shells) |
| 3 — transcript | 22 | Original cutover plus ExecutionCard (spec 315), GenuiCard, DirectiveDiffRow, and FollowUpRail |
| 4 — lane chrome | 6 | `renderDashboard`, `renderActiveLaneChrome`, `refreshMetricsRender`, `renderRailEntry`, `refreshZenRail` |
| 5 — right rail | 8 | 8 builders + 3 `patch*` functions |
| 6 — composer | 9 | Original composer cutover; AssistStrip came and went (spec 306) |
| 7 — overlays | 20 | Current registry; historical 7.15 retired, later additions (incl. `ExecutionDialog`, spec 319) retained |
| **Total** | **80 (79 registered + LayoutHost)** | **Historical cutover counts remain historical; no Timeline capture implementation or style owner remains** |

# Packaging, style ownership, and theming

**One component = one directory.** Everything it needs ships together, so adding it is creating a folder and
removing it is deleting one:

```
src/acp/components/tool-row/
├── index.ts        // import './tool-row.css'; the class; export const def: ComponentDef
├── tool-row.css    // the ONLY file allowed to declare .acp-harness__tool*
└── tool-row.test.ts
```

Registration is one import plus one array entry in `src/acp/components/registry.ts`. Nothing else in the
repo names the component — not a CSS manifest, not a layout constant, not a render method.

**One block, three layers, three token levels.** The sheet declares its block inside
`@layer krypton.component`, its light-mode rules inside `@layer krypton.scheme`, and exposes every tunable
as a custom property with a fallback chain:

```css
/* tool-row.css */
@layer krypton.component {
  .acp-harness__tool {
    --tool-head-fg: var(--acp-tool-head-fg,  /* 3 · theme / instance override — spec 303 */
                    var(--agent-text,         /* 2 · harness token, derived from the theme */
                        #d8e8d8));            /* 1 · literal fallback                      */
    --tool-output-max-h: 320px;
  }
  .acp-harness__tool-output { max-height: var(--tool-output-max-h); }
}
@layer krypton.scheme {
  html[data-theme-scheme='light'] .acp-harness__tool { … }   /* today: theme-scheme.css:139+ */
}
```

Level 2 is already live — `theme.ts:456-490` derives 32 `--agent-*` tokens from the active theme and
`setCssProperties` (`:609-619`) writes all 151 properties onto `document.documentElement`, so `set_theme` and
**Reload Config** already repaint components with no restart. Level 3 is the hook; who may set it is
[spec 303](./0303-themeable-component-tokens.md).

`styles-ownership.test.ts` enforces both rules: a sheet declares selectors only for its own block, and only
inside a `krypton.*` layer.

Three ⚠ collisions must be resolved during the split, or isolation is a lie:

| ⚠ | Today | After |
|---|---|---|
| `Card` / `DocCardRow` | review card paints into `acp-harness__artifact-head` (`harness-tool-render.ts:729-770`) | review card gets `acp-harness__review-card` + its own sheet |
| `InlinePalette` ×4 | one class, no discriminator; its rules sit in a byte-identical 99-line span declared twice (`acp-harness.css:5601-5699` ≡ `:5812-5910`) | one block + `data-palette`; duplicate deleted |
| `Caret` ×3 | shared class with no owner; attention overlay forked it as `acp-triage__caret` | one `Caret` component, underline only; fork deleted |

The same duplicated span also re-declares `.acp-harness__fs-activity` (`:5659` / `:5870`); `diff` over
`:5601-5699` vs `:5812-5910` reports no differences at all. Also deleted during the split:
the three CSS files whose own first comment says they mirror another shell (`review-quality.css:1-5`,
`review-priority.css:1-6`, `orchestrator-console.css:3-4`) once `OverlayShell` owns that markup.

# Explicitly not components

- **`md.parse` / `smd` markdown output** — stays raw HTML inside the body node a row component owns.
  Wrapping parsed markdown in components would re-parse per update, which is the quadratic cost spec 114 removed.
- **`harness-format.ts` helpers** (`esc`, `formatCount`, `formatCpu`, `formatElapsed`, …) — pure functions, not components.
- **Workspace footer gauges** (`renderTriageGaugeEl`, `renderReviewGaugeEl`) — these publish to the global
  footer bus and render nothing in the harness (`acp-harness-view.ts:5097-5121,5277-5295`).
- **`flashChip`** — not a toast system; it writes into `ComposerMeta`, so it stays a method.
- **Keybinding tables and mode routing** — `input-router.ts` and `ACP_HARNESS_LEADER_KEYS` are untouched.
  Components render selection state; they never decide which key opens them (`CLAUDE.md` constraint 1).
