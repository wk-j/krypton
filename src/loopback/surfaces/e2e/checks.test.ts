import { describe, expect, it } from 'vitest';

import { resolvePointer } from './checks';

// Spec 0328 rev 5: `evidence.pointer` is an RFC 6901 JSON Pointer. Keys from a
// runner (`getWIPDocuments/POS CE date`) carry `/`, so the escapes matter.

describe('resolvePointer', () => {
  const doc = { evidence: { 'a/b': { list: [10, 20] }, 'm~n': 1, '': 'empty key' } };

  it('follows escaped keys and array indexes', () => {
    expect(resolvePointer(doc, '/evidence/a~1b/list/1')).toEqual({ found: true, value: 20 });
    expect(resolvePointer(doc, '/evidence/m~0n')).toEqual({ found: true, value: 1 });
    expect(resolvePointer(doc, '/evidence/')).toEqual({ found: true, value: 'empty key' });
    expect(resolvePointer(doc, '')).toEqual({ found: true, value: doc });
  });

  it('misses absent keys, bad indexes and pointers without a leading slash', () => {
    for (const pointer of ['/evidence/a/b', '/evidence/a~1b/list/2', '/evidence/a~1b/list/01', '/evidence/a~1b/list/-', 'evidence', '/evidence/toString']) {
      expect(resolvePointer(doc, pointer)).toEqual({ found: false });
    }
  });
});
