// Krypton — Music Engine
// Native MP3 player with FFT-based audio visualization.
// Uses rodio for playback on a dedicated audio thread, rustfft for
// frequency analysis. Communicates with the frontend via Tauri IPC
// commands and events.

use std::io::{BufReader, Cursor};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use rodio::{Decoder, OutputStream, Sink, Source};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::Serialize;
use tauri::Emitter;

use crate::config::MusicConfig;

// ─── Constants ────────────────────────────────────────────────────

const FFT_SIZE: usize = 2048;
const FFT_BINS: usize = 32;
const FFT_INTERVAL_MS: u64 = 33; // ~30fps
const POSITION_INTERVAL_MS: u64 = 500;
const RING_BUF_SIZE: usize = 8192; // ~186ms at 44.1kHz — enough for FFT window

// ─── Real-time Audio Tap ─────────────────────────────────────────

/// Lock-free(ish) ring buffer for capturing PCM samples during playback.
struct AudioRingBuffer {
    buf: Mutex<Vec<f32>>,
    write_pos: AtomicUsize,
    sample_rate: AtomicUsize,
}

impl AudioRingBuffer {
    fn new() -> Self {
        Self {
            buf: Mutex::new(vec![0.0; RING_BUF_SIZE]),
            write_pos: AtomicUsize::new(0),
            sample_rate: AtomicUsize::new(44100),
        }
    }

    /// Write samples into the ring buffer (called from audio thread).
    fn push(&self, samples: &[f32]) {
        let mut buf = self.buf.lock().unwrap();
        let mut pos = self.write_pos.load(Ordering::Relaxed);
        for &s in samples {
            buf[pos % RING_BUF_SIZE] = s;
            pos = pos.wrapping_add(1);
        }
        self.write_pos.store(pos, Ordering::Relaxed);
    }

    /// Read the last `count` samples (for FFT). Returns mono samples.
    fn read_last(&self, count: usize) -> Vec<f32> {
        let buf = self.buf.lock().unwrap();
        let pos = self.write_pos.load(Ordering::Relaxed);
        let count = count.min(RING_BUF_SIZE);
        let mut out = Vec::with_capacity(count);
        for i in (pos.wrapping_sub(count))..pos {
            out.push(buf[i % RING_BUF_SIZE]);
        }
        out
    }
}

/// A rodio Source wrapper that copies samples to a shared ring buffer
/// as they flow through playback — zero-latency audio tap.
struct TappedSource<S: Source<Item = f32>> {
    inner: S,
    ring: Arc<AudioRingBuffer>,
    batch: Vec<f32>,
}

impl<S: Source<Item = f32>> TappedSource<S> {
    fn new(source: S, ring: Arc<AudioRingBuffer>) -> Self {
        let sr = source.sample_rate();
        let ch = source.channels();
        ring.sample_rate.store(sr as usize, Ordering::Relaxed);
        // We'll mix to mono in the batch flush
        let _ = ch; // channels used in Iterator::next
        Self {
            inner: source,
            ring,
            batch: Vec::with_capacity(256),
        }
    }
}

impl<S: Source<Item = f32>> Iterator for TappedSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;
        self.batch.push(sample);

        // Flush in batches to reduce lock contention
        let channels = self.inner.channels() as usize;
        if self.batch.len() >= 256 {
            // Mix to mono before pushing
            let mono: Vec<f32> = if channels > 1 {
                self.batch
                    .chunks(channels)
                    .map(|ch| ch.iter().sum::<f32>() / channels as f32)
                    .collect()
            } else {
                self.batch.clone()
            };
            self.ring.push(&mono);
            self.batch.clear();
        }

        Some(sample)
    }
}

impl<S: Source<Item = f32>> Source for TappedSource<S> {
    fn current_frame_len(&self) -> Option<usize> {
        self.inner.current_frame_len()
    }

    fn channels(&self) -> u16 {
        self.inner.channels()
    }

