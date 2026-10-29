// Krypton — Rails verifier (spec 337): the dock's time, progress and state text.
//
// Shared by the Rails dock and its action states (spec 344). Times are local
// `HH:MM`, never relative ages, so nothing that paints them needs a timer.

import type { RailsProgress, RailsSnapshot } from './types';

/** Local `HH:MM` of an RFC 3339 string or epoch ms; `--:--` when unparseable. */
export function localHhMm(at: string | number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** `1 finding`, `3 findings`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Static head progress line; null when idle. */
export function progressText(progress: RailsProgress): string | null {
  switch (progress.kind) {
    case 'idle':
      return null;
    case 'checking':
      return `check ${progress.index}/${progress.total} ${progress.name}`;
    case 'judging':
      return 'judging';
    case 'paused':
      return 'auto run paused at trust';
    case 'clean-tree':
      return 'no changes to check';
    case 'busy':
      return 'busy (another harness)';
    case 'held':
      return `auto run held until ${localHhMm(progress.until)} · min interval`;
    case 'cooling':
      return `judge cooling until ${localHhMm(progress.until)}`;
    case 'error':
      return progress.message;
  }
}

/** A manifest that declares nothing: no `## Rails` bullets and no `[[check]]`. */
export function isEmptyManifest(snapshot: RailsSnapshot): boolean {
  return snapshot.present && snapshot.rules.length === 0 && snapshot.checks.length === 0;
}

export interface HeadState {
  readonly text: string;
  /** `accent`: in progress or waiting on the human; `ink`: plain information. */
  readonly tone: 'accent' | 'ink';
}

/**
 * Spec 345: the head's one state line — the first rule that applies. A run in
 * progress, then an error, then trust (which is why an auto run is `paused`),
 * then the other progress lines, the empty-manifest hint and warnings. The
 * texts are short enough for one line of the 352 px column at 16 px.
 */
export function headStateLine(snapshot: RailsSnapshot | null, progress: RailsProgress): HeadState | null {
  if (progress.kind === 'checking' || progress.kind === 'judging') {
    return { text: progressText(progress) ?? '', tone: 'accent' };
  }
  if (progress.kind === 'error') return { text: progress.message, tone: 'ink' };
  if (snapshot?.error) return { text: snapshot.error, tone: 'ink' };
  if (snapshot?.present && snapshot.trust !== 'trusted' && !isEmptyManifest(snapshot)) {
    const lead = snapshot.trust === 'changed' ? 'changed since trust' : 'not trusted';
    const count = snapshot.checks.length;
    const waiting = count > 0 ? `${plural(count, 'check')} wait${count === 1 ? 's' : ''}` : 'auto runs wait';
    return { text: `${lead} · ${waiting}`, tone: 'accent' };
  }
  const line = progressText(progress);
  if (line !== null) return { text: line, tone: 'accent' };
  if (snapshot && isEmptyManifest(snapshot)) return { text: 'no rails yet · #rails init', tone: 'ink' };
  if (snapshot && snapshot.warnings.length > 0) {
    return { text: plural(snapshot.warnings.length, 'manifest warning'), tone: 'ink' };
  }
  return null;
}
