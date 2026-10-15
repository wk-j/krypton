# 301. Harness UI Components

> Status: Draft
> Date: 2026-10-15
> Scope: frontend only — `src/acp/` render paths + a new generic `src/ui/` kernel. No Rust, no protocol, no visual change.
> Companion: [302 — Harness Component Catalog](./0302-harness-component-catalog.md) lists every component with its props, example UI, emitted markup, and the call sites it deletes.

## Problem

Every harness feature that paints must hand-wire itself into five unrelated mechanisms: the 20-field
`transcriptRenderSignature()` string, an out-of-band `patch*` function, the wrapper-class sync, the seal
path, and the "no `infinite` animation on a static row" rule. Nothing type-checks that wiring, so a
feature that forgets one produces a repaint, a flicker, a stale card, or a scroll jump.

The evidence that this is structural, not incidental:

- `docs/0114-acp-harness-streaming-perf.md` carries **24 numbered revisions**, every one a repaint or
  scroll regression.
- **14 of the last 131 commits (≈11%)** are harness repaint fixes (`.git/logs/HEAD`, 2026-09-09→10-15):
  `drop streaming class when sealing assistant reply`, `preserve thought DOM when streaming ends`,
  `avoid dashboard remount on ticket reload`, `patch only the REFERENCES rail on Git refresh`,
  `skip composer rebuild on a plain transcript click`, `rebuild Review Board cards when hint labels change`, …
- `CLAUDE.md:82-86` dedicates architecture constraint 10 to it, stating verbatim "*this regression
  recurred several times*".
- `acp-harness-view.ts:825-859` ships `installLaneBodyScrollTracer()`, a **dev-build monkey-patch of
  `Element.prototype.scrollTop`** that `console.trace`s any writer leaving the lane body short of bottom —
  a prototype trap shipped to hunt the view's own repaint bug (issue #17, writer never identified).

Underneath: `render()` (`acp-harness-view.ts:11822`) is **synchronous with 97 call sites** and begins with
`dashboardEl.innerHTML = ''` (`:12917`), which is why 13 event cases carry a hand-set `needsRender = false`
(`:8077-8275`) and why `renderDashboard` must detach/reattach the lane body and write `prevScrollTop` back
by hand (`:12896-12916`). There is no component boundary anywhere: 58 `innerHTML =` sites, ~25 render
surfaces, three rendering idioms (HTML strings, `createElement`, ViewModel + `createElement`), and three
selection-state conventions coexist.

## Solution

Add a ~260-line generic component kernel at `src/ui/` — `Component` (own a node, update in place, dispose),
`reconcile()` (one keyed list diff), `RenderScheduler` (region invalidation), `el()` (typed element
builder) — then convert the harness surfaces to components in five phases.

Two mechanisms replace the hand-maintained scar tissue:

1. **Props equality replaces the signature string.** A component's default change test is a shallow
   compare of its own props object; components reading a mutable payload override a local `deps()` tuple
   sitting next to the `paint()` it guards. `transcriptRenderSignature()` (130 lines, 1,000 lines away
   from the renderer it mirrors) is deleted.
2. **`LiveComponent` makes the seal a single method.** While `live`, a row refuses structural repaint and
   accepts only `appendChunk()`. `seal()` is the one place that flips live→static, drops
   `acp-harness__msg--streaming`, and re-syncs deps. Constraint 10 becomes unforgettable instead of
   documented.

## Research

**Reference equality already works better than the signature.** `mergeToolPayloadForUpdate()`
(`harness-tool-retention.ts:140-159`) returns a **fresh object** per update but **preserves array identity**
for `sections`/`diffs` when the update carried no output (`:155-156`). So a 10-element identity tuple
`[statusBucket, kind, subject, command, result, exitCode, sections, diffs, subagents, expandedKey]` is both
*cheaper* (10 `Object.is`) and *more accurate* than today's string, which builds ~0.5–1.5 KB per tool row
per pass via eight `.map().join()` calls (`harness-transcript-render.ts:472-487`).

**Scroll damage is caused by container wipes, not by bad save/restore.** `docs/0095` states it directly:
"*A render path that calls `innerHTML = ''` on a container holding scrollable state is hostile to scroll
preservation, no matter how careful the save/restore code is.*" A `LaneShell` component is constructed once
and updated in place, so the body node is never detached — the `prevScrollTop` dance at `:12896-12916` and
the 2 s "transcript yanks itself back" symptom disappear by construction rather than by rescue code.

