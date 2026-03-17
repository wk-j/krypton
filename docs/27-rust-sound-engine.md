# Rust Sound Engine — Implementation Spec

> Status: Implemented
> Date: 2026-03-17
> Milestone: M8 — Polish

## Problem

The frontend Web Audio API is unreliable for sound playback in a Tauri WebView. The project's design history (doc 17, section 11) documents six iterations of workarounds for AudioContext degradation, suspended states, silence bugs, and node churn — none of which fully solved the problem. Moving audio playback to the Rust backend eliminates these browser-specific issues entirely.

## Solution

Replace the frontend `SoundEngine` (Web Audio API) with a Rust-side audio engine using the `rodio` crate. The frontend keeps its existing `play()` / `playKeypress()` call sites but they now fire lightweight Tauri commands to the backend instead of managing AudioContext nodes. WAV files are bundled as Tauri resources and decoded into in-memory buffers at startup. Overlap management (max concurrent, throttle, cooldown) moves to Rust.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/sound.rs` | **New** — Rust sound engine: WAV buffer cache, playback via rodio, overlap/throttle/cooldown logic |
| `src-tauri/src/lib.rs` | Register new commands, initialize sound engine as managed state |
| `src-tauri/src/config.rs` | No struct changes — `SoundConfig` already has the right shape |
| `src-tauri/Cargo.toml` | Add `rodio` dependency |
| `src-tauri/tauri.conf.json` | Add `resources` to bundle WAV files |
| `public/sounds/` → `src-tauri/sounds/` | Move WAV files to Rust resource directory |
| `src/sound.ts` | Gut playback logic — becomes a thin IPC wrapper that calls `invoke()` |
| `src/compositor.ts` | No changes — calls `sound.play()` / `sound.playKeypress()` as before |
| `src/input-router.ts` | No changes |
| `src/command-palette.ts` | No changes — pack list fetched via new command |
| `src/main.ts` | No changes |
| `docs/17-sound-themes.md` | Update architecture section to reflect Rust-side playback |

## Design

### Data Structures (Rust)

```rust
// src-tauri/src/sound.rs

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;
use std::time::Instant;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};

/// In-memory WAV data, ready to be cloned into a Decoder on each play.
struct WavBuffer {
    bytes: Vec<u8>,
}

/// Per-event cooldown tracker.
struct CooldownTracker {
    last_fired: HashMap<String, Instant>,
}

pub struct SoundEngine {
    /// rodio output stream (must be kept alive).
    _stream: OutputStream,
    /// Handle used to create Sinks.
    stream_handle: OutputStreamHandle,
    /// Cached WAV bytes keyed by WAV name (e.g., "CLICK", "HOVER").
    buffers: HashMap<String, WavBuffer>,
    /// Currently active sinks (playing sounds). Cleaned up on each play.
    active_sinks: Vec<Sink>,
    /// Current config.
    config: SoundConfig,
    /// Per-event cooldown tracking.
    cooldowns: CooldownTracker,
    /// Last keypress timestamp for throttling.
    last_keypress: Option<Instant>,
    /// Current pack name.
    current_pack: String,
}

// Wrapped for Tauri managed state:
pub type SoundEngineState = Mutex<SoundEngine>;
```

### Constants

```rust
const MAX_CONCURRENT: usize = 8;
const KEYPRESS_THROTTLE_MS: u64 = 25;
const EVENT_COOLDOWN_MS: u64 = 50;

