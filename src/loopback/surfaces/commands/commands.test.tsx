import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCommandManifest } from '../../../acp/hash-commands';
import type { CommandManifestEntry } from '../../../acp/hash-commands';
import { act, flush, press, render } from '../../kit/test-utils';
import type { Rendered } from '../../kit/test-utils';

import { CommandsPage, promptNodes } from './index';

function stubFetch(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  );
}

const text = (root: ParentNode, selector: string): string => root.querySelector(selector)?.textContent ?? '';

describe('CommandsPage', () => {
  let view: Rendered | null = null;
  let root: HTMLElement;

  async function mount(body: unknown, ok = true): Promise<void> {
    stubFetch(body, ok);
    view = render(<CommandsPage />);
    root = view.container;
    await flush();
  }

  const selected = (): string | null => root.querySelector('.lb-roster__item[aria-selected="true"]')?.getAttribute('data-key') ?? null;

  function type(input: HTMLInputElement, value: string): void {
    act(() => {
      // React tracks `value`; go through the prototype setter so the input event reads as a user edit.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  afterEach(() => {
    view?.unmount();
    view = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('renders every manifest command into its section of the master list', async () => {
    const manifest = buildCommandManifest();
    await mount({ commands: manifest });

    const rows = [...root.querySelectorAll('.lb-roster__item')].map((row) => row.textContent);
    for (const e of manifest) expect(rows, `#${e.name} list row missing`).toContain(`#${e.name}`);
    const titles = [...root.querySelectorAll('.lb-commands__group h2')].map((h) => h.textContent);
    expect(titles).toEqual(['Session & lane control', 'Browser surfaces', 'Orchestration & agent-driven']);
    const surfaceRows = [...root.querySelectorAll('.lb-commands__group')][1].querySelectorAll('.lb-roster__item');
    expect(surfaceRows.length).toBe(manifest.filter((e) => e.category === 'surface').length);

    // The detail pane shows the first prompt-backed command with its placeholder tokens tinted.
    const first = manifest.find((e) => e.prompt) as CommandManifestEntry;
    expect(selected()).toBe(first.name);
    expect(text(root, '.lb-commands__title')).toContain(`#${first.name}`);
    expect(text(root, '.lb-commands__prompt-label')).toContain('injected system prompt');
    expect(root.querySelector('.lb-commands__prompt .lb-commands__ph')).not.toBeNull();
    expect(text(root, '.lb-commands__prompt')).toBe(first.prompt);

    // Stats reflect the manifest, not hardcoded numbers.
    const stats = [...root.querySelectorAll('.lb-stat')].map((s) => s.textContent);
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
    expect(selected()).toBe('polly');
    expect(text(root, '.lb-commands__anatomy')).toBe('plan → fan out → merge');
    expect([...root.querySelectorAll('.lb-commands__badges .lb-pill')].map((p) => p.textContent)).toEqual([
      'workflow',
      '3 lanes',
    ]);

    press('k');
    expect(selected()).toBe('docs');
    press('ArrowUp');
    expect(selected()).toBe('new');
    expect(text(root, '.lb-commands__no-prompt')).toContain('no injected system prompt');
    press('j');
    expect(selected()).toBe('docs');
    expect(root.querySelector('[data-key="docs"]')?.getAttribute('aria-selected')).toBe('true');

    press('/');
    const input = root.querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    type(input, 'lane');
    expect([...root.querySelectorAll('.lb-roster__item')].map((r) => r.textContent)).toEqual(['#new']);
    // Groups without a hit disappear; j snaps to the first visible command.
    expect(root.querySelectorAll('.lb-commands__group:not([hidden])').length).toBe(1);
    act(() => input.blur());
    press('j');
    expect(selected()).toBe('new');

    type(input, 'zzz');
    expect(text(root, '.lb-commands__no-hits')).toBe('no command matches “zzz”');
    expect((root.querySelector('.lb-commands__no-hits') as HTMLElement).hidden).toBe(false);

    // Esc inside the box leaves it and keeps the query (the old page's behaviour).
    act(() => input.focus());
    press('Escape', {}, input);
    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe('zzz');
    expect(root.querySelectorAll('.lb-roster__item').length).toBe(0);
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
    act(() => (root.querySelector('[data-key="new"]') as HTMLElement).click());
    expect(selected()).toBe('new');
    press('c');
    expect(writeText).not.toHaveBeenCalled();

    act(() => (root.querySelector('[data-key="draw"]') as HTMLElement).click());
    press('c');
    await flush();
    expect(writeText).toHaveBeenCalledWith('Draw <drawing request>.');
    expect(text(root, '.lb-banner')).toBe('system prompt copied');
  });

  it('explains an empty manifest and a failed load', async () => {
    await mount({ commands: [] });
    expect(root.textContent).toContain('no command manifest yet');
    view?.unmount();

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    view = render(<CommandsPage />);
    root = view.container;
    await flush();
    expect(root.textContent).toContain('could not load /commands.json');
  });
});

describe('promptNodes', () => {
  it('tints each <placeholder> and keeps the rest as text', () => {
    const view = render(<pre>{promptNodes('Fix <owner/repo#123> then <x>, not a < b > c.')}</pre>);
    const spans = [...view.container.querySelectorAll('.lb-commands__ph')].map((n) => n.textContent);
    expect(spans).toEqual(['<owner/repo#123>', '<x>', '< b >']);
    expect(view.container.textContent).toBe('Fix <owner/repo#123> then <x>, not a < b > c.');
    view.unmount();
  });
});
