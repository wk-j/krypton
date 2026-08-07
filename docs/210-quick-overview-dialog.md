# Quick Overview Dialog — Implementation Spec

> Status: Implemented
> Date: 2026-08-05
> Milestone: M8 — Polish

## Problem

Krypton has no modal for *showing content*. Every global overlay it owns is a
picker or a composer (command palette, quick file search, prompt dialog), so any
feature that wants to answer "just show me this thing for two seconds" has to
either invent its own overlay or open a tab. Hint mode takes the second route:
selecting a filepath label spawns a Helix tab (`hints.ts:653`), which costs an
editor start plus a tab close to read three lines.

## Solution

Add **Quick Overview** — one global modal whose only job is to render a
pluggable `OverviewSource`. The dialog owns the shell, scrolling, keyboard
handling, mode lifecycle, and cancellation; a source owns the title, the body,
and any extra actions. Hint mode's filepath action becomes the first source, with
the existing tab/viewer/browser openers demoted to escalations reachable from
inside the dialog. Future "peek at X" features register a source and get the
dialog for free.

## Research

**Existing overlays (none is a content viewer):**

| Surface | What it is | Verdict |
|---|---|---|
| `krypton-quicksearch` (`quick-file-search.css:3`) | global `fixed/inset:0` shell, input + list + statusbar + hint bar | shell + router contract are the model to copy |
| `krypton-palette` (`overlays.css:195`) | fuzzy list picker | picker only |
| `acp-harness__triage-overlay` (`attention-triage.css:29`) | `position: absolute` **inside** the harness view | pane-scoped, unusable for a global peek |
| `prompt-dialog.ts` | composer that writes to a PTY | unrelated |
| `dashboard.css:28` | 80vw/1200px full view | far too heavy for a peek |
| file-manager preview / markdown-view | pane and tab content views | exactly what we are trying to avoid |

**Reuse points found:**
- `read_file` command already exists (`src-tauri/src/commands.rs:179`) and is used
  by six frontend modules.
- File-manager already solved content rendering: `PREVIEW_MAX_BYTES = 65536`,
  `extToLang()` (`file-manager.ts:1918`), `isBinaryExtension()` (`:1971`),
  `isMarkdownFile()` (`:1966`), and a `Marked` + `markedHighlight` instance
  (`:13`). These are private duplicates waiting to be shared.
- The router contract for a modal is established: `isVisible` + `handleKey(e):
  boolean` + an `exitX()` callback, wired in `main.ts:127`.
- The scroll recipe is documented in `attention-triage.css:89`: the scrolling
  region needs `flex: 1; min-height: 0` or the panel's `overflow: hidden` at
  `max-height` clips it.
- `ContentView.getWorkingDirectory?.()` (used at `compositor.ts:3845`) gives
  non-terminal panes a cwd, which is what makes relative-path resolution work
  when hint mode runs over a DOM pane rather than a terminal.

**Alternatives ruled out:**
- *Add a preview pane to Quick File Search* — helps only the picker; hint mode,
  diffs, and agent output would still have nowhere to render.
- *Generalise markdown-view to all file types* — it is a tab, so it does not
  solve the "without leaving what I'm doing" problem at all.
- *Reuse the triage overlay* — it lives inside the harness DOM and would need to
  be lifted out, which is a bigger change than writing the primitive.

## Prior Art

| App | Implementation | Notes |
|---|---|---|
| VS Code / Visual Studio | Peek Definition (`Alt+F12`) embeds an inline editor under the cursor; `Esc` closes; content is scrollable and editable | Peek is explicitly framed as "stay in context"; `editor.stablePeek` exists because accidental dismissal is the main complaint |
| telescope.nvim | Picker with a live preview window; `Ctrl+D` / `Ctrl+U` scroll the preview (hard-coded half/30 lines) while the cursor stays in the prompt | Preview scroll keys are separate from list-navigation keys |
| fzf | `--preview 'bat {}'` renders an arbitrary command's output beside the list; `--preview-window` controls geometry | Preview is a *pluggable source*, not a fixed renderer — the model this spec follows |
| lazygit | Right-hand panel previews the focused item (diff, file, commit) with the same keys everywhere | One panel, many sources |
| iTerm2 / WezTerm / Kitty / Warp | Hyperlink and semantic-history clicks **open** the target in an external editor or browser; no in-terminal peek exists | Terminal emulators have no equivalent — this is a Krypton-specific capability |

