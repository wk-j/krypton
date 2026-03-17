// Krypton — Rust Sound Engine
// Plays pre-rendered WAV files via rodio (cpal backend).
// Replaces the frontend Web Audio API implementation for reliability.
//
// rodio's OutputStream is !Send+!Sync, so we run audio on a dedicated
// thread and communicate via an mpsc channel. The Tauri-managed state
// holds only the sender (which is Send+Sync).

use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Instant;

use rodio::{Decoder, OutputStream, Sink};

use crate::config::SoundConfig;

// ─── Constants ────────────────────────────────────────────────────

const MAX_CONCURRENT: usize = 8;
const KEYPRESS_THROTTLE_MS: u64 = 25;
const EVENT_COOLDOWN_MS: u64 = 50;

const WAV_NAMES: &[&str] = &[
    "APP_START",
    "CLICK",
    "FEATURE_SWITCH_OFF",
    "FEATURE_SWITCH_ON",
    "HOVER",
    "HOVER_UP",
    "IMPORTANT_CLICK",
    "LIMITER_OFF",
    "LIMITER_ON",
    "SWITCH_TOGGLE",
    "TAB_CLOSE",
    "TAB_INSERT",
    "TAB_SLASH",
    "TYPING_BACKSPACE",
    "TYPING_ENTER",
    "TYPING_LETTER",
    "TYPING_SPACE",
];

// ─── Available packs ─────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct SoundPack {
    pub id: String,
    pub display_name: String,
}

#[derive(Clone, serde::Serialize)]
pub struct SoundPackInfo {
    pub available: Vec<SoundPack>,
    pub current: String,
}

fn available_packs() -> Vec<SoundPack> {
    vec![
        SoundPack {
            id: "deep-glyph".into(),
            display_name: "Deep Glyph".into(),
        },
        SoundPack {
            id: "mach-line".into(),
            display_name: "Mach Line".into(),
        },
    ]
}

// ─── Event-to-WAV mapping ────────────────────────────────────────

fn event_to_wav(event: &str) -> Option<&'static str> {
    match event {
        "startup" => Some("APP_START"),
        "window.create" => Some("TAB_INSERT"),
        "window.close" => Some("TAB_CLOSE"),
        "window.focus" => Some("HOVER"),
        "window.maximize" => Some("FEATURE_SWITCH_ON"),
        "window.restore" => Some("FEATURE_SWITCH_OFF"),
        "window.pin" => Some("LIMITER_ON"),
        "window.unpin" => Some("LIMITER_OFF"),
        "mode.enter" => Some("CLICK"),
        "mode.exit" => Some("HOVER_UP"),
        "quick_terminal.show" => Some("FEATURE_SWITCH_ON"),
        "quick_terminal.hide" => Some("FEATURE_SWITCH_OFF"),
        "workspace.switch" => Some("TAB_SLASH"),
        "command_palette.open" => Some("TAB_SLASH"),
        "command_palette.close" => Some("HOVER_UP"),
        "command_palette.execute" => Some("IMPORTANT_CLICK"),
        "hint.activate" => Some("CLICK"),
        "hint.select" => Some("IMPORTANT_CLICK"),
        "hint.cancel" => Some("HOVER_UP"),
        "layout.toggle" => Some("SWITCH_TOGGLE"),
        "swap.complete" => Some("CLICK"),
        "resize.step" => Some("HOVER"),
        "move.step" => Some("HOVER"),
        "terminal.bell" => Some("IMPORTANT_CLICK"),
        "terminal.exit" => Some("TAB_CLOSE"),
        "tab.create" => Some("TAB_INSERT"),
        "tab.close" => Some("TAB_CLOSE"),
        "tab.switch" => Some("CLICK"),
        "tab.move" => Some("SWITCH_TOGGLE"),
        "pane.split" => Some("TAB_INSERT"),
        "pane.close" => Some("TAB_CLOSE"),
        "pane.focus" => Some("HOVER"),
        _ => None,
    }
}

fn key_to_wav(key: &str) -> &'static str {
    match key {
        "Backspace" => "TYPING_BACKSPACE",
        "Enter" => "TYPING_ENTER",
        " " => "TYPING_SPACE",
        _ => "TYPING_LETTER",
    }
}

// ─── Messages sent to the audio thread ───────────────────────────

enum AudioMsg {
    /// Play a WAV by name at a given volume.
    Play { wav_name: String, volume: f32 },
    /// Load a new pack's WAV files from disk.
    LoadPack { pack_dir: PathBuf },
}

