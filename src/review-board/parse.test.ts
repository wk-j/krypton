import { describe, expect, it } from 'vitest';

import {
  answerableBlocks,
  blockIdHash,
  parseBlockBody,
  parseReviewDocument,
  parseWalkthroughAnchor,
  reattachBlockId,
  walkthroughStepCount,
} from './parse';
import type { ReviewBlock } from '../acp/types';

// spec 211 — the parser's two contracts: it never throws and never drops a
// block (a malformed typed fence degrades to a diagnostic-carrying `markdown`
// block, so half a review still beats none), and block ids stay stable across
// lane iterations so the human's answers re-attach.

/** Find the single block of a kind, failing loudly when the count is wrong. */
function only<K extends ReviewBlock['kind']>(
  blocks: readonly ReviewBlock[],
  kind: K,
): Extract<ReviewBlock, { kind: K }> {
  const matches = blocks.filter((b): b is Extract<ReviewBlock, { kind: K }> => b.kind === kind);
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('parseBlockBody', () => {
  it('reads flat scalars and strips one layer of quotes', () => {
    const { values, stray } = parseBlockBody('title: read it in this order\nkind: "bar"\nn: 3');
    expect(values.get('title')).toBe('read it in this order');
    expect(values.get('kind')).toBe('bar');
    expect(values.get('n')).toBe('3');
    expect(stray).toEqual([]);
  });

  it('reads an indented list of scalars', () => {
    const { values } = parseBlockBody('options:\n  - per-target (today)\n  - global\n');
    expect(values.get('options')).toEqual(['per-target (today)', 'global']);
  });

  it('reads an indented list of maps', () => {
    const { values } = parseBlockBody('steps:\n  - at: a.ts:1\n    say: first\n  - at: b.ts:2\n    say: second\n');
    expect(values.get('steps')).toEqual([
      { at: 'a.ts:1', say: 'first' },
      { at: 'b.ts:2', say: 'second' },
    ]);
  });

  it('reads an indented map', () => {
    const { values } = parseBlockBody('data:\n  acp/: 152\n  diff-view: 41\n');
    expect(values.get('data')).toEqual({ 'acp/': '152', 'diff-view': '41' });
  });

  it('joins a wrapped continuation line onto the previous value', () => {
    const { values } = parseBlockBody('steps:\n  - at: a.ts:1\n    say: the guard map\n      one entry per target\n');
    expect(values.get('steps')).toEqual([{ at: 'a.ts:1', say: 'the guard map one entry per target' }]);
  });

  it('collects unplaceable lines as stray instead of throwing', () => {
    const { values, stray } = parseBlockBody('title: ok\nthis line has no key\n');
    expect(values.get('title')).toBe('ok');
    expect(stray).toEqual(['this line has no key']);
  });
});

describe('parseReviewDocument — frontmatter + block typing', () => {
  it('lifts the frontmatter stamp out of the block stream', () => {
    const doc = parseReviewDocument(
      '---\ntitle: Peering guard rewrite\nlane: Claude-1\nsubject: the working diff\ncreated: 2026-08-07\n---\n\nThe change moves the guard.\n',
    );
    expect(doc.title).toBe('Peering guard rewrite');
    expect(doc.laneName).toBe('Claude-1');
    expect(doc.subject).toBe('the working diff');
    // The `---` fences must not survive as an hr + heading block.
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('markdown');
    expect(doc.blocks[0].raw).toContain('The change moves the guard.');
  });

  it('emits one block per top-level token', () => {
    const doc = parseReviewDocument('# Title\n\nsome prose\n\n- a\n- b\n');
    expect(doc.blocks.map((b) => b.kind)).toEqual(['markdown', 'markdown', 'markdown']);
    expect(doc.blocks).toHaveLength(3);
  });

  it('types a walkthrough and keeps step order', () => {
    const doc = parseReviewDocument(
      '```review:walkthrough\ntitle: read it in this order\nsteps:\n  - at: src/acp/inter-lane.ts:812\n    say: the guard map\n  - at: src/acp/lane-inbox.ts:96\n    say: where the envelope lands\n```\n',
    );
    const block = only(doc.blocks, 'walkthrough');
    expect(block.data.title).toBe('read it in this order');
    expect(block.data.steps).toEqual([
      { at: 'src/acp/inter-lane.ts:812', say: 'the guard map' },
      { at: 'src/acp/lane-inbox.ts:96', say: 'where the envelope lands' },
    ]);
    expect(block.diagnostic).toBeUndefined();
  });

  it('types a finding and pulls in the prose that follows it', () => {
    const doc = parseReviewDocument(
      '```review:finding\nseverity: blocking\nfile: src/acp/inter-lane.ts\nline: 835\ntitle: guard is set after the await\n```\nA second peer_send can enter between the check and the set.\n',
    );
    const block = only(doc.blocks, 'finding');
    expect(block.data).toMatchObject({
      severity: 'blocking',
      file: 'src/acp/inter-lane.ts',
      line: 835,
      title: 'guard is set after the await',
    });
    expect(block.data.detail).toContain('A second peer_send');
    // The prose still renders as its own block — the card only mirrors it.
    expect(doc.blocks.filter((b) => b.kind === 'markdown')).toHaveLength(1);
  });

  it('types a decision, carries the recommendation, and caps options at 9', () => {
    const doc = parseReviewDocument(
      '```review:decision\nquestion: per-target or global guard?\noptions:\n  - per-target (today)\n  - global\nrecommended: 2\n```\n',
    );
    const block = only(doc.blocks, 'decision');
    expect(block.data.question).toBe('per-target or global guard?');
    expect(block.data.options).toEqual(['per-target (today)', 'global']);
    expect(block.data.recommended).toBe(2);

    const many = parseReviewDocument(
      `\`\`\`review:decision\nquestion: pick\noptions:\n${Array.from({ length: 12 }, (_, i) => `  - option ${i + 1}`).join('\n')}\n\`\`\`\n`,
    );
    const capped = only(many.blocks, 'decision');
    expect(capped.data.options).toHaveLength(9);
    expect(capped.diagnostic).toContain('first 9 options');
  });

  it('types a chart from a data map and from a list of maps', () => {
    const fromMap = only(
      parseReviewDocument('```review:chart\nkind: bar\ntitle: lines changed\ndata:\n  acp/: 152\n  diff-view: 41\n```\n').blocks,
      'chart',
    );
    expect(fromMap.data.kind).toBe('bar');
    expect(fromMap.data.data).toEqual([
      { label: 'acp/', value: 152 },
      { label: 'diff-view', value: 41 },
    ]);

    const fromList = only(
      parseReviewDocument('```review:chart\ndata:\n  - label: acp/\n    value: 152\n```\n').blocks,
      'chart',
    );
    expect(fromList.data.data).toEqual([{ label: 'acp/', value: 152 }]);
    // No `kind:` defaults to bar, silently — bar is the honest default shape.
    expect(fromList.data.kind).toBe('bar');
    expect(fromList.diagnostic).toBeUndefined();
  });

  it('types metrics as ordered label/value rows', () => {
    const block = only(
      parseReviewDocument('```review:metrics\nfiles: 6 changed, +214 / -38\nnew deps: none\n```\n').blocks,
      'metrics',
    );
    expect(block.data.rows).toEqual([
      { label: 'files', value: '6 changed, +214 / -38' },
      { label: 'new deps', value: 'none' },
    ]);
  });

  it('types a bare ```diff fence as a diff block', () => {
    const block = only(parseReviewDocument('```diff\n@@ -1,2 +1,2 @@\n-a\n+b\n```\n').blocks, 'diff');
    expect(block.data.unified).toBe('@@ -1,2 +1,2 @@\n-a\n+b');
  });

  it('leaves an ordinary code fence as markdown with no diagnostic', () => {
    const doc = parseReviewDocument('```ts\nconst a = 1;\n```\n');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('markdown');
    expect(doc.blocks[0].diagnostic).toBeUndefined();
  });
});

describe('parseReviewDocument — degradation', () => {
  it('degrades a malformed typed block to markdown with a diagnostic', () => {
    const doc = parseReviewDocument('```review:finding\nseverity: blocking\n```\n');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('markdown');
    expect(doc.blocks[0].diagnostic).toContain('title');
    // Never dropped: the raw source is still there to read.
    expect(doc.blocks[0].raw).toContain('severity: blocking');
  });

  it('degrades an unknown review:* kind but keeps it forward-compatible', () => {
    const doc = parseReviewDocument('```review:hologram\nsomething new\n```\n');
    expect(doc.blocks[0].kind).toBe('markdown');
    expect(doc.blocks[0].diagnostic).toContain('review:hologram');
  });

  it('keeps a partially-valid block and reports the problem as a chip', () => {
    const block = only(
      parseReviewDocument('```review:finding\nseverity: catastrophic\ntitle: something\nline: later\n```\n').blocks,
      'finding',
    );
    expect(block.data.severity).toBe('non-blocking');
    expect(block.data.line).toBeUndefined();
    expect(block.diagnostic).toContain('catastrophic');
    expect(block.diagnostic).toContain('line "later"');
  });

  it('rejects an svg block that does not open with <svg>', () => {
    const doc = parseReviewDocument('```review:svg\n<script>alert(1)</script>\n```\n');
    expect(doc.blocks[0].kind).toBe('markdown');
    expect(doc.blocks[0].diagnostic).toContain('<svg>');
  });

  it('returns no blocks for an empty document', () => {
    expect(parseReviewDocument('').blocks).toEqual([]);
    expect(parseReviewDocument('   \n\n  ').blocks).toEqual([]);
  });
});

describe('block id stability', () => {
  const doc = (src: string): ReviewBlock[] => parseReviewDocument(src).blocks;

  it('gives a block the same id across re-parses of identical source', () => {
    const src = '# Title\n\nprose\n';
    expect(doc(src).map((b) => b.id)).toEqual(doc(src).map((b) => b.id));
  });

  it('keeps a block id when unrelated text elsewhere changes', () => {
    const before = doc('# Title\n\nfirst\n\nsecond\n');
    const after = doc('# Title CHANGED\n\nfirst\n\nsecond\n');
    // The edited heading gets a new id; the untouched blocks keep theirs.
    expect(after[0].id).not.toBe(before[0].id);
    expect(after[1].id).toBe(before[1].id);
    expect(after[2].id).toBe(before[2].id);
  });

  it('re-attaches an answer when a block shifts position', () => {
    const before = doc('first\n\nsecond\n');
    const after = doc('inserted above\n\nfirst\n\nsecond\n');
    const recorded = before[1].id; // "second"
    expect(after.some((b) => b.id === recorded)).toBe(false); // ordinal moved
    const reattached = reattachBlockId(recorded, after);
    expect(reattached).not.toBeNull();
    expect(blockIdHash(reattached!)).toBe(blockIdHash(recorded));
    expect(after.find((b) => b.id === reattached)?.raw).toContain('second');
  });

  it('refuses to guess when the block text is duplicated', () => {
    const before = doc('same\n');
    const after = doc('padding\n\nsame\n\nsame\n');
    expect(reattachBlockId(before[0].id, after)).toBeNull();
  });

  it('drops an answer whose block vanished', () => {
    expect(reattachBlockId('b1-deadbeef', doc('unrelated\n'))).toBeNull();
  });
});

describe('derived counts and anchors', () => {
  it('counts answerable blocks and walkthrough steps', () => {
    const blocks = parseReviewDocument(
      '```review:walkthrough\nsteps:\n  - at: a.ts:1\n    say: one\n  - at: b.ts:2\n    say: two\n```\n\n```review:finding\ntitle: f\n```\n\n```review:decision\nquestion: q\noptions:\n  - a\n  - b\n```\n',
    ).blocks;
    expect(walkthroughStepCount(blocks)).toBe(2);
    expect(answerableBlocks(blocks).map((b) => b.kind)).toEqual(['finding', 'decision']);
  });

  it('parses walkthrough anchors', () => {
    expect(parseWalkthroughAnchor('src/a.ts:812')).toEqual({ path: 'src/a.ts', line: 812, lineEnd: undefined });
    expect(parseWalkthroughAnchor('src/a.ts:812-830')).toEqual({ path: 'src/a.ts', line: 812, lineEnd: 830 });
    expect(parseWalkthroughAnchor('src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(parseWalkthroughAnchor('  ')).toBeNull();
  });

  it('treats a descending line range as a single line rather than inverting it', () => {
    expect(parseWalkthroughAnchor('a.ts:20-10')).toEqual({ path: 'a.ts', line: 20, lineEnd: undefined });
  });
});
