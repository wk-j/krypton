import type { BackendLinkState } from './view-bus-types';

/** spec 213: last known state of one off-machine backend. `off` never reaches
 *  here — the footer deletes the entry instead, so a switched-off backend leaves
 *  no trace in the footer at all. */
export interface BackendLinkEntry {
  label: string;
  baseUrl: string;
  project: string;
  state: Exclude<BackendLinkState, 'off'>;
  detail: string | null;
  latencyMs: number | null;
  checkedAt: number;
}

/** spec 213: severity order for picking which backend's state the single link
 *  segment shows when more than one backend is publishing. */
const BACKEND_LINK_WEIGHT: Record<Exclude<BackendLinkState, 'off'>, number> = {
  linked: 0,
  unauthorized: 1,
  offline: 2,
};

/** Latency is detail-density only — in compact the segment is a state word. */
export function linkLabel(entry: BackendLinkEntry, detail: boolean): string {
  if (entry.state === 'unauthorized') return `${entry.label} auth`;
  if (entry.state === 'offline') return `${entry.label} offline`;
  if (detail && entry.latencyMs !== null) {
    return `${entry.label} ${entry.latencyMs}ms`;
  }
  return entry.label;
}

/** The tooltip is where the fix lives: a segment can only carry a state, but
 *  a human who sees a fault needs to know which server and what to do. */
export function linkTooltip(entry: BackendLinkEntry): string {
  const where = `${entry.baseUrl || '(no base_url)'} · project ${entry.project || '(none)'}`;
  const checked = entry.checkedAt
    ? `checked ${new Date(entry.checkedAt * 1000).toLocaleTimeString()}`
    : 'not yet checked';
  const lines = [`${entry.label}: ${entry.state}`, where, checked];
  if (entry.detail) lines.push(entry.detail);
  if (entry.state === 'offline') {
    lines.push(`server unreachable at ${entry.baseUrl} — press ⌘P X to re-probe`);
  } else if (entry.state === 'unauthorized') {
    lines.push('token rejected — store a new one with #xenon token <token>');
  }
  return lines.join('\n');
}

export class FooterLink {
  readonly el: HTMLElement;
  /** spec 213: latest link report per off-machine backend, keyed by backendId.
   * `xenon` is the only publisher today; the map is what lets a second backend
   * arrive without touching the footer. An `off` state deletes its entry. */
  private linkByBackend = new Map<string, BackendLinkEntry>();

  constructor() {
    // spec 213: backend link indicator — whether the off-machine Xenon server
    // is actually reachable with our credential. Unlike the two depth gauges
    // above it IS coloured when faulted (ADR-0017): a broken link silently
    // fails every publish, which is demand on the human, not advisory depth.
    this.el = document.createElement('span');
    this.el.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--link';
    this.el.hidden = true;
  }

  set(backendId: string, state: BackendLinkState, rest: Omit<BackendLinkEntry, 'state'>): void {
    if (state === 'off') this.linkByBackend.delete(backendId);
    else this.linkByBackend.set(backendId, { ...rest, state });
  }

  /**
   * spec 213: render the backend link segment — is the off-machine server
   * actually reachable with our credential?
   *
   * Hidden entirely when no backend is configured, rather than shown greyed:
   * the footer's established idiom is to stay quiet about subsystems that are
   * switched off, not to advertise them. Coloured only when faulted (ADR-0017)
   * — a healthy link is ambient and must not compete with the attention gauge.
   * Static, like every other footer chip: no pulse, no animation.
   */
  render(detail: boolean): void {
    // One backend exists today; if a second ever publishes, the worst state
    // wins the segment, because that is the one the human has to act on.
    let worst: BackendLinkEntry | null = null;
    for (const entry of this.linkByBackend.values()) {
      if (!worst || BACKEND_LINK_WEIGHT[entry.state] > BACKEND_LINK_WEIGHT[worst.state]) {
        worst = entry;
      }
    }
    if (!worst) {
      this.el.hidden = true;
      this.el.replaceChildren();
      this.el.removeAttribute('title');
      return;
    }

    this.el.hidden = false;
    this.el.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--link ' +
      `krypton-workspace-footer__segment--link-${worst.state}`;

    const glyph = document.createElement('span');
    glyph.className = 'krypton-workspace-footer__link-glyph';
    glyph.textContent = '⇄';
    const label = document.createElement('span');
    label.textContent = linkLabel(worst, detail);
    this.el.replaceChildren(glyph, label);
    this.el.title = linkTooltip(worst);
  }
}
