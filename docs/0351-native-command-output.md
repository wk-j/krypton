# Native Command Output — Implementation Spec

> Status: Implemented
> Date: 2026-11-01
> Milestone: M8 — Polish
> Builds on: [0334](./0334-inline-ai-terminal-context.md) (OSC 133 command records) · [0346](./0346-osc-support.md) (OSC table)
> Extended by: [0352](./0352-native-git-status.md) — `git status` is a second renderer; the card became `native-card.ts` with a `diff` | `status` model, and the diff body moved to `render-diff.ts`.

## Problem

`git diff` in a terminal pane is plain text: no line numbers, no syntax colour, no intra-line
changes. With the dev machine's `core.pager = delta`, the pane shows delta's decorated text instead
of a diff. Rex shows the same block as a native view: a bar reading `git diff · Native | Raw · copy`
at the block's top-right, files as `modified <path> +1 −0`, one line-number column, syntax colour and
word-level marks. Raw shows the terminal text again.

## Solution

Each command is a block, bounded by its OSC 133 `C` and `D` marks. fish 4 emits these on its own.
When a finished block holds a unified diff, Krypton paints a static DOM card over exactly that
block's rows. The diff comes from the block's own rows when they parse. Otherwise, for a local plain
`git diff`, Krypton runs it once more with `--no-pager --no-color`. Each card has a Native/Raw toggle
(`Leader i`). Raw hides the card, and the terminal cells underneath were never changed. Unified diff
is the only renderer in this spec.

## Research

- **OSC 133 is already wired.** `wireProgramStatus` (`compositor.ts:997-1034`) parses `A`/`C`/`D`
  through `parseOsc133` and feeds `ShellCommandLog`. That log drops markers for every record except
  the newest finished one (`terminal-context.ts:101-102`), so native blocks need markers of their
  own, taken in the same handler. `commandOutput` already defines the row range: `D` at column 0
  means the output ended with a newline (`terminal-context.ts:178-190`).
- **xterm decorations are unusable here.** In xterm 6.0.0, `registerDecoration` calls
  `_checkProposedApi()`, and Krypton does not set `allowProposedApi`. Worse, `_refreshStyle` sets
  `display:none` as soon as the marker row is outside the viewport. A tall block anchored at `C`
  would vanish once its first row scrolled off. Krypton's existing overlays (`hints.ts:447-483`,
  `selection.ts:468-577`) position their own DOM with `(row - viewportY) * cellHeight`. This spec
  does the same.
- **The canvas is transparent** (`XTERM_TRANSPARENT_BG`, `compositor.ts:304-310`), and the window
  CSS draws the tint. An opaque card would hide the raw glyphs but read as a black slab on the
  translucent window. Krypton loads no WebGL addon, so the rows are the DOM renderer's
  `.xterm-rows > div` (one per viewport row, in order), and CSS can hide the ones under a card.
- **Existing diff code.** `DiffBlock` `unified` (`acp/components/diff-block`) has no line numbers,
  and `unifiedDiffRows` misreads a deleted line that starts with `--` as `meta`. `DiffView`
  (`diff-view.ts`) is a full-pane diff2html table with review. Neither fits inline. This spec reuses
  diff2html `parse()` (line numbers, renames, binary flags), `hljs` with `extToLang`
  (`file-preview.ts`), and `diffWordsWithSpace` from `diff`.
- **Pagers.** On this machine `git config core.pager` is `delta` (`line-numbers`, `decorations`),
  so a block's rows hold delta output that is not a unified diff. Reading the buffer alone would
  never trigger for this user's `git diff`, which is why the re-run path exists. When less pages a
  long diff on the alternate screen, no rows remain in scrollback, so there is nothing to cover.
- **Re-running.** `git.rs` `run_git` runs an argv without a shell. `collect_working_diff` already
  passes `--no-pager --no-ext-diff --no-textconv`.
