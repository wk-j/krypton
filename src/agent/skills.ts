// Krypton — AI Agent Skill Auto-Detection
//
// Discovers SKILL.md files from .claude/skills/ and .agents/skills/,
// builds a keyword index, and matches user prompts to relevant skills.
// Matched skill content is injected into the agent's system prompt.

import { invoke } from '@tauri-apps/api/core';

// ─── Types ────────────────────────────────────────────────────────────

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  keywords: string[];
}

export interface SkillMatch {
  skill: SkillMeta;
  score: number;
}

// ─── Stop words for keyword extraction ────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some', 'them',
  'than', 'its', 'over', 'such', 'that', 'this', 'with', 'will', 'each',
  'make', 'like', 'from', 'when', 'what', 'where', 'which', 'their', 'then',
  'into', 'just', 'also', 'more', 'about', 'after', 'before', 'other',
  'could', 'would', 'should', 'does', 'doing', 'during', 'without',
  'use', 'used', 'using', 'ensure', 'ensures', 'stay', 'sync',
]);

// ─── Keyword extraction ───────────────────────────────────────────────

/** Extract meaningful keywords from text. */
function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.\-_/()!?;:'"]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// ─── Frontmatter parsing ──────────────────────────────────────────────

interface Frontmatter {
  name: string;
  description: string;
}

/** Parse YAML frontmatter from a SKILL.md file. */
function parseFrontmatter(content: string): Frontmatter | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  let name = '';
  let description = '';

  for (const line of yaml.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
  }

  if (!name) return null;
  return { name, description };
}

// ─── Discovery ────────────────────────────────────────────────────────

/** List SKILL.md files in skill directories via Rust backend. */
async function listSkillFiles(projectDir: string): Promise<string[]> {
  const dirs = [
    `${projectDir}/.claude/skills`,
    `${projectDir}/.agents/skills`,
  ];

  const paths: string[] = [];
  for (const dir of dirs) {
    try {
      const result = await invoke<string>('run_command', {
        program: 'ls',
        args: ['-1', dir],
      });
      for (const name of result.split('\n').filter(Boolean)) {
        paths.push(`${dir}/${name}/SKILL.md`);
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }
  return paths;
}

/** Scan skill directories and build index. */
export async function discoverSkills(projectDir: string): Promise<SkillMeta[]> {
  const skillFiles = await listSkillFiles(projectDir);
  const seen = new Set<string>();
  const skills: SkillMeta[] = [];

  for (const path of skillFiles) {
    try {
      const content = await invoke<string>('read_file', { path });
      const fm = parseFrontmatter(content);
      if (!fm || seen.has(fm.name)) continue;

      seen.add(fm.name);

      // Build keywords from description + name parts
      const keywords = [
        ...extractKeywords(fm.description),
        ...fm.name.split('-').filter((w) => w.length > 2),
      ];

      skills.push({ name: fm.name, description: fm.description, path, keywords });
    } catch {
      console.warn(`[skills] failed to read ${path}`);
    }
  }

  return skills;
}

// ─── Matching ─────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.3;
const MAX_SKILL_CONTENT_LENGTH = 4000;

/** Match user input against skill index. Returns skills sorted by score (descending). */
export function matchSkills(
  input: string,
  skills: SkillMeta[],
  threshold: number = DEFAULT_THRESHOLD,
): SkillMatch[] {
  const inputWords = new Set(extractKeywords(input));
  if (inputWords.size === 0) return [];

  const matches: SkillMatch[] = [];

  for (const skill of skills) {
    if (skill.keywords.length === 0) continue;

    let hits = 0;
    for (const kw of skill.keywords) {
      if (inputWords.has(kw)) hits++;
    }

    const score = hits / skill.keywords.length;
    if (score >= threshold) {
      matches.push({ skill, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

/** Force-match a skill by name. Returns null if not found. */
export function forceMatchSkill(name: string, skills: SkillMeta[]): SkillMatch | null {
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;
  return { skill, score: 1.0 };
}

// ─── Loading ──────────────────────────────────────────────────────────

/** Load full SKILL.md content, stripping frontmatter. Capped at MAX_SKILL_CONTENT_LENGTH chars. */
export async function loadSkillContent(skill: SkillMeta): Promise<string> {
  try {
    const raw = await invoke<string>('read_file', { path: skill.path });
    // Strip frontmatter
    const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    if (body.length > MAX_SKILL_CONTENT_LENGTH) {
      return body.slice(0, MAX_SKILL_CONTENT_LENGTH) + '\n\n[... skill content truncated]';
    }
    return body;
  } catch {
    console.warn(`[skills] failed to load content for ${skill.name}`);
    return '';
  }
}

// ─── System prompt builder ────────────────────────────────────────────

/** Build the skill section to append to the system prompt. */
export async function buildSkillPrompt(matches: SkillMatch[]): Promise<string> {
  if (matches.length === 0) return '';

  const sections: string[] = [];
  for (const { skill } of matches) {
    const content = await loadSkillContent(skill);
    if (content) {
      sections.push(`## Active Skill: ${skill.name}\n\n${content}`);
    }
  }

  if (sections.length === 0) return '';
  return '\n\n# Skills\n\nThe following skills are active for this request. Follow their instructions.\n\n' +
    sections.join('\n\n---\n\n');
}
