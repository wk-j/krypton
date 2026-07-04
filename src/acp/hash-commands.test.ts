import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HASH_COMMANDS,
  buildCommandManifest,
  commandMeta,
  filteredHashCommands,
  hashPaletteVisible,
} from './hash-commands';

describe('hashPaletteVisible', () => {
  it('shows on a bare # at the start', () => {
    expect(hashPaletteVisible('#', false)).toBe(true);
  });

  it('shows while typing a command token', () => {
    expect(hashPaletteVisible('#rev', false)).toBe(true);
    expect(hashPaletteVisible('#new!', false)).toBe(true);
  });

  it('hides once a space (arguments) is typed', () => {
    expect(hashPaletteVisible('#review ', false)).toBe(false);
    expect(hashPaletteVisible('#recall what', false)).toBe(false);
  });

  it('hides when # is not at the start', () => {
    expect(hashPaletteVisible('see #review', false)).toBe(false);
    expect(hashPaletteVisible('', false)).toBe(false);
  });

  it('stays hidden when dismissed', () => {
    expect(hashPaletteVisible('#rev', true)).toBe(false);
  });
});

describe('filteredHashCommands', () => {
  it('returns every command for a bare #', () => {
    expect(filteredHashCommands('#')).toEqual(HASH_COMMANDS);
  });

  it('filters by case-insensitive prefix', () => {
    expect(filteredHashCommands('#RE').map((c) => c.name)).toEqual([
      'restart',
      'resume',
      'recall',
      'review',
    ]);
  });

  it('matches the bang variant', () => {
    expect(filteredHashCommands('#new').map((c) => c.name)).toEqual(['new', 'new!']);
  });

  it('returns nothing for an unknown prefix or non-palette draft', () => {
    expect(filteredHashCommands('#zzz')).toEqual([]);
    expect(filteredHashCommands('not a command')).toEqual([]);
  });
});

// spec 185: the /commands reference page renders this manifest — coverage here
// is the drift guard (a command added without manifest metadata fails).
describe('buildCommandManifest', () => {
  const manifest = buildCommandManifest();
  const byName = new Map(manifest.map((e) => [e.name, e]));

  it('covers every palette command', () => {
    for (const c of HASH_COMMANDS) {
      expect(byName.has(c.name), `#${c.name} missing from manifest`).toBe(true);
    }
  });

  // Keep in sync with the dispatch-only branches in `runHashCommand`
  // (#docs, #console alias, #fix-issue).
  it('covers the dispatch-only commands and the console alias', () => {
    expect(byName.get('docs')?.badges).toContain('hidden');
    expect(byName.get('fix-issue')?.badges).toContain('hidden');
    expect(byName.get('orchestrator')?.alias).toBe('console');
  });

  it('carries the real prompt template on every prompt-backed command', () => {
    const promptBacked = [
      'goal', 'handoff', 'resume', 'wiki', 'recall',
      'directive', 'review', 'polly', 'debby', 'fix-issue',
    ];
    for (const name of promptBacked) {
      const prompt = byName.get(name)?.prompt ?? '';
      expect(prompt.length, `#${name} prompt is empty`).toBeGreaterThan(40);
    }
    expect(byName.get('goal')?.prompt).toContain('<text>');
    expect(byName.get('resume')?.prompt).toContain('"<lane>"');
    expect(byName.get('polly')?.prompt).toContain('<task>');
    expect(byName.get('debby')?.prompt).toContain('<question>');
    expect(byName.get('fix-issue')?.prompt).toContain('<owner/repo#123>');
  });

  it('assigns a category to every entry and anatomy to every workflow', () => {
    for (const e of manifest) {
      expect(['session', 'surface', 'agent']).toContain(e.category);
      if (e.badges.includes('workflow')) {
        expect(e.anatomy, `#${e.name} workflow lacks anatomy`).toBeTruthy();
        expect(e.lanes, `#${e.name} workflow lacks lane cost`).toBeTruthy();
      }
    }
  });

  // The manifest builder falls back to `session`/no-badge for an unknown name
  // (safe at runtime); this equality makes that fallback unreachable in a
  // shipped build — a roster entry without explicit metadata fails here.
  it('has explicit metadata for exactly the manifest name set', () => {
    const metaKeys = [...Object.keys(commandMeta())].sort();
    const manifestNames = manifest.map((e) => e.name).sort();
    expect(metaKeys).toEqual(manifestNames);
  });
});

// Smoke-render the /commands page script against the REAL manifest: extract the
// inline <script> from artifact-commands.html and run it with stubbed
// document/fetch. Guards the page↔manifest contract (field names, JSON shape)
// without a browser.
describe('artifact-commands.html render', () => {
  it('renders every manifest command from /commands.json', async () => {
    const html = readFileSync(join(__dirname, 'artifact-commands.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script, 'inline script missing').toBeTruthy();

    const manifest = buildCommandManifest();
    const elements: Record<string, { innerHTML: string }> = {
      content: { innerHTML: '' },
      stats: { innerHTML: '' },
    };
    const doc = { getElementById: (id: string) => elements[id] };
    const fetchStub = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ commands: manifest }) });

    new Function('document', 'fetch', script as string)(doc, fetchStub);
    await new Promise((r) => setTimeout(r, 0));

    for (const e of manifest) {
      expect(elements.content.innerHTML, `#${e.name} card missing`).toContain(`#${e.name}`);
    }
    // Prompt expanders render with placeholder tokens accent-tinted.
    expect(elements.content.innerHTML).toContain('system prompt');
    expect(elements.content.innerHTML).toContain('<span class="ph">&lt;task&gt;</span>');
    // Stats reflect the manifest, not hardcoded numbers.
    expect(elements.stats.innerHTML).toContain(`${manifest.length}</b><span>commands`);
  });
});
