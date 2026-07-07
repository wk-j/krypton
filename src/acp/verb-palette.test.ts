import { describe, expect, it } from 'vitest';

import { injectableVerbNames } from './verb-registry';
import { applyVerbSelection, filteredVerbNames, verbPaletteContext } from './verb-palette';

// cursor helper: place the cursor at end of `draft` unless a caret index is given.
const ctxAt = (draft: string, cursor = draft.length): ReturnType<typeof verbPaletteContext> =>
  verbPaletteContext(draft, cursor);

describe('verbPaletteContext', () => {
  it('detects a #token at the start of the draft', () => {
    expect(ctxAt('#ana')).toEqual({ hashIndex: 0, prefix: 'ana' });
  });

  it('detects a #token in the MIDDLE of a prompt', () => {
    expect(ctxAt('focus on auth then #ana')).toEqual({ hashIndex: 19, prefix: 'ana' });
  });

  it('detects a bare # with an empty prefix', () => {
    expect(ctxAt('do this #')).toEqual({ hashIndex: 8, prefix: '' });
  });

  it('detects a #token being typed inside a half-typed {{#', () => {
    expect(ctxAt('x {{#ana')).toEqual({ hashIndex: 4, prefix: 'ana' });
  });

  it('does NOT trigger when # is glued to a preceding word (issue#42, a#b)', () => {
    expect(ctxAt('issue#42')).toBeNull();
    expect(ctxAt('a#b')).toBeNull();
  });

  it('does NOT trigger when the token is not at the cursor', () => {
    // cursor is at index 5 ("focus"), the #token is later — nothing at the cursor
    expect(verbPaletteContext('focus then #ana', 5)).toBeNull();
  });

  it('uses only the text before the cursor for the prefix', () => {
    // cursor sits right after "#an" inside "#analyze"
    expect(verbPaletteContext('run #analyze now', 7)).toEqual({ hashIndex: 4, prefix: 'an' });
  });
});

describe('filteredVerbNames', () => {
  const names = ['analyze-github-issue', 'fix-github-issue', 'post-github-comment', 'tag-github-issue'];

  it('prefix-matches case-insensitively and sorts', () => {
    expect(filteredVerbNames(names, 'a')).toEqual(['analyze-github-issue']);
    expect(filteredVerbNames(names, 'A')).toEqual(['analyze-github-issue']);
  });

  it('returns all names for an empty prefix', () => {
    expect(filteredVerbNames(names, '')).toEqual([...names].sort());
  });

  it('returns nothing for a non-matching prefix', () => {
    expect(filteredVerbNames(names, 'zzz')).toEqual([]);
  });

  it('only offers real injectable verbs (create/dispatch are excluded)', () => {
    const real = injectableVerbNames();
    expect(real).toContain('analyze-github-issue');
    expect(real).not.toContain('create-github-issue');
    expect(real).not.toContain('dispatch-github-issue');
  });
});

describe('applyVerbSelection', () => {
  it('replaces a mid-prompt #token with the {{#name}} injection token', () => {
    const out = applyVerbSelection('focus then #ana', 15, 'analyze-github-issue');
    expect(out.draft).toBe('focus then {{#analyze-github-issue}}');
    expect(out.cursor).toBe(out.draft.length);
  });

  it('keeps text that follows the cursor', () => {
    const draft = 'do #ana now';
    const out = applyVerbSelection(draft, 7, 'analyze-github-issue');
    expect(out.draft).toBe('do {{#analyze-github-issue}} now');
    // cursor lands right after the inserted token, before " now"
    expect(out.draft.slice(out.cursor)).toBe(' now');
  });

  it('absorbs an already-typed {{ so it never doubles the braces', () => {
    const draft = 'x {{#ana';
    const out = applyVerbSelection(draft, draft.length, 'fix-github-issue');
    expect(out.draft).toBe('x {{#fix-github-issue}}');
    expect(out.draft).not.toContain('{{{{');
  });

  it('completes a bare # at the start', () => {
    const out = applyVerbSelection('#', 1, 'tag-github-issue');
    expect(out.draft).toBe('{{#tag-github-issue}}');
  });

  it('swallows the token suffix when accepting with the cursor mid-token', () => {
    // cursor sits after "#an" inside "#analyze"; the trailing "alyze" must NOT survive
    const draft = 'run #analyze please';
    const out = applyVerbSelection(draft, 7, 'analyze-github-issue');
    expect(out.draft).toBe('run {{#analyze-github-issue}} please');
    expect(out.draft).not.toContain('alyze}}');
  });

  it('absorbs an existing closing }} when completing a pretyped {{#token}}', () => {
    // cursor inside a fully-braced token: "{{#ana|}}"
    const draft = 'x {{#ana}} y';
    const out = applyVerbSelection(draft, 8, 'analyze-github-issue');
    expect(out.draft).toBe('x {{#analyze-github-issue}} y');
    expect(out.draft).not.toContain('}}}}');
    expect(out.draft).not.toContain('{{{{');
  });

  it('does NOT absorb a stray }} when there was no leading {{', () => {
    // a bare "#ana" not wrapped in braces: a following "}}" is unrelated text, keep it
    const draft = 'see #ana}} stays';
    const out = applyVerbSelection(draft, 8, 'analyze-github-issue');
    expect(out.draft).toBe('see {{#analyze-github-issue}}}} stays');
  });
});
