# Program-Status Fire — Implementation Spec

> Status: Implemented
> Date: 2026-11-06
> Milestone: Window chrome — program status presentation (extends [0284](./0284-program-status-osc7501.md))
> Extended by: [0363](./0363-program-status-fire-look.md) — per-state look keys (`height`, `intensity`, `speed`, colours)

## Problem

Krypton already knows, without depending on any particular agent, what the program in each terminal window is doing. OSC 7501 program status (spec 0284) reports `working`, `blocked`, `error` and `done`. Krypton shows this as a status dot, a border accent and a titlebar chip. Some users want something louder: Rune's `rune-fx` fire, with flames off a card's top edge, rising embers and a warm glow (ui-lab `fx` → Ship page). Krypton has no WebGL code, so it cannot draw that.

## Solution

Add a window effect, **fire**, driven only by Krypton's own program-status aggregate. This is the same `winTop` state that `paintProgramStatus` already paints, so no agent or hook-specific event is involved. A new `[fire] on = [...]` key lists the states that set a window on fire. The default is `[]`, so the effect is off until the user turns it on.

The spec also **removes the `[hooks] animation` background animations** (`flame`, `brainwave`, `matrix`; spec 0034), so Krypton no longer animates on Claude Code hook events. The rest of the hook integration stays: `POST /hook`, the status badge, the tool HUD, the uplink bar and the activity trace.

The look is a GLSL ES 3.00 port of rune-fx's **procedural** `FireStyle::Top`:

- noise flames;
- a CPU ember table;
- a soft glow.

It does not include the fluid simulation, so there is no smoke and no heat haze. The fire is rendered in one lazily created WebGL2 canvas per burning window. It burns along the **bottom** edge of the window content, behind the terminal text, so it is never cut off by the viewport and never covers a neighbouring window.

## Research

**Trigger source** (spec 0284, `src/program-status.ts`, `src/compositor.ts`):

- Any program can write `ESC ] 7501 ; state=…`. That covers agents, build tools, deploy scripts and shell functions, because the protocol is shared with Ghostty and Rex and is not tied to one vendor.
- The xterm OSC handler feeds `ProgramStatusStore` (`compositor.ts:1049-1050`). On any change, `handleProgramStatusChange` calls `paintProgramStatus(win)` (`:1437-1452`).
- `paintProgramStatus` computes `winTop`, the window's highest-priority pane summary (`:1456-1480`). Priority runs `idle 0 < working 1 < done 2 < error 3 < blocked 4` (`program-status.ts:197-203`). Fire hooks in at exactly this point, so it always matches what the window chrome shows.
- Lifetime comes from the store, so fire needs no timer or watchdog:
  - `working` and `blocked` are dropped on prompt start (OSC 133 `A`, `:1063`) and on program exit (process poller, 0284).
  - `done` and `error` are dropped when the user types into the pane (`acknowledge`, `:1082`; `program-status.ts:279-281`).
- `paintProgramStatus` also runs after tab moves, splits and closes (`:1704`; 0284 edge 8).
- The Quick Terminal and non-terminal views (agent, harness, vault) register no OSC 7501 handler (0284 edge 9), so they never burn.

**Source effect** (rune `8ee30954`, `crates/rune-fx`, MIT, © 2026 Anomaly):

- `shaders/fire.wgsl` `flames()` treats the host as a rounded-rect SDF and keeps only the part whose normal points up. Its main terms:
  - `span` fades the fire over the corners.
  - Tongue height `hl = H · smoothstep(0.15, 0.95, up) · span`.
  - `fl` adds a slow breathe plus an ~8 Hz flicker per column.
  - Domain-warped `fbm4` turbulence rises over time.
  - Density `(1 − yh)·1.2 + n·0.8 − 0.08` maps to temperature `T`, then through `fire_ramp(T, low, mid, hot)`.
  - Emission is `col · body · (0.3 + 0.75 T²)`. Alpha is `body · occlusion` (0.25).
  - A `base_glow` term lights the edge.