**Krypton delta** — the source-plugin model comes from fzf, the `Ctrl+D/U`
scroll from telescope, and the "read without leaving context" framing from Peek.
The divergence is that Krypton's dialog is fully keyboard-driven and never
editable: it is a *read* surface, and editing is an explicit escalation
(`Enter` → Helix tab). No terminal emulator ships this, so there is no terminal
convention to match.

## Affected Files

| File | Change |
|---|---|
| `src/quick-overview.ts` | **new** — the primitive: shell, keys, scroll, lifecycle |
| `src/file-preview.ts` | **new** — shared helpers extracted from file-manager (`PREVIEW_MAX_BYTES`, `extToLang`, `isBinaryExtension`, `isMarkdownFile`, `formatSize`, the `Marked` instance) |
| `src/file-peek-source.ts` | **new** — `createFilePeekSource()`: resolve path → read → classify → actions |
| `src/file-manager.ts` | import the extracted helpers, delete the private copies |
| `src/hints.ts` | filepath branch opens an overview instead of a Helix tab (config-gated) |
| `src/input-router.ts` | `Mode.QuickOverview` wiring, `exitQuickOverview()`, force-exit list, hint→overview handoff |
| `src/types.ts` | `Mode.QuickOverview` |
| `src/main.ts` | construct `QuickOverview`, inject into the router |
| `src/styles/quick-overview.css`, `src/styles/index.css` | new styles + import |
| `src/config.ts`, `src-tauri/src/config.rs` | `[hints] file_action` key |
| `docs/12-hint-mode.md`, `docs/82-global-hint-mode.md`, `docs/06-configuration.md`, `docs/04-architecture.md`, `docs/PROGRESS.md` | doc updates |

## Design

### Data Structures

```ts
// src/quick-overview.ts

/** What the dialog renders. A source is loaded once per open. */
export interface OverviewSource {
  /** Header text, rendered verbatim — paths keep their real casing. */
  readonly title: string;
  /** Right-aligned header meta, e.g. 'typescript · 4.2 kb · 118 lines'. */
  readonly meta?: string;
  /** Produce the body. Rejections render as an error notice, never a crash. */
  load(signal: AbortSignal): Promise<OverviewBody>;
  /** Source-specific keys, dispatched before the built-ins and listed in the footer. */
  readonly actions?: OverviewAction[];
}

export type OverviewBody =
  | { kind: 'code'; text: string; lang: string | null; truncated?: boolean }
  | { kind: 'markdown'; text: string; basePath: string }
  | { kind: 'notice'; text: string }
  | { kind: 'element'; el: HTMLElement };

export interface OverviewAction {
  /** Single lowercase character, or 'Enter'. */
  readonly key: string;
  /** Footer label, lowercase. */
  readonly label: string;
  run(): void | Promise<void>;
  /** Close the dialog after `run()`. Default true. */
  readonly closes?: boolean;
}
```

### API

```ts
export class QuickOverview {
  constructor(compositor: Compositor, onClose: () => void);
  get isVisible(): boolean;
  /** Opens synchronously in a loading state, then awaits source.load(). */
  open(source: OverviewSource): void;
  close(): void;
  /** Returns true when the key was consumed. */
  handleKey(e: KeyboardEvent): boolean;
}

// src/file-peek-source.ts
export function createFilePeekSource(
  compositor: Compositor,
  rawPath: string,
): OverviewSource;
```

### Data Flow

```
1. Hint mode: user selects a label whose rule is `filepath`
2. hints.executeActionForText() → this.overviewOpener(createFilePeekSource(compositor, text))
   (opener injected by InputRouter; when [hints] file_action = "editor" this
    branch is skipped and the old openInHelixTab path runs unchanged)
3. InputRouter opens QuickOverview synchronously; hints.handleKey returns 'selected'
4. handleHintKey sees quickOverview.isVisible → setMode(Mode.QuickOverview)
   (instead of toNormal())
5. Source.load(signal) resolves the path: absolute → '~' via expandVaultPath()
   → pane cwd via getFocusedWorkingDirectory() / contentView.getWorkingDirectory()
6. invoke('read_file', { path: abs }); classify by extension → code | markdown | notice
7. Dialog renders the body, focuses the scroll region, footer lists built-ins +
   source actions
8. Esc → close() → onClose() → router.exitQuickOverview() → Mode.Normal
   Enter → escalate (helix tab / markdown viewer / OS browser) → close
```

### Keybindings

