# Active-Lane → Window Accent — Implementation Spec

> Status: Implemented (rev. 3 — cascade scope corrected during implementation; user-approved 2026-06-04)
> **Rev. 3 (implementation finding):** the `data-signal` `--krypton-window-accent-rgb` retarget (`window.css:40-44`) is a **normal** stylesheet declaration, while the compositor sets `--krypton-window-accent-rgb` as a **normal inline** style on every window (`compositor.ts:1597/1788`). Inline normal beats stylesheet normal, so the signal `-rgb` override is **already dominated on every window today** (the original spec-104 design used a separate `--krypton-color-signal` var, docs/104:88-91; the shipped code retargets the accent var instead). Rev. 2 planned to add `!important` to the signal rules so the signal would win over the lane base — but that would **globally activate the currently-dormant signal-border recolor on all windows**, which is out of scope for "harness tracks active lane." So `!important` is scoped to the **lane rules only** (they match exclusively when the harness sets `data-lane-accent`); the signal rules are left unchanged. Consequence: the harness window wears its active lane's identity color, and a status signal does **not** recolor that window's border (consistent with today — it never did). See Open Question O2 + the flagged decision.
> Date: 2026-06-04
> Milestone: M-ACP — Harness Multi-Agent
> Related: `docs/105-view-protocol.md` (the `data-signal` window-accent override this layers under), window accent allocation in `src/compositor.ts`
> Reviewed by: Codex-1 (pre-implementation). **Rev. 2 folds:** High 1 — drop the remove-inline plan (it leaks the wrong base accent when a harness pane is disposed but the host window survives & promotes a sibling, `compositor.ts:4008-4016`); use author `!important` on both the lane and signal custom-property declarations instead — beats the compositor's normal inline vars, no restore path. High 2 — `closeActiveLane()` bypasses `activateLane()` (direct `activeLaneId` writes at `acp-harness-view.ts:5014`/`:5022`); route both through the new helper. Med — removed vague "restore via compositor" (private API) wording. Low — tightened signal wording: signal retints only `-rgb`-driven surfaces (border, edge glow, corner *glow*); solid-hex surfaces (dot, accent bar, corner L-mark fill at `window.css:63`) keep lane identity. Low — derive slot from `lane.index`, never `lane.accent` (slot 1 is the self-referential var).

## Problem

In the ACP harness view the host Krypton window wears a single accent color assigned once at window creation by the compositor's palette allocator. It has no relationship to the lanes inside. The user wants the **host window's accent (status dot, border, corner L-marks, glow, accent bar) to track the currently active ACP lane** — switch the active lane and the whole window re-tints to that lane's identity color, so the window's chrome tells you at a glance which backend lane you are driving.

Each lane already owns a stable identity color (`laneAccent(index)`), consumed today only by lane-scoped surfaces *inside* the harness (`--acp-lane-accent`). Nothing propagates it up to the `.krypton-window` host element.

## Solution

When the active lane changes, set a `data-lane-accent="<slot 1–10>"` attribute on the host `.krypton-window` element. A small CSS palette maps each slot to concrete `--krypton-window-accent` (hex) **and** `--krypton-window-accent-rgb` (tuple) values. The harness reaches the host via `this.element.closest('.krypton-window')` from inside `activateLane()` (the single funnel for lane focus changes) and on teardown removes the attribute so the window reverts to its compositor-allocated color.

This is a **layered** accent model on the window element:

1. **Base / identity layer** — `data-lane-accent` sets the window's accent to the active lane's color. This is the steady-state color.
2. **Signal layer (existing, left unchanged)** — `docs/105-view-protocol.md`'s `data-signal` rules (`window.css:40-44`) are **normal** declarations that retarget `--krypton-window-accent-rgb`. Because the compositor sets that var as a normal **inline** style on every window, those rules are already dominated (see rev. 3 note) — the signal does not recolor the window border today, on any window. We deliberately do **not** change that (adding `!important` would globally activate it). Status continues to be surfaced through the pane edge-glow / dot, not the window accent.

The result: the harness window wears the active lane's identity color steadily; we are not coupling the window border to lane status in this spec. (Coupling status → window border is a separate, opt-in change — see O2 / the flagged decision.)

### Why NOT inline style from the harness (the central pitfall)

The obvious implementation — `windowEl.style.setProperty('--krypton-window-accent-rgb', laneRgb)` — is **wrong** and would regress the view protocol. Inline style declarations have higher cascade priority than the `.krypton-window[data-signal='…']` attribute-selector rules, so an inline `--krypton-window-accent-rgb` would permanently win and the status-signal coloring (`docs/105`) would silently stop working. Instead the base color is driven through a `data-lane-accent` attribute + **`!important`** stylesheet rules (see "Cascade resolution" below), which keeps the signal layer working and needs no inline writes from the harness.

### Second pitfall — self-referential slot 1

