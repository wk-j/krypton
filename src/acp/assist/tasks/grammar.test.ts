import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { AssistContext, AssistTaskConfig } from '../types';
import { grammar, looksEnglish } from './grammar';

const cfg: AssistTaskConfig = {
  mode: 'auto',
  backendId: 'claude',
  modelId: 'haiku',
  maxInputChars: 6_000,
  timeoutMs: 8_000,
  options: {},
};

function ctx(text: string): AssistContext {
  return {
    laneId: 'l1',
    laneName: 'claude-1',
    backendId: 'claude',
    modelName: null,
    projectDir: null,
    stopReason: 'end_turn',
    turn: [{ id: 'u1', kind: 'user', text } as HarnessTranscriptItem],
    plan: null,
    queuedPrompts: 0,
    draft: '',
  };
}

describe('grammar assist task', () => {
  it('runs on the prompt the human sends, not at turn end', () => {
    expect(grammar.onUserPrompt).toBe(true);
    expect(grammar.onTurnEnd).toBe(false);
    expect(grammar.defaults.mode).toBe('off');
  });

  it('is eligible for English prose only', () => {
    expect(grammar.eligible?.(ctx('What curent changes in git?'), cfg)).toBe(true);
    expect(grammar.eligible?.(ctx('ok'), cfg)).toBe(false);
    expect(grammar.eligible?.(ctx('/review src/a.ts'), cfg)).toBe(false);
    expect(grammar.eligible?.(ctx('#assist grammar now'), cfg)).toBe(false);
    expect(grammar.eligible?.(ctx('ช่วยแก้บั๊กนี้ให้หน่อยครับ ใน src/a.ts'), cfg)).toBe(false);
  });

  it('does not count code, paths and URLs as English words', () => {
    expect(looksEnglish('`src/acp/a.ts` https://x.dev/y')).toBe(false);
    expect(looksEnglish('please fix `fooBar` in src/a.ts')).toBe(true);
  });

  it('sends the newest user prompt verbatim', () => {
    expect(grammar.payload(ctx('I want assist agent do grammer check'), cfg)).toBe(
      'I want assist agent do grammer check',
    );
  });

  it('renders in the rail panel, not the composer strip', () => {
    expect(grammar.surface).toBe('panel');
  });

  it('maps a correct prompt to a clean check', () => {
    expect(grammar.parse('{"ok":true}', cfg)).toEqual({ corrected: null, fixes: [] });
  });

  it('maps a correction to the corrected prompt and its fixes', () => {
    const raw = '```json\n{"ok":false,"corrected":"What are the current changes in git?",'
      + '"fixes":["curent → current","What → What are"]}\n```';
    expect(grammar.parse(raw, cfg)).toEqual({
      corrected: 'What are the current changes in git?',
      fixes: ['curent → current', 'What → What are'],
    });
  });

  it('rejects replies that are not the contract', () => {
    expect(grammar.parse('looks fine to me', cfg)).toBeNull();
    expect(grammar.parse('{"ok":false}', cfg)).toBeNull();
    expect(grammar.parse('{"corrected":"x"}', cfg)).toBeNull();
  });
});