// ─── Audio thread (owns OutputStream, Sinks, buffers) ────────────

fn audio_thread(rx: mpsc::Receiver<AudioMsg>) {
    let (_stream, stream_handle) = match OutputStream::try_default() {
        Ok(pair) => pair,
        Err(e) => {
            log::warn!("No audio output device available: {e}. Sound thread exiting.");
            // Drain the channel so senders don't block
            for _ in rx {}
            return;
        }
    };

    let mut buffers: HashMap<String, Vec<u8>> = HashMap::new();
    let mut active_sinks: Vec<Sink> = Vec::new();

    while let Ok(msg) = rx.recv() {
        match msg {
            AudioMsg::Play { wav_name, volume } => {
                // Prune finished sinks
                active_sinks.retain(|s| !s.empty());

                // Max concurrent check
                if active_sinks.len() >= MAX_CONCURRENT {
                    continue;
                }

                let bytes = match buffers.get(&wav_name) {
                    Some(b) => b.clone(),
                    None => continue,
                };

                let cursor = Cursor::new(bytes);
                let source = match Decoder::new(cursor) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("Failed to decode WAV '{wav_name}': {e}");
                        continue;
                    }
                };

                match Sink::try_new(&stream_handle) {
                    Ok(sink) => {
                        sink.set_volume(volume);
                        sink.append(source);
                        active_sinks.push(sink);
                    }
                    Err(e) => {
                        log::warn!("Failed to create audio sink: {e}");
                    }
                }
            }
            AudioMsg::LoadPack { pack_dir } => {
                buffers.clear();
                if !pack_dir.exists() {
                    log::warn!("Sound pack directory not found: {}", pack_dir.display());
                    continue;
                }
                let mut loaded = 0;
                for &name in WAV_NAMES {
                    let path = pack_dir.join(format!("{name}.wav"));
                    match std::fs::read(&path) {
                        Ok(bytes) => {
                            buffers.insert(name.to_string(), bytes);
                            loaded += 1;
                        }
                        Err(e) => {
                            log::warn!("Failed to read WAV {}: {e}", path.display());
                        }
                    }
                }
                log::info!(
                    "Loaded {loaded}/{} WAV files from '{}'",
                    WAV_NAMES.len(),
                    pack_dir.display()
                );
            }
        }
    }
}

// ─── SoundEngine (Send+Sync — stored in Tauri state) ─────────────

pub struct SoundEngine {
    /// Channel to the audio thread.
    tx: mpsc::Sender<AudioMsg>,
    /// Current config (for checks done before sending to audio thread).
    config: SoundConfig,
    /// Per-event cooldown tracking.
    last_event_time: HashMap<String, Instant>,
    /// Last keypress timestamp for throttling.
    last_keypress: Option<Instant>,
    /// Current pack name.
    current_pack: String,
    /// Base path for sound resources.
    resource_base: Option<PathBuf>,
}

// Safety: SoundEngine only contains Send types (mpsc::Sender is Send+Sync,
// the rest are plain data). The !Send OutputStream lives on the audio thread.
unsafe impl Send for SoundEngine {}
unsafe impl Sync for SoundEngine {}

/// Wrapped for Tauri managed state.
pub type SoundEngineState = std::sync::Mutex<SoundEngine>;

impl Default for SoundEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SoundEngine {
    /// Create a new sound engine. Spawns the audio thread.
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();

        std::thread::Builder::new()
            .name("krypton-audio".into())
            .spawn(move || audio_thread(rx))
            .expect("failed to spawn audio thread");

