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
3. **Recognized dumps** get the same cheap structure git already has: path, line number, separator, text. Grep/rg (and execute wrapping them) split `path:line:text` and `line:text`. Unknown output stays a plain `<pre>`.
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

Token colors (themeable, no raw hex in the renderer):

| Token | Token path |
|-------|------------|
| `tok-path` | `--krypton-warning` |
| `tok-line` | `--krypton-fg` @ 0.42, `tabular-nums` |
| `tok-sep` | `--krypton-fg` @ 0.28 |
| `tok-text` | `--krypton-fg` |
| `tok-hit` | `--krypton-success` |
| `tok-ctx` | `--krypton-fg` @ 0.55 (rg context lines) |

Git-stat paths and unidiff `diff --git` headers switch from cyan to `tok-path` (warning). Add/del/hunk colors stay.

Each span is filled with `textContent`. No `innerHTML` of the dump.

### Chrome

```
.acp-harness__tool-output {
  margin-left: calc(1.4ch + 8px);
  padding: 3px 0 3px 0;   /* no 8px + 2px rail */
  border-left: none;
}
```

## Edge Cases

- Mixed dumps (3 grep lines + a banner) that fail the majority-match rule stay a plain `<pre>` in foreground. No half-highlighted block.
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
