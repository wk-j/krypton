// Generic frontmatter card + body. Declines (null) without non-empty frontmatter.

import { isMarkdownFile } from '../../../file-preview';
import { parseSkillFrontmatter, renderFrontmatterCard } from '../../skill';
import type { PreviewRenderer } from '../registry';
import { parseMarkdown } from './markdown';

export const frontmatter: PreviewRenderer = {
  id: 'frontmatter',
  sources: ['cursor', 'search'],
  matches: (t) => isMarkdownFile(t.name),
  async render(_t, io) {
    const { frontmatter: fm, body } = parseSkillFrontmatter(await io.readText());
    if (!(fm && Object.keys(fm).length > 0)) return null;
    return { kind: 'markdown', html: renderFrontmatterCard(fm) + parseMarkdown(body) };
  },
};
