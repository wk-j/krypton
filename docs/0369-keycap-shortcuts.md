# Keycap Shortcuts — Implementation Spec

> Status: Implemented (approved 2026-11-07: "อนุมัติสเปก docs/0369-keycap-shortcuts.md แล้วลงมือทำตามสเปกนี้ได้เลย")
> Date: 2026-11-07
> Milestone: Krypton Console — consistency
> Builds on: 302 §1.7 (`KeyHintBar`) · 366 (Console faceplate) · DESIGN.md "Key", "Surfaces"

## Problem

Most surfaces print keyboard shortcuts as ASCII text: `[a] accept`, `[a]ccept`, `Press [o] to open a
directory`, `a accept · A all · r reject · R all`, `j/k move · enter switch · esc cancel`. The key and
its action read as one run of words, and the same key is spelled `esc`, `Esc` and `⎋` on different
surfaces. Only five places draw a real `<kbd>` cap, and each repeats its own copy of the cap CSS.

## Solution

Every keyboard shortcut drawn as DOM text becomes a key cap: a `<kbd>` with one shared style. A
hint is a cap (or caps) followed by its action as printed legend: `[a] accept` → <kbd>a</kbd> accept.
One kernel helper builds caps and hint runs, `KeyHintBar` always draws caps, and every surface that
builds its hint as a string passes structured hints instead. Text that cannot hold markup (tooltips,
`aria-label`, input placeholders) stays text.

## Research

- Inventory (2026-11-07, scout over `src/` minus `src/loopback/`): 8 bracket-notation sites, about 60
  plain-text hint lines, about 20 key names inside prose (empty states, flash chips, system rows),
  plain-text keybinding columns in the command palette and three help screens. 18 `title` tooltips, 2
  `aria-label`s and 2 input placeholders also name keys.
- Already caps: `KeyHintBar` `style: 'kbd'` (execution dialog, review matrix and priority feet,
  triage queue hint), help overlay `r`/`R`, grammar panel, music now-playing help, review-board
  `keyHint()`. Eight separate CSS rules style those `<kbd>`s with the same `--mat-key*` declarations.
- Spans that already look like caps (which-key, `f` hint-mode labels, question option hotkeys, ticket
  action keys, dictation key, Live Assist header caps) are caps visually; they are not in scope.
- `KeyHintBar` already models a hint as `{ keys, label, keySeparator }`. `DecisionComposer`,
  `triage-overlay` and the composer status chip pass pre-joined strings as one label, so flipping the
  style alone changes nothing; their callers must pass structured hints.
- `live-assist.html` loads `layers.css`, `materials.css` and `live-assist.css`, not `index.css`, so a
  shared cap rule must be its own sheet imported by both entries.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed | One `KeyBinding` component (`crates/ui/src/components/keybinding.rs`) draws every binding as key elements; `KeybindingHint` adds a prefix/suffix label. On macOS modifiers render as `⌃ ⌥ ⌘ ⇧`, Enter and Escape as icons. | One primitive, used by palette, menus and hints |
| VS Code | Command palette and hovers draw bindings as `monaco-keybinding-key` caps, one per key, chords side by side. | Caps, not text |
| GitHub | Shortcut help and command palette use `<kbd>` caps. | Semantic `<kbd>` |

**Krypton delta:** one primitive like Zed's, semantic `<kbd>` like GitHub. Named keys stay words
(`Esc`, `Enter`, `Tab`) because harness surfaces already use words and a monospace cap reads them
plainly; modifiers use the macOS symbols, as Zed does.

## Affected Files

