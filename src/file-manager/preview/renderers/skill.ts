// Claude Code skill card + body. Declines (null) when the file is not a skill.

import { isMarkdownFile } from '../../../file-preview';
import { isSkillFrontmatter, isSkillPath, parseSkillFrontmatter, renderSkillSpec } from '../../skill';
import type { PreviewRenderer } from '../registry';
import { parseMarkdown } from './markdown';

export const skill: PreviewRenderer = {
  id: 'skill',
  sources: ['cursor', 'search'],
  matches: (t) => isMarkdownFile(t.name),
  async render(t, io) {
    const { frontmatter: fm, body } = parseSkillFrontmatter(await io.readText());
    const isSkill = isSkillPath(t.path) || isSkillFrontmatter(fm);
    if (!(isSkill && fm)) return null;
    return { kind: 'markdown', html: renderSkillSpec(fm) + parseMarkdown(body) };
  },
};
