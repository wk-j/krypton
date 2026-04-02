# MP3 Player — Implementation Spec

> Status: Implemented
> Date: 2026-04-02
> Milestone: M8 — Polish

## Problem

Krypton has no way to play music. Users who spend their day in the terminal want background music without leaving the app. An integrated MP3 player fits the cyberpunk aesthetic and keyboard-first philosophy.

## Solution

Add a native MP3 player to Krypton with three UI layers: (1) a **Music dashboard overlay** for browsing/playlist management, (2) a **persistent mini-player bar** at the bottom of the workspace for at-a-glance status and quick controls, and (3) a **Circuit Trace audio visualizer** — a workspace-level background canvas rendering PCB-style orthogonal signal traces that light up in response to audio frequency data. Playback is handled entirely in the Rust backend via `rodio` (already a dependency — just enable the `mp3` feature). Rust performs FFT on the audio stream and emits frequency bin data to the frontend at ~30fps. Frontend communicates via IPC commands and events.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `mp3` feature to `rodio`, add `rustfft` crate |
| `src-tauri/src/music.rs` | **New** — Music engine: load, play, pause, stop, seek, volume, playlist, FFT analysis |
| `src-tauri/src/lib.rs` | Register music commands, manage MusicEngine state |
| `src/music.ts` | **New** — Frontend music player: dashboard UI, mini-player bar, IPC wrapper |
| `src/circuit-trace.ts` | **New** — Circuit Trace visualizer renderer (implements `Renderer` interface for animation worker) |
| `src/animation-worker.ts` | Add `circuit-trace` animation type, accept FFT data messages |
| `src/offscreen-animation.ts` | Add `circuit-trace` to `AnimationType`, configure opacity/class |
| `src/types.ts` | Add `Music` to Mode enum, music-related types |
| `src/input-router.ts` | Add Music mode handling, global media key shortcuts |
| `src/compositor.ts` | Mount mini-player bar, workspace-level visualizer canvas, register music dashboard |
| `src/styles.css` | Music dashboard + mini-player + visualizer canvas styles |
| `src-tauri/src/config.rs` | Add `MusicConfig` to `KryptonConfig` |

## Design

### Data Structures

**Rust (`music.rs`):**

```rust
pub struct MusicEngine {
    tx: mpsc::Sender<MusicMsg>,
    state: Arc<RwLock<PlaybackState>>,
}

#[derive(Clone, Serialize)]
pub struct PlaybackState {
    pub status: PlayStatus,       // Playing, Paused, Stopped
    pub current_track: Option<TrackInfo>,
    pub position_secs: f64,
    pub duration_secs: f64,
    pub volume: f32,              // 0.0–1.0
    pub playlist: Vec<TrackInfo>,
    pub playlist_index: usize,
    pub repeat: RepeatMode,       // Off, One, All
    pub shuffle: bool,
}

#[derive(Clone, Serialize)]
pub struct TrackInfo {
    pub path: String,
    pub filename: String,         // display name (filename without extension)
    pub duration_secs: f64,
    pub bitrate_kbps: u32,        // e.g. 320
    pub sample_rate_hz: u32,      // e.g. 44100
    pub channels: u8,             // 1 = mono, 2 = stereo
}

enum MusicMsg {
    LoadDirectory { path: PathBuf },
    LoadFile { path: PathBuf },
    Play,
    Pause,
    Stop,
    Next,
    Previous,
    Seek { position_secs: f64 },
    SetVolume { volume: f32 },
    ToggleRepeat,
    ToggleShuffle,
    GetState,
}

/// FFT frequency bin data emitted to frontend for visualization
#[derive(Clone, Serialize)]
pub struct FftData {
    /// 32 frequency bins (logarithmically spaced), values 0.0–1.0
    pub bins: Vec<f32>,
}
```

**TypeScript (`music.ts`):**

```typescript
interface PlaybackState {
  status: 'Playing' | 'Paused' | 'Stopped';
  current_track: TrackInfo | null;
  position_secs: number;
  duration_secs: number;
  volume: number;
  playlist: TrackInfo[];
  playlist_index: number;
  repeat: 'Off' | 'One' | 'All';
  shuffle: boolean;
}

interface TrackInfo {
  path: string;
  filename: string;
  duration_secs: number;
  bitrate_kbps: number;
  sample_rate_hz: number;
  channels: number;
}
```

