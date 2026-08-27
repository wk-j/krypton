# Harness Tool Output Palette — Implementation Spec

> Status: Implemented
> Date: 2026-08-24
> Milestone: ACP Harness visual polish
> Related: `docs/72-acp-harness-view.md`, `docs/231-lane-peek-action-hud.md`
> Prototype: `docs/prototypes/235-harness-tool-output.html`

## Problem

Harness tool cards paint stdout/output/content as one cyan wash (`--agent-user` `#6dd0ff` plus a cyan `text-shadow` fallback). Execute is the most common kind, so grep, sed, and file lists all read as the same blue dump. Kind chips are a gray outline, so a search and a shell look identical once the glyph ticks. The 2px left rail on `.acp-harness__tool-output` is also a banned side-stripe.

## Solution

Keep chrome cyan. Stop using cyan as the dump body color.

1. **Kind chip** reuses the spec 231 HUD accent (chip text + 1px border only, not a filled pill).
2. **Section body** is foreground phosphor. Labels keep semantic color (error red, summary green, diff gold). `output` / `stdout` / `content` / `text` drop the cyan mapping.
3. **Recognized dumps** get the same cheap structure git already has: path, line number, separator, text. Grep/rg (and execute wrapping them) split `path:line:text` and `line:text`. Execute dumps that start with `exit: N` (Grok Bash `output_for_prompt`) peel that line and paint a quiet **exit readout** on the first OUTPUT/TERMINAL label — muted tabular number for 0, danger color for non-zero, no kind-chip frame — instead of leaving `exit: 0` as dump text. Unknown output stays a plain `<pre>`.
4. **Drop the 2px left rail.** Indent stays (`margin-left: calc(1.4ch + 8px)`). No inner card, no background glow.

No highlight.js. No language grammar. Line-oriented regex only, same budget as `parseGitDiffStat`.

## Research

- `renderPlainToolSection` tints the entire `<pre>` through `--acp-tool-section-color`. `toolSectionTone("output"|"stdout"|"text")` → `output` → `--agent-user`. `--content` is `#b8e0ff`. The body `text-shadow` fallback is hardcoded `rgba(109, 208, 255, 0.78)` even when the section is not output.
- Git already escaped the cyan wall: add/del/hunk tones in `renderUnifiedGitDiff` / `renderGitDiffStat` / `renderGitStatusShort`. File headers and stat paths are still cyan (`rgba(109, 208, 255, …)`).
- Spec 72: "plain monospace text, not syntax-highlighted code" and "label-specific text colors and text-shadow glow only; the group container does not add a background glow." The glow-only rule stays. The "not syntax-highlighted" rule is updated to allow *structure* tokens (path/line), not language highlighting.
- Spec 231 already assigned kind accents: edit gold, search green, execute/read cyan, fetch info, move magenta, delete red. Transcript chips must match so a search in the rail and a search in the thread are the same color.
- DESIGN.md / PRODUCT.md: no side-stripe (`border-left` > 1px), no nested cards, colors through tokens, cyan is chrome not content.

**Alternatives ruled out**

- *Repaint execute HUD away from cyan* — out of scope; the dump body is the problem, not the 7-letter chip.
- *highlight.js on every dump* — file-manager already owns that; 6–12 line previews would look like an editor nested in the thread, and Spec 72 forbade it.
- *Tint the whole section by kind* — a green grep wall is the same bug in another hue.
- *Box the output* — nested container ban; Spec 72 already forbids a section background glow.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Claude Code CLI | Execute + output in one cyan stream | The boring blue wall this spec rejects |
| ripgrep / bat | Path, line, match as separate tones | Structure, not language syntax |
| Zed Agent Panel | Tool kind label + muted body | Kind is scannable; body is not neon |
| GitHub PR files | Path gold/gray, +/- green/red | Same split Krypton already uses for git |
| Krypton git tool cards | File/hunk/add/del rows | Precedent for structure; grep should match |