- `shade()` adds the embers: shutter streaks (`segdist`) with a Gaussian core and halo, coloured by `flame_light()` (a blackbody fit from 1000 to 2700 K).
- `cpu.rs::embers()` builds the ember table on the CPU. It is deterministic per `(seed, ember index, generation)`: drag `k = 2.4`, terminal rise `0.32 · ember_rise`, sway, cooling `exp(−age/(0.42·life))·(1−a²)`, and it culls embers below `0.004`. There are two `vec4`s per ember, capped at 40.
- `glow.wgsl` soft variant: `bloom(d) = 0.65·gauss(d, 0.35r) + 0.35·gauss(d, 1.2r)`, passed through `knee(x) = 1 − e^−x`.
- `FireParams::default()` gives:
  - colours `low #8a1405`, `mid #ff5a14`, `hot #ffc65a`;
  - `height 54`, `scale 20`, `speed 1.5`;
  - embers: `ember_rise 58`, `ember_size 0.8`, `ember_life 1.5`;
  - shaping: `warp 1`, `base_glow 0.5`, `occlusion 0.25`.
- The Ship page (`ui-lab/src/bin/fx/pages/ship.rs:108-109`) uses `scale 26`, 24 embers, height `64 + 70·hot`, a soft glow (`#ff7a1a`, radius 30), and spring timing: ignite takes 0.7 s, putting the fire out takes 1.4 s.
- The screenshot's smoke comes from `firesim.wgsl` plus `sim.rs`, a stable-fluids compute pipeline. It is out of scope.

**Krypton constraints:**

- Window geometry. Grid places top-row windows `gap = 6px` below the viewport, which is `overflow: hidden` (`compositor.ts:7683`, `base.css:22`), and every other row sits 6px under a neighbour. Flames above a window would therefore be cut off or would cover another window's text, so the fire burns inside the content, at the bottom.
- `.krypton-window__content` is the stacking context; panes sit at `z-index: 1` (`window.css:942-1002`). A canvas at `z-index: 0` lies under the text, as the music visualizer's canvas does (`music.ts:264-265`).
- There is no WebGL in `src/`. `@xterm/addon-webgl` was dropped in `a706487` because xterm's WebGL renderer could not draw transparent terminal backgrounds. Whether a transparent WebGL canvas composites correctly in the transparent WKWebView is still **[INFERENCE]** and is the first smoke check.
- The JS work per frame is a few GL calls plus a table of at most 24 embers; the GPU does the rest. So the fire runs on the main thread, as `header-scope.ts` does (0188). Spec 0048's worker exists for Canvas 2D animations whose JS was the cost.
- `DESIGN.md:183,362-366` requires dropping ambient infinite animations under `prefers-reduced-motion`. `DESIGN.md:210` says "motion is reserved for state"; program status is state.
- WebKit keeps at most **16** active WebGL contexts and loses the oldest beyond that (`LayoutTests/webgl/max-active-contexts-gc.html`). Released contexts keep counting until GC. Flutter #195025 shows a storm when an app re-creates contexts inside `webglcontextlost`.
- WebGL 2.0 has shipped by default in Safari/WebKit since Safari 15 (Khronos, 2022).

**What the removal touches** (all call sites found by grep):

- `claude-hooks.ts` owns the whole lifecycle:
  - `animations`, `animationType`, `animationIdleTimer` and `ANIMATION_IDLE_TIMEOUT_MS` (`:96-130`);
  - `startFlame()` calls in `SessionStart`, `PreToolUse` and `UserPromptSubmit`, and `stopFlame()` in `Stop` and `SessionEnd` (`:212-305`);
  - `setAnimationType`, `createAnimationCanvas`, `disposeAnimation`, `resizeAnimations`, the idle-timer helpers and `createAnimationInstance` (`:596-705`).
