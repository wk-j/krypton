# Workspace Status Bar — Implementation Spec

> Status: Implemented
> Date: 2026-05-26
> Milestone: M8 — Polish
> Spec 350 (2026-11-01): compact density is now the git ref, a mode chip only outside Normal, and the right-zone exceptions (attention, program status, Rails findings/faults, backend-link faults, music). Mode `NORMAL`, role/title, cwd, counts, process and activity, a healthy link, quiet Rails states and the review gauges show in detail density only. The contextual hint is removed. Sections below are updated where they describe current behavior.
> Styling superseded by [spec 0366](./0366-console-faceplate-ui.md) and DESIGN.md (Krypton Console): footer is a plate strip; sweeps, shimmer and glows removed. DESIGN.md 2.3.6 gives the Git branch a neutral-ink recessed well with its existing amber dirty marker.

## Problem

Krypton has several local status surfaces, but no persistent workspace-level readout. The user can see a focused window's titlebar CWD and mode popups, but cannot quickly answer: what mode am I in, what pane is focused, what project/branch is active, how much activity is happening, or what keyboard action is most relevant now?

## Solution

Promote the existing bottom mini-player footer into a shared `WorkspaceFooter`. Music remains one segment of the rail, but the unused/empty space also summarizes workspace state: mode, focused pane role/title, focused working directory and git ref, window/tab/pane counts, last foreground process, throughput/progress, and one contextual keyboard hint. The rail uses three zones: left status core, center context, and right ephemeral/music. It is read-only in v1 and keyboard-first by design: it exposes `Leader ?` to toggle detail density and command-palette actions for show/hide/detail, but it adds no mouse dependency and no new backend IPC.

## Research

- There is no workspace status bar module today; `.krypton-workspace` is a transparent fixed container in `src/styles/window.css`.
- The visible bottom strip already exists as the music **mini-player footer bar**: `src/music.ts` creates `.krypton-mini-player`, and `src/styles/music.css` positions it as `fixed; bottom: 0; left: 0; right: 0; height: 28px`. This should be reused instead of adding a second footer.
- Workspace switching is not implemented yet (`docs/0104-chrome-signal-upgrades.md`), so this spec must not depend on multi-workspace state.
- Existing data is enough for v1: `InputRouter.onModeChange()`, `Compositor.getFocusedWorkingDirectory()`, focused view/title helpers, `ViewBus` signals (`view:throughput`, `view:progress`, `view:metrics`, `view:state`, `system:focus-change`), and the existing `run_command` helper for git branch detection.
- `src/pty-bridge.ts` already converts PTY output, progress, process, and exit events into typed bus signals, so the status bar should subscribe there instead of adding another Tauri listener.
- `docs/0104-chrome-signal-upgrades.md` already scoped HUD numerics to window chrome. This spec deliberately targets the workspace: aggregate context, not per-window chrome replacement.
- Cursor-1 review validated the one-rail approach and added concrete priority/compression rules: P0 mode/focus always visible, P1 project/git, P2 counts/process/hint, P3 activity/progress; music is a fixed/minmax right segment when active.
- Cursor-1's protocol review rejected a new `view:status` signal for v1. The footer derives from existing `InputRouter`, `Compositor`, `ViewBus`, and debounced git probes, mirroring `chrome-signals.ts` as a subscriber aggregator.

Alternatives ruled out:
- Put more fields into every window titlebar: too dense when many windows are visible, and duplicates workspace context.
- Add a second dedicated workspace bar above the mini-player: wastes vertical space and creates two competing global footers.
- Make the bar interactive with mouse menus: useful later, but contrary to Krypton's keyboard-first baseline for a first slice.
- Poll git/process state independently: unnecessary; use focus-change and existing bus updates.
- Implement workspace switching first: not required for a useful status bar.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| iTerm2 | Configurable, scriptable status bar with components for CWD, host/user, foreground job, git state, system monitors, clock, and actions. | Strong model for componentized status with priority/compression. |
| WezTerm | `set_right_status` writes a right-aligned tab-bar status area; examples include CWD, hostname, date/time, and battery. | Strong model for deriving status from the active pane and clipping when space is tight. |
| Kitty | Tab bar can use separators/styles and display active tab/window metadata; richer status commonly comes from shell or tmux integration. | Useful for visual density, less relevant for workspace-level aggregation. |
| Zellij | Default bottom `status-bar` plugin is full-width and expected to show input modes and status. | Strong model for making modes visible at all times. |
| tmux | Bottom status line with current session/window/pane, mode indicators, host, time, and custom format strings. | Familiar keyboard-terminal convention, but v1 avoids a user format language. |