| Slice | Files | Change |
|-------|-------|--------|
| Kernel | `src/ui/kbd.ts` (new), `src/styles/kbd.css` (new), `src/styles/index.css`, `src/live-assist-main.ts`, `src/acp/components/key-hint-bar/index.ts` | `keyCap()`, `KeyHint`, `keyHintNodes()`; one cap rule; `KeyHintBar` loses `style` and always draws caps |
| Kernel CSS cleanup | `execution-dialog.css`, `help-overlay.css`, `review-matrix-overlay.css`, `review-priority-overlay.css`, `triage-overlay.css`, `grammar-panel.css`, `music.css`, `review-board.css` | Delete the per-surface `kbd` cap rules |
| Harness transcript + composer | `fs-write-review-row`, `permission-row`, `question-row`, `decision-composer`, `composer-meta`, `rail-entry`, `staging-strip`, `system-row`, `doc-card-row` + `card`, `live-voice-strip`, `image-viewer`, `genui-panel`, `inline-palette`; `acp-harness-view.ts` (hint strings, flash chips, status chip, palettes, annotation overlay), `ask-user-question.ts`, `computer-approval.ts`, `harness-lane-chrome.ts`, `harness-live-voice-controller.ts` | Structured hints; caps in rows, meta line and flash chips |
| Harness docks + overlays | `rails-dock`, `assistant-instances`, `overlay-shell` + every picker passing `sub` (`directive`, `handoff`, `lane`, `model`, `session`, `remote`, `ticket`), `help-overlay`, `metrics-overlay`, `triage-overlay`, `orchestrator-console`, `execution-dialog`, `review-thread-dialog` | `sub` and footers take hints; section key `[2]` → cap; buttons end with a cap |
| Agent view | `src/agent/agent-view.ts`, `src/agent/context-view.ts`, `src/styles/agent.css` | Review keys, turn keys, scroll/empty/armed hints, `/help` text |
| Other views | `music.ts`, `dashboard.ts`, `dashboards/opencode.ts`, `dashboards/git.ts`, `file-manager/view.ts` (+ parity snapshot), `diff-view.ts`, `hurl-view.ts`, `markdown-view.ts`, `markdown-view-ai.ts`, `file-manager-ai.ts`, `inline-ai.ts`, `telegram-settings-view.ts`, `usage-view.ts`, `review-board/picker.ts`, `review-board/view.ts`, `prompt-dialog.ts`, `command-palette.ts`, `search-palette.ts`, `quick-file-search.ts`, `quick-overview.ts`, `compositor.ts` (vault/pencil pickers), `vault-view.ts`, `connected-computers-view.ts`, `live-assist-view.ts` | Footers, empty states, help screens and keybinding columns draw caps |
| Docs | `DESIGN.md`, `docs/0302-harness-component-catalog.md` §1.7, `docs/README.md` | Key cap part; key-hint foot wording; `KeyHintBar` contract |

## Design

### Data Structures

```ts
// src/ui/kbd.ts — moved from key-hint-bar; one shape for every surface.
export interface KeyHint {
  readonly keys: readonly string[];   // each becomes one <kbd>; may be empty (pure legend)
  readonly label: string;             // printed legend after the caps; may be empty
  readonly keySeparator?: string;     // between this hint's caps; default ' '
}
export function keyCap(key: string): HTMLElement;                       // <kbd>key</kbd>
export function keyHintNodes(hints: readonly KeyHint[], separator?: string): Node[]; // default ' · '
```

`keyHintNodes` wraps each hint that has keys in `<span class="krypton-key-hint">` so a hint never
breaks between its caps and its legend; the run wraps between hints. A legend-only hint stays a text
node so a long sentence can still wrap (`keyHint(hint, className)` gives it a span when it needs a
colour).

### Cap legends

A cap prints what the user presses:

- Letters and digits as typed, case-sensitive: `a` and `A` (Shift+a), as the help overlay already does.
- Named keys as words, title case: `Esc`, `Enter`, `Tab`, `Space`, `Backspace`, `Home`, `End`,
  `PgDn`. The glyphs `↵ ⏎ ⎋ ⇥` become those words.
