// Spec 380 — backend id → adapter. A backend without an entry gets `generic`.

import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { genericAdapter } from './generic';
import { grokAdapter } from './grok';
import { ompAdapter } from './omp';
import type { LaneAdapter } from './types';

const ADAPTERS: ReadonlyMap<string, LaneAdapter> = new Map(
  [claudeAdapter, codexAdapter, grokAdapter, ompAdapter].map((adapter) => [adapter.id, adapter]),
);

export function adapterFor(backendId: string): LaneAdapter {
  return ADAPTERS.get(backendId) ?? genericAdapter;
}
