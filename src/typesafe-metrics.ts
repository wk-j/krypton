export interface TypeSafeMetricsSnapshot {
  apiRequests: number;
  logicalOperations: number;
  retries: number;
  suggestions: number;
  fallbacks: number;
  averageLatencyMs: number | null;
}

export interface TypeSafeMetricRow {
  leftLabel: string;
  leftValue: string;
  rightLabel: string;
  rightValue: string;
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function count(value: number): string {
  return NUMBER_FORMAT.format(Math.max(0, Math.trunc(value)));
}

export function completedTypeSafeOperations(metrics: TypeSafeMetricsSnapshot): number {
  return Math.max(0, metrics.suggestions) + Math.max(0, metrics.fallbacks);
}

export function formatTypeSafeFooterLabel(
  metrics: TypeSafeMetricsSnapshot,
  detail: boolean,
): string {
  const requests = count(metrics.apiRequests);
  if (!detail) return `TS ${requests}`;
  return `TS ${requests} · ${count(metrics.logicalOperations)} op · ${count(metrics.retries)} retry`;
}

export function formatTypeSafeTooltip(metrics: TypeSafeMetricsSnapshot): string {
  const latency = metrics.averageLatencyMs === null
    ? 'n/a'
    : `${count(metrics.averageLatencyMs)} ms`;
  return [
    `TypeSafe API requests: ${count(metrics.apiRequests)}`,
    `logical operations: ${count(metrics.logicalOperations)}`,
    `retries: ${count(metrics.retries)}`,
    `completed: ${count(completedTypeSafeOperations(metrics))}`,
    `average latency: ${latency}`,
    'scope: this app run',
    'press ⌘P then ⇧P for the full matrix',
  ].join('\n');
}

export function typeSafeMetricRows(metrics: TypeSafeMetricsSnapshot): TypeSafeMetricRow[] {
  return [
    {
      leftLabel: 'requests',
      leftValue: count(metrics.apiRequests),
      rightLabel: 'operations',
      rightValue: count(metrics.logicalOperations),
    },
    {
      leftLabel: 'retries',
      leftValue: count(metrics.retries),
      rightLabel: 'completed',
      rightValue: count(completedTypeSafeOperations(metrics)),
    },
    {
      leftLabel: 'suggestions',
      leftValue: count(metrics.suggestions),
      rightLabel: 'fallbacks',
      rightValue: count(metrics.fallbacks),
    },
    {
      leftLabel: 'avg latency',
      leftValue: metrics.averageLatencyMs === null
        ? 'n/a'
        : `${count(metrics.averageLatencyMs)} ms`,
      rightLabel: 'scope',
      rightValue: 'this run',
    },
  ];
}
