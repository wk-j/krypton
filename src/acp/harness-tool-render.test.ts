import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ToolPayload } from './harness-view-types';
import {
  GROK_RAW_OUTPUT_TYPES,
  mergeToolCall,
  buildToolPayload,
  extractGrepQuery,
  extractToolExit,
  extractToolExitCode,
  formatGrokFileMatches,
  grepHitNeedles,
  grokRawOutputSections,
  isGrepLikeOutput,
  parseGrepDump,
  parseGrepLine,
  patchStreamingToolBody,
  peelExitPrefix,
  renderGrepSection,
  renderToolBody,
  renderToolOutput,
  stripGrokReadLineAnchors,
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
  parent: FakeEl | null;
  appendChild(child: FakeEl): FakeEl;
  append(...children: FakeEl[]): FakeEl;
  insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
  querySelector(selector: string): FakeEl | null;
  replaceWith(next: FakeEl): void;
  remove(): void;
}

function makeFakeEl(tag: string): FakeEl {
  const el: FakeEl = {
    tagName: tag,
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    parent: null,
    appendChild(child: FakeEl): FakeEl {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    append(...children: FakeEl[]): FakeEl {
      for (const child of children) child.parent = this;
      this.children.push(...children);
      return this;
    },
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl {
      child.parent = this;
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at === -1) this.children.push(child);
      else this.children.splice(at, 0, child);
      return child;
    },
    // Supports the two shapes patchStreamingToolBody uses: ':scope > .cls'
    // (direct child) and '.cls' (descendant).
    querySelector(selector: string): FakeEl | null {
      const cls = selector.replace(':scope > ', '').replace(/^\./, '');
      if (selector.startsWith(':scope > ')) {
        return this.children.find((c) => c.className.split(/\s+/).includes(cls)) ?? null;
      }
      return findClass(this, cls) ?? null;
    },
    replaceWith(next: FakeEl): void {
      if (!this.parent) return;
      const at = this.parent.children.indexOf(this);
      if (at === -1) return;
      next.parent = this.parent;
      this.parent.children[at] = next;
      this.parent = null;
    },
    remove(): void {
      if (!this.parent) return;
      const at = this.parent.children.indexOf(this);
      if (at !== -1) this.parent.children.splice(at, 1);
      this.parent = null;
    },
  };
  // Back-reference must not show up in JSON.stringify (existing dump asserts).
  Object.defineProperty(el, 'parent', { value: null, writable: true, enumerable: false });
  return el;
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

  it('skips Grok "Found at least N matching lines" and a truncated envelope', () => {
    const xml =
      '<workspace_result workspace_path="/Users/wk/Source/krypton">\n' +
      'Found at least 67 matching lines\n' +
      '/Users/wk/Source/krypton/src/perspective-fix.ts\n' +
      '146:        ctrlKey: me.ctrlKey,\n' +
      '/Users/wk/Source/krypton/src/quick-overview.ts\n' +
      '158:    if (action && !e.metaKey && !e.ctrlKey) {';
    const rows = parseGrepDump(xml);
    expect(rows).toEqual([
      {
        path: '/Users/wk/Source/krypton/src/perspective-fix.ts',
        line: '146',
        text: '        ctrlKey: me.ctrlKey,',
        context: false,
      },
      {
        path: '/Users/wk/Source/krypton/src/quick-overview.ts',
        line: '158',
        text: '    if (action && !e.metaKey && !e.ctrlKey) {',
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

  it('strips the open tag when the line cap dropped the close tag', () => {
    expect(
      unwrapWorkspaceResultDump(
        '<workspace_result workspace_path="/Users/wk/Source/krypton">\n' +
          'Found at least 67 matching lines\n' +
          '/Users/wk/Source/krypton/src/a.ts\n' +
          '10:  hit',
      ),
    ).toBe('Found at least 67 matching lines\n/Users/wk/Source/krypton/src/a.ts\n10:  hit');
  });
});

describe('stripGrokReadLineAnchors', () => {
  it('drops first-and-every-10th-line N→ prefixes', () => {
    expect(stripGrokReadLineAnchors('1→---\nname: karpathy-guidelines\n10→license: MIT')).toBe(
      '---\nname: karpathy-guidelines\nlicense: MIT',
    );
  });

  it('leaves ordinary file text alone', () => {
    expect(stripGrokReadLineAnchors('export function foo() {\n  return 1;\n}')).toBe(
      'export function foo() {\n  return 1;\n}',
    );
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

describe('mergeToolCall', () => {
  it('keeps previous content when an update sends an empty list', () => {
    const previous = {
      toolCallId: 't1',
      content: [{ type: 'content' as const, content: { type: 'text' as const, text: 'hello' } }],
    };
    const merged = mergeToolCall(previous, {
      toolCallId: 't1',
      status: 'in_progress',
      content: [],
    });
    expect(merged.content).toEqual(previous.content);
  });

  it('takes new content when the update has blocks', () => {
    const previous = {
      toolCallId: 't1',
      content: [{ type: 'content' as const, content: { type: 'text' as const, text: 'old' } }],
    };
    const next = [{ type: 'content' as const, content: { type: 'text' as const, text: 'new' } }];
    expect(mergeToolCall(previous, { toolCallId: 't1', content: next }).content).toEqual(next);
  });
});

describe('renderToolBody / renderToolOutput (spec 235)', () => {
  it('paints a reserved spinner cell for pending and in_progress, never an empty ·', () => {
    for (const status of ['pending', 'in_progress']) {
      const body = withDom(() => {
        const el = makeFakeEl('div');
        renderToolBody(el as unknown as HTMLElement, payload({
          status,
          glyph: '·',
        }));
        return el;
      });
      const glyph = findClass(body, 'acp-harness__tool-glyph');
      const classes = glyph?.className.split(/\s+/) ?? [];
      expect(classes).toContain('acp-harness__spinner');
      expect(classes).toContain(`acp-harness__tool-glyph--${status}`);
      expect(glyph?.textContent).toBe('⠋');
    }
  });

  it('drops the spinner class on a completed glyph', () => {
    const body = withDom(() => {
      const el = makeFakeEl('div');
      renderToolBody(el as unknown as HTMLElement, payload({ status: 'completed', glyph: '✓' }));
      return el;
    });
    const glyph = findClass(body, 'acp-harness__tool-glyph');
    expect(glyph?.className.split(/\s+/)).not.toContain('acp-harness__spinner');
    expect(glyph?.textContent).toBe('✓');
  });

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

  it('does not paint a truncated Grok search envelope', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'search',
        command: '',
        subject: 'ctrlKey',
        sections: [{
          label: 'stdout',
          text:
            '<workspace_result workspace_path="/Users/wk/Source/krypton">\n' +
            'Found at least 67 matching lines\n' +
            '/Users/wk/Source/krypton/src/perspective-fix.ts\n' +
            '146:        ctrlKey: me.ctrlKey,\n' +
            '/Users/wk/Source/krypton/src/quick-overview.ts\n' +
            '158:    if (action && !e.metaKey && !e.ctrlKey) {',
        }],
      })) as unknown as FakeEl;
    });
    const classes = collectClasses(out).join(' ');
    expect(classes).toContain('acp-harness__tool-rich--grep');
    expect(classes).not.toContain('acp-harness__tool-section-text');
    expect(JSON.stringify(out)).not.toContain('workspace_result');
  });

  it('does not paint Grok read_file N→ line anchors', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'read',
        command: '',
        subject: 'SKILL.md',
        sections: [{
          label: 'content',
          text: '1→---\nname: karpathy-guidelines\n10→license: MIT',
        }],
      })) as unknown as FakeEl;
    });
    const pre = findClass(out, 'acp-harness__tool-section-text');
    expect(pre?.textContent).toBe('---\nname: karpathy-guidelines\nlicense: MIT');
    expect(pre?.textContent).not.toContain('→');
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