    fn sample_rate(&self) -> u32 {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
}

// ─── Types ────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum PlayStatus {
    Playing,
    Paused,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum RepeatMode {
    Off,
    One,
    All,
}

#[derive(Clone, Debug, Serialize)]
pub struct TrackInfo {
    pub path: String,
    pub filename: String,
    pub duration_secs: f64,
    pub bitrate_kbps: u32,
    pub sample_rate_hz: u32,
    pub channels: u8,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlaybackState {
    pub status: PlayStatus,
    pub current_track: Option<TrackInfo>,
    pub position_secs: f64,
    pub duration_secs: f64,
    pub volume: f32,
    pub playlist: Vec<TrackInfo>,
    pub playlist_index: usize,
    pub repeat: RepeatMode,
    pub shuffle: bool,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            status: PlayStatus::Stopped,
            current_track: None,
            position_secs: 0.0,
            duration_secs: 0.0,
            volume: 0.7,
            playlist: Vec::new(),
            playlist_index: 0,
            repeat: RepeatMode::Off,
            shuffle: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct FftData {
    pub bins: Vec<f32>,
}

// ─── Messages ─────────────────────────────────────────────────────

enum MusicMsg {
    LoadDirectory { path: PathBuf },
    LoadFile { path: PathBuf },
    Play,
    Pause,
    Stop,
    Next,
    Previous,
    PlayIndex { index: usize },
    Seek { position_secs: f64 },
    SetVolume { volume: f32 },
    ToggleRepeat,
    ToggleShuffle,
}

// ─── Audio Thread ─────────────────────────────────────────────────

fn scan_mp3_files(dir: &PathBuf) -> Vec<TrackInfo> {
    let mut tracks = Vec::new();

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("Failed to read directory {}: {e}", dir.display());
            return tracks;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("mp3")) {
            let filename = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            // Try to get duration and audio info by decoding headers
            let (duration_secs, sample_rate_hz, channels) =
                match std::fs::read(&path) {
                    Ok(bytes) => {
                        match Decoder::new(Cursor::new(bytes)) {
                            Ok(source) => {
                                let sr = source.sample_rate();
                                let ch = source.channels() as u8;
                                let dur = source
                                    .total_duration()
                                    .map(|d| d.as_secs_f64())
                                    .unwrap_or(0.0);
                                (dur, sr, ch)
                            }
                            Err(_) => (0.0, 44100, 2),
                        }
                    }
                    Err(_) => (0.0, 44100, 2),
                };

            // Estimate bitrate from file size and duration
            let bitrate_kbps = if duration_secs > 0.0 {
                let file_size = std::fs::metadata(&path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                ((file_size as f64 * 8.0) / (duration_secs * 1000.0)) as u32
            } else {
                0
            };

            tracks.push(TrackInfo {
                path: path.to_string_lossy().to_string(),
                filename,
                duration_secs,
                bitrate_kbps,
                sample_rate_hz,
                channels,
            });
        }
    }

    tracks.sort_by(|a, b| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
    tracks
}

fn compute_fft_bins(samples: &[f32]) -> Vec<f32> {
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    // Apply Hann window and convert to complex
    let mut buffer: Vec<Complex<f32>> = samples
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let window =
                0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos());
            Complex::new(s * window, 0.0)
        })
        .collect();

    // Pad if needed
    buffer.resize(FFT_SIZE, Complex::new(0.0, 0.0));

    fft.process(&mut buffer);

    // Map to logarithmically-spaced bins
    let nyquist = FFT_SIZE / 2;
    let mut bins = vec![0.0f32; FFT_BINS];

    for (i, bin) in bins.iter_mut().enumerate() {
        // Log-spaced frequency band boundaries
        let lo = ((nyquist as f64).powf(i as f64 / FFT_BINS as f64)) as usize;
        let hi = ((nyquist as f64).powf((i + 1) as f64 / FFT_BINS as f64)) as usize;
        let lo = lo.max(1).min(nyquist);
        let hi = hi.max(lo + 1).min(nyquist);

        let mut sum = 0.0f32;
        let count = (hi - lo).max(1) as f32;
        for item in buffer.iter().take(hi).skip(lo) {
            sum += item.norm();
        }
        *bin = (sum / count / FFT_SIZE as f32 * 4.0).min(1.0);
    }

    bins
}