**Krypton delta** — match terminal convention by making mode, focus, project, git, process, and activity visible. Diverge by keeping it graphical-DOM, theme-token driven, and workspace-scoped rather than shell-scoped or format-string based.

## Affected Files

| File | Change |
|------|--------|
| `src/workspace-footer.ts` *(new)* | Shared workspace footer controller, slot rendering, subscriptions, git branch cache, render/update logic. |
| `src/workspace-footer-*.ts` | **Module layout:** `workspace-footer.ts` is the facade (public API, subscriptions, RAF/generation guard, bus state, root DOM). Siblings: `-format` (pure text helpers), `-dom` (icons + segment builder), `-segments` (left/center segments, density-gated), `-git` (`FooterGit` cache + debounce), and one right-zone component each: `-attention`, `-review-gauges`, `-link`, `-rails`, `-program-status`, `-music`. |
| `src/music.ts` | Stop owning the whole fixed footer; expose music playback as a footer segment or register with `WorkspaceFooter`. |
| `src/main.ts` | Construct the footer after `ViewBus`, `Compositor`, and `InputRouter` exist; pass it to `MusicPlayer` or register music after init. |
| `src/input-router.ts` | Add `Leader ?` in compositor mode to toggle compact/detail status; notify mode callbacks when mode changes as already done. |
| `src/command-palette.ts` | Add show/hide and compact/detail actions. |
| `src/compositor.ts` | Expose focused summary helpers if missing: focused view id, window count, tab/pane counts, focused title/role, and focus-change callback reuse. |
| `src/styles/workspace-footer.css` *(new or replaces mini-player footer rules)* | Shared footer layout, music segment, status segments, compact/detail states, responsive priority hiding, theme variables. |
| `src/main.ts` or central CSS import file | Import the new CSS. |
| `docs/0004-architecture.md` | Add a short workspace status bar section. |
| `docs/0005-data-flow.md` | Add data flow for focus/mode/bus signals into the bar. |
| `docs/PROGRESS.md` | Add landing note when implemented. |
| `docs/prototypes/workspace-footer.html` | Static interactive prototype for compact/detail, music-active, mode, and narrow-width states.

## Design

### Data Structures

```ts
// src/workspace-footer.ts
export type WorkspaceFooterDensity = 'compact' | 'detail';

export interface WorkspaceStatusSnapshot {
  mode: Mode;
  focusedViewId: string | null;
  role: PaneContentType | null;
  title: string;
  cwd: string | null;
  git: string | null;
  windows: number;
  tabs: number;
  panes: number;
  process: string | null;
  throughput: number;
  progress: { state: ProgressState; pct: number | null } | null;
  state: SignalState;
  hint: string;
}

export type WorkspaceFooterPriority = 'p0' | 'p1' | 'p2' | 'p3' | 'music';

export interface MusicFooterSegment {
  statusIcon: string;
  track: string;
  info: string;
  flags: string;
  time: string;
  progressPct: number;
  visualizer?: HTMLCanvasElement;
}

export class WorkspaceFooter {
  constructor(deps: {
    workspace: HTMLElement;
    compositor: Compositor;
    inputRouter: InputRouter;
    bus: ViewBus;
    runCommand?: typeof runCommand;
  });

  start(): void;
  stop(): void;
  setVisible(visible: boolean): void;
  toggleVisible(): void;
  toggleDensity(): void;
  setMusicSegment(segment: MusicFooterSegment | null): void;
  refresh(reason: 'mode' | 'focus' | 'bus' | 'timer' | 'config'): void;
}
```

The class owns the existing bottom footer responsibility:

```html
<div class="krypton-workspace-footer" role="status" aria-live="polite">
  <div class="krypton-workspace-footer__left">
    <!-- mode chip: non-Normal modes; NORMAL in detail only (spec 350) -->
  </div>
  <div class="krypton-workspace-footer__center">
    <!-- git ref (compact); cwd · git · role/title · counts · process · activity (detail) -->
  </div>
  <div class="krypton-workspace-footer__right">
    <!-- attention, program status, rails, link, reviews, priority, music; each hides when it has nothing to say in the current density -->
  </div>
</div>
```

