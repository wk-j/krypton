import { describe, expect, it } from 'vitest';

import {
  completedTypeSafeOperations,
  formatTypeSafeFooterLabel,
  formatTypeSafeTooltip,
  typeSafeMetricRows,
  type TypeSafeMetricsSnapshot,
} from './typesafe-metrics';

const METRICS: TypeSafeMetricsSnapshot = {
  apiRequests: 12,
  logicalOperations: 10,
  retries: 2,
  suggestions: 4,
  fallbacks: 6,
  averageLatencyMs: 412,
};

describe('TypeSafe metrics presentation', () => {
  it('distinguishes requests, logical operations, retries, and completions', () => {
    expect(completedTypeSafeOperations(METRICS)).toBe(10);
    expect(formatTypeSafeFooterLabel(METRICS, false)).toBe('TS 12');
    expect(formatTypeSafeFooterLabel(METRICS, true)).toBe('TS 12 · 10 op · 2 retry');
  });

  it('keeps an in-flight operation out of completed totals', () => {
    const inFlight = { ...METRICS, apiRequests: 13, logicalOperations: 11 };
    expect(completedTypeSafeOperations(inFlight)).toBe(10);
    expect(typeSafeMetricRows(inFlight)[1]).toEqual({
      leftLabel: 'retries',
      leftValue: '2',
      rightLabel: 'completed',
      rightValue: '10',
    });
  });

  it('describes the run scope and unavailable latency', () => {
    const empty: TypeSafeMetricsSnapshot = {
      apiRequests: 0,
      logicalOperations: 0,
      retries: 0,
      suggestions: 0,
      fallbacks: 0,
      averageLatencyMs: null,
    };
    expect(formatTypeSafeTooltip(empty)).toContain('average latency: n/a');
    expect(formatTypeSafeTooltip(empty)).toContain('scope: this app run');
  });
});
