// Plain markdown: the whole file through the shared `previewMarked` instance.

import { isMarkdownFile, previewMarked } from '../../../file-preview';
import type { PreviewRenderer } from '../registry';

/** The one markdown call every markdown renderer shares. */
export function parseMarkdown(src: string): string {
  return previewMarked.parse(src, { gfm: true, breaks: true }) as string;
}

export const markdown: PreviewRenderer = {
  id: 'markdown',
  sources: ['cursor', 'search'],
  matches: (t) => isMarkdownFile(t.name),
  async render(_t, io) {
    return { kind: 'markdown', html: parseMarkdown(await io.readText()) };
  },
};
