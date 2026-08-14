import { describe, expect, it } from 'vitest';

import {
  isUnsafeMarkdownAttribute,
  liveAssistMarkdownHtml,
  liveAssistUsesMarkdown,
} from './live-assist-markdown';

describe('liveAssistUsesMarkdown', () => {
  it('formats assistant conversation rows only', () => {
    expect(liveAssistUsesMarkdown('assistant')).toBe(true);
    expect(liveAssistUsesMarkdown('message_chunk')).toBe(true);
    expect(liveAssistUsesMarkdown('user')).toBe(false);
    expect(liveAssistUsesMarkdown('thought')).toBe(false);
    expect(liveAssistUsesMarkdown('tool')).toBe(false);
    expect(liveAssistUsesMarkdown('system')).toBe(false);
  });
});

describe('liveAssistMarkdownHtml', () => {
  it('renders headings, emphasis, lists, and fenced code', () => {
    const html = liveAssistMarkdownHtml([
      '# Title',
      '',
      'A **bold** and *italic* line.',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const ok = true;',
      '```',
    ].join('\n'));

    expect(html).toContain('<h1');
    expect(html).toContain('Title');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toMatch(/<em>italic<\/em>/);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<pre>');
    expect(html).toContain('hljs language-ts');
    expect(html).toMatch(/ok\s*=/);
  });

  it('renders GFM tables that streaming-markdown mishandles', () => {
    const html = liveAssistMarkdownHtml([
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'));

    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('treats inline event-handler attributes as unsafe', () => {
    expect(isUnsafeMarkdownAttribute('onerror')).toBe(true);
    expect(isUnsafeMarkdownAttribute('onclick')).toBe(true);
    expect(isUnsafeMarkdownAttribute('href')).toBe(false);
    expect(isUnsafeMarkdownAttribute('src')).toBe(false);
  });
});
