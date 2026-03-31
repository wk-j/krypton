// Krypton — Profiler Metrics Collector
// Singleton that accumulates IPC timing, PTY throughput, agent latency,
// layout cost, FPS, and memory stats. Data is collected from app startup;
// the HUD reads snapshots on a 1-second interval.

export interface IpcRecord {
  command: string;
  startTime: number;
  duration: number;
  error: boolean;
}

export interface IpcAggregated {
  count: number;
  totalMs: number;
  maxMs: number;
  avgMs: number;
  errorCount: number;
}

export interface PtyThroughput {
  sessionId: number;
  bytesPerSecond: number;
  totalBytes: number;
}

export interface AgentTiming {
  promptText: string;
  startTime: number;
  timeToFirstToken: number | null;
  totalDuration: number | null;
  outputTokens: number;
}

export interface ProfilerSnapshot {
  timestamp: number;
  fps: number;
  heap: { usedMB: number; totalMB: number } | null;
  domNodes: number;
  ipc: {
    recent: IpcRecord[];
    aggregated: Map<string, IpcAggregated>;
  };
  pty: PtyThroughput[];
  agent: AgentTiming | null;
  layoutMs: number;
}

const IPC_RING_SIZE = 200;
const PTY_WINDOW_MS = 3000;

class MetricsCollector {
  // ─── IPC ──────────────────────────────────────────────────────────
  private ipcRing: IpcRecord[] = [];
  private ipcRingIndex = 0;
  private ipcCounters: Map<string, { count: number; totalMs: number; maxMs: number; errorCount: number }> = new Map();

  // ─── PTY ──────────────────────────────────────────────────────────
  private ptyTotalBytes: Map<number, number> = new Map();
  private ptyBytesWindow: Map<number, { timestamp: number; bytes: number }[]> = new Map();

  // ─── Agent ────────────────────────────────────────────────────────
  private currentAgent: AgentTiming | null = null;

  // ─── Layout ───────────────────────────────────────────────────────
  private _layoutMs = 0;
  private layoutStart_ = 0;

  // ─── FPS ──────────────────────────────────────────────────────────
  private frameTimes: number[] = [];
  private lastFrameTime = 0;
  private rafId: number | null = null;
  private fpsListeners = 0;

  // ─── IPC recording ────────────────────────────────────────────────

  recordIpc(command: string, duration: number, error: boolean): void {
    const record: IpcRecord = { command, startTime: performance.now(), duration, error };

    // Ring buffer
    if (this.ipcRing.length < IPC_RING_SIZE) {
      this.ipcRing.push(record);
    } else {
      this.ipcRing[this.ipcRingIndex] = record;
      this.ipcRingIndex = (this.ipcRingIndex + 1) % IPC_RING_SIZE;
    }

    // Running counters
    let c = this.ipcCounters.get(command);
    if (!c) {
      c = { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 };
      this.ipcCounters.set(command, c);
    }
    c.count++;
    c.totalMs += duration;
    if (duration > c.maxMs) c.maxMs = duration;
    if (error) c.errorCount++;
  }

  // ─── PTY recording ────────────────────────────────────────────────

  recordPtyBytes(sessionId: number, byteCount: number): void {
    const total = (this.ptyTotalBytes.get(sessionId) ?? 0) + byteCount;
    this.ptyTotalBytes.set(sessionId, total);

    let window = this.ptyBytesWindow.get(sessionId);
    if (!window) {
      window = [];
      this.ptyBytesWindow.set(sessionId, window);
    }
    window.push({ timestamp: performance.now(), bytes: byteCount });
  }

  removePtySession(sessionId: number): void {
    this.ptyTotalBytes.delete(sessionId);
    this.ptyBytesWindow.delete(sessionId);
  }

  // ─── Agent recording ──────────────────────────────────────────────

  agentPromptStart(promptText: string): void {
    this.currentAgent = {
      promptText: promptText.slice(0, 40),
      startTime: performance.now(),
      timeToFirstToken: null,
      totalDuration: null,
      outputTokens: 0,
    };
  }

  agentFirstToken(): void {
    if (this.currentAgent && this.currentAgent.timeToFirstToken === null) {
      this.currentAgent.timeToFirstToken = performance.now() - this.currentAgent.startTime;
    }
  }

  agentPromptEnd(outputTokens: number): void {
    if (this.currentAgent) {
      this.currentAgent.totalDuration = performance.now() - this.currentAgent.startTime;
      this.currentAgent.outputTokens = outputTokens;
    }
  }

  // ─── Layout recording ─────────────────────────────────────────────

  layoutStart(): void {
    this.layoutStart_ = performance.now();
  }

  layoutEnd(): void {
    this._layoutMs = performance.now() - this.layoutStart_;
  }

  // ─── FPS tracking ─────────────────────────────────────────────────

  startFps(): void {
    this.fpsListeners++;
    if (this.rafId !== null) return;
    this.lastFrameTime = performance.now();
    this.frameTimes = [];
    const tick = (now: number): void => {
      const dt = now - this.lastFrameTime;
      this.lastFrameTime = now;
      this.frameTimes.push(dt);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopFps(): void {
    this.fpsListeners--;
    if (this.fpsListeners <= 0) {
      this.fpsListeners = 0;
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }
  }

  // ─── Snapshot ─────────────────────────────────────────────────────

  getSnapshot(): ProfilerSnapshot {
    const now = performance.now();

    // FPS from frame times
    let fps = 0;
    if (this.frameTimes.length > 1) {
      const sum = this.frameTimes.reduce((a, b) => a + b, 0);
      fps = Math.round(1000 / (sum / this.frameTimes.length));
    }

    // Heap (Chromium only)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mem = (performance as any).memory;
    const heap = mem
      ? { usedMB: Math.round(mem.usedJSHeapSize / 1048576), totalMB: Math.round(mem.jsHeapSizeLimit / 1048576) }
      : null;

    // DOM nodes
    const domNodes = document.querySelectorAll('*').length;

    // IPC aggregated
    const aggregated = new Map<string, IpcAggregated>();
    for (const [cmd, c] of this.ipcCounters) {
      aggregated.set(cmd, {
        count: c.count,
        totalMs: c.totalMs,
        maxMs: c.maxMs,
        avgMs: c.count > 0 ? c.totalMs / c.count : 0,
        errorCount: c.errorCount,
      });
    }

    // PTY throughput — prune old entries and compute bytes/sec
    const pty: PtyThroughput[] = [];
    for (const [sid, window] of this.ptyBytesWindow) {
      // Prune entries older than the rolling window
      const cutoff = now - PTY_WINDOW_MS;
      while (window.length > 0 && window[0].timestamp < cutoff) {
        window.shift();
      }
      const windowBytes = window.reduce((sum, e) => sum + e.bytes, 0);
      const elapsed = window.length > 0 ? (now - window[0].timestamp) / 1000 : PTY_WINDOW_MS / 1000;
      pty.push({
        sessionId: sid,
        bytesPerSecond: elapsed > 0 ? windowBytes / elapsed : 0,
        totalBytes: this.ptyTotalBytes.get(sid) ?? 0,
      });
    }

    return {
      timestamp: now,
      fps,
      heap,
      domNodes,
      ipc: { recent: [...this.ipcRing], aggregated },
      pty,
      agent: this.currentAgent ? { ...this.currentAgent } : null,
      layoutMs: this._layoutMs,
    };
  }
}

export const collector = new MetricsCollector();
