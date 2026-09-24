// Krypton — ACP Harness View: lane & backend identity.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Pure, side-effect-free
// derivations of a lane's presentation identity — backend label, logo symbol id,
// directive role bucket, accent colour. No DOM, no view state.

import type { AcpBackendDescriptor } from './types';

export const BACKEND_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  'pi-acp': 'Pi',
  droid: 'Droid',
  cursor: 'Cursor',
  junie: 'Junie',
  omp: 'OMP',
  copilot: 'Copilot',
  mimo: 'MiMo',
  cline: 'Cline',
};

/** Preferred add-lane picker order. Remaining installed backends follow by id. */
export const HARNESS_BACKEND_ORDER: readonly string[] = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'pi-acp',
];

export function harnessBackends(backends: AcpBackendDescriptor[]): AcpBackendDescriptor[] {
  const rank = (id: string): number => {
    const index = HARNESS_BACKEND_ORDER.indexOf(id);
    return index === -1 ? HARNESS_BACKEND_ORDER.length : index;
  };
  return backends
    .filter((backend) => backend.id !== 'gemini')
    .slice()
    .sort((a, b) => {
      const byPreferred = rank(a.id) - rank(b.id);
      if (byPreferred !== 0) return byPreferred;
      return a.id.localeCompare(b.id);
    });
}

export function backendLabel(backendId: string): string {
  return BACKEND_LABELS[backendId] ?? backendId.charAt(0).toUpperCase() + backendId.slice(1);
}

// spec 125 — lane-rail disambiguation helpers. Pure, side-effect-free
// derivations from data the schema already carries (HarnessLane.backendId,
// HarnessDirective.task / title). Exported so unit tests can exercise the
// table-driven mapping without spinning up a view.
export type DirectiveRoleBucket =
  | 'analysis'
  | 'review'
  | 'impl'
  | 'plan'
  | 'explore'
  | 'hash-1'
  | 'hash-2'
  | 'hash-3';

// djb2-style hash → 3 buckets. Stable across renders so two lanes with the
// same custom `task` always land in the same fallback color.
export function hashBucket(s: string): 'hash-1' | 'hash-2' | 'hash-3' {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const i = Math.abs(h) % 3;
  return i === 0 ? 'hash-1' : i === 1 ? 'hash-2' : 'hash-3';
}

// Patterns are checked in declaration order. Overlap is intentional: a
// directive titled "review-implementation" lands in `review`, not `impl`.
export function directiveRole(task: string): DirectiveRoleBucket {
  const t = task.trim().toLowerCase();
  if (!t) return hashBucket('');
  if (/\banaly|\bdiagnos/.test(t)) return 'analysis';
  if (/\breview/.test(t)) return 'review';
  if (/\bimplement|\bimpl|\bfix/.test(t)) return 'impl';
  if (/\bplan|\bdesign|\bspec/.test(t)) return 'plan';
  if (/\bexplor|\bsurvey|\bmap|\bresearch|\binvestigat/.test(t)) return 'explore';
  return hashBucket(t);
}

// Decoupled from `directiveRole()` so a `task = "refactor"` can hash to a
// stable color while the chip still reads "refactor", not the bucket id.
export function directiveTagLabel(task: string): string {
  const t = task.trim().toLowerCase();
  if (!t) return 'custom';
  if (/\banaly|\bdiagnos/.test(t)) return 'analysis';
  if (/\breview/.test(t)) return 'review';
  if (/\bimplement|\bimpl|\bfix/.test(t)) return 'impl';
  if (/\bplan|\bdesign|\bspec/.test(t)) return 'plan';
  if (/\bexplor|\bsurvey|\bmap|\bresearch|\binvestigat/.test(t)) return 'explore';
  return t;
}

export function backendLogoId(backendId: string): string {
  switch (backendId) {
    case 'claude':
      return 'krypton-logo-claude';
    case 'codex':
      return 'krypton-logo-codex';
    case 'opencode':
      return 'krypton-logo-opencode';
    case 'pi-acp':
      return 'krypton-logo-pi';
    case 'droid':
      return 'krypton-logo-droid';
    case 'cursor':
      return 'krypton-logo-cursor';
    case 'junie':
      return 'krypton-logo-junie';
    case 'omp':
      return 'krypton-logo-omp';
    case 'grok':
      return 'krypton-logo-grok';
    case 'copilot':
      return 'krypton-logo-copilot';
    case 'mimo':
      return 'krypton-logo-mimo';
    case 'cline':
      return 'krypton-logo-cline';
    default:
      return 'krypton-logo-omp';
  }
}

