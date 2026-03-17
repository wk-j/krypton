# Sound Engine — Specification

> Status: Implemented
> Date: 2026-03-17
> Milestone: M7 — Sound Effects / M8 — Polish
>
> Consolidates: former docs 17, 21, 25, 26

---

## 1. Overview

Krypton's sound engine is entirely frontend-based — no Rust-side audio. The `SoundEngine` class (`src/sound.ts`) plays pre-rendered WAV files via the Web Audio API. Each sound pack is a directory of 17 WAV files. The engine maps 31 UI events and 4 keypress types to these files.

### Architecture

```
WAV file (fetch) -> decodeAudioData() -> AudioBuffer (cached in Map)
                                              |
play() -> AudioBufferSourceNode -> GainNode -> DynamicsCompressorNode -> GainNode (master) -> destination
           (2 nodes per sound)
```

Key properties:
- **2 nodes per sound** (source + gain) — minimal Web Audio overhead
- **No procedural synthesis** — eliminates AudioContext degradation from high node churn
- **Pack-switchable** — users swap entire sound aesthetics via config or command palette
- **Frontend-only** — Rust backend carries `SoundConfig` for serialization but does zero audio processing

---

## 2. Sound Packs

### Built-in Packs

| Pack | Directory | Description |
|------|-----------|-------------|
| `deep-glyph` (default) | `public/sounds/deep-glyph/` | Rich, deep UI sounds |
| `mach-line` | `public/sounds/mach-line/` | Sharp, mechanical interface tones |

### WAV File Convention

All packs must provide exactly 17 WAV files with these names:

```
APP_START.wav          LIMITER_OFF.wav        TAB_SLASH.wav
CLICK.wav              LIMITER_ON.wav         TYPING_BACKSPACE.wav
FEATURE_SWITCH_OFF.wav SWITCH_TOGGLE.wav      TYPING_ENTER.wav
FEATURE_SWITCH_ON.wav  TAB_CLOSE.wav          TYPING_LETTER.wav
HOVER.wav              TAB_INSERT.wav         TYPING_SPACE.wav
HOVER_UP.wav
IMPORTANT_CLICK.wav
```

