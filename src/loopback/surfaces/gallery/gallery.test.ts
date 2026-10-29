import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NavContext } from '../../surfaces';
import { GalleryView, projectLabels } from './index';
import type { GalleryProject } from './index';

const fixture: GalleryProject[] = [
  {
    projectId: 'project-aaaaaa111111',
    projectName: 'krypton',
    artifacts: [
      { id: 'a1', state: 'live', size: 2048, hash: 'abcdef0123456789', token: 'tok one', title: 'Report', laneLabel: 'Codex-1', tail: 'report.html' },
      { id: 'a2', state: 'pending', title: 'Draft', laneLabel: 'Claude-2', tail: 'draft.html' },
    ],
  },
  {
    projectId: 'project-bbbbbb222222',
    projectName: 'xenon',
    artifacts: [{ id: 'b1', state: 'live', size: 10, token: 'tok2', title: 'Plot', laneLabel: 'Codex-3', tail: 'plot.html' }],
  },
];

function stubFetch(body: () => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body()), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

function press(key: string): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

function shellStub(ctx: Partial<NavContext> | null): { onContext(cb: (ctx: NavContext) => void): () => void } {
  return {
    onContext: (cb) => {
      if (ctx) cb(ctx as NavContext);
      return () => undefined;
    },
  };
}

function activeTab(root: HTMLElement): string {
  return root.querySelector('.lb-tabs__tab[aria-selected="true"] .lb-tabs__label')?.textContent ?? '';
}

describe('GalleryView', () => {
  let view: GalleryView | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  });
  afterEach(() => {
    view?.dispose();
    view = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders projects, switches tabs with ] and 0, and repaints in place', async () => {
    let body: unknown = { projects: fixture };
    stubFetch(() => body);
    view = new GalleryView(shellStub(null));
    document.body.append(view.el);
    await flush();

    const root = view.el;
    expect(root.querySelector('.lb-stats')?.textContent).toContain('3');
    expect(activeTab(root)).toBe('all');
    expect(root.querySelectorAll('.lb-gallery__project-head:not([hidden])')).toHaveLength(2);

    const live = root.querySelector<HTMLElement>('[data-state="live"]');
    const open = live?.querySelector<HTMLAnchorElement>('a.lb-gallery__open');
    expect(open?.getAttribute('href')).toBe('/artifact/tok%20one');
    expect(open?.target).toBe('_blank');
    expect(live?.querySelector('.lb-gallery__tail')?.textContent).toBe('abcdef012345 · report.html');
    const pending = root.querySelector<HTMLElement>('[data-state="pending"]');
    expect(pending?.querySelector('a')).toBeNull();
    expect(pending?.querySelector('.lb-gallery__size')?.textContent).toBe('writing…');
    expect(pending?.querySelector('.lb-pill')?.textContent).toBe('pending');

    press(']');
    expect(activeTab(root)).toBe('krypton');
    expect(root.querySelectorAll('.lb-gallery__art')).toHaveLength(2);
    press(']');
    expect(activeTab(root)).toBe('xenon');
    expect(root.querySelectorAll('.lb-gallery__art')).toHaveLength(1);
    press('1');
    expect(activeTab(root)).toBe('krypton');
    press('0');
    expect(activeTab(root)).toBe('all');
    expect(root.querySelectorAll('.lb-gallery__art')).toHaveLength(3);
    press('2');
    expect(activeTab(root)).toBe('xenon');
    press('1');
    expect(activeTab(root)).toBe('krypton');

    const before = root.querySelector('[data-state="live"]');
    body = {
      projects: [
        { ...fixture[0], artifacts: [fixture[0].artifacts?.[0], { ...fixture[0].artifacts?.[1], state: 'live', token: 't3', size: 5 }] },
        fixture[1],
      ],
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(root.querySelector('[data-state="live"]')).toBe(before);
    expect(root.querySelectorAll('[data-state="pending"]')).toHaveLength(0);
  });

  it('defaults to the shell project and shows the empty state', async () => {
    stubFetch(() => ({ projects: fixture }));
    view = new GalleryView(shellStub({ project: { projectId: 'project-bbbbbb222222' } as NavContext['project'] }));
    await flush();
    expect(activeTab(view.el)).toBe('xenon');
    view.dispose();

    stubFetch(() => ({ projects: [] }));
    view = new GalleryView(shellStub(null));
    await flush();
    expect(view.el.querySelector('.lb-empty')?.textContent).toContain('No artifacts yet');
    expect(view.el.querySelector<HTMLElement>('.lb-tabs')?.hidden).toBe(true);
  });

  it('suffixes same-basename project labels', () => {
    const labels = projectLabels([
      { projectId: 'project-aaaaaa111111', projectName: 'app' },
      { projectId: 'project-bbbbbb222222', projectName: 'app' },
    ]);
    expect(labels.get('project-aaaaaa111111')).toBe('app · 111111');
  });
});
