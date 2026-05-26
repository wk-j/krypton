# Workspace Status Bar — Implementation Spec

> Status: Implemented
> Date: 2026-05-26
> Milestone: M8 — Polish

## Problem

Krypton has several local status surfaces, but no persistent workspace-level readout. The user can see a focused window's titlebar CWD and mode popups, but cannot quickly answer: what mode am I in, what pane is focused, what project/branch is active, how much activity is happening, or what keyboard action is most relevant now?

## Solution

Promote the existing bottom mini-player footer into a shared `WorkspaceFooter`. Music remains one segment of the rail, but the unused/empty space also summarizes workspace state: mode, focused pane role/title, focused working directory and git ref, window/tab/pane counts, last foreground process, throughput/progress, and one contextual keyboard hint. The rail uses three zones: left status core, center context, and right ephemeral/music. It is read-only in v1 and keyboard-first by design: it exposes `Leader ?` to toggle detail density and command-palette actions for show/hide/detail, but it adds no mouse dependency and no new backend IPC.

## Research

- There is no workspace status bar module today; `.krypton-workspace` is a transparent fixed container in `src/styles/window.css`.
- The visible bottom strip already exists as the music **mini-player footer bar**: `src/music.ts` creates `.krypton-mini-player`, and `src/styles/music.css` positions it as `fixed; bottom: 0; left: 0; right: 0; height: 28px`. This should be reused instead of adding a second footer.
- Workspace switching is not implemented yet (`docs/104-chrome-signal-upgrades.md`), so this spec must not depend on multi-workspace state.
- Existing data is enough for v1: `InputRouter.onModeChange()`, `Compositor.getFocusedWorkingDirectory()`, focused view/title helpers, `ViewBus` signals (`view:throughput`, `view:progress`, `view:metrics`, `view:state`, `system:focus-change`), and the existing `run_command` helper for git branch detection.
- `src/pty-bridge.ts` already converts PTY output, progress, process, and exit events into typed bus signals, so the status bar should subscribe there instead of adding another Tauri listener.
- `docs/104-chrome-signal-upgrades.md` already scoped HUD numerics to window chrome. This spec deliberately targets the workspace: aggregate context, not per-window chrome replacement.
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
| `src/music.ts` | Stop owning the whole fixed footer; expose music playback as a footer segment or register with `WorkspaceFooter`. |
| `src/main.ts` | Construct the footer after `ViewBus`, `Compositor`, and `InputRouter` exist; pass it to `MusicPlayer` or register music after init. |
| `src/input-router.ts` | Add `Leader ?` in compositor mode to toggle compact/detail status; notify mode callbacks when mode changes as already done. |
| `src/command-palette.ts` | Add show/hide and compact/detail actions. |
| `src/compositor.ts` | Expose focused summary helpers if missing: focused view id, window count, tab/pane counts, focused title/role, and focus-change callback reuse. |
| `src/styles/workspace-footer.css` *(new or replaces mini-player footer rules)* | Shared footer layout, music segment, status segments, compact/detail states, responsive priority hiding, theme variables. |
| `src/main.ts` or central CSS import file | Import the new CSS. |
| `docs/04-architecture.md` | Add a short workspace status bar section. |
| `docs/05-data-flow.md` | Add data flow for focus/mode/bus signals into the bar. |
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
    <!-- P0: mode + focused role/title -->
  </div>
  <div class="krypton-workspace-footer__center">
    <!-- P1/P2/P3: cwd/git/process/counts/activity -->
  </div>
  <div class="krypton-workspace-footer__right">
    <!-- music segment when active; otherwise contextual hint -->
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
| Left | Mode chip + focused pane role/title | Always visible; strongest space priority. |
| Center | CWD, git ref/dirty summary, process, counts, activity/progress | Main compression zone; each segment has a priority class. |
| Right | Music segment when active, otherwise one contextual hint | Music gets reserved width while active; hints disappear before core status. |

### Priority Tiers

| Tier | Content | Compact Behavior |
|------|---------|------------------|
| P0 | Input mode, focused pane role/title | Never hidden except extreme truncation. |
| P1 | Project path + git ref | Abbreviate path before hiding. |
| P2 | Contextual hint, window/tab/pane counts, foreground process | Hide when music or width pressure requires it; counts only show when >1. |
| P3 | Throughput, progress percentage, signal state | First to hide; detail mode can show fuller labels. |
| Music | Track, time, progress, optional mini visualizer | Visible only when a track exists; bounded width so it cannot consume the rail. |

Default compact layout, no music active:

```text
NORMAL | terminal session_03 | ~/Source/krypton main * | win 2 tab 1 pane 1 | zsh | 0.8K/s | Leader ? details
```

Compact layout with music active:

```text
NORMAL | terminal session_03 | ~/Source/krypton main *          ▶ track.mp3 · 02:14 / 04:10 [=====---]
```

Detail mode adds progress/state and slightly fuller paths:

```text
NORMAL | terminal session_03 pane_7 | /Users/wk/Source/krypton | git main +3 -1 ?2 | proc zsh pid 12345 | io 0.8K/s | progress 42% | windows 2 tabs 4 panes 5
```

Responsive priorities:

- Always show: P0 mode + focused role/title, then P1 project/git.
- Hide first below 900px: P3 activity/progress, then P2 counts.
- Hide below 700px: P2 process and contextual hint.
- Below 520px: P0 mode plus abbreviated P1 project/git only.
- When music is active: reserve the music segment first, then apply the same priority hiding to the status side.

