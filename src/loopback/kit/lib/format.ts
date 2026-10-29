// Spec 341 — number, size and time formatting shared by every surface.

export function pad2(n: number): string {
  return String(Math.floor(Math.abs(n))).padStart(2, '0');
}

/** `1.4 KB`, `12 MB`; bytes below 1 KiB stay exact. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** `850ms`, `12.4s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${pad2(minutes % 60)}m`;
}

/** `just now`, `12s ago`, `5m ago`, `3h ago`, `2d ago`. */
export function formatAgo(at: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - at);
  if (delta < 5000) return 'just now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Local `HH:MM:SS`. */
export function formatClock(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local date + time in the viewer's locale (or `locale`). */
export function formatDateTime(at: number, locale?: string): string {
  return new Date(at).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Rewrite Rust-rendered `<time data-ts="<epoch ms or s>">` labels into the
 * viewer's locale. The server writes a UTC fallback, so a page without
 * script still reads correctly.
 */
export function localizeTimes(root: ParentNode, selector = 'time[data-ts]', locale?: string): void {
  for (const node of root.querySelectorAll<HTMLElement>(selector)) {
    const raw = Number(node.dataset.ts);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const ms = raw < 1e12 ? raw * 1000 : raw;
    node.textContent = formatDateTime(ms, locale);
    node.title = new Date(ms).toISOString();
  }
}

/** Case-insensitive AND match of every whitespace-separated term. */
export function matchesQuery(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack.toLowerCase();
  return terms.every((term) => text.includes(term));
}