### API / Commands

No new Tauri commands or Rust events.

New frontend command-palette actions:

```ts
workspace.status.toggleVisible
workspace.status.toggleDensity
workspace.status.refresh
```

New input action:

| Key | Context | Action |
|-----|---------|--------|
| `?` | Compositor mode | Toggle status bar compact/detail density |

`?` is currently not in `GLOBAL_LEADER_RESERVED_KEYS`; if a local content view already claims `?`, focused local leader handling keeps priority and the global action does not run.

### Data Flow

```
1. App starts; main.ts creates ViewBus, Compositor, InputRouter, then WorkspaceFooter.
2. WorkspaceFooter subscribes to InputRouter.onModeChange().
3. WorkspaceFooter subscribes to ViewBus: system:focus-change, view:state, view:throughput, view:progress, view:metrics, view:exit.
4. MusicPlayer reports playback state to WorkspaceFooter instead of rendering a separate fixed footer.
5. On focus/mode changes, WorkspaceFooter asks Compositor for the focused view summary and focused CWD.
6. Bus-derived fields are accepted only when `signal.source.viewId === compositor.getFocusedViewId()`. Unfocused view signals are ignored except for optional cached last-state cleanup on `view:exit`.
7. If CWD changed, it runs cached git probes through run_command:
   git branch --show-current
   fallback: git rev-parse --short HEAD
8. Render is scheduled through one requestAnimationFrame; multiple signals coalesce.
9. A 1 Hz timer only updates age/clock-like transient fields if they are visible in detail mode.
```

### UI Changes

### Zone Model

| Zone | Contents | Behavior |
|------|----------|----------|
| Left | Mode chip | Shown for every non-Normal mode; `NORMAL` shows in detail density only (spec 350). |
| Center | Compact: git ref/dirty summary. Detail: CWD, git, focused role/title, counts, process, activity/progress, state, program status | Main compression zone; each segment has a priority class. Role/title is built by `composeRoleTitle`: the shell-embedded cwd is stripped from the title (`stripCwdToken`, matched against the focused cwd — exact or shell-abbreviated like `~/S/krypton`), while real path arguments (`vim /tmp/a`) and separators (`MD // foo`) are kept. The role prefix is dropped when the title already names the same kind of view, so `acp_harness` + "ACP Harness" shows just "ACP Harness". |
| Right | Attention, program status, Rails, backend link, review gauges, music | Compact shows only demand (attention, program status, Rails findings/error/failed check, link `auth`/`offline`); detail adds a healthy link with latency, quiet Rails states and the review gauges. Music keeps reserved width while active. |

Spec 258 extends the right zone with a global `⚡ TS N` segment immediately
before the Xenon link indicator. It is hidden while TypeSafe is disabled or the
process-lifetime request count is zero. Compact density shows requests only;
detail density adds logical operations and retries, while the tooltip names the
completed count, average latency, run scope, and Profiler shortcut. The segment
subscribes to `system:typesafe-metrics`, adds no polling, focus target, mouse
interaction, or animation, and uses tabular numerics so changing counts do not
jitter the rail.

### Priority Tiers

| Tier | Content | Compact Behavior |
|------|---------|------------------|
| P0 | Input mode, focused pane role/title | Mode: non-Normal always, `NORMAL` in detail; role/title detail only (spec 350). |
| P1 | Project path + git ref | Git ref always; the path is detail only (spec 350) and abbreviates before hiding. |
| P2 | Window/tab/pane counts, foreground process | Detail only (spec 350); counts only show when >1. |
| P3 | Throughput, progress percentage, signal state | First to hide; detail mode can show fuller labels. |
| Music | Track, time, progress, optional mini visualizer | Visible only when a track exists; bounded width so it cannot consume the rail. |

Since spec 350 the tiers order detail density; compact shows the git ref, a non-Normal mode chip and the right-zone exceptions.

Compact, healthy:

```text
main *
```

Compact with a non-Normal mode, a fault and music active:

```text
RESIZE | main *                    2 attention ▮▮▯▯  RAILS ✗ tsc  ▶ track.mp3 · 02:14 / 04:10 [=====---]
```

Detail:

```text
NORMAL | ~/Source/krypton | main * | terminal session_03 | 2/1/1 | zsh 12345 | 0.8K/s | 42%      RAILS ✓  ⇄ xenon 42ms
```