### API / Commands

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `music_load_dir` | `path: String` | `Result<PlaybackState>` | Scan directory for MP3s, build playlist |
| `music_load_file` | `path: String` | `Result<PlaybackState>` | Load single MP3 file |
| `music_play` | — | `Result<()>` | Play / resume |
| `music_pause` | — | `Result<()>` | Pause |
| `music_stop` | — | `Result<()>` | Stop and reset position |
| `music_next` | — | `Result<()>` | Next track |
| `music_previous` | — | `Result<()>` | Previous track |
| `music_seek` | `position_secs: f64` | `Result<()>` | Seek to position |
| `music_set_volume` | `volume: f32` | `Result<()>` | Set volume (0.0–1.0) |
| `music_toggle_repeat` | — | `Result<()>` | Cycle repeat mode |
| `music_toggle_shuffle` | — | `Result<()>` | Toggle shuffle |
| `music_get_state` | — | `Result<PlaybackState>` | Get current state |
| `music_play_index` | `index: usize` | `Result<()>` | Play specific playlist entry |

**Events (Rust → Frontend):**

| Event | Payload | Description |
|-------|---------|-------------|
| `music-state-changed` | `PlaybackState` | Emitted on any state change (play/pause/track change/seek) |
| `music-position` | `{ position_secs: f64 }` | Emitted every ~1s during playback for progress bar |
| `music-fft` | `FftData` | 32 frequency bins at ~30fps during playback for visualizer |

### Data Flow

```
1. User opens music dashboard (Cmd+Shift+M or compositor 'm' key)
2. Dashboard shows file browser / current playlist
3. User selects directory → invoke('music_load_dir', { path })
4. Rust scans directory for *.mp3 files, builds playlist
5. Rust emits 'music-state-changed' with playlist populated
6. User presses Enter on a track → invoke('music_play_index', { index })
7. Rust audio thread decodes MP3 via rodio, starts playback
8. Rust spawns position ticker thread, emits 'music-position' every 1s
9. Frontend mini-player bar updates track name + progress
10. User presses Space (in Music mode) → invoke('music_pause')
11. Global shortcuts (from any mode): Cmd+Shift+. (next), Cmd+Shift+, (prev)
```

### Audio Visualization — Circuit Trace

**Concept:** A PCB (printed circuit board) rendered on a workspace-level canvas behind all terminal windows. Orthogonal signal traces (horizontal/vertical lines with right-angle turns) form a static board layout. During playback, signals pulse along the traces — brightness, color, and propagation speed driven by FFT frequency bins. Low frequencies drive thick power traces, mid frequencies drive data buses, high frequencies drive fine signal traces.

**FFT Pipeline (Rust):**

The music audio thread taps the decoded PCM samples before sending to rodio's Sink. Every ~33ms (~30fps), it runs a 2048-sample FFT (via `rustfft` crate), maps the result to 32 logarithmically-spaced bins normalized to 0.0–1.0, and emits a `music-fft` Tauri event.

```rust
// In the audio thread, after decoding samples:
// 1. Copy PCM samples into a ring buffer
// 2. Every 33ms, take 2048 samples from the ring buffer
// 3. Apply Hann window, run FFT
// 4. Map FFT magnitudes to 32 log-spaced bins
// 5. Normalize each bin to 0.0–1.0 (with smoothing/decay)
// 6. Emit via app_handle.emit("music-fft", FftData { bins })
```

**Renderer (`circuit-trace.ts`):**

Implements the same `Renderer` interface as flame/matrix/brainwave, runs in the animation worker via `OffscreenCanvas`.

```typescript
interface TraceSegment {
  x1: number; y1: number;   // start point (grid-snapped)
  x2: number; y2: number;   // end point (grid-snapped)
  band: number;              // which frequency band (0=low, 2=high)
  thickness: number;         // line width (thicker for power traces)
}

interface TracePulse {
  segment: number;           // index into segments array
  position: number;          // 0.0–1.0 along segment
  speed: number;             // pixels per frame
  intensity: number;         // brightness 0.0–1.0
  color: string;             // cyan/green/amber based on band
}

class CircuitTraceRenderer implements Renderer {
  private segments: TraceSegment[] = [];
  private pulses: TracePulse[] = [];
  private fftBins: Float32Array = new Float32Array(32);
  private grid = 20;                    // px grid spacing
  // ...
}
```

**Board generation:** On `init(W, H)`, procedurally generates a PCB layout:
1. Place IC "chips" (rectangles) at random grid positions
2. Route orthogonal traces between chips (horizontal → corner → vertical)
3. Add vias (circles at junctions), test pads, decoupling caps
4. Traces are categorized into 3 bands: power (thick, low-freq), data (medium, mid-freq), signal (thin, high-freq)