- `compositor.ts` calls into it at five places:
  - `pendingHookAnimation` (`:458`, `:774-780`, `:2323-2326`);
  - the canvas append in `createWindow` (`:2709-2710`);
  - the `removeWindow` dispose (`:5485-5490`);
  - `resizeAnimations` in `fitAll` (`:8642-8644`);
  - the `clearPaneTree` keep-list (`:2212-2214`).
- `flame.ts`, `brainwave.ts` and `matrix.ts` are used only by this path. Two exceptions sit in `flame.ts`:
  - the `BackgroundAnimation` interface is also used by `header-scope.ts` and `offscreen-animation.ts`;
  - `RenderCtx` is also used by `circuit-trace.ts`.
- `offscreen-animation.ts` and `animation-worker.ts` also serve the music visualizer (`music.ts:260`, `'circuit-trace'`), so they stay, trimmed to that one type.
- Config: `HooksConfig.animation` (`config.rs:443-451`, `config.ts:163`). `HooksConfig` has no `deny_unknown_fields`, so an old `animation = "…"` line in a user's file is ignored, not an error.
- There are no tests for any of these files.

**Alternatives ruled out:**

- Moving fire into the `[hooks] animation` slot (0034): it only fires on Claude Code's HTTP hooks, and every window starts and stops together. This spec removes that slot instead.
- Flames outside the window's top edge: cut off or covering a neighbour (see above).
- One shared WebGL context feeding every window through `transferToImageBitmap`: the bitmap is always the full canvas size, so windows of different sizes would need a buffer reallocation every frame.
- Canvas 2D: no per-pixel noise at 60 fps. The `flame` animation removed here cost 5–12% CPU per window (0064).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| rune-fx (Anomaly) | `Fx::fire(FireParams{style: Top})`: WGSL fragment shader on the node SDF plus a CPU ember table; optional fluid sim | Source of the port |
| Rex | OSC 7501 states shown as spinners and symbols on unfocused tab headers, plus a `terminal.program_status_changed` Lua event | Same trigger; the presentation stays quiet |
| VS Code Power Mode | "Flames" preset is a base64 GIF at the cursor on each keystroke | Triggered by typing |
| Atom activate-power-mode | Canvas 2D particles plus screen shake on typing; toggled with `Ctrl-Alt-O` | Triggered by typing |
| Ghostty | `custom-shader`: a Shadertoy-style GLSL pass over the terminal texture; the loop runs only on the focused surface | Whole-surface, user-authored, not tied to state |

**Krypton delta:** this is the first presentation of program status that uses motion. Each window burns on its own state, not on keystrokes and not globally. The fire sits *behind* the text and ships built in, not as user GLSL.

## Affected Files