describe('peelExitPrefix / extractToolExitCode', () => {
  it('peels a Grok Bash exit prefix', () => {
    expect(peelExitPrefix('exit: 0\n[master abc] msg')).toEqual({
      code: 0,
      rest: '[master abc] msg',
    });
    expect(peelExitPrefix('exit: 1\n')).toEqual({ code: 1, rest: '' });
    expect(peelExitPrefix('exit: 0')).toEqual({ code: 0, rest: '' });
    expect(peelExitPrefix('src/a.ts:1: hit')).toBeNull();
  });

  it('reads structured exit_code and hides zero on the head result', () => {
    expect(extractToolExitCode({ exit_code: 0 })).toBe(0);
    expect(extractToolExitCode({ exit_code: 1 })).toBe(1);
    expect(extractToolExitCode({ output: 'x' })).toBeNull();
    expect(extractToolExit({ exit_code: 0 })).toBe('');
    expect(extractToolExit({ exit_code: 2 })).toBe('exit 2');
  });
});

describe('execute exit badge (spec 235)', () => {
  it('paints a success chip and strips the dump prefix', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'execute',
        command: 'git commit -m x',
        subject: 'git commit -m x',
        sections: [{
          label: 'output',
          text:
            'exit: 0\n[master 599d8d8] feat(palette): navigate results with Ctrl+N/P\n' +
            ' 3 files changed, 20 insertions(+), 5 deletions(-)',
        }],
      })) as unknown as FakeEl;
    });
    const chip = findClass(out, 'acp-harness__tool-exit');
    expect(chip?.dataset.status).toBe('ok');
    expect(findClass(out, 'acp-harness__tool-exit-code')?.textContent).toBe('0');
    expect(findClass(out, 'acp-harness__tool-exit-label')?.textContent).toBe('exit');
    const label = findClass(out, 'acp-harness__tool-section-label');
    expect(findClass(label!, 'acp-harness__tool-exit')).toBe(chip);
    expect(out.children[0]?.className).not.toBe('acp-harness__tool-exit');
    const pre = findClass(out, 'acp-harness__tool-section-text');
    expect(pre?.textContent).toContain('[master 599d8d8]');
    expect(pre?.textContent).not.toContain('exit: 0');
  });

  it('paints a fail chip for non-zero', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'execute',
        command: 'tsc --noEmit',
        exitCode: 1,
        sections: [{ label: 'output', text: 'error TS2322: Type string is not assignable' }],
      })) as unknown as FakeEl;
    });
    const fail = findClass(out, 'acp-harness__tool-exit');
    expect(fail?.dataset.status).toBe('fail');
    expect(findClass(out, 'acp-harness__tool-exit-code')?.textContent).toBe('1');
    expect(findClass(findClass(out, 'acp-harness__tool-section-label')!, 'acp-harness__tool-exit')).toBe(fail);
    expect(findClass(out, 'acp-harness__tool-section-text')?.textContent).toContain('error TS2322');
  });

  it('does not chip a search dump that happens to carry exit_code', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'search',
        exitCode: 1,
        sections: [{ label: 'stdout', text: 'No matches found' }],
      })) as unknown as FakeEl;
    });
    expect(findClass(out, 'acp-harness__tool-exit')).toBeUndefined();
  });

  it('peels exit before git-status so porcelain still goes rich', () => {
    const out = withDom(() => {
      return renderToolOutput(payload({
        kind: 'execute',
        command: 'git status --short',
        subject: 'git status --short',
        sections: [{ label: 'output', text: 'exit: 0\nM  src/a.ts\n?? b.ts' }],
      })) as unknown as FakeEl;
    });
    expect(collectClasses(out).join(' ')).toContain('acp-harness__tool-rich--gitstatus');
    expect(findClass(out, 'acp-harness__tool-exit-code')?.textContent).toBe('0');
    expect(out.children[0]?.className).toBe('acp-harness__tool-exit');
    expect(JSON.stringify(out)).not.toContain('exit: 0');
  });

  it('buildToolPayload seeds a braille spinner for in-flight statuses, never · or ⟳', () => {
    const call = { toolCallId: 'g1', title: 'execute', rawInput: { command: 'ls' } };
    expect(buildToolPayload(call, 'pending').glyph).toBe('⠋');
    expect(buildToolPayload(call, 'in_progress').glyph).toBe('⠋');
    expect(buildToolPayload(call, 'completed').glyph).toBe('✓');
    expect(buildToolPayload(call, 'failed').glyph).toBe('✗');
  });

  it('buildToolPayload peels Grok Bash output_for_prompt before the line cap', () => {
    const tool = buildToolPayload({
      toolCallId: 'b1',
      title: 'git commit',
      kind: 'execute',
      rawInput: { command: 'git commit -m x' },
      rawOutput: {
        type: 'Bash',
        exit_code: 0,
        output_for_prompt:
          'exit: 0\n[master 599d8d8] feat(palette): navigate results with Ctrl+N/P\n' +
          ' 3 files changed, 20 insertions(+), 5 deletions(-)\n',
      },
    }, 'completed');
    expect(tool.exitCode).toBe(0);
    expect(tool.result).toBe('');
    expect(tool.sections[0]?.text).toContain('[master 599d8d8]');
    expect(tool.sections[0]?.text).not.toContain('exit: 0');
  });

  it('still paints a chip when the dump is only the exit line', () => {
    const el = withDom(() => {
      const body = makeFakeEl('div');
      renderToolBody(body as unknown as HTMLElement, payload({
        kind: 'execute',
        command: 'false',
        exitCode: 1,
        sections: [],
      }));
      return body;
    });
    expect(findClass(el, 'acp-harness__tool-exit-code')?.textContent).toBe('1');
    expect(findClass(el, 'acp-harness__tool-exit')?.dataset.status).toBe('fail');
  });

  it('does not frame the number as a kind chip; fail keeps error color', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../styles/acp-harness.css'),
      'utf8',
    );
    const code = css.match(/\.acp-harness__tool-exit-code\s*\{[^}]*\}/)?.[0] ?? '';
    const fail = css.match(
      /\.acp-harness__tool-exit\[data-status="fail"\] \.acp-harness__tool-exit-code\s*\{[^}]*\}/,
    )?.[0] ?? '';
    const sectionLabel = css.match(/\.acp-harness__tool-section-label\s*\{[^}]*\}/)?.[0] ?? '';
    expect(code).not.toMatch(/border:/);
    expect(code).not.toMatch(/font-weight:\s*700/);
    expect(code).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(code).not.toMatch(/--agent-accent/);
    expect(fail).toMatch(/--agent-error/);
    expect(sectionLabel).toMatch(/display:\s*flex/);
  });
});

