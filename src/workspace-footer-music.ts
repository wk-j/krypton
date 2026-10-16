import { footerSegment } from './workspace-footer-dom';

export interface MusicFooterSegment {
  statusIcon: string;
  track: string;
  info: string;
  flags: string;
  time: string;
  progressPct: number;
  playing: boolean;
  visualizer?: HTMLCanvasElement;
}

/** Music mini-player segment in the footer's right zone. Rebuilds only when the
 *  static parts (icon/track/info/flags/visualizer) change; time + progress are
 *  patched in place. */
export class FooterMusic {
  readonly el: HTMLElement;
  private progressFillEl: HTMLElement;
  private musicIconEl: HTMLElement | null = null;
  private musicTimeEl: HTMLElement | null = null;
  private renderedMusicKey: string | null = null;
  private musicSegment: MusicFooterSegment | null = null;
  private musicVisualizer: HTMLCanvasElement | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'krypton-workspace-footer__music';
    this.el.setAttribute('aria-label', 'music mini player');
    this.el.setAttribute('aria-hidden', 'true');
    this.progressFillEl = document.createElement('div');
    this.progressFillEl.className = 'krypton-workspace-footer__music-progress-fill';
  }

  get active(): boolean {
    return this.musicSegment !== null;
  }

  set(segment: MusicFooterSegment | null): void {
    this.musicSegment = segment;
    this.el.setAttribute('aria-hidden', segment ? 'false' : 'true');
    if (!segment) {
      this.renderedMusicKey = null;
      this.musicIconEl = null;
      this.musicTimeEl = null;
      this.progressFillEl.style.width = '0%';
    }
  }

  updatePosition(time: string, progressPct: number, playing: boolean): void {
    if (!this.musicSegment) return;
    this.musicSegment.time = time;
    this.musicSegment.progressPct = progressPct;
    this.musicSegment.playing = playing;
    if (this.musicTimeEl) this.musicTimeEl.textContent = time;
    this.progressFillEl.style.width = `${Math.max(0, Math.min(100, progressPct))}%`;
  }

  render(): void {
    const segment = this.musicSegment;
    if (!segment) {
      this.el.replaceChildren();
      this.musicVisualizer = null;
      this.renderedMusicKey = null;
      return;
    }

    const key = [
      segment.statusIcon,
      segment.track,
      segment.info,
      segment.flags,
      segment.visualizer ? 'viz' : 'no-viz',
    ].join('\u001f');

    if (key === this.renderedMusicKey) {
      this.updatePosition(segment.time, segment.progressPct, segment.playing);
      return;
    }

    this.renderedMusicKey = key;
    this.el.replaceChildren();
    this.musicVisualizer = null;

    const icon = footerSegment(segment.statusIcon, 'music-icon');
    this.musicIconEl = icon;
    const track = footerSegment(segment.track, 'music-track');
    const info = footerSegment(segment.info, 'music-info');
    const flags = footerSegment(segment.flags, 'music-flags');
    const time = footerSegment(segment.time, 'music-time');
    this.musicTimeEl = time;
    const progress = document.createElement('div');
    progress.className = 'krypton-workspace-footer__music-progress';
    this.progressFillEl.style.width = `${Math.max(0, Math.min(100, segment.progressPct))}%`;
    progress.appendChild(this.progressFillEl);

    this.el.appendChild(icon);
    if (segment.visualizer) {
      this.musicVisualizer = segment.visualizer;
      this.el.appendChild(segment.visualizer);
    }
    this.el.append(track, info, flags, time, progress);
  }
}
