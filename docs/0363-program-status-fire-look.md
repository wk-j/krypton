# Program-Status Fire Look — Implementation Spec

> Status: Implemented
> Date: 2026-11-06
> Milestone: Window chrome — program status presentation (extends [0362](./0362-program-status-fire.md))
> Moved by: [0391](./0391-workspace-fire.md) — the looks now apply to the single workspace fire, which takes the look of the most urgent burning window state; `height` scales from the workspace height

## Problem

Spec 0362 ships one fire look for every state. `[fire] on` chooses which OSC 7501 states burn, and three theme tokens recolour the fire, but height, brightness and speed are constants in `src/fire.ts`. A user cannot make `blocked` look different from `working`. Recolouring also needs a full custom theme file, because a theme file replaces the built-in theme it shadows instead of merging with it (`theme.rs:679`).

## Solution

`[fire]` gains six optional look keys: `height`, `intensity` and `speed` (multipliers; `1.0` is the 0362 look) and `low`, `mid` and `hot` (CSS colours). A `[fire.<state>]` table for `working`, `blocked`, `error` or `done` takes the same keys and overrides `[fire]` for that state only, key by key. This is the override pattern `[acp_harness.assist.tasks.<id>]` already uses. When the state of a burning window changes, the fire eases to the new look instead of switching in one frame. `on` remains the only switch that turns fire on or off. The shader does not change.

## Research

**Where each knob lives today** (`src/fire.ts`, `src/fire-shader.ts`):

- Height. `fireBand` computes `flameMax = clamp(0.22·contentH, 40, 120)` and sizes the canvas band to `min(contentH, ceil(flameMax·2.2))`. Each frame draws flames `flameMax·(0.45 + 0.55·heat)` tall (`u_height`).
- Intensity. `FIRE.intensity = 0.6` reaches the shader as `u_p1.y`, and `k = u_p1.y·u_heat` scales both emission and coverage (`fire-shader.ts:222-233`).
- Speed. The shader clock `u_time` drives the flicker (`t·1.3` and `t·8`, `:178-179`) and, through `FIRE.speed = 1.5`, the upward scroll (`tr = t·u_p0.y`, `:168`). The ember table is a function of the same `t` (`fireEmbers`). `t` is real elapsed seconds and wraps at 600 s.
- Colour. `start()` resolves `var(--krypton-fire-{low,mid,hot}, <rune default>)` into linear RGB through a 1×1 2D canvas (`readTokenColor`). It does this only when the fire was out, so a theme change applies on the next ignite.
- `FireController.configure(on)` takes only the state list. `compositor.ts:778` passes `config.fire?.on ?? []` and then repaints every window, and `sync(win, state)` calls `start()`, which does nothing while the fire is already lit. A burning window that moves from `working` to `blocked` therefore keeps its look.

**Config conventions** (`config.rs`):

- `AssistTaskOverride` is the precedent for a per-key override table: every field is `Option`, `skip_serializing_if = "Option::is_none"`, and an unset key falls back to the parent table.
- Rails (`src/acp/rails/config.ts`) is the precedent for ranges: Rust only parses, and the frontend clamps.
- A value of the wrong TOML type fails the whole load, and `load_config` falls back to defaults (`config.rs:1166-1175`). This already applies to every typed key, `on` included.
- TOML allows `inf` and `nan` floats. serde_json serialises a non-finite `f64` as `null`, so the frontend receives such a value as `null`.

**Alternatives ruled out:**

