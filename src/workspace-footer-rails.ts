import type { SignalValueMap } from './view-bus-types';

// spec 337: the Rails verifier footer segment. Each ACP harness publishes
// `system:rails` for its own project; the footer shows the worst state across
// all of them, so a failed check in a background harness still surfaces.
//
// Only a failed check is coloured — a fault under ADR-0017. Model findings stay
// neutral (ADR-0004): `RAILS 3` means "evidence to inspect", not "act on me".
// Static text only; nothing here pulses or animates.

export type RailsFooterSignalValue = SignalValueMap['system:rails'];
export type RailsFooterState = RailsFooterSignalValue['state'];

export type RailsFooterEntry = Pick<RailsFooterSignalValue, 'state' | 'findings' | 'failedCheck'>;

export interface RailsFooterView {
  readonly text: string;
  /** True only for `check_failed`. */
  readonly fault: boolean;
  readonly title: string;
}

/** Worst first wins. `none` never reaches the map; it is listed for totality. */
const RAILS_STATE_WEIGHT: Record<RailsFooterState, number> = {
  none: 0,
  clean: 1,
  running: 2,
  paused: 3,
  findings: 4,
  error: 5,
  check_failed: 6,
};

/**
 * The segment for a set of harness entries, or null when it must hide: no
 * entries, or every entry is `none`.
 *
 * - `check_failed`: `RAILS ✗ <check>`, `+N` when more harnesses failed too.
 * - `findings`: `RAILS <sum of findings over the harnesses reporting findings>`.
 * - `error` / `paused` / `running`: neutral short text.
 * - `clean`: `RAILS ✓`.
 */
export function railsFooterView(entries: Iterable<RailsFooterEntry>): RailsFooterView | null {
  let worst: RailsFooterState = 'none';
  let findings = 0;
  const failed: RailsFooterEntry[] = [];
  for (const entry of entries) {
    if (entry.state === 'none') continue;
    if (RAILS_STATE_WEIGHT[entry.state] > RAILS_STATE_WEIGHT[worst]) worst = entry.state;
    if (entry.state === 'findings') findings += entry.findings;
    if (entry.state === 'check_failed') failed.push(entry);
  }
  switch (worst) {
    case 'none':
      return null;
    case 'check_failed': {
      const first = failed[0]?.failedCheck ?? null;
      const more = failed.length > 1 ? ` +${failed.length - 1}` : '';
      return {
        text: `RAILS ✗${first ? ` ${first}` : ''}${more}`,
        fault: true,
        title:
          `Rails: check ${first ?? '(unknown)'} failed` +
          (failed.length > 1 ? ` (and ${failed.length - 1} more harness${failed.length > 2 ? 'es' : ''})` : '') +
          ' — see the Rails tab',
      };
    }
    case 'error':
      return { text: 'RAILS error', fault: false, title: 'Rails: the last run could not judge the tree — see the Rails tab' };
    case 'findings':
      return {
        text: `RAILS ${findings}`,
        fault: false,
        title: `Rails: ${findings} open finding${findings === 1 ? '' : 's'} — see the Rails tab`,
      };
    case 'paused':
      return { text: 'RAILS paused', fault: false, title: 'Rails: checks wait for #rails trust' };
    case 'running':
      return { text: 'RAILS …', fault: false, title: 'Rails: a run is in progress' };
    case 'clean':
      return { text: 'RAILS ✓', fault: false, title: 'Rails: clean' };
  }
}

const BASE_CLASS = 'krypton-workspace-footer__segment krypton-workspace-footer__segment--rails';

export class FooterRails {
  readonly el: HTMLElement;
  private readonly bySource = new Map<string, RailsFooterEntry>();

  constructor() {
    this.el = document.createElement('span');
    this.el.className = BASE_CLASS;
    this.el.hidden = true;
  }

  set(value: RailsFooterSignalValue): void {
    if (value.state === 'none') {
      this.bySource.delete(value.sourceId);
      return;
    }
    this.bySource.set(value.sourceId, {
      state: value.state,
      findings: value.findings,
      failedCheck: value.failedCheck,
    });
  }

  render(): void {
    const view = railsFooterView(this.bySource.values());
    if (!view) {
      this.el.hidden = true;
      this.el.className = BASE_CLASS;
      this.el.textContent = '';
      this.el.removeAttribute('title');
      return;
    }
    this.el.hidden = false;
    this.el.className = view.fault ? `${BASE_CLASS} krypton-workspace-footer__segment--rails-fault` : BASE_CLASS;
    this.el.textContent = view.text;
    this.el.title = view.title;
  }
}