**The duplication is already admitted in comments.** `review-quality.css:1-5` "Mirrors the attention-triage
overlay shell"; `review-priority.css:1-6` "Mirrors the review-quality overlay shell";
`orchestrator-console.css:1-5` "Mirrors the harness overlay shell"; `acp-harness.css:3555,3566,3582,3601`
"Mirrors `.acp-harness__tool-head`" ×4. `acp-harness.css` contains literally duplicated rule blocks
(`.acp-harness__slash-palette` at `:5604` **and** `:5815`; `.acp-harness__fs-activity` at `:5660` **and** `:5871`).

**Alternatives ruled out:**

- **morphdom / idiomorph** — diffs a freshly built tree against the live one. The invariant that keeps
  breaking is "*this row is live, do not touch it*", which morphing expresses only as per-node opt-out
  attributes and heuristics. We need that exemption **declared by the component**, not inferred.
- **lit-html** — would work for the static surfaces, but assistant streaming writes into a **specific body
  node** held by a per-lane parser (`lane.streamingMarkdownParser/Body/ItemId`, spec 117). lit-html owns
  its DOM between parts and owns its own update timing; we need the node handle.
- **Bigger extraction instead of components** — already tried twice. Spec 204 moved ten helper modules out
  (16,020 → 12,032 lines) and spec 275 extracted three controllers (16,665 → 15,045). The file is back at
  **16,377** lines because neither touched the render contract: `HarnessViewHost` still exposes a bare
  `render(): void` (`harness-view-host.ts`), so every controller's only vocabulary is "repaint everything".

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | No UI framework by deliberate decision. `IListRenderer<T, TTemplateData>` = `{ templateId, renderTemplate(container), renderElement(element, index, templateData), disposeElement?, disposeTemplate }` (`src/vs/base/browser/ui/list/list.ts:26-32`), plus `DisposableStore` for listener lifetime. | Template built once, data bound per element — exactly the split we lack. Adopted. |
| React | Keyed reconciliation + props equality (`memo`, `shouldComponentUpdate`). | Idea adopted (key + props compare), VDOM rejected. |
| lit-html | Tagged templates cached as `TemplateResult`; only changed bindings ("parts") are written. | Closest to our string-builder style; rejected for node ownership (see Research). |
| morphdom / idiomorph | Morph live DOM toward a new tree, preserving focus/scroll/CSS state. | Rejected: live-row exemption must be declared, not heuristic. |
| Zed | GPUI immediate mode — re-derives the frame from state every paint. | Not transferable to DOM; confirms "state → view" as the direction of travel. |
| Krypton itself | `src/acp/diff-render.ts:81-102` already parameterises its row builder by class prefix — the one existing reuse precedent. | Generalised by this spec. |

**Krypton delta** — we match VS Code (no framework, explicit disposal, template reuse) and keep its
*rejection* of virtualization complexity: the 300-row cap + 60-row tail window (spec 103) stays, so the
kernel needs `reconcile()` but no viewport engine. We diverge from every framework on one point: a
component may declare itself **live**, and the reconciler is then forbidden from repainting it. No
mainstream library offers that as a first-class contract; it is the single invariant this codebase keeps
breaking.

## Affected Files

