import { describe, expect, it } from 'vitest';

import { nextPrompt } from './next-prompt';
import type { AssistBudget, AssistContext, AssistTaskConfig } from '../types';
import type { HarnessTranscriptItem, ToolPayload } from '../../harness-view-types';

const BUDGET: AssistBudget = { maxInputChars: 1_000, timeoutMs: 8_000 };

function cfg(over: Partial<AssistTaskConfig> = {}): AssistTaskConfig {
  return {
    mode: 'auto',
    backendId: 'claude',
    modelId: 'haiku',
    options: { count: 3 },
    maxInputChars: BUDGET.maxInputChars,
    timeoutMs: BUDGET.timeoutMs,
    ...over,
  };
}

function ctx(over: Partial<AssistContext> = {}): AssistContext {
  return {
    laneId: 'lane-1',
    laneName: 'OMP-1',
    backendId: 'omp',
    modelName: 'claude-opus-5',
    projectDir: '/Users/wk/Source/krypton',
    stopReason: 'end_turn',
    turn: [],
    plan: null,
    queuedPrompts: 0,
    draft: '',
    ...over,
  };
}

function toolItem(id: string, kind: string, subject: string): HarnessTranscriptItem {
  const tool: ToolPayload = {
    glyph: '✓',
    status: 'completed',
    kind,
    subject,
    command: subject,
    result: '',
    exitCode: null,
    sections: [{ label: 'stdout', text: 'secret output' }],
    diffs: [],
  };
  return { id, kind: 'tool', text: '', status: 'completed', tool };
}

function textItem(id: string, kind: 'user' | 'assistant', text: string): HarnessTranscriptItem {
  return { id, kind, text };
}

describe('next-prompt payload', () => {
  it('writes the header block from the context', () => {
    const payload = nextPrompt.payload(ctx({
      turn: [textItem('u1', 'user', 'add a test'), textItem('a1', 'assistant', 'done')],
      plan: [
        { content: 'wire the controller', status: 'in_progress' },
        { content: 'write the test', status: 'pending' },
      ],
    }), BUDGET);

    expect(payload.split('\n').slice(0, 4)).toEqual([
      'project: krypton',
      'lane: OMP-1 (omp · claude-opus-5)',
      'stop: end_turn',
      'plan: [in_progress] wire the controller / [pending] write the test',
    ]);
    expect(payload).toContain('--- user asked ---\nadd a test');
    expect(payload).toContain('--- agent replied ---\ndone');
  });

  it('caps the plan at five entries and drops a null plan', () => {
    const plan = Array.from({ length: 7 }, (_, i) => ({ content: `step ${i}`, status: 'pending' as const }));

    expect(nextPrompt.payload(ctx({ plan }), BUDGET)).toContain(
      'plan: [pending] step 0 / [pending] step 1 / [pending] step 2 / [pending] step 3 / [pending] step 4\n',
    );
    expect(nextPrompt.payload(ctx(), BUDGET)).not.toContain('plan:');
  });

  it('lists tool names with counts and never their arguments or output', () => {
    const payload = nextPrompt.payload(ctx({
      turn: [
        toolItem('t1', 'read', '/etc/passwd'),
        toolItem('t2', 'edit', 'src/acp/assist/engine.ts'),
        toolItem('t3', 'read', '~/.ssh/id_rsa'),
        toolItem('t4', 'read', 'package.json'),
      ],
    }), BUDGET);

    expect(payload).toContain('tools: read×3, edit×1');
    expect(payload).not.toContain('passwd');
    expect(payload).not.toContain('id_rsa');
    expect(payload).not.toContain('secret output');
  });

  it('omits the tools line when the turn used none', () => {
    expect(nextPrompt.payload(ctx(), BUDGET)).not.toContain('tools:');
  });

  it('head-truncates the user prompt at 25% of the budget', () => {
    const user = `START${'u'.repeat(400)}END`;
    const payload = nextPrompt.payload(ctx({ turn: [textItem('u1', 'user', user)] }), BUDGET);
    const line = payload.split('--- user asked ---\n')[1].split('\n--- agent replied ---')[0];

    expect(line.startsWith('START')).toBe(true);
    expect(line.endsWith(' …[truncated]')).toBe(true);
    expect(line).not.toContain('END');
    expect(line.length).toBe(250 + ' …[truncated]'.length);
  });

  it('tail-truncates the assistant reply at 60% of the budget', () => {
    const reply = `START${'a'.repeat(700)}END`;
    const payload = nextPrompt.payload(ctx({ turn: [textItem('a1', 'assistant', reply)] }), BUDGET);
    const line = payload.split('--- agent replied ---\n')[1];

    expect(line).not.toContain('START');
    expect(line).toContain('END');
    expect(line.endsWith(' …[truncated]')).toBe(true);
    expect(line.length).toBe(600 + ' …[truncated]'.length);
  });

  it('leaves short text untouched and uses the last item of each kind', () => {
    const payload = nextPrompt.payload(ctx({
      turn: [
        textItem('u1', 'user', 'first ask'),
        textItem('a1', 'assistant', 'first reply'),
        textItem('u2', 'user', 'second ask'),
        textItem('a2', 'assistant', 'second reply'),
      ],
    }), BUDGET);

    expect(payload).not.toContain('[truncated]');
    expect(payload).toContain('--- user asked ---\nsecond ask');
    expect(payload).toContain('--- agent replied ---\nsecond reply');
  });

  it('stays inside the budget when both halves overflow', () => {
    const payload = nextPrompt.payload(ctx({
      turn: [textItem('u1', 'user', 'u'.repeat(5_000)), textItem('a1', 'assistant', 'a'.repeat(5_000))],
    }), BUDGET);

    expect(payload.length).toBeLessThanOrEqual(BUDGET.maxInputChars);
  });
});

