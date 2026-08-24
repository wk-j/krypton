import { describe, expect, it } from 'vitest';

import type { ToolPayload } from './harness-view-types';
import {
  extractGrepQuery,
  grepHitNeedles,
  isGrepLikeOutput,
  parseGrepDump,
  parseGrepLine,
  renderGrepSection,
  renderToolBody,
  renderToolOutput,
  toolChipKind,
  toolSectionTone,
  unwrapWorkspaceResultDump,
} from './harness-tool-render';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  children: FakeEl[];
  appendChild(child: FakeEl): FakeEl;
}

function makeFakeEl(tag: string): FakeEl {
  return {
    tagName: tag,
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    appendChild(child: FakeEl): FakeEl {
      this.children.push(child);
      return child;
    },
  };
}

function withDom<T>(fn: () => T): T {
  const prev = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => makeFakeEl(tag),
    createTextNode: (text: string) => {
      const node = makeFakeEl('#text');
      node.textContent = text;
      return node;
    },
  };
  try {
    return fn();
  } finally {
    (globalThis as { document?: unknown }).document = prev;
  }
}

function findClass(el: FakeEl, className: string): FakeEl | undefined {
  if (el.className.split(/\s+/).includes(className)) return el;
  for (const child of el.children) {
    const hit = findClass(child, className);
    if (hit) return hit;
  }
  return undefined;
}

function collectClasses(el: FakeEl): string[] {
  return [el.className, ...el.children.flatMap(collectClasses)].filter(Boolean);
}

function payload(over: Partial<ToolPayload> = {}): ToolPayload {
  return {
    glyph: '✓',
    status: 'completed',
    kind: 'execute',
    subject: 'grep -n "class"',
    command: 'grep -n "class"',
    result: '',
    sections: [],
    diffs: [],
    ...over,
  };
}

describe('toolChipKind', () => {
  it('maps inferred labels onto HUD kinds', () => {
    expect(toolChipKind('execute')).toBe('execute');
    expect(toolChipKind('bash')).toBe('execute');
    expect(toolChipKind('search')).toBe('search');
    expect(toolChipKind('grep')).toBe('search');
    expect(toolChipKind('rg')).toBe('search');
    expect(toolChipKind('edit')).toBe('edit');
    expect(toolChipKind('write')).toBe('edit');
    expect(toolChipKind('read')).toBe('read');
    expect(toolChipKind('fetch')).toBe('fetch');
    expect(toolChipKind('delete')).toBe('delete');
    expect(toolChipKind('rename')).toBe('move');
    expect(toolChipKind('memory_get')).toBe('other');
    expect(toolChipKind('')).toBe('other');
  });
});

describe('toolSectionTone', () => {
  it('paints stdout/output/content as output, not a cyan content bucket', () => {
    expect(toolSectionTone('stdout')).toBe('output');
    expect(toolSectionTone('output')).toBe('output');
    expect(toolSectionTone('text')).toBe('output');
    expect(toolSectionTone('content')).toBe('output');
    expect(toolSectionTone('stderr')).toBe('error');
  });
});

describe('extractGrepQuery / grepHitNeedles', () => {
  it('reads the first quoted arg after grep flags', () => {
    expect(extractGrepQuery('grep -n "class \\|public"')).toBe('class \\|public');
    expect(extractGrepQuery("rg -n --hidden 'foo bar' src")).toBe('foo bar');
    expect(extractGrepQuery('grep -e "SearchService" file.java')).toBe('SearchService');
    expect(extractGrepQuery('grep class file.java')).toBe('');
  });

  it('splits grep OR into literal needles of length >= 2', () => {
    expect(grepHitNeedles('class \\|public')).toEqual(['class', 'public']);
    expect(grepHitNeedles('a|bb')).toEqual(['bb']);
  });
});

describe('parseGrepLine / parseGrepDump', () => {
  it('splits path:line:text and path:line:col:text', () => {
    expect(parseGrepLine('SearchService.java:60:public class SearchService {')).toEqual({
      path: 'SearchService.java',
      line: '60',
      text: 'public class SearchService {',
      context: false,
    });
    expect(parseGrepLine('src/acp/foo.ts:12:4:  const x = 1;')).toEqual({
      path: 'src/acp/foo.ts',
      line: '12:4',
      text: '  const x = 1;',
      context: false,
    });
  });

  it('splits single-file grep -n and context hyphens', () => {
    expect(parseGrepLine('40:  * Search documents')).toEqual({
      path: null,
      line: '40',
      text: '  * Search documents',
      context: false,
    });
    expect(parseGrepLine('38-  * nearby')).toEqual({
      path: null,
      line: '38',
      text: '  * nearby',
      context: true,
    });
    expect(parseGrepLine('src/a.ts-12- context')).toEqual({
      path: 'src/a.ts',
      line: '12',
      text: ' context',
      context: true,
    });
  });

  it('does not treat error prefixes or hyphenated words as paths', () => {
    expect(parseGrepLine('error: 12: boom')).toBeNull();
    expect(parseGrepLine('foo-12-bar')).toBeNull();
  });

  it('returns null when a majority of lines are not grep-shaped', () => {
    expect(parseGrepDump('cargo test\nrunning 3 tests\nsrc/a.ts:1: hit')).toBeNull();
    expect(parseGrepDump('40: hit\n128: other')).toHaveLength(2);
  });

  it('unwraps Grok workspace_result XML and grouped path headers', () => {
    const xml =
      '<workspace_result workspace_path="/Users/wk/Source/krypton">\n' +
      'Found 2 matching lines\n' +
      '/Users/wk/Source/krypton/src/acp/client.ts\n' +
      '267:          case \'agent_thought_chunk\':\n' +
      '270:          case \'tool_call\':\n' +
      '</workspace_result>';
    const rows = parseGrepDump(xml);
    expect(rows).toEqual([
      {
        path: '/Users/wk/Source/krypton/src/acp/client.ts',
        line: '267',
        text: "          case 'agent_thought_chunk':",
        context: false,
      },
      {
        path: '/Users/wk/Source/krypton/src/acp/client.ts',
        line: '270',
        text: "          case 'tool_call':",
        context: false,
      },
    ]);
  });
});