| File | Change |
|------|--------|
| `src/ui/component.ts` *(new, ~90)* | `Component<P>`, `LiveComponent<P>`, shallow/deps equality, `DisposableBag`. |
| `src/ui/list.ts` *(new, ~70)* | `reconcile(container, items, spec)` — keyed, order-preserving, live-aware. |
| `src/ui/scheduler.ts` *(new, ~60)* | `RenderScheduler<R>`: `invalidate(region)`, `invalidateAll()`, `flushSync()`. |
| `src/ui/dom.ts` *(new, ~40)* | `el()`, `frag()`, `classes()`. No template-literal engine. |
| `src/ui/layout.ts` *(new, ~70)* | `LayoutHost` + `Slot`: named placement containers and the declarative `HarnessLayout` table that says which slot each panel mounts into, and in what order. |
| `src/acp/components/<name>/` *(new, ~70 directories)* | One self-contained component each: `index.ts` (class + `ComponentDef`, imports its own CSS), `<name>.css` (its block + its `krypton.scheme` overrides), `<name>.test.ts`. Covers the 12 primitives, the 18 transcript rows, lane chrome, right rail, composer parts and overlays. |
| `src/acp/components/registry.ts` *(new)* | `HARNESS_COMPONENTS` — one import + one array entry per component. |
| `src/acp/harness-transcript-render.ts` | `renderTranscriptItem` → per-kind components; **`transcriptRenderSignature` deleted**. |
| `src/acp/acp-harness-view.ts` | `render()`/`renderDashboard()`/`renderActiveTranscript()`/`renderComposer()`/5 pickers/4 palettes replaced by component ownership + `invalidate()`. The 8 copied cursor handlers and 4 copied palette handlers are deleted. |
| `src/acp/harness-view-host.ts` | `render(): void` → `invalidate(region: HarnessRegion): void`. |
| `src/acp/harness-tool-render.ts`, `lane-peek.ts`, `harness-lane-chrome.ts`, `attention-overlay.ts`, `review-priority-overlay.ts`, `harness-ticket-controller.ts`, `remote-harness-picker.ts` | String builders → components; `patch*` functions become component methods. |
| `src/styles/acp-harness.css` + 4 harness CSS files | 7,101 lines / 988 `.acp-harness` selectors redistributed into the component directories; the two duplicated rule blocks (`:5604-5699` ≡ `:5815-5910`) and the three "Mirrors …" shells deleted. |
| `src/styles/index.css` | Gains the `@layer krypton.base, krypton.component, krypton.scheme, krypton.theme;` declaration; **loses** harness `@import` lines (component sheets now load from their own module). `theme-scheme.css` stays last. |
| `src/styles/theme-scheme.css` | Its 54 harness selectors move into the owning components' `krypton.scheme` layer; non-harness rules unchanged. |
| `src/acp/components/styles-ownership.test.ts` *(new)* | A component sheet may only declare selectors for its own block, and only inside a `krypton.*` layer. |
| `src/acp/acp-harness-view.test.ts` and 5 sibling tests | Source-text regex assertions re-expressed as DOM behaviour tests (see Testing). |

## Design

### Data Structures

```ts
// src/ui/component.ts
export abstract class Component<P> {
  readonly el: HTMLElement;
  private deps: readonly unknown[] | null = null;
  protected readonly bag = new DisposableBag();   // listeners, timers, observers

  update(next: P): void {
    const d = this.readDeps(next);
    if (this.deps !== null && sameDeps(this.deps, d)) return;   // ← the whole diff
    this.deps = d;
    this.paint(next);
  }
  /** Default: shallow values of `next`. Override only for mutable payloads. */
  protected readDeps(next: P): readonly unknown[] { return Object.values(next as object); }
  protected abstract paint(next: P): void;
  dispose(): void { this.bag.dispose(); }
}

/** A row the agent is still writing into. */
export abstract class LiveComponent<P> extends Component<P> {
  private live = true;
  update(next: P): void { if (this.live) this.appendChunk(next); else super.update(next); }
  protected abstract appendChunk(next: P): void;
  protected abstract onSeal(): void;
  /** The ONLY live→static transition. Drops the streaming class and re-syncs deps. */
  seal(next: P): void {
    if (!this.live) return;
    this.live = false;
    this.el.classList.remove('acp-harness__msg--streaming');
    this.onSeal();
    this.resync(next);              // store deps WITHOUT painting
  }
}
```

```ts
// src/ui/list.ts — the generalised transcript diff loop
export interface ListSpec<T, C extends Component<unknown>> {
  key(item: T): string;
  create(item: T): C;
  update(cmp: C, item: T): void;
}
export function reconcile<T, C extends Component<unknown>>(
  container: HTMLElement, items: readonly T[], spec: ListSpec<T, C>,
): void;
```

`reconcile` keeps today's exact semantics (`acp-harness-view.ts:12187-12245`): pointer-compare before
`insertBefore` so an in-place node never moves (spec 103 rev 2), reuse-and-patch rather than
`replaceWith` (spec 94), and `dispose()` + remove for keys that fell out of the window.

```ts
// src/ui/scheduler.ts
export class RenderScheduler<R extends string> {
  constructor(order: readonly R[], commit: (region: R) => void);
  invalidate(region: R): void;   // coalesced into one rAF, committed in `order`
  invalidateAll(): void;
  flushSync(): void;             // same-frame commit for keystroke paths
}
```