**Krypton delta** — cyan stays on chrome, execute/read chips, and links. Dump body is foreground. Structure tokens use the existing semantic palette (gold path, muted line, green match when the query is known). Grep becomes a sibling of git-stat, not a code highlighter.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-tool-render.ts` | `data-kind` on the chip; structure parser + renderer for grep/rg; `renderToolOutput` tries structure before plain; path tokens in git-stat / unidiff file headers. |
| `src/acp/harness-tool-render.test.ts` | **New.** Parser cases, kind chip attribute, no-match fallback to plain `<pre>`. |
| `src/styles/acp-harness.css` | Kind-chip accents; section `--output`/`--content` → foreground; token colors; drop 2px left rail; git path cyan → gold. |
| `docs/72-acp-harness-view.md` | Tool rows: structure tokens for grep/rg/git; body is foreground; no side-stripe. |
| `docs/README.md` | Index. |
| `docs/prototypes/235-harness-tool-output.html` | Before / after of execute grep, search, read, fail, git. |

## Design

### Kind chip

`renderToolBody` sets `kind.dataset.kind` from the same map spec 231 uses (`search`/`execute`/`edit`/`read`/`fetch`/`delete`/`move`/`other`). CSS colors text + border from the HUD accent. Background stays transparent. Gray outline remains the fallback for unknown kinds.

### Section tones

| Label | Tone | Color |
|-------|------|-------|
| stderr / error / message | `error` | danger (unchanged) |
| summary | `summary` | success (unchanged) |
| diff | `diff` | warning (unchanged) |
| terminal | `terminal` | special (unchanged) |
| stdout / output / text / content | `output` | **foreground**, not cyan |
| other | `default` | lane accent at low mix into foreground |

Body `color` is `var(--krypton-fg)` (or `--agent-text`). Glow on the body is dropped. Label glow stays at the section color, including a muted foreground for `output`.

### Structure tokens

Tried in `renderToolOutput` after the existing git-stat / unidiff / git-status rich path, for `stdout`/`output`/`content` when the tool is `search` **or** the command matches `\b(rg|grep|ag|ack)\b`.

Line shapes (majority of non-empty lines must match, else plain `<pre>`):

```
path:line:text          → tok-path  tok-sep  tok-line  tok-sep  tok-text
path:line:col:text      → same, col folded into tok-line as `12:4`
path-line-text          → context line (rg `-B`/`-A`); path dimmer, no hit
^line:text$             → single-file `grep -n`; no path token
```

If `extractGrepQuery(command)` finds a quoted pattern, wrap occurrences in `tok-hit` (success). No query → no hit span. Paths / line numbers / separators are always tokens when the shape matches.

Grok's ACP `rawOutput` is a **typed variant** (`rawOutput.type`), not a generic stdout blob. `grokRawOutputSections` switches on that tag and pulls the human-readable field. Unknown types return `null` and fall through to the generic `summary/stdout/stderr/output/content/text/message` walker. Protocol wrappers are stripped by **shape**, not inferred kind: `<workspace_result>` even when the 6-line cap dropped the close tag, and `N→` read-file anchors when the dump starts with one (kind can be missing on a `tool_call_update`).

| `rawOutput.type` | Dump field | Notes |
|------------------|------------|-------|
| `ReadFile` | `FileContent.content` / `FileNotFound` | Strip `N→`. Skip `ImageContent` bytes. |
| `GrepSearch` | `file_matches` → path + `line:text` | Fallback: decode `stdout` bytes, unwrap XML. |
| `ListDir` / `WebFetch` | `Content.content` | |
| `Bash` | `output_for_prompt`, else decoded `output` | Peel `exit: N`. Chip from `exit_code`. |
| `MCP` | `output.OkayOutput` / `output.Error` | `is_error` → error tone. |
| `SearchTool` | `content` | |
| `Todo` | `TodosUpdated.summary_for_prompt` | |
| `SearchReplace` | _(none)_ | Diff lives in ACP `content`. |
| `BackgroundTaskStarted` | `summary` | |
| `TaskOutput` | `Result.output` | |
| `Text` | `text` | |
| `KillTask` | `Result.message` | |
| `ImageGen` | `path` | |

Coverage lock: `GROK_RAW_OUTPUT_TYPES` + one fixture per type in `harness-tool-render.test.ts`. Re-scan `~/.grok/sessions/**/updates.jsonl` `rawOutput.type` when Grok adds a variant.

Token colors (themeable, no raw hex in the renderer):

| Token | Token path |
|-------|------------|
| `tok-path` | `--krypton-warning` |
| `tok-line` | `--krypton-fg` @ 0.42, `tabular-nums`, right-aligned in a ≥4ch gutter |
| `tok-sep` | `--krypton-fg` @ 0.28 |
| `tok-text` | `--krypton-fg` |
| `tok-hit` | `--krypton-success` |
| `tok-ctx` | `--krypton-fg` @ 0.55 (rg context lines) |

Git-stat paths and unidiff `diff --git` headers switch from cyan to `tok-path` (warning). Add/del/hunk colors stay.

Each span is filled with `textContent`. No `innerHTML` of the dump.

Grep rows are a five-column grid (path · sep · line · sep · text). The line track is `minmax(4ch, max-content)`, `tabular-nums`, right-aligned, so `75` and `160` form a gutter (same trick as git-stat's 5ch count column). Line-only dumps (`grep -n` with no path) use the three-column `--lineno` template and the same gutter.

### Exit status

Grok Bash wraps every dump as `exit: N\n<body>` and also sends `rawOutput.exit_code`. Structured `exit_code` wins; the prefix is stripped **before** the 12-line cap so it does not steal a content line. Execute cards paint:

```
.acp-harness__tool-section-label   → "output" | "terminal" | …
  .acp-harness__tool-exit[data-status=ok|fail]
    span.tool-exit-label   → "exit"
    span.tool-exit-code    → tabular-nums, no border, no weight jump