- Modifiers as macOS symbols inside the same cap: `⌘Enter`, `⇧Enter`, `⌃C`, `⌥1–9`, `⇧Tab`.
- Arrows `↑ ↓ ← →`; a pair is one cap (`↑↓`). A range is one cap (`1–9`).
- Alternatives are separate caps joined by `/` (`j`/`k`, `=`/`-`, `i`/`Esc`); a sequence is caps
  side by side (`Leader` `n`, `f` then the label).

### Rendering rules

1. **Hint lines** (footers, picker heads, composer rows, palettes, status chips): `KeyHint[]`
   rendered by `KeyHintBar` or `keyHintNodes()`. Context words in the same line (`svg viewer`,
   `command mode:`) stay a hint with no keys.
2. **Prose** (empty states, flash chips, system rows, card actions): the sentence keeps its words
   and the key becomes a cap: `Press <kbd>o</kbd> to open a directory.`
3. **Fake key faces that cannot be pressed** — the fs write-review actions and the agent view's
   accept/reject keys — become hint runs like the permission row (<kbd>a</kbd> accept · <kbd>r</kbd>
   reject · <kbd>A</kbd> accept all). Their state colour moves to the legend: reject keeps the fault
   ink, the cap stays material.
4. **Buttons that print their shortcut** (`Close · Esc`, `Start Review · Enter`, `Save profile ·
   Cmd+Enter`): the label, then a cap inside the key (`Close <kbd>Esc</kbd>`).
5. **Keybinding columns and help terms** (command palette, palette tab keys, dashboard header, harness,
   diff and hurl help): each key of the binding is a cap.
6. **No markup possible**: `title`, `aria-label` and `<input placeholder>` keep text, with the legends
   of §Cap legends. The orchestrator's dispatch "placeholder" is a `<span>` and converts.

### Shared cap style

`src/styles/kbd.css`, in `@layer krypton.base`, is the only rule that draws a cap:

```css
kbd {
  display: inline-block;
  padding: 0 4px;
  border: 1px solid var(--mat-key-edge);
  border-radius: 4px;
  background: var(--mat-key);
  box-shadow: var(--mat-key-raise);
  color: var(--mat-lit);
  font: inherit;
  font-size: 0.92em;
  line-height: 1.1;        /* the cap fits inside its host's line box; no row grows */
  text-shadow: var(--mat-print);
  white-space: nowrap;
}
.krypton-key-hint { white-space: nowrap; }
```

A component may restyle a cap only for size in dense rows; it never recolours a cap (DESIGN.md:
key caps take no theme colours). The eight per-surface `kbd` rules are deleted.

### `KeyHintBar`

`style` is removed; every hint's keys are caps. Callers that passed `style: 'plain'`
(`decision-composer`, `queue-card`, `remote-picker`, `ticket-picker`, `triage-overlay`) drop the
prop. `queue-card`'s `#unqueue · #queue clear` are commands and stay hints with no keys.
`DecisionComposerProps.hint` becomes `readonly KeyHint[]`; `OverlayShell` `sub` becomes
`string | readonly KeyHint[]`; `InlinePalette` `hint` and `zeroState` become `readonly KeyHint[]`.

### Composer meta and flash chips

Composer-meta segments carry `hints?: readonly KeyHint[]` beside `text`; `flashChip()` accepts a
string or `KeyHint[]`. A segment with hints renders `keyHintNodes(hints)` in its span. The live-voice
hint's second writer (`harness-live-voice-controller.ts:562`) writes through the strip component
instead of `textContent`.

### UI changes

- New class `krypton-key-hint` (one hint: caps + legend). No other new classes.
- Removed: the bracket text and the key-face styling of `.acp-harness__fs-review-action` and
  `.agent-view__msg-review-key`; those spans become `krypton-key-hint` runs with a legend colour.
- DESIGN.md: a **Key cap** part under Parts (the rule above); "the key-hint foot is printed legend"
  becomes "the key-hint foot prints each key as a key cap and its action as legend"; a Don't: "a
  shortcut written as text (`[a]`, `esc close`) where a cap can be drawn"; version 2.1.0.