Harness regions: `'rail' | 'laneChrome' | 'transcript' | 'rightRail' | 'composer' | 'overlay'`.

Scheduler **regions** say *when* a surface repaints. They are not placement — *where* a component lives
is the `LayoutHost` below, whose unit is a **slot** (the word already in the DOM: `data-slot="peek"`).

### Layout — where a component lives

Today a panel's position is nailed down in three unrelated places, so moving one is a three-file edit
with no compiler help:

1. **Order** = `appendChild` order in `buildDOM` (`acp-harness-view.ts:6467-6490`: plan, peek, thought, queue).
2. **Position** = CSS (`acp-harness.css:1103-1106` `position:absolute; top:36px; right:12px`, `:1119-1122` fixed `width:320px`, `:1145-1148` `margin-top:auto` to pin the queue).
3. **Identity** = four private element fields (`planSlotEl`, `peekSlotEl`, `thoughtSlotEl`, `queueSlotEl`), each renderer writing into its own field by name.

Components already expose exactly what a container needs — `el` and `dispose()` — so placement becomes a table:

```ts
// src/ui/layout.ts
export interface Slot { readonly el: HTMLElement; mount(id: string, c: Component<unknown>, order: number): void; unmount(id: string): void }
export class LayoutHost<S extends string> {
  constructor(slots: Readonly<Record<S, HTMLElement>>);
  slot(id: S): Slot;
  apply(layout: Readonly<Record<string, { slot: S; order: number }>>): void;
}
```

```ts
// src/acp/harness-layout.ts
export type HarnessSlot = 'lane.head' | 'lane.understats' | 'rail.top' | 'rail.bottom' | 'dock.right' | 'composer.above' | 'composer.below';
export const HARNESS_LAYOUT_DEFAULT = {
  plan:    { slot: 'rail.top',      order: 10 },
  peek:    { slot: 'rail.top',      order: 20 },
  thought: { slot: 'rail.top',      order: 30 },
  queue:   { slot: 'rail.bottom',   order: 10 },
  ticket:  { slot: 'dock.right',    order: 10 },
  peerStrip:  { slot: 'composer.above', order: 10 },
  annotation: { slot: 'rail.top',      order: 40 },
} as const satisfies HarnessLayout;
```

`HARNESS_LAYOUT_DEFAULT` reproduces today's arrangement exactly. Moving the plan panel under the lane
stats becomes `plan: { slot: 'lane.understats', order: 10 }` — **one line, type-checked against the slot
union**, no CSS edit (slots own their own sizing rules) and no renderer edit (renderers address their
component, never a DOM field).

**Pinned, deliberately not movable:**

| Surface | Why |
|---|---|
| `.acp-harness__lane-body` (transcript) | Reparenting a scroll container discards `scrollTop` — measured 800 → 0 across detach/reattach in Chromium (spec 94). Spec 95 exists because of this. The layout may resize its slot; it may never move the node. |
| Composer | Keyboard-first (`CLAUDE.md` constraint 1): the command escape hatch must always be present and reachable. The slot may move; the component may not be unmounted. |
| Inline permission / question / write-review rows | Transcript content, not panels. Spec 251 already draws this line: hiding or moving a panel must never conceal an action that unblocks a lane. |

`#panels` (spec 251) stays exactly as it is — it hides the *whole* rail via a root class, which is a
coarser control than, and independent of, slot placement.

### Data Flow

```
1. onLaneEvent() mutates lane state (unchanged)
2. it calls scheduler.invalidate('transcript')   — never render()
3. one rAF later the scheduler commits regions in order
4. 'transcript' commit → Transcript.update(props)
5. Transcript captures the scroll anchor, calls reconcile(body, tailWindow, rowSpec)
6. reconcile: live rows → cmp.update() → appendChunk(); static rows → deps compare → skip or paint
7. Transcript restores the anchor and applies sticky scroll
```

Keystrokes keep today's timing exactly: `setDraft()` → `invalidate('composer')` → `flushSync()` →
`pinStickyAfterComposerKey()`, preserving the ordering asserted at `acp-harness-view.test.ts:2058-2094`.

