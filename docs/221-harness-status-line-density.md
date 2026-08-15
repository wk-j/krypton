# Spec 221 — Harness Status Line Redundancy Removal

> Status: Implemented
> Date: 2026-08-15
> Milestone: M6 — ACP Harness polish

## Problem

The ACP Harness composer status line (`.acp-harness__composer-meta`) overflows its window: it is built
by unconditional string concatenation, every segment is `flex: 0 0 auto`, and the row has no
`overflow`, so on a half-screen harness the directive chip and project readout are clipped mid-word
and paint outside the window bounds.

Overflow is the symptom. The cause is that **most of the row is already printed somewhere else on the
same screen** — six of its nine readouts duplicate the lane head, the lane stats row, the input line,
or the window footer, and two more carry no information at all in their default state. The row is
~830 px of which ~200 px is unique.

## Solution

Delete the duplicates and the zero-information tokens outright rather than hiding them at narrow
widths. What remains is the ~200 px that has no other home. Then add the structural safety net the row
never had — `overflow: hidden` plus one shrinkable segment (live activity) that ellipsizes to fit — so
the row cannot overflow again as content grows.

## Research

**How the row is built.** `renderComposer()` (`src/acp/acp-harness-view.ts:11262`) emits
`composerStatusChip()` (11356) as one escaped string, then the concise tag (11267), Polly/Salty bypass
chips (11268-11269), `renderDirectiveChip()` (11338), and `renderComposerProjectStatus()` (11584).
CSS: the row is `display: flex` with no wrap and no `overflow` (`src/styles/acp-harness.css:2724`);
`.acp-harness__memory-chip` is `flex: 0 0 auto` (3031). Only `.acp-harness__project-status` can shrink
(3041) — so the *unique* readout is crushed first while the duplicated rigid ones push past the edge.

**The active lane's head and stats row are rendered in every layout.** `renderLaneList()` skips
non-active lanes in Zen Mode (`acp-harness-view.ts:11002`) but still renders the active lane's
`renderLaneHead` (11014) and `renderLaneStats` (11027). `.acp-harness__lane-stats` is
`flex-wrap: wrap` (`acp-harness.css:1308`) — it wraps, it is never hidden. So anything the head or
stats row prints for the active lane is visible whenever the composer is.

**Redundancy audit** — every element of the row, verified against its other rendering site:

| Element | Also rendered at | Verdict |
|---|---|---|
| lane name (`Claude-2 …`) | lane head name `harness-lane-chrome.ts:143`; input line `acp-harness-view.ts:11280` (directly below); window footer lane strip (spec 218) | **4× duplicate → delete** |
| `· Ctrl+C cancel` | lane head cancel hint `harness-lane-chrome.ts:136-140` (superset: also covers `needs_permission` / `awaiting_peer` / pending shell) | **duplicate → delete** |
| `· N tok` | lane stats `in N out N` `harness-lane-chrome.ts:483` | **duplicate → delete** |
| `polly-bypass` chip | lane stats `polly-bypass` `harness-lane-chrome.ts:496` | **duplicate → delete** |
| project cwd (`~/Source/llm-wiki`) | lane stats `basename(projectDir)` `harness-lane-chrome.ts:464`; window footer project badge (spec 219); workspace footer `workspace-footer.ts:812` | **3× duplicate → delete** |
| `◆ default` triage tag | — | **zero-information → delete when source is `default`.** Spec 130 made *all* harness-memory lanes triage-equipped, so `default` distinguishes nothing. A non-default source still renders. |
| `directive none` | — | **zero-information → delete when unset.** A *set* directive still renders; the picker stays reachable via `Cmd+P` `.` and the chip returns the moment one is set. |
| `concise` tag (spec 157) | — | **zero-information → delete.** The collapsed tool cards on the same screen are the mode's own cue and `?` help carries `Cmd+Shift+.`; a permanent chip said only what the transcript already showed. |
| generic `running` verb | spinner on the input line `acp-harness-view.ts:11286`; `--running` chip accent; the ticking `m:ss` beside it; lane head status | **4× duplicate → delete.** Only a *named* operation (`reviewing`, `saving to wiki`) is a readout; it still renders. Kept as a fallback for the one frame where neither clock nor activity is known yet, so the chip is never empty. |
| live activity (`⚒ write …`) | — | **KEEP** — see below |
| `⎇ branch` | workspace footer (focused window only) | **keep** — the only project readout that survives de-focus |
| elapsed `m:ss`, `N queued`, `salty-bypass`, custom command verb, directive **when set** | — | **keep** — unique |

**Correction worth recording: live activity is *not* redundant.** The lane head's activity cell uses
`laneActivity()` (`harness-lane-chrome.ts:517-528`), which returns the **latest transcript row's text**
— a lagging record of what already happened. The composer uses `formatLaneActivity(lane.activity)`
(`harness-format.ts:83`), the **live** activity (`thinking…` / `writing…` / `⚒ <tool title>`). They
look alike in a screenshot because the last transcript row is usually the running tool, but they are
different data and the composer's is the only leading indicator. It stays, and becomes the row's
shrinkable segment.

