// Krypton — AI Agent Skill Auto-Detection
//
// Discovers skills from multiple sources:
//   1. SKILL.md files in .claude/skills/ and .agents/skills/ (Krypton format)
//   2. .claude/commands/*.md files (Claude Code format — filename is command name)
//   3. ~/.claude/commands/*.md (user-global Claude Code commands)
//
// Skills are auto-matched by keyword; commands are invocable as /command-name.
// Matched content is injected into the agent's system prompt.

import { invoke } from '@tauri-apps/api/core';

// ─── Types ────────────────────────────────────────────────────────────

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  /** True for .claude/commands/ files — invocable as /name, supports $ARGUMENTS */
  isCommand: boolean;
}

export interface SkillMatch {
  skill: SkillMeta;
  score: number;
}

// ─── Frontmatter parsing ──────────────────────────────────────────────

interface Frontmatter {
  name?: string;
  description?: string;
}

/** Parse YAML frontmatter from a markdown file. Returns null if no frontmatter block. */
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

  return { name: name || undefined, description: description || undefined };
}

/** Strip frontmatter block from content. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

// ─── Discovery helpers ───────────────────────────────────────────────

/** List entries in a directory. Returns empty array if dir doesn't exist. */
async function listDir(dir: string): Promise<string[]> {
  try {
    const result = await invoke<string>('run_command', {
      program: 'ls',
      args: ['-1', dir],
    });
    return result.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Discover SKILL.md files in .claude/skills/ and .agents/skills/. */
async function discoverSkillFiles(projectDir: string): Promise<SkillMeta[]> {
  const dirs = [
    `${projectDir}/.claude/skills`,
    `${projectDir}/.agents/skills`,
  ];

  const seen = new Set<string>();
  const skills: SkillMeta[] = [];

  for (const dir of dirs) {
    const entries = await listDir(dir);
    for (const entry of entries) {
      const path = `${dir}/${entry}/SKILL.md`;
      try {
        const content = await invoke<string>('read_file', { path });
        const fm = parseFrontmatter(content);
        const name = fm?.name ?? entry;
        if (seen.has(name)) continue;
        seen.add(name);

        const description = fm?.description ?? '';
        skills.push({ name, description, path, isCommand: false });
      } catch {
        // SKILL.md doesn't exist in this subdirectory — skip
      }
    }
  }

  return skills;
}

/** Discover .claude/commands/*.md files (Claude Code format). */
async function discoverCommandFiles(projectDir: string): Promise<SkillMeta[]> {
  const homeDir = await invoke<string>('get_env_var', { name: 'HOME' }).catch(() => '');

  // Project-level commands override user-global commands
  const dirs: string[] = [];
  if (homeDir) dirs.push(`${homeDir}/.claude/commands`);
  dirs.push(`${projectDir}/.claude/commands`);

  const seen = new Set<string>();
  const commands: SkillMeta[] = [];

  for (const dir of dirs) {
    const entries = await listDir(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.replace(/\.md$/, '');
      const path = `${dir}/${entry}`;

      try {
        const content = await invoke<string>('read_file', { path });
        const fm = parseFrontmatter(content);
        const description = fm?.description ?? stripFrontmatter(content).slice(0, 80);

        // Project-level overrides user-global (later dir wins)
        seen.delete(name);
        const existingIdx = commands.findIndex((c) => c.name === name);
        if (existingIdx >= 0) commands.splice(existingIdx, 1);

        commands.push({ name, description, path, isCommand: true });
        seen.add(name);
      } catch {
        // File unreadable — skip
      }
    }
  }

  return commands;
}

// ─── Discovery ────────────────────────────────────────────────────────

/** Scan all skill sources and build index. */
export async function discoverSkills(projectDir: string): Promise<SkillMeta[]> {
  const [skills, commands] = await Promise.all([
    discoverSkillFiles(projectDir),
    discoverCommandFiles(projectDir),
  ]);

  // Merge: commands don't override skills with the same name
  const seen = new Set(skills.map((s) => s.name));
  for (const cmd of commands) {
    if (!seen.has(cmd.name)) {
      skills.push(cmd);
      seen.add(cmd.name);
    }
  }

  return skills;
}

// ─── Matching ─────────────────────────────────────────────────────────

const MAX_SKILL_CONTENT_LENGTH = 4000;

/**
 * Use the LLM to decide which skills are relevant for the user's input.
 * Makes a lightweight API call with skill metadata and returns matched skills.
 * Falls back to empty matches on error (agent proceeds without skills).
 */
export async function matchSkills(
  input: string,
  skills: SkillMeta[],
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<SkillMatch[]> {
  if (skills.length === 0) return [];

  // Build compact skill catalog for the classifier
  const catalog = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');

  const classifierPrompt = `You are a skill classifier. Given a user's message and a list of available skills, return a JSON array of skill names that are relevant to the user's request. Only include skills that clearly match the intent. Return an empty array [] if no skills are relevant.

Available skills:
${catalog}

User message: ${input}

Respond with ONLY a JSON array of skill name strings, nothing else. Example: ["design-first"] or []`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: classifierPrompt }],
        temperature: 0,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      console.warn(`[skills] classifier request failed: ${response.status}`);
      return [];
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';

    // Parse JSON array from response (handle markdown code fences)
    const jsonStr = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const names: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(names)) return [];

    const matched: SkillMatch[] = [];
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const skill = skills.find((s) => s.name === name);
      if (skill) matched.push({ skill, score: 1.0 });
    }

    return matched;
  } catch (e) {
    console.warn('[skills] classifier failed, skipping skill matching:', e);
    return [];
  }
}

/** Force-match a skill by name. Returns null if not found. */
export function forceMatchSkill(name: string, skills: SkillMeta[]): SkillMatch | null {
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;
  return { skill, score: 1.0 };
}

// ─── Loading ──────────────────────────────────────────────────────────

/**
 * Load skill/command content, stripping frontmatter.
 * For command files, replaces $ARGUMENTS with the provided args string.
 * Capped at MAX_SKILL_CONTENT_LENGTH chars.
 */
export async function loadSkillContent(skill: SkillMeta, args?: string): Promise<string> {
  try {
    const raw = await invoke<string>('read_file', { path: skill.path });
    let body = stripFrontmatter(raw);

    // Claude Code command format: replace $ARGUMENTS placeholder
    if (skill.isCommand && args !== undefined) {
      body = body.replace(/\$ARGUMENTS/g, args);
    }

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

/** Build skill section to append to the system prompt. */
export async function buildSkillPrompt(matches: SkillMatch[], commandArgs?: string): Promise<string> {
  if (matches.length === 0) return '';

  const sections: string[] = [];
  for (const { skill } of matches) {
    const content = await loadSkillContent(skill, skill.isCommand ? commandArgs : undefined);
    if (content) {
      const label = skill.isCommand ? 'Command' : 'Skill';
      sections.push(`## Active ${label}: ${skill.name}\n\n${content}`);
    }
  }

  if (sections.length === 0) return '';
  return '\n\n# Skills\n\nThe following skills are active for this request. Follow their instructions.\n\n' +
    sections.join('\n\n---\n\n');
}