```

Rides the first labeled section (`output` / `stdout` / `terminal` / grep) so `TERMINAL` and `exit 0` share one line. Git-rich dumps have no section label, so the readout stays a row above the files. A dump that is only `exit: 1` still shows that row. 0 → muted foreground. Non-zero → `--agent-error` on the number. Search/read never get the readout (`grep` miss is exit 1). Concise mode still hides the whole output group.

### Chrome

```
.acp-harness__tool-output {
  margin-left: calc(1.4ch + 8px);
  padding: 3px 0 3px 0;   /* no 8px + 2px rail */
  border-left: none;
  font-size: var(--krypton-font-size, 13px);  /* same as conversation */
}
```

Dump body (plain `<pre>`, grep rows, git-rich) inherits that size. Kind chips, `OUTPUT`/`exit` labels, and timers stay chrome-scale (`0.7em` / `0.78em`). The tool-card `0.88em` shrink does not apply to the payload.

## Edge Cases

- Mixed dumps (3 grep lines + a banner) that fail the majority-match rule stay a plain `<pre>` in foreground. No half-highlighted block.
- `exit: N` is peeled only when it is the first line of a `stdout`/`output` section. A script that prints that string later in the dump is left alone.
- Search dumps are capped at 6 lines **after** stripping the Grok envelope, so a missing `</workspace_result>` (the close tag fell off the cap) still unwraps.
- ANSI is still stripped in `boundedOutputLines` before parse.
- Line cap unchanged (execute 12, grep-as-search 6, git-diff 80).
- Concise mode still hides `__tool-output` entirely.
- Live Assist does not reuse this renderer; no change there.
- Light theme: tokens go through `--krypton-*`, not hardcoded dark-only cyan.

## Out of Scope

- Recoloring the spec 231 action HUD.
- Language syntax highlighting (JS/Java/TOML) inside dumps.
- Changing assistant markdown heading cyan.
- Boxing or background-glowing the output group.

## Resources

- `src/acp/harness-tool-render.ts` — current dump + git rich path
- `src/styles/acp-harness.css` — `--acp-tool-section-color`, HUD kind accents
- `docs/72-acp-harness-view.md` — existing "plain monospace / no syntax highlight" rule
- `docs/231-lane-peek-action-hud.md` — kind accent map
- DESIGN.md 1.2.1 — side-stripe ban
- Claude Code CLI execute stream — the cyan wall this rejects