Turn end: `stop` → `AssistantRow.seal(props)` → no `render()`, no `renderActiveLane()` (constraint 10c),
because the scheduler is never invalidated by the seal.

Late async state (Git refs, images, usage, memory): the owning **sub-component** gets
`update(nextProps)`; its deps changed, its `paint()` runs, the parent row is untouched. The
`patchReferenceRails()` special case (`:7637`) is deleted.

### UI changes and style ownership

**Visually: none.** Every component emits the BEM markup its current builder emits, so `DESIGN.md`
compliance and constraint 9 (no corner brackets) are untouched.

**Structurally the CSS does change**, because today a component cannot be restyled in isolation:

| Leak | Evidence |
|---|---|
| One block covers the whole view | `src/styles/acp-harness.css` is 7,101 lines declaring **988 top-level `.acp-harness` selectors**. `acp-harness` is a namespace, not a component, so there is no boundary to scope a change to. |
| Two components share one class | `renderReviewCardBody` paints into `acp-harness__artifact-head` (`harness-tool-render.ts:729-775`) — restyling the artifact card silently restyles the Review Board card. |
| Four components share one class | all four inline palettes emit `acp-harness__slash-palette` (`harness-lane-chrome.ts:443`, `acp-harness-view.ts:4468,4563,4674`) — the mention palette cannot be changed without changing `/`, `#` and `{{#`. |
| A rule block is declared twice | `.acp-harness__slash-palette…` at `:5604-5700` **and** `:5815-5911`, byte-identical except one comment; same for `.acp-harness__fs-activity`. Editing the first copy has no effect — the second wins. |
| Shared leaf with no owner | `acp-harness__caret` is emitted by three unrelated components — the composer draft line, the dictation preview and the ticket picker's filter (`acp-harness-view.ts:13257`, `harness-dictation-controller.ts:50`, `harness-ticket-controller.ts:758`) — and queried by a fourth (`harness-composer-bloom.ts:156,176`). The attention overlay needed a different caret and forked it instead of parameterising: `acp-triage__caret` (`attention-overlay.ts:120`, `attention-triage.css:274`). |
| Theming reaches into component internals | `src/styles/theme-scheme.css` carries **54 selectors** naming harness blocks (`:139` onward). A component's light-mode appearance is defined 357 lines away in a global file, and deleting the component leaves the override behind. |

Four changes make a component a self-contained unit you can add or delete in one move:

**1. One directory per component.** Markup, style, scheme override and test live together:

```
src/acp/components/tool-row/
├── index.ts        // import './tool-row.css'; export class ToolRow …; export const def
├── tool-row.css    // the ONLY file allowed to declare .acp-harness__tool*
└── tool-row.test.ts
```

The CSS is imported **from the component's own module**, not from a central manifest. That is already how
three views in this repo load their sheets (`src/live-assist-main.ts:12`, `src/diff-view.ts:7-8`,
`src/markdown-view.ts:7`). Deleting the directory removes its rules from the bundle automatically — there is
no `src/styles/index.css` line to remember, which is the whole point of "easy to remove".
A `styles-ownership.test.ts` asserts a component sheet only declares selectors for its own block, following
the CSS-reading test convention already used at `acp-harness-view.test.ts:312,847,2161,2191`.

**2. `@layer` fixes the order that TS imports make unpredictable.** `src/styles/index.css` declares the order
once; component sheets author inside it:

```css
/* index.css, first line */
@layer krypton.base, krypton.component, krypton.scheme, krypton.theme;
```
```css
/* tool-row.css */
@layer krypton.component { .acp-harness__tool { … } }
@layer krypton.scheme    { html[data-theme-scheme='light'] .acp-harness__tool { … } }
```

Cascade order then follows the declared layer order regardless of which module imported what first.

**3. A component owns its own scheme overrides.** `src/styles/theme-scheme.css` currently reaches into harness
internals with **54 selectors** — e.g. `html[data-theme-scheme='light'] .acp-harness__rail-entry--directive.acp-harness__rail-entry--active`
(`theme-scheme.css:139-...`). A light-mode fix for one card therefore lives 357 lines away in a global file,
and deleting the card leaves its override behind. Those 54 rules move into the owning component's
`@layer krypton.scheme` block; non-harness rules stay where they are, so `theme.test.ts:259-263`
("imported last") still holds.