- **Rejected:** (a) opening `DiffView` from the block. It exists (`Leader d`) but is not inline and
  not tied to the command. (b) Writing blank rows into xterm to make room for a taller card. That
  desyncs the shell's cursor model and breaks reflow. (c) Setting `GIT_PAGER=cat` in spawned
  shells. That changes the user's terminal behind their back.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Rex (observed, screenshot) | Bar at the block's top-right: `git diff`, a `Native`/`Raw` segmented toggle, copy. Native shows a per-file `modified <path> +A −D` header, a single line-number column (old for `−`, new for `+`/context), syntax colour and intra-line marks. | The implementation is not public; only the UX is matched. |
| Warp | Blocks group command and output. `⌘↑` selects the newest block, `↑`/`↓` move between blocks, and a sticky command header covers cut-off blocks. | No native diff rendering inside a block. |
| VS Code terminal | Shell integration draws xterm.js gutter decorations (exit status) and a sticky-scroll header for the partially visible command. | Same xterm.js. Decorations are only one-cell marks. |
| Wave Terminal | Rich content opens as separate widgets (`wsh view`), not over the output. | Same model as Krypton's `DiffView` handoff. |

**Krypton delta:** the card sits inline like Rex's. Native/Raw is a Leader key first and a mouse
click second. Krypton never alters the PTY bytes, the shell's environment or the scrollback; Raw is
the untouched terminal.

## Affected Files

| File | Change |
|------|--------|
| `src/native-output/blocks.ts` | New. `CommandBlockTracker`: OSC 133 → `CommandBlock` records with their own markers; `rawRows()` |
| `src/native-output/git-diff.ts` | New. `looksLikeUnifiedDiff`, `parseNativeDiff` (diff2html → rows + word marks), `isGitDiffCmdline` |
| `src/native-output/native-card.ts` | New. `NativeCard extends Component`: bar + body, painted once (named `native-diff-card.ts` until 0352) |
| `src/native-output/native-output.css` | New. Layout in `@layer krypton.component`; the hljs colour map is unlayered (see Implementation Notes) |
| `src/native-output/layer.ts` | New. `NativeOutputLayer` per terminal pane: its own OSC 133/RIS handlers, card lifecycle, layout, view toggle; `syncNativeOutputMode()` |
| `src/compositor.ts` | One layer per pane in `createPane`; `rerunGitDiff()`, `toggleNativeOutput()`, `copyNativeOutput()` |
| `src/main.ts` | Mode change → `syncNativeOutputMode` (suspend in Selection/Hint, show Raw bars in Compositor) |
| `src/input-router.ts`, `src/which-key.ts`, `src/command-palette.ts` | `Leader i`, `Leader Shift+I` |
| `src-tauri/src/git.rs`, `commands.rs`, `lib.rs` | `native_git_diff` command; `git_diff_rerun_args` validator |
| `src-tauri/src/config.rs`, `src/config.ts` | `[native_output]` section |
| `docs/0004`, `0005`, `0006`, `0346`, `README.md` | Architecture, data flow, config key, OSC 133 row, index |

## Design

### Data Structures

```ts
// blocks.ts
export interface CommandBlock {
  readonly id: number;
  readonly cmdline: string | null;
  readonly start: IMarker;          // cursor row at C
  readonly end: IMarker;            // cursor row at D (a block exists only once D arrived)
  readonly endCol: number;
  readonly exit: number | null;
}
export function rawRows(b: CommandBlock): number; // end.line - start.line + (endCol > 0 ? 1 : 0)

// git-diff.ts
export interface NativeDiffRow {
  kind: 'ctx' | 'add' | 'del' | 'gap';
  line: number | null;              // old for del, new for add/ctx, null for gap
  text: string;                     // sign stripped
  marks: ReadonlyArray<readonly [number, number]>; // changed ranges, 1:1 del/add pairs only
}
export interface NativeDiffFile {
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  path: string; oldPath: string | null;
  added: number; deleted: number;
  language: string | null;          // extToLang(path)
  rows: NativeDiffRow[];
}
export function looksLikeUnifiedDiff(lines: readonly string[]): boolean; // first non-blank line is `diff --git ` or `--- ` followed by `+++ `
export function parseNativeDiff(text: string): NativeDiffFile[] | null;  // null: no file, or > 5 000 lines / 2 MiB
export function isGitDiffCmdline(cmdline: string): boolean;             // cheap IPC pre-filter: /^git(\s+--no-pager)?\s+diff(\s|$)/
```