| File | Change |
|------|--------|
| `src/fire.ts` (new) | `FireController` (per-window map, config, sync, resize, dispose) and `FireAnimation` (canvas, lazy context, frame loop, heat envelope, reduced motion, context loss). Exports pure helpers `fireEmbers`, `stepHeat`, `fireBand` |
| `src/fire-shader.ts` (new) | GLSL ES 3.00 vertex and fragment sources as string constants, headed by rune's MIT notice (no `?raw` imports exist in the repo) |
| `src/fire.test.ts` (new) | Node tests for the pure helpers |
| `src/compositor.ts` | Owns `readonly fire = new FireController()`. `paintProgramStatus` calls `fire.sync(win, winTop?.state ?? null)` right after computing `winTop`, before any of its early returns. `removeWindow` calls `fire.remove(win.id)`. `fitAll` calls `fire.resize()`. `applyConfig` calls `fire.configure(config.fire.on)` and then repaints every window. The `clearPaneTree` keep-list swaps `krypton-flame/brainwave/matrix-canvas` for `krypton-fire-canvas`. Removes `pendingHookAnimation`, its `applyConfig` block and setter, the animation canvas in `createWindow`, its dispose in `removeWindow` and `resizeAnimations` in `fitAll` |
| `src/claude-hooks.ts` | Delete the animation lifecycle listed in Research and its imports. Hook handling, badge, tool HUD, uplink and activity trace are unchanged |
| `src/flame.ts`, `src/brainwave.ts`, `src/matrix.ts` | Delete |
| `src/background-animation.ts` (new) | `BackgroundAnimation` and `RenderCtx`, moved verbatim from `flame.ts`. `header-scope.ts`, `offscreen-animation.ts`, `circuit-trace.ts` and `fire.ts` import them from here |
| `src/offscreen-animation.ts`, `src/animation-worker.ts` | `AnimationType` becomes `'circuit-trace'`. Drop the flame/matrix/brainwave renderer imports, cases, canvas classes, opacities and FPS entries |
| `src/styles/window.css` | Replace the `.krypton-flame-canvas, .krypton-brainwave-canvas, .krypton-matrix-canvas` rule (`:967-979`) with `.krypton-fire-canvas` (below) |
| `src-tauri/src/config.rs` | `FireConfig { on: Vec<String> }`, `#[serde(default)]`, default empty; field `fire` on the root config. Remove `HooksConfig.animation` and its default |
| `src/config.ts` | `FireConfig { on: string[] }`; `fire: FireConfig`. Remove `HooksConfig.animation` |
| `docs/0006-configuration.md` | Add the `[fire]` example block and reference-table row; remove the `[hooks] animation` example line (`:275`) and row (`:1116`) |
| `docs/0030-claude-code-hooks.md` | Remove `animation` from the TOML example (`:392-393`) |
| `docs/0034-background-animations.md` | `Status: Removed (spec 0362)` |
| `docs/0048-offscreen-canvas-animations.md`, `docs/0064-matrix-animation-cpu-burn.md`, `docs/0067-matrix-glyph-atlas.md` | Status note: flame/brainwave/matrix removed by spec 0362; the worker remains for `circuit-trace` |
| `docs/0284-program-status-osc7501.md` | Presentation list gains "window fire (opt-in, spec 0362)" |
| `docs/README.md` | Index row 362 |

## Design

### Data Structures

```ts
// src/fire.ts
export type FireState = 'working' | 'blocked' | 'error' | 'done';
export class FireController {
  configure(on: readonly string[]): void;          // keep known FireState values; warn once per unknown value (0363: takes the whole FireConfig)
  sync(win: KryptonWindow, state: ProgramState | null): void;
  resize(): void;                                   // burning windows only
  remove(windowId: WindowId): void;                 // dispose that window's FireAnimation
}
export interface FireBand { cssWidth: number; cssHeight: number; flameMax: number }
export function fireBand(contentW: number, contentH: number): FireBand; // 0363: adds a height multiplier
// flameMax = clamp(0.22·contentH, 40, 120); cssHeight = min(contentH, ceil(flameMax·2.2))
export function stepHeat(heat: number, target: 0 | 1, dt: number): number;
// exponential approach: τ 0.25 s toward 1 (ignite), τ 0.45 s toward 0 (put out)
export function fireEmbers(t: number, seed: number, band: FireBand, radius: number, heightNow: number, out: Float32Array): number;
// port of cpu.rs::embers with FIRE.embers = 24; writes 2 vec4 per live ember, returns count

const FIRE = { scale: 26, speed: 1.5, warp: 1.0, baseGlow: 0.5, occlusion: 0.25,
  intensity: 0.6, embers: 24, emberRise: 58, emberSize: 0.8, emberLife: 1.5,
  glowRadius: 30, glowReach: 80, fpsCap: 60 } as const;
```

These constants are starting values. Smoke tuning may change them; final values go in Implementation Notes. Every configured state gets the same look; spec 0363 adds per-state looks on top of these constants.

### Rendering

