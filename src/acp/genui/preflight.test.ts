import { describe, expect, it } from 'vitest';

import { formatUiFailure, preflightUiReply, UI_REPLY_MAX_CHARS } from './preflight';

const fence = '\x60\x60\x60';
const valid = `${fence}krypton-ui\nversion 2\nCard("Ready", [Text("hello")])\n${fence}`;

describe('preflightUiReply', () => {
  it('accepts a complete UI and a prose opt-out', () => {
    expect(preflightUiReply(valid)).toEqual({
      kind: 'valid',
      source: 'version 2\nCard("Ready", [Text("hello")])',
    });
    expect(preflightUiReply('A panel would not help here.')).toEqual({ kind: 'prose' });
    expect(preflightUiReply('Use \x60code\x60 inline.')).toEqual({ kind: 'prose' });
  });

  it('returns compiler diagnostics for invalid syntax and catalog names', () => {
    const syntax = preflightUiReply(`${fence}krypton-ui\nCard(\n${fence}`);
    expect(syntax.kind).toBe('invalid');
    if (syntax.kind === 'invalid') expect(syntax.diagnostics[0]).toMatch(/line .*:/);
    const catalog = preflightUiReply(`${fence}krypton-ui\nUnknownWidget("x")\n${fence}`);
    expect(catalog.kind).toBe('invalid');
  });

  it('rejects broken envelopes and empty replies', () => {
    for (const reply of [
      '',
      `${fence}ui\nCard("x", [])\n${fence}`,
      `${fence}krypton-ui\nCard("x", [])`,
      `${fence}krypton-ui\n\n${fence}`,
      `${valid}\n${valid}`,
      `    ${fence}krypton-ui\nCard("x", [])\n${fence}`,
      `Here is ${fence}krypton-ui Card("x", [])`,
      'Card("x", [Text("y")])',
    ]) {
      expect(preflightUiReply(reply).kind, reply).toBe('invalid');
    }
  });

  it('caps a complete reply', () => {
    const result = preflightUiReply('x'.repeat(UI_REPLY_MAX_CHARS + 1));
    expect(result).toEqual({
      kind: 'invalid',
      diagnostics: [`reply exceeds ${UI_REPLY_MAX_CHARS} characters`],
    });
  });

  it('uses a longer plain-text fence when failed source contains backticks', () => {
    const failure = formatUiFailure(`bad\n${fence}krypton-ui\ntext`, 'line 2: invalid');
    expect(failure).toContain('line 2: invalid');
    expect(failure).toContain(`${fence}${fence[0]}text`);
    expect(failure).toContain(`bad\n${fence}krypton-ui\ntext`);
  });
});
