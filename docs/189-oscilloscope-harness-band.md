# Oscilloscope Band in Content Windows (Agent / ACP / Harness) — Implementation Spec

> Status: Implemented
> Date: 2026-07-06
> Milestone: M-chrome — window chrome polish

## Problem

The live oscilloscope header band ([188-oscilloscope-header-band.md](188-oscilloscope-header-band.md))
only runs on terminal and Quick-Terminal windows, driven by PTY byte throughput. Agent, ACP,
and ACP-harness windows still show the **static striped `<div>`** — the exact "torn edge /
rendering glitch" band the oscilloscope replaced. Those windows stream just as much live
output (assistant/thought text deltas), so they deserve the same living signal. Spec 188
listed this explicitly as **Out of Scope / future** ("content-view windows keep the static
band"; "feeding the band from non-PTY signals — future"). This is that follow-up.

## Solution

Extend `HeaderScope` to content windows by (1) making `createContentWindow` build a real
`HeaderScope` via `buildHeaderAccent(chrome)` instead of hardcoding the static div, and (2)
pumping it from the streaming-text choke points already present in each view — `.length` of
each text delta stands in for PTY `data.length`. No new class, no new data structure: the
same `pump(n)` energy model, the same idle-stop rAF loop, the same reduced-motion fallback.
The band's meaning shifts from "bytes/sec of terminal output" to "rate of model output" —
you *see* the agent thinking/typing.

## Research

**Prior art in this codebase (decisive):** `HeaderScope` is already generic — it takes a
number into `pump()` and knows nothing about PTY. The only PTY-specific thing is the *call
site*. So no change to `header-scope.ts` is needed; this is pure wiring.

Findings from code survey:
- **Attach point:** `createContentWindow` (`compositor.ts:1900`) builds the shared chrome
  but, unlike terminal windows, hardcodes a static striped div at `compositor.ts:1943–1945`
  instead of calling `buildHeaderAccent`. Terminal windows call `buildHeaderAccent(chrome)`
  (`compositor.ts:1773`) and store the returned scope on the window record
  (`compositor.ts:1836`), dispose it at `compositor.ts:3407`, and refresh its color on theme
  change (`compositor.ts:1408–1409`). Content windows do none of this today.
- **Pump sources (streaming text choke points that already exist):**
  - Agent view — `agent-view.ts:1353` `this.currentAssistantBuffer += e.delta` (assistant
    text stream; `e.delta` is a `string`).
  - ACP harness view — `acp-harness-view.ts:10080` `appendStreaming(lane, kind, text)`, one
    method covering assistant / thought / user chunks for **every lane**.
  - ACP view — `acp-view.ts:873` (`message_chunk`) and `:882` (`thought_chunk`).
- **CSS conflict:** `agent.css:95–103` overrides `.krypton-window__header-accent` with an
  amber gradient background. That override was written for the static div; with a `<canvas>`
  (whose scope variant sets `background: none`) it would paint an amber block *behind* the
  transparent trace. The `--scope` variant must win, or the agent override must exclude the
  canvas.

**Constraint:** `HeaderScope` is one canvas per **window chrome**, but a harness window hosts
**multiple lanes** and `appendStreaming` is per-lane. One band cannot represent N lanes
separately, so the pump policy for harness needs a decision (see Design → Pump policy).

**Alternatives ruled out:**
- *Per-lane scopes inside the transcript* — rejected; the band is a window-chrome element by
  design (spec 188), and multi-band-in-content is a much larger UI change out of proportion
  to "make the existing band alive."
- *Pump from the per-frame rAF hook instead of per-chunk* — rejected; per-chunk `.length`
  mirrors the PTY design exactly and gives amplitude proportional to output volume, which the
  rAF hook (fires once per frame regardless of volume) would flatten.

## Prior Art

Same as spec 188 — no mainstream agent/terminal UI draws a continuous throughput waveform in
window chrome. The closest agent-specific equivalent is a spinner / "typing…" indicator
(Claude Code, Cursor, Warp AI) which is binary (busy vs idle). **Krypton delta:** the band is
an analog read of *how fast* the model is emitting, not just whether it is. Purely visual;
keyboard-first is unaffected.

## Affected Files

| File | Change |
|------|--------|
| `src/compositor.ts` | `createContentWindow`: replace the hardcoded static-div header-accent (`:1943–1945`) with `buildHeaderAccent(chrome)`, store the returned scope on the window record, dispose on close, refresh color on theme change (mirror the terminal path). **Also `createContentTab`:** wire `contentView.onOutputPump` to the host window's shared `headerScope` — this is the path content views actually open through in the common case (see Design → Attach points). |
| `src/agent/agent-view.ts` | Pump the host window's scope on each assistant delta (`:1353`). Needs a way to reach the scope (see Design → Reaching the scope). |
| `src/acp/acp-harness-view.ts` | Pump on `appendStreaming` (`:10080`), gated by pump policy. |
| `src/acp/acp-view.ts` | Pump on `message_chunk`/`thought_chunk` (`:873`/`:882`). |
| `src/styles/agent.css` | Fix the `header-accent` amber-gradient override (`:95–103`) so the `--scope` canvas variant is not painted over. |
| `docs/188-oscilloscope-header-band.md` | Note the "content windows" out-of-scope item is now covered by 189. |
| `docs/PROGRESS.md`, `docs/04-architecture.md`, `docs/05-data-flow.md` | Document the extended feed (per `/feature-implementation`). |

## Design

### Attach points — windows *and* tabs

The band lives on the **window chrome** and is shared by every tab/pane of that
window (one `HeaderScope` per `KryptonWindow`, stored as `win.headerScope`). A content
view can reach that scope two ways, and **both must be wired** or the band appears dead
for views opened the common way:

- `createContentWindow` (empty-workspace fallback) — builds a fresh chrome and its own
  `HeaderScope`; wires `onOutputPump` to that scope directly.
- `createContentTab` (the common path: leader+Y / palette opens the harness, agent, and
  ACP views as a **tab in the launching terminal window**) — the window already has a
  live `HeaderScope` fed by the terminal's PTY; wire the new tab's `onOutputPump` to that
  existing `win.headerScope`. This is what the harness actually uses, so omitting it is
  why the harness band never animated in practice.

Both wirings no-op when the theme's header-accent style is `ticks` (`headerScope` is
null → `onOutputPump` stays unset).