describe('unwrapWorkspaceResultDump', () => {
  it('strips the Grok search envelope and leaves a clean no-match line', () => {
    expect(
      unwrapWorkspaceResultDump(
        '<workspace_result workspace_path="/Users/wk/Source/krypton">\n' +
          'No matches found\n' +
          '</workspace_result>',
      ),
    ).toBe('No matches found');
  });

  it('leaves non-XML dumps alone', () => {
    expect(unwrapWorkspaceResultDump('src/a.ts:1: hit')).toBe('src/a.ts:1: hit');
  });
});

describe('isGrepLikeOutput', () => {
  it('fires for search kind and execute wrapping grep/rg', () => {
    expect(isGrepLikeOutput(payload({ kind: 'search', command: '', subject: 'foo' }), { label: 'output' })).toBe(true);
    expect(isGrepLikeOutput(payload({ kind: 'execute', command: 'rg foo', subject: 'rg foo' }), { label: 'stdout' })).toBe(true);
    expect(isGrepLikeOutput(payload({ kind: 'execute', command: 'ls', subject: 'ls' }), { label: 'output' })).toBe(false);
    expect(isGrepLikeOutput(payload({ kind: 'search' }), { label: 'stderr' })).toBe(false);
  });
});

describe('renderToolBody / renderToolOutput (spec 235)', () => {
  it('stamps data-kind on the chip from the HUD map', () => {
    const body = withDom(() => {
      const el = makeFakeEl('div');
      renderToolBody(el as unknown as HTMLElement, payload({ kind: 'search' }));
      return el;
    });
    const chip = findClass(body, 'acp-harness__tool-kind');
    expect(chip?.dataset.kind).toBe('search');
    expect(chip?.textContent).toBe('search');
  });

  it('renders grep structure tokens instead of a plain pre', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'execute',
        command: 'grep -n "class"',
        subject: 'grep -n "class"',
        sections: [{
          label: 'output',
          text: 'SearchService.java:60:public class SearchService {\nSearchService.java:87:  public SearchResultDTO searchStorage()',
        }],
      })) as unknown as FakeEl;
    });
    const classes = collectClasses(out).join(' ');
    expect(classes).toContain('acp-harness__tool-rich--grep');
    expect(classes).toContain('acp-harness__tok-path');
    expect(classes).toContain('acp-harness__tok-line');
    expect(classes).toContain('acp-harness__tok-hit');
    expect(classes).not.toContain('acp-harness__tool-section-text');
  });

  it('does not paint Grok workspace_result XML on a search miss', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'search',
        command: '',
        subject: 'border-radius',
        sections: [{
          label: 'stdout',
          text:
            '<workspace_result workspace_path="/Users/wk/Source/krypton">\n' +
            'No matches found\n' +
            '</workspace_result>',
        }],
      })) as unknown as FakeEl;
    });
    const pre = findClass(out, 'acp-harness__tool-section-text');
    expect(pre?.textContent).toBe('No matches found');
    expect(pre?.textContent).not.toContain('workspace_result');
  });

  it('falls back to a plain pre when the dump is not grep-shaped', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'execute',
        command: 'grep -n "class"',
        sections: [{ label: 'output', text: 'not a match dump\nstill a banner' }],
      })) as unknown as FakeEl;
    });
    expect(collectClasses(out).join(' ')).toContain('acp-harness__tool-section-text');
    expect(collectClasses(out).join(' ')).not.toContain('acp-harness__tool-rich--grep');
  });

  it('does not highlight hits on rg context lines', () => {
    const section = withDom(() => {
      return renderGrepSection(
        { command: 'rg -n "class" src', subject: 'rg -n "class" src' },
        { label: 'output', text: 'src/a.ts-12- nearby class\nsrc/a.ts:13: public class Foo' },
      ) as unknown as FakeEl;
    });
    const ctx = findClass(section, 'acp-harness__grep-row--ctx');
    expect(ctx).toBeTruthy();
    expect(collectClasses(ctx!).join(' ')).not.toContain('acp-harness__tok-hit');
  });
});