fn music_audio_thread(
    rx: mpsc::Receiver<MusicMsg>,
    state: Arc<RwLock<PlaybackState>>,
    app_handle: tauri::AppHandle,
) {
    let (_stream, stream_handle) = match OutputStream::try_default() {
        Ok(pair) => pair,
        Err(e) => {
            log::warn!("No audio output for music: {e}");
            for _ in rx {}
            return;
        }
    };

    let mut sink: Option<Sink> = None;
    let mut last_fft_time = Instant::now();
    let mut last_position_time = Instant::now();
    let mut playback_start: Option<Instant> = None;
    let mut playback_offset_secs: f64 = 0.0;

    // Real-time audio ring buffer — shared with TappedSource
    let audio_ring = Arc::new(AudioRingBuffer::new());

    // Smoothed FFT bins for visual smoothing
    let mut smooth_bins = vec![0.0f32; FFT_BINS];

    loop {
        // Non-blocking check for messages
        match rx.try_recv() {
            Ok(msg) => {
                let mut st = state.write().unwrap();
                match msg {
                    MusicMsg::LoadDirectory { path } => {
                        let tracks = scan_mp3_files(&path);
                        log::info!("Scanned {} MP3 files from {}", tracks.len(), path.display());
                        st.playlist = tracks;
                        st.playlist_index = 0;
                        st.status = PlayStatus::Stopped;
                        st.current_track = None;
                        st.position_secs = 0.0;
                        st.duration_secs = 0.0;
                        if let Some(s) = sink.take() {
                            s.stop();
                        }
                        playback_start = None;
                        emit_state(&app_handle, &st);
                    }
                    MusicMsg::LoadFile { path } => {
                        let dir = path.parent().unwrap_or(&path).to_path_buf();
                        let tracks = scan_mp3_files(&dir);
                        let idx = tracks
                            .iter()
                            .position(|t| t.path == path.to_string_lossy())
                            .unwrap_or(0);
                        st.playlist = tracks;
                        st.playlist_index = idx;
                        st.status = PlayStatus::Stopped;
                        st.current_track = None;
                        if let Some(s) = sink.take() {
                            s.stop();
                        }
                        playback_start = None;
                        emit_state(&app_handle, &st);
                    }
                    MusicMsg::Play => {
                        if st.playlist.is_empty() {
                            continue;
                        }
                        if st.status == PlayStatus::Paused {
                            if let Some(ref s) = sink {
                                s.play();
                                st.status = PlayStatus::Playing;
                                playback_start = Some(Instant::now());
                                playback_offset_secs = st.position_secs;
                                emit_state(&app_handle, &st);
                            }
                        } else {
                            let idx = st.playlist_index;
                            drop(st);
                            play_track(
                                idx,
                                &state,
                                &stream_handle,
                                &mut sink,
                                &audio_ring,
                                &mut playback_start,
                                &mut playback_offset_secs,
                                &app_handle,
                            );
                        }
                    }
                    MusicMsg::Pause => {
                        if let Some(ref s) = sink {
                            s.pause();
                        }
                        // Update position before pausing
                        if let Some(start) = playback_start {
                            st.position_secs =
                                playback_offset_secs + start.elapsed().as_secs_f64();
                        }
                        st.status = PlayStatus::Paused;
                        playback_start = None;
                        emit_state(&app_handle, &st);
                    }
                    MusicMsg::Stop => {
                        if let Some(s) = sink.take() {
                            s.stop();
                        }
                        st.status = PlayStatus::Stopped;
                        st.position_secs = 0.0;
                        playback_start = None;
                        emit_state(&app_handle, &st);
                    }
                    MusicMsg::Next => {
                        let len = st.playlist.len();
                        if len == 0 {
                            continue;
                        }
                        let next_idx = if st.shuffle {
                            use std::collections::hash_map::DefaultHasher;
                            use std::hash::{Hash, Hasher};
                            let mut hasher = DefaultHasher::new();
                            Instant::now().hash(&mut hasher);
                            hasher.finish() as usize % len
                        } else {
                            match st.repeat {
                                RepeatMode::One => st.playlist_index,
                                _ => {
                                    if st.playlist_index + 1 >= len {
                                        if st.repeat == RepeatMode::All {
                                            0
                                        } else {
                                            continue;
                                        }
                                    } else {
                                        st.playlist_index + 1
                                    }
                                }
                            }
                        };
                        drop(st);
                        play_track(
                            next_idx,
                            &state,
                            &stream_handle,
                            &mut sink,
                            &audio_ring,
                            &mut playback_start,
                            &mut playback_offset_secs,
                            &app_handle,
                        );
                    }
                    MusicMsg::Previous => {
                        let len = st.playlist.len();
                        if len == 0 {
                            continue;
                        }
                        let prev_idx = if st.playlist_index == 0 {
                            len - 1
                        } else {
                            st.playlist_index - 1
                        };
                        drop(st);
                        play_track(
                            prev_idx,
                            &state,
                            &stream_handle,
                            &mut sink,
                            &audio_ring,
                            &mut playback_start,
                            &mut playback_offset_secs,
                            &app_handle,
                        );
                    }
                    MusicMsg::PlayIndex { index } => {
                        if index >= st.playlist.len() {
                            continue;
                        }
                        drop(st);
                        play_track(
                            index,
                            &state,
                            &stream_handle,
                            &mut sink,
                            &audio_ring,
                            &mut playback_start,
                            &mut playback_offset_secs,
                            &app_handle,
                        );
                    }
                    MusicMsg::Seek { position_secs } => {
                        // Seeking with rodio requires re-creating the source
                        let idx = st.playlist_index;
                        let vol = st.volume;
                        drop(st);

                        if let Some(s) = sink.take() {
                            s.stop();
                        }

                        let st_r = state.read().unwrap();
                        if idx < st_r.playlist.len() {
                            let track = &st_r.playlist[idx];
                            if let Ok(bytes) = std::fs::read(&track.path) {
                                let cursor = Cursor::new(bytes);
                                if let Ok(source) = Decoder::new(BufReader::new(cursor)) {
                                    let skip_dur = Duration::from_secs_f64(position_secs.max(0.0));
                                    let skipped = source.skip_duration(skip_dur);
                                    let tapped = TappedSource::new(
                                        skipped.convert_samples::<f32>(),
                                        Arc::clone(&audio_ring),
                                    );
                                    match Sink::try_new(&stream_handle) {
                                        Ok(s) => {
                                            s.set_volume(vol);
                                            s.append(tapped);
                                            sink = Some(s);
                                        }
                                        Err(e) => log::warn!("Failed to create sink for seek: {e}"),
                                    }
                                }
                            }
                        }
                        drop(st_r);

                        let mut st = state.write().unwrap();
                        st.position_secs = position_secs.max(0.0);
                        playback_offset_secs = st.position_secs;
                        playback_start = Some(Instant::now());
                        emit_state(&app_handle, &st);
                    }
                    MusicMsg::SetVolume { volume } => {
                        let vol = volume.clamp(0.0, 1.0);
                        st.volume = vol;
                        if let Some(ref s) = sink {
                            s.set_volume(vol);
                        }
                        emit_state(&app_handle, &st);
                    }
                    MusicMsg::ToggleRepeat => {
                        st.repeat = match st.repeat {
                            RepeatMode::Off => RepeatMode::One,
                            RepeatMode::One => RepeatMode::All,
                            RepeatMode::All => RepeatMode::Off,
                        };
                        emit_state(&app_handle, &st);
                    }
                    MusicMsg::ToggleShuffle => {
                        st.shuffle = !st.shuffle;
                        emit_state(&app_handle, &st);
                    }
                }
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => break,
        }

        // Check if current track finished — auto-advance
        if let Some(ref s) = sink {
            if s.empty() {
                let st = state.read().unwrap();
                if st.status == PlayStatus::Playing {
                    let len = st.playlist.len();
                    let repeat = st.repeat;
                    let shuffle = st.shuffle;
                    let idx = st.playlist_index;
                    drop(st);

                    if len > 0 {
                        let next_idx = if shuffle {
                            use std::collections::hash_map::DefaultHasher;
                            use std::hash::{Hash, Hasher};
                            let mut hasher = DefaultHasher::new();
                            Instant::now().hash(&mut hasher);
                            hasher.finish() as usize % len
                        } else {
                            match repeat {
                                RepeatMode::One => idx,
                                RepeatMode::All => (idx + 1) % len,
                                RepeatMode::Off => {
                                    if idx + 1 < len {
                                        idx + 1
                                    } else {
                                        // End of playlist
                                        let mut st = state.write().unwrap();
                                        st.status = PlayStatus::Stopped;
                                        st.position_secs = 0.0;
                                        playback_start = None;
                                        emit_state(&app_handle, &st);
                                        std::thread::sleep(Duration::from_millis(10));
                                        continue;
                                    }
                                }
                            }
                        };

                        play_track(
                            next_idx,
                            &state,
                            &stream_handle,
                            &mut sink,
                            &audio_ring,
                            &mut playback_start,
                            &mut playback_offset_secs,
                            &app_handle,
                        );
                    }
                }
            }
        }

        // Emit position updates and FFT
        {
            let st = state.read().unwrap();
            if st.status == PlayStatus::Playing {
                if let Some(start) = playback_start {
                    let now = Instant::now();

                    // Position update (~2x per second)
                    if now.duration_since(last_position_time).as_millis()
                        >= POSITION_INTERVAL_MS as u128
                    {
                        last_position_time = now;
                        let pos = playback_offset_secs + start.elapsed().as_secs_f64();
                        let _ = app_handle.emit(
                            "music-position",
                            serde_json::json!({ "position_secs": pos }),
                        );
                    }

                    // FFT update (~30fps) — read from real-time audio tap
                    if now.duration_since(last_fft_time).as_millis() >= FFT_INTERVAL_MS as u128 {
                        last_fft_time = now;

                        let samples = audio_ring.read_last(FFT_SIZE);
                        if !samples.is_empty() {
                            let raw_bins = compute_fft_bins(&samples);
                            for (i, &raw) in raw_bins.iter().enumerate() {
                                // Fast attack (0.6), slow release (0.85) — beats punch through
                                if raw > smooth_bins[i] {
                                    smooth_bins[i] = smooth_bins[i] * 0.4 + raw * 0.6;
                                } else {
                                    smooth_bins[i] = smooth_bins[i] * 0.85 + raw * 0.15;
                                }
                            }
                            let _ = app_handle.emit(
                                "music-fft",
                                FftData {
                                    bins: smooth_bins.clone(),
                                },
                            );
                        }
                    }
                }
            }
        }

        std::thread::sleep(Duration::from_millis(10));
    }
}

#[allow(clippy::too_many_arguments)]
fn play_track(
    index: usize,
    state: &Arc<RwLock<PlaybackState>>,
    stream_handle: &rodio::OutputStreamHandle,
    sink: &mut Option<Sink>,
    audio_ring: &Arc<AudioRingBuffer>,
    playback_start: &mut Option<Instant>,
    playback_offset_secs: &mut f64,
    app_handle: &tauri::AppHandle,
) {
    // Stop current playback
    if let Some(s) = sink.take() {
        s.stop();
    }

    let track = {
        let st = state.read().unwrap();
        if index >= st.playlist.len() {
            return;
        }
        st.playlist[index].clone()
    };

    let bytes = match std::fs::read(&track.path) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("Failed to read {}: {e}", track.path);
            return;
        }
    };

    let cursor = Cursor::new(bytes);
    let source = match Decoder::new(BufReader::new(cursor)) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to decode {}: {e}", track.path);
            return;
        }
    };

    // Wrap in TappedSource for real-time FFT — captures samples as they play
    let tapped = TappedSource::new(source.convert_samples::<f32>(), Arc::clone(audio_ring));

    let mut st = state.write().unwrap();
    st.volume = st.volume.clamp(0.0, 1.0);

    match Sink::try_new(stream_handle) {
        Ok(s) => {
            s.set_volume(st.volume);
            s.append(tapped);
            *sink = Some(s);
        }
        Err(e) => {
            log::warn!("Failed to create music sink: {e}");
            return;
        }
    }

    st.playlist_index = index;
    st.current_track = Some(track.clone());
    st.duration_secs = track.duration_secs;
    st.position_secs = 0.0;
    st.status = PlayStatus::Playing;
    *playback_start = Some(Instant::now());
    *playback_offset_secs = 0.0;

    emit_state(app_handle, &st);
    log::info!("Playing: {}", track.filename);
}

