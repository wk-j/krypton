// Krypton — shared subscription usage polling (spec 153).

import { invoke } from '@tauri-apps/api/core';

export type UsageProvider = 'claude' | 'codex' | 'copilot' | 'cursor';
export type UsageFreshness = 'loading' | 'live' | 'stale' | 'off';

export interface UsageWindow {
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

export interface UsagePayloads {
  claude: ClaudeUsage;
  codex: CodexUsage;
  copilot: CopilotUsage;
  cursor: CursorUsage;
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

const PROVIDERS: readonly UsageProvider[] = ['claude', 'codex', 'copilot', 'cursor'];
const POLL_MS: Record<UsageProvider, number> = {
  claude: 180_000,
  codex: 60_000,
  copilot: 180_000,
  cursor: 180_000,
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function quota(label: string, value: number): UsageQuotaSummary {
  return { label, usedPercent: clampPercent(value) };
}

export function providerForBackend(backendId: string): UsageProvider | null {
  if (backendId === 'claude' || backendId === 'codex' || backendId === 'copilot' || backendId === 'cursor') {
    return backendId;
  }
  return null;
}

export function summarizeUsage(state: ProviderUsageState): ProviderUsageSummary {
  const quotas: UsageQuotaSummary[] = [];
  const data = state.data;

  if (state.provider === 'claude' && data) {
    const u = data as ClaudeUsage;
    quotas.push(quota('5h', u.fiveHour.utilization), quota('week', u.sevenDay.utilization));
    if (u.sevenDayOpus) quotas.push(quota('opus', u.sevenDayOpus.utilization));
    if (u.sevenDaySonnet) quotas.push(quota('sonnet', u.sevenDaySonnet.utilization));
  } else if (state.provider === 'codex' && data) {
    const u = data as CodexUsage;
    if (u.primary) quotas.push(quota('5h', u.primary.usedPercent));
    if (u.secondary) quotas.push(quota('week', u.secondary.usedPercent));
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