`laneAccent()` slot 1 returns the literal string `var(--krypton-window-accent, #0cf)` (`acp-harness-view.ts:9636`). Feeding that back into `--krypton-window-accent` is a self-reference → the custom property becomes invalid at computed-value time. The CSS palette rules therefore use the **concrete** color for that slot (`#00ccff` / `0, 204, 255`, the window default cyan), never the var.

## Research

Findings from `src/acp/acp-harness-view.ts`, `src/styles/window.css`, `src/compositor.ts`:

- **Lane identity color is stable and index-derived.** `laneAccent(index)` (`acp-harness-view.ts:9634`) is a fixed 10-color palette; a lane's `accent` is assigned once at creation (`acp-harness-view.ts:~3204`) and never mutated. The active palette slot is `((index - 1) % 10) + 1`.
- **`activateLane(id)` is the single funnel** for focus changes (`acp-harness-view.ts:7614`): sets `this.activeLaneId = id` then `this.render()`. All switch call-sites (peek click, triage selection, Ctrl+n/p cycle, session load) converge here.
- **The harness root is nested in the window:** `.krypton-window > .krypton-window__content > .krypton-tab-wrapper > .krypton-pane > .acp-harness`. The harness root is `this.element`; `this.element.closest('.krypton-window')` reaches the host (`compositor.ts:~3668`).
- **Window chrome reads two vars.** `--krypton-window-accent` (solid: dot, accent bar) and `--krypton-window-accent-rgb` (rgba: border, focus glow, corner marks, scanline, footer — 15+ uses in `window.css`). Both must be set or the chrome de-syncs (dot one color, border another).
- **`data-signal` already drives `-rgb`.** `window.css:40-44` re-targets `--krypton-window-accent-rgb` per `data-signal` value (view protocol, spec 105). The harness already sets `data-signal` on its host window. This is the layer the new base color sits beneath.
- **Compositor owns the initial color** via `applyAccentColor()` / `windowColorIndex` / `usedColorIndices` (`compositor.ts:1520-1555`), set as inline style on the window at creation. `data-lane-accent` (stylesheet) does **not** override that inline base by specificity — so we must set the lane vars in the same place the signal layer does (attribute + stylesheet) and ensure the lane rule beats the compositor's inline base. **Open question O1 below** resolves how (see "Cascade ordering").

**Alternatives ruled out:**
- *Inline style on the window from the harness* — clobbers the `data-signal` layer (see pitfall above). Rejected.
- *A new compositor public API `setWindowAccent(id, hex, rgb)` the harness calls* — cleaner ownership, but it writes inline style (same clobber problem) unless it also routes through an attribute, and it requires the harness to know its host `windowId` (not currently threaded to the content view). More plumbing for no benefit over the attribute. Deferred; revisit only if multiple non-harness views want programmatic accent control.
- *Mutating each lane's `--acp-lane-accent` to also paint the window* — `--acp-lane-accent` is per-lane-element scoped, not on the window; wrong altitude. Rejected.

## Prior Art

Editors that color-code the active context in chrome: VS Code's `workbench.colorCustomizations` / Peacock extension tints the window by workspace; tmux colors the active pane border. Krypton delta: the tint is driven by the **active backend agent lane**, layered beneath a transient status-signal color, all through CSS custom properties on one host element.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add a private helper `applyActiveLaneAccent()`: look up `this.activeLane()`; if present resolve `const slot = ((lane.index - 1) % 10) + 1` (from `lane.index`, **never** `lane.accent` — slot 1 is the self-referential var) and set `hostWindowEl.dataset.laneAccent = String(slot)` via `this.element.closest('.krypton-window')` (guard null — not mounted in tests); if absent (`activeLaneId === ''`) `delete hostWindowEl.dataset.laneAccent`. Call it from: (a) `activateLane(id)` after the `activeLaneId` assignment; (b) **`closeActiveLane()`** after **both** branches reassign `activeLaneId` (`:5014` empty / `:5022` next) — this path bypasses `activateLane` (Codex-1 High 2); (c) initial mount/render when a lane already exists. In `dispose()`, `delete hostWindowEl.dataset.laneAccent` (inline compositor vars remain underneath → window reverts). Consider extracting a `setActiveLaneId(id)` that wraps the assignment + `applyActiveLaneAccent()` so future active-lane writes can't bypass it. |
| `src/styles/window.css` | Add the 10-slot lane palette as `.krypton-window[data-lane-accent='N'] { --krypton-window-accent: <hex> !important; --krypton-window-accent-rgb: <r,g,b> !important; }` rules, placed before the existing `data-signal` rules. **Leave the `data-signal` rules unchanged** (no `!important`) — see "Cascade resolution". |
| `docs/PROGRESS.md`, `docs/04-architecture.md` | Doc sync — note the harness host window tracks the active lane accent, layered under the view-protocol signal. |

### The slot palette (concrete values)

Mirrors `laneAccent()` (`acp-harness-view.ts:9634`), slot 1 resolved to concrete cyan:

| slot | hex | rgb |
|------|-----|-----|
| 1 | `#00ccff` | `0, 204, 255` |
| 2 | `#8effb0` | `142, 255, 176` |
| 3 | `#ffd166` | `255, 209, 102` |
| 4 | `#c77dff` | `199, 125, 255` |
| 5 | `#ff6b8b` | `255, 107, 139` |
| 6 | `#5fb3b3` | `95, 179, 179` |
| 7 | `#ff9f1c` | `255, 159, 28` |
| 8 | `#b18cff` | `177, 140, 255` |
| 9 | `#4dd0ff` | `77, 208, 255` |
| 10 | `#5ce6a8` | `92, 230, 168` |

## Cascade resolution (O1 — resolved via `!important` layering)

The compositor sets `--krypton-window-accent` / `-rgb` as **normal inline style** on the window at creation (`applyAccentColor`, `compositor.ts:1552`). A plain `.krypton-window[data-lane-accent='N']` stylesheet rule loses to that inline declaration by cascade origin/priority, so the lane palette would not take effect.

**Resolution (Codex-1 High 1, refined in rev. 3): author `!important` on the lane rules only — do NOT remove the compositor's inline vars, and do NOT touch the signal rules.**

- Mark **both** custom-property declarations in each `.krypton-window[data-lane-accent='N']` rule `!important`. An author `!important` declaration beats a *normal* inline declaration, so the lane palette wins over the compositor's inline base **without touching it**. These selectors only match when the harness has set `data-lane-accent`, so the `!important` is **scoped to harness windows** — non-harness windows are unaffected.
- **Leave the `.krypton-window[data-signal='…']` rules as normal declarations.** They are already dominated by the compositor's inline accent on every window (rev. 3 finding), so promoting them to `!important` would globally activate a dormant signal-border recolor — out of scope. As a result a status signal does not override the harness window's lane color; that is consistent with current behavior (the signal `-rgb` retarget wins nowhere today).
- On dispose / no-active-lane, the harness simply **removes** `data-lane-accent`. The compositor's inline vars are still present underneath, so the window instantly reverts to its allocated color — no snapshot, no restore path, no compositor API.

**Why this beats the rejected remove-inline plan:** closing a *pane* disposes the harness `contentView` but can leave the `.krypton-window` alive and promote a sibling pane (`compositor.ts:4008-4016`). If the harness had *removed* the inline accent vars, the surviving window would fall back to CSS defaults (cyan), not its compositor-allocated color. Keeping the inline vars intact and layering with `!important` avoids that leak entirely. The compositor only re-assigns a window's color on window *close* (`freeAccentColor`), never on pane swap, so the underlying inline base stays correct for the window's lifetime.

## Open Questions (resolved with recommended defaults; confirm)

- **O2 — identity vs signal precedence.** *Resolved (rev. 3): identity only, status NOT coupled to the window border.* The active lane is the window's steady accent. The `data-signal` border recolor is dormant today (dominated by the compositor's inline accent), and we deliberately keep it that way rather than globally activating it. **Flagged for human review** (`attention_flag`): if you *want* a lane error to flash the host window's border red, that is a one-line follow-up (promote the `data-signal` `-rgb` rules to `!important`) — but it turns the signal-border recolor on for *every* window, not just the harness. Left off by default to stay in scope and avoid surprising non-harness windows.
- **O3 — multi-pane windows.** *Resolved: whole window.* The harness owns its host window in normal use; the accent paints the entire window. If a harness ever shares a window with non-harness panes, the tint still reflects the harness's active lane (acceptable; revisit if split-pane harness becomes common).
- **O4 — relationship to the manual color-picker design (art-2).** *Resolved: auto-by-lane first.* This spec supersedes the manual picker as the harness's default behavior. A manual per-window override can layer on later (auto as default, explicit pick wins) without conflicting — out of scope here.

## Out of Scope

- Manual color override (the earlier picker concept) — separate follow-up.
- Persisting accent across app restart — no window-state serialization exists; the lane→accent mapping is recomputed live each session.
- Changing the lane palette itself or the compositor's allocation algorithm.

## Testing

- Switch active lane (click peek, Ctrl+n/p) → window dot, border, corner L-marks, glow, accent bar all re-tint to the new lane's color.
- **Close the active lane** (Codex-1 High 2 path) → window re-tints to the newly-promoted active lane, or reverts to the compositor color when no lanes remain. (Confirms `closeActiveLane()` calls `applyActiveLaneAccent()`.)
- Drive a lane to `error`/`needs_attention` → the harness window keeps its lane identity color (status is NOT coupled to the window border in this spec — rev. 3 / O2). Confirm no *non-harness* window changed its signal behavior either.
- **Focused/unfocused breathing glow** keeps animating and reads the current lane rgb (keyframes resolve the var at computed-style time — no break).
- Dispose the harness pane while the host window survives (sibling pane promoted) → window keeps its compositor-allocated color (NOT cyan fallback), confirming inline vars were never removed.
- Dispose the harness / close the window → no console errors; remaining windows keep their compositor colors.
- Lane index > 10 → wraps via the slot modulo and still paints a valid palette color.
- `npm run check` clean; manual verify in `npx tauri dev`.
