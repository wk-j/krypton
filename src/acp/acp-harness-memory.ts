// Krypton — ACP harness shared memory.
// Tab-local feed used by AcpHarnessView to pass compact context between lanes.

export type HarnessMemorySource = 'tool_observation' | 'agent_footer';

export interface PendingExtraction {
  text: string;
  filePath?: string;
  source: HarnessMemorySource;
  fromToolCallId?: string;
}

export interface HarnessMemoryEntry {
  id: string;
  seq: number;
  text: string;
  filePath?: string;
  sourceLaneId: string;
  sourceLabel: string;
  source: HarnessMemorySource;
  createdAt: number;
  pinned: boolean;
}

export interface HarnessSharedMemory {
  projectDir: string | null;
  entries: HarnessMemoryEntry[];
  nextSeq: number;
}

export interface MemorySelection {
  selected: HarnessMemoryEntry[];
  total: number;
  packet: string;
}

const MEMORY_CAP = 50;
const MAX_PACKET_CHARS = 2000;
const MAX_PACKET_ENTRIES = 15;
const MAX_PINNED_PACKET_ENTRIES = 10;

const DENY_PATTERNS = [
  '~/.ssh/',
  '~/.aws/',
  '~/.gnupg/',
  '/.ssh/',
  '/.aws/',
  '/.gnupg/',
  '.netrc',
  '.pem',
  '.key',
  'id_rsa',
  'id_ed25519',
  'credential',
  'credentials',
  'secret',
];

export const MEMORY_FOOTER =
  'End your response with a "MEMORY:" block followed by 0-3 short hyphen bullets\n' +
  '("- fact"). Each bullet <= 200 chars, optionally prefixed with "<file>:".\n' +
  'Skip the block if nothing useful for other agents on this project.';

export function createSharedMemory(projectDir: string | null): HarnessSharedMemory {
  return { projectDir, entries: [], nextSeq: 1 };
}

export function appendMemoryEntries(
  memory: HarnessSharedMemory,
  laneId: string,
  laneLabel: string,
  extractions: PendingExtraction[],
): HarnessMemoryEntry[] {
  const appended: HarnessMemoryEntry[] = [];
  const seen = new Set<string>();
  for (const extraction of extractions) {
    const normalizedText = normalizeWhitespace(extraction.text);
    if (normalizedText.length < 8 || seen.has(normalizedText)) continue;
    seen.add(normalizedText);
    if (isDeniedExtraction(normalizedText, extraction.filePath)) continue;
    const seq = memory.nextSeq++;
    const entry: HarnessMemoryEntry = {
      id: `M${seq}`,
      seq,
      text: normalizedText,
      filePath: extraction.filePath,
      sourceLaneId: laneId,
      sourceLabel: laneLabel,
      source: extraction.source,
      createdAt: Date.now(),
      pinned: false,
    };
    memory.entries.push(entry);
    appended.push(entry);
  }
  enforceCap(memory);
  return appended;
}

export function pinMemory(memory: HarnessSharedMemory, id: string, pinned: boolean): boolean {
  const entry = findMemory(memory, id);
  if (!entry) return false;
  entry.pinned = pinned;
  return true;
}

export function deleteMemory(memory: HarnessSharedMemory, id: string): 'deleted' | 'pinned' | 'missing' {
  const index = memory.entries.findIndex((entry) => entry.id.toLowerCase() === id.toLowerCase());
  if (index < 0) return 'missing';
  if (memory.entries[index].pinned) return 'pinned';
  memory.entries.splice(index, 1);
  return 'deleted';
}

export function findMemory(memory: HarnessSharedMemory, id: string): HarnessMemoryEntry | null {
  return memory.entries.find((entry) => entry.id.toLowerCase() === id.toLowerCase()) ?? null;
}

