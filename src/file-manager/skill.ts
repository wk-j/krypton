// Krypton — Claude Code skill detection & frontmatter cards (spec 317).
// Moved verbatim from src/file-manager.ts. Pure; returns HTML strings because
// they are concatenated with previewMarked.parse() output into one innerHTML.

export const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse YAML frontmatter. Supports simple `key: value`, `key: >` (folded), `key: |` (literal). */
export function parseSkillFrontmatter(content: string): { frontmatter: Record<string, string> | null; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };

  const fm: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  let key: string | null = null;
  let mode: 'folded' | 'literal' | null = null;
  let buffer: string[] = [];

  const commit = (): void => {
    if (!(key && mode)) return;
    fm[key] = mode === 'folded'
      ? buffer.map((l) => l.trim()).filter(Boolean).join(' ')
      : buffer.join('\n');
    buffer = [];
    mode = null;
  };

  for (const line of lines) {
    if (mode && (/^\s+\S/.test(line) || /^\s*$/.test(line))) {
      if (!(buffer.length === 0 && /^\s*$/.test(line))) buffer.push(line);
      continue;
    }
    commit();
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const value = kv[2];
    if (value === '>') mode = 'folded';
    else if (value === '|') mode = 'literal';
    else fm[key] = value;
  }
  commit();

  return { frontmatter: fm, body: match[2] };
}

/** Canonical skill file paths: anything inside `.claude/skills/` or named `SKILL.md`. */
export function isSkillPath(path: string): boolean {
  if (/[/\\]\.claude[/\\]skills[/\\]/.test(path)) return true;
  const basename = path.split(/[/\\]/).pop() ?? '';
  return basename.toUpperCase() === 'SKILL.MD';
}

/** Frontmatter shape matching the Claude Code skill spec (name + description + allowed-tools). */
export function isSkillFrontmatter(fm: Record<string, string> | null): boolean {
  if (!fm) return false;
  const hasTools = 'allowed-tools' in fm || 'allowedTools' in fm;
  return 'name' in fm && 'description' in fm && hasTools;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Split an `allowed-tools` value into entries, respecting parenthesised argument patterns. */
export function parseAllowedTools(str: string): string[] {
  const tools: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if ((ch === ' ' || ch === ',' || ch === '\n' || ch === '\t') && depth === 0) {
      if (current.trim()) tools.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tools.push(current.trim());
  return tools;
}

export function renderSkillSpec(fm: Record<string, string>): string {
  const name = fm['name'] ?? '';
  const description = fm['description'] ?? '';
  const allowedToolsRaw = fm['allowed-tools'] ?? fm['allowedTools'] ?? '';
  const tools = parseAllowedTools(allowedToolsRaw);

  const known = new Set(['name', 'description', 'allowed-tools', 'allowedTools']);
  const extras = Object.entries(fm).filter(([k]) => !known.has(k));

  const toolsRow = tools.length > 0
    ? `<div class="krypton-skill-spec__row">`
      + `<div class="krypton-skill-spec__label">Allowed Tools</div>`
      + `<div class="krypton-skill-spec__tools">${tools.map((t) => `<span class="krypton-skill-spec__tool">${escapeHtml(t)}</span>`).join('')}</div>`
      + `</div>`
    : '';

  const extraRows = extras.map(([k, v]) =>
    `<div class="krypton-skill-spec__row">`
    + `<div class="krypton-skill-spec__label">${escapeHtml(k)}</div>`
    + `<div class="krypton-skill-spec__value">${escapeHtml(v)}</div>`
    + `</div>`,
  ).join('');

  return `<div class="krypton-skill-spec">`
    + `<div class="krypton-skill-spec__header">`
    + `<span class="krypton-skill-spec__tag">Claude Code Skill</span>`
    + (name ? `<span class="krypton-skill-spec__name">${escapeHtml(name)}</span>` : '')
    + `</div>`
    + (description ? `<div class="krypton-skill-spec__description">${escapeHtml(description)}</div>` : '')
    + toolsRow
    + extraRows
    + `</div>`;
}

/** Render a generic frontmatter card for non-skill markdown files using the same spec-card style. */
export function renderFrontmatterCard(fm: Record<string, string>): string {
  const titleKey = ['title', 'name'].find((k) => k in fm);
  const title = titleKey ? fm[titleKey] : '';
  const description = fm['description'] ?? '';
  const promoted = new Set<string>();
  if (titleKey) promoted.add(titleKey);
  if (description) promoted.add('description');

  const rows = Object.entries(fm)
    .filter(([k, v]) => !promoted.has(k) && v !== '')
    .map(([k, v]) =>
      `<div class="krypton-skill-spec__row">`
      + `<div class="krypton-skill-spec__label">${escapeHtml(k)}</div>`
      + `<div class="krypton-skill-spec__value">${escapeHtml(v)}</div>`
      + `</div>`,
    ).join('');

  return `<div class="krypton-skill-spec">`
    + `<div class="krypton-skill-spec__header">`
    + `<span class="krypton-skill-spec__tag">Frontmatter</span>`
    + (title ? `<span class="krypton-skill-spec__name">${escapeHtml(title)}</span>` : '')
    + `</div>`
    + (description ? `<div class="krypton-skill-spec__description">${escapeHtml(description)}</div>` : '')
    + rows
    + `</div>`;
}