- **Absolute pixels for height.** The 0362 flame height scales with window height and is clamped to 40–120 px. A pixel key would either drop that scaling or need a second key for it. A multiplier keeps the scaling and matches the other two keys.
- **Speed as a multiplier on `u_time`.** Changing the multiplier mid-burn jumps the noise phase, so the flames would teleport. Accumulating a phase `t += dt·speed` keeps the motion continuous when the speed changes. It also scales the flicker, the scroll and the embers together, which is what "faster fire" means.
- **Per-state colours as theme tokens only** (`krypton-fire-blocked-mid`). A user on a built-in theme would still need to copy a whole theme file. Config colours avoid that. Config colours outranking theme colours follows `[theme.colors]` (`theme.rs:731-767`).
- **Snapping to the new look in one frame.** Colour and height would jump in a single frame and read as a glitch, while ignite and put-out already ease through the heat envelope. The look ease reuses the ignite time constant (τ 0.25 s).
- **A canvas sized for the tallest configured state.** It is simpler, but a 3× `blocked` height would triple the fill cost of every `working` frame.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Windows Terminal | `unfocusedAppearance`: an object inside a profile that overrides appearance keys only (`opacity`, `colorScheme`, `experimental.pixelShaderPath`, …) while the pane is unfocused; unset keys keep the profile value | Same shape as `[fire.<state>]`, with one state instead of four |
| VS Code Power Mode | `powermode.presets` picks a built-in effect; 20+ settings tune it (`explosions.maxExplosions`, `explosionFrequency`, `customExplosions` GIFs, `customCss`) | Tuned per effect, not per state; triggered by typing |
| Atom activate-power-mode | Particles: colour (`cursor`, `random` or fixed), total count, spawn count, size; screen shake intensity | Knobs are size, amount and colour; no per-state look |
| Ghostty | Only user GLSL (`custom-shader`); `custom-shader-animation` = `true` (loop while focused), `false` (draw on update) or `always` | The look is whatever the shader author writes; no parameter keys |
| rune-fx | `FireParams` exposes `height`, `scale`, `speed`, `low`/`mid`/`hot`, ember keys and glow | The source of the 0362 look; this spec exposes three of those as multipliers, plus the colours |

**Krypton delta:** the look is chosen per program state, like Windows Terminal's per-focus appearance, and each key falls back on its own. Like the power-mode packages, Krypton exposes a few safe knobs instead of user shaders. Unlike them, every key hot-reloads and is clamped, so no value can break the fire.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/config.rs` | New `FireLook` (six `Option` fields, `skip_serializing_if`). `FireConfig` flattens one `FireLook` and gains `working`, `blocked`, `error` and `done: Option<FireLook>`. Tests: per-state table parse, integer literal `height = 2`, and unset keys absent from JSON |
| `src/config.ts` | Mirror `FireLookConfig`; `FireConfig extends FireLookConfig` with the four state tables |
| `src/fire.ts` | `resolveFireLooks`, `FIRE_LOOK_LIMITS`, `stepLook`, `fireBand(w, h, height)`; `FireController.configure(cfg)`; `sync` passes the state's look; `FireAnimation.setLook`, phase clock, config colours ahead of theme tokens, band grow and shrink |
| `src/fire.test.ts` | Precedence, clamp, non-finite, `stepLook` convergence, `fireBand` height scaling |
| `src/compositor.ts` | `this.fire.configure(config.fire)` (`:778`) |
| `docs/0006-configuration.md` | `[fire]` example and reference rows for the six keys and `[fire.<state>]` |
| `docs/0362-program-status-fire.md` | Note that 0363 overrides "every configured state gets the same look" and two Out of Scope items |
| `docs/README.md` | Index row 363 |

## Design

### Data Structures

```rust
// config.rs — Rust parses; ranges and colour validity are the frontend's job.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FireLook {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub intensity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub low: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub mid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub hot: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FireConfig {
    pub on: Vec<String>,
    #[serde(flatten)] pub look: FireLook,
    #[serde(skip_serializing_if = "Option::is_none")] pub working: Option<FireLook>,
    // blocked, error, done: same
}
```

```ts
// fire.ts
export const FIRE_LOOK_LIMITS = {
  height: { min: 0.25, max: 3 }, intensity: { min: 0.1, max: 2 }, speed: { min: 0.25, max: 4 },
} as const;
/** One state's look. A colour is the first valid config value (state first); null = theme token, then built-in. */
export interface FireLook {
  height: number; intensity: number; speed: number;
  low: string | null; mid: string | null; hot: string | null;
}
export function resolveFireLooks(
  cfg: FireConfig | null | undefined, warn: (msg: string) => void, isColor: (value: string) => boolean,
): Record<FireState, FireLook>;
export function stepLook(live: LiveLook, target: LiveLook, dt: number): boolean;
// eases `live` in place (LiveLook = numbers + linear Rgb; τ 0.25 s); true once settled and snapped
export function fireBand(contentW: number, contentH: number, height: number): FireBand;
// flameMax = clamp(0.22·contentH, 40, 120) · height; cssHeight = min(contentH, ceil(flameMax·2.2))
```

