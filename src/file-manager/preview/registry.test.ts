// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { dir, entry } from '../test-fixtures';
import type { FileEntry } from '../types';
import { readError, renderPreview, type PreviewIO, type PreviewRenderer, type PreviewTarget } from './registry';

const cursor = (e: FileEntry): PreviewTarget => ({ source: 'cursor', path: e.path, name: e.name, entry: e, showHidden: false });
const search = (path: string): PreviewTarget => ({ source: 'search', path, name: path.split('/').pop()!, entry: null, showHidden: false });

function io(text: string | Error, children: FileEntry[] | Error = []): PreviewIO & { reads: number } {
  const o = {
    reads: 0,
    readText: vi.fn(async () => {
      o.reads++;
      if (text instanceof Error) throw text;
      return text;
    }),
    listDirectory: vi.fn(async () => {
      if (children instanceof Error) throw children;
      return children;
    }),
  };
  return o;
}

describe('renderPreview — cursor source', () => {
  it('directory summary and unreadable directory', async () => {
    expect(await renderPreview(cursor(dir('src')), io('', [dir('a'), entry('b'), entry('c')])))
      .toEqual({ kind: 'text', text: 'Directory: src/\n\n1 directories, 2 files' });
    expect(await renderPreview(cursor(dir('src')), io('', new Error('x'))))
      .toEqual({ kind: 'text', text: 'Directory: src/\n\n(cannot read)' });
  });

  it('too large and binary never read the file', async () => {
    const i = io('nope');
    expect(await renderPreview(cursor(entry('big.ts', { size: 70000 })), i))
      .toEqual({ kind: 'text', text: 'File too large for preview\n68.4K' });
    expect(await renderPreview(cursor(entry('a.png', { size: 2048 })), i))
      .toEqual({ kind: 'text', text: 'Binary file\n2.0K' });
    expect(i.reads).toBe(0);
  });

  it('skill by path, skill by frontmatter, frontmatter card, plain markdown', async () => {
    const byPath = await renderPreview(cursor(entry('SKILL.md')), io('---\nname: s\n---\nbody'));
    expect(byPath.kind).toBe('markdown');
    expect((byPath as { html: string }).html).toContain('Claude Code Skill');

    const byFm = await renderPreview(cursor(entry('a.md')), io('---\nname: n\ndescription: d\nallowed-tools: Read\n---\nx'));
    expect((byFm as { html: string }).html).toContain('Claude Code Skill');

    const card = await renderPreview(cursor(entry('a.md')), io('---\ntitle: T\n---\nx'));
    expect((card as { html: string }).html).toContain('>Frontmatter<');

    expect(await renderPreview(cursor(entry('a.md')), io('# Hi'))).toEqual({ kind: 'markdown', html: '<h1>Hi</h1>\n' });
  });

  it('reads the file at most once per request', async () => {
    const i = io('---\ntitle: T\n---\nx');
    await renderPreview(cursor(entry('a.md')), i);
    expect(i.reads).toBe(1);
  });

  it('code with a known language, highlightAuto otherwise', async () => {
    const ts = await renderPreview(cursor(entry('a.ts')), io('const a = 1;'));
    expect(ts.kind).toBe('html');
    expect((ts as { html: string }).html).toContain('hljs-keyword');
    expect((await renderPreview(cursor(entry('a.unknownext')), io('hello'))).kind).toBe('html');
  });

  it('a read error becomes readError', async () => {
    const t = cursor(entry('a.ts', { size: 10 }));
    expect(await renderPreview(t, io(new Error('x')))).toEqual({ kind: 'text', text: 'Cannot read file\n10B' });
    expect(readError(t)).toEqual({ kind: 'text', text: 'Cannot read file\n10B' });
  });
});

describe('renderPreview — search source', () => {
  it('binary, truncation, plain text and read error (P6)', async () => {
    expect(await renderPreview(search('/r/a.png'), io('x'))).toEqual({ kind: 'text', text: '[binary file]' });
    const long = Array.from({ length: 250 }, (_, i) => `l${i}`).join('\n');
    const out = await renderPreview(search('/r/notes.unknownext'), io(long));
    expect(out).toEqual({
      kind: 'text',
      text: Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n') + '\n\n... (truncated)',
    });
    expect(await renderPreview(search('/r/a.ts'), io(new Error('x')))).toEqual({ kind: 'text', text: '[cannot read file]' });
  });

  it('has no size limit and no directory summary', async () => {
    const out = await renderPreview(search('/r/a.ts'), io('const a = 1;'));
    expect(out.kind).toBe('html');
  });
});

describe('custom registries', () => {
  it('order is priority and a renderer may decline', async () => {
    const decline: PreviewRenderer = { id: 'd', sources: ['cursor'], matches: () => true, render: () => null };
    const img: PreviewRenderer = { id: 'img', sources: ['cursor'], matches: (t) => t.name.endsWith('.png'), render: () => ({ kind: 'text', text: 'IMG' }) };
    expect(await renderPreview(cursor(entry('a.png')), io(''), [decline, img])).toEqual({ kind: 'text', text: 'IMG' });
    expect(await renderPreview(cursor(entry('a.txt')), io(''), [decline, img])).toEqual({ kind: 'text', text: '' });
  });
});
