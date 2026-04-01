# Sound Engine — Specification

> Status: Implemented
> Date: 2026-03-17
> Milestone: M7 — Sound Effects / M8 — Polish
>
> Consolidates: former docs 17, 21, 25, 26

---

## 1. Overview

Krypton's sound engine runs in the Rust backend (`src-tauri/src/sound.rs`) using the `rodio` crate for OS-native audio playback via cpal/CoreAudio. The frontend `SoundEngine` class (`src/sound.ts`) is a thin IPC wrapper — it contains no Web Audio API code. Each sound pack is a directory of 17 WAV files bundled as Tauri resources.

### Architecture

```
App startup: SoundEngine::new() spawns "krypton-audio" thread
             SoundEngine::init() sends LoadPack -> audio thread reads 17 WAVs into HashMap

Frontend event -> invoke('sound_play') -> Rust sound_play command
  |                                         |
  |                                         v
  |                                       Check enabled, cooldown, throttle
  |                                         |
  |                                         v
  |                                       mpsc::send(AudioMsg::Play { wav_name, volume })
  |                                         |
  v                                         v
(returns immediately)                   Audio thread: clone bytes -> Decoder -> Sink -> OS audio
```

Key properties:
- **Rust-native audio** — uses `rodio`/`cpal` for direct OS audio output, no browser WebView involvement
- **Dedicated audio thread** — `OutputStream` is `!Send`, so it lives on a named thread. Communication via `mpsc` channel
- **No procedural synthesis** — static WAV file playback only
- **Pack-switchable** — users swap entire sound aesthetics via config or command palette
- **No AudioContext issues** — eliminates all WebView audio degradation, suspended-state, and silence bugs

---

## 2. Sound Packs

### Built-in Packs

| Pack | Directory | Description |
|------|-----------|-------------|
| `deep-glyph` (default) | `src-tauri/sounds/deep-glyph/` | Rich, deep UI sounds |
| `mach-line` | `src-tauri/sounds/mach-line/` | Sharp, mechanical interface tones |
| `holo-dash` | `src-tauri/sounds/holo-dash/` | Holographic dashboard interface tones |

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

Packs are registered in `src-tauri/src/sound.rs`:

```rust
fn available_packs() -> Vec<SoundPack> {
    vec![
        SoundPack { id: "deep-glyph".into(), display_name: "Deep Glyph".into() },
        SoundPack { id: "mach-line".into(), display_name: "Mach Line".into() },
        SoundPack { id: "holo-dash".into(), display_name: "Holo Dash".into() },
    ]
}
```

Display names are also mirrored in `src/sound.ts` for synchronous access in the command palette.

### Adding a New Pack

1. Create `src-tauri/sounds/<pack-name>/`
2. Place all 17 WAV files (same naming convention)
3. Add an entry to `available_packs()` in `src-tauri/src/sound.rs`
4. Add the display name to `PACK_DISPLAY_NAMES` in `src/sound.ts`
5. The pack appears in the command palette and is selectable via `[sound] pack = "<pack-name>"`

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

## 5. Audio Thread Lifecycle

### Initialization

The audio thread is spawned at app startup by `SoundEngine::new()`. It owns the `rodio::OutputStream` (which holds the cpal audio device) and the `OutputStreamHandle` for creating `Sink`s. The thread blocks on `mpsc::Receiver::recv()` waiting for `AudioMsg` messages.

If no audio output device is available, `OutputStream::try_default()` fails, the thread drains the channel and exits. All subsequent `play()` calls are silent no-ops.

### Audio Chain

```
WAV bytes (Vec<u8>) -> Cursor -> rodio::Decoder -> rodio::Sink (with volume) -> OS audio output
```

Each sound gets its own `Sink` with configurable volume. Sinks are tracked in a `Vec<Sink>` and pruned (via `sink.empty()`) before each new sound.

---

## 6. WAV Loading

### Load Flow

On `AudioMsg::LoadPack`, the audio thread:

1. Clears the existing buffer `HashMap`
2. Reads each of the 17 WAV files from `<resource_dir>/sounds/<pack>/<NAME>.wav`
3. Stores raw bytes as `Vec<u8>` in `HashMap<String, Vec<u8>>`

WAV files are bundled as Tauri resources (declared in `tauri.conf.json` under `bundle.resources`). At runtime, resolved via `app.path().resource_dir()`.

### Pack Switching

When the user switches packs (via command palette or config change):

1. Frontend calls `invoke('sound_load_pack', { pack })` or config hot-reload triggers `apply_config()`
2. `SoundEngine` sends `AudioMsg::LoadPack { pack_dir }` to the audio thread
3. Audio thread clears buffer cache, reads new WAV files
4. Sounds already playing on existing Sinks finish normally; new sounds use new buffers

---

## 7. Playback

### `sound_play(event)` (Tauri command)

1. Lock `SoundEngineState` mutex
2. Check `enabled`, per-event override, cooldown dedup (50ms)
3. Map event to WAV name via `event_to_wav()` match
4. Calculate volume: `config.volume * per_event_override`
5. Send `AudioMsg::Play { wav_name, volume }` to audio thread
6. Audio thread: prune finished sinks, check `MAX_CONCURRENT`, clone bytes, decode, create `Sink`, play