## Edge Cases

- **Dense rows** (composer meta, rail meta at 11px): `line-height: 1.1` keeps the cap inside the
  host line box; verify computed row heights do not change.
- **Light scheme**: caps read the `--mat-*` tokens, which swap to aluminium; no scheme rule needed.
- **Wrapping**: a hint never splits between cap and legend (`white-space: nowrap` on the hint).
- **Sealed transcript rows**: converted rows still paint once from `readDeps()`; a hint array is a
  constant per row state, so deps compare by content (as `KeyHintBar.readDeps` already does).
- **Tests**: markup contract tests that pin old strings are updated where they test behaviour;
  pure wording pins are deleted. The file-manager parity snapshot is regenerated.
- **Dynamic keys** (`press ${hintLabel} to open`, `formatShortcut()`): the key part becomes a cap;
  a formatter returns `KeyHint`/cap legends instead of a joined string.

## Open Questions

None. Decisions the user may overturn: named keys as words rather than `↵ ⎋` glyphs; `A` rather
than `⇧A` for Shift+a; non-pressable key faces become cap + legend instead of a cap nested in a key.

## Out of Scope

- The loopback app (`src/loopback/`): already draws `<kbd>` with its own design system.
- Spans that already look like caps (which-key, hint-mode labels, question hotkeys, ticket and
  dictation keys, Live Assist header caps): no span → `<kbd>` churn.
- Text printed into a terminal (`backend-updates.ts` `printf`), the keyboard overlay, prompts sent to
  agents, hash-command usage text (`#queue [clear | edit N]`), music repeat/shuffle state `[R]`/`[S]`.
- Changing any key binding.

## Implementation Notes

Deviations and additions found while implementing (2026-11-07):

- **Extra files.** `src/acp/components/composer/index.ts` (palette `hint`/`zeroState` pass through to
  `InlinePalette`); `src/acp/harness-view-host.ts` (`HarnessLiveVoiceHost` loses `composerEl`, gains
  `patchLiveVoice()`, so the live-voice controller writes through the strip, not `textContent`);
  `src/palette-types.ts` (`ScopeHint` extends `KeyHint` plus `kind`); `src/file-manager/components/status-bar`
  (`hints` prop for the `y`/`N` delete confirm); `src/acp/components/action-button` (`shortcut` prop: a
  cap after the label, used by the review-thread dialog); `src/styles/overlays.css` (prompt-dialog
  digit holder no longer colours its cap).
- **Command palette.** `bindingCaps()` in `command-palette.ts` turns binding strings (`Leader Shift+K`,
  `Cmd+Shift+>`) into a sequence of caps, so palette entries keep their string bindings.
- **Review board.** Its private keycap helper and `.krypton-review__key` rule are gone; it uses
  `src/ui/kbd.ts`.
- **Left as text, on purpose.** The `Ctrl+C again to force-restart` transcript row is persisted
  transcript text; the `#voice` description in `hash-commands.ts` is also served as JSON at
  `/commands.json`; `open reference: press label` names a hint label, not a fixed key; inline-AI
  session errors reach the screen through text-only paths (spelled `⌘K`).
- **Wording.** Where a hint starts with its key, the word "press" was dropped (`q to open in
  browser`, `d dispatch to X`); flash chips use ` · ` before key hints.

## Resources

- `/Users/wk/Source/zed/crates/ui/src/components/keybinding.rs`, `keybinding_hint.rs` — one binding
  primitive, macOS modifier symbols, hint = binding + prefix/suffix label.
- [Command Palette UI Design — Setproduct](https://www.setproduct.com/blog/command-palette-ui-design-guide) — footer hint bar as caps plus action words.
- [Keyboard Keys (kbd) — fwdtools](https://fwdtools.com/ui-snippets/kbd-keys) — `<kbd>` caps read better than plain `Cmd+K` text.