Responsive priorities:

- Compact always shows any non-Normal mode chip and the git ref.
- Hide first below 900px: P3 activity/progress, then P2 counts.
- Hide below 700px: P2 process.
- Below 520px: the mode chip plus the git ref (and the abbreviated cwd in detail) only.
- When music is active: reserve the music segment first, then apply the same priority hiding to the status side.

CSS constraints:

- Reuse the existing footer footprint: `position: fixed; left: 0; right: 0; bottom: 0; height: 28px;`.
- Does not reserve layout space; it overlays the transparent workspace and uses `pointer-events: none`.
- Background is the shared plate (`--mat-brush` + `--mat-plate`), with a top seam and inner bevel. No overlay-tier slab.
- No `backdrop-filter`.
- Uses BEM classes and existing theme variables.
- Text is single-line with priority hiding, `min-width: 0`, and `text-overflow: ellipsis`.
- Bar height stays stable in compact and detail mode; detail changes content density, not dimensions.
- Music visualizer canvas keeps its current 22px height and becomes a child of the music segment.
- The footer remains `pointer-events: none` in v1; no click targets are introduced.
- Segment classes carry priority modifiers such as `.krypton-workspace-footer__segment--p0` through `--p3` so CSS can hide lower-priority content at breakpoints without JS measuring text.

Kind color (spec 236, amended by DESIGN.md 2.3.6): default type follows the shared ink tiers. The workspace Git branch is neutral `--krypton-ink-2` in a recessed `--mat-well` / `--mat-well-shadow` readout, with 8px radius, 2px × 6px padding and chrome-size type. Preserve ref case and the warning-coloured dirty dot. In detail density its preceding separator is replaced by an 8px gap, outside the well; compact git retains the normal footer inset. Neither density changes the 28px rail height. This footer-only treatment does not change composer-meta branch styling.

### Motion

The footer should feel alive, but motion must remain telemetry-like and never change layout.

| Trigger | Animation | Constraints |
|---------|-----------|-------------|
| Mode changes | 320-400 ms vertical snap/fade on the mode chip | Only runs when `Mode` changes; no idle loop. |
| View throughput/progress pulse | One-shot 600-800 ms scan sweep across the footer background | Optional v1.1 polish; if included, trigger only on throughput band crossing or progress changes, max ~1 pulse / 2s. |
| Music playing | Mini visualizer bar motion and subtle play-glyph blink | Runs only while music segment is visible and playback status is `Playing`. |
| Music progress | Thin progress fill shimmer | Paused/stopped disables shimmer. |

Implementation rules:

- All animations are CSS transforms/opacity/background-position only.
- No animation changes footer height, segment width, or text content measurements.
- `prefers-reduced-motion: reduce` disables snap, sweep, mini visualizer motion, blink, and shimmer.
- Footer hidden stops the music mini visualizer RAF or CSS animation class.
- Activity sweeps are rate-limited by the existing `view:throughput` 5 Hz budget and the footer's RAF render coalescing; do not add another timer per pane.
- Activity sweeps are decorative (`aria-hidden`) and may be deferred without blocking the first implementation.

### Contextual Hints

Removed by spec 350. The hint was fixed per mode and view kind, so after the first read it carried no state; which-key shows each mode's keys and overlays carry their own `Esc`.

### Configuration

No TOML config in v1. State is runtime-only:

- Visible by default.
- Density defaults to `compact`.
- Command palette and `Leader ?` change the current app session only.

Persistent config can be added later under `[workspace.status_bar]` if the bar proves useful.

## Edge Cases

