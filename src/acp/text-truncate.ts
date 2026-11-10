// Krypton — one-line text bounds shared by the harness and the lane decoder.
//
// Pure: no Tauri imports, so the spec 380 decoder stays runnable in a browser
// (spec 381). `harness-format.ts` re-exports both functions.

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function truncateInline(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