**4. Collisions resolved, not inherited.** The review card gets its own block; `InlinePalette` keeps one block
and gains `data-palette="slash|mention|hash|verb"`; `Caret` becomes a real shared primitive with a `glyph`
prop (three components share it, a fourth forked it); the two duplicated rule blocks are deleted.

### Theme support

Each component's tunables are custom properties declared at its own block root, in a three-level chain:

```css
@layer krypton.component {
  .acp-harness__tool {
    --tool-head-fg: var(--acp-tool-head-fg,   /* 3 · per-theme / per-instance override */
                    var(--agent-text,          /* 2 · harness token namespace            */
                        #d8e8d8));             /* 1 · literal fallback                   */
  }
}
```

- **Level 2 already exists.** `theme.ts:455-491` derives **36 `--agent-*` tokens** from the active theme
  ("DESIGN.amber structure, color from the active theme") and `setCssProperties` (`:608-617`) writes all
  ~120 `--krypton-*` / `--agent-*` / `--vault-*` properties onto `document.documentElement`. A component that
  consumes `--agent-*` is already themed, and `set_theme` / `reload_config` already repaint it with no restart.
- **Level 3 is the new hook.** Overriding one `--acp-*` property reaches that component's subtree and nothing
  else, because custom properties inherit downward only. This generalises the per-lane pattern the view
  already uses (`style.setProperty('--acp-lane-accent', …)` at `:12019,12036,13034`).
- **Who may set level 3 is out of scope here.** The theme TOML is a closed Rust struct today
  (`src-tauri/src/theme.rs:21-30` — `colors`, `chrome`, `focused`, `workspace`, `ui`, no free-form map), so a
  user theme cannot name a component token. Opening that is a backend change and a user-facing feature:
  **spec 303**. This spec only lands the hooks.

### Registry — adding and removing a component

```ts
// src/acp/components/registry.ts
import { toolRow } from './tool-row';
import { peekCard } from './peek-card';
export const HARNESS_COMPONENTS = [toolRow, peekCard, /* … */] as const;
```

```ts
export interface ComponentDef<P> {
  id: string;
  slot: HarnessSlot;                     // default placement, overridable by HARNESS_LAYOUT
  order: number;
  create(ctx: HarnessCtx): Component<P>;
  props(state: HarnessState): P | null;  // null ⇒ not mounted this pass
}
```

Add = one directory + one import + one array entry. Remove = delete the directory and those two lines; the
CSS, the scheme override, the layout entry and the listeners go with it, because `dispose()` and the sheet
both belong to the directory.

**Rejected — `import.meta.glob` auto-discovery.** Zero registration lines, but the mounted set stops being
greppable, tree-shaking is defeated, and every vitest file would load every component. One explicit line is
cheaper than that.

**Rejected — Shadow DOM.** Real isolation, unaffordable here: the harness delegates eight click selectors at
`this.element` (`:6308-6375`) and a shadow boundary retargets `event.target`; global hint mode (spec 82) and
copy-on-select (spec 81) walk the document; annotations (spec 240) compute text offsets across the body
subtree; `md.parse` output is styled by global rules that would need duplicating into every root.

**Rejected — CSS Modules.** Hashed class names break the named-class contract in `DESIGN.md`, the twelve tests
that read CSS files, and constraint 5 (BEM). It also solves the wrong problem: the leak is one block covering
everything, not the global namespace.

### Keybindings / Configuration

None. Selection state moves from three conventions (view fields, `HarnessLane` fields, plain objects)
into `ListPicker` state, but every key and every behaviour is preserved.

## Phases

Each phase ships independently (`npm run check` + `npx vitest run` clean, plus a manual `npx tauri dev`
smoke of the surfaces it touched) and **carries its own CSS**: a component directory is created with its
sheet carved out of `acp-harness.css` in the same commit, so the monolith shrinks phase by phase instead
of in one terminal move.

