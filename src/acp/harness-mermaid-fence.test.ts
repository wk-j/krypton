import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: mermaidMock }));

import {
  cachedMermaid,
  clearMermaidCache,
  mermaidThemeVariables,
  normalizeDiagramType,
  renderMermaid,
  type MermaidTheme,
} from './harness-mermaid-fence';
import { isFenceClosed } from './harness-svg-fence';

const DARK: MermaidTheme = { key: 'dark', config: { theme: 'base', darkMode: true } };
const LIGHT: MermaidTheme = { key: 'light', config: { theme: 'base', darkMode: false } };

beforeEach(() => {
  clearMermaidCache();
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
  mermaidMock.render.mockImplementation(async (_id: string, text: string) => {
    if (text.includes('bad')) throw new Error('Parse error on line 2:\n...');
    return { svg: `<svg viewBox="0 0 10 10">${text}</svg>`, diagramType: 'flowchart-v2' };
  });
});

describe('normalizeDiagramType', () => {
  it('turns mermaid diagram ids into card labels', () => {
    expect(normalizeDiagramType('flowchart-v2')).toBe('flowchart');
    expect(normalizeDiagramType('stateDiagram')).toBe('state');
    expect(normalizeDiagramType('classDiagram')).toBe('class');
    expect(normalizeDiagramType('sequence')).toBe('sequence');
    expect(normalizeDiagramType('')).toBe('diagram');
  });
});

describe('mermaidThemeVariables', () => {
  it('maps the palette and falls back border → muted → fg', () => {
    const vars = mermaidThemeVariables({ fg: '#eeeeee', surface: '#111111' }, 'Mono');
    expect(vars.primaryTextColor).toBe('#eeeeee');
    expect(vars.mainBkg).toBe('#111111');
    expect(vars.lineColor).toBe('#eeeeee');
    expect(vars.clusterBorder).toBe('#eeeeee');
    expect(vars.fontFamily).toBe('Mono');
  });

  it('colours pie slices from c1…c6 and leaves missing ones to mermaid', () => {
    const vars = mermaidThemeVariables({ c1: '#ff00ff', c3: '#0000ff' }, 'Mono');
    expect(vars.pie1).toBe('#ff00ff');
    expect(vars.pie3).toBe('#0000ff');
    expect('pie2' in vars).toBe(false);
  });
});

describe('renderMermaid', () => {
  it('renders once per source and theme, then serves the cache', async () => {
    const first = await renderMermaid('graph LR; A-->B', DARK);
    expect(first).toEqual({ ok: true, svg: '<svg viewBox="0 0 10 10">graph LR; A-->B</svg>', diagramType: 'flowchart' });
    expect(cachedMermaid('graph LR; A-->B', DARK)).toEqual(first);
    await renderMermaid('graph LR; A-->B', DARK);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it('re-initializes and re-renders when the theme changes', async () => {
    await renderMermaid('graph LR; A-->B', DARK);
    expect(cachedMermaid('graph LR; A-->B', LIGHT)).toBeUndefined();
    await renderMermaid('graph LR; A-->B', LIGHT);
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(LIGHT.config);
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
  });

  it('caches a parse error so a rebuilt row does not re-render it', async () => {
    const result = await renderMermaid('graph LR; bad', DARK);
    expect(result).toEqual({ ok: false, error: 'Parse error on line 2:\n...' });
    await renderMermaid('graph LR; bad', DARK);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it('joins an in-flight render and skips one nobody still wants', async () => {
    const gone = renderMermaid('graph TD; X-->Y', DARK, () => false);
    expect(await gone).toBeNull();
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(cachedMermaid('graph TD; X-->Y', DARK)).toBeUndefined();

    let detached = false;
    const old = renderMermaid('graph TD; P-->Q', DARK, () => !detached);
    const rebuilt = renderMermaid('graph TD; P-->Q', DARK, () => true);
    detached = true;
    const [a, b] = await Promise.all([old, rebuilt]);
    expect(a).toEqual(b);
    expect(a?.ok).toBe(true);
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used result past the cap', async () => {
    await renderMermaid('graph LR; keep', DARK);
    for (let i = 0; i < 64; i++) {
      cachedMermaid('graph LR; keep', DARK); // touch: stays most recent
      await renderMermaid(`graph LR; n${i}`, DARK);
    }
    expect(cachedMermaid('graph LR; keep', DARK)).toBeDefined();
    expect(cachedMermaid('graph LR; n0', DARK)).toBeUndefined();
  });
});

describe('isFenceClosed', () => {
  // Minimal node shapes: only parentNode/nextSibling are read.
  const node = (parentNode: object | null, nextSibling: object | null = null): Node =>
    ({ parentNode, nextSibling }) as unknown as Node;

  it('is open while the fence is the last thing written', () => {
    const body = node(null);
    const li = node(body);
    expect(isFenceClosed(node(body), body)).toBe(false);
    expect(isFenceClosed(node(li), body)).toBe(false);
  });

  it('is closed once anything follows it, at any depth below the body', () => {
    const body = node(null);
    expect(isFenceClosed(node(body, {}), body)).toBe(true);
    const li = node(body, {});
    expect(isFenceClosed(node(li), body)).toBe(true);
  });
});