// Presentation-only: strips a single leading "<BackendLabel> " token so the
// rail does not echo the backend that the logo + lane name already say.
// Never mutates storage; the picker and peer_list still see the full title.
export function trimBackendPrefix(title: string, backendId: string): string {
  const label = BACKEND_LABELS[backendId];
  if (!label) return title;
  const prefix = label + ' ';
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

export function laneAccent(index: number): string {
  const accents = [
    'var(--krypton-window-accent, #0cf)',
    '#8effb0',
    '#ffd166',
    '#c77dff',
    '#ff6b8b',
    '#5fb3b3',
    '#ff9f1c',
    '#b18cff',
    '#4dd0ff',
    '#5ce6a8',
    '#7fa8ff',
    '#ff8552',
    '#56d6c0',
  ];
  return accents[(index - 1) % accents.length];
}

/** A lane identity color: `color` feeds `--acp-lane-accent`, `rgb` (a bare
 * `r, g, b` tuple or a var resolving to one) feeds the host window's
 * `--krypton-window-accent-rgb`. The first entry follows the active color
 * theme instead of a fixed hex; every entry is concrete (never the
 * self-referential `--krypton-window-accent`). */
export interface LaneAccentColor {
  color: string;
  rgb: string;
}

export const LANE_ACCENT_PALETTE: readonly LaneAccentColor[] = [
  { color: 'var(--krypton-focused-accent, #00ccff)', rgb: 'var(--krypton-accent-rgb, 0, 204, 255)' },
  { color: '#8effb0', rgb: '142, 255, 176' },
  { color: '#ffd166', rgb: '255, 209, 102' },
  { color: '#c77dff', rgb: '199, 125, 255' },
  { color: '#ff6b8b', rgb: '255, 107, 139' },
  { color: '#5fb3b3', rgb: '95, 179, 179' },
  { color: '#ff9f1c', rgb: '255, 159, 28' },
  { color: '#b18cff', rgb: '177, 140, 255' },
  { color: '#4dd0ff', rgb: '77, 208, 255' },
  { color: '#5ce6a8', rgb: '92, 230, 168' },
  { color: '#7fa8ff', rgb: '127, 168, 255' },
  { color: '#ff8552', rgb: '255, 133, 82' },
  { color: '#56d6c0', rgb: '86, 214, 192' },
];

/** Picks a random palette color no live lane is using. Falls back to the whole
 * palette once every color is taken (more lanes than colors). */
export function pickLaneAccent(
  inUse: readonly string[],
  random: () => number = Math.random,
): LaneAccentColor {
  const free = LANE_ACCENT_PALETTE.filter((entry) => !inUse.includes(entry.color));
  const pool = free.length > 0 ? free : LANE_ACCENT_PALETTE;
  return pool[Math.floor(random() * pool.length)];
}

export function laneAccentForLabel(label: string): string {
  if (/codex/i.test(label)) return laneAccent(1);
  if (/claude/i.test(label)) return laneAccent(2);
  if (/opencode/i.test(label)) return laneAccent(4);
  if (/^pi(-|$)/i.test(label)) return laneAccent(5);
  if (/droid/i.test(label)) return laneAccent(6);
  if (/cursor/i.test(label)) return laneAccent(7);
  if (/junie/i.test(label)) return laneAccent(8);
  if (/^omp(-|$)/i.test(label)) return laneAccent(9);
  if (/grok/i.test(label)) return laneAccent(10);
  if (/copilot/i.test(label)) return laneAccent(11);
  if (/mimo/i.test(label)) return laneAccent(12);
  if (/cline/i.test(label)) return laneAccent(13);
  const match = label.match(/-(\d+)$/);
  return match ? laneAccent(Number(match[1])) : 'var(--krypton-window-accent, #0cf)';
}
