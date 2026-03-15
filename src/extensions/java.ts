// Krypton — Java Resource Monitor Extension
// Shows JVM heap, GC stats, CPU, and RSS for Java server processes.
// Uses process tree ownership: only shows java processes that are
// descendants of the terminal's shell PID.

import { invoke } from '@tauri-apps/api/core';
import type { ContextExtension, ExtensionWidget, JavaServerInfo, JavaStats, ProcessInfo, SessionId } from '../types';

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

/** Create a server row element for the top bar. */
function createServerRow(server: JavaServerInfo): HTMLElement {
  const row = document.createElement('div');
  row.className = 'krypton-extension-bar__server';
  row.dataset.pid = String(server.pid);
  row.innerHTML = `
    <span class="krypton-extension-bar__label">JAVA</span>
    <span class="krypton-extension-bar__content">${server.main_class}</span>
    <span class="krypton-extension-bar__stat">PID ${server.pid}</span>
    <span class="krypton-extension-bar__stat">:${server.port}</span>
  `;
  return row;
}

export const javaExtension: ContextExtension = {
  name: 'java-monitor',
  description: 'JVM resource monitor — heap, GC, CPU, memory',
  processNames: ['java'],

  createWidgets(_process: ProcessInfo, sessionId: SessionId): ExtensionWidget[] {
    // ── Top bar: shows server identities once found ──
    const topBar = document.createElement('div');
    topBar.className = 'krypton-extension-bar krypton-extension-bar--accent';
    topBar.innerHTML = `
      <span class="krypton-extension-bar__label">JAVA</span>
      <span class="krypton-extension-bar__content" data-field="main-class">Searching for server...</span>
    `;

    // ── Bottom panel: graphical resource stats (for primary server) ──
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
    /** PID of the primary server whose stats are shown in the bottom panel */
    let primaryPid: number | null = null;

    /** Once servers are found, populate top bar and start stats polling. */
    const onServersFound = (servers: JavaServerInfo[]): void => {
      // Replace the "Searching..." placeholder with server rows
      topBar.innerHTML = '';
      for (const server of servers) {
        topBar.appendChild(createServerRow(server));
      }

      // Use the first server as primary for the bottom stats panel
      primaryPid = servers[0].pid;

      // Initial stats fetch
      invoke<JavaStats>('get_java_stats', { pid: primaryPid })
        .then((stats) => updateStatsBar(bottomBar, stats))
        .catch(() => {
          const heapText = bottomBar.querySelector('[data-field="heap-text"]');
          if (heapText) heapText.textContent = 'jstat unavailable — install JDK';
        });

      // Poll every 2s — stats for primary, re-discover servers periodically
      let pollCount = 0;
      statsPollInterval = setInterval(async () => {
        if (disposed) return;
        pollCount++;

        // Poll stats for primary server
        if (primaryPid !== null) {
          try {
            const stats = await invoke<JavaStats>('get_java_stats', { pid: primaryPid });
            updateStatsBar(bottomBar, stats);
          } catch {
            // Process may have exited — will be caught by re-discovery below
          }
        }

        // Re-discover servers every 5th poll (10s) to catch new/exited servers
        if (pollCount % 5 === 0) {
          try {
            const freshServers = await invoke<JavaServerInfo[]>(
              'find_java_server_for_session',
              { sessionId },
            );
            if (freshServers.length > 0 && !disposed) {
              // Update top bar rows
              topBar.innerHTML = '';
              for (const server of freshServers) {
                topBar.appendChild(createServerRow(server));
              }
              // Switch primary if the current one is gone
              const primaryStillAlive = freshServers.some((s) => s.pid === primaryPid);
              if (!primaryStillAlive) {
                primaryPid = freshServers[0].pid;
              }
            }
          } catch {
            // Discovery failed — keep showing current data
          }
        }
      }, 2000);
    };

    /** Search for java servers in the terminal's process tree. */
    let retryCount = 0;
    const maxRetries = 30;

    const tryFindServers = async (): Promise<void> => {
      if (disposed) return;
      try {
        const servers = await invoke<JavaServerInfo[]>(
          'find_java_server_for_session',
          { sessionId },
        );
        if (servers.length > 0 && !disposed) {
          onServersFound(servers);
          return;
        }
      } catch {
        // Command failed
      }

      // Not found yet — retry
      if (retryCount < maxRetries && !disposed) {
        retryCount++;
        retryTimer = setTimeout(tryFindServers, 2000);
      } else if (!disposed) {
        // Give up — show message
        const mainClassEl = topBar.querySelector('[data-field="main-class"]');
        if (mainClassEl) mainClassEl.textContent = 'No server port detected';
        const heapText = bottomBar.querySelector('[data-field="heap-text"]');
        if (heapText) heapText.textContent = 'No listening port found';
      }
    };

    tryFindServers();

    return [
      { element: topBar, position: 'top' },
      {
        element: bottomBar,
        position: 'bottom',
        dispose: () => {
          disposed = true;
          if (statsPollInterval !== null) clearInterval(statsPollInterval);
          if (retryTimer !== null) clearTimeout(retryTimer);
        },
      },
    ];
  },
};
