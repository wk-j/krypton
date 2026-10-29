import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCommandManifest } from '../../../acp/hash-commands';
import type { CommandManifestEntry } from '../../../acp/hash-commands';

import { CommandsView, promptNodes } from './index';

function stubFetch(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  );
}

function press(key: string, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const text = (root: ParentNode, selector: string): string => root.querySelector(selector)?.textContent ?? '';

describe('CommandsView', () => {
  let view: CommandsView;

  async function mount(body: unknown, ok = true): Promise<CommandsView> {
    stubFetch(body, ok);
    view = new CommandsView();
    document.body.append(view.el);
    await view.load();
    return view;
  }

  afterEach(() => {
    view.dispose();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('renders every manifest command into its section of the master list', async () => {
    const manifest = buildCommandManifest();
    await mount({ commands: manifest });

    const rows = [...view.el.querySelectorAll('.lb-roster__item')].map((row) => row.textContent);
    for (const e of manifest) expect(rows, `#${e.name} list row missing`).toContain(`#${e.name}`);
    const titles = [...view.el.querySelectorAll('.lb-commands__group h2')].map((h) => h.textContent);
    expect(titles).toEqual(['Session & lane control', 'Browser surfaces', 'Orchestration & agent-driven']);
    const surfaceRows = [...view.el.querySelectorAll('.lb-commands__group')][1].querySelectorAll('.lb-roster__item');
    expect(surfaceRows.length).toBe(manifest.filter((e) => e.category === 'surface').length);

    // The detail pane shows the first prompt-backed command with its placeholder tokens tinted.
    const first = manifest.find((e) => e.prompt) as CommandManifestEntry;
    expect(view.selected()).toBe(first.name);
    expect(text(view.el, '.lb-commands__title')).toContain(`#${first.name}`);
    expect(text(view.el, '.lb-commands__prompt-label')).toContain('injected system prompt');
    expect(view.el.querySelector('.lb-commands__prompt .lb-commands__ph')).not.toBeNull();
    expect(text(view.el, '.lb-commands__prompt')).toBe(first.prompt);

    // Stats reflect the manifest, not hardcoded numbers.
    const stats = [...view.el.querySelectorAll('.lb-stat')].map((s) => s.textContent);
    expect(stats).toContain(`${manifest.length}commands`);
    expect(stats).toContain(`${manifest.filter((e) => e.prompt).length}system prompts`);
  });

  it('walks the filtered list with j/k and arrows, and filters from /', async () => {
    const commands: CommandManifestEntry[] = [
      { name: 'new', args: '', description: 'Open a lane', category: 'session', badges: [] },
      { name: 'docs', args: '', description: 'Repo docs', category: 'surface', badges: [] },
      {
        name: 'polly',
        args: '<task>',
        description: 'Fan out',
        category: 'agent',
        badges: ['workflow'],
        anatomy: 'plan → fan out → merge',
        lanes: '3 lanes',
        prompt: 'Run <task> across lanes.',
      },
    ];
    await mount({ commands });
    expect(view.selected()).toBe('polly');
    expect(text(view.el, '.lb-commands__anatomy')).toBe('plan → fan out → merge');
    expect([...view.el.querySelectorAll('.lb-commands__badges .lb-pill')].map((p) => p.textContent)).toEqual([
      'workflow',
      '3 lanes',
    ]);

    press('k');
    expect(view.selected()).toBe('docs');
    press('ArrowUp');
    expect(view.selected()).toBe('new');
    expect(text(view.el, '.lb-commands__no-prompt')).toContain('no injected system prompt');
    press('j');
    expect(view.selected()).toBe('docs');
    expect(view.el.querySelector('[data-key="docs"]')?.getAttribute('aria-selected')).toBe('true');

    press('/');
    const input = view.el.querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = 'lane';
    input.dispatchEvent(new Event('input'));
    expect([...view.el.querySelectorAll('.lb-roster__item')].map((r) => r.textContent)).toEqual(['#new']);
    // Groups without a hit disappear; j snaps to the first visible command.
    expect(view.el.querySelectorAll('.lb-commands__group:not([hidden])').length).toBe(1);
    input.blur();
    press('j');
    expect(view.selected()).toBe('new');

    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    expect(text(view.el, '.lb-commands__no-hits')).toBe('no command matches “zzz”');
    expect((view.el.querySelector('.lb-commands__no-hits') as HTMLElement).hidden).toBe(false);

    // Esc inside the box leaves it and keeps the query (the old page's behaviour).
    input.focus();
    press('Escape', input);
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe('zzz');
    expect(view.el.querySelectorAll('.lb-roster__item').length).toBe(0);
  });

  it('selects on click and copies the prompt with c', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount({
      commands: [
        { name: 'new', args: '', description: 'Open a lane', category: 'session', badges: [] },
        { name: 'draw', args: '', description: 'Draw', category: 'agent', badges: [], prompt: 'Draw <drawing request>.' },
      ],
    });
    (view.el.querySelector('[data-key="new"]') as HTMLElement).click();
    expect(view.selected()).toBe('new');
    press('c');
    expect(writeText).not.toHaveBeenCalled();

    (view.el.querySelector('[data-key="draw"]') as HTMLElement).click();
    press('c');
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('Draw <drawing request>.'));
    await vi.waitFor(() => expect(text(view.el, '.lb-banner')).toBe('system prompt copied'));
  });

  it('explains an empty manifest and a failed load', async () => {
    await mount({ commands: [] });
    expect(view.el.textContent).toContain('no command manifest yet');
    view.dispose();

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    view = new CommandsView();
    await view.load();
    expect(view.el.textContent).toContain('could not load /commands.json');
  });
});

describe('promptNodes', () => {
  it('tints each <placeholder> and keeps the rest as text', () => {
    const nodes = promptNodes('Fix <owner/repo#123> then <x>, not a < b > c.');
    const spans = nodes.filter((n): n is HTMLElement => n instanceof HTMLElement).map((n) => n.textContent);
    expect(spans).toEqual(['<owner/repo#123>', '<x>', '< b >']);
    expect(nodes.map((n) => (typeof n === 'string' ? n : n.textContent)).join('')).toBe(
      'Fix <owner/repo#123> then <x>, not a < b > c.',
    );
  });
});