### `sound_play_keypress(key)` (Tauri command)

1. Lock mutex
2. Check enabled, per-event override for `keypress`
3. Throttle check (25ms minimum interval)
4. Route key to WAV name (`TYPING_BACKSPACE` / `TYPING_ENTER` / `TYPING_SPACE` / `TYPING_LETTER`)
5. Calculate volume: `config.volume * config.keyboard_volume * per_event_override`
6. Send `AudioMsg::Play` to audio thread

---

## 8. Configuration

### TOML (`[sound]` section)

```toml
[sound]
enabled = true              # master toggle
volume = 0.5                # 0.0-1.0
pack = "deep-glyph"         # "deep-glyph" | "mach-line" | "holo-dash"
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

The TypeScript `SoundEngine` class is a thin IPC wrapper. `play()` and `playKeypress()` call `invoke()` to the Rust backend. No Web Audio API code.

### Hot-Reload

On config file change, `lib.rs::reload_and_emit()` calls `engine.apply_config()` directly on the Rust `SoundEngine` — no IPC round-trip. If the pack changed, the audio thread reloads WAV files.

### Command Palette

The command palette dynamically lists all available packs under the "Sound Theme" category. The current pack is marked `(active)`. Selecting a pack calls `soundEngine.loadTheme(packName)` which invokes `sound_load_pack` on the backend.

---

## 9. Affected Files

| File | Role |
|------|------|
| `src-tauri/src/sound.rs` | Rust sound engine: audio thread, WAV buffer cache, playback via rodio, event mapping, overlap/throttle/cooldown, Tauri commands |
| `src-tauri/src/lib.rs` | Sound engine initialization, command registration, hot-reload integration |
| `src-tauri/src/config.rs` | Rust `SoundConfig` struct with defaults |
| `src/sound.ts` | Thin IPC wrapper: `play()` / `playKeypress()` call Tauri commands |
| `src/compositor.ts` | Triggers sounds for window/tab/pane/layout actions, keypress sounds, terminal bell |
| `src/input-router.ts` | Triggers sounds for mode changes, resize/move/swap/hint actions |
| `src/command-palette.ts` | Triggers palette open/close/execute sounds; lists sound packs for switching |
| `src/main.ts` | Startup sound |
| `src-tauri/sounds/deep-glyph/` | 17 WAV files — Deep Glyph pack (bundled as Tauri resource) |
| `src-tauri/sounds/mach-line/` | 17 WAV files — Mach Line pack (bundled as Tauri resource) |
| `src-tauri/sounds/holo-dash/` | 17 WAV files — Holo Dash pack (bundled as Tauri resource) |

---

## 10. Diagnostics

The Rust sound engine logs via the `log` crate:
- WAV loading: `Loaded 17/17 WAV files from pack 'deep-glyph'`
- Warnings: failed WAV reads, missing pack directories, decode errors, no audio device
- Audio thread lifecycle: startup and device availability

---

## 11. Design History

The sound engine evolved through several iterations:

1. **M7 original**: Procedural additive/subtractive synthesis with `krypton-cyber` patches (10-18 Web Audio nodes per sound). Caused AudioContext degradation after hours of use.

2. **Ghost-signal integration**: Added 5 function-based sound themes from the ghost-signal project. Each theme was a JS module exporting `createSounds(ctx, noiseBuffer)` returning fire-and-forget functions. Volume controlled via `Proxy` wrapping `AudioContext.destination`.

3. **AudioContext resilience** (former doc 21): Added `statechange` monitoring and context recycling at 50k sounds to mitigate degradation. Resume-aware guards to handle macOS display sleep.

4. **Buffer cache** (former doc 25): Pre-rendered all sounds into `AudioBuffer`s via `OfflineAudioContext` at theme load time. Reduced per-sound nodes from 10-18 to 2. Ghost-signal `TYPING_LETTER` pre-rendered 8 variants in round-robin pool. Context recycle threshold raised to 500k.

5. **Silence bug analysis** (former doc 26): Identified four interacting causes: `resume()` promise never settling, `warmCache()` race conditions, stale ghost-signal closures, and no output health check. Proposed resume timeout, generation-guarded cache warming, closure invalidation, and `AnalyserNode` output probes.

6. **WAV replacement**: Eliminated all procedural synthesis. Replaced with static WAV file playback. Each sound pack is a directory of 17 pre-rendered WAVs. This eliminated the root cause of all prior AudioContext degradation.

7. **Rust backend** (current): Moved all audio from the frontend Web Audio API to the Rust backend using `rodio` (cpal). A dedicated `krypton-audio` thread owns the `OutputStream` and `Sink`s. The frontend `SoundEngine` became a thin IPC wrapper calling Tauri commands. This eliminates all browser/WebView audio issues entirely — no AudioContext lifecycle management, no suspended states, no silence bugs.

---

## 12. Out of Scope

- Procedural/real-time synthesis (removed — was root cause of AudioContext degradation)
- Custom user sound packs from `~/.config/krypton/sounds/` (future)
- Mixing sounds from different packs
- Per-event WAV override within a pack
- Spatial audio / panning based on window position