Precedence for every key, independently: `[fire.<state>]`, then `[fire]`, then the built-in value (`1.0`, or the theme token `--krypton-fire-<c>` and then the rune default for colours). A number outside its range is clamped, with one `console.warn` per key and value. `null` (from `inf`/`nan`) and any other non-number count as unset. A colour value counts only if `CSS.supports('color', value)` is true. Each rejected colour logs one warning, and the next table is tried. `var()` values are accepted and resolve through the cascade as tokens already do; one that names an unset property resolves to the inherited text colour (see Implementation Notes).

### Data Flow

```
1. Reload Config → applyConfig → fire.configure(config.fire)
   looks = resolveFireLooks(cfg); repaint every window (as today)
2. paintProgramStatus → fire.sync(win, state)
   burning → fire.setLook(looks[state]); fire.start()
3. FireAnimation.setLook(look): the same object as the current target is a no-op (sync
   runs on every repaint; looks are rebuilt only by configure). Otherwise target = look, and
   if the fire is lit: resolve the target's colours, grow the band now if the target needs
   it, then reduced motion → snap live = target and redraw the static frame;
   otherwise the frame loop eases toward it
   start() from out (where 0362 already reads colours): resolve the target's colours
   (re-reading theme tokens), snap live = target, size the band for it
4. Frame: heat = stepHeat(); live = stepLook(live, target, dt)
   t = (t + dt·live.speed) % 600
   u_height = clamp(0.22·contentH, 40, 120)·live.height·(0.45 + 0.55·heat)
   u_p1.y = FIRE.intensity·live.intensity; u_low/mid/hot = live colours
   once live ≈ target (every |Δ| < 0.001, then snap) and the band is taller than live needs → shrink it
5. Putting out keeps the last look while heat falls (0362 step 6)
```

The canvas is resized at most twice per look change: it grows when the change starts and shrinks when the ease ends.

### Configuration

```toml
[fire]
on = ["working", "blocked", "error"]
height = 0.8          # 0.25–3, 1 = 0362 look
intensity = 1.0       # 0.1–2
speed = 1.0           # 0.25–4
# low / mid / hot: any CSS colour; unset → theme token krypton-fire-* → built-in

[fire.blocked]        # overrides [fire] for blocked only, key by key
height = 1.4
speed = 1.6
low = "#3a0a6a"
mid = "#b04dff"
hot = "#ffd6ff"

[fire.error]
intensity = 1.5
```

Every key hot-reloads with Reload Config. A `[fire.<state>]` table for a state that is not in `on` stays inert, so a user can disable a state without deleting its look.

### Keybindings

None. The look follows the program state and the config (0362, `DESIGN.md:210`). Reload Config is already reachable from the palette.

## Edge Cases

- **A state table sets only some keys:** the others come from `[fire]`, then from the built-in values. `[fire.blocked] speed = 2` keeps the `[fire] height`.
- **State changes while lit** (`working` → `blocked`, both in `on`): ease over about 1 s (τ 0.25 s). The flames never teleport, because speed changes the rate of the phase clock, not its value.
- **State leaves `on` while lit:** heat falls with the current look (0362 step 6). There is no ease toward a look that will never show.
- **Reload Config while lit:** the same window and state get the new target and ease to it.
- **Reduced motion:** every look change snaps and redraws the static frame. Speed has no effect.
- **Fill cost:** band area grows linearly with `height`. At 3× a window pays about 3× the 0362 fill cost while it burns, and a window that is out pays nothing, as before.
- **Height past the content:** `cssHeight` is still capped at the content height, so a tall look on a short window is cut at the content top edge.
- **Wrong TOML type** (`height = "tall"`): the whole config fails to load and falls back to defaults, as every typed key does today. The error is in `Krypton.log`.
- **`inf`/`nan`:** arrive as `null` and count as unset.
- **Invalid colour** (`mid = "orangey"`): skipped with one warning; the same key in `[fire]` is tried next, then the theme token.
- **Theme change mid-burn:** token colours are re-read on the next look change or ignite. 0362 re-read them only on ignite.
- **`[fire.idle]` or another unknown table:** ignored by serde. `idle` never burns.

## Verification

