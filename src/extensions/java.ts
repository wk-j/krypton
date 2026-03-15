// Krypton — Java Resource Monitor Extension
// Shows JVM heap, GC stats, CPU, and RSS for a Java server process.
// Only shows data for the java process that has a TCP listening port
// in the same working directory as the terminal.

import { invoke } from '@tauri-apps/api/core';
import type { ContextExtension, ExtensionWidget, JavaServerInfo, JavaStats, ProcessInfo, SessionId } from '../types';

/** Callback to trigger pane refit when bars change visibility. */
type RefitCallback = (() => void) | null;

/** Format a number, avoiding NaN display. */
function fmt(n: number, decimals: number): string {
  return Number.isFinite(n) ? n.toFixed(decimals) : '--';
}

/** Get the gauge color based on percentage. */
function gaugeColor(pct: number): string {
  if (pct > 95) return '#ec5f67';
  if (pct > 80) return '#fac863';
  if (pct > 60) return 'rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.9)';
  return 'rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.7)';
}

/** Update the stats panel with live JavaStats data. */
function updateStatsBar(panel: HTMLElement, stats: JavaStats): void {
  // Heap gauge
  const heapBar = panel.querySelector<HTMLElement>('[data-field="heap-bar"]');
  const heapPct = panel.querySelector('[data-field="heap-pct"]');
  const heapText = panel.querySelector('[data-field="heap-text"]');
  const heapSection = panel.querySelector<HTMLElement>('[data-field="heap"]');

  if (heapBar) {
    const pct = Math.min(stats.heap_percent, 100);
    heapBar.style.width = `${pct}%`;
    heapBar.style.background = gaugeColor(pct);
  }
  if (heapPct) heapPct.textContent = `${fmt(stats.heap_percent, 0)}%`;
  if (heapText) heapText.textContent = `${fmt(stats.heap_used_mb, 0)} / ${fmt(stats.heap_max_mb, 0)} MB`;
  if (heapSection) {
    heapSection.classList.toggle('krypton-java-panel__heap--warn', stats.heap_percent > 80 && stats.heap_percent <= 95);
    heapSection.classList.toggle('krypton-java-panel__heap--critical', stats.heap_percent > 95);
  }

  // GC
  const gcText = panel.querySelector('[data-field="gc-text"]');
  if (gcText) gcText.textContent = `${stats.gc_count} runs (${fmt(stats.gc_time_secs, 1)}s)`;

  // CPU
  const cpuText = panel.querySelector('[data-field="cpu-text"]');
  if (cpuText) cpuText.textContent = `${fmt(stats.cpu_percent, 1)}%`;

  // RSS
  const rssText = panel.querySelector('[data-field="rss-text"]');
  if (rssText) rssText.textContent = `${fmt(stats.rss_mb, 0)} MB`;
}

export const javaExtension: ContextExtension = {
  name: 'java-monitor',
  description: 'JVM resource monitor — heap, GC, CPU, memory',
  processNames: ['java'],

  createWidgets(_process: ProcessInfo, sessionId: SessionId): ExtensionWidget[] {
    // ── Top bar: shows server identity once found ──
    const topBar = document.createElement('div');
    topBar.className = 'krypton-extension-bar krypton-extension-bar--accent';
    topBar.innerHTML = `
      <span class="krypton-extension-bar__label">JAVA</span>
      <span class="krypton-extension-bar__content" data-field="main-class">Searching for server...</span>
    `;

    // ── Bottom panel: graphical resource stats ──
    const bottomBar = document.createElement('div');
    bottomBar.className = 'krypton-java-panel';
    bottomBar.innerHTML = `
      <div class="krypton-java-panel__section krypton-java-panel__heap" data-field="heap">
        <div class="krypton-java-panel__header">
          <span class="krypton-java-panel__label">HEAP</span>
          <span class="krypton-java-panel__value" data-field="heap-text">-- / -- MB</span>
        </div>
        <div class="krypton-java-panel__gauge">
          <div class="krypton-java-panel__gauge-fill" data-field="heap-bar" style="width: 0%"></div>
          <span class="krypton-java-panel__gauge-pct" data-field="heap-pct">0%</span>
        </div>
      </div>
      <div class="krypton-java-panel__metrics">
        <div class="krypton-java-panel__metric" data-field="gc">
          <span class="krypton-java-panel__metric-icon">&#9676;</span>
          <span class="krypton-java-panel__label">GC</span>
          <span class="krypton-java-panel__value" data-field="gc-text">--</span>
        </div>
        <div class="krypton-java-panel__metric" data-field="cpu">
          <span class="krypton-java-panel__metric-icon">&#9649;</span>
          <span class="krypton-java-panel__label">CPU</span>
          <span class="krypton-java-panel__value" data-field="cpu-text">--%</span>
        </div>
        <div class="krypton-java-panel__metric" data-field="rss">
          <span class="krypton-java-panel__metric-icon">&#9638;</span>
          <span class="krypton-java-panel__label">RSS</span>
          <span class="krypton-java-panel__value" data-field="rss-text">-- MB</span>
        </div>
      </div>
    `;

    let disposed = false;
    let statsPollInterval: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    /** Once the server is found, populate UI and start stats polling. */
    const onServerFound = (server: JavaServerInfo): void => {
      // Update top bar
      const mainClassEl = topBar.querySelector('[data-field="main-class"]');
      if (mainClassEl) {
        mainClassEl.textContent = `${server.main_class}  PID ${server.pid}  :${server.port}`;
      }

      // Start stats polling
      invoke<JavaStats>('get_java_stats', { pid: server.pid })
        .then((stats) => updateStatsBar(bottomBar, stats))
        .catch(() => {
          const heapText = bottomBar.querySelector('[data-field="heap-text"]');
          if (heapText) heapText.textContent = 'jstat unavailable — install JDK';
        });

      // Poll every 2s
      statsPollInterval = setInterval(async () => {
        if (disposed) return;
        try {
          const stats = await invoke<JavaStats>('get_java_stats', { pid: server.pid });
          updateStatsBar(bottomBar, stats);
        } catch {
          // Process may have exited
        }
      }, 2000);
    };

    /** Search for a java server with a listening port in the terminal's CWD. */
    let retryCount = 0;
    const maxRetries = 30;

    const tryFindServer = async (): Promise<void> => {
      if (disposed) return;
      try {
        const server = await invoke<JavaServerInfo | null>('find_java_server_by_cwd', {
          sessionId,
        });
        if (server && !disposed) {
          onServerFound(server);
          return;
        }
      } catch {
        // Command failed
      }

      // Not found yet — retry
      if (retryCount < maxRetries && !disposed) {
        retryCount++;
        retryTimer = setTimeout(tryFindServer, 2000);
      } else if (!disposed) {
        // Give up — show message
        const mainClassEl = topBar.querySelector('[data-field="main-class"]');
        if (mainClassEl) mainClassEl.textContent = 'No server port detected';
        const heapText = bottomBar.querySelector('[data-field="heap-text"]');
        if (heapText) heapText.textContent = 'No listening port found';
      }
    };

    tryFindServer();

    return [
      { element: topBar, position: 'top' },
      {
        element: bottomBar,
        position: 'top',
        dispose: () => {
          disposed = true;
          if (statsPollInterval !== null) clearInterval(statsPollInterval);
          if (retryTimer !== null) clearTimeout(retryTimer);
        },
      },
    ];
  },
};
