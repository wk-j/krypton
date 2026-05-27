import type { ProviderErrorCategory, ProviderErrorPayload } from './types';

const MAX_PROVIDER_ERROR_TEXT = 1200;

export interface ProviderErrorDedupCandidate {
  kind?: string;
  providerError?: ProviderErrorPayload;
}

const CATEGORY_RULES: Array<{
  category: ProviderErrorCategory;
  retryable: boolean;
  codePatterns: RegExp[];
  textPatterns: RegExp[];
}> = [
  {
    category: 'rate_limit',
    retryable: true,
    codePatterns: [/\bresource_exhausted\b/i, /\brate_limit_error\b/i],
    textPatterns: [/\brate[-_\s]?limit(?:ed|s)?\b/i, /\b429\b/, /\btoo many requests\b/i],
  },
  {
    category: 'quota',
    retryable: false,
    codePatterns: [/\binsufficient_quota\b/i, /\bquota_exceeded\b/i],
    textPatterns: [/\bquota (?:exceeded|exhausted)\b/i, /\bcredit balance\b/i, /\busage limit\b/i],
  },
  {
    category: 'context',
    retryable: false,
    codePatterns: [/\bcontext_length_exceeded\b/i],
    textPatterns: [/\bcontext length\b/i, /\btoken limit\b/i, /\bmax(?:imum)? tokens?\b/i, /\bmaximum context\b/i],
  },
  {
    category: 'auth',
    retryable: false,
    codePatterns: [/\bauthentication_error\b/i, /\binvalid_api_key\b/i],
    textPatterns: [/\binvalid api key\b/i, /\bunauthori[sz]ed\b/i, /\bauthentication\b/i, /\b401\b/],
  },
  {
    category: 'network',
    retryable: true,
    codePatterns: [/\beconnreset\b/i, /\betimedout\b/i, /\beconnrefused\b/i],
    textPatterns: [/\bnetwork error\b/i, /\bconnection refused\b/i, /\b503\b/],
  },
  {
    category: 'provider',
    retryable: true,
    codePatterns: [/\boverloaded_error\b/i, /\bapi_error\b/i],
    textPatterns: [/\binternal server error\b/i, /\b529\b/, /\boverloaded\b/i],
  },
];

const CODE_RE = /\b(resource_exhausted|rate_limit_error|insufficient_quota|quota_exceeded|context_length_exceeded|authentication_error|invalid_api_key|overloaded_error|api_error|econnreset|etimedout|econnrefused)\b/i;

export function classifyProviderError(text: string, _backendId?: string): ProviderErrorPayload | null {
  const raw = text.trim();
  if (!raw) return null;
  const normalized = normalizeProviderErrorText(raw);
  if (!looksLikeProviderFailure(normalized)) return null;

  const strongMarker = CATEGORY_RULES.some((rule) =>
    [...rule.codePatterns, ...rule.textPatterns].some((pattern) => pattern.test(normalized)),
  );
  if (!strongMarker) return null;

  for (const rule of CATEGORY_RULES) {
    if ([...rule.codePatterns, ...rule.textPatterns].some((pattern) => pattern.test(normalized))) {
      return buildPayload(rule.category, rule.retryable, raw, normalized);
    }
  }

  return buildPayload('unknown', true, raw, normalized);
}

export function shouldAppendProviderError(
  last: ProviderErrorDedupCandidate | null | undefined,
  next: ProviderErrorPayload,
): boolean {
  if (last?.kind !== 'provider_error' || !last.providerError) return true;
  const prev = last.providerError;
  if (prev.raw === next.raw) return false;
  if (prev.code && next.code && prev.code === next.code) return false;
  return prev.category !== next.category || prev.headline !== next.headline;
}

function buildPayload(
  category: ProviderErrorCategory,
  retryable: boolean,
  raw: string,
  normalized: string,
): ProviderErrorPayload {
  const copy = CATEGORY_COPY[category];
  return {
    category,
    code: extractProviderErrorCode(normalized),
    headline: copy.headline,
    hint: copy.hint,
    retryable,
    raw,
  };
}

function normalizeProviderErrorText(text: string): string {
  return stripAnsi(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function looksLikeProviderFailure(text: string): boolean {
  if (text.length > MAX_PROVIDER_ERROR_TEXT) return false;
  if (/^#{1,6}\s/u.test(text) || /^[-*]\s/u.test(text)) return false;
  const paragraphCount = text.split(/\n\s*\n/u).filter(Boolean).length;
  if (paragraphCount > 1 && text.length > 320) return false;
  return /(?:^|\b)(error|exception|failed|failure|api|provider|request|unauthori[sz]ed|rate|quota|context|token|overloaded|resource_exhausted|429|529|503|401|403)(?:\b|$)/i.test(text);
}

function extractProviderErrorCode(text: string): string | undefined {
  const match = CODE_RE.exec(text);
  return match?.[1]?.toLowerCase();
}

const CATEGORY_COPY: Record<ProviderErrorCategory, { headline: string; hint: string }> = {
  rate_limit: {
    headline: 'Provider rate limit reached',
    hint: 'Wait briefly, retry, or reduce the request/context size.',
  },
  quota: {
    headline: 'Provider quota exhausted',
    hint: 'Check account quota, billing, or usage limits.',
  },
  auth: {
    headline: 'Provider authentication failed',
    hint: 'Re-authenticate the backend outside Krypton, then restart the lane.',
  },
  context: {
    headline: 'Request exceeded model context',
    hint: 'Start a fresh session or send a smaller prompt/context.',
  },
  network: {
    headline: 'Provider network request failed',
    hint: 'Retry when connectivity or provider availability recovers.',
  },
  provider: {
    headline: 'Provider service error',
    hint: 'Retry later; the provider returned a temporary service error.',
  },
  unknown: {
    headline: 'Agent request failed',
    hint: 'Inspect details before retrying.',
  },
};
