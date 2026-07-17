// Krypton — Subscription Credit Usage View (spec 151)
// Read-only gauges for provider subscription quotas. Payloads and polling come
// from the shared UsageStore so this detailed view and window chrome consume
// one provider snapshot/timer.
//
// Layout: one flat widget per provider on a responsive grid (side by side
// in wide windows, stacked in narrow ones). Each widget is a single
// surface — full border + background tint, no inner boxes.

import type { ContentView, PaneContentType } from './types';
import type { PaletteAction } from './palette-types';
import {
  codexWindowLabel,
  usageStore,
  type CodexWindow,
  type CopilotQuota,
  type UsageProvider,
  type UsageWindow,
} from './usage-store';

/** Static error sentinels from the Rust side, mapped to display hints. */
const ERROR_HINTS: Record<string, string> = {
  'not-connected': 'not connected',
  'usage-scope-missing': 'Claude login lacks user:profile scope — usage unavailable',
  'rate-limited': 'rate limited — retrying next cycle',
  'no-recent-data': 'no recent data — run codex once',
  'unexpected-response': 'unexpected response — retrying next cycle',
  'network-error': 'fetch failed — retrying next cycle',
};

/** `token-expired` names the PROVIDER's own credential, so the remedy must be
 *  provider-specific — each CLI owns its token refresh (claude OAuth,
 *  ~/.config/github-copilot, ~/.cursor/cli-config.json, ~/.grok/auth.json). */
const TOKEN_EXPIRED_HINTS: Record<UsageProvider, string> = {
  claude: 'token expired — open a Claude lane or run claude to refresh',
  codex: 'token expired — run codex to refresh',
  copilot: 'token expired — sign in to GitHub Copilot again to refresh',
  cursor: 'token expired — run cursor-agent login to refresh',
  grok: 'token expired — run grok to refresh',
};

/** Widget freshness states — dot color is always paired with the foot text. */
type WidgetState = 'loading' | 'ok' | 'stale' | 'off';

// Provider marks. Geometry mirrors BACKEND_LOGO_SVG_DEFS in
// src/acp/acp-harness-view.ts (spec 125) — keep in sync if iterated; not
// imported from there so this lazy chunk stays free of the harness module.
// currentColor strokes/fills so CSS recolors them like any glyph.
const PROVIDER_LOGOS: Record<string, string> = {
  claude:
    '<svg class="krypton-usage__logo" viewBox="0 0 16 16" aria-hidden="true">' +
    '<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none">' +
    '<line x1="8" y1="2" x2="8" y2="14"/>' +
    '<line x1="2" y1="8" x2="14" y2="8"/>' +
    '<line x1="3.8" y1="3.8" x2="12.2" y2="12.2"/>' +
    '<line x1="3.8" y1="12.2" x2="12.2" y2="3.8"/>' +
    '</g></svg>',
  codex:
    '<svg class="krypton-usage__logo" viewBox="0 0 16 16" aria-hidden="true">' +
    '<polygon points="8,1.6 13.6,5 13.6,11 8,14.4 2.4,11 2.4,5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="1.6" fill="currentColor"/>' +
    '</svg>',
  copilot:
    '<svg class="krypton-usage__logo" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M8 5 V3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '<rect x="2.5" y="5" width="11" height="7.4" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<ellipse cx="6.2" cy="8.7" rx="0.95" ry="1.5" fill="currentColor"/>' +
    '<ellipse cx="9.8" cy="8.7" rx="0.95" ry="1.5" fill="currentColor"/>' +
    '</svg>',
  cursor:
    '<svg class="krypton-usage__logo" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M3 2 L13 8.5 L8.4 9.4 L10.7 13.8 L9.2 14.6 L6.9 10.2 L4 12.5 Z" fill="currentColor"/>' +
    '</svg>',
  // grok/xai: angular bolt — mirrors krypton-logo-grok in acp-harness-view.ts.
  grok:
    '<svg class="krypton-usage__logo" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M9.2 1.5 L3.8 8.8 H6.9 L5.8 14.5 L12.2 6.6 H8.8 Z" fill="currentColor"/>' +
    '</svg>',
};

