import { describe, expect, it } from 'vitest';

import { VerbCompositionError, hasVerbTokens, resolveVerbTokens } from './verb-compose';
import { injectableVerbPrompt } from './verb-registry';

/** A small fixed verb table for the tests. */
const table: Record<string, string> = {
  a: 'ALPHA',
  b: 'BETA',
  wrap: 'before {{#a}} after',
  nest: 'x {{#wrap}} y', // wrap itself expands {{#a}}
  selfcycle: 'loop {{#selfcycle}}',
  ping: '{{#pong}}',
  pong: '{{#ping}}',
};
const lookup = (name: string): string | undefined => table[name];

describe('resolveVerbTokens', () => {
  it('leaves text without tokens unchanged', () => {
    expect(resolveVerbTokens('plain prompt, no tokens', lookup)).toBe('plain prompt, no tokens');
  });

  it('substitutes a single token inline', () => {
    expect(resolveVerbTokens('start {{#a}} end', lookup)).toBe('start ALPHA end');
  });

  it('substitutes multiple tokens, including repeats', () => {
    expect(resolveVerbTokens('{{#a}} {{#b}} {{#a}}', lookup)).toBe('ALPHA BETA ALPHA');
  });

  it('recurses into a composed verb that embeds another verb', () => {
    expect(resolveVerbTokens('{{#nest}}', lookup)).toBe('x before ALPHA after y');
  });

  it('throws on an unknown / non-injectable verb', () => {
    expect(() => resolveVerbTokens('{{#missing}}', lookup)).toThrow(VerbCompositionError);
  });

  it('throws on a direct self-cycle', () => {
    expect(() => resolveVerbTokens('{{#selfcycle}}', lookup)).toThrow(/cyclic/);
  });

  it('throws on an indirect cycle (ping ↔ pong)', () => {
    expect(() => resolveVerbTokens('{{#ping}}', lookup)).toThrow(VerbCompositionError);
  });

  it('throws when nesting exceeds maxDepth', () => {
    const deep: Record<string, string> = { l0: '{{#l1}}', l1: '{{#l2}}', l2: '{{#l3}}', l3: 'end' };
    expect(() => resolveVerbTokens('{{#l0}}', (n) => deep[n], { maxDepth: 2 })).toThrow(/too deep/);
  });

  it('does not treat a bare #token (no braces) as a verb token', () => {
    expect(resolveVerbTokens('see #a for details', lookup)).toBe('see #a for details');
  });
});

describe('hasVerbTokens', () => {
  it('detects a token', () => {
    expect(hasVerbTokens('x {{#a}} y')).toBe(true);
  });

  it('is false without a token', () => {
    expect(hasVerbTokens('x #a y {{a}} {{a#}}')).toBe(false);
  });
});

// spec 191: inline verb injection into a free-form user prompt uses the SAME
// registry + resolver as composed verbs. These assert that a real registered verb
// expands when embedded at an arbitrary position of the user's prose.
describe('inline verb injection (real registry)', () => {
  const expand = (text: string): string => resolveVerbTokens(text, injectableVerbPrompt);

  it('expands a verb token embedded mid-prompt', () => {
    const out = expand('Please handle this for me: {{#analyze-github-issue}} — thanks!');
    expect(out).toContain('Please handle this for me:');
    expect(out).toContain('thanks!');
    // the analyze verb's rendered prompt (no ref → back-reference variant) is spliced in
    expect(out).toContain('the GitHub issue you are working on');
    expect(out).not.toContain('{{#analyze-github-issue}}');
  });

  it('expands multiple different verbs in one prompt', () => {
    const out = expand('first {{#fix-github-issue}} then {{#post-github-comment}}');
    expect(out).toContain('Fix the GitHub issue you are working on');
    expect(out).toContain('Post a comment on the GitHub issue you are working on');
  });

  it('throws on a non-injectable / unknown verb in a user prompt', () => {
    // control-op verbs (e.g. dispatch) and creation verbs are absent from the registry
    expect(() => expand('do {{#dispatch-github-issue}} now')).toThrow(VerbCompositionError);
    expect(() => expand('do {{#create-github-issue}} now')).toThrow(VerbCompositionError);
  });
});
