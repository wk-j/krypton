# Harness Concise Mode — Implementation Spec

> Status: Implemented
> Date: 2026-06-13
> Milestone: M6 — ACP Harness

## Problem

A busy lane transcript is dominated by machinery rows — tool-call cards, thinking, fs-activity, memory writes — and the actual conversation (user prompt → agent response) drowns in them. When the user wants to *read* the exchange rather than *audit* it, there is no way to strip the noise.

## Solution

Add a view-wide **concise mode** toggled with `Cmd+Shift+.` (sibling of Zen Mode's `Cmd+.`). When on, the root element gets `.acp-harness--concise` and CSS collapses every tool card to its existing single-line head (glyph + kind + subject + result + timer) by hiding the detail children (`__tool-output`, `__tool-diffs`, `__artifact-redaction`); pure side-channel kinds (`thought`, `fs_activity`, `memory`) are hidden entirely. No transcript data is touched, no rendering path changes — streaming parsers keep mutating collapsed rows, and toggling back reveals everything instantly. State persists per-project in `localStorage`, same as Zen Mode.

## Research

- All transcript rows carry `.acp-harness__msg--${kind}` modifiers (renderer `renderTranscriptItem`, `acp-harness-view.ts:9322`), so a root-class CSS toggle can target kinds precisely with zero per-row JS.
- The tool card already has a natural one-line summary: `renderToolBody` (`acp-harness-view.ts:9838`) appends a `.acp-harness__tool-head` flex row (glyph, kind badge, subject, result, live timer) first, then the detail blocks as siblings — so "single-line tool card" is purely hiding the siblings, no new summary renderer needed.
- The streaming fast path (`acp-harness-view.ts:6309-6330`) mutates row bodies in place; removing rows from the DOM would break the spec-117 parser-binding invariant. **CSS hide was chosen over render-time filtering for exactly this reason** — `display: none` keeps every row alive for the parser and the render-signature dedupe.
- Zen Mode (spec 80) is the established per-view toggle precedent: boolean field, `localStorage` key `krypton:acp-harness:zen:${projectDir}`, root-class toggle at the two render sites (`acp-harness-view.ts:6067`, `6132`), help entry at `7485`.
- Zen's binding at `acp-harness-view.ts:2423` requires `!e.shiftKey`, so `Cmd+Shift+.` is free and unambiguous.
- The spec-156 activity ticker already surfaces the running tool name in the busy chip, so live tool feedback survives even with tool cards hidden — good synergy.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code CLI | Tool results collapsed to one-line summaries by default; `Ctrl+O` toggles verbose transcript | Toggle is global, keyboard-driven |
| Zed agent panel | Tool calls render as collapsed cards, expanded per-card by click | Mouse-driven disclosure |
| Cursor | Tool detail folded behind "Ran tool" rows | Per-row, mouse-driven |
| ChatGPT web | Work/tool detail hidden behind a "Thought for Ns" disclosure | Hidden by default, per-block |

**Krypton delta** — closest to the Claude Code CLI model: machinery collapses to one-line summaries behind a single keyboard toggle. Diverges from Zed/Cursor by having no per-card mouse disclosure (view-wide toggle only), and unlike all of them the one-liner is the *existing* tool head — live timer and result included — not a separate stub renderer.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | `conciseMode` field + storage helpers, key handler, root-class toggle at both render sites, composer chip token, help entry |
| `src/styles/acp-harness.css` | `.acp-harness--concise` hide rules, `concise` chip token style |
| `docs/72-acp-harness-view.md` | Keybinding table + concise-mode behavior note |
| `docs/PROGRESS.md` | Milestone entry |

## Design

### Collapsed vs. hidden vs. visible kinds

| Kind | Concise treatment | Why |
|---|---|---|
| `tool` | **Collapsed to one line** — head only (glyph, kind, subject, result, timer); `__tool-output`, `__tool-diffs`, `__artifact-redaction` hidden | User still sees *what* ran and whether it succeeded, just not the payload |
| `thought` | Hidden | Reasoning, not response; no useful one-line head |
| `fs_activity` | Hidden | Tool side-channel, duplicates the tool row |
| `memory` | Hidden | Tool side-channel |

| Stays fully visible | Why |
|---|---|
| `user`, `assistant` | The conversation |
| `permission`, `fs_write_review` | **Interactive** — hiding them would silently deadlock a waiting lane |
| `provider_error` | Failures must always surface |
| `inter_lane` | Peer mail is conversation, not machinery |
| `artifact` | Deliverable the user opens (`f` hint mode keeps working) |
| `system`, `restart`, `shell` | Structural markers + user-initiated shell rows |

### State & persistence

```ts
private conciseMode = false; // init: readConciseModePreference(projectDir)
// localStorage key: `krypton:acp-harness:concise:${projectDir ?? ''}`
```

Helpers `conciseModeStorageKey` / `readConciseModePreference` / `writeConciseModePreference` mirror the zen trio at `acp-harness-view.ts:8734-8749`. View-wide (all lanes), per-project, survives reopen.

### Keybinding

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+Shift+.` | Anywhere in harness view | Toggle concise mode |

Handler inserted directly below the zen branch (`acp-harness-view.ts:2423`). With Shift held, macOS reports the shifted character, so match both: `(e.key === '.' || e.key === '>') && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey`. `toggleConciseMode()` flips the flag, persists, calls `this.render()` (same shape as `toggleZenMode`, `8470`). Help `<dl>` (`7485`) gains `<dt>Cmd+Shift+.</dt><dd>Toggle Concise Mode</dd>`.

### UI Changes

Root class applied beside the zen toggle at both render sites (`6067`, `6132`):

```ts
this.element.classList.toggle('acp-harness--concise', this.conciseMode);
```

CSS:

```css
/* tool cards: keep the head row, drop the detail */
.acp-harness--concise .acp-harness__msg--tool .acp-harness__tool-output,
.acp-harness--concise .acp-harness__msg--tool .acp-harness__tool-diffs,
.acp-harness--concise .acp-harness__msg--tool .acp-harness__artifact-redaction {
  display: none;
}
/* single-line guarantee: the head normally flex-wraps and the subject
   word-breaks; in concise it must stay one line, ellipsized */
.acp-harness--concise .acp-harness__tool-head { flex-wrap: nowrap; }
.acp-harness--concise .acp-harness__tool-subject {
  white-space: nowrap;
  word-break: normal;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* side-channel kinds: hidden entirely */
.acp-harness--concise .acp-harness__msg--thought,
.acp-harness--concise .acp-harness__msg--fs_activity,
.acp-harness--concise .acp-harness__msg--memory {
  display: none;
}
```

Discoverability: `composerStatusChip()` (`7251`) appends a muted `concise` token (`.acp-harness__concise-tag`, chrome-label typography, no left border per house rules) so the user always knows why machinery rows are absent — important because the flag persists across reopen.

### Data Flow

```
1. User presses Cmd+Shift+. anywhere in the harness view
2. onKeyDown matches, calls toggleConciseMode()
3. Flag flips, writeConciseModePreference persists it, this.render() runs
4. Render sites toggle .acp-harness--concise on the root element
5. CSS collapses tool cards to their head line and hides side-channel rows; streaming/dedupe logic untouched (all rows and detail nodes stay in DOM)
6. Composer chip shows/clears the `concise` token
```

## Edge Cases

- **Streaming while collapsed/hidden** — parser keeps writing into `display: none` nodes; on toggle-off the fully streamed content is simply revealed. No parser teardown.
- **Live tool timer** — the timer span lives in the head, which stays visible; the existing tick updater keeps finding it. A running tool still reads `◆ bash npm test 2.3s` live.
- **Long tool subjects** — head normally flex-wraps and `word-break: break-all`s; concise overrides to `nowrap` + ellipsis so the card is genuinely one line.
- **Scroll anchor** — `this.render()` re-anchors via the existing capture/restore in `renderActiveTranscript`; a stick-to-bottom lane re-pins automatically because hiding rows only shrinks scrollHeight.
- **Spec-103 hidden-row indicator** — `↑ N earlier rows hidden` counts transcript rows, not visible ones; in concise mode N can exceed what toggling Ctrl+H appears to reveal. Accepted; documented in docs/72.
- **Lane peek (109) / triage / review overlays** — render their own surfaces outside `.acp-harness__lane-body`; unaffected.
- **Pending permission mid-stream** — `permission` rows stay visible, so a lane never waits on an invisible prompt.

## Open Questions

None — resolved during design (see hidden/visible table and keybinding choice).

## Out of Scope

- Per-lane concise state (view-wide only, matching zen).
- Fully hiding tool rows (first draft; rejected — the one-line head must stay visible).
- Per-card expand of a single collapsed tool card — toggle the whole view off instead.
- Hiding `shell` rows (user-initiated; revisit if they prove noisy).
- TOML config key for a default — localStorage persistence is sufficient, matching zen.

## Resources

- `docs/72-acp-harness-view.md`, `docs/80-*` (zen mode), `docs/103-*` (transcript window), `docs/117-*` (streaming markdown), `docs/156-lane-activity-ticker.md` — internal prior art that shaped the toggle/persistence/streaming constraints.
- Prior-art table from direct product knowledge of Claude Code CLI, Zed, Cursor, ChatGPT; no external API constraints apply — purely internal CSS/DOM change.
