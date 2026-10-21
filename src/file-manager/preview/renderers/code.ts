// Syntax-highlighted file (cursor source): the catch-all.

import hljs from 'highlight.js';

import { extToLang } from '../../../file-preview';
import type { PreviewRenderer } from '../registry';

export const code: PreviewRenderer = {
  id: 'code',
  sources: ['cursor'],
  matches: () => true,
  async render(t, io) {
    const content = await io.readText();
    const lang = extToLang(t.name);
    if (lang && hljs.getLanguage(lang)) {
      return { kind: 'html', html: hljs.highlight(content, { language: lang }).value };
    }
    return { kind: 'html', html: hljs.highlightAuto(content).value };
  },
};