| # | Phase | Deletes |
|---|---|---|
| 1 | `src/ui/` kernel + the `@layer` declaration in `index.css`; 12 primitive directories; pilot on the 4 inline palettes and 6 list pickers | 8 copied cursor handlers, 4 copied palette handlers, 14 `innerHTML` sites, the `scrollIntoView` band-aids (`:12813`, `:13290`), the `acp-triage__caret` fork |
| 2 | `RenderScheduler`; `HarnessViewHost.render` → `invalidate`; narrow the 97 `render()` sites | `dashboardEl.innerHTML = ''` (`:12917`) and the `prevScrollTop` detach/reattach dance (`:12896-12916`) |
| 3 | 18 transcript-row directories + `LiveComponent` | `transcriptRenderSignature` (130 lines), the pre-signature streaming fast path (`:12156-12183`), `patchStreamingToolBody`'s dedupe dataset keys, the spec-117 orphan-parser `console.warn` (`:12136-12145`) |
| 4 | Lane chrome + composer directories | `refreshMetricsRender`'s per-head `innerHTML` (`:13550`), the 1 Hz full composer rebuild (`:13409`) |
| 5 | `LayoutHost` + `HARNESS_LAYOUT_DEFAULT`; right rail + remaining overlay directories | the four hardcoded slot fields (`acp-harness-view.ts:6467-6490`), 3 "Mirrors …" CSS shells, 18 ad-hoc empty states |
| 6 | Residue sweep: `theme-scheme.css`'s 54 harness selectors move to their owners; `styles-ownership.test.ts` lands; whatever is still in `acp-harness.css` is by definition unowned | `acp-harness.css` itself, the 2 duplicated rule blocks (`:5604-5699` ≡ `:5815-5910`), its `@import` line |

Phase 2 ends with `installLaneBodyScrollTracer()` (`:825-859`) removed and issue #17 re-checked: if the
14 px drift survives a view with no container wipe, it is not a render bug and gets its own spec.

The layout table lands **with** the right-rail components, not after them: the slots replace the four
`*SlotEl` fields rather than being layered on top. Doing it later would mean touching every rail
component a second time.

Phase 6 is a sweep, not a split: after five phases of carve-out, what remains in `acp-harness.css` has no
component claiming it, which is the cheapest possible audit for dead CSS.

## Testing

`acp-harness-view.test.ts` contains ~15 **source-text regex assertions** (`readFileSync(...)` +
`expect(src).toMatch(/replaceChildren/)` at `:302`, `:271`, `:286`, `:296`, `:324`, `:340`, `:2038`,
`:2060`, `:2099`). They pin the implementation text, not the behaviour, and a component refactor breaks
them mechanically. Each is **replaced by the DOM test it was approximating**, run against the component:

| Invariant | New test |
|---|---|
| Seal drops `--streaming` and re-syncs deps (`harness-seal-static.test.ts:36-65`) | `AssistantRow.seal()` → assert class gone, then `update(samePropsObject)` performs **zero** DOM writes (MutationObserver count 0) |
| `pending → in_progress` must not rebuild (`:207-233`) | `ToolRow.update()` across both statuses → body node identity unchanged |
| In-flight section text excluded (`:236-267`) | `ToolRow` with appended section text → only `.acp-harness__tool-output` replaced, head nodes identical |
| Row never `replaceWith` (`:294-307`) | `reconcile()` unit test: node identity stable across 100 updates |
| `stop` does not full-render (`:322-335`) | scheduler spy: `stop` invalidates no region |
| Scroll/smooth-follow block (`:1944-2112`) | unchanged — that logic moves into `Transcript` but keeps its pure helpers |

New kernel tests: `src/ui/component.test.ts` (deps skip, deps override, dispose runs the bag),
`src/ui/list.test.ts` (key reorder preserves nodes, removal disposes, live rows never repainted),
`src/ui/scheduler.test.ts` (coalescing, region order, `flushSync`).

One test outside the harness is affected: `theme.test.ts:268` asserts `theme-scheme.css` contains
`html[data-theme-scheme='light'] .acp-harness__rail`. That pins a rule's **file location**, not its
behaviour, and phase 6 moves the rule to its owner. It is re-pointed at `rail-entry/rail-entry.css`; the
sibling assertion that `theme-scheme.css` is imported last (`:259-263`) still holds and is unchanged.

New ownership test: a component sheet declares selectors only for its own block, and only inside a
`krypton.*` layer — a single regex pass over `src/acp/components/*/*.css`.

## Edge Cases

- **Live row slides out of the tail window** — `reconcile` disposes the component, whose `dispose()` tears
  down `lane.streamingMarkdownParser`. Replaces the spec-117 `console.warn` guard with a structural one.
