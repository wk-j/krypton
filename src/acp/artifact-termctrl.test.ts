import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const html = readFileSync(join(__dirname, 'artifact-termctrl.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

describe('Terminal Control monitor page', () => {
  it('keeps the visible terminal screen text-only', () => {
    expect(html).toContain("var text = typeof payload.text === 'string'");
    expect(html).toContain('screenEl.textContent = text');
    expect(html).not.toMatch(/screenEl\.innerHTML/);
    expect(html).not.toMatch(/insertAdjacentHTML/);
  });

  it('uses the capability path for relative list and screen requests', () => {
    expect(html).toContain("var apiBase = '/termctrl/api/' + encodeURIComponent(token)");
    expect(html).toContain("apiBase + '/sessions'");
    expect(html).toContain("apiBase + '/screen/' + encodeURIComponent(session.name)");
  });

  it('pauses polling while hidden and prevents overlapping requests', () => {
    expect(html).toContain("document.visibilityState === 'hidden'");
    expect(html).toContain('if (listInFlight');
    expect(html).toContain('if (!session || screenInFlight');
    expect(html).toContain("document.addEventListener('visibilitychange'");
    expect(html).toContain('stopTimers()');
  });

  it('provides keyboard filtering, selection, and refresh', () => {
    expect(html).toContain('event.metaKey || event.ctrlKey || event.altKey');
    expect(html).toContain("event.key === '/'");
    expect(html).toContain("event.key === 'j'");
    expect(html).toContain("event.key === 'k'");
    expect(html).toContain("event.key === 'r'");
    expect(html).toContain("event.key === 'Escape'");
  });

  it('retains row focus and caches immutable exited screens', () => {
    expect(html).toContain("row.dataset.sessionName = session.name");
    expect(html).toContain("row.focus({ preventScroll: true })");
    expect(html).toContain("session.state === 'exited' && screenCache.has(session.name)");
  });

  it('keeps unavailable guidance stable across later request errors', () => {
    expect(html).toContain('firstLoad = false;');
    expect(html.indexOf('firstLoad = false;')).toBeLessThan(html.indexOf("showEmpty(\n              'termctrl is unavailable'"));
  });

  it('has parseable inline JavaScript and no writable session control', () => {
    expect(inlineScripts).toHaveLength(1);
    expect(() => new Function(inlineScripts[0])).not.toThrow();
    expect(html).not.toMatch(/\/send|\/stop|\/restart|\/resize|WebSocket/i);
  });

  it('uses full selection borders and no accent rails', () => {
    expect(html).toContain('.session[aria-selected="true"] { border-color: var(--accent)');
    expect(html).not.toContain('border-left:');
  });
});