- **Geometry.** The canvas is a band pinned to the content's bottom edge. The fragment shader puts a virtual host rect (radius = the window's `--krypton-border-radius`) directly under the band. Its top edge is the band's bottom row, so `flames()` runs unchanged and its tongues rise into the band. Flame height is `flameMax · (0.45 + 0.55·heat)`, the Ship page's `64 + 70·hot` shape.
- **Per frame.** Draw one full-band triangle. Uniforms:
  - `u_res`, `u_time`, `u_heat`, `u_seed`, `u_height`;
  - the `FIRE` params;
  - three colours;
  - `u_embers[48]` (`vec4`) and `u_emberCount`.
- **Fragment shader.** It returns `flames()` with the smoke term removed, plus the soft glow `bloom(d, 30, 80)·(0.25 + 0.9·heat)` in `mid`, plus the embers. Everything is multiplied by `FIRE.intensity · heat`, encoded linear→sRGB, and TPDF-dithered (`finish()`).
- **Compositing.** The output is valid premultiplied colour: sRGB light with alpha `max(body·occlusion, max(rgb))`, so light covers at least its own brightness. The canvas sits under the panes, so text is never covered.
- **Context options.** `{ alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' }`.
- **Resolution.** The backing store is the band's CSS size × 1, ignoring `devicePixelRatio`. Fire is soft, and this quarters the fill on 2× displays.
- **Port map.** WGSL `u32` hashes (`pcg`, `hcell`) become GLSL `uint`. `mat2x2f` becomes `mat2`. `select(a, b, c)` becomes `c ? b : a`. Every float is `highp`.
- **Seed.** Each window gets its own random seed, so two burning windows never flicker in sync.

### Data Flow

```
1. Program writes ESC ] 7501 ; state=working ESC \  (any program, any agent)
2. ProgramStatusStore → handleProgramStatusChange → paintProgramStatus(win) → winTop
3. fire.sync(win, winTop?.state ?? null)
   burning = configured.has(state)
   a. burning, no instance → new FireAnimation(seed); insert canvas as first child of
      win.contentElement; start()
   b. burning, instance stopped → start()        c. not burning, running → stop()
4. FireAnimation.start(): first time → getContext('webgl2'), compile/link
   (failure → controller marks fire unavailable, one console.warn with the GL log, no canvas shown);
   read --krypton-fire-{low,mid,hot} (fallback to rune defaults); resize(); t = 0; target 1; rAF
5. Frame (≤ 60 fps by timestamp gate): heat = stepHeat(); fireEmbers(); uniforms; drawArrays
6. State leaves the set (prompt start, program exit, user typed after done/error, or the
   window shows a higher-priority state) → stop(): target 0; loop runs until heat < 0.01,
   then cancels rAF and sets display: none (idle cost 0)
7. Window close → fire.remove(id): cancel rAF, remove listeners,
   WEBGL_lose_context.loseContext(), remove canvas
```

A window that never burns never gets a canvas or a context.

### UI Changes

```css
.krypton-fire-canvas {
  position: absolute; left: 0; right: 0; bottom: 0; /* height set inline from fireBand */
  z-index: 0; pointer-events: none; display: none;
  transform: translateZ(0); /* same preserve-3d compositing as .krypton-circuit-trace-canvas */
}
```

There are no keybindings. The fire follows state; it is not a command (`DESIGN.md:210`).

### Configuration

```toml
[fire]
on = ["working"]   # OSC 7501 states that set a window on fire: working | blocked | error | done. Default [] (off)
```

The key hot-reloads through `config-changed` → `applyConfig` → `fire.configure`, then every window is repainted. Themes can recolour the fire through spec 303 tokens: `krypton-fire-low`, `krypton-fire-mid` and `krypton-fire-hot`, which all match `^[a-z][a-z0-9-]{0,63}$`.

### Verification

