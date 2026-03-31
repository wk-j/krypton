// Krypton — Profiler HUD
// Non-modal, non-focusable floating overlay docked to the top-right corner.
// Displays live performance metrics: FPS, heap, DOM, IPC, PTY, agent, layout.
// Toggle with Cmd+P → Shift+P.  pointer-events: none — clicks pass through.

import { collector } from './metrics';
import type { ProfilerSnapshot, IpcAggregated } from './metrics';

export class ProfilerHud {
  private element: HTMLElement;
  private visible = false;
  private renderInterval: number | null = null;

  // DOM sections
  private summaryRow: HTMLElement;
  private ipcSection: HTMLElement;
  private ptySection: HTMLElement;
  private agentSection: HTMLElement;
  private layoutSection: HTMLElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'krypton-profiler-hud';

    // Title
    const title = document.createElement('div');
    title.className = 'krypton-profiler-hud__title';
    title.textContent = 'PROFILER';
    this.element.appendChild(title);

    // Summary row (FPS, Heap, DOM)
    this.summaryRow = document.createElement('div');
    this.summaryRow.className = 'krypton-profiler-hud__row';
    this.element.appendChild(this.summaryRow);

    // IPC section
    this.ipcSection = this.createSection('IPC');
    // PTY section
    this.ptySection = this.createSection('PTY');
    // Agent section
    this.agentSection = this.createSection('AGENT');
    // Layout section
    this.layoutSection = this.createSection('LAYOUT');

    document.body.appendChild(this.element);
  }

  private createSection(label: string): HTMLElement {
    const header = document.createElement('div');
    header.className = 'krypton-profiler-hud__section-header';
    header.textContent = label;
    this.element.appendChild(header);

    const body = document.createElement('div');
    body.className = 'krypton-profiler-hud__section';
    this.element.appendChild(body);
    return body;
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.element.classList.add('krypton-profiler-hud--visible');
    collector.startFps();
    this.renderInterval = window.setInterval(() => this.render(), 1000);
    // Render immediately
    this.render();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.element.classList.remove('krypton-profiler-hud--visible');
    collector.stopFps();
    if (this.renderInterval !== null) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
  }

  get isVisible(): boolean {
    return this.visible;
  }

  private render(): void {
    const snap = collector.getSnapshot();
    this.renderSummary(snap);
    this.renderIpc(snap);
    this.renderPty(snap);
    this.renderAgent(snap);
    this.renderLayout(snap);
  }

  private renderSummary(snap: ProfilerSnapshot): void {
    const heapStr = snap.heap
      ? `Heap ${snap.heap.usedMB}/${snap.heap.totalMB}MB`
      : 'Heap n/a';
    this.summaryRow.textContent = `FPS ${snap.fps}  ${heapStr}  DOM ${snap.domNodes}`;
  }

  private renderIpc(snap: ProfilerSnapshot): void {
    if (snap.ipc.aggregated.size === 0) {
      this.ipcSection.textContent = '(no calls)';
      return;
    }

    // Sort by total time descending
    const entries = [...snap.ipc.aggregated.entries()]
      .sort((a, b) => b[1].totalMs - a[1].totalMs);

    const totalCalls = entries.reduce((s, [, v]) => s + v.count, 0);
    const lines: string[] = [`total ${totalCalls} calls`];

    for (const [cmd, stats] of entries.slice(0, 8)) {
      lines.push(this.formatIpcLine(cmd, stats));
    }

    this.ipcSection.textContent = lines.join('\n');
  }

  private formatIpcLine(cmd: string, stats: IpcAggregated): string {
    const name = cmd.length > 18 ? cmd.slice(0, 17) + '…' : cmd.padEnd(18);
    const count = `×${stats.count}`.padStart(6);
    const avg = `avg ${stats.avgMs.toFixed(1)}`.padStart(9);
    const max = `max ${stats.maxMs.toFixed(1)}`.padStart(9);
    return `${name}${count} ${avg} ${max}`;
  }

  private renderPty(snap: ProfilerSnapshot): void {
    if (snap.pty.length === 0) {
      this.ptySection.textContent = '(none)';
      return;
    }

    const lines = snap.pty.map((p) => {
      const rate = this.formatBytes(p.bytesPerSecond) + '/s';
      const total = this.formatBytes(p.totalBytes);
      return `#${p.sessionId}  ${rate.padStart(10)}  ${total.padStart(8)} total`;
    });

    this.ptySection.textContent = lines.join('\n');
  }

  private renderAgent(snap: ProfilerSnapshot): void {
    if (!snap.agent) {
      this.agentSection.textContent = '(none)';
      return;
    }

    const a = snap.agent;
    const prompt = a.promptText.length > 30
      ? `"${a.promptText.slice(0, 29)}…"`
      : `"${a.promptText}"`;

    const duration = a.totalDuration !== null
      ? `${(a.totalDuration / 1000).toFixed(1)}s`
      : `${((performance.now() - a.startTime) / 1000).toFixed(1)}s…`;

    const ttft = a.timeToFirstToken !== null
      ? `TTFT ${(a.timeToFirstToken / 1000).toFixed(1)}s`
      : 'TTFT …';

    const tokRate = (a.totalDuration !== null && a.outputTokens > 0)
      ? `${Math.round(a.outputTokens / (a.totalDuration / 1000))} tok/s`
      : '';

    const tokens = a.outputTokens > 0 ? `${a.outputTokens} tok` : '';

    this.agentSection.textContent =
      `${prompt}  ${duration}\n${ttft}  ${tokens}  ${tokRate}`;
  }

  private renderLayout(snap: ProfilerSnapshot): void {
    this.layoutSection.textContent = `last pass ${snap.layoutMs.toFixed(1)}ms`;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
}