        Self {
            tx,
            config: SoundConfig::default(),
            last_event_time: HashMap::new(),
            last_keypress: None,
            current_pack: "deep-glyph".into(),
            resource_base: None,
        }
    }

    /// Set the resource base path and load initial WAV files.
    pub fn init(&mut self, resource_dir: PathBuf) {
        self.resource_base = Some(resource_dir.clone());
        let pack_dir = resource_dir.join("sounds").join(&self.current_pack);
        let _ = self.tx.send(AudioMsg::LoadPack { pack_dir });
    }

    /// Apply sound config (volume, enabled, pack, etc.).
    pub fn apply_config(&mut self, config: SoundConfig) {
        let prev_pack = self.current_pack.clone();
        self.config = config;

        // Reload if pack changed
        if self.config.pack != prev_pack {
            self.current_pack = self.config.pack.clone();
            if let Some(base) = &self.resource_base {
                let pack_dir = base.join("sounds").join(&self.current_pack);
                let _ = self.tx.send(AudioMsg::LoadPack { pack_dir });
            }
        }
    }

    /// Switch to a different sound pack.
    pub fn load_pack(&mut self, pack: &str) {
        self.current_pack = pack.to_string();
        self.config.pack = pack.to_string();
        if let Some(base) = &self.resource_base {
            let pack_dir = base.join("sounds").join(pack);
            let _ = self.tx.send(AudioMsg::LoadPack { pack_dir });
        }
    }

    /// Get pack info for the frontend.
    pub fn get_packs(&self) -> SoundPackInfo {
        SoundPackInfo {
            available: available_packs(),
            current: self.current_pack.clone(),
        }
    }

    /// Play a UI sound event.
    pub fn play(&mut self, event: &str) {
        if !self.config.enabled {
            return;
        }

        // Per-event override check
        if let Some(val) = self.config.events.get(event) {
            if val == &serde_json::Value::Bool(false) {
                return;
            }
        }

        // Cooldown dedup
        let now = Instant::now();
        if let Some(last) = self.last_event_time.get(event) {
            if now.duration_since(*last).as_millis() < EVENT_COOLDOWN_MS as u128 {
                return;
            }
        }
        self.last_event_time.insert(event.to_string(), now);

        // Map event to WAV name
        let wav_name = match event_to_wav(event) {
            Some(w) => w,
            None => return,
        };

        // Determine volume
        let mut volume = self.config.volume as f32;
        if let Some(val) = self.config.events.get(event) {
            if let Some(v) = val.as_f64() {
                volume *= v.clamp(0.0, 1.0) as f32;
            }
        }

        let _ = self.tx.send(AudioMsg::Play {
            wav_name: wav_name.to_string(),
            volume,
        });
    }

    /// Play a keypress sound.
    pub fn play_keypress(&mut self, key: &str) {
        if !self.config.enabled {
            return;
        }

        // Per-event override for keypress
        if let Some(val) = self.config.events.get("keypress") {
            if val == &serde_json::Value::Bool(false) {
                return;
            }
        }

        // Throttle
        let now = Instant::now();
        if let Some(last) = self.last_keypress {
            if now.duration_since(last).as_millis() < KEYPRESS_THROTTLE_MS as u128 {
                return;
            }
        }
        self.last_keypress = Some(now);

        let wav_name = key_to_wav(key);

        // Volume: master * keyboard_volume * per-event override
        let mut volume = self.config.volume as f32 * self.config.keyboard_volume as f32;
        if let Some(val) = self.config.events.get("keypress") {
            if let Some(v) = val.as_f64() {
                volume *= v.clamp(0.0, 1.0) as f32;
            }
        }

        let _ = self.tx.send(AudioMsg::Play {
            wav_name: wav_name.to_string(),
            volume,
        });
    }
}

// ─── Tauri Commands ───────────────────────────────────────────────

#[tauri::command]
pub fn sound_play(event: String, state: tauri::State<'_, SoundEngineState>) -> Result<(), String> {
    match state.lock() {
        Ok(mut engine) => {
            engine.play(&event);
            Ok(())
        }
        Err(e) => Err(format!("Sound engine lock poisoned: {e}")),
    }
}

#[tauri::command]
pub fn sound_play_keypress(
    key: String,
    state: tauri::State<'_, SoundEngineState>,
) -> Result<(), String> {
    match state.lock() {
        Ok(mut engine) => {
            engine.play_keypress(&key);
            Ok(())
        }
        Err(e) => Err(format!("Sound engine lock poisoned: {e}")),
    }
}

#[tauri::command]
pub fn sound_apply_config(
    config: SoundConfig,
    state: tauri::State<'_, SoundEngineState>,
) -> Result<(), String> {
    match state.lock() {
        Ok(mut engine) => {
            engine.apply_config(config);
            Ok(())
        }
        Err(e) => Err(format!("Sound engine lock poisoned: {e}")),
    }
}

#[tauri::command]
pub fn sound_load_pack(
    pack: String,
    state: tauri::State<'_, SoundEngineState>,
) -> Result<(), String> {
    match state.lock() {
        Ok(mut engine) => {
            engine.load_pack(&pack);
            Ok(())
        }
        Err(e) => Err(format!("Sound engine lock poisoned: {e}")),
    }
}

#[tauri::command]
pub fn sound_get_packs(state: tauri::State<'_, SoundEngineState>) -> Result<SoundPackInfo, String> {
    match state.lock() {
        Ok(engine) => Ok(engine.get_packs()),
        Err(e) => Err(format!("Sound engine lock poisoned: {e}")),
    }
}
