import { describe, expect, it } from 'vitest';

import { classifyProviderError, shouldAppendProviderError } from './provider-error';

describe('classifyProviderError', () => {
  it('classifies resource_exhausted as retryable rate limit', () => {
    const payload = classifyProviderError('Error: T: resource_exhausted] Error');
    expect(payload).toMatchObject({
      category: 'rate_limit',
      code: 'resource_exhausted',
      headline: 'Provider rate limit reached',
      retryable: true,
    });
  });

  it('classifies 429 rate limit responses', () => {
    const payload = classifyProviderError('API Error 429: Rate limit reached for requests');
    expect(payload?.category).toBe('rate_limit');
    expect(payload?.retryable).toBe(true);
  });

  it('classifies quota exhaustion separately from rate limit', () => {
    const payload = classifyProviderError('insufficient_quota: You exceeded your current quota');
    expect(payload).toMatchObject({
      category: 'quota',
      code: 'insufficient_quota',
      retryable: false,
    });
  });

  it('classifies context length failures', () => {
    const payload = classifyProviderError('context_length_exceeded: maximum context length exceeded');
    expect(payload).toMatchObject({
      category: 'context',
      code: 'context_length_exceeded',
      retryable: false,
    });
  });

  it('classifies auth failures', () => {
    const payload = classifyProviderError('unauthorized: invalid api key');
    expect(payload).toMatchObject({
      category: 'auth',
      retryable: false,
    });
  });

  it('classifies provider overload failures', () => {
    const payload = classifyProviderError('Error code: 529 - overloaded_error: Overloaded');
    expect(payload).toMatchObject({
      category: 'provider',
      code: 'overloaded_error',
      retryable: true,
    });
  });

  it('does not classify normal assistant prose mentioning errors', () => {
    const payload = classifyProviderError(
      'The error handling path should preserve the original result. Here is a complete explanation with several implementation details and no provider failure marker.',
    );
    expect(payload).toBeNull();
  });

  it('does not classify generic short request failures without provider markers', () => {
    expect(classifyProviderError('Error: request failed')).toBeNull();
  });

  it('does not classify bare 403 as authentication without auth context', () => {
    expect(classifyProviderError('Error 403: forbidden')).toBeNull();
  });

  it('does not classify working assistant prose that merely mentions authentication', () => {
    expect(
      classifyProviderError(
        'I added the authentication middleware to the API request handler and wired up the token refresh path.',
      ),
    ).toBeNull();
  });

  it('still classifies a genuine authentication failure with failure context', () => {
    expect(classifyProviderError('authentication failed: token expired')?.category).toBe('auth');
  });

  describe('prose mode (assistant rows)', () => {
    it('does not classify a build-success message that mentions a 401 code path', () => {
      expect(
        classifyProviderError(
          '**BUILD SUCCESS — 55 tests passed**, createIndex 8 wired. Now adding a unit test for `DimAnyAuthService` (401 paths + success):',
          { prose: true },
        ),
      ).toBeNull();
    });

    it('does not classify working prose that merely discusses rate limits or auth', () => {
      expect(
        classifyProviderError(
          'I wired the rate limit guard and the authentication retry path; the request now returns a token on success.',
          { prose: true },
        ),
      ).toBeNull();
    });

    it('does not chop a Thai-leading message down to a stray status number', () => {
      expect(classifyProviderError('เพิ่มเทสต์ 401 path เรียบร้อย', { prose: true })).toBeNull();
    });

    it('still classifies a stringified provider error that leads with the failure', () => {
      expect(
        classifyProviderError('Error: T: resource_exhausted] Error', { prose: true })?.category,
      ).toBe('rate_limit');
      expect(classifyProviderError('unauthorized: invalid api key', { prose: true })?.category).toBe('auth');
      expect(classifyProviderError('429 Too Many Requests', { prose: true })?.category).toBe('rate_limit');
    });
  });

  it('does not classify long markdown content', () => {
    const body = '# Error handling notes\n\n' + 'This document discusses rate limit handling.\n'.repeat(80);
    expect(classifyProviderError(body)).toBeNull();
  });
});

describe('shouldAppendProviderError', () => {
  it('dedupes a structured error that repeats a converted streamed provider error', () => {
    const streamed = classifyProviderError('Error: T: resource_exhausted] Error');
    const structured = classifyProviderError('resource_exhausted');
    expect(streamed).not.toBeNull();
    expect(structured).not.toBeNull();
    expect(shouldAppendProviderError({
      kind: 'provider_error',
      providerError: streamed!,
    }, structured!)).toBe(false);
  });

  it('allows a distinct provider error after a different transcript row', () => {
    const payload = classifyProviderError('context_length_exceeded: maximum context length exceeded');
    expect(payload).not.toBeNull();
    expect(shouldAppendProviderError({ kind: 'assistant' }, payload!)).toBe(true);
  });
});
