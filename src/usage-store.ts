// Krypton — shared subscription usage polling (spec 153).

import { invoke } from '@tauri-apps/api/core';

export type UsageProvider = 'claude' | 'codex' | 'copilot' | 'cursor' | 'grok';
export type UsageFreshness = 'loading' | 'live' | 'stale' | 'off';

export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/** Model-scoped weekly window (spec 187), e.g. the Fable weekly bucket. */
export interface ScopedUsageWindow {
  name: string;
  utilization: number;
  resetsAt: string | null;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
}

export interface ClaudeUsage {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  sevenDayOpus: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  weeklyScoped: ScopedUsageWindow[];
  extraUsage: ExtraUsage | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  fetchedAt: number;
}

export interface CodexWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

export interface CodexUsage {
  primary: CodexWindow | null;
  secondary: CodexWindow | null;
  planType: string | null;
  observedAt: string;
  sessionFile: string;
}

export interface CopilotQuota {
  usedPercent: number;
  remaining: number;
  entitlement: number;
  unlimited: boolean;
}

export interface CopilotUsage {
  premium: CopilotQuota | null;
  chat: CopilotQuota | null;
  completions: CopilotQuota | null;
  plan: string | null;
  resetDate: string | null;
  fetchedAt: number;
}

export interface CursorUsage {
  totalPercentUsed: number | null;
  totalSpend: number | null;
  includedSpend: number | null;
  bonusSpend: number | null;
  limitSpend: number | null;
  cycleStart: number | null;
  cycleEnd: number | null;
  requestsUsed: number | null;
  requestsLimit: number | null;
  email: string | null;
  fetchedAt: number;
}

/** Grok subscription credit usage (spec 193), from cli-chat-proxy billing. */
export interface GrokUsage {
  used: number | null;
  monthlyLimit: number | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  periodStart: number | null;
  periodEnd: number | null;
  tier: string | null;
  email: string | null;
  fetchedAt: number;
}

export interface UsagePayloads {
  claude: ClaudeUsage;
  codex: CodexUsage;
  copilot: CopilotUsage;
  cursor: CursorUsage;
  grok: GrokUsage;
}

export interface ProviderUsageState<P extends UsageProvider = UsageProvider> {
  provider: P;
  data: UsagePayloads[P] | null;
  error: string | null;
  pending: boolean;
}

export interface UsageQuotaSummary {
  label: string;
  usedPercent: number;
}

export interface ProviderUsageSummary {
  provider: UsageProvider;
  quotas: readonly UsageQuotaSummary[];
  mostConstrained: UsageQuotaSummary | null;
  freshness: UsageFreshness;
  error: string | null;
}

