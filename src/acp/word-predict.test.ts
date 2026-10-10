import { describe, expect, it } from 'vitest';

import { WordModel } from './word-predict-model';
import { acceptGhost, ghostRequestable, typeThrough, type GhostSuggestion } from './word-predict';

function modelOf(...texts: string[]): WordModel {
  const model = new WordModel();
  for (const text of texts) model.observe(text);
  return model;
}

describe('WordModel.complete', () => {
  it('completes the word at the end of the text with the learned surface form', () => {
    const model = modelOf('Thai language', 'Thai language support', 'TypeScript types', 'TypeScript');
    expect(model.complete('write thai la')).toBe('nguage');
    expect(model.complete('use Ty')).toBe('peScript');
  });

  it('stays silent for one-letter prefixes, mid-word cursors, and unseen words', () => {
    const model = modelOf('language language language');
    expect(model.complete('l')).toBeNull();
    expect(model.complete('la ')).toBeNull();
    expect(model.complete('zz')).toBeNull();
  });

  it('needs repeated evidence and a clear lead', () => {
    expect(modelOf('language').complete('la')).toBeNull();
    expect(modelOf('language layout', 'language layout').complete('la')).toBeNull();
    expect(modelOf('language language layout').complete('la')).toBe('nguage');
  });

  it('does not extend a prefix that is itself the dominant finished word', () => {
    const model = modelOf('the the the the the then');
    expect(model.complete('the')).toBeNull();
  });

  it('lets the previous word break a tie between candidates', () => {
    const model = modelOf('push the branch', 'pull request', 'push it', 'pull it', 'git push', 'git push');
    expect(model.complete('git pu')).toBe('sh');
  });

  it('does not carry context across sentence breaks', () => {
    const model = modelOf('git push', 'git push', 'pull request', 'pull request', 'pull request');
    expect(model.complete('git. pu')).toBe('ll');
  });

  it('completes Thai words written without spaces', () => {
    const model = modelOf('ช่วยแก้ภาษาไทยให้หน่อย', 'ภาษาไทยอ่านง่าย', 'ทดสอบภาษาไทย');
    expect(model.complete('ช่วยแก้ภาษ')).toBe('า');
    expect(model.complete('ภาษาไท')).toBe('ย');
  });

  it('learns words observed after the first completion', () => {
    const model = modelOf('alpha alpha');
    expect(model.complete('kryp')).toBeNull();
    model.observe('krypton krypton');
    expect(model.complete('kryp')).toBe('ton');
  });
});

describe('ghost helpers', () => {
  it('requests only at a line end right after a word character', () => {
    expect(ghostRequestable('fix la', 6)).toBe(true);
    expect(ghostRequestable('fix la\nnext', 6)).toBe(true);
    expect(ghostRequestable('fix la', 4)).toBe(false);
    expect(ghostRequestable('fix la ', 7)).toBe(false);
    expect(ghostRequestable('', 0)).toBe(false);
    expect(ghostRequestable('ภาษ', 3)).toBe(true);
  });

  it('Tab appends a space only for space-delimited scripts; → never does', () => {
    expect(acceptGhost('thai la', 7, 'nguage', true)).toEqual({ draft: 'thai language ', cursor: 14 });
    expect(acceptGhost('thai la', 7, 'nguage', false)).toEqual({ draft: 'thai language', cursor: 13 });
    expect(acceptGhost('ภาษ', 3, 'า', true)).toEqual({ draft: 'ภาษา', cursor: 4 });
    expect(acceptGhost('a la\nb', 4, 'nguage', true)).toEqual({ draft: 'a language \nb', cursor: 11 });
  });

  it('typing the ghost’s next characters shrinks it; anything else drops it', () => {
    const ghost: GhostSuggestion = { laneId: 'l1', draft: 'la', cursor: 2, suffix: 'nguage' };
    expect(typeThrough(ghost, 'lan', 3)).toEqual({ laneId: 'l1', draft: 'lan', cursor: 3, suffix: 'guage' });
    expect(typeThrough(ghost, 'lang', 4)?.suffix).toBe('uage');
    expect(typeThrough(ghost, 'lax', 3)).toBeNull();
    expect(typeThrough(ghost, 'l', 1)).toBeNull();
    expect(typeThrough(ghost, 'language', 8)).toBeNull();
    expect(typeThrough({ ...ghost, draft: 'la\nx' }, 'lan\ny', 3)).toBeNull();
  });
});
