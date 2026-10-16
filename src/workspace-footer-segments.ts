// Left + center zone segment builders for the workspace footer. Pure functions
// of their inputs: each returns a fresh element (or null when its datum is
// absent), so the caller's ordering IS the layout.
import { Mode } from './types';
import { programStatusSentence, type ProgramStatusSummary } from './program-status';
import type { SignalState } from './view-bus-types';
import { footerIcon, footerSegment } from './workspace-footer-dom';
import {
  abbreviatePath,
  composeRoleTitle,
  formatBytesPerSec,
  modeLabel,
  plural,
  progressText,
  type FocusedBusState,
  type FocusSummary,
} from './workspace-footer-format';

export function leftSegments(mode: Mode, summary: FocusSummary): HTMLElement[] {
  return [
    footerSegment(modeLabel(mode), mode === Mode.Normal ? 'mode mode-normal' : 'mode'),
    footerSegment(composeRoleTitle(summary.role, summary.title, summary.cwd), 'p0 role'),
  ];
}

/** Compose the center zone from independent per-datum segment builders. Each
 *  returns null when its datum is absent, so the order here IS the layout and
 *  nothing is entangled in a chain of ifs. */
export function centerSegments(
  summary: FocusSummary,
  gitText: string | null,
  busState: FocusedBusState,
  programStatus: ProgramStatusSummary | null,
): HTMLElement[] {
  return [
    workingDirSegment(summary.cwd),
    gitSegment(gitText),
    countsSegment(summary),
    processSegment(busState.process),
    throughputSegment(busState.throughput),
    progressSegment(busState.progress),
    stateSegment(busState.state),
    programStatusSegment(programStatus),
  ].filter((el): el is HTMLElement => el !== null);
}

/** Build the single canonical working-directory segment for the workspace
 *  footer. This is the ONE place the workspace renders the focused pane's cwd
 *  (the left title strips path tokens so it never duplicates this). Returns
 *  null when there is no cwd to show. */
export function workingDirSegment(cwd: string | null): HTMLElement | null {
  const abbreviated = abbreviatePath(cwd);
  if (!abbreviated) return null;
  const el = footerSegment(abbreviated, 'p1 project');
  const label = `working directory ${cwd}`;
  el.title = label;
  el.setAttribute('aria-label', label);
  return el;
}

/** Git ref + dirty marker for the focused pane's cwd. Null when not a repo. */
export function gitSegment(text: string | null): HTMLElement | null {
  if (!text) return null;
  const dirty = text.endsWith(' *');
  const ref = dirty ? text.slice(0, -2) : text;
  const el = footerSegment(ref, 'p1 git');
  el.prepend(footerIcon('branch'));
  if (dirty) {
    const dot = footerIcon('dot', 'fill dot');
    dot.classList.add('krypton-workspace-footer__git-dirty');
    el.append(dot);
  }
  const label = dirty ? `branch ${ref} — uncommitted changes` : `branch ${ref}`;
  el.title = label;
  el.setAttribute('aria-label', label);
  return el;
}

/** Compact window/tab/pane triplet with a layout icon. Null unless something
 *  is split (any count > 1) — a lone pane needs no counter. */
export function countsSegment(summary: FocusSummary): HTMLElement | null {
  if (summary.windows <= 1 && summary.tabs <= 1 && summary.panes <= 1) return null;
  const el = footerSegment(`${summary.windows}/${summary.tabs}/${summary.panes}`, 'p2 counts');
  el.prepend(footerIcon('layout'));
  const label = `${plural(summary.windows, 'window')} · ${plural(summary.tabs, 'tab')} · ${plural(summary.panes, 'pane')}`;
  el.title = label;
  el.setAttribute('aria-label', label);
  return el;
}

/** Foreground process name (+ pid) of the focused session. Null when unknown. */
export function processSegment(process: FocusedBusState['process']): HTMLElement | null {
  if (!process) return null;
  const { name, pid } = process;
  const el = footerSegment(name, 'p2 process');
  el.prepend(footerIcon('prompt'));
  if (pid !== null) {
    const pidEl = document.createElement('span');
    pidEl.className = 'krypton-workspace-footer__pid';
    pidEl.textContent = ` ${pid}`;
    el.append(pidEl);
  }
  const label = pid !== null ? `process ${name} · pid ${pid}` : `process ${name}`;
  el.title = label;
  el.setAttribute('aria-label', label);
  return el;
}

/** PTY throughput rate. Null when idle (0 B/s). */
export function throughputSegment(throughput: number): HTMLElement | null {
  if (throughput <= 0) return null;
  const rate = formatBytesPerSec(throughput);
  const el = footerSegment(rate, 'p3 throughput');
  el.prepend(footerIcon('io'));
  el.title = `throughput ${rate}`;
  el.setAttribute('aria-label', el.title);
  return el;
}

/** OSC progress percentage / indeterminate marker. Null when no progress. */
export function progressSegment(progressState: FocusedBusState['progress']): HTMLElement | null {
  const progress = progressText(progressState);
  if (!progress) return null;
  const el = footerSegment(progress, 'p3 detail');
  el.title = `progress ${progress}`;
  el.setAttribute('aria-label', el.title);
  return el;
}

/** Signal state (busy/warn/err/…) as a coloured dot + word. Null when normal.
 *  Tagged via data-state so CSS colours it by meaning, not the flat p3 tier. */
export function stateSegment(state: SignalState): HTMLElement | null {
  if (state === 'normal') return null;
  const el = footerSegment(state, 'p3 detail state');
  el.dataset.state = state;
  el.prepend(footerIcon('dot', 'fill dot'));
  el.title = `state: ${state}`;
  el.setAttribute('aria-label', el.title);
  return el;
}

/** spec 284: the focused pane's OSC 7501 summary as `app: message`. Detail
 *  density only; null when the pane has no records or is idle. */
export function programStatusSegment(status: ProgramStatusSummary | null): HTMLElement | null {
  if (!status || status.state === 'idle') return null;
  const sentence = programStatusSentence(status);
  const el = footerSegment(status.app ? `${status.app}: ${sentence}` : sentence, 'p3 detail program');
  el.dataset.state = status.state;
  el.title = `program status: ${status.state} — ${sentence}`;
  el.setAttribute('aria-label', el.title);
  return el;
}
