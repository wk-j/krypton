import { invoke } from '@tauri-apps/api/core';

export interface WikiLink {
  raw: string;
  target: string;
  display: string;
  lineNumber: number;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface VaultFile {
  path: string;
  relativePath: string;
  title: string;
  frontmatter: Record<string, unknown>;
  wikilinks: WikiLink[];
  tags: string[];
  frontmatterTags: string[];
  headings: Heading[];
  headingsLoaded: boolean;
  modifiedAt: number;
  contentUpdatedAt: number;
}

export interface VaultIndex {
  root: string;
  files: Map<string, VaultFile>;
  backlinks: Map<string, string[]>;
  tags: Map<string, string[]>;
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;
const TAG_RE = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: content };

  const yaml = match[1];
  const body = content.slice(match[0].length).trimStart();
  const frontmatter: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

function parseWikilinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(lines[i])) !== null) {
      links.push({
        raw: match[0],
        target: match[1].trim(),
        display: (match[2] ?? match[1]).trim(),
        lineNumber: i + 1,
      });
    }
  }

  return links;
}

function parseHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  let match: RegExpExecArray | null;
  HEADING_RE.lastIndex = 0;
  while ((match = HEADING_RE.exec(content)) !== null) {
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
      id: slugify(match[2].trim()),
    });
  }
  return headings;
}

function parseTags(content: string): string[] {
  const tags = new Set<string>();
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

function parseFrontmatterTags(fm: Record<string, unknown>): string[] {
  const raw = fm['tags'] ?? fm['Tags'] ?? fm['TAGS'];
  if (!raw) return [];
  const str = String(raw);
  // Handle YAML array syntax: [tag1, tag2] or tag1, tag2
  const cleaned = str.replace(/^\[|\]$/g, '');
  return cleaned
    .split(',')
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t.length > 0);
}

function buildSlugMap(files: Map<string, VaultFile>): Map<string, string> {
  const slug = new Map<string, string>();
  for (const [, file] of files) {
    const base = file.relativePath.replace(/\.md$/, '').toLowerCase();
    if (!slug.has(base)) slug.set(base, file.relativePath);
    const segments = base.split('/');
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      if (!slug.has(suffix)) slug.set(suffix, file.relativePath);
    }
  }
  return slug;
}

function resolveWikilinkTarget(target: string, slug: Map<string, string>): string {
  const normalized = target.toLowerCase().replace(/\.md$/, '');
  return slug.get(normalized) ?? target;
}

export async function listVaultFiles(root: string): Promise<string[]> {
  try {
    const output = await invoke<string>('run_command', {
      program: 'find',
      args: [root, '-name', '*.md', '-type', 'f', '-not', '-path', '*/.obsidian/*', '-not', '-path', '*/node_modules/*'],
      cwd: root,
    });
    return output
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .sort();
  } catch {
    return [];
  }
}

export async function readVaultFile(path: string): Promise<string> {
  try {
    return await invoke<string>('run_command', {
      program: 'cat',
      args: [path],
      cwd: '/',
    });
  } catch {
    return '';
  }
}

export async function readVaultFiles(paths: string[]): Promise<string[]> {
  try {
    return await invoke<string[]>('read_vault_files', { paths });
  } catch {
    return paths.map(() => '');
  }
}

export function parseHeadingsForFile(content: string): Heading[] {
  return parseHeadings(content);
}

function parseVaultFile(absolutePath: string, root: string, content: string): VaultFile {
  const relativePath = absolutePath.startsWith(root)
    ? absolutePath.slice(root.length).replace(/^\//, '')
    : absolutePath;

  const { frontmatter, body } = parseFrontmatter(content);

  const title = (frontmatter['title'] as string)
    ?? relativePath.split('/').pop()?.replace(/\.md$/, '')
    ?? 'Untitled';

  const inlineTags = parseTags(body);
  const fmTags = parseFrontmatterTags(frontmatter);
  const allTags = [...new Set([...fmTags, ...inlineTags])];

  return {
    path: absolutePath,
    relativePath,
    title,
    frontmatter,
    wikilinks: parseWikilinks(body),
    tags: allTags,
    frontmatterTags: fmTags,
    headings: [],
    headingsLoaded: false,
    modifiedAt: 0,
    contentUpdatedAt: parseFrontmatterDate(frontmatter),
  };
}

function parseFrontmatterDate(fm: Record<string, unknown>): number {
  const candidates = ['updated', 'date_ingested', 'date', 'created'];
  for (const key of candidates) {
    const raw = fm[key];
    if (typeof raw === 'string' && raw.length > 0) {
      const ts = Date.parse(raw);
      if (!Number.isNaN(ts)) return Math.floor(ts / 1000);
    }
  }
  return 0;
}

export async function buildVaultIndex(root: string): Promise<VaultIndex> {
  const filePaths = await listVaultFiles(root);
  const [contents, mtimes] = await Promise.all([
    readVaultFiles(filePaths),
    invoke<number[]>('stat_files', { paths: filePaths }).catch(() => [] as number[]),
  ]);

  const files = new Map<string, VaultFile>();
  for (let i = 0; i < filePaths.length; i++) {
    const file = parseVaultFile(filePaths[i], root, contents[i] ?? '');
    file.modifiedAt = mtimes[i] ?? 0;
    files.set(file.relativePath, file);
  }

  const slug = buildSlugMap(files);
  const backlinks = new Map<string, string[]>();
  const tags = new Map<string, string[]>();

  for (const [, file] of files) {
    for (const link of file.wikilinks) {
      link.target = resolveWikilinkTarget(link.target, slug);
      const existing = backlinks.get(link.target) ?? [];
      existing.push(file.relativePath);
      backlinks.set(link.target, existing);
    }

    for (const tag of file.tags) {
      const existing = tags.get(tag) ?? [];
      existing.push(file.relativePath);
      tags.set(tag, existing);
    }
  }

  return { root, files, backlinks, tags };
}