export function renderMemorySelection(
  memory: HarnessSharedMemory,
  activeLaneId: string,
  draft: string,
): MemorySelection {
  const others = memory.entries.filter((entry) => entry.sourceLaneId !== activeLaneId);
  const total = memory.entries.length;
  const promptPaths = extractPathTokens(draft);
  const selected: HarnessMemoryEntry[] = [];
  const selectedIds = new Set<string>();

  const pinned = others
    .filter((entry) => entry.pinned)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_PINNED_PACKET_ENTRIES);
  for (const entry of pinned) addSelected(entry);

  const matched = others
    .filter((entry) => !entry.pinned && entry.filePath && promptPaths.some((path) => pathsMatch(entry.filePath!, path)))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const entry of matched) addSelected(entry);

  const recent = others
    .filter((entry) => !entry.pinned)
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const entry of recent) addSelected(entry);

  const lines = selected.map((entry) => {
    const path = entry.filePath ? ` (${entry.filePath})` : '';
    return `- [${entry.id}] ${entry.sourceLabel}${path}: ${entry.text}`;
  });
  return {
    selected,
    total,
    packet: lines.length > 0 ? `# Shared memory\n\n${lines.join('\n')}` : '',
  };

  function addSelected(entry: HarnessMemoryEntry): void {
    if (selectedIds.has(entry.id) || selected.length >= MAX_PACKET_ENTRIES) return;
    const candidate = selected.concat(entry);
    const chars = candidate.reduce((sum, item) => sum + item.text.length + (item.filePath?.length ?? 0) + 24, 16);
    if (chars > MAX_PACKET_CHARS) return;
    selected.push(entry);
    selectedIds.add(entry.id);
  }
}

export function extractFooterMemory(text: string): { stripped: string; extractions: PendingExtraction[]; found: boolean } {
  const match = text.match(/(?:^|\n)MEMORY:\s*\n([\s\S]*)$/);
  if (!match || match.index === undefined) return { stripped: text, extractions: [], found: false };
  const blockStart = match.index + (text[match.index] === '\n' ? 1 : 0);
  const stripped = text.slice(0, blockStart).trimEnd();
  const lines = match[1].split('\n');
  const extractions: PendingExtraction[] = [];
  for (const line of lines) {
    const bullet = parseMemoryBullet(line);
    if (bullet) extractions.push(bullet);
    if (extractions.length >= 3) break;
  }
  return { stripped, extractions, found: true };
}

export function dedupeFooterAgainstTools(
  footer: PendingExtraction[],
  tools: PendingExtraction[],
): PendingExtraction[] {
  const keptTools = tools.filter((tool) => !footer.some((entry) => similarity(entry.text, tool.text) >= 0.8));
  return footer.concat(keptTools);
}

function parseMemoryBullet(line: string): PendingExtraction | null {
  const trimmed = line.trim().replace(/^[-*•]\s+/, '').trim();
  if (trimmed.length < 8 || trimmed.length > 200) return null;
  const pathMatch = trimmed.match(/^`?([^`:\s][^:`]{1,120})`?:\s+(.+)$/);
  let filePath: string | undefined;
  let text = trimmed;
  if (pathMatch && looksPathLike(pathMatch[1])) {
    filePath = pathMatch[1];
    text = `${filePath}: ${pathMatch[2]}`;
  } else {
    const inline = trimmed.match(/`([^`]+\.[\w-]+)`/);
    if (inline && looksPathLike(inline[1])) filePath = inline[1];
  }
  if (isDeniedExtraction(text, filePath)) return null;
  return { text, filePath, source: 'agent_footer' };
}

function enforceCap(memory: HarnessSharedMemory): void {
  while (memory.entries.length > MEMORY_CAP) {
    const oldestUnpinned = memory.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !entry.pinned)
      .sort((a, b) => a.entry.createdAt - b.entry.createdAt)[0];
    if (!oldestUnpinned) break;
    memory.entries.splice(oldestUnpinned.index, 1);
  }
}

function isDeniedExtraction(text: string, filePath?: string): boolean {
  const haystack = [filePath ?? '', ...extractPathTokens(text)].join('\n').toLowerCase();
  return DENY_PATTERNS.some((pattern) => haystack.includes(pattern.toLowerCase())) || /\.env(?:\.|$)/i.test(haystack);
}

function extractPathTokens(text: string): string[] {
  const tokens = text.match(/(?:@|`)?(?:~|\.{1,2}|\/)?[\w.-]+(?:\/[\w.@-]+)+(?:\.[\w-]+)?`?/g) ?? [];
  return tokens.map((token) => token.replace(/^[@`]+|[`]+$/g, ''));
}

function pathsMatch(entryPath: string, promptPath: string): boolean {
  const a = entryPath.toLowerCase();
  const b = promptPath.toLowerCase();
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function looksPathLike(value: string): boolean {
  return value.includes('/') || /\.[a-z0-9]{1,8}$/i.test(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
  const left = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const right = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const word of left) if (right.has(word)) intersection++;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}