describe('next-prompt system prompt', () => {
  it('substitutes the clamped suggestion count', () => {
    expect(nextPrompt.system(cfg())).toContain('At most 3 entries');
    expect(nextPrompt.system(cfg({ options: { count: 1 } }))).toContain('At most 1 entries');
    expect(nextPrompt.system(cfg({ options: { count: 9 } }))).toContain('At most 3 entries');
    expect(nextPrompt.system(cfg({ options: {} }))).toContain('At most 3 entries');
    expect(nextPrompt.system(cfg())).toContain('No prose outside the JSON.');
  });
});

describe('next-prompt eligibility', () => {
  it('is eligible only when nothing is queued', () => {
    expect(nextPrompt.eligible?.(ctx({ queuedPrompts: 0 }), cfg())).toBe(true);
    expect(nextPrompt.eligible?.(ctx({ queuedPrompts: 1 }), cfg())).toBe(false);
  });
});

describe('next-prompt parse', () => {
  const one = { label: 'run the failing test', prompt: 'Run the failing vitest file and paste the output.' };

  it('reads a bare JSON object', () => {
    expect(nextPrompt.parse(JSON.stringify({ suggestions: [one] }), cfg())).toEqual([one]);
  });

  it('strips a ```json fence', () => {
    const raw = '```json\n' + JSON.stringify({ suggestions: [one] }) + '\n```';
    expect(nextPrompt.parse(raw, cfg())).toEqual([one]);
  });

  it('takes the outermost object out of trailing prose', () => {
    const raw = `Sure! Here you go:\n${JSON.stringify({ suggestions: [one] })}\nHope that helps.`;
    expect(nextPrompt.parse(raw, cfg())).toEqual([one]);
  });

  it('collapses whitespace in the label and keeps newlines in the prompt', () => {
    const raw = JSON.stringify({ suggestions: [{ label: '  run   the\ntest  ', prompt: 'line one\nline two' }] });
    expect(nextPrompt.parse(raw, cfg())).toEqual([{ label: 'run the test', prompt: 'line one\nline two' }]);
  });

  it('drops entries with wrong types', () => {
    const raw = JSON.stringify({ suggestions: [{ label: 7, prompt: 'a valid prompt here' }, 'nope', null, one] });
    expect(nextPrompt.parse(raw, cfg())).toEqual([one]);
  });

  it('drops an over-long label and an empty one', () => {
    const raw = JSON.stringify({
      suggestions: [
        { label: 'x'.repeat(49), prompt: 'a valid prompt here' },
        { label: '   ', prompt: 'a valid prompt here' },
        one,
      ],
    });
    expect(nextPrompt.parse(raw, cfg())).toEqual([one]);
  });

  it('truncates an over-long prompt but drops a too-short one', () => {
    const raw = JSON.stringify({
      suggestions: [
        { label: 'short', prompt: 'tiny' },
        { label: 'long', prompt: 'p'.repeat(400) },
      ],
    });
    expect(nextPrompt.parse(raw, cfg())).toEqual([{ label: 'long', prompt: 'p'.repeat(240) }]);
  });

  it('caps the list at the configured count', () => {
    const suggestions = [1, 2, 3, 4].map((i) => ({ label: `label ${i}`, prompt: `prompt number ${i}` }));
    const parsed = nextPrompt.parse(JSON.stringify({ suggestions }), cfg({ options: { count: 3 } }));

    expect(parsed?.map((a) => a.label)).toEqual(['label 1', 'label 2', 'label 3']);
  });

  it('returns null when nothing survives, or there is no object at all', () => {
    expect(nextPrompt.parse(JSON.stringify({ suggestions: [{ label: 'ok', prompt: 'tiny' }] }), cfg())).toBeNull();
    expect(nextPrompt.parse(JSON.stringify({ suggestions: [] }), cfg())).toBeNull();
    expect(nextPrompt.parse(JSON.stringify({ other: 1 }), cfg())).toBeNull();
    expect(nextPrompt.parse('no json here', cfg())).toBeNull();
    expect(nextPrompt.parse('{ not: valid json }', cfg())).toBeNull();
    expect(nextPrompt.parse('', cfg())).toBeNull();
  });
});