- `npx vitest run src/fire.test.ts`:
  - a state key beats `[fire]`, which beats the built-in value, per key;
  - out-of-range numbers clamp to `FIRE_LOOK_LIMITS` and `null` counts as unset;
  - `stepLook` gets within 0.01 of its target in 1.5 s of 60 fps steps and never overshoots on a stalled frame;
  - `fireBand` scales `flameMax` by `height` and never exceeds the content height.
- `cargo test --lib config::`: a per-state table and `height = 2` parse; unset keys are absent from the JSON.
- `npx tsc --noEmit`, `cargo clippy`, `cargo fmt -- --check`.
- Playwright WebKit on the 0362 mock window: `working` → `blocked` eases colour and height with no frame-to-frame pattern jump, the band grows and then shrinks once, and reduced motion snaps.
- App smoke on a Krypton build, with the window on screen: write `ESC ] 7501 ; state=working ESC \` and then `state=blocked` to the pane's tty; a window capture (`screencapture -l`) shows both looks.

## Implementation Notes

Deviations from the approved design:

- **`FireLook` colours are `string | null`**, not a candidate list. `resolveFireLooks` already walks state → `[fire]` and keeps the first valid value, so a list would only ever be read at `[0]`.
- **`resolveFireLooks(cfg, warn, isColor)`** takes the colour check as a parameter. The controller passes `CSS.supports('color', v)`, and the Node tests pass a stub. `warn` messages are deduplicated by the controller, so a Reload Config repeats none of them.
- **`stepLook(live, target, dt)` eases `live` in place and returns `true` once settled** instead of returning a new object, so the frame loop allocates nothing.
- **A `var()` naming an unset property** passes `CSS.supports` but resolves to the inherited colour, which is the content's text colour, not the next candidate. CSS defines this behaviour: the value is invalid at computed-value time and `color` inherits. Checked in WebKit 2311: `var(--nope)` under `rgb(1, 2, 3)` computes to `rgb(1, 2, 3)`.

**Verified:**

- `npx tsc --noEmit` passes.
- `npx vitest run`: 286 files and 3436 tests pass, including 14 in `fire.test.ts`.
- `cargo test --lib config::`: 26 tests pass, including `fire_look_keys_and_state_tables_reach_the_frontend`.
- `cargo fmt -- --check` is clean.
- `cargo clippy --all-targets` warns only about the existing `assert_eq!` in `timeline.rs:3244`.
- Playwright WebKit 2311 on a 900×520 mock window, with `on = ["working", "blocked"]` and `[fire.blocked] height = 2, speed = 2` plus violet colours:
  - `working` burns in a 252 px band;
  - switching to `blocked` grows the band to 504 px at once;
  - the live height is 1.38 at 114 ms, 1.81 at 415 ms and 1.98 at 1015 ms, and settles on 2;
  - the phase clock never steps more than 0.036 between frames;
  - switching back to `working` keeps 504 px during the ease and shrinks to 252 px once, at 1.7 s;
  - after the fire goes out there are 0 rAF in 500 ms;
  - under reduced motion the look change snaps (504 px band, 0 rAF);
  - configuring twice with `on = [..., "idle"]`, `height = 9` and `mid = "orangey"` prints each of the three warnings once;
  - screenshots show orange `working` flames and taller violet `blocked` flames behind the pane text.

**Not yet verified:** the app smoke inside Krypton itself. The running Krypton hosts this session, so it was not rebuilt or reinstalled.

## Open Questions

None.

## Out of Scope

- Ember count, ember size, glow radius, flame scale and warp. They stay `FIRE` constants.
- Fire on any edge other than the bottom, and windows without OSC 7501 (harness lanes, Agent view, Quick Terminal), as in 0362.
- User-authored shaders and named presets.
- A per-window or per-program look (for example keyed on OSC 7501 `app`).
- Keybindings or palette commands for the look.

## Resources

- [Windows Terminal — Appearance profile settings](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-appearance): `unfocusedAppearance`, the per-state override object, and its appearance-only key list.
- [hoovercj/vscode-power-mode](https://github.com/hoovercj/vscode-power-mode): presets plus tuning settings.
- [JoelBesada/activate-power-mode](https://github.com/JoelBesada/activate-power-mode): particle colour, count and size knobs.
- [Ghostty option reference](https://ghostty.org/docs/config/reference): `custom-shader` and `custom-shader-animation`.
- [0362 Program-Status Fire](./0362-program-status-fire.md): rune-fx `FireParams`, the shader and the lifecycle this spec extends.