- **Entrance animation vs. repaint** — `--enter` is added at construction and removed on `animationend`
  inside the row component; `paint()` never writes `className` wholesale, so the `const entering = …`
  rescue at `:12215-12218` is unnecessary.
- **Spinner frame continuity** — the spinner is its own component updated by `tickSpinner`; a parent
  `paint()` cannot reach it, so the `liveSpinnerGlyph` module global (`harness-tool-render.ts:32-35`) is
  no longer load-bearing and is deleted with phase 3.
- **Mutable payloads not yet immutable** — `HarnessPermission`, `QuestionState` and `HarnessLane` are
  mutated in place today; those components override `readDeps()` with an explicit tuple. Dev builds assert
  `readDeps()` is stable across `paint()` to catch deps derived from values `paint()` mutates.
- **Background (inactive) lanes** — only the active `LaneShell` is mounted, as today; switching lanes
  constructs the new shell and disposes the old. Sealed rows re-render from `item.markdownHtml` (spec 94
  cache), unchanged.
- **Remote (ssh) harness** — `resolveLocalImages = false` becomes a prop on the row components; no
  behaviour change.
- **Phase interleaving** — phases 1/2 leave `renderTranscriptItem` untouched; phase 3 leaves the composer
  untouched. No phase requires a second rendering convention to exist "temporarily".

## Open Questions

None blocking. One fork was decided inside this spec and is the thing to confirm before phase 1:
**hand-rolled ~260-line kernel vs. adopting lit-html or idiomorph.** Decided hand-rolled — the live-row
exemption and the parser-owned body node are requirements no library expresses (see Research). Reversing
this decision later costs phase 1 only; phases 2–6 are unaffected by which engine sits underneath.

## Out of Scope

- DOM virtualization beyond the existing 300-row cap / 60-row window (spec 94 non-goal, unchanged).
- Adoption of `src/ui/` by `diff-view.ts`, `vault-view.ts`, `hurl-view.ts`, `markdown-view.ts`,
  `quick-overview.ts`, or the `live-assist` window. The kernel is written generic and harness-free so they
  *can* later; this spec converts the harness only.
- Any visual redesign, new feature, or new keybinding. In particular the `LayoutHost` ships with **one**
  table, `HARNESS_LAYOUT_DEFAULT`, that reproduces today's arrangement byte-for-byte on screen. Named
  presets, a `#layout` command, a picker, per-project persistence, and drag-to-rearrange are a follow-up
  spec — this one only removes the reason they are currently expensive to build.
- User-resizable panes and drag-and-drop panel moves. Slot sizing stays in CSS.
- **Letting a theme file name a component token.** Every component gets its `--acp-*` hook here, but the
  theme TOML is a closed Rust struct (`src-tauri/src/theme.rs:21-30`), so nothing user-authored can set one
  yet. Opening it is [spec 303 — Themeable Component Tokens](./0303-themeable-component-tokens.md), which
  owns the backend change, the sanitisation, and the config docs.
- A theme editor UI or runtime restyling of a live component.
- Shadow DOM and CSS Modules — rejected with reasons in §UI changes and style ownership. `@layer` is **not**
  deferred any more: moving sheets into TS imports makes declared layer order the only reliable ordering.
- Rust/backend, ACP protocol, MCP tools. (Spec 303 carries the one Rust change this family needs.)
- Making `ToolPayload`/`HarnessLane` immutable. `readDeps()` overrides cover them; immutability is a
  follow-up spec if the overrides prove noisy.

## Resources

- [vscode `list.ts` — `IListRenderer`](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/list/list.ts) — the `renderTemplate` / `renderElement` / `disposeTemplate` split adopted by `Component`.
- [vscode wiki — Lists and Trees](https://github.com/microsoft/vscode-wiki/blob/main/Lists-And-Trees.md) — virtual list rationale; informed the decision to keep the tail window and skip virtualization.
- [How lit-html works](https://github.com/lit/lit/blob/main/dev-docs/design/how-lit-html-works.md) — template-parts update model; rejected for node ownership.
- [morphdom README](https://github.com/patrick-steele-idem/morphdom) — "all of the internal state associated with the existing DOM nodes (scroll positions, input caret positions, CSS transition states) will be lost" with `innerHTML`; the argument for node-identity preservation.
- [idiomorph README](https://github.com/bigskysoftware/idiomorph) — id-set morphing; evaluated as the alternative to a hand-rolled reconciler.