CSS constraints:

- Reuse the existing footer footprint: `position: fixed; left: 0; right: 0; bottom: 0; height: 28px;`.
- Does not reserve layout space; it overlays the transparent workspace and uses `pointer-events: none`.
- No `backdrop-filter`.
- Uses BEM classes and existing theme variables.
- Text is single-line with priority hiding, `min-width: 0`, and `text-overflow: ellipsis`.
- Bar height stays stable in compact and detail mode; detail changes content density, not dimensions.
- Music visualizer canvas keeps its current 22px height and becomes a child of the music segment.
- The footer remains `pointer-events: none` in v1; no click targets are introduced.
- Segment classes carry priority modifiers such as `.krypton-workspace-footer__segment--p0` through `--p3` so CSS can hide lower-priority content at breakpoints without JS measuring text.

### Motion

The footer should feel alive, but motion must remain telemetry-like and never change layout.

| Trigger | Animation | Constraints |
|---------|-----------|-------------|
| Mode changes | 320-400 ms vertical snap/fade on the mode chip | Only runs when `Mode` changes; no idle loop. |
| Contextual hint changes | 250-350 ms fade/slide on the hint segment | Only runs on mode/focus/content-type changes. |
| View throughput/progress pulse | One-shot 600-800 ms scan sweep across the footer background | Optional v1.1 polish; if included, trigger only on throughput band crossing or progress changes, max ~1 pulse / 2s. |
| Music playing | Mini visualizer bar motion and subtle play-glyph blink | Runs only while music segment is visible and playback status is `Playing`. |
| Music progress | Thin progress fill shimmer | Paused/stopped disables shimmer. |

Implementation rules:

- All animations are CSS transforms/opacity/background-position only.
- No animation changes footer height, segment width, or text content measurements.
- `prefers-reduced-motion: reduce` disables snap, hint fade, sweep, mini visualizer motion, blink, and shimmer.
- Footer hidden stops the music mini visualizer RAF or CSS animation class.
- Activity sweeps are rate-limited by the existing `view:throughput` 5 Hz budget and the footer's RAF render coalescing; do not add another timer per pane.
- Activity sweeps are decorative (`aria-hidden`) and may be deferred without blocking the first implementation.

### Contextual Hints

Hints are derived from `Mode` and focused content type, not from ad-hoc strings scattered across the compositor.

| Context | Hint |
|---------|------|
| Normal terminal | `Leader v select · Cmd+O files · Cmd+Shift+G git` |
| Compositor | `n new · h/j/k/l focus · ? details` |
| Resize/Move/Swap | `arrows adjust · Esc cancel` |
| Command palette / dashboard / prompt dialog | `Esc close` |
| ACP harness | `Cmd+P lanes · #cancel running` |
| Music active | `Cmd+Shift+M music` when the right segment has room for a hint; otherwise music wins. |

### Configuration

No TOML config in v1. State is runtime-only:

- Visible by default.
- Density defaults to `compact`.
- Command palette and `Leader ?` change the current app session only.

Persistent config can be added later under `[workspace.status_bar]` if the bar proves useful.

## Edge Cases

- **No focused pane** — show `NORMAL | no focus | win N` and omit cwd/git/process.
- **Non-git directory** — omit the git segment; cache negative result per CWD for 10 seconds.
- **Detached HEAD** — show `HEAD <sha>`.
- **Git probe failure** — fail silent; never surface command errors in the bar.
- **High throughput** — bus already emits at 5 Hz; status bar coalesces renders in RAF.
- **Many focus changes** — CWD/git refresh is debounced 100 ms and keyed by focused view id + cwd.
- **Quick Terminal visible** — status source is Quick Terminal session and title, matching `Compositor.getFocusedSessionId()`.
- **Music inactive** — music segment is hidden and workspace status fills the footer.
- **Music active** — music segment gets fixed/minmax width, workspace status compresses by priority before overflowing.
- **Long branch/path/track names** — every segment has `min-width: 0`; no wrapping; path and track names ellipsize before the rail grows.
- **Overlay modes** — mode segment reflects `CommandPalette`, `Dashboard`, `PromptDialog`, `QuickFileSearch`, etc.; hints point to `Esc`/current overlay where known.
- **Webview panes** — process/throughput may be absent; show role/title/project only.
- **Reduced motion** — all motion is disabled; state changes are direct text/color updates.
- **Footer hidden** — music mini visualizer RAF stops; playback continues.
- **Hint staleness** — hints update on mode/focus/content-type changes only, not every keypress.
- **Screen readers** — text segments use `role="status"` / `aria-live="polite"` at low frequency; decorative sweeps and visualizer bars are `aria-hidden`.

## Future Protocol Extension

Do not add `view:status` in v1. The footer derives from existing signals:

| Source | Footer Use |
|--------|------------|
| `InputRouter` | Mode chip and contextual hints. |
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
- `docs/104-chrome-signal-upgrades.md` — current chrome signal scope and workspace-switching caveat.
- `docs/105-view-protocol.md` — existing typed bus used as the status bar data source.
- `src/input-router.ts`, `src/compositor.ts`, `src/pty-bridge.ts`, `src/chrome-signals.ts` — local data sources and update patterns.
