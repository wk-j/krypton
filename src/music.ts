// Krypton — Music Player
// Frontend music player with dashboard overlay, mini-player footer bar,
// and Circuit Trace audio visualizer lifecycle management.

import { invoke } from './profiler/ipc';
import { listen } from '@tauri-apps/api/event';

import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';

import { OffscreenAnimationProxy, supportsOffscreenCanvas } from './offscreen-animation';

import type { Compositor } from './compositor';
import type { DashboardDefinition } from './types';

// ─── Types (mirror Rust) ─────────────────────────────────────────

export interface TrackInfo {
  path: string;
  filename: string;
  duration_secs: number;
  bitrate_kbps: number;
  sample_rate_hz: number;
  channels: number;
}

export interface PlaybackState {
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

interface FftData {
  bins: number[];
}

// ─── Formatting Helpers ──────────────────────────────────────────

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSampleRate(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)}kHz` : `${hz}Hz`;
}

function formatChannels(ch: number): string {
  return ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : `${ch}ch`;
}

// ─── Music Player ────────────────────────────────────────────────

export class MusicPlayer {
  private state: PlaybackState = {
    status: 'Stopped',
    current_track: null,
    position_secs: 0,
    duration_secs: 0,
    volume: 0.7,
    playlist: [],
    playlist_index: 0,
    repeat: 'Off',
    shuffle: false,
  };

  private miniPlayer: HTMLElement | null = null;
  private visualizer: OffscreenAnimationProxy | null = null;
  private visualizerEnabled = true;
  private visualizerOpacity = 0.18;
  private compositor: Compositor | null = null;
  private unlistenState: (() => void) | null = null;
  private unlistenPosition: (() => void) | null = null;
  private unlistenFft: (() => void) | null = null;

  // Mini visualizer state
  private miniVizCanvas: HTMLCanvasElement | null = null;
  private miniVizCtx: CanvasRenderingContext2D | null = null;
  private miniVizBins: number[] = [];
  private miniVizRaf: number = 0;

  // Dashboard selection state
  private selectedIndex = 0;
  private currentDirectory = '';

  // Animated track name state
  private animatedTrackPath = '';
  private trackLineAnimations: Animation[] = [];

  async init(workspaceEl: HTMLElement, compositor?: Compositor): Promise<void> {
    this.compositor = compositor ?? null;

    if (this.compositor) {
      // Move visualizer canvas when focused window changes
      this.compositor.onFocusChange(() => {
        this.moveVisualizerToFocusedWindow();
      });
      // Resize visualizer after window relayout
      this.compositor.onRelayout(() => {
        this.resizeVisualizer();
      });
    }

    // Listen for backend events
    this.unlistenState = await listen<PlaybackState>('music-state-changed', (event) => {
      const hadPlaylist = this.state.playlist.length > 0;
      this.state = event.payload;
      this.updateMiniPlayer();
      // Reset selection when playlist loads for the first time
      if (!hadPlaylist && this.state.playlist.length > 0) {
        this.selectedIndex = 0;
      }
      this.refreshDashboardList();
    });

    this.unlistenPosition = await listen<{ position_secs: number }>('music-position', (event) => {
      this.state.position_secs = event.payload.position_secs;
      this.updateMiniPlayerPosition();
    });

    this.unlistenFft = await listen<FftData>('music-fft', (event) => {
      if (this.visualizer) {
        this.visualizer.sendFftData(event.payload.bins);
      }
      this.miniVizBins = event.payload.bins;
    });

    // Create mini-player bar
    this.createMiniPlayer();

    // Fetch initial state
    try {
      this.state = await invoke<PlaybackState>('music_get_state');
      this.updateMiniPlayer();
    } catch (e) {
      console.warn('[MusicPlayer] Failed to get initial state:', e);
    }
  }

  applyConfig(config: { enabled: boolean; volume: number; directory: string; visualizer: boolean; visualizer_opacity: number }): void {
    this.visualizerEnabled = config.visualizer;
    this.visualizerOpacity = config.visualizer_opacity;

    if (this.visualizer) {
      this.visualizer.setOpacity(this.visualizerOpacity);
    }

    // Auto-load directory from config on startup (only if no playlist loaded yet)
    if (config.directory && this.state.playlist.length === 0 && !this.currentDirectory) {
      this.currentDirectory = config.directory;
      this.loadDirectory(config.directory);
    }
  }

  // ─── IPC Commands ────────────────────────────────────────────

  async loadDirectory(path: string): Promise<void> {
    try {
      // Fire and forget — the music-state-changed event will update UI
      // when the audio thread finishes scanning the directory.
      await invoke<PlaybackState>('music_load_dir', { path });
      // Remember this directory for next launch
      this.currentDirectory = path;
    } catch (e) {
      console.warn('[MusicPlayer] Failed to load directory:', e);
    }
  }

  /** Get the currently loaded directory path */
  getCurrentDirectory(): string {
    return this.currentDirectory;
  }

  async play(): Promise<void> {
    await invoke('music_play').catch(() => {});
  }

  async pause(): Promise<void> {
    await invoke('music_pause').catch(() => {});
  }

  async togglePlayPause(): Promise<void> {
    if (this.state.status === 'Playing') {
      await this.pause();
    } else {
      await this.play();
    }
  }

  async stop(): Promise<void> {
    await invoke('music_stop').catch(() => {});
    this.stopVisualizer();
  }

  async next(): Promise<void> {
    await invoke('music_next').catch(() => {});
  }

  async previous(): Promise<void> {
    await invoke('music_previous').catch(() => {});
  }

  async playIndex(index: number): Promise<void> {
    console.log(`[MusicPlayer] playIndex(${index}), playlist length: ${this.state.playlist.length}`);
    await invoke('music_play_index', { index }).catch((e) => {
      console.warn('[MusicPlayer] playIndex failed:', e);
    });
  }

  async seek(positionSecs: number): Promise<void> {
    await invoke('music_seek', { positionSecs }).catch(() => {});
  }

  async setVolume(volume: number): Promise<void> {
    await invoke('music_set_volume', { volume: Math.max(0, Math.min(1, volume)) }).catch(() => {});
  }

  async toggleRepeat(): Promise<void> {
    await invoke('music_toggle_repeat').catch(() => {});
  }

  async toggleShuffle(): Promise<void> {
    await invoke('music_toggle_shuffle').catch(() => {});
  }

  getState(): PlaybackState {
    return this.state;
  }

  // ─── Visualizer ──────────────────────────────────────────────

  private startVisualizer(): void {
    if (!this.visualizerEnabled) return;
    if (this.visualizer) return; // Already running
    if (!supportsOffscreenCanvas()) {
      console.warn('[MusicPlayer] OffscreenCanvas not supported');
      return;
    }

    const container = this.compositor?.getFocusedContentElement();
    if (!container) return;

    console.log('[MusicPlayer] Starting Circuit Trace visualizer (in-window)');

    this.visualizer = new OffscreenAnimationProxy('circuit-trace');
    this.visualizer.setOpacity(this.visualizerOpacity);
    const canvas = this.visualizer.getElement();

    // Insert as first child of window content (behind terminal panes)
    container.insertBefore(canvas, container.firstChild);

    this.visualizer.start();
  }

  /** Move the visualizer canvas into the currently focused window */
  private moveVisualizerToFocusedWindow(): void {
    if (!this.visualizer) return;
    const container = this.compositor?.getFocusedContentElement();
    if (!container) return;

    const canvas = this.visualizer.getElement();
    // Skip if already in this window
    if (canvas.parentElement === container) return;

    container.insertBefore(canvas, container.firstChild);
    this.visualizer.resize();
  }

  private stopVisualizer(): void {
    if (this.visualizer) {
      console.log('[MusicPlayer] Stopping Circuit Trace visualizer');
      this.visualizer.stop();
      this.visualizer.dispose();
      this.visualizer = null;
    }
  }

  /** Resize the visualizer canvas (call after window relayout) */
  resizeVisualizer(): void {
    if (this.visualizer) {
      this.visualizer.resize();
    }
  }

  toggleVisualizer(): void {
    this.visualizerEnabled = !this.visualizerEnabled;
    if (this.visualizerEnabled && this.state.status === 'Playing') {
      this.startVisualizer();
    } else if (!this.visualizerEnabled) {
      this.stopVisualizer();
    }
  }

  // ─── Mini-Player Bar ────────────────────────────────────────

  private createMiniPlayer(): void {
    this.miniPlayer = document.createElement('div');
    this.miniPlayer.className = 'krypton-mini-player';
    this.miniPlayer.style.display = 'none';
    document.body.appendChild(this.miniPlayer);

    // Create mini visualizer canvas
    this.miniVizCanvas = document.createElement('canvas');
    this.miniVizCanvas.className = 'krypton-mini-player__viz';
    this.miniVizCanvas.width = 120;
    this.miniVizCanvas.height = 22;
    this.miniVizCtx = this.miniVizCanvas.getContext('2d');
  }

  private updateMiniPlayer(): void {
    if (!this.miniPlayer) return;

    const hasTrack = this.state.playlist.length > 0;
    this.miniPlayer.style.display = hasTrack ? 'flex' : 'none';

    if (!hasTrack) return;

    // Manage visualizer lifecycle
    if (this.state.status === 'Playing') {
      this.startVisualizer();
    } else {
      this.stopVisualizer();
    }

    const track = this.state.current_track;
    const statusIcon =
      this.state.status === 'Playing' ? '\u25B6' :
      this.state.status === 'Paused' ? '\u23F8' : '\u23F9';

    const trackName = track ? track.filename : '—';
    const audioInfo = track
      ? `MP3 \u00B7 ${track.bitrate_kbps}kbps \u00B7 ${formatSampleRate(track.sample_rate_hz)} \u00B7 ${formatChannels(track.channels)}`
      : '';
    const time = `${formatTime(this.state.position_secs)} / ${formatTime(this.state.duration_secs)}`;
    const progress = this.state.duration_secs > 0
      ? (this.state.position_secs / this.state.duration_secs) * 100
      : 0;

    const repeatIcon = this.state.repeat === 'One' ? ' [R1]' : this.state.repeat === 'All' ? ' [R]' : '';
    const shuffleIcon = this.state.shuffle ? ' [S]' : '';

    this.miniPlayer.innerHTML = `
      <span class="krypton-mini-player__status">${statusIcon}</span>
      <span class="krypton-mini-player__track">${this.escapeHtml(trackName)}</span>
      <span class="krypton-mini-player__info">${audioInfo}</span>
      <span class="krypton-mini-player__flags">${repeatIcon}${shuffleIcon}</span>
      <span class="krypton-mini-player__time">${time}</span>
      <div class="krypton-mini-player__progress">
        <div class="krypton-mini-player__progress-fill" style="width: ${progress}%"></div>
      </div>
    `;

    // Insert mini visualizer canvas (between status icon and track name)
    if (this.miniVizCanvas) {
      const statusEl = this.miniPlayer.querySelector('.krypton-mini-player__status');
      if (statusEl) {
        statusEl.after(this.miniVizCanvas);
      }
    }

    // Start/stop mini visualizer animation loop
    if (this.state.status === 'Playing') {
      this.startMiniViz();
    } else {
      this.stopMiniViz();
    }
  }

  private updateMiniPlayerPosition(): void {
    if (!this.miniPlayer) return;
    const timeEl = this.miniPlayer.querySelector('.krypton-mini-player__time');
    const fillEl = this.miniPlayer.querySelector('.krypton-mini-player__progress-fill') as HTMLElement;

    if (timeEl) {
      timeEl.textContent = `${formatTime(this.state.position_secs)} / ${formatTime(this.state.duration_secs)}`;
    }
    if (fillEl && this.state.duration_secs > 0) {
      fillEl.style.width = `${(this.state.position_secs / this.state.duration_secs) * 100}%`;
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Mini Visualizer ───────────────────────────────────────

  private startMiniViz(): void {
    if (this.miniVizRaf) return;
    const draw = (): void => {
      this.drawMiniViz();
      this.miniVizRaf = requestAnimationFrame(draw);
    };
    this.miniVizRaf = requestAnimationFrame(draw);
  }

  private stopMiniViz(): void {
    if (this.miniVizRaf) {
      cancelAnimationFrame(this.miniVizRaf);
      this.miniVizRaf = 0;
    }
    // Clear canvas
    if (this.miniVizCtx && this.miniVizCanvas) {
      this.miniVizCtx.clearRect(0, 0, this.miniVizCanvas.width, this.miniVizCanvas.height);
    }
  }

  private drawMiniViz(): void {
    const ctx = this.miniVizCtx;
    const canvas = this.miniVizCanvas;
    if (!ctx || !canvas) return;

    const bins = this.miniVizBins;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (bins.length === 0) return;

    // Draw frequency bars across the canvas
    const barCount = 28;
    const gap = 1;
    const barWidth = (w - gap * (barCount - 1)) / barCount;

    for (let i = 0; i < barCount; i++) {
      // Map bar index to FFT bin (skip bin 0 which is DC offset)
      const binIndex = Math.min(1 + Math.floor((i / barCount) * (bins.length - 1)), bins.length - 1);
      const value = bins[binIndex] ?? 0;

      // Height proportional to FFT magnitude (bins are 0..1 range)
      const barH = Math.max(2, value * h);
      const x = i * (barWidth + gap);
      const y = h - barH;

      // Brighter bars with cyan-to-white gradient based on intensity
      const alpha = 0.6 + value * 0.4;
      const green = Math.round(212 + value * 43);
      ctx.fillStyle = `rgba(0, ${green}, 255, ${alpha})`;
      ctx.fillRect(x, y, barWidth, barH);

      // Bright cap on top of each bar for extra visibility
      if (value > 0.05) {
        ctx.fillStyle = `rgba(180, 240, 255, ${0.7 + value * 0.3})`;
        ctx.fillRect(x, y, barWidth, Math.min(2, barH));
      }
    }
  }

  // ─── Dashboard Definition ──────────────────────────────────

  createDashboard(): DashboardDefinition {
    return {
      id: 'music',
      title: 'Music Player',
      shortcut: { key: 'KeyM', meta: true, shift: true },
      tabs: [
        {
          label: 'Player',
          render: (container: HTMLElement) => this.renderPlayerTab(container),
        },
      ],
      onOpen: (ready: () => void) => {
        this.selectedIndex = this.state.playlist_index;
        ready();
      },
      onKeyDown: (e: KeyboardEvent): boolean => {
        return this.handleDashboardKey(e);
      },
    };
  }

  private renderPlayerTab(container: HTMLElement): void {
    container.innerHTML = '';
    container.className = 'krypton-music-dashboard';

    // Left: playlist
    const left = document.createElement('div');
    left.className = 'krypton-music-dashboard__playlist';

    // Directory input
    const dirBar = document.createElement('div');
    dirBar.className = 'krypton-music-dashboard__dir-bar';
    const dirValue = this.escapeHtml(this.currentDirectory);
    dirBar.innerHTML = `
      <span class="krypton-music-dashboard__dir-label">DIR:</span>
      <input type="text" class="krypton-music-dashboard__dir-input"
             placeholder="~/Music" value="${dirValue}" spellcheck="false" />
    `;
    left.appendChild(dirBar);

    // Track list
    const list = document.createElement('div');
    list.className = 'krypton-music-dashboard__track-list';
    this.renderTrackList(list);
    left.appendChild(list);

    // Right: now playing
    const right = document.createElement('div');
    right.className = 'krypton-music-dashboard__now-playing';
    this.renderNowPlaying(right);

    container.appendChild(left);
    container.appendChild(right);

    // Focus the dir input if no playlist
    if (this.state.playlist.length === 0) {
      const input = dirBar.querySelector('input') as HTMLInputElement;
      requestAnimationFrame(() => input?.focus());
    }
  }

  private renderTrackList(container: HTMLElement): void {
    container.innerHTML = '';
    if (this.state.playlist.length === 0) {
      container.innerHTML = '<div class="krypton-music-dashboard__empty">No MP3 files loaded. Press [o] to open a directory.</div>';
      return;
    }

    for (let i = 0; i < this.state.playlist.length; i++) {
      const track = this.state.playlist[i];
      const el = document.createElement('div');
      el.className = 'krypton-music-dashboard__track';
      if (i === this.state.playlist_index && this.state.status !== 'Stopped') {
        el.classList.add('krypton-music-dashboard__track--playing');
      }
      if (i === this.selectedIndex) {
        el.classList.add('krypton-music-dashboard__track--selected');
      }
      el.innerHTML = `
        <span class="krypton-music-dashboard__track-idx">${String(i + 1).padStart(2, ' ')}</span>
        <span class="krypton-music-dashboard__track-name">${this.escapeHtml(track.filename)}</span>
        <span class="krypton-music-dashboard__track-duration">${formatTime(track.duration_secs)}</span>
      `;
      container.appendChild(el);
    }

    // Scroll selected into view
    const selected = container.querySelector('.krypton-music-dashboard__track--selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  private renderNowPlaying(container: HTMLElement): void {
    const track = this.state.current_track;
    const statusLabel =
      this.state.status === 'Playing' ? 'PLAYING' :
      this.state.status === 'Paused' ? 'PAUSED' : 'STOPPED';

    const repeatLabel = this.state.repeat === 'One' ? 'REPEAT: ONE' : this.state.repeat === 'All' ? 'REPEAT: ALL' : 'REPEAT: OFF';
    const shuffleLabel = this.state.shuffle ? 'SHUFFLE: ON' : 'SHUFFLE: OFF';
    const volPercent = Math.round(this.state.volume * 100);

    container.innerHTML = `
      <div class="krypton-music-dashboard__np-status">${statusLabel}</div>
      <div class="krypton-music-dashboard__np-track"></div>
      <div class="krypton-music-dashboard__np-info">${track ? `MP3 \u00B7 ${track.bitrate_kbps}kbps \u00B7 ${formatSampleRate(track.sample_rate_hz)} \u00B7 ${formatChannels(track.channels)}` : ''}</div>
      <div class="krypton-music-dashboard__np-time">
        <span>${formatTime(this.state.position_secs)}</span>
        <div class="krypton-music-dashboard__np-progress">
          <div class="krypton-music-dashboard__np-progress-fill" style="width: ${this.state.duration_secs > 0 ? (this.state.position_secs / this.state.duration_secs * 100) : 0}%"></div>
        </div>
        <span>${formatTime(this.state.duration_secs)}</span>
      </div>
      <div class="krypton-music-dashboard__np-controls">
        <span>VOL: ${volPercent}%</span>
        <span>${repeatLabel}</span>
        <span>${shuffleLabel}</span>
        <span>VIS: ${this.visualizerEnabled ? 'ON' : 'OFF'}</span>
      </div>
      <div class="krypton-music-dashboard__np-help">
        <div>[Space] Play/Pause  [s] Stop  [n/j] Next  [p/k] Prev</div>
        <div>[Enter] Play selected  [o] Open dir  [+/-] Volume</div>
        <div>[r] Repeat  [z] Shuffle  [v] Visualizer  [Esc] Close</div>
      </div>
    `;

    // Animate the track name with pretext line-by-line reveal
    const trackEl = container.querySelector('.krypton-music-dashboard__np-track') as HTMLElement;
    if (trackEl) {
      this.renderAnimatedTrackName(trackEl, track?.filename ?? '\u2014', track?.path ?? '');
    }
  }

  private renderAnimatedTrackName(container: HTMLElement, name: string, trackPath: string): void {
    // Check if this is a new track (skip re-animation on state refreshes)
    const isNewTrack = trackPath !== this.animatedTrackPath;
    this.animatedTrackPath = trackPath;

    // Cancel any running animations
    for (const anim of this.trackLineAnimations) {
      anim.cancel();
    }
    this.trackLineAnimations = [];

    container.innerHTML = '';

    if (name === '\u2014') {
      container.textContent = '\u2014';
      return;
    }

    // Use pretext to break the track name into lines.
    // The now-playing panel is 320px with 16px padding on each side = 288px available.
    const font = '500 16px "Mononoki Nerd Font Mono", "JetBrains Mono", monospace';
    const maxWidth = 288;
    const lineHeight = 22;

    const prepared = prepareWithSegments(name, font);
    const { lines } = layoutWithLines(prepared, maxWidth, lineHeight);

    for (let i = 0; i < lines.length; i++) {
      const lineEl = document.createElement('div');
      lineEl.className = 'krypton-music-dashboard__np-track-line';
      lineEl.textContent = lines[i].text;

      if (isNewTrack) {
        // Start hidden, then animate in
        lineEl.style.opacity = '0';
        lineEl.style.transform = 'translateX(-12px)';
      }

      container.appendChild(lineEl);

      if (isNewTrack) {
        // Staggered slide-in + fade animation per line
        const delay = i * 80;
        const anim = lineEl.animate([
          { opacity: 0, transform: 'translateX(-12px)', filter: 'blur(4px)' },
          { opacity: 0.5, transform: 'translateX(2px)', filter: 'blur(0px)', offset: 0.6 },
          { opacity: 1, transform: 'translateX(0)', filter: 'blur(0px)' },
        ], {
          duration: 320,
          delay,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          fill: 'forwards',
        });
        this.trackLineAnimations.push(anim);

        // Glow pulse on each line after it appears
        const glowAnim = lineEl.animate([
          { textShadow: '0 0 0px transparent' },
          { textShadow: '0 0 8px rgba(0, 212, 255, 0.6)', offset: 0.4 },
          { textShadow: '0 0 2px rgba(0, 212, 255, 0.15)' },
        ], {
          duration: 600,
          delay: delay + 200,
          easing: 'ease-out',
          fill: 'forwards',
        });
        this.trackLineAnimations.push(glowAnim);
      }
    }
  }

  private handleDashboardKey(e: KeyboardEvent): boolean {
    const key = e.key;

    // Directory input handling
    const input = document.querySelector('.krypton-music-dashboard__dir-input') as HTMLInputElement;
    if (input && document.activeElement === input) {
      if (key === 'Enter') {
        const dir = input.value.trim();
        console.log(`[MusicPlayer] Dir input Enter: "${dir}"`);
        if (dir) {
          this.loadDirectory(dir);
          input.blur();
        }
        return true;
      }
      if (key === 'Escape') {
        input.blur();
        return true;
      }
      return false; // Let the input handle its own keys
    }

    switch (key) {
      case ' ':
        e.preventDefault();
        this.togglePlayPause();
        return true;
      case 's':
        this.stop();
        return true;
      case 'n':
      case 'j':
      case 'ArrowDown':
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.state.playlist.length - 1);
        this.refreshDashboardList();
        return true;
      case 'p':
      case 'k':
      case 'ArrowUp':
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.refreshDashboardList();
        return true;
      case 'Enter':
        console.log(`[MusicPlayer] Enter pressed, playlist: ${this.state.playlist.length}, selected: ${this.selectedIndex}`);
        if (this.state.playlist.length > 0) {
          this.playIndex(this.selectedIndex);
        }
        return true;
      case 'l':
      case 'ArrowRight':
        this.seek(this.state.position_secs + 10);
        return true;
      case 'h':
      case 'ArrowLeft':
        this.seek(Math.max(0, this.state.position_secs - 10));
        return true;
      case '+':
      case '=':
        this.setVolume(this.state.volume + 0.05);
        return true;
      case '-':
        this.setVolume(this.state.volume - 0.05);
        return true;
      case 'r':
        this.toggleRepeat();
        return true;
      case 'z':
        this.toggleShuffle();
        return true;
      case 'v':
        this.toggleVisualizer();
        return true;
      case 'o': {
        const dirInput = document.querySelector('.krypton-music-dashboard__dir-input') as HTMLInputElement;
        dirInput?.focus();
        return true;
      }
      default:
        return false;
    }
  }

  private refreshDashboardList(): void {
    const list = document.querySelector('.krypton-music-dashboard__track-list');
    if (list) {
      this.renderTrackList(list as HTMLElement);
    }
    const np = document.querySelector('.krypton-music-dashboard__now-playing');
    if (np) {
      this.renderNowPlaying(np as HTMLElement);
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────

  dispose(): void {
    this.unlistenState?.();
    this.unlistenPosition?.();
    this.unlistenFft?.();
    this.stopVisualizer();
    this.miniPlayer?.remove();
  }
}
