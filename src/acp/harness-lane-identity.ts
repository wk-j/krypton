// Krypton — ACP Harness View: lane & backend identity.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Pure, side-effect-free
// derivations of a lane's presentation identity — backend label, logo symbol id,
// directive role bucket, accent colour. No DOM, no view state.

import type { AcpBackendDescriptor } from './types';

export const BACKEND_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
  'pi-acp': 'Pi',
  droid: 'Droid',
  cursor: 'Cursor',
  junie: 'Junie',
  omp: 'OMP',
  grok: 'Grok',
  copilot: 'Copilot',
  mimo: 'MiMo',
  cline: 'Cline',
};

export function harnessBackends(backends: AcpBackendDescriptor[]): AcpBackendDescriptor[] {
  return backends.filter((backend) => backend.id !== 'gemini');
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