WAV files originate from the [ghost-signal](https://github.com/wk-j/ghost-signal) project. Each ghost-signal theme exports WAV renders of its 17 sounds.

### Pack Registry

Packs are registered in `src/sound.ts`:

```typescript
interface SoundPack {
  id: string;
  displayName: string;
}

const AVAILABLE_PACKS: SoundPack[] = [
  { id: 'deep-glyph', displayName: 'Deep Glyph' },
  { id: 'mach-line', displayName: 'Mach Line' },
];
```

### Adding a New Pack

1. Create `public/sounds/<pack-name>/`
2. Place all 17 WAV files (same naming convention)
3. Add an entry to `AVAILABLE_PACKS` in `src/sound.ts`
4. The pack appears in the command palette and is selectable via `[sound] pack = "<pack-name>"`

---

## 3. Sound Event Mapping

### UI Events

31 `SoundEvent` values mapped to the 17 WAV files. All packs share this mapping:

| Krypton Event | WAV File | Rationale |
|---|---|---|
| `startup` | `APP_START` | Application awakening |
| `window.create` | `TAB_INSERT` | New element appearing |
| `window.close` | `TAB_CLOSE` | Element disappearing |
| `window.focus` | `HOVER` | Attention/proximity |
| `window.maximize` | `FEATURE_SWITCH_ON` | State toggle on |
| `window.restore` | `FEATURE_SWITCH_OFF` | State toggle off |
| `window.pin` | `LIMITER_ON` | Constraint engaged |
| `window.unpin` | `LIMITER_OFF` | Constraint released |
| `mode.enter` | `CLICK` | Discrete action |
| `mode.exit` | `HOVER_UP` | Stepping back |
| `quick_terminal.show` | `FEATURE_SWITCH_ON` | Toggle on |
| `quick_terminal.hide` | `FEATURE_SWITCH_OFF` | Toggle off |
| `workspace.switch` | `TAB_SLASH` | Navigation command |
| `command_palette.open` | `TAB_SLASH` | Command activation |
| `command_palette.close` | `HOVER_UP` | Dismissal |
| `command_palette.execute` | `IMPORTANT_CLICK` | Confirm action |
| `hint.activate` | `CLICK` | Initiate |
| `hint.select` | `IMPORTANT_CLICK` | Confirm selection |
| `hint.cancel` | `HOVER_UP` | Cancel/dismiss |
| `layout.toggle` | `SWITCH_TOGGLE` | Binary toggle |
| `swap.complete` | `CLICK` | Action complete |
| `resize.step` | `HOVER` | Incremental feedback |
| `move.step` | `HOVER` | Incremental feedback |
| `terminal.bell` | `IMPORTANT_CLICK` | Alert |
| `terminal.exit` | `TAB_CLOSE` | Process ended |
| `tab.create` | `TAB_INSERT` | New tab |
| `tab.close` | `TAB_CLOSE` | Tab removed |
| `tab.switch` | `CLICK` | Navigation |
| `tab.move` | `SWITCH_TOGGLE` | Reorder |
| `pane.split` | `TAB_INSERT` | New pane |
| `pane.close` | `TAB_CLOSE` | Pane removed |
| `pane.focus` | `HOVER` | Focus shift |

### Keyboard Sounds

Four typing WAV files routed by key:

| Key | WAV File |
|---|---|
| `Backspace` | `TYPING_BACKSPACE` |
| `Enter` | `TYPING_ENTER` |
| ` ` (space) | `TYPING_SPACE` |
| Everything else | `TYPING_LETTER` |

Only the `press` phase plays. The `release` phase is a no-op — WAV files include the full envelope.

### Where Sounds Are Triggered

| Location | Events |
|---|---|
| `src/compositor.ts` | Window create/close/focus/maximize/restore/pin/unpin, tab create/close/switch/move, pane split/close/focus, layout toggle, terminal bell (BEL `\x07` detection), terminal exit, keypress sounds, quick terminal show/hide |
| `src/input-router.ts` | Mode enter/exit, resize/move step, swap complete, hint activate/select/cancel |
| `src/command-palette.ts` | Palette open/close/execute |
| `src/main.ts` | Startup sound |

All triggers are direct method calls (`this.sound.play('event.name')`) — no pub/sub event bus.

---

## 4. Overlap Management

| Parameter | Value | Purpose |
|---|---|---|
| `MAX_CONCURRENT` | 8 | Max simultaneous sounds — excess dropped |
| `KEYPRESS_THROTTLE_MS` | 25 | Minimum interval between keypress sounds |
| `EVENT_COOLDOWN_MS` | 50 | Per-event dedup — same event won't re-fire within this window |

---

## 5. AudioContext Lifecycle

### Lazy Initialization

The `AudioContext` is created on first sound play (not at startup) to comply with browser autoplay policy. `ensureContext()` is called before every sound:

1. If context exists and is `running` — return immediately
2. If `suspended` — call `ctx.resume()` (macOS display sleep, audio device change)
3. If `closed` — null everything, recreate on next call
4. If no context — create a new one with master chain

### Master Channel

```
DynamicsCompressorNode (limiter: threshold=-3dB, ratio=8:1, knee=10, attack=3ms, release=100ms)
    -> GainNode (master volume from config)
    -> AudioContext.destination
```

### State Monitoring

A `statechange` listener on the `AudioContext` handles:
- **`closed`**: Nulls all references so the next `ensureContext()` recreates
- **`suspended`**: Calls `ctx.resume()` (best-effort)

---

## 6. WAV Loading

### Load Flow

`loadAllWavs()` is called on first `applyConfig()` or when the pack changes:

1. Clear existing buffer cache
2. Ensure AudioContext exists (needed for `decodeAudioData`)
3. For each of the 17 WAV names, fetch `/sounds/<packName>/<NAME>.wav`
4. Decode each response into an `AudioBuffer` via `ctx.decodeAudioData()`
5. Store in `Map<string, AudioBuffer>`

### Pack Switching

When the user switches packs:

1. `loadTheme(packName)` updates `config.pack`
2. `loaded` flag reset, buffer cache cleared
3. `loadAllWavs()` fetches from the new pack's directory
4. Sounds already playing finish normally; new sounds use new buffers

---

## 7. Playback

### `play(event: SoundEvent)`

1. Check `enabled`, per-event override, cooldown dedup, max concurrent
2. Map event to WAV name via `EVENT_TO_WAV`
3. Look up `AudioBuffer` from cache
4. Create `AudioBufferSourceNode` + `GainNode` (2 nodes)
5. Connect through compressor to master
6. Track active sound count; decrement on `ended` event

### `playKeypress(phase, key)`

1. Ignore `release` phase
2. Check enabled, per-event override for `keypress`
3. Throttle check (25ms minimum interval)
4. Route key to WAV name (`TYPING_BACKSPACE` / `TYPING_ENTER` / `TYPING_SPACE` / `TYPING_LETTER`)
5. Apply `keyboard_volume` multiplier
6. Play via same buffer playback path

---

## 8. Configuration

### TOML (`[sound]` section)

```toml
[sound]
enabled = true              # master toggle
volume = 0.5                # 0.0-1.0
pack = "deep-glyph"         # "deep-glyph" | "mach-line"
keyboard_type = "cherry-mx-brown"  # reserved for future use
keyboard_volume = 1.0       # 0.0-1.0 multiplier for typing sounds

[sound.events]
# Per-event overrides (boolean to toggle, float for volume)
# "terminal.bell" = false   # disable bell sound
# "startup" = 0.3           # quiet startup
```

### Rust (`src-tauri/src/config.rs`)

```rust
pub struct SoundConfig {
    pub enabled: bool,              // default: true
    pub volume: f64,                // default: 0.5
    pub pack: String,               // default: "deep-glyph"
    pub keyboard_type: String,      // default: "cherry-mx-brown"
    pub keyboard_volume: f64,       // default: 1.0
    pub events: HashMap<String, serde_json::Value>,
}
```

### TypeScript (`src/sound.ts`)

```typescript
interface SoundConfig {
  enabled: boolean;
  volume: number;
  pack: string;
  keyboard_type: string;
  keyboard_volume: number;
  events: Record<string, boolean | number>;
}
```

### Hot-Reload

On `config-changed` Tauri event, `SoundEngine.applyConfig()` compares the new `pack` to the previous one. If changed, clears the buffer cache and reloads WAVs from the new directory.

### Command Palette

The command palette dynamically lists all available packs under the "Sound Theme" category. The current pack is marked `(active)`. Selecting a pack calls `soundEngine.loadTheme(packName)`.

---

## 9. Affected Files

| File | Role |
|------|------|
| `src/sound.ts` | Sound engine: WAV loading, buffer cache, playback, event mapping, pack registry, overlap management, AudioContext lifecycle |
| `src/compositor.ts` | Triggers sounds for window/tab/pane/layout actions, keypress sounds, terminal bell |
| `src/input-router.ts` | Triggers sounds for mode changes, resize/move/swap/hint actions |
| `src/command-palette.ts` | Triggers palette open/close/execute sounds; lists sound packs for switching |
| `src/main.ts` | Startup sound |
| `src/config.ts` | TypeScript `SoundConfig` interface |
| `src-tauri/src/config.rs` | Rust `SoundConfig` struct with defaults |
| `public/sounds/deep-glyph/` | 17 WAV files — Deep Glyph pack |
| `public/sounds/mach-line/` | 17 WAV files — Mach Line pack |

---

## 10. Diagnostics

`startDiagnostics()` enables 30-second periodic logging:

```
[SoundEngine] ctx=running active=2 attempted=1423 played=1401 buffers=17/17 loaded=true
```

Fields: AudioContext state, active concurrent sounds, total attempted/played counts, buffer cache population, load status.

---

## 11. Design History

The sound engine evolved through several iterations:

1. **M7 original**: Procedural additive/subtractive synthesis with `krypton-cyber` patches (10-18 Web Audio nodes per sound). Caused AudioContext degradation after hours of use.

2. **Ghost-signal integration**: Added 5 function-based sound themes from the ghost-signal project. Each theme was a JS module exporting `createSounds(ctx, noiseBuffer)` returning fire-and-forget functions. Volume controlled via `Proxy` wrapping `AudioContext.destination`.

3. **AudioContext resilience** (former doc 21): Added `statechange` monitoring and context recycling at 50k sounds to mitigate degradation. Resume-aware guards to handle macOS display sleep.

4. **Buffer cache** (former doc 25): Pre-rendered all sounds into `AudioBuffer`s via `OfflineAudioContext` at theme load time. Reduced per-sound nodes from 10-18 to 2. Ghost-signal `TYPING_LETTER` pre-rendered 8 variants in round-robin pool. Context recycle threshold raised to 500k.

5. **Silence bug analysis** (former doc 26): Identified four interacting causes: `resume()` promise never settling, `warmCache()` race conditions, stale ghost-signal closures, and no output health check. Proposed resume timeout, generation-guarded cache warming, closure invalidation, and `AnalyserNode` output probes.

6. **WAV replacement** (current): Eliminated all procedural synthesis. Replaced with static WAV file playback. Each sound pack is a directory of 17 pre-rendered WAVs. This eliminates the root cause of all prior AudioContext degradation — node churn is now 2 nodes/sound instead of 10-18. The resilience, buffer cache, and silence bug mitigations are no longer needed in the WAV architecture but informed the current design's simplicity.

---

## 12. Out of Scope

- Procedural/real-time synthesis (removed — root cause of AudioContext degradation)
- Custom user sound packs from `~/.config/krypton/sounds/` (future — needs Tauri asset protocol)
- Mixing sounds from different packs
- Per-event WAV override within a pack
- AudioWorklet-based playback
- Rust-side audio engine