const PROVIDERS: readonly UsageProvider[] = ['claude', 'codex', 'copilot', 'cursor', 'grok'];
const POLL_MS: Record<UsageProvider, number> = {
  claude: 180_000,
  codex: 60_000,
  copilot: 180_000,
  cursor: 180_000,
  grok: 180_000,
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function quota(label: string, value: number): UsageQuotaSummary {
  return { label, usedPercent: clampPercent(value) };
}

export function providerForBackend(backendId: string): UsageProvider | null {
  if (
    backendId === 'claude' ||
    backendId === 'codex' ||
    backendId === 'copilot' ||
    backendId === 'cursor' ||
    backendId === 'grok'
  ) {
    return backendId;
  }
  return null;
}

/** Codex quota label derived from the window's ACTUAL duration. The windows
 *  are not fixed contract — the 5h primary disappeared mid-2026 when Codex
 *  moved to a weekly-only limit (primary became `window_minutes: 10080`,
 *  secondary null) — so never hard-code "5h"/"week" for a slot. */
export function codexWindowLabel(windowMinutes: number): string {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return 'window';
  if (windowMinutes % 10080 === 0) {
    const weeks = windowMinutes / 10080;
    return weeks === 1 ? 'week' : `${weeks}w`;
  }
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

export function summarizeUsage(state: ProviderUsageState): ProviderUsageSummary {
  const quotas: UsageQuotaSummary[] = [];
  const data = state.data;

  if (state.provider === 'claude' && data) {
    const u = data as ClaudeUsage;
    quotas.push(quota('5h', u.fiveHour.utilization), quota('week', u.sevenDay.utilization));
    if (u.sevenDayOpus) quotas.push(quota('opus', u.sevenDayOpus.utilization));
    if (u.sevenDaySonnet) quotas.push(quota('sonnet', u.sevenDaySonnet.utilization));
    for (const scoped of u.weeklyScoped) {
      quotas.push(quota(scoped.name.toLowerCase(), scoped.utilization));
    }
  } else if (state.provider === 'codex' && data) {
    const u = data as CodexUsage;
    if (u.primary) quotas.push(quota(codexWindowLabel(u.primary.windowMinutes), u.primary.usedPercent));
    if (u.secondary) quotas.push(quota(codexWindowLabel(u.secondary.windowMinutes), u.secondary.usedPercent));
  } else if (state.provider === 'copilot' && data) {
    const u = data as CopilotUsage;
    if (u.premium && !u.premium.unlimited) quotas.push(quota('premium', u.premium.usedPercent));
    if (u.chat && !u.chat.unlimited) quotas.push(quota('chat', u.chat.usedPercent));
    if (u.completions && !u.completions.unlimited) quotas.push(quota('complete', u.completions.usedPercent));
  } else if (state.provider === 'cursor' && data) {
    const u = data as CursorUsage;
    if (u.totalPercentUsed !== null) {
      quotas.push(quota('month', u.totalPercentUsed));
    } else if (u.requestsLimit !== null && u.requestsLimit > 0) {
      quotas.push(quota('requests', ((u.requestsUsed ?? 0) / u.requestsLimit) * 100));
    }
  } else if (state.provider === 'grok' && data) {
    const u = data as GrokUsage;
    if (u.monthlyLimit !== null && u.monthlyLimit > 0) {
      quotas.push(quota('credits', ((u.used ?? 0) / u.monthlyLimit) * 100));
    }
  }

  let mostConstrained: UsageQuotaSummary | null = null;
  for (const candidate of quotas) {
    if (!mostConstrained || candidate.usedPercent > mostConstrained.usedPercent) {
      mostConstrained = candidate;
    }
  }

  return {
    provider: state.provider,
    quotas,
    mostConstrained,
    freshness: state.pending ? 'loading' : data ? (state.error ? 'stale' : 'live') : 'off',
    error: state.error,
  };
}

export class UsageStore {
  private states = new Map<UsageProvider, ProviderUsageState>();
  private subscribers = new Map<UsageProvider, Set<() => void>>();
  private timers = new Map<UsageProvider, ReturnType<typeof setInterval>>();
  private inFlight = new Map<UsageProvider, Promise<void>>();

  constructor() {
    for (const provider of PROVIDERS) {
      this.states.set(provider, { provider, data: null, error: null, pending: true });
      this.subscribers.set(provider, new Set());
    }
  }

  get<P extends UsageProvider>(provider: P): ProviderUsageState<P> {
    return this.states.get(provider) as ProviderUsageState<P>;
  }

  summary(provider: UsageProvider): ProviderUsageSummary {
    return summarizeUsage(this.get(provider));
  }

  subscribe(providers: readonly UsageProvider[], callback: () => void): () => void {
    const unique = [...new Set(providers)];
    for (const provider of unique) {
      const subscribers = this.subscribers.get(provider)!;
      const wasEmpty = subscribers.size === 0;
      subscribers.add(callback);
      if (wasEmpty) {
        void this.fetch(provider);
        this.timers.set(provider, setInterval(() => void this.fetch(provider), POLL_MS[provider]));
      }
    }
    return () => {
      for (const provider of unique) {
        const subscribers = this.subscribers.get(provider)!;
        subscribers.delete(callback);
        if (subscribers.size === 0) {
          const timer = this.timers.get(provider);
          if (timer !== undefined) clearInterval(timer);
          this.timers.delete(provider);
        }
      }
    };
  }

  async refresh(providers: readonly UsageProvider[] = PROVIDERS): Promise<void> {
    await Promise.allSettled([...new Set(providers)].map((provider) => this.fetch(provider)));
  }

  private fetch(provider: UsageProvider): Promise<void> {
    const existing = this.inFlight.get(provider);
    if (existing) return existing;
    const request = this.fetchProvider(provider).finally(() => this.inFlight.delete(provider));
    this.inFlight.set(provider, request);
    return request;
  }

  private async fetchProvider(provider: UsageProvider): Promise<void> {
    const state = this.get(provider);
    try {
      const data = await invoke<UsagePayloads[typeof provider]>(`usage_fetch_${provider}`);
      this.states.set(provider, { provider, data, error: null, pending: false });
    } catch (error) {
      this.states.set(provider, { ...state, error: String(error), pending: false });
    }
    for (const callback of this.subscribers.get(provider) ?? []) callback();
  }
}

export const usageStore = new UsageStore();