describe('tool dump font size', () => {
  it('matches conversation --krypton-font-size; nested dump bodies do not shrink again', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../styles/acp-harness.css'),
      'utf8',
    );
    const output = css.match(/\.acp-harness__tool-output\s*\{[^}]*\}/)?.[0] ?? '';
    const diffs = css.match(/\.acp-harness__tool-diffs\s*\{[^}]*\}/)?.[0] ?? '';
    const sectionText = css.match(/\.acp-harness__tool-section-text\s*\{[^}]*\}/)?.[0] ?? '';
    const rich = css.match(/\.acp-harness__tool-rich\s*\{[^}]*\}/)?.[0] ?? '';
    const grepRow = css.match(/\.acp-harness__grep-row\s*\{[^}]*\}/)?.[0] ?? '';
    const diffBody = css.match(/\.acp-harness__tool-body--diff\s*\{[^}]*\}/)?.[0] ?? '';
    expect(output).toMatch(/font-size:\s*var\(--krypton-font-size,\s*13px\)/);
    expect(diffs).toMatch(/font-size:\s*var\(--krypton-font-size,\s*13px\)/);
    expect(sectionText).toMatch(/font-size:\s*inherit/);
    expect(sectionText).not.toMatch(/0\.92em/);
    expect(rich).toMatch(/font-size:\s*inherit/);
    expect(rich).not.toMatch(/0\.92em/);
    expect(grepRow).not.toMatch(/font-size:/);
    expect(diffBody).toMatch(/font-size:\s*inherit/);
    expect(diffBody).not.toMatch(/0\.92em/);
  });
});