**Rendering per frame:**
1. Draw static board elements at low opacity: substrate color, silkscreen outlines, pad rings
2. For each frequency band, map FFT energy to pulse spawn rate and intensity
3. Propagate existing pulses along their segments (glow trail behind)
4. Draw trace segments with base dim color + additive glow where pulses are active
5. Color palette: cyan (power/low), green (data/mid), amber (signal/high) — all theme-aware via `--krypton-*` vars

**DOM placement (workspace-level, NOT per-window):**

```
#workspace-container
  +-- canvas.krypton-circuit-trace   (absolute, z-index: 0, pointer-events: none, full workspace)
  +-- .krypton-window (each window)  (z-index: 1+)
  +-- .krypton-mini-player           (z-index: 100)
```

The canvas covers the entire workspace. Opacity ~0.15–0.20 so it's subtle behind terminal windows but visible in gaps between them and on the transparent desktop.

**Worker integration:**

The animation worker receives FFT data via `postMessage({ type: 'fft', bins: Float32Array })`. The main thread listens to `music-fft` events and forwards bins to the worker. The worker's `CircuitTraceRenderer` stores the latest bins and uses them each frame.

```typescript
// In animation-worker.ts, add to WorkerMessage type:
| { type: 'fft'; bins: number[] }

// In tick(), pass bins to renderer
```

### Keybindings

**Global (any mode):**

| Key | Action |
|-----|--------|
| `Cmd+Shift+M` | Toggle music dashboard |
| `Cmd+Shift+.` | Next track |
| `Cmd+Shift+,` | Previous track |

**Compositor mode (after leader key):**

| Key | Action |
|-----|--------|
| `m` | Toggle music dashboard |

**Music dashboard mode:**

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `s` | Stop |
| `n` / `j` / `↓` | Next track / move down in playlist |
| `p` / `k` / `↑` | Previous track / move up in playlist |
| `Enter` | Play selected track |
| `l` / `→` | Seek forward 10s |
| `h` / `←` | Seek backward 10s |
| `+` / `=` | Volume up |
| `-` | Volume down |
| `r` | Cycle repeat mode (Off → One → All) |
| `z` | Toggle shuffle |
| `v` | Toggle Circuit Trace visualizer on/off |
| `o` | Open directory (shows path input) |
| `Escape` | Close dashboard, return to Normal |

### UI Changes

**Mini-player footer bar** (persistent, bottom of workspace when music loaded):
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▶  TRACK_NAME          MP3 · 320kbps · 44.1kHz · Stereo    02:34 / 04:12  ━━━━━░░░░  │
└──────────────────────────────────────────────────────────────────────────────┘
```
- Fixed to bottom of workspace, full width
- Shows playback state icon (▶/⏸/⏹), track name, audio metadata (format, bitrate, sample rate, channels), time position, and progress bar
- Themed with `--krypton-*` CSS variables
- Cyberpunk aesthetic: thin glowing border, monospace text, subtle scan line
- Hidden when no music is loaded
- Repeat/shuffle indicators shown as small icons when active

**Music dashboard overlay** (full-screen overlay, same pattern as existing dashboards):
- Left panel: playlist with highlighted current track
- Right panel: now-playing display with large track info, progress bar, volume, repeat/shuffle indicators
- Scan line / glow effects consistent with Krypton theme
- Path input bar at top for loading directories

### Configuration

```toml
[music]
enabled = true
volume = 0.7
directory = "~/Music"      # default directory to scan
visualizer = true          # enable Circuit Trace background visualizer
visualizer_opacity = 0.18  # background canvas opacity
```

**Rust struct:**
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MusicConfig {
    pub enabled: bool,
    pub volume: f64,
    pub directory: String,
    pub visualizer: bool,
    pub visualizer_opacity: f64,
}
```

## Edge Cases

- **No MP3 files in directory**: Show "No MP3 files found" in dashboard, no-op on play
- **File deleted during playback**: Skip to next track, log warning
- **Audio device unavailable**: Graceful fallback (same pattern as SoundEngine — log warning, drain channel)
- **Very long playlists**: Virtual scroll in dashboard list (render only visible items)
- **Concurrent sound effects + music**: Music uses its own `Sink` separate from SoundEngine sinks — both play simultaneously on the same `OutputStream`. Music volume is independent.
- **Seek beyond duration**: Clamp to duration, trigger next track
- **Empty playlist operations**: No-op for play/next/previous when playlist is empty

## Out of Scope

- Streaming audio from URLs (only local files)
- Audio formats beyond MP3 (can be added later by enabling more rodio features)
- Album art / ID3 tag parsing (filenames only for v1)
- Multiple visualizer styles (Circuit Trace only for v1)
- Crossfade between tracks
- Global system media key integration (macOS media keys)