### Reaching the scope from a ContentView

`HeaderScope` lives on the window record (chrome level); `AgentView` / `AcpHarnessView` /
`AcpView` are `ContentView`s mounted *inside* the window and don't hold a window reference.
Rather than thread the window id through, add a tiny callback the compositor injects when it
creates the content window:

```ts
// ContentView (or a mixin the three views share)
onOutputPump?: (chars: number) => void;   // set by compositor after buildHeaderAccent
```

The compositor, right after `const scope = buildHeaderAccent(chrome)` in
`createContentWindow`, wires `contentView.onOutputPump = (n) => scope?.pump(n)`. Each view
then calls `this.onOutputPump?.(delta.length)` at its choke point. This keeps `HeaderScope`
ignorant of views and views ignorant of window internals — one function boundary.

### Pump policy (harness, multi-lane)

`appendStreaming` fires for every lane. **Chosen: pump on every lane's stream** — the band
reflects aggregate window activity (matches the terminal multi-pane rule in spec 188: "all
panes pump the single window band"). Simpler than tracking the active lane, and a
single-lane harness (the common case) is unaffected. The alternative — pump only the
active/foregrounded lane — is deferred (see Open Questions → resolved).

### Data Flow

```
1. Model streams a text delta into a content view.
   - Agent:   handleAgentEvent 'message_update' → currentAssistantBuffer += e.delta   (agent-view.ts:1353)
   - Harness: onLaneEvent chunk → appendStreaming(lane, kind, text) → item.text += text (acp-harness-view.ts:10080)
   - ACP:     onAcpEvent 'message_chunk'/'thought_chunk' → raw += e.text              (acp-view.ts:873/882)
2. NEW: view calls this.onOutputPump?.(deltaText.length).
3. onOutputPump → scope.pump(n): energy += n/SCALE, (re)start rAF if stopped.
4. Same rAF loop as terminal: decay, push sample, draw, idle-stop at ε. 0 CPU when idle.
```

### UI Changes

- Content-window header-accent element becomes the same
  `<canvas class="krypton-window__header-accent krypton-window__header-accent--scope">` used
  by terminal windows (built by the existing `buildHeaderAccent`).
- `agent.css` fix: change the `:95–103` amber-gradient rule so it applies to the static
  `.krypton-window__header-accent` only (not `--scope`), OR set the trace/accent color for
  the agent via `--krypton-window-accent-rgb` and drop the gradient. The band should read as
  the amber trace, consistent with the agent aesthetic (DESIGN.amber.md), on a transparent
  base — no solid gradient block behind it.
- Reduced-motion + `header_accent.enabled=false` + `style="ticks"` all behave exactly as on
  terminal windows (already handled inside `buildHeaderAccent` / `HeaderScope`).

### Configuration

None new. Reuses `theme.chrome.header_accent.{enabled,style}` from spec 188 — setting
`style="ticks"` reverts content windows to the static band too, for free.

## Edge Cases

- **Idle agent window** → rAF stops, 0 CPU (same guarantee as terminal).
- **Harness with many lanes streaming at once** → one band, aggregate energy; self-throttles.
- **User's own message echo** (`user_message_chunk` at harness `:6008`) → also flows through
  `appendStreaming`, so the band ticks while the user's streamed input renders. Acceptable
  (it *is* window activity); noted, not special-cased.
- **View disposed / window closed** → scope disposed via the existing `createContentWindow`
  close path (add the `dispose()` call alongside the store).
- **Theme / lane-accent change** → `refreshColor()` on `theme-changed`, mirroring terminal.
- **`onOutputPump` unset** (e.g. view created without chrome, tests) → optional-chained, no-op.

## Open Questions

_None blocking._ The one real fork — harness pump policy (all lanes vs active lane) — is
resolved in Design → Pump policy as **all lanes** (aggregate), matching the multi-pane
terminal rule. Flagged to the human review queue for visibility; reversible.

## Out of Scope

- Per-lane bands / in-transcript waveforms — the band stays a single window-chrome element.
- Distinguishing thought vs assistant vs tool output in the waveform — all output pumps the
  same energy.
- Any change to `HeaderScope` internals or the tick fallback.
- Vault view and non-interactive dashboard panels — they keep the static band unless a future
  spec says otherwise.
- New keybindings (purely visual).

## Resources

- Internal: [188-oscilloscope-header-band.md](188-oscilloscope-header-band.md) (the base
  feature + `HeaderScope` contract), `src/header-scope.ts`, `src/compositor.ts`
  (`buildHeaderAccent`, `createContentWindow`, terminal build/dispose/refresh sites),
  `src/agent/agent-view.ts`, `src/acp/acp-harness-view.ts`, `src/acp/acp-view.ts`,
  `src/styles/agent.css`.
- N/A external — purely internal wiring of an existing feature.
