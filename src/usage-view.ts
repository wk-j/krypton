// Krypton — Subscription Credit Usage View (spec 151)
// Read-only gauges for provider subscription quotas: Claude (OAuth usage
// endpoint, fetched by the Rust backend with a 180 s cache) and Codex
// (snapshot from the newest local rollout JSONL — only as fresh as the
// last Codex activity, hence the "as of" label).
//
// Layout: one flat widget per provider on a responsive grid (side by side
// in wide windows, stacked in narrow ones). Each widget is a single
// surface — full border + background tint, no inner boxes.

import { invoke } from '@tauri-apps/api/core';

import type { ContentView, PaneContentType } from './types';
import type { PaletteAction } from './palette-types';

interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
}

interface ClaudeUsage {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  sevenDayOpus: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  extraUsage: ExtraUsage | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  fetchedAt: number;
}

interface CodexWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

interface CodexUsage {
  primary: CodexWindow | null;
  secondary: CodexWindow | null;
  planType: string | null;
  observedAt: string;
  sessionFile: string;
}

interface CopilotQuota {
  usedPercent: number;
  remaining: number;
  entitlement: number;
  unlimited: boolean;
}

interface CopilotUsage {
  premium: CopilotQuota | null;
  chat: CopilotQuota | null;
  completions: CopilotQuota | null;
  plan: string | null;
  resetDate: string | null;
  fetchedAt: number;
}

interface CursorUsage {
  requestsUsed: number | null;
  requestsLimit: number | null;
  startOfMonth: string | null;
  email: string | null;
  fetchedAt: number;
}

const CLAUDE_POLL_MS = 180_000;
const CODEX_POLL_MS = 60_000;
const COPILOT_POLL_MS = 180_000;
const CURSOR_POLL_MS = 180_000;

/** Static error sentinels from the Rust side, mapped to display hints. */
const ERROR_HINTS: Record<string, string> = {
  'not-connected': 'not connected',
  'token-expired': 'token expired — open a Claude lane or run claude to refresh',
  'rate-limited': 'rate limited — retrying next cycle',
  'no-recent-data': 'no recent data — run codex once',
  'unexpected-response': 'unexpected response — retrying next cycle',
  'network-error': 'fetch failed — retrying next cycle',
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
};