- `npm run check` and `npx vitest run src/fire.test.ts` pass. The tests cover:
  - `fireEmbers` is deterministic for equal inputs (no frame-to-frame jitter);
  - it never returns more than 24 embers, and every ember's temperature is above 0.004;
  - `stepHeat` falls below 0.01 within 2.5 s of target 0, which guarantees the loop stops.
- A throwaway Vite page opened in Safari (WebKit, the WKWebView engine) mounts `FireAnimation` over a transparent mock window to check the shader. It is deleted afterwards.
- App smoke on a Krypton build, with `on = ["working"]`:
  - `printf '\e]7501;state=working\e\\'` ignites only that window;
  - a new prompt or `printf '\e]7501;state=clear\e\\'` puts it out and the loop ends (no rAF in the Web Inspector timeline);
  - the fire stays behind the text, and transparency is correct over the desktop;
  - reduced motion shows a static frame.
- Removal: a grep of `src/` and `src-tauri/src/` for `FlameAnimation|BrainwaveRenderer|MatrixRenderer|setAnimationType|startFlame|hooks.animation` returns nothing. Krypton still loads a `krypton.toml` that keeps an old `[hooks] animation = "matrix"` line. A Claude Code session still drives the badge, uplink and activity trace, with no canvas animation. The music visualizer still draws.

## Edge Cases