fn emit_state(app_handle: &tauri::AppHandle, state: &PlaybackState) {
    let _ = app_handle.emit("music-state-changed", state);
}


fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") || path == "~" {
        if let Some(home) = dirs::home_dir() {
            return path.replacen('~', &home.to_string_lossy(), 1);
        }
    }
    path.to_string()
}

// ─── MusicEngine (Tauri state) ────────────────────────────────────

pub struct MusicEngine {
    tx: mpsc::Sender<MusicMsg>,
    state: Arc<RwLock<PlaybackState>>,
}

unsafe impl Send for MusicEngine {}
unsafe impl Sync for MusicEngine {}

pub type MusicEngineState = std::sync::Mutex<MusicEngine>;

impl MusicEngine {
    pub fn new(app_handle: tauri::AppHandle, config: &MusicConfig) -> Self {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(RwLock::new(PlaybackState {
            volume: config.volume as f32,
            ..Default::default()
        }));

        let state_for_thread = state.clone();
        std::thread::Builder::new()
            .name("krypton-music".into())
            .spawn(move || music_audio_thread(rx, state_for_thread, app_handle))
            .expect("failed to spawn music audio thread");

        Self { tx, state }
    }

    pub fn get_state(&self) -> PlaybackState {
        self.state.read().unwrap().clone()
    }

