# 66 — Invisible Window and WebContent Reload Recovery

## Incident

The Krypton process remains alive (visible in `ps`, ~113 MB resident) but the window is not visible on any screen. No user-accessible gesture brings it back: Mission Control, `Cmd+Tab`, and `Cmd+H` cycling all fail. The process must be killed and relaunched, losing all PTY sessions.

No logs are written to disk, so post-mortem diagnosis is impossible.

## Root Cause

The window geometry is configured **once at startup** and never re-validated.

`src-tauri/src/lib.rs:150-168`:

```rust
if let Ok(Some(monitor)) = window.current_monitor() {
    let pos = monitor.position();
    let size = monitor.size();
    let _ = window.set_position(tauri::Position::Physical(...));
    let _ = window.set_size(tauri::Size::Physical(...));
}
let _ = window.set_always_on_top(true);
let _ = window.set_always_on_top(false);
```

Combined with the window config in `src-tauri/tauri.conf.json`:

```json
{ "decorations": false, "transparent": true, "resizable": true }
```

…the window has **zero visible chrome**. If its content layer is not painting at valid on-screen coordinates, it is literally invisible, with no titlebar to drag and no frame to click.

### Contributing factors

1. **Display topology changes are unhandled.** Sleep/wake, unplugging an external monitor, resolution changes, or clamshell-close leave the window pinned to now-invalid absolute pixel coords — fully outside every active monitor's bounds.
2. **Space / monitor stranding on macOS.** Because the app sets its own fullscreen geometry (to preserve transparency), the window can end up on a Space whose underlying monitor no longer exists.
3. **WKWebView compositor loss after wake.** Transparent WKWebView occasionally loses its surface layer after system sleep. With no opaque chrome, nothing remains to see.
4. **`current_monitor()` returning `None`.** If the primary monitor isn't resolvable at launch, the `if let` silently falls through and the window keeps its default (likely zero-size) geometry — invisible on a transparent, decorationless window.
5. **Release builds write no logs.** `tauri_plugin_log` is gated on `cfg!(debug_assertions)` (`lib.rs:142`). `~/Library/Logs/Krypton/` does not exist in production. Every future recurrence is therefore undiagnosable.
6. **No user-facing recovery affordance.** No tray icon, no "panic recenter" global shortcut, no menu-bar item. The only recovery path is `kill`.

## Fix (shipped)

Implemented in `src-tauri/src/lib.rs`:

- **`apply_fullscreen_geometry()`** — positions the window covering the full monitor. Falls back from `current_monitor` → `primary_monitor` → first `available_monitors` → hardcoded 1440×900. The previous one-shot `if let Ok(Some(monitor)) = ...` silently left the default (possibly zero-sized) rect on fallthrough; it now always lands somewhere visible.
- **`on_window_event` handler** — re-applies geometry on `ScaleFactorChanged` (display reconfiguration) and on `Focused(true)` when the window rect does not intersect any available monitor (`window_is_offscreen` helper). This covers sleep/wake, unplugging an external display, and resolution changes.
- **`Cmd+Ctrl+Shift+0` panic recenter** — global shortcut that runs a hide→show cycle, `unminimize()`, `apply_fullscreen_geometry()`, an `always_on_top` flicker, and `set_focus()`. The hide→show forces WKWebView to reattach a surface layer when the window rect is valid but nothing renders (the sleep/wake compositor-loss case where `window_is_offscreen` returns false). Quad-modifier was chosen because the user's own global-shortcut tooling owns the simpler `Ctrl+Shift+0`.
- **Shortcut registration is logged on success** so post-mortem can confirm the hotkey was actually bound (previously only failures were logged, so a silent OS-level conflict looked the same as no event).
- **File logging in release** — removed the `cfg!(debug_assertions)` gate on `tauri_plugin_log`. Logs now go to `~/Library/Logs/Krypton/` in production. Geometry application, display-change reapply, and panic-recenter events all log a line, so the next recurrence is diagnosable from disk.

## Follow-up: macOS Spaces killed WebContent

Issue #20 exposed a different failure mode: switching away from Krypton's macOS
Space made the transparent window `NotVisible`. WebKit attempted to suspend its
WebContent process and killed it when the process could not shrink below the
inactive-process memory threshold. The Rust app and PTYs stayed alive, but the
new frontend used to run normal startup and create one unrelated empty shell.

The shipped defense has three parts:

- The main Tauri window sets `backgroundThrottling: "disabled"`. Tauri/Wry maps
  this to WebKit's `inactiveSchedulingPolicy = None` on macOS 14+, preventing a
  Space switch from entering the failing `prepareToSuspend` path.
- `.krypton-window` no longer carries permanent `will-change: transform,
  opacity`. WAAPI promotes layers while an animation runs; permanent promotion
  can retain a large compositing surface for every Retina-sized terminal window
  and inflate GPU backing-store memory while idle.
- The frontend snapshots window order, layout mode, tabs, pane splits, focus,
  pin/maximize state, and PTY session IDs into the long-lived Rust process after
  compositor changes and immediately before the document becomes hidden. On a
  replacement WebContent bootstrap, Krypton reconstructs that layout and routes
  future PTY output/input back to the existing sessions. It never spawns a
  replacement shell for a saved pane whose PTY disappeared.

Terminal scrollback is owned by xterm.js and therefore dies with WebContent; a
reattached terminal shows an explicit notice. Content-only views such as an ACP
Harness also own substantial JavaScript state and cannot yet be reconstructed;
their original pane remains in the layout as an explicit recovery notice rather
than being silently replaced. The snapshot is deliberately process-local: a
true app exit still starts a new workspace on the next launch.

`Krypton.log` distinguishes the paths as `WebContent startup` and `WebContent
reload`, including whether a snapshot existed and how many PTYs were active.

## Still Recommended — Defense-in-Depth (not yet implemented)

1. **macOS menu-bar tray icon** with `Show Window` / `Quit`. Guaranteed recovery path independent of global shortcuts, which can be stolen by other apps.
2. **Persist and restore last-known-good native geometry** across launches. The
   WebContent snapshot is process-local and intentionally does not replace this.
3. **Broader display-change coverage on macOS.** The current `ScaleFactorChanged` hook catches DPI changes; observing `NSApplicationDidChangeScreenParametersNotification` directly would cover pure topology changes (same DPI, different monitor set) more reliably than relying on the next focus event.
4. **Serializable content-view state.** Terminal panes recover now. Rich views
   need per-view snapshot/reattach contracts before Harness transcripts and
   other frontend-only state can survive an actual WebContent replacement.

## Recovery

- **Cmd+Ctrl+Shift+0** — panic recenter.
- If the native surface is stranded, use panic recenter; it remains a geometry
  repair only. A WebContent reload is automatic and reattaches live PTYs.
- If the whole app process must be killed, PTY sessions are still lost because
  their owner is the Rust process.

## References

- `src-tauri/src/lib.rs` — `apply_fullscreen_geometry`, `window_is_offscreen`, `recover_window`, `on_window_event` handler
- `src-tauri/src/workspace_state.rs` — process-local frontend snapshot and startup/reload classification
- `src/workspace-recovery.ts`, `src/compositor.ts` — snapshot validation, layout reconstruction, and PTY reattachment
- `src-tauri/tauri.conf.json` — window flags (`decorations: false`, `transparent: true`)
- `docs/04-architecture.md` — platform gotchas (macOS fullscreen + transparency)