- **Several panes or tabs in different states:** the window burns only when `winTop`, the state its chrome already shows, is configured. With `on = ["working"]`, one `blocked` pane overrides a `working` one and the fire goes out.
- **`done` or `error` configured:** the fire burns until the user types into that pane (`acknowledge`).
- **SSH:** reports pass through, but the local poller cannot see the remote program exit. `working` therefore persists until a remote `OSC 133;A` or `clear` (0284 edge 6).
- **WebGL2 unavailable or the shader fails to compile:** fire is disabled for the session, with one `console.warn` carrying the GL info log. Program-status chrome is unaffected.
- **`webglcontextlost`:** `preventDefault()`, stop the loop, hide the canvas. Never call `getContext` again from the handler (the Flutter #195025 storm). On `webglcontextrestored`, rebuild the program and resume if the window still burns.
- **More than 16 burning windows:** WebKit drops the oldest context, and that window goes dark through the handler above. Krypton creates no other WebGL contexts.
- **`prefers-reduced-motion: reduce`:** `start()` draws one frame at `heat = 1, t = 0` with no embers and no loop. `stop()` hides at once. A live `change` event switches between the static frame and the loop, as `header-scope.ts:77-82` does.
- **Content shorter than the band:** `cssHeight = contentH`. A 0×0 content (hidden workspace) skips the draw that frame.
- **High-refresh displays:** the timestamp gate caps drawing at 60 fps. `u_time` is real elapsed seconds (scaled by the look's `speed` since 0363), so flame speed does not change.
- **Theme change mid-burn:** colours are re-read on the next `start()` (0363: also on a look change).
- **Very long burns:** `t` resets on every `start()` and wraps every 600 s, so the `highp` noise inputs stay small. The one-frame pattern jump at the wrap is lost in the flicker.
- **Old config files:** `[hooks] animation = "…"` is silently ignored once the field is removed (`HooksConfig` does not deny unknown fields). Nothing migrates it to `[fire]`, because the trigger and the meaning both change.

## Implementation Notes

Deviations from the approved design, all found while smoking the shader in WebKit:

- **Output alpha.** The draft emitted `rgb > alpha` (additive light on a premultiplied canvas). On a translucent window over a bright backdrop, WebKit composited that as washed-out pastel. The shader now emits `alpha = max(cover, max(rgb))`. The flames read as fire, and because the canvas is under the panes the text stays sharp.
- **`fireEmbers` takes `radius`.** rune insets the ember spawn range by the corner radius (`x0 = 0.6r … w − 0.6r`), so the radius is a parameter.
- **Token colours** go through a 1×1 2D canvas after `getComputedStyle`. A theme can therefore use `oklch()` or `color-mix()`, not only `rgb()`/hex.
- **Glow reach** is the constant `FIRE.glowReach = 80`.
- **Failure handling.** Any failure (no WebGL2, or the shader fails to compile or link) disables fire for the session, as specified. `FireController` disposes every fire and warns once.

**Verified:**

- `npx tsc --noEmit` passes.
- `npx vitest run`: 286 files, 3429 tests pass, including 7 in `fire.test.ts`.
- On a mac-mini copy of the tree, `cargo test --lib config::` passes 25 tests, including the new `retired_hook_animation_is_ignored_and_fire_states_parse`.
- `cargo clippy --all-targets` reports nothing in the touched files. Its two warnings are already in `inline_remote.rs` and `timeline.rs`.
- `cargo fmt -- --check` is clean.
- Playwright WebKit 2311 (the WKWebView engine) on a mock window:
  - WebGL2 is present and the shader compiles.
  - `working` lights a 900×252 band for 520 px of content.
  - Switching to `blocked` (not configured) puts it out.
  - The loop runs 60 rAF/s while burning and 0 after it goes out.
  - Reduced motion shows a static frame with 0 rAF.
  - `remove()` detaches the canvas.
  - `oklch`/`color-mix` tokens recolour the flames.

**Not yet verified:** a smoke inside the Krypton app itself. This needs the native transparent window, the compositor wiring, and `printf '\e]7501;state=working\e\\'` from a real pane. This machine has no disk space for a Tauri build, and the running Krypton hosts this session.

## Open Questions

None.

## Out of Scope

- Any agent-specific trigger. The rest of the Claude Code hook integration (`POST /hook`, badge, tool HUD, uplink bar, activity trace) is unchanged.
- Windows without OSC 7501: harness lanes, the Agent view and the Quick Terminal. Lanes have their own ACP status.
- OSC 9;4 progress as a trigger.
- Smoke, the fluid simulation, heat haze (it needs backdrop sampling, and WebGL cannot read DOM pixels), and WebGPU.
- Fire outside a window's edges and a worker/`OffscreenCanvas` path. (A different look per state and intensity/size keys were added by spec 0363.)
- Loading `@xterm/addon-webgl`.

## Resources

- rune `crates/rune-fx` at `8ee30954` (`shaders/fire.wgsl`, `glow.wgsl`, `common.wgsl`, `cpu.rs`, `params.rs`), MIT: the ported math and its defaults.
- ui-lab `src/bin/fx/pages/ship.rs`: the screenshot's layer stack, ember count, height and spring timing.
- [Program Status Protocol rev 0.3](https://www.superlogical.com/rex/docs/build/program-status) and [A Terminal Protocol for Program Status](https://mitchellh.com/writing/program-status-osc7501): the trigger states, their lifetime, and Rex's presentation.
- [WebKit `max-active-contexts-gc.html`](https://github.com/WebKit/WebKit/blob/main/LayoutTests/webgl/max-active-contexts-gc.html): the 16-context limit.
- [flutter/flutter#195025](https://github.com/flutter/flutter/issues/195025): WebKit counts released contexts until GC; re-creating inside `contextlost` storms.
- [WebKit Features in Safari 17.0](https://webkit.org/blog/14445/webkit-features-in-safari-17-0): OffscreenCanvas WebGL (considered for a worker path, not adopted).
- [Khronos: WebGL 2.0 pervasive support](http://www.khronos.org/news/permalink/webgl-2.0-achieves-pervasive-support-from-all-major-web-browsers): WebGL2 in Safari.
- [hoovercj/vscode-power-mode](https://github.com/hoovercj/vscode-power-mode), [JoelBesada/activate-power-mode](https://github.com/JoelBesada/activate-power-mode): editor fire and particle prior art.
- [Ghostty `custom-shader`](https://ghostty.org/docs/config/reference#custom-shader): terminal shader prior art and focused-only animation loop.