    fn send(&self, msg: MusicMsg) {
        let _ = self.tx.send(msg);
    }
}

// ─── Tauri Commands ───────────────────────────────────────────────

#[tauri::command]
pub fn music_load_dir(
    path: String,
    state: tauri::State<'_, MusicEngineState>,
    config: tauri::State<'_, std::sync::Arc<std::sync::RwLock<crate::config::KryptonConfig>>>,
) -> Result<PlaybackState, String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    let expanded = expand_tilde(&path);
    engine.send(MusicMsg::LoadDirectory {
        path: PathBuf::from(&expanded),
    });

    // Persist directory to config so it auto-loads next launch
    if let Ok(mut cfg) = config.write() {
        cfg.music.directory = path;
        // Write config to disk
        if let Some(config_path) = crate::config::config_path() {
            if let Ok(toml_str) = toml::to_string_pretty(&*cfg) {
                let content = format!(
                    "# Krypton configuration\n\
                     # See docs/06-configuration.md for full reference\n\n\
                     {toml_str}"
                );
                let _ = std::fs::write(config_path, content);
            }
        }
    }

    // Give the thread a moment to process
    std::thread::sleep(Duration::from_millis(50));
    Ok(engine.get_state())
}

#[tauri::command]
pub fn music_load_file(
    path: String,
    state: tauri::State<'_, MusicEngineState>,
) -> Result<PlaybackState, String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::LoadFile {
        path: PathBuf::from(path),
    });
    std::thread::sleep(Duration::from_millis(50));
    Ok(engine.get_state())
}