function errorHint(err: unknown): string {
  const key = String(err);
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
  private claude: ClaudeUsage | null = null;
  private claudeError: string | null = null;
  private claudePending = true;
  private codex: CodexUsage | null = null;
  private codexError: string | null = null;
  private codexPending = true;
  private copilot: CopilotUsage | null = null;
  private copilotError: string | null = null;
  private copilotPending = true;
  private cursor: CursorUsage | null = null;
  private cursorError: string | null = null;
  private cursorPending = true;
  /** Text nodes re-rendered by the 1 s tick (countdowns + data ages). */
  private liveTexts: Array<{ el: HTMLElement; text: () => string }> = [];
  private pollTimers: number[] = [];
  private tickTimer: number | null = null;
  private closeCallback: (() => void) | null = null;
  private disposed = false;

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

    this.render();
    void this.refresh();

    this.pollTimers.push(
      window.setInterval(() => void this.fetchClaude(), CLAUDE_POLL_MS),
      window.setInterval(() => void this.fetchCodex(), CODEX_POLL_MS),
      window.setInterval(() => void this.fetchCopilot(), COPILOT_POLL_MS),
      window.setInterval(() => void this.fetchCursor(), CURSOR_POLL_MS),
    );
    this.tickTimer = window.setInterval(() => this.tick(), 1_000);
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  private async refresh(): Promise<void> {
    await Promise.allSettled([
      this.fetchClaude(),
      this.fetchCodex(),
      this.fetchCopilot(),
      this.fetchCursor(),
    ]);
  }

  private async fetchClaude(): Promise<void> {
    try {
      const usage = await invoke<ClaudeUsage>('usage_fetch_claude');
      if (this.disposed) return;
      this.claude = usage;
      this.claudeError = null;
    } catch (err) {
      if (this.disposed) return;
      // Keep last good payload visible; the foot line marks it stale by age.
      this.claudeError = errorHint(err);
    }
    this.claudePending = false;
    this.render();
  }

  private async fetchCodex(): Promise<void> {
    try {
      const usage = await invoke<CodexUsage>('usage_fetch_codex');
      if (this.disposed) return;
      this.codex = usage;
      this.codexError = null;
    } catch (err) {
      if (this.disposed) return;
      this.codexError = errorHint(err);
    }
    this.codexPending = false;
    this.render();
  }

  private async fetchCopilot(): Promise<void> {
    try {
      const usage = await invoke<CopilotUsage>('usage_fetch_copilot');
      if (this.disposed) return;
      this.copilot = usage;
      this.copilotError = null;
    } catch (err) {
      if (this.disposed) return;
      this.copilotError = errorHint(err);
    }
    this.copilotPending = false;
    this.render();
  }

  private async fetchCursor(): Promise<void> {
    try {
      const usage = await invoke<CursorUsage>('usage_fetch_cursor');
      if (this.disposed) return;
      this.cursor = usage;
      this.cursorError = null;
    } catch (err) {
      if (this.disposed) return;
      this.cursorError = errorHint(err);
    }
    this.cursorPending = false;
    this.render();
  }

  // ─── Rendering ────────────────────────────────────────────

  private render(): void {
    this.liveTexts = [];
    this.body.innerHTML = '';
    this.body.appendChild(this.renderClaude());
    this.body.appendChild(this.renderCodex());
    this.body.appendChild(this.renderCopilot());
    this.body.appendChild(this.renderCursor());
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
    const u = this.claude;
    const metaParts: string[] = [];
    if (u?.subscriptionType) metaParts.push(u.subscriptionType);
    if (u?.rateLimitTier) metaParts.push(u.rateLimitTier.replace(/^default_claude_/, ''));

    const state: WidgetState = this.claudePending
      ? 'loading'
      : u
        ? this.claudeError
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('claude', metaParts.join(' · '), state);

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
      if (u.extraUsage?.isEnabled) {
        const used = u.extraUsage.usedCredits ?? 0;
        const limit = u.extraUsage.monthlyLimit;
        this.note(
          widget,
          `extra credits $${used.toFixed(2)}${limit !== null ? ` / $${limit.toFixed(2)}` : ''}`,
        );
      }
      const error = this.claudeError;
      if (error) {
        this.foot(widget, 'stale', () => `stale · ${formatAge(u.fetchedAt)} — ${error}`);
      } else {
        this.foot(widget, 'ok', () => `live · updated ${formatAge(u.fetchedAt)}`);
      }
    } else if (this.claudePending) {
      this.skeleton(widget, 3);
      this.foot(widget, 'loading', () => 'connecting…');
    } else {
      this.foot(widget, 'off', () => this.claudeError ?? 'not connected');
    }
    return widget;
  }

  private renderCodex(): HTMLElement {
    const u = this.codex;
    const metaParts: string[] = [];
    if (u?.planType) metaParts.push(u.planType);

    const state: WidgetState = this.codexPending
      ? 'loading'
      : u
        ? this.codexError
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('codex', metaParts.join(' · '), state);

    if (u) {
      if (u.primary) {
        this.gauge(widget, 'session 5h', u.primary.usedPercent, u.primary.resetsAt * 1000);
      }
      if (u.secondary) {
        this.gauge(widget, 'week', u.secondary.usedPercent, u.secondary.resetsAt * 1000);
      }
      const observed = Date.parse(u.observedAt);
      const error = this.codexError;
      const asOf = () => (Number.isNaN(observed) ? 'as of last session' : `as of ${formatAge(observed)}`);
      if (error) {
        this.foot(widget, 'stale', () => `${asOf()} — ${error}`);
      } else {
        // Codex data is a local snapshot: freshness is the last codex
        // activity, not the last poll, so the foot always says "as of".
        this.foot(widget, 'ok', asOf);
      }
    } else if (this.codexPending) {
      this.skeleton(widget, 2);
      this.foot(widget, 'loading', () => 'reading sessions…');
    } else {
      this.foot(widget, 'off', () => this.codexError ?? 'not connected');
    }
    return widget;
  }

  private renderCopilot(): HTMLElement {
    const u = this.copilot;
    const metaParts: string[] = [];
    if (u?.plan) metaParts.push(u.plan);

    const state: WidgetState = this.copilotPending
      ? 'loading'
      : u
        ? this.copilotError
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('copilot', metaParts.join(' · '), state);

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
      const error = this.copilotError;
      if (error) {
        this.foot(widget, 'stale', () => `stale · ${formatAge(u.fetchedAt)} — ${error}`);
      } else {
        this.foot(widget, 'ok', () => `live · updated ${formatAge(u.fetchedAt)}`);
      }
    } else if (this.copilotPending) {
      this.skeleton(widget, 3);
      this.foot(widget, 'loading', () => 'connecting…');
    } else {
      this.foot(widget, 'off', () => this.copilotError ?? 'not connected');
    }
    return widget;
  }

  private renderCursor(): HTMLElement {
    const u = this.cursor;
    const metaParts: string[] = [];
    if (u?.email) metaParts.push(u.email);

    const state: WidgetState = this.cursorPending
      ? 'loading'
      : u
        ? this.cursorError
          ? 'stale'
          : 'ok'
        : 'off';
    const widget = this.widget('cursor', metaParts.join(' · '), state);

    if (u) {
      if (u.requestsLimit !== null && u.requestsLimit > 0) {
        // Legacy request-capped plan — the only quota Cursor's CLI token
        // can read.
        const used = u.requestsUsed ?? 0;
        this.gauge(widget, 'requests', (used / u.requestsLimit) * 100, null);
        this.note(widget, `${used} / ${u.requestsLimit} fast requests this cycle`);
      } else {
        this.note(widget, 'plan usage not exposed by Cursor — see cursor.com/dashboard');
      }
      const cycleStart = u.startOfMonth ? Date.parse(u.startOfMonth) : NaN;
      const error = this.cursorError;
      if (error) {
        this.foot(widget, 'stale', () => `stale · ${formatAge(u.fetchedAt)} — ${error}`);
      } else if (!Number.isNaN(cycleStart)) {
        this.foot(widget, 'ok', () => `connected · cycle started ${formatAge(cycleStart)}`);
      } else {
        this.foot(widget, 'ok', () => 'connected');
      }
    } else if (this.cursorPending) {
      this.skeleton(widget, 2);
      this.foot(widget, 'loading', () => 'connecting…');
    } else {
      this.foot(widget, 'off', () => this.cursorError ?? 'not connected');
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
    this.disposed = true;
    for (const t of this.pollTimers) window.clearInterval(t);
    this.pollTimers = [];
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.liveTexts = [];
    this.element.remove();
  }
}