const WAV_NAMES: [&str; 17] = [
    "APP_START", "CLICK", "FEATURE_SWITCH_OFF", "FEATURE_SWITCH_ON",
    "HOVER", "HOVER_UP", "IMPORTANT_CLICK", "LIMITER_OFF", "LIMITER_ON",
    "SWITCH_TOGGLE", "TAB_CLOSE", "TAB_INSERT", "TAB_SLASH",
    "TYPING_BACKSPACE", "TYPING_ENTER", "TYPING_LETTER", "TYPING_SPACE",
];
```

### Event-to-WAV Mapping

Same mapping as the current frontend `EVENT_TO_WAV` — a `HashMap<&str, &str>` or match expression mapping 32 event names to 17 WAV names. Defined as a constant/static in `sound.rs`.

### API / Commands

```rust
/// Play a UI sound event.
#[tauri::command]
fn sound_play(event: String, state: tauri::State<'_, SoundEngineState>) -> Result<(), String>;

/// Play a keypress sound.
#[tauri::command]
fn sound_play_keypress(key: String, state: tauri::State<'_, SoundEngineState>) -> Result<(), String>;

/// Apply updated sound config (called on config load/change).
#[tauri::command]
fn sound_apply_config(config: SoundConfig, state: tauri::State<'_, SoundEngineState>) -> Result<(), String>;

/// Switch sound pack. Reloads WAV buffers from the new pack directory.
#[tauri::command]
fn sound_load_pack(
    pack: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, SoundEngineState>,
) -> Result<(), String>;

/// Get available sound packs and current selection.
#[tauri::command]
fn sound_get_packs(state: tauri::State<'_, SoundEngineState>) -> Result<SoundPackInfo, String>;
```

```rust
#[derive(serde::Serialize)]
struct SoundPackInfo {
    available: Vec<SoundPack>,
    current: String,
}

#[derive(serde::Serialize)]
struct SoundPack {
    id: String,
    display_name: String,
}
```

### Data Flow

**Sound playback (primary path):**

```
1. Frontend event occurs (e.g., window created)
2. compositor.ts calls this.sound.play('window.create')
3. SoundEngine.play() calls invoke('sound_play', { event: 'window.create' })
4. Rust sound_play command:
   a. Lock SoundEngineState mutex
   b. Check config.enabled + per-event override
   c. Check event cooldown (50ms dedup)
   d. Map event -> WAV name via EVENT_TO_WAV
   e. Prune finished sinks from active_sinks
   f. Check active_sinks.len() < MAX_CONCURRENT
   g. Clone WAV bytes from buffer cache
   h. Create rodio::Sink, append Decoder(Cursor::new(bytes))
   i. Set volume (config.volume * per-event volume if any)
   j. Push sink to active_sinks
   k. Return Ok(())
5. Sound plays on OS audio device via rodio/cpal
```

**Keypress sounds:**

```
1. compositor.ts keydown handler calls sound.playKeypress('press', key)
2. SoundEngine.playKeypress() calls invoke('sound_play_keypress', { key })
3. Rust sound_play_keypress command:
   a. Lock mutex
   b. Check enabled + keypress event override
   c. Check throttle (25ms since last keypress)
   d. Map key -> WAV name (Backspace/Enter/Space/Letter)
   e. Apply keyboard_volume multiplier
   f. Play via same sink path
```

**Pack switching:**

```
1. Command palette selects new pack
2. Frontend calls invoke('sound_load_pack', { pack: 'mach-line' })
3. Rust loads 17 WAV files from resources/<pack>/ directory
4. Clears old buffer cache, populates with new WAV bytes
5. Updates current_pack
```

**Startup / config:**

```
1. lib.rs: create SoundEngine with default config, manage as state
2. lib.rs: after config loaded, call sound_engine.apply_config(config.sound)
3. SoundEngine loads WAV files from bundled resources for initial pack
4. On config-changed: backend calls sound_engine.apply_config() directly
   (no IPC round-trip — Rust already has the new config)
```

### WAV Resource Bundling

WAV files move from `public/sounds/` to `src-tauri/sounds/` and are declared in `tauri.conf.json`:

```json
{
  "bundle": {
    "resources": [
      "sounds/**/*"
    ]
  }
}
```

At runtime, resolved via `app.path().resource_dir()`:
```
<resource_dir>/sounds/deep-glyph/CLICK.wav
<resource_dir>/sounds/mach-line/CLICK.wav
```

WAV bytes are read into memory (`Vec<u8>`) at pack load time — they're small (total ~1.4 MB for both packs) so keeping them in memory is fine.

### Frontend `SoundEngine` Rewrite

The `SoundEngine` class in `src/sound.ts` becomes a thin wrapper:

```typescript
export class SoundEngine {
  private enabled: boolean = true;

  async applyConfig(config: SoundConfig): Promise<void> {
    this.enabled = config.enabled;
    await invoke('sound_apply_config', { config });
  }

  play(event: SoundEvent): void {
    if (!this.enabled) return;
    invoke('sound_play', { event }).catch(() => {});
  }

  playKeypress(phase: 'press' | 'release', key?: string): void {
    if (phase !== 'press' || !this.enabled) return;
    invoke('sound_play_keypress', { key: key ?? '' }).catch(() => {});
  }

  async loadTheme(packName: string): Promise<void> {
    await invoke('sound_load_pack', { pack: packName });
  }

  async getAvailableThemes(): Promise<string[]> {
    const info = await invoke<SoundPackInfo>('sound_get_packs');
    return info.available.map(p => p.id);
  }

  getThemeDisplayName(packName: string): string {
    // Keep static map for display names (no IPC needed)
    const names: Record<string, string> = {
      'deep-glyph': 'Deep Glyph',
      'mach-line': 'Mach Line',
    };
    return names[packName] ?? packName;
  }

  getCurrentPack(): string {
    // Tracked locally — updated by applyConfig/loadTheme
    return this._currentPack;
  }
}
```

All AudioContext code, buffer cache, overlap management, cooldown/throttle logic, WAV loading, and diagnostics are **deleted** from the frontend.

### Configuration

No TOML changes needed. The `[sound]` section and `SoundConfig` struct already have the correct shape. The Rust sound engine reads config values directly instead of forwarding them to the frontend for interpretation.

## Edge Cases

| Case | Handling |
|------|----------|
| No audio device available | `rodio::OutputStream::try_default()` returns error — log warning, set engine to disabled mode. Sounds silently no-op. |
| Audio device disconnected mid-session | rodio sinks will error on play — catch and log, don't crash. Attempt re-init on next play. |
| Pack WAV file missing | Log error for missing file, skip that sound. Other sounds continue working. |
| Rapid sound bursts (e.g., holding resize key) | Same overlap management as before: MAX_CONCURRENT=8 cap, event cooldown=50ms, keypress throttle=25ms. All enforced in Rust. |
| Config hot-reload changes pack | Backend already has the new config — reload WAV buffers inline, no IPC needed. |
| `invoke()` latency for keypress sounds | rodio playback start is ~0.1ms (buffer already in memory). IPC overhead ~0.1-0.5ms. Total well under the 25ms throttle window. If latency is noticeable, can switch `sound_play`/`sound_play_keypress` to fire-and-forget Tauri events instead of commands. |

## Open Questions

None — the design is straightforward: move the same logic from TypeScript/Web Audio to Rust/rodio. The WAV files, event mapping, overlap rules, and config shape are all unchanged.

## Out of Scope

- Custom user sound packs from `~/.config/krypton/sounds/` (future enhancement)
- Spatial audio / panning based on window position
- Keyboard type variations (the `keyboard_type` config field remains reserved)
- Any new sound events or WAV files
- Changes to the command palette sound-switching UX