#[tauri::command]
pub fn music_play(state: tauri::State<'_, MusicEngineState>) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::Play);
    Ok(())
}

#[tauri::command]
pub fn music_pause(state: tauri::State<'_, MusicEngineState>) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::Pause);
    Ok(())
}

#[tauri::command]
pub fn music_stop(state: tauri::State<'_, MusicEngineState>) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::Stop);
    Ok(())
}

#[tauri::command]
pub fn music_next(state: tauri::State<'_, MusicEngineState>) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::Next);
    Ok(())
}

#[tauri::command]
pub fn music_previous(state: tauri::State<'_, MusicEngineState>) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::Previous);
    Ok(())
}

#[tauri::command]
pub fn music_play_index(
    index: usize,
    state: tauri::State<'_, MusicEngineState>,
) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::PlayIndex { index });
    Ok(())
}

#[tauri::command]
pub fn music_seek(
    position_secs: f64,
    state: tauri::State<'_, MusicEngineState>,
) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::Seek { position_secs });
    Ok(())
}

#[tauri::command]
pub fn music_set_volume(
    volume: f32,
    state: tauri::State<'_, MusicEngineState>,
) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::SetVolume { volume });
    Ok(())
}

#[tauri::command]
pub fn music_toggle_repeat(state: tauri::State<'_, MusicEngineState>) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::ToggleRepeat);
    Ok(())
}

#[tauri::command]
pub fn music_toggle_shuffle(state: tauri::State<'_, MusicEngineState>) -> Result<(), String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    engine.send(MusicMsg::ToggleShuffle);
    Ok(())
}

#[tauri::command]
pub fn music_get_state(state: tauri::State<'_, MusicEngineState>) -> Result<PlaybackState, String> {
    let engine = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    Ok(engine.get_state())
}
