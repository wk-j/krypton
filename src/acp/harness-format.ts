// Krypton — ACP Harness View: formatting & parsing primitives.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Leaf helpers with no
// view state: string/path/time formatting, HTML escaping, and untrusted-payload
// parsing shared by the render helpers and the view class.

import { invoke } from '@tauri-apps/api/core';

import type {
  AcpSessionCapabilities,
  AcpSessionInfo,
  AgentInitInfo,
  ReviewFinding,
} from './types';
import type { LaneActivity } from './harness-view-types';

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function truncateInline(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function abbreviatePath(path: string): string {
  const home = getHomeLikePrefix();
  const p = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `${p.startsWith('~') ? '~/' : '/'}.../${parts.slice(-2).join('/')}`;
}

export function pathToFileUri(path: string): string {
  if (path.startsWith('file://')) return path;
  return `file://${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

let cachedHomeDir: string | null = null;
let homeDirLoad: Promise<string | null> | null = null;

export function loadHomeDir(): Promise<string | null> {
  if (cachedHomeDir) return Promise.resolve(cachedHomeDir);
  if (!homeDirLoad) {
    homeDirLoad = invoke<string | null>('get_env_var', { name: 'HOME' })
      .then((value) => {
        const trimmed = value ? value.replace(/\/+$/, '') : null;
        cachedHomeDir = trimmed || null;
        return cachedHomeDir;
      })
      .catch(() => null);
  }
  return homeDirLoad;
}

export function getHomeLikePrefix(): string | null {
  if (cachedHomeDir) return cachedHomeDir;
  const match = location.pathname.match(/^\/Users\/[^/]+/);
  return match ? match[0] : null;
}

export function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** spec 156: activity segment of the busy chip. Tool titles are hard-truncated
 *  so a full-path title cannot push the chip past one line. */
export function formatLaneActivity(activity: LaneActivity): string {
  if (activity.kind === 'thinking') return 'thinking…';
  if (activity.kind === 'writing') return 'writing…';
  return `⚒ ${truncate(activity.label, 32)}`;
}

export function formatShortTime(epochMs: number): string {
  const age = Date.now() - epochMs;
  if (age >= 0 && age < 24 * 60 * 60 * 1000) return `${formatAge(age)} ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** spec 146: review matrix round timestamp — clock time today, else "Mon D · HH:MM". */
export function formatReviewRoundTime(epochMs: number): string {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${time}`;
}

/** Parse optional review_outcome findings from the acp-review-outcome event payload.
 * Untrusted IPC input — all-or-nothing: one malformed item rejects the whole array. */
export function parseReviewFindings(raw: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const findings: ReviewFinding[] = [];
  for (const item of raw) {
    const finding = parseReviewFindingItem(item);
    if (!finding) return undefined;
    findings.push(finding);
  }
  return findings;
}

export function parseReviewFindingItem(item: unknown): ReviewFinding | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const file = typeof obj.file === 'string' ? obj.file.trim() : '';
  if (!file) return null;
  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  if (!note) return null;
  const severity = obj.severity;
  if (severity !== 'blocking' && severity !== 'non-blocking' && severity !== 'suggestion') return null;
  const finding: ReviewFinding = { file, severity, note };
  if (obj.line !== undefined) {
    const line = obj.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
    finding.line = line;
  }
  return finding;
}

export function formatSessionUpdatedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return formatShortTime(ms);
}

export function normalizePathForCompare(value: string): string {
  return value.replace(/\/+$/, '');
}

export function filterSessionsForProject(sessions: AcpSessionInfo[], projectDir: string | null): AcpSessionInfo[] {
  if (!projectDir) return sessions;
  const project = normalizePathForCompare(projectDir);
  return sessions.filter((session) => !session.cwd || normalizePathForCompare(session.cwd) === project);
}

export function sessionCapabilitiesFromAgent(caps: AgentInitInfo['agent_capabilities']): AcpSessionCapabilities {
  const sessionCaps = caps.sessionCapabilities;
  return {
    canList: Boolean(sessionCaps?.list),
    canResume: Boolean(sessionCaps?.resume),
    canLoad: caps.loadSession === true,
  };
}

export function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 8);
}

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatCpu(pct: number): string {
  if (!Number.isFinite(pct)) return '--';
  if (pct >= 100) return `${pct.toFixed(0)}%`;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  return `${pct.toFixed(1)}%`;
}

export function formatRss(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${mb.toFixed(0)}M`;
}

export function formatCoarseAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  if (ms < 5 * 60_000) return '1m+';
  if (ms < 15 * 60_000) return '5m+';
  return '15m+';
}