### API / Commands

`native_git_diff(cwd: String, cmdline: String) -> Result<String, String>` (Rust is the only place
that decides what may run):

- `git_diff_rerun_args(cmdline)` splits on whitespace. It returns `Err` for any of
  `` | & ; < > ( ) $ ` ' " \ * ? [ ] { } # `` or a newline anywhere, and for `~` where a shell
  would expand it (token start, or right after `=` / `:`); `HEAD~1` passes. The command must be
  exactly `git [--no-pager] diff <rest>`, so `git -C`, `-c`, `--git-dir`, aliases and other
  subcommands are refused. A `--name[=…]` token in `<rest>` is refused when its name is a prefix
  of, or starts with, `--output`, `--ext-diff`, `--textconv`, `--word-diff` or `--color` (git
  accepts unambiguous abbreviations, so `--out=x` is caught; `--no-color` passes).
- It runs `git --no-pager diff --no-color --no-ext-diff --no-textconv <rest>` in `cwd` with
  `GIT_OPTIONAL_LOCKS=0`, killed after 5 s. Stdout over 2 MiB, or an exit status other than 0/1, is
  an `Err`. The command is `async` on `spawn_blocking`.

### Data Flow

```
1. fish → OSC 133;C;cmdline_url=git%20diff → NativeOutputLayer's own 133 handler (returns false,
   so wireProgramStatus's handler still runs) → open block { start: registerMarker(0), cmdline }
2. OSC 133;D;0 → end = registerMarker(0), endCol = cursorX; A with an open block → drop it
3. setTimeout(0), out of the parser callback → layer.tryMount(block). Drop unless: enabled,
   rawRows ≥ 1, exit ∈ {0, 1, null}. Rows are read from buffer.normal.
   a. the first 8 logical lines look like a unified diff → read every line of the block
   b. else isGitDiffCmdline → get_foreground_process must be null (the pane's own shell is in
      front, so the command ran locally) → get_pty_cwd → native_git_diff
   c. parseNativeDiff; markers still alive → NativeCard painted once, view = default_view
4. terminal.onRender / onScroll / onResize / buffer change → layer.layout(): per card,
   top = (start.line − viewportY) × cellH, height = rawRows × cellH; hidden when fully
   off-screen; writes only transform/height. The bar rides the first visible row.
5. start/end marker onDispose (scrollback trim, clear) or RIS → card disposed
```

`cellH` is `.xterm-screen`'s inline `style.height` ÷ rows, so a layout pass forces no reflow. A
pane keeps at most 16 cards, and the oldest is disposed first. A card's DOM is static after its
first paint; toggling flips one class.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader i` | Compositor | Toggle Native/Raw on the focused pane's newest card that is partly in view; no card → no-op |
| `Leader Shift+I` | Compositor | Copy that card's unified diff text |

Mouse: the bar's `Native` / `Raw` / copy buttons.

### UI Changes

```
.krypton-native-output                 layer inside .xterm-screen; pointer-events none; overflow hidden; holds the row-hiding <style>
  .krypton-native-block[--raw]         absolute, full width, translateY per layout
    .krypton-native-block__bar         top-right, pointer-events auto: <cmdline> · Native|Raw · copy
    .krypton-native-block__body        transparent; overflow-y auto; overscroll contain
      .krypton-native-diff__file       status word · path · +A −D
      .krypton-native-diff__row--{ctx,add,del,gap}   [line][sign][code with .hljs-* and __mark spans]
```

The body uses the terminal's font family and size, with line-height equal to the cell height, so
native rows sit on the terminal grid. Long lines wrap (`pre-wrap`, `overflow-wrap: anywhere`), and
continuation rows have an empty gutter. Colours come from the theme's ANSI variables and
`--krypton-*` tokens; `hljs-*` classes map to the ANSI palette. The bar has a full 1px border, with
no corner ticks and no `infinite` animation. In Raw view the body is hidden, and the bar shows only
on hover or while Compositor mode is active. The layer hides while the alternate buffer is active,
and while Selection or Hint mode runs in that pane, because both paint on raw cells.