**Why the branch stays in the composer for now.** It is the one project readout unique to an
*unfocused* harness window (the workspace footer shows only the focused pane; the window footer's
project badge carries the name, not the ref). Moving it to the window footer next to the badge is the
better long-term home, but spec 220's `DiffStatStore` carries counts only — no branch — so it needs a
new per-window branch source. Out of scope here; recorded as follow-up.

**Alternatives ruled out.**
- *Hide by width instead of deleting* (the first draft of this spec: four container-query tiers) —
  keeps ~630 px of duplicated text on wide screens for no gain, and leaves the redundancy in the DOM.
  Deleting is the smaller change and the honest one. One narrow-width rule survives, for the branch.
- *Wrap to two lines* — the composer's height is part of the harness grid; a row that grows on resize
  reflows the transcript.
- *`ResizeObserver` + measured packing* (iTerm2's model) — a second layout pass on every resize and
  every 1 s composer tick, against the <16 ms / idle-CPU budget, to solve a problem that deletion
  solves for free.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | Status-bar items are split Primary (left, workspace-scope) / Secondary (right, contextual) with a numeric priority for order and survival. The UX guidelines lead with *restraint*: "limit the number of items added", short text labels, "avoid more than one item unless necessary", icons only for clear metaphors. | The guidance this spec follows — the first-line defence is fewer items, not smarter packing. |
| iTerm2 | Components have a priority (default 5) and a compression resistance (spring constant) with min/max widths. "Tight packing" drops lowest-priority components first, then sizes survivors in proportion to their springs. | The measured-packing alternative, rejected above; its *one shrinkable spring* idea is kept for the activity segment. |
| tmux | `status-left-length` / `status-right-length` are hard character caps; past the cap a segment truncates and an over-long right status can vanish entirely (tmux#46). | Krypton's current failure mode — a fixed budget with a cliff. |
| WezTerm | `update-status` returns a user-formatted string; no width negotiation at all. | No prior art to borrow. |

**Krypton delta** — none of these tools can deduplicate, because a terminal status bar is the only
status surface on screen. Krypton has four (lane head, lane stats, composer meta, window footer) and
they grew independently, so the highest-value move is one no upstream tool can make: delete what
another surface already says. What is kept is then packed with VS Code's restraint plus a single
iTerm2-style spring, with no measurement pass.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-composer-meta.ts` | **New.** Pure builder: busy lane → `MetaSegment[]`; `renderStatusSegments()` |
| `src/acp/harness-composer-meta.test.ts` | **New.** Segment construction + rendering, incl. omitted-segment cases |
| `src/acp/acp-harness-view.ts` | `composerStatusChip()` returns segments minus lane name / tokens / cancel; drop `renderPollyBypassChip` and the spec-157 `concise` tag from the meta row; `renderDirectiveChip()` returns `''` when unset and omits a `default` triage tag; `renderComposerProjectStatus()` drops the cwd span |
| `src/acp/harness-format.ts` | `formatLaneActivity` truncate cap 32 → 64 (CSS now does the fitting) |
| `src/styles/acp-harness.css` | `overflow: hidden` + `container-type` on the meta row; `.acp-harness__meta-seg` rules and CSS dividers; delete the now-unused `.acp-harness__project-cwd` and `.acp-harness__concise-tag` blocks; one `@container` rule for the branch |
| `docs/72-acp-harness-view.md` | Update the composer chip text at lines 279 / 420 / 430 and the DOM sketch at 339 |
| `docs/157-harness-concise-mode.md` | The `concise` tag is dropped; collapsed cards + `?` help are the cue |
| `docs/README.md` | Index entry |

## Design

### Before / after

```
before  Claude-2 running · 5:12 · ⚒ write wiki/concepts/shaping-the… · 1.2k tok · 2 queued ·
        Ctrl+C cancel   CONCISE   · directive none ◆ default   · ~/Source/llm-wiki ⎇ main
                                                                                    (~830 px)

after   5:12 · ⚒ write wiki/concepts/shaping-the-agent-loop.md · 2 queued   ⎇ main
                                                                                    (~200 px)

        (a custom command keeps its named verb: `reviewing · 0:41 · ⚒ read src/…`)
```

Idle is unchanged (`memory: 3/3`), as are the command-mode, open-hint, peer-wait, starting, and
memory-warning strings — they were never the overflow and each is the only copy of its message.

### Data Structures

```ts
// src/acp/harness-composer-meta.ts
export type MetaSegId = 'verb' | 'elapsed' | 'activity' | 'queued' | 'text';

export interface MetaSegment { id: MetaSegId; text: string }

/** Busy lane → ordered segments. Every other chip state collapses to one `text` segment. */
export function buildStatusSegments(input: StatusInput): MetaSegment[];

/** `<span class="acp-harness__meta-seg" data-seg="…">` — separators come from CSS. */
export function renderStatusSegments(segs: MetaSegment[]): string;
```

`this.chip` (flash overrides such as `lane idle — Enter to send`) and every non-busy branch return
`[{ id: 'text', text }]` — one segment, never dropped, ellipsized if long.

### UI Changes

```html
<span class="acp-harness__memory-chip acp-harness__memory-chip--running">
  <!-- data-seg="verb" only for a named operation (reviewing / saving to wiki), or as
       the empty-chip fallback before the clock and the activity are known -->
  <span class="acp-harness__meta-seg" data-seg="elapsed">5:12</span>
  <span class="acp-harness__meta-seg" data-seg="activity">⚒ write wiki/concepts/shaping-…</span>
  <span class="acp-harness__meta-seg" data-seg="queued">2 queued</span>
</span>
```

The ` · ` divider becomes `.acp-harness__meta-seg + .acp-harness__meta-seg::before`, so an omitted
segment takes its divider with it and no `· ·` can appear. Same pseudo-element idiom and dim
accent-mix colour as the existing chip dividers (`acp-harness.css:3022-3028`); no left-edge rails.

```css
.acp-harness__composer-meta { container-type: inline-size; overflow: hidden; }
.acp-harness__memory-chip   { flex: 0 1 auto; min-width: 0; display: inline-flex; overflow: hidden; }
.acp-harness__meta-seg      { flex: 0 0 auto; white-space: nowrap; }
.acp-harness__meta-seg[data-seg='activity'],
.acp-harness__meta-seg[data-seg='text'] { flex: 0 1 auto; min-width: 0;
                                          overflow: hidden; text-overflow: ellipsis; }

/* The last width-gated readout: on a third-width window the branch yields to the
   activity text. It is the one segment with an off-screen fallback (the workspace
   footer, once this window is focused). */
@container (max-width: 480px) { .acp-harness__project-branch { display: none; } }
```

`activity` is the single spring — it absorbs the squeeze, and nothing else can be dropped because
nothing else is redundant. Raising `formatLaneActivity`'s cap to 64 chars lets a wide window show more
of the tool title than today while a narrow one ellipsizes; the cap is now only a paste-bomb guard.

### Data Flow

```
1. Lane state changes, or the 1 s composer tick fires
2. composerStatusChip(lane) → MetaSegment[]         (pure, unit-tested)
3. renderStatusSegments() → span HTML; renderComposer() writes composerEl.innerHTML
4. Browser resolves overflow/ellipsis against the row's own width
5. Window resize → @container re-evaluates the branch rule; no JS involved
```

No new IPC, no new state, no `ResizeObserver`, no extra render pass.

### Keybindings / Configuration

None. No behaviour changes — only which readouts render.

## Edge Cases

- **Permission mode.** `.acp-harness__composer--permission .acp-harness__composer-meta` already
  overrides to `flex: 0 0 auto` + ellipsis (2627) and renders only the `perm` label; kept as-is.
- **Salty bypass stays in the composer.** `renderLaneStats` prints `polly-bypass` (496) but has no
  salty equivalent, so deleting the salty chip would lose a safety readout entirely. Adding it to the
  lane stats row instead is a spec 195 change, not this one.
- **Directive picker discoverability.** With `directive none` gone, an unset lane shows no directive
  chip. The picker stays on `Cmd+P` `.` and in the help overlay, and the chip reappears permanently
  once a directive is set. This is the one deletion that removes an affordance rather than a duplicate
  — see Open Questions in the review notes if that trade is unwanted.
- **Command mode / open-hint strings** (11357-11358) become one `text` segment — shrinkable and
  ellipsized instead of overflowing. A strict improvement at every width.
- **Zen mode / view split** narrow the composer further; both inherit the same rules, and the active
  lane's head + stats (the surfaces this spec leans on) render in both.
- **Live Assist** (spec 208) has its own composer and is untouched.
- **Thai / RTL text** — segments are `nowrap` + ellipsis; no `word-break` change.
- **No activity yet** — the segment is omitted entirely, not rendered empty, so no stray divider.
- **`container-type: inline-size` implies `contain: layout style`** on the meta row. It has no
  absolutely-positioned descendants (the mention/slash/hash palettes are siblings inside
  `.acp-harness__composer`), so no containing-block shift.

## Out of Scope

- **Moving `⎇ branch` to the window footer** next to the project badge. Better long-term home, but
  needs a per-window branch source that spec 220's counts-only store does not provide. Follow-up.
- The lane head, lane stats, and window footer rows themselves — specs 215 / 218 / 219 / 220 own them.
  This spec only *reads* them to justify each deletion.
- Adding a salty-bypass cell to `renderLaneStats` (spec 195's territory).
- User-configurable priority or a status-line format string (tmux / WezTerm style).

## Resources

- [VS Code — Status Bar UX guidelines](https://code.visualstudio.com/api/ux-guidelines/status-bar) — the restraint-first guidance (few items, short labels) behind deleting rather than packing.
- [iTerm2 — Status Bar documentation](https://iterm2.com/documentation-status-bar.html) — priority + compression-resistance packing; the measured alternative rejected here, and the source of the single-spring idea.
- [tmux issue #46 — right status bar disappears with long text](https://github.com/tmux/tmux/issues/46) — the hard-cap cliff this spec avoids.
- [MDN — CSS container queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries) — `container-type: inline-size` semantics and implied containment.
