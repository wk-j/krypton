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

  // Keep in sync with the console alias on the orchestrator entry.
  it('covers the console alias', () => {
    expect(byName.get('orchestrator')?.alias).toBe('console');
  });

  it('includes docs and the github-issue verbs in the palette roster', () => {
    const names = HASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('docs');
    expect(names).toContain('dispatch-github-issue');
    expect(names).not.toContain('fix-issue');
    expect(byName.get('docs')?.badges).not.toContain('hidden');
    expect(byName.get('dispatch-github-issue')?.badges).not.toContain('hidden');
    expect(byName.get('dispatch-github-issue')?.alias).toBeUndefined();
  });

  it('carries the real prompt template on every prompt-backed command', () => {
    const promptBacked = [
      'goal', 'handoff', 'resume', 'wiki', 'recall',
      'directive', 'review', 'polly', 'debby', 'dispatch-github-issue',
      'analyze-github-issue', 'fix-github-issue', 'tag-github-issue',
      'post-github-comment', 'handle-github-issue',
    ];
    for (const name of promptBacked) {
      const prompt = byName.get(name)?.prompt ?? '';
      expect(prompt.length, `#${name} prompt is empty`).toBeGreaterThan(40);
    }
    expect(byName.get('goal')?.prompt).toContain('<text>');
    expect(byName.get('resume')?.prompt).toContain('"<lane>"');
    expect(byName.get('polly')?.prompt).toContain('<task>');
    expect(byName.get('debby')?.prompt).toContain('<question>');
    expect(byName.get('dispatch-github-issue')?.prompt).toContain('<owner/repo#123>');
    // The composed verb's manifest prompt has its tokens resolved (spec 191).
    expect(byName.get('handle-github-issue')?.prompt).not.toContain('{{#');
    expect(byName.get('handle-github-issue')?.prompt).toContain('issue_progress');
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
  // Minimal DOM stub for the rev-2 master/detail page. Elements are looked up by id and
  // persist, so the page's `getElementById('x')` and `el.querySelector('#x')` resolve to
  // the SAME fake node whose innerHTML we can assert. The page renders the command list
  // into #list-items and the selected command's prompt into #detail (not one big blob),
  // so we assert against those instead of a single `content` element.
  type FakeEl = {
    innerHTML: string;
    className: string;
    value: string;
    textContent: string;
    addEventListener: () => void;
    getAttribute: () => null;
    closest: () => null;
    scrollIntoView: () => void;
    focus: () => void;
    select: () => void;
    querySelector: (sel: string) => FakeEl | null;
  };

  it('renders every manifest command into the master/detail page', async () => {
    const html = readFileSync(join(__dirname, 'artifact-commands.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script, 'inline script missing').toBeTruthy();

    const manifest = buildCommandManifest();
    const store: Record<string, FakeEl> = {};
    const getEl = (id: string): FakeEl => (store[id] ??= makeEl());
    function makeEl(): FakeEl {
      return {
        innerHTML: '',
        className: '',
        value: '',
        textContent: '',
        addEventListener: () => {},
        getAttribute: () => null,
        closest: () => null,
        scrollIntoView: () => {},
        focus: () => {},
        select: () => {},
        querySelector: (sel: string) => (sel.startsWith('#') ? getEl(sel.slice(1)) : null),
      };
    }
    const doc = {
      getElementById: (id: string) => getEl(id),
      querySelector: () => null,
      addEventListener: () => {},
      activeElement: null,
    };
    const fetchStub = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ commands: manifest }) });

    new Function('document', 'fetch', script as string)(doc, fetchStub);
    await new Promise((r) => setTimeout(r, 0));

    // Every command appears as a row in the searchable master list.
    for (const e of manifest) {
      expect(getEl('list-items').innerHTML, `#${e.name} list row missing`).toContain(`#${e.name}`);
    }
    // The detail pane shows the default-selected (first prompt-backed) command's
    // injected system prompt, with placeholder <token>s accent-tinted.
    expect(getEl('detail').innerHTML).toContain('injected system prompt');
    expect(getEl('detail').innerHTML).toContain('<span class="ph">');
    // Stats reflect the manifest, not hardcoded numbers.
    expect(getEl('stats').innerHTML).toContain(`${manifest.length}</b><span>commands`);
  });
});

// spec 186: same smoke-render for the /tools page script. The real payload
// comes from Rust (`bus_tool_descriptors()` — covered by a Rust test); here a
// fixture in the same descriptor shape guards the page's rendering contract
// (field names, schema traversal, chips) without a browser.
describe('artifact-tools.html render', () => {
  it('renders descriptor-shaped tools from /tools.json', async () => {
    const html = readFileSync(join(__dirname, 'artifact-tools.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script, 'inline script missing').toBeTruthy();

    const tools = [
      {
        name: 'handoff_set',
        category: 'memory',
        description: "Write your lane's single handoff document.",
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'One short headline.' },
            detail: { type: 'string', maxLength: 8000, description: 'The full body.' },
          },
          required: ['summary', 'detail'],
        },
      },
      {
        name: 'peer_list',
        category: 'peering',
        description: 'List live peer lanes.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'mark_review_priority',
        category: 'review',
        description: 'Tell the Diff Window where to spend reading attention.',
        inputSchema: {
          type: 'object',
          properties: {
            ranges: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' },
                  level: { enum: ['high', 'routine'] },
                },
                required: ['file', 'level'],
              },
            },
          },
          required: ['ranges'],
        },
      },
    ];
    const elements: Record<string, { innerHTML: string }> = {
      content: { innerHTML: '' },
      stats: { innerHTML: '' },
    };
    const doc = { getElementById: (id: string) => elements[id] };
    const fetchStub = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ tools }) });

    new Function('document', 'fetch', script as string)(doc, fetchStub);
    await new Promise((r) => setTimeout(r, 0));

    for (const t of tools) {
      expect(elements.content.innerHTML, `${t.name} card missing`).toContain(t.name);
    }
    // Params table: required star + maxLength chip; zero-param fallback.
    expect(elements.content.innerHTML).toContain('max 8000');
    expect(elements.content.innerHTML).toContain('no parameters');
    // Array-of-object item shape renders sub-params with enum chips.
    expect(elements.content.innerHTML).toContain('<span class="chip">high</span>');
    // Stats reflect the payload, not hardcoded numbers.
    expect(elements.stats.innerHTML).toContain(`${tools.length}</b><span>tools`);
    expect(elements.stats.innerHTML).toContain('3</b><span>categories');
  });
});