### Configuration

```toml
[native_output]
enabled = true            # false: no cards
default_view = "native"   # "native" | "raw" for new cards
```

Reload Config applies to new blocks; existing cards keep their view.

## Edge Cases

- **No OSC 133** (zsh/bash without integration, tmux, screen): no blocks, no cards.
- **The pager used the alternate screen** (a long diff through less or delta): `rawRows` is 0, so
  there is no card. `Leader d` (`DiffView`) remains the way to see the whole diff.
- **delta, colour or other decorated output:** the buffer check fails, and the re-run path applies
  when the command is a local plain `git diff`.
- **SSH, `docker exec` or any other foreground once the command ended:** `get_foreground_process`
  is not null, so nothing is re-run. A remote `git --no-pager diff` still works from the buffer.
- **Empty context lines from the buffer:** the terminal trims ` ` to ``, which diff2html skips,
  so line numbers would drift. `parseNativeDiff` counts each hunk from its `@@` header and puts the
  space back.
- **Re-run differs from what scrolled by** (the tree changed in the interval): the card shows the
  re-run, and Raw shows what was printed.
- **Native taller than raw rows** (more wrapping due to the gutter): the body scrolls inside the
  card. Shorter: the body pads to `rawRows`, so the next prompt never moves.
- **Resize:** xterm reflows and moves the markers; `rawRows` is re-read in `layout()`, and CSS
  re-wraps the body.
- **Interrupted command** (`A` with no `D`), or `git` exit 128: no card.
- **Buffer source:** tabs already arrive as spaces, and trailing whitespace is trimmed. The re-run
  source uses `tab-size: 8`.
- **Binary or mode-only file:** a header row only (`binary` / `modified`), with no body rows.

## Open Questions

None.

## Out of Scope

- Renderers other than unified diff (`git show`, `git log -p`, JSON, tables). `git status` came in
  [0352](./0352-native-git-status.md).
- Warp-style block selection, navigation, and a sticky header for non-native blocks.
- Shipping zsh/bash OSC 133 integration scripts.
- Review comments and side-by-side layout (`DiffView` owns both).

## Tests

- `git-diff.test.ts`:
  - `looksLikeUnifiedDiff`: accepts `git diff` and `diff -u` output; rejects delta text, blank input
    and `--stat` output.
  - `parseNativeDiff`: modified, added, deleted, renamed and binary files; line numbers; a deleted
    line starting with `--` stays `del`; marks only on 1:1 pairs; size caps.
  - `isGitDiffCmdline`.
- `blocks.test.ts`: C→D makes a block; A without D drops it and disposes its marker; a second C or
  RIS forgets the open block; the `rawRows` `endCol` rule; a trimmed marker gives 0 rows.
- `git-diff.test.ts` also covers the trimmed-empty-context case and `wordMarks`' common-text floor.
- `git.rs`:
  - `git_diff_rerun_args` accepts `git diff`, `git --no-pager diff --staged -- src`, `HEAD~1`. It
    rejects pipes, quotes, `$`, `~/x`, `git -C x diff`, `-c`, `env X=1`, `git show`,
    `--output=x`, `--out=x`, `--ext-diff`, `--textconv`, `--word-diff*`, `--color*`.
  - `native_git_diff` in a temp repo with `core.pager=less` and `color.ui=always` returns a plain
    diff without escapes.

## Implementation Notes

- **The layer registers its own OSC 133 and RIS handlers** instead of being fed from
  `wireProgramStatus`. xterm runs every handler for an identifier until one returns `true`, and
  both return `false`, so the layer is self-contained and the compositor only constructs it.
- **"Local" is decided when the command has ended**, not at `C`. `processBySession` is a 500 ms
  poll (and stops when `[extensions]` is off), so a just-started `ssh` could still read as local.
  `get_foreground_process` is synchronous `tcgetpgrp()` and returns null only while the pane's own
  shell is in front.
- **The hljs colour map is unlayered.** The github-dark sheets other views import are unlayered and
  would beat any `krypton.*` rule. The map uses a three-class selector to outrank their
  `.hljs-title.function_`.