| Key | Context | Action |
|---|---|---|
| `j` / `k` | QuickOverview | scroll one line |
| `Ctrl+D` / `Ctrl+U` | QuickOverview | scroll half a page (telescope convention) |
| `g` / `G` | QuickOverview | jump to top / bottom |
| `y` | QuickOverview | copy the resolved absolute path |
| `Enter` | QuickOverview | primary source action — for a file peek: `.md` → markdown viewer tab, `.html` → OS browser, else Helix tab |
| `Esc` | QuickOverview | close, return to Normal |

No Alt-modifier bindings (they do not reach the app). `Cmd+O` / `Cmd+Shift+K` /
`Cmd+P` keep working from inside the dialog by force-exiting it first, matching
the existing overlay handling at `input-router.ts:500-537`.

### UI Changes

```
.krypton-overview                      /* fixed inset:0 scrim, --visible toggles opacity */
  .krypton-overview__panel             /* clamp(720px, 78vw, 1100px), max-height 78vh */
    .krypton-overview__head            /* title (verbatim casing) + meta */
    .krypton-overview__body            /* flex:1; min-height:0; overflow-y:auto */
      pre.krypton-overview__code       /* hljs output */
      div.krypton-overview__markdown   /* marked output */
    .krypton-overview__footer          /* key hints, lowercase labels */
```

The panel is the only frame: no card inside the panel, no `border-left` accent
rails anywhere. Chrome (head, footer) uses `--krypton-chrome-font-size`; the body
is a reading surface and uses the user's configured `--krypton-font-family` at
normal size. Colours come from the existing `--krypton-palette-*` custom
properties, so themes and hot-reload work with no new theme keys. Sounds reuse
`command_palette.open` / `command_palette.close` — no new WAV assets.

### Configuration

```toml
[hints]
file_action = "peek"   # "peek" (default) | "editor" — what a filepath label does
```

Rust: `HintsConfig` gains `file_action: HintFileAction` (serde enum, default
`Peek`); TypeScript mirrors it in `config.ts`. Hot-reloads with the rest of
`[hints]` through the existing `applyConfig()` path (`main.ts:101`).

## Extension Points

The point of the primitive is the next feature, not this one. Each of these
becomes a source file plus one call site — no change to the dialog:

- Quick File Search: `Ctrl+Space` on the highlighted hit → file peek source.
- Diff view: peek the full file behind a hunk without leaving the diff.
- ACP harness: peek a tool result, an artifact, or a handoff payload.
- Agent view: peek a skill definition from the skill list.
- `file:line` hints: a source that scrolls to and marks a line once the hint
  regex captures line numbers.

## Edge Cases

| Case | Handling |
|---|---|
| File larger than 64 kb | render the first 64 kb, footer shows `truncated`; `Enter` still opens the whole file |
| Binary extension | `notice` body — `binary file — nothing to preview`; `Enter` still escalates |
| Path cannot be resolved (DOM pane, no cwd) | `notice` body naming the unresolved path; `Esc` closes, nothing else fires |
| `read_file` fails (missing, permission) | error text as a `notice`; never throws into the router |
| Dialog closed while the read is in flight | `AbortController` aborts; the resolved value is discarded |
| Opened over Quick Terminal | cwd resolves through `getFocusedWorkingDirectory()`, which already special-cases QT |
| Hint mode found no match | unchanged — existing "No hints found" toast, dialog never opens |

## Out of Scope

- Editing inside the dialog. It is read-only; `Enter` escalates to Helix.
- Search / highlight inside the peeked content.
- Image, PDF, or other binary rendering.
- Any consumer other than hint-mode filepath (the list above is future work).
- A `read_file_head` backend command — the 64 kb cap is applied after a full
  read, so a multi-megabyte file briefly costs its own size in memory. Accepted
  for now; a ranged read is the follow-up if it ever bites.

## Resources

- [VS Code — Code Navigation](https://code.visualstudio.com/docs/editing/editingevolved) — Peek view behaviour, `Esc` dismissal, `editor.stablePeek`
- [Visual Studio — Peek Definition (Alt+F12)](https://learn.microsoft.com/en-us/visualstudio/ide/how-to-view-and-edit-code-by-using-peek-definition-alt-plus-f12?view=vs-2022) — inline peek framing and keyboard model
- [telescope.nvim — key mappings](https://github.com/nvim-telescope/telescope.nvim/blob/master/lua/telescope/mappings.lua) — `Ctrl+D`/`Ctrl+U` preview-scroll convention
- [telescope.nvim #500 — scroll lines in the preview window](https://github.com/nvim-telescope/telescope.nvim/issues/500) — confirms half-page scroll is the default and why line-scroll was requested