- **No focused pane** — compact shows only the right-zone exceptions; detail shows the mode and `no focus` and omits cwd/git/process.
- **Non-git directory** — omit the git segment; cache negative result per CWD for 10 seconds.
- **Detached HEAD** — show `HEAD <sha>`.
- **Git probe failure** — fail silent; never surface command errors in the bar.
- **High throughput** — bus already emits at 5 Hz; status bar coalesces renders in RAF.
- **Many focus changes** — CWD/git refresh is debounced 100 ms and keyed by focused view id + cwd.
- **`cd` without a focus change** — terminals that report OSC 7 publish a `view:cwd` signal on every prompt (via `pty-bridge`); the footer caches the path per view (`cwdByView`) and uses it directly, so a directory change shows immediately rather than waiting for a focus change or the detail-mode timer. Shells/views without OSC 7 fall back to the live `get_pty_cwd` query in `render()`. The bridge carries a bounded trailing partial across chunks (`trailingEscStart`, `OSC7_CARRY_CAP`) so a sequence split between two `pty-output` reads is still parsed, and a malformed percent-escape is ignored rather than throwing. **Accepted trade-offs of preferring the pushed cwd (over always re-querying):** if a shell stops reporting OSC 7 (e.g. a full-screen TUI or a subshell), the cached path can go stale until the next focus change; and for SSH shells the OSC 7 path is the **remote** cwd, so the local git probe in `render()` will not reflect it. These are inherent to the event-driven choice; revisit if correctness outweighs instant `cd` feedback.
- **Quick Terminal visible** — status source is Quick Terminal session and title, matching `Compositor.getFocusedSessionId()`.
- **Music inactive** — music segment is hidden and workspace status fills the footer.
- **Music active** — music segment gets fixed/minmax width, workspace status compresses by priority before overflowing.
- **Long branch/path/track names** — every segment has `min-width: 0`; no wrapping; path and track names ellipsize before the rail grows.
- **Overlay modes** — the mode chip reflects `CommandPalette`, `Dashboard`, `PromptDialog`, `QuickFileSearch`, etc.
- **Webview panes** — process/throughput may be absent; show role/title/project only.
- **Reduced motion** — all motion is disabled; state changes are direct text/color updates.
- **Footer hidden** — music mini visualizer RAF stops; playback continues.
- **Screen readers** — text segments use `role="status"` / `aria-live="polite"` at low frequency; decorative sweeps and visualizer bars are `aria-hidden`.

## Future Protocol Extension

Do not add `view:status` in v1. The footer derives from existing signals:

| Source | Footer Use |
|--------|------------|
| `InputRouter` | Mode chip. |
| `Compositor` | Focused role/title, CWD, counts, focused `viewId`. |
| `run_command` | Debounced git branch / detached HEAD / dirty summary. |
| `view:metrics` | Foreground process name, pid, command when available. |
| `view:throughput` | Activity bytes/s for the focused view. |
| `view:progress` | Progress state and percentage for the focused view. |
| `view:state` | Detail-mode state token such as `busy`, `warn`, or `err`. |

If view-authored footer copy becomes necessary later, prefer well-known `view:metrics` keys such as `statusLabel` and `statusDetail` before adding a new signal kind. Footer priority/compression remains owned by `WorkspaceFooter`; views do not publish priority or hint text.

## Open Questions

None. The v1 behavior is intentionally read-only and runtime-only.

## Out of Scope

- Implementing real workspace switching or workspace persistence.
- User-authored status format strings/components.
- Mouse menus or click actions.
- New Rust process/git watchers.
- Battery, CPU, memory, network system monitors.
- Moving local view-specific status bars into the workspace footer.
- Replacing the music dashboard; only the mini-player footer rendering is shared.
- A generic plugin slot registry. The v1 class can be shaped to allow it later, but only built-in workspace + music slots ship now.
- A new `view:status` protocol signal.

## Resources

- [iTerm2 Status Bar documentation](https://iterm2.com/3.6/documentation-status-bar.html) — component model, CWD/job/git/system status, priority/compression behavior.
- [WezTerm `window:set_right_status`](https://wezterm.org/config/lua/window/set_right_status.html) — active-pane-derived right status, clipping behavior, CWD/host/date examples.
- [Kitty configuration: tab bar](https://sw.kovidgoyal.net/kitty/conf/#tab-bar) — terminal tab/status visual density conventions.
- [Zellij status-bar alias](https://zellij.dev/documentation/status-bar-alias) — full-width bottom status plugin expected to show input modes/status.
- Cursor-1 inter-lane brainstorm (2026-05-26) — priority tiering, three-zone footer, music-active compression, and implementation cautions.
- `docs/prototypes/workspace-footer.html` — static prototype of the proposed 28px shared footer rail and compression states.
- `docs/0104-chrome-signal-upgrades.md` — current chrome signal scope and workspace-switching caveat.
- `docs/0105-view-protocol.md` — existing typed bus used as the status bar data source.
- `src/input-router.ts`, `src/compositor.ts`, `src/pty-bridge.ts`, `src/chrome-signals.ts` — local data sources and update patterns.
