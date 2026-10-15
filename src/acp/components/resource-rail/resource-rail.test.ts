import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem, MessageResource } from '../../harness-view-types';
import { ResourceRail, type ResourceRailProps } from './index';

function resource(over: Partial<MessageResource> = {}): MessageResource {
  return {
    key: 'file:/w/src/ui/list.ts',
    kind: 'file',
    target: '/w/src/ui/list.ts',
    label: 'list.ts',
    source: 'markdown',
    hintLabel: null,
    ...over,
  };
}

function item(resources: MessageResource[], overflow = 0): HarnessTranscriptItem {
  return { id: 'm1', kind: 'assistant', text: 'body', resources, resourceOverflow: overflow };
}

function mount(props: ResourceRailProps): ResourceRail {
  const rail = new ResourceRail();
  rail.update(props);
  return rail;
}

describe('ResourceRail', () => {
  it('emits the REFERENCES head and one button per reference', () => {
    const rail = mount({ item: item([resource()]), projectDir: '/w', lane: null });

    expect(rail.el.className).toBe('acp-harness__resources');
    expect(rail.el.getAttribute('aria-label')).toBe('Message references');
    const head = rail.el.querySelector('.acp-harness__resources-head');
    expect(head?.textContent).toBe('REFERENCES1');
    const row = rail.el.querySelector<HTMLButtonElement>('[data-response-resource]');
    expect(row?.className).toBe('acp-harness__resource acp-harness__resource--file');
    expect(row?.type).toBe('button');
    expect(row?.dataset.responseResource).toBe('file:/w/src/ui/list.ts');
    expect(row?.title).toBe('src/ui/list.ts');
    expect(row?.getAttribute('aria-label')).toBe('Open file src/ui/list.ts');
    expect(row?.querySelector('.acp-harness__resource-label')?.textContent).toBe('list.ts');
    expect(row?.querySelector('.acp-harness__resource-target')?.textContent).toBe('src/ui/list.ts');
    expect(row?.querySelector('.acp-harness__resource-action')?.textContent).toBe('OPEN TAB ↗');
    expect(row?.querySelector('.acp-harness__resource-thumb')?.getAttribute('data-glyph')).toBe('code');
    expect(row?.querySelector('.acp-harness__resource-glyph')?.textContent).toBe('TS');
    expect(row?.querySelector('.acp-harness__resource-git')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('counts the hidden overflow in the head', () => {
    const rail = mount({ item: item([resource()], 4), projectDir: '/w', lane: null });

    expect(rail.el.querySelector('.acp-harness__resource-count')?.textContent).toBe('1 · +4 hidden');
  });

  it('draws a url reference as a globe with OPEN ↗', () => {
    const rail = mount({
      item: item([resource({ key: 'https://x.dev/a', kind: 'url', target: 'https://x.dev/a', label: 'x.dev' })]),
      projectDir: '/w',
      lane: null,
    });

    const row = rail.el.querySelector('[data-response-resource]');
    expect(row?.className).toBe('acp-harness__resource acp-harness__resource--url');
    expect(row?.querySelector('.acp-harness__resource-action')?.textContent).toBe('OPEN ↗');
    expect(row?.querySelector('svg use')?.getAttribute('href')).toBe('#krypton-icon-globe');
  });

  it('renders Git counts and says so in the accessible name', () => {
    const rail = mount({
      item: item([resource({ git: { status: 'M', countKind: 'lines', added: 12, removed: 3 } })]),
      projectDir: '/w',
      lane: null,
    });

    const git = rail.el.querySelector('.acp-harness__resource-git');
    expect(git?.querySelector('.acp-harness__resource-git-status')?.getAttribute('data-status')).toBe('M');
    expect(git?.querySelector('.acp-harness__resource-git-add')?.textContent).toBe('+12');
    expect(git?.querySelector('.acp-harness__resource-git-remove')?.textContent).toBe('−3');
    expect(rail.el.querySelector('[data-response-resource]')?.getAttribute('aria-label')).toBe(
      'Open file src/ui/list.ts. Modified, 12 lines added, 3 lines removed',
    );
  });

  it('shows BIN / N/A instead of counts for binary and unavailable files', () => {
    const binary = mount({
      item: item([resource({ git: { status: 'A', countKind: 'binary', added: null, removed: null } })]),
      projectDir: '/w',
      lane: null,
    });
    const unavailable = mount({
      item: item([resource({ git: { status: 'D', countKind: 'unavailable', added: null, removed: null } })]),
      projectDir: '/w',
      lane: null,
    });

    expect(binary.el.querySelector('.acp-harness__resource-git-counts')?.textContent).toBe('BIN');
    expect(unavailable.el.querySelector('.acp-harness__resource-git-counts')?.textContent).toBe('N/A');
  });

  it('repaints the rows when late Git state lands, keeping the head node', () => {
    const payload = resource();
    const props: ResourceRailProps = { item: item([payload]), projectDir: '/w', lane: null };
    const rail = mount(props);
    const head = rail.el.firstElementChild;

    payload.git = { status: 'M', countKind: 'lines', added: 1, removed: 0 };
    rail.update(props);

    expect(rail.el.firstElementChild).toBe(head);
    expect(rail.el.querySelector('.acp-harness__resource-git-status')?.textContent).toBe('M');
  });

  it('writes nothing while its dependency tuple holds', () => {
    const props: ResourceRailProps = { item: item([resource()]), projectDir: '/w', lane: null };
    const rail = mount(props);
    const observer = new MutationObserver(() => undefined);
    observer.observe(rail.el, { childList: true, subtree: true, attributes: true, characterData: true });

    rail.update(props);

    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it('marks a hinted reference and puts the hint inside the thumb', () => {
    const rail = mount({ item: item([resource({ hintLabel: 'a' })]), projectDir: '/w', lane: null });

    const row = rail.el.querySelector('[data-response-resource]');
    expect(row?.classList.contains('acp-harness__resource--hinted')).toBe(true);
    expect(row?.querySelector('.acp-harness__resource-thumb > .acp-harness__resource-hint')?.textContent).toBe('a');
  });
});
