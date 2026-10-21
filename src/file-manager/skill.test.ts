// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  isSkillFrontmatter,
  isSkillPath,
  parseAllowedTools,
  parseSkillFrontmatter,
  renderFrontmatterCard,
  renderSkillSpec,
} from './skill';

describe('parseSkillFrontmatter', () => {
  it('parses simple, folded and literal values', () => {
    const src = '---\nname: x\ndescription: >\n  one\n  two\nnotes: |\n  l1\n  l2\n---\nBody';
    const { frontmatter, body } = parseSkillFrontmatter(src);
    expect(frontmatter).toEqual({ name: 'x', description: 'one two', notes: '  l1\n  l2' });
    expect(body).toBe('Body');
  });

  it('returns null frontmatter and the whole content without a fence', () => {
    expect(parseSkillFrontmatter('# Title')).toEqual({ frontmatter: null, body: '# Title' });
  });
});

describe('skill detection', () => {
  it('isSkillPath matches .claude/skills/ and SKILL.md', () => {
    expect(isSkillPath('/p/.claude/skills/x.md')).toBe(true);
    expect(isSkillPath('/p/docs/skill.md')).toBe(true);
    expect(isSkillPath('/p/docs/notes.md')).toBe(false);
  });

  it('isSkillFrontmatter needs name + description + tools', () => {
    expect(isSkillFrontmatter({ name: 'a', description: 'b', 'allowed-tools': 'Read' })).toBe(true);
    expect(isSkillFrontmatter({ name: 'a', description: 'b', allowedTools: 'Read' })).toBe(true);
    expect(isSkillFrontmatter({ name: 'a', description: 'b' })).toBe(false);
    expect(isSkillFrontmatter(null)).toBe(false);
  });

  it('parseAllowedTools keeps parenthesised arguments whole', () => {
    expect(parseAllowedTools('Bash(git log:*), Read  Write')).toEqual(['Bash(git log:*)', 'Read', 'Write']);
  });
});

describe('cards', () => {
  it('escapes HTML everywhere', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const skill = renderSkillSpec({ name: '<n>', description: 'd&', 'allowed-tools': 'Read', extra: '<x>' });
    expect(skill).toContain('&lt;n&gt;');
    expect(skill).toContain('d&amp;');
    expect(skill).toContain('&lt;x&gt;');
    expect(skill).toContain('Claude Code Skill');
    const card = renderFrontmatterCard({ title: '<t>', tags: '<a>' });
    expect(card).toContain('&lt;t&gt;');
    expect(card).toContain('&lt;a&gt;');
    expect(card).toContain('>Frontmatter<');
  });
});