function errorHint(err: unknown, provider: UsageProvider): string {
  const key = String(err);
  // "rate-limited:<epochMs>" — Retry-After deadline from the backend. Foot
  // closures re-evaluate this every tick, so the countdown stays live.
  if (key.startsWith('rate-limited:')) {
    const until = Number(key.slice('rate-limited:'.length));
    if (Number.isFinite(until) && until > Date.now()) {
      return `rate limited — retry in ${formatCountdown(until)}`;
    }
    return ERROR_HINTS['rate-limited'];
  }
  if (key === 'token-expired') return TOKEN_EXPIRED_HINTS[provider];
  return ERROR_HINTS[key] ?? `fetch failed (${key}) — retrying next cycle`;
}

/** "2h 14m" / "4d 02h" style countdown to an epoch-ms target. */
function formatCountdown(targetMs: number): string {
  const delta = Math.max(0, targetMs - Date.now());
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${String(hours % 24).padStart(2, '0')}h`;
}

function formatAge(sinceMs: number): string {
  const secs = Math.floor((Date.now() - sinceMs) / 1_000);
  if (secs < 60) return `${Math.max(0, secs)}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Subscription credit usage — one flat widget per provider, gauges only. */
export class UsageContentView implements ContentView {
  readonly type: PaneContentType = 'usage';
  readonly element: HTMLElement;

  private body: HTMLElement;
  private readonly providers: readonly UsageProvider[] = ['claude', 'codex', 'copilot', 'cursor', 'grok'];
  /** Text nodes re-rendered by the 1 s tick (countdowns + data ages). */
  private liveTexts: Array<{ el: HTMLElement; text: () => string }> = [];
  private unsubscribe: (() => void) | null = null;
  private tickTimer: number | null = null;
  private closeCallback: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'krypton-usage';
    this.element.tabIndex = 0;
    container.appendChild(this.element);

    this.body = document.createElement('div');
    this.body.className = 'krypton-usage__body';
    this.element.appendChild(this.body);

    const hints = document.createElement('div');
    hints.className = 'krypton-usage__hints';
    hints.textContent = 'r refresh · j/k scroll · q close';
    this.element.appendChild(hints);

    this.unsubscribe = usageStore.subscribe(this.providers, () => this.render());
    this.render();
    this.tickTimer = window.setInterval(() => this.tick(), 1_000);
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  private async refresh(): Promise<void> {
    await usageStore.refresh(this.providers);
  }

  // ─── Rendering ────────────────────────────────────────────

  private render(): void {
    this.liveTexts = [];
    this.body.innerHTML = '';
    this.body.appendChild(this.renderClaude());
    this.body.appendChild(this.renderCodex());
    this.body.appendChild(this.renderCopilot());
    this.body.appendChild(this.renderCursor());
    this.body.appendChild(this.renderGrok());
  }

  /** One provider widget: head (logo + name + meta + dot), rows, foot line. */
  private widget(name: string, meta: string, state: WidgetState): HTMLElement {
    const widget = document.createElement('section');
    widget.className = 'krypton-usage__widget';

    const head = document.createElement('div');
    head.className = 'krypton-usage__head';

    const logo = PROVIDER_LOGOS[name];
    if (logo) head.insertAdjacentHTML('beforeend', logo);

    const title = document.createElement('span');
    title.className = 'krypton-usage__name';
    title.textContent = name;

    const metaEl = document.createElement('span');
    metaEl.className = 'krypton-usage__meta';
    metaEl.textContent = meta;

    const dot = document.createElement('span');
    dot.className = `krypton-usage__dot krypton-usage__dot--${state}`;

    head.appendChild(title);
    head.appendChild(metaEl);
    head.appendChild(dot);
    widget.appendChild(head);
    return widget;
  }

  /** Foot status line — always restates the dot state in words. */
  private foot(widget: HTMLElement, kind: WidgetState, text: () => string): void {
    const foot = document.createElement('div');
    foot.className = `krypton-usage__foot krypton-usage__foot--${kind}`;
    foot.textContent = text();
    this.liveTexts.push({ el: foot, text });
    widget.appendChild(foot);
  }

  private note(widget: HTMLElement, text: string): void {
    const note = document.createElement('div');
    note.className = 'krypton-usage__note';
    note.textContent = text;
    widget.appendChild(note);
  }

  /** Three placeholder rows shown before the first payload arrives. */
  private skeleton(widget: HTMLElement, rows: number): void {
    for (let i = 0; i < rows; i++) {
      const row = document.createElement('div');
      row.className = 'krypton-usage__gauge';
      const label = document.createElement('span');
      label.className = 'krypton-usage__label krypton-usage__skeleton';
      const bar = document.createElement('div');
      bar.className = 'krypton-usage__bar krypton-usage__skeleton';
      row.appendChild(label);
      row.appendChild(bar);
      widget.appendChild(row);
    }
  }

  private gauge(widget: HTMLElement, label: string, pct: number, resetMs: number | null): void {
    const row = document.createElement('div');
    row.className = 'krypton-usage__gauge';

    const level = pct >= 95 ? 'critical' : pct >= 80 ? 'warn' : null;

    const labelEl = document.createElement('span');
    labelEl.className = 'krypton-usage__label';
    labelEl.textContent = label;

    const bar = document.createElement('div');
    bar.className = 'krypton-usage__bar';
    const fill = document.createElement('div');
    fill.className = 'krypton-usage__fill';
    if (level) fill.classList.add(`krypton-usage__fill--${level}`);
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    bar.appendChild(fill);

    const pctEl = document.createElement('span');
    pctEl.className = 'krypton-usage__pct';
    if (level) pctEl.classList.add(`krypton-usage__pct--${level}`);
    pctEl.textContent = `${Math.round(pct)}%`;

    const resetEl = document.createElement('span');
    resetEl.className = 'krypton-usage__reset';
    if (resetMs !== null) {
      const text = () => `resets ${formatCountdown(resetMs)}`;
      resetEl.textContent = text();
      this.liveTexts.push({ el: resetEl, text });
    }

    row.appendChild(labelEl);
    row.appendChild(bar);
    row.appendChild(pctEl);
    row.appendChild(resetEl);
    widget.appendChild(row);
  }

  private renderClaude(): HTMLElement {
    const state = usageStore.get('claude');
    const u = state.data;
    const metaParts: string[] = [];
    if (u?.subscriptionType) metaParts.push(u.subscriptionType);
    if (u?.rateLimitTier) metaParts.push(u.rateLimitTier.replace(/^default_claude_/, ''));

    const widgetState: WidgetState = state.pending
      ? 'loading'
      : u
        ? state.error
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('claude', metaParts.join(' · '), widgetState);

    if (u) {
      const isoMs = (w: UsageWindow): number | null =>
        w.resetsAt ? Date.parse(w.resetsAt) : null;
      this.gauge(widget, 'session 5h', u.fiveHour.utilization, isoMs(u.fiveHour));
      this.gauge(widget, 'week', u.sevenDay.utilization, isoMs(u.sevenDay));
      if (u.sevenDayOpus) {
        this.gauge(widget, 'week · opus', u.sevenDayOpus.utilization, isoMs(u.sevenDayOpus));
      }
      if (u.sevenDaySonnet) {
        this.gauge(widget, 'week · sonnet', u.sevenDaySonnet.utilization, isoMs(u.sevenDaySonnet));
      }
      for (const scoped of u.weeklyScoped) {
        this.gauge(widget, `week · ${scoped.name.toLowerCase()}`, scoped.utilization, isoMs(scoped));
      }
      if (u.extraUsage?.isEnabled) {
        const used = u.extraUsage.usedCredits ?? 0;
        const limit = u.extraUsage.monthlyLimit;
        this.note(
          widget,
          `extra credits $${used.toFixed(2)}${limit !== null ? ` / $${limit.toFixed(2)}` : ''}`,
        );
      }
      const error = state.error;
      if (error) {
        this.foot(widget, 'stale', () => `stale · ${formatAge(u.fetchedAt)} — ${errorHint(error, 'claude')}`);
      } else {
        this.foot(widget, 'ok', () => `live · updated ${formatAge(u.fetchedAt)}`);
      }
    } else if (state.pending) {
      this.skeleton(widget, 3);
      this.foot(widget, 'loading', () => 'connecting…');
    } else {
      const error = state.error;
      this.foot(widget, 'off', () => (error ? errorHint(error, 'claude') : 'not connected'));
    }
    return widget;
  }

  private renderCodex(): HTMLElement {
    const state = usageStore.get('codex');
    const u = state.data;
    const metaParts: string[] = [];
    if (u?.planType) metaParts.push(u.planType);

    const widgetState: WidgetState = state.pending
      ? 'loading'
      : u
        ? state.error
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('codex', metaParts.join(' · '), widgetState);

    if (u) {
      // Label each window by its ACTUAL duration — Codex windows changed shape
      // mid-2026 (5h primary dropped; primary became the weekly window), so a
      // fixed "session 5h" label misreports the live payload.
      const gaugeLabel = (w: CodexWindow): string =>
        w.windowMinutes > 0 && w.windowMinutes < 1440
          ? `session ${codexWindowLabel(w.windowMinutes)}`
          : codexWindowLabel(w.windowMinutes);
      if (u.primary) {
        this.gauge(widget, gaugeLabel(u.primary), u.primary.usedPercent, u.primary.resetsAt * 1000);
      }
      if (u.secondary) {
        this.gauge(widget, gaugeLabel(u.secondary), u.secondary.usedPercent, u.secondary.resetsAt * 1000);
      }
      const observed = Date.parse(u.observedAt);
      const error = state.error;
      const asOf = () => (Number.isNaN(observed) ? 'as of last session' : `as of ${formatAge(observed)}`);
      if (error) {
        this.foot(widget, 'stale', () => `${asOf()} — ${errorHint(error, 'codex')}`);
      } else {
        // Codex data is a local snapshot: freshness is the last codex
        // activity, not the last poll, so the foot always says "as of".
        this.foot(widget, 'ok', asOf);
      }
    } else if (state.pending) {
      this.skeleton(widget, 2);
      this.foot(widget, 'loading', () => 'reading sessions…');
    } else {
      const error = state.error;
      this.foot(widget, 'off', () => (error ? errorHint(error, 'codex') : 'not connected'));
    }
    return widget;
  }

  private renderCopilot(): HTMLElement {
    const state = usageStore.get('copilot');
    const u = state.data;
    const metaParts: string[] = [];
    if (u?.plan) metaParts.push(u.plan);

    const widgetState: WidgetState = state.pending
      ? 'loading'
      : u
        ? state.error
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('copilot', metaParts.join(' · '), widgetState);

    if (u) {
      // quota_reset_date is a date string ("2026-07-01") — monthly cycle.
      const resetMs = u.resetDate ? Date.parse(u.resetDate) : null;
      const row = (label: string, q: CopilotQuota | null): void => {
        if (!q) return;
        if (q.unlimited) {
          this.note(widget, `${label} — unlimited`);
          return;
        }
        this.gauge(widget, label, q.usedPercent, resetMs);
      };
      row('premium', u.premium);
      row('chat', u.chat);
      row('completions', u.completions);
      const error = state.error;
      if (error) {
        this.foot(widget, 'stale', () => `stale · ${formatAge(u.fetchedAt)} — ${errorHint(error, 'copilot')}`);
      } else {
        this.foot(widget, 'ok', () => `live · updated ${formatAge(u.fetchedAt)}`);
      }
    } else if (state.pending) {
      this.skeleton(widget, 3);
      this.foot(widget, 'loading', () => 'connecting…');
    } else {
      const error = state.error;
      this.foot(widget, 'off', () => (error ? errorHint(error, 'copilot') : 'not connected'));
    }
    return widget;
  }

  private renderCursor(): HTMLElement {
    const state = usageStore.get('cursor');
    const u = state.data;
    const metaParts: string[] = [];
    if (u?.email) metaParts.push(u.email);

    const widgetState: WidgetState = state.pending
      ? 'loading'
      : u
        ? state.error
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('cursor', metaParts.join(' · '), widgetState);

    if (u) {
      if (u.totalPercentUsed !== null) {
        // Usage-based plan — % of included usage for the billing cycle,
        // straight from Cursor's dashboard RPC.
        this.gauge(widget, 'usage', u.totalPercentUsed, u.cycleEnd);
        if (u.totalSpend !== null && u.includedSpend !== null) {
          const bonus = u.bonusSpend ? ` + $${u.bonusSpend.toFixed(2)} bonus` : '';
          this.note(
            widget,
            `$${u.totalSpend.toFixed(2)} used · $${u.includedSpend.toFixed(2)} included${bonus}`,
          );
        }
      } else if (u.requestsLimit !== null && u.requestsLimit > 0) {
        // Legacy request-capped plan fallback.
        const used = u.requestsUsed ?? 0;
        this.gauge(widget, 'requests', (used / u.requestsLimit) * 100, null);
        this.note(widget, `${used} / ${u.requestsLimit} fast requests this cycle`);
      } else {
        this.note(widget, 'plan usage not exposed by Cursor — see cursor.com/dashboard');
      }
      const error = state.error;
      if (error) {
        this.foot(widget, 'stale', () => `stale · ${formatAge(u.fetchedAt)} — ${errorHint(error, 'cursor')}`);
      } else if (u.totalPercentUsed !== null) {
        this.foot(widget, 'ok', () => `live · updated ${formatAge(u.fetchedAt)}`);
      } else if (u.cycleStart !== null) {
        const start = u.cycleStart;
        this.foot(widget, 'ok', () => `connected · cycle started ${formatAge(start)}`);
      } else {
        this.foot(widget, 'ok', () => 'connected');
      }
    } else if (state.pending) {
      this.skeleton(widget, 2);
      this.foot(widget, 'loading', () => 'connecting…');
    } else {
      const error = state.error;
      this.foot(widget, 'off', () => (error ? errorHint(error, 'cursor') : 'not connected'));
    }
    return widget;
  }

  private renderGrok(): HTMLElement {
    const state = usageStore.get('grok');
    const u = state.data;
    const metaParts: string[] = [];
    if (u?.email) metaParts.push(u.email);
    if (u?.tier) metaParts.push(u.tier);

    const widgetState: WidgetState = state.pending
      ? 'loading'
      : u
        ? state.error
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('grok', metaParts.join(' · '), widgetState);

    if (u) {
      if (u.monthlyLimit !== null && u.monthlyLimit > 0) {
        // Monthly credit balance — the only pollable Grok quota (spec 193).
        const used = u.used ?? 0;
        this.gauge(widget, 'credits', (used / u.monthlyLimit) * 100, u.periodEnd);
        this.note(widget, `${Math.round(used)} / ${Math.round(u.monthlyLimit)} credits this cycle`);
      } else {
        this.note(widget, 'credit usage not exposed for this plan — see grok.com');
      }
      const error = state.error;
      if (error) {
        this.foot(widget, 'stale', () => `stale · ${formatAge(u.fetchedAt)} — ${errorHint(error, 'grok')}`);
      } else {
        this.foot(widget, 'ok', () => `live · updated ${formatAge(u.fetchedAt)}`);
      }
    } else if (state.pending) {
      this.skeleton(widget, 1);
      this.foot(widget, 'loading', () => 'connecting…');
    } else {
      const error = state.error;
      this.foot(widget, 'off', () => (error ? errorHint(error, 'grok') : 'not connected'));
    }
    return widget;
  }

  /** Update countdown/age labels in place — no full re-render per second. */
  private tick(): void {
    for (const { el, text } of this.liveTexts) {
      el.textContent = text();
    }
  }

  // ─── ContentView ──────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    switch (e.key) {
      case 'r':
        void this.refresh();
        return true;
      case 'j':
        this.body.scrollBy({ top: 40, behavior: 'auto' });
        return true;
      case 'k':
        this.body.scrollBy({ top: -40, behavior: 'auto' });
        return true;
      case 'q':
      case 'Escape':
        if (this.closeCallback) this.closeCallback();
        return true;
      default:
        return false;
    }
  }

  getPaletteActions(): readonly PaletteAction[] {
    return [
      {
        id: 'usage.refresh',
        label: 'Refresh usage',
        category: 'Usage',
        keybinding: 'r',
        execute: () => void this.refresh(),
      },
    ];
  }

  onResize(): void {
    // Pure CSS layout — nothing to recompute.
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.liveTexts = [];
    this.element.remove();
  }

  getUsageProviders(): readonly UsageProvider[] {
    return this.providers;
  }
}