describe('grep line gutter (spec 235)', () => {
  it('right-aligns line numbers in a shared ≥4ch column', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../styles/acp-harness.css'),
      'utf8',
    );
    const line = css.match(/\.acp-harness__tok-line\s*\{[^}]*\}/)?.[0] ?? '';
    const pathRow = css.match(/\.acp-harness__grep-row--path\s*\{[^}]*\}/)?.[0] ?? '';
    const linenoRow = css.match(/\.acp-harness__grep-row--lineno\s*\{[^}]*\}/)?.[0] ?? '';
    expect(line).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(line).toMatch(/text-align:\s*end/);
    expect(line).toMatch(/justify-self:\s*end/);
    expect(pathRow).toMatch(/minmax\(8ch,\s*32ch\)/);
    expect(pathRow).toMatch(/minmax\(4ch,\s*max-content\)/);
    expect(linenoRow).toMatch(/minmax\(4ch,\s*max-content\)/);
  });
});

describe('buildToolPayload Grok dumps', () => {
  it('unwraps search XML before the 6-line cap so the close tag is not required', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `/Users/wk/Source/krypton/src/f${i}.ts\n${i}:  hit`);
    const tool = buildToolPayload({
      toolCallId: 't1',
      title: 'SEARCH',
      kind: 'search',
      rawOutput: {
        stdout:
          '<workspace_result workspace_path="/Users/wk/Source/krypton">\n' +
          'Found at least 67 matching lines\n' +
          lines.join('\n') +
          '\n</workspace_result>',
      },
    }, 'completed');
    expect(tool.sections[0]?.text).not.toContain('workspace_result');
    expect(tool.sections[0]?.text).toContain('src/f0.ts');
    expect(tool.sections[0]?.text.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('strips read_file line anchors before paint', () => {
    const tool = buildToolPayload({
      toolCallId: 't2',
      title: 'READ',
      kind: 'read',
      content: [{
        type: 'content',
        content: { type: 'text', text: '1→---\nname: karpathy-guidelines' },
      }],
    }, 'completed');
    expect(tool.sections[0]?.text).toBe('---\nname: karpathy-guidelines');
  });
});

describe('grokRawOutputSections — every rawOutput.type', () => {
  const xml = '<workspace_result workspace_path="/Users/wk/Source/krypton">\nNo matches found\n</workspace_result>';
  const xmlBytes = Array.from(new TextEncoder().encode(xml));

  it('returns null for unknown types so the generic walker still runs', () => {
    expect(grokRawOutputSections({ type: 'BrandNewGrokTool', stdout: 'x' })).toBeNull();
    expect(grokRawOutputSections({ output: 'plain' })).toBeNull();
  });

  it('handles every recorded Grok type without falling through', () => {
    for (const type of GROK_RAW_OUTPUT_TYPES) {
      expect(grokRawOutputSections({ type }), `unhandled Grok type ${type}`).not.toBeNull();
    }
  });

  it('ReadFile strips via FileContent and FileNotFound, never ImageContent bytes', () => {
    expect(grokRawOutputSections({
      type: 'ReadFile',
      FileContent: { content: '1→---\nname: skill' },
    })).toEqual([{ label: 'content', text: '1→---\nname: skill' }]);
    expect(grokRawOutputSections({
      type: 'ReadFile',
      FileNotFound: 'Error: missing.md does not exist.',
    })).toEqual([{ label: 'message', text: 'Error: missing.md does not exist.' }]);
    expect(grokRawOutputSections({
      type: 'ReadFile',
      ImageContent: { data: 'iVBORw0KGgoAAAANSUhEUg==' },
    })).toEqual([]);
  });

  it('GrepSearch prefers file_matches over XML stdout', () => {
    const hits = grokRawOutputSections({
      type: 'GrepSearch',
      stdout: xmlBytes,
      stderr: [],
      exit_code: 0,
      match_count: 1,
      file_matches: [{
        path: '/Users/wk/Source/krypton/src/a.ts',
        matches: [{ line_number: 146, content: '        ctrlKey: me.ctrlKey,' }],
      }],
    });
    expect(hits).toEqual([{
      label: 'stdout',
      text: '/Users/wk/Source/krypton/src/a.ts\n146:        ctrlKey: me.ctrlKey,',
    }]);
    expect(hits?.[0]?.text).not.toContain('workspace_result');
  });

  it('GrepSearch empty matches decodes XML stdout for unwrap', () => {
    expect(grokRawOutputSections({
      type: 'GrepSearch',
      stdout: xmlBytes,
      stderr: [],
      exit_code: 1,
      match_count: 0,
      file_matches: [],
    })).toEqual([{ label: 'stdout', text: xml }]);
  });

  it('ListDir / WebFetch read Content.content', () => {
    expect(grokRawOutputSections({
      type: 'ListDir',
      Content: { content: '- /docs/\n  - 15-command-palette.md' },
    })).toEqual([{ label: 'content', text: '- /docs/\n  - 15-command-palette.md' }]);
    expect(grokRawOutputSections({
      type: 'WebFetch',
      Content: { url: 'https://example.com', content: '# Title\nbody' },
    })).toEqual([{ label: 'content', text: '# Title\nbody' }]);
  });

  it('Bash prefers output_for_prompt over byte output', () => {
    expect(grokRawOutputSections({
      type: 'Bash',
      output: [62, 32, 116, 115, 99],
      output_for_prompt: 'exit: 0\n\n> tsc --noEmit\n',
    })).toEqual([{ label: 'output', text: 'exit: 0\n\n> tsc --noEmit\n' }]);
  });

  it('MCP paints OkayOutput and Error, SearchReplace defers to the diff', () => {
    expect(grokRawOutputSections({
      type: 'MCP',
      output: { OkayOutput: '{ "recorded": true }' },
    })).toEqual([{ label: 'output', text: '{ "recorded": true }' }]);
    expect(grokRawOutputSections({
      type: 'MCP',
      is_error: true,
      output: { Error: 'ranges[0].file must be a non-empty string' },
    })).toEqual([{ label: 'error', text: 'ranges[0].file must be a non-empty string' }]);
    expect(grokRawOutputSections({ type: 'SearchReplace', EditsApplied: { old_string: 'a', new_string: 'b' } })).toEqual([]);
  });

  it('covers Todo, Text, KillTask, ImageGen, TaskOutput, BackgroundTaskStarted, SearchTool', () => {
    expect(grokRawOutputSections({
      type: 'Todo',
      TodosUpdated: { summary_for_prompt: '- [in_progress] write tests' },
    })?.[0]?.text).toContain('write tests');
    expect(grokRawOutputSections({
      type: 'Text',
      text: 'Subagent started in background.',
    })?.[0]?.text).toBe('Subagent started in background.');
    expect(grokRawOutputSections({
      type: 'KillTask',
      Result: { message: 'Task was terminated successfully' },
    })?.[0]?.text).toBe('Task was terminated successfully');
    expect(grokRawOutputSections({
      type: 'ImageGen',
      path: '/tmp/images/1.jpg',
    })?.[0]?.text).toBe('/tmp/images/1.jpg');
    expect(grokRawOutputSections({
      type: 'TaskOutput',
      Result: { output: 'cargo test ok' },
    })?.[0]?.text).toBe('cargo test ok');
    expect(grokRawOutputSections({
      type: 'BackgroundTaskStarted',
      summary: 'moved to background',
    })?.[0]?.text).toBe('moved to background');
    expect(grokRawOutputSections({
      type: 'SearchTool',
      content: '{ "results": [] }',
    })?.[0]?.text).toBe('{ "results": [] }');
  });

  it('buildToolPayload paints structured grep without XML and strips read anchors', () => {
    const grep = buildToolPayload({
      toolCallId: 'g1',
      title: 'grep',
      kind: 'search',
      rawOutput: {
        type: 'GrepSearch',
        stdout: xmlBytes,
        file_matches: [{
          path: '/Users/wk/Source/krypton/src/a.ts',
          matches: [{ line_number: 10, content: 'hit' }],
        }],
      },
    }, 'completed');
    expect(grep.sections[0]?.text).toContain('src/a.ts');
    expect(grep.sections[0]?.text).toContain('10:hit');
    expect(grep.sections[0]?.text).not.toContain('workspace_result');

    const read = buildToolPayload({
      toolCallId: 'r1',
      title: 'READ',
      kind: 'read',
      rawOutput: {
        type: 'ReadFile',
        FileContent: { content: '1→---\nname: skill' },
      },
    }, 'completed');
    expect(read.sections[0]?.text).toBe('---\nname: skill');
  });
});

describe('formatGrokFileMatches', () => {
  it('returns empty for missing or empty arrays', () => {
    expect(formatGrokFileMatches(undefined)).toBe('');
    expect(formatGrokFileMatches([])).toBe('');
  });
});

describe('patchStreamingToolBody (spec 114 rev 8)', () => {
  const streamPayload = (text: string): ToolPayload => payload({
    glyph: '⠋',
    status: 'in_progress',
    subject: 'npm test',
    command: 'npm test',
    sections: [{ label: 'stdout', text }],
  });

  it('swaps only the output block; head keeps its DOM nodes', () => {
    withDom(() => {
      const body = makeFakeEl('div');
      renderToolBody(body as unknown as HTMLElement, streamPayload('line 1'));
      const head = findClass(body, 'acp-harness__tool-head');
      const firstOutput = findClass(body, 'acp-harness__tool-output');
      expect(head).toBeDefined();
      expect(firstOutput).toBeDefined();

      patchStreamingToolBody(body as unknown as HTMLElement, streamPayload('line 1\nline 2'));
      expect(findClass(body, 'acp-harness__tool-head')).toBe(head);
      expect(findClass(body, 'acp-harness__tool-output')).not.toBe(firstOutput);
      expect(findClass(body, 'acp-harness__tool-section-text')?.textContent).toContain('line 2');
    });
  });

  it('dedupes on unchanged section text', () => {
    withDom(() => {
      const body = makeFakeEl('div');
      renderToolBody(body as unknown as HTMLElement, streamPayload('same'));
      patchStreamingToolBody(body as unknown as HTMLElement, streamPayload('same'));
      const output = findClass(body, 'acp-harness__tool-output');
      patchStreamingToolBody(body as unknown as HTMLElement, streamPayload('same'));
      expect(findClass(body, 'acp-harness__tool-output')).toBe(output);
    });
  });

  it('appends the output block when the first section arrives late', () => {
    withDom(() => {
      const body = makeFakeEl('div');
      renderToolBody(body as unknown as HTMLElement, payload({ glyph: '⠋', status: 'in_progress', sections: [] }));
      expect(findClass(body, 'acp-harness__tool-output')).toBeUndefined();
      patchStreamingToolBody(body as unknown as HTMLElement, streamPayload('first chunk'));
      expect(findClass(body, 'acp-harness__tool-section-text')?.textContent).toBe('first chunk');
    });
  });

  it('never touches an artifact-redacted body', () => {
    withDom(() => {
      const body = makeFakeEl('div');
      const redacted = payload({
        glyph: '⠋',
        status: 'in_progress',
        artifactRedaction: { tail: 'a.html', size: 10, hash: 'x', pending: true },
      });
      renderToolBody(body as unknown as HTMLElement, redacted);
      const snapshot = body.children.slice();
      patchStreamingToolBody(body as unknown as HTMLElement, { ...redacted, sections: [{ label: 'stdout', text: 'html' }] });
      expect(body.children).toEqual(snapshot);
    });
  });
});
