// Search-source catch-all: first 200 lines; hljs only for a known extension,
// with no getLanguage guard (quirk P6 — an unknown language throws → readError).

import hljs from 'highlight.js';

import { extToLang } from '../../../file-preview';
import type { PreviewRenderer } from '../registry';

export const SEARCH_PREVIEW_MAX_LINES = 200;

export const searchCode: PreviewRenderer = {
  id: 'search-code',
  sources: ['search'],
  matches: () => true,
  async render(t, io) {
    const content = await io.readText();
    const lang = extToLang(t.name);
    const lines = content.split('\n');
    const truncated = lines.length > SEARCH_PREVIEW_MAX_LINES
      ? lines.slice(0, SEARCH_PREVIEW_MAX_LINES).join('\n') + '\n\n... (truncated)'
      : content;
    if (lang) {
      return { kind: 'html', html: hljs.highlight(truncated, { language: lang }).value };
    }
    return { kind: 'text', text: truncated };
  },
};
