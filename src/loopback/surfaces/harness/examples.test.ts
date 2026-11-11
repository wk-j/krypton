import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolState, ToolView } from '../../../acp/adapters/types';
import { ROW_KINDS, rowKindFor } from '../../../acp/components/transcript/rows';
import type { RowKind } from '../../../acp/components/transcript/rows';
import { HARNESS_COMPONENTS } from '../../../acp/components/registry';
import type { ToolKind } from '../../../acp/types';
import { buildState } from './build';
import { ENTRIES } from './examples';
import type { GalleryInput } from './examples';

// Spec 381 coverage guard: every shape adapter output can take has an example,
// so a state that drifts is on the page before a lane happens to hit it.

/** Row kinds only Krypton itself produces; spec 381 excludes them. */
const KRYPTON_ONLY: readonly RowKind[] = ['interLane', 'docCard', 'directiveDiff'];

const TOOL_KINDS = [
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other', 'agents', 'wait',
] as const satisfies readonly (ToolKind | 'agents' | 'wait')[];
const TOOL_STATES = ['pending', 'in_progress', 'completed', 'failed', 'canceled'] as const satisfies readonly ToolState[];

// A new ACP tool kind or tool state fails the type check here until it has an example.
type Exhaustive<Missing> = [Missing] extends [never] ? true : false;
const kindsCovered: Exhaustive<Exclude<ToolKind, (typeof TOOL_KINDS)[number]>> = true;
const statesCovered: Exhaustive<Exclude<ToolState, (typeof TOOL_STATES)[number]>> = true;

const INPUTS: readonly GalleryInput[] = ENTRIES.flatMap((entry) => entry.states.flatMap((state) => state.inputs));
const TOOLS: readonly ToolView[] = INPUTS.flatMap((input) => (input.kind === 'tool' ? [input.view] : []));

const FIXTURES = join(import.meta.dirname, '../../../acp/adapters/fixtures');

describe('harness gallery examples', () => {
  it('names each entry and state once, and only registered components', () => {
    expect(kindsCovered && statesCovered).toBe(true);
    const ids = ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const registered = new Set(HARNESS_COMPONENTS.map((def) => def.id));
    for (const entry of ENTRIES) {
      expect(entry.states.length, entry.id).toBeGreaterThan(0);
      const labels = entry.states.map((state) => state.label);
      expect(new Set(labels).size, entry.id).toBe(labels.length);
      for (const id of entry.components) expect(registered.has(id), `${entry.id}: ${id}`).toBe(true);
    }
  });

  it('has an example of every row kind adapter output can produce', () => {
    const kinds = new Set<RowKind>();
    for (const entry of ENTRIES) {
      entry.states.forEach((state, index) => {
        for (const item of buildState(entry.id, index, state, 0)) kinds.add(rowKindFor(item));
      });
    }
    const wanted = ROW_KINDS.filter((kind) => !KRYPTON_ONLY.includes(kind));
    expect(wanted.filter((kind) => !kinds.has(kind))).toEqual([]);
  });

  it('has an example of every tool kind, status, exit shape and card payload', () => {
    const kinds = new Set(TOOLS.map((view) => view.kind));
    expect(TOOL_KINDS.filter((kind) => !kinds.has(kind))).toEqual([]);
    const states = new Set(TOOLS.map((view) => view.status));
    expect(TOOL_STATES.filter((status) => !states.has(status))).toEqual([]);

    expect(TOOLS.some((view) => view.exit === null)).toBe(true);
    expect(TOOLS.some((view) => view.exit === 0)).toBe(true);
    expect(TOOLS.some((view) => view.exit !== null && view.exit !== 0)).toBe(true);

    expect(TOOLS.some((view) => view.subagents !== undefined)).toBe(true);
    expect(TOOLS.some((view) => view.jobs !== undefined)).toBe(true);
    expect(TOOLS.some((view) => view.execution !== undefined)).toBe(true);
    expect(TOOLS.some((view) => view.guardianReview !== undefined)).toBe(true);
    expect(TOOLS.some((view) => view.remoteCommand !== undefined)).toBe(true);
    expect(TOOLS.some((view) => view.diffs.length > 0)).toBe(true);
    expect(TOOLS.some((view) => view.background !== null)).toBe(true);
    expect(INPUTS.some((input) => input.kind === 'tool' && (input.images?.blocks.length ?? 0) > 0)).toBe(true);
  });

  it('references every spec 380 fixture scenario, and only scenarios that exist', () => {
    const scenarios = new Set<string>();
    if (existsSync(FIXTURES)) {
      for (const backend of readdirSync(FIXTURES, { withFileTypes: true })) {
        if (!backend.isDirectory()) continue;
        for (const file of readdirSync(join(FIXTURES, backend.name))) {
          if (file.endsWith('.jsonl')) scenarios.add(file.slice(0, -'.jsonl'.length));
        }
      }
    }
    const referenced = new Set(ENTRIES.flatMap((entry) => (entry.scenario === null ? [] : [entry.scenario])));
    expect([...scenarios].filter((scenario) => !referenced.has(scenario))).toEqual([]);
    expect([...referenced].filter((scenario) => !scenarios.has(scenario))).toEqual([]);
  });
});
