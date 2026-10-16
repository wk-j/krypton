// Pure text helpers for the workspace footer (spec 121). No DOM state, no
// instance state — everything here is a function of its arguments (plus the
// process HOME for path abbreviation), so it is unit-testable in isolation.
import { Mode, ProgressState, type PaneContentType } from './types';
import type { SignalSource, SignalState, ViewAddress } from './view-bus-types';

export type FooterRole = PaneContentType | 'quick_terminal' | null;

export interface FocusSummary {
  viewId: string | null;
  role: FooterRole;
  title: string;
  cwd: string | null;
  windows: number;
  tabs: number;
  panes: number;
}

export interface FocusedBusState {
  state: SignalState;
  throughput: number;
  process: { name: string; pid: number | null } | null;
  progress: { state: ProgressState; pct: number | null } | null;
}

export function isViewSource(source: SignalSource): source is ViewAddress {
  return 'viewId' in source;
}

export function abbreviatePath(path: string | null): string | null {
  if (!path) return null;
  const home = getHomePath();
  if (home && path === home) return '~';
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  const userHomeMatch = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (userHomeMatch) return `~${userHomeMatch[1] ?? ''}`;
  return path;
}

/** True when a title token is the shell's rendering of `cwd` — exact, or an
 *  abbreviated form like `~/S/krypton` for `~/Source/krypton` (each leading
 *  path segment a prefix of the real one, last segment equal). Matching against
 *  the actual cwd means we drop only the duplicated working directory, never an
 *  unrelated path argument such as the `/tmp/a` in a "vim /tmp/a" title. */
export function tokenIsCwd(token: string, cwd: string | null): boolean {
  if (!cwd) return false;
  const segs = (p: string): string[] => p.replace(/\/+$/, '').split('/');
  const tok = segs(token);
  if (tok.length === 0) return false;
  for (const cand of [cwd, abbreviatePath(cwd) ?? cwd]) {
    const ref = segs(cand);
    if (ref.length !== tok.length) continue;
    const matches = tok.every((t, i) => {
      const a = t.toLowerCase();
      const b = ref[i].toLowerCase();
      return i === tok.length - 1 ? a === b : b.startsWith(a);
    });
    if (matches) return true;
  }
  return false;
}

/** Drop the shell-embedded cwd from a terminal title so it isn't duplicated with
 *  the center CWD segment, keeping everything else (command names, real path
 *  arguments, decorative separators like the `//` in "MD // foo"). */
export function stripCwdToken(title: string, cwd: string | null): string {
  return title
    .split(/\s+/)
    .filter((token) => token.length > 0 && !tokenIsCwd(token, cwd))
    .join(' ')
    .trim();
}

export function getHomePath(): string | null {
  const envHome = (globalThis as unknown as { process?: { env?: { HOME?: string } } }).process?.env?.HOME;
  return envHome ?? null;
}

export function formatBytesPerSec(value: number): string {
  if (value < 1000) return `${value}B/s`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K/s`;
  return `${(value / 1_000_000).toFixed(1)}M/s`;
}

export function modeLabel(mode: Mode): string {
  return mode.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

export function roleLabel(role: FocusSummary['role']): string {
  if (!role) return 'no focus';
  if (role === 'quick_terminal') return 'quick terminal';
  return role;
}

/** Compose the left "role + title" label, dropping the role prefix when the
 *  title already names the same kind of view — otherwise content views whose
 *  title IS the view name double up (e.g. role `acp_harness` + title
 *  "ACP Harness" → "acp_harness ACP Harness"). The shell-embedded cwd is
 *  stripped from the title first so it isn't duplicated with the CWD segment. */
export function composeRoleTitle(role: FocusSummary['role'], rawTitle: string, cwd: string | null): string {
  const roleText = roleLabel(role);
  const title = stripCwdToken(rawTitle, cwd);
  if (!title) return roleText;
  const norm = (s: string): string => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  const nRole = norm(roleText);
  const nTitle = norm(title);
  // Title equals or extends the role name → it already conveys the kind.
  if (nTitle === nRole || nTitle.startsWith(`${nRole} `)) return title;
  return `${roleText} ${title}`.trim();
}

export function progressText(progress: FocusedBusState['progress']): string | null {
  if (!progress || progress.state === ProgressState.Hidden) return null;
  if (progress.pct !== null) return `${Math.round(progress.pct)}%`;
  if (progress.state === ProgressState.Indeterminate) return '…';
  return null;
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Contextual key hint for the right zone: mode first, then the focused role,
 *  then whether the music mini player is active. */
export function hintFor(mode: Mode, role: FooterRole, musicOn: boolean): string {
  if (mode === Mode.Compositor) return 'n new · h/j/k/l focus · ? details';
  if (mode === Mode.Resize || mode === Mode.Move || mode === Mode.Swap) return 'arrows adjust · Esc cancel';
  if (mode === Mode.CommandPalette || mode === Mode.Dashboard || mode === Mode.PromptDialog || mode === Mode.QuickFileSearch) return 'Esc close';
  if (role === 'acp_harness') return 'Cmd+P lanes · #cancel running';
  if (musicOn) return 'Cmd+Shift+M music';
  return 'Leader v select · Cmd+O files · Cmd+Shift+G git';
}

/** Spec 236: leading token of a ` · `-separated hint part that is a key. */
const HINT_KEY_RE =
  /^(?:Leader|Esc|arrows|h\/j\/k\/l|#\w+|\?|Cmd(?:\+[A-Za-z]+)+|[a-z])$/;

export interface HintChip {
  key: string | null;
  rest: string;
}

/** Split a footer hint into key chips + trailing labels. Parts with no
 *  leading key stay `{ key: null, rest: part }`. */
export function parseHint(text: string): HintChip[] {
  return text.split(' · ').map((part) => {
    const trimmed = part.trim();
    const space = trimmed.indexOf(' ');
    const first = space === -1 ? trimmed : trimmed.slice(0, space);
    if (!HINT_KEY_RE.test(first)) return { key: null, rest: part };
    return { key: first, rest: space === -1 ? '' : trimmed.slice(space + 1) };
  });
}

export function fillHint(el: HTMLElement, text: string): void {
  el.replaceChildren();
  parseHint(text).forEach((chip, i) => {
    if (i > 0) el.append(document.createTextNode(' · '));
    if (!chip.key) {
      el.append(document.createTextNode(chip.rest));
      return;
    }
    const kbd = document.createElement('kbd');
    kbd.textContent = chip.key;
    el.append(kbd);
    if (chip.rest) el.append(document.createTextNode(` ${chip.rest}`));
  });
}