- **Cards are transparent; the raw rows under a Native card are hidden instead.** The first build
  painted an opaque `rgb(var(--krypton-bg-rgb))` body, and the user called it isolated from the
  theme. Now the layer gives its `.xterm-screen` a `data-krypton-native` id and writes one rule per
  visible Native card into a `<style>` it owns:
  `.xterm-rows > div:nth-child(n+a):nth-child(-n+b) { visibility: hidden }`. The rule is gated on
  `:root:not(.krypton-native-output--suspended)`, so Selection and Hint mode see the rows again.
  It is rewritten only when the set of rows changes, and it is emptied for Raw cards, on the
  alternate buffer and when no card is left. The bar sits on `--krypton-bg-elev`, so it stays
  legible over raw text. This depends on the DOM renderer; a canvas/WebGL renderer would need the
  opaque body back.
- **Dim text is the terminal foreground at 55% (`--krypton-native-dim`), not `--krypton-fg-dim`.**
  The latter is the theme's titlebar text colour; legacy-radiance sets it to `#304838`, which made
  line numbers, directories, group labels and the bar's labels nearly invisible on the terminal.
  Foreground-at-opacity is how xterm draws SGR 2 (dim), so it tracks every theme the same way.
- **Word marks follow `diffWordsWithSpace` tokens:** `console.error` → `this.notify` marks
  `console` and `error` and leaves the `.` unmarked. Pairs with under 25% common text, or longer
  than 500 characters, get no marks.
- **Mouse:** `mousedown` on the bar or body is `preventDefault` + `stopPropagation`, so focus stays
  in xterm's textarea and no raw selection starts underneath. The wheel scrolls the body while it
  can and otherwise reaches the terminal.

## Verification

- `npm run check`, `npx vitest run` (276 files, 3 327 tests), `npm run build`; `cargo fmt --check`,
  `cargo clippy`, `cargo test` (all pass).
- Browser smoke (throwaway, deleted). The real `NativeOutputLayer` ran on an `@xterm/xterm`
  Terminal fed real bytes captured from an interactive `fish -i` in a 120×40 PTY. The re-run stub
  returned real `git --no-pager diff` output. Observed:
  - after `ls`, `git --no-pager diff -- src/which-key.ts src/main.ts` gave one card (2 files, 28
    rows, syntax spans, a gap row), and `ls` gave none;
  - `git diff` through delta took the re-run path and covered exactly delta's 12 rows;
  - Native/Raw flipped by key and by click, and the Raw bar showed in Compositor mode;
  - the bar rode the first visible row with the block's top scrolled off, and the card hid once
    fully off screen;
  - resizing to 70 columns reflowed card and raw together;
  - `?1049h` hid the layer, the suspended class hid it, and RIS removed the card;
  - the wheel over a card scrolled the terminal, and a click or drag on a card kept xterm's focus
    with no raw selection;
  - Copy wrote the unified diff and notified.
- Not exercised: the running Tauri app. This machine gives the agent no screen-capture or keystroke
  permission, so `get_foreground_process` → `get_pty_cwd` → `native_git_diff` over real IPC and the
  WKWebView paint are covered only by the parts above.

## Resources

- [Warp — Terminal Block Basics](https://docs.warp.dev/terminal/blocks/block-basics.md) — block
  grouping, `⌘↑`/`↑↓` block navigation, sticky command header.
- [VS Code — Terminal Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration)
  — command decorations on xterm.js, sticky scroll.
- `node_modules/@xterm/xterm/typings/xterm.d.ts:515-612, 1157` and `lib/xterm.mjs`
  (`registerDecoration` → `_checkProposedApi`; `_refreshStyle` hides off-viewport anchors).
- `node_modules/diff2html/lib/types.d.ts` — `DiffFile` / `DiffBlock` / `DiffLine` with
  `oldNumber`/`newNumber`.
- `man fish-terminal-compatibility` (via spec 0334) — `133;C;cmdline_url=`, `133;D;<exit>`.
- Rex Beta (local app, screenshot) — observed Native/Raw bar UX only.
