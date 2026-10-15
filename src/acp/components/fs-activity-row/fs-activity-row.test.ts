import { describe, expect, it } from 'vitest';

import type { FsActivityPayload, HarnessTranscriptItem } from '../../harness-view-types';
import type { RowProps } from '../transcript-row';
import { FsActivityRow } from './index';

function props(fsActivity: FsActivityPayload | undefined, isNew = false): RowProps {
  const item: HarnessTranscriptItem = { id: 'fs1', kind: 'fs_activity', text: 'fs', fsActivity };
  return { item, isNew, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function watch(node: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
  return observer;
}

function animationEnd(name: string): Event {
  const event = new Event('animationend');
  Object.defineProperty(event, 'animationName', { value: name });
  return event;
}

function mount(payload: FsActivityPayload | undefined): { row: FsActivityRow; body: HTMLElement } {
  const row = new FsActivityRow(props(payload));
  row.update(props(payload));
  const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
  if (!body) throw new Error('fs activity row did not paint');
  return { row, body };
}

describe('FsActivityRow', () => {
  it('emits the read chip', () => {
    const { row, body } = mount({ method: 'read', path: 'src/acp/list.ts', ok: true });

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--fs_activity');
    expect(body.className).toBe('acp-harness__msg-body acp-harness__fs-activity');
    expect(body.innerHTML).toBe(
      '<span class="acp-harness__fs-activity-icon">📖</span>' +
      '<span class="acp-harness__fs-activity-verb">read</span>' +
      '<span class="acp-harness__fs-activity-path" title="src/acp/list.ts">src/acp/list.ts</span>',
    );
    row.dispose();
  });

  it('emits the write chip with the past-tense verb', () => {
    const { row, body } = mount({ method: 'write', path: 'src/ui/component.ts', ok: true });
    expect(body.querySelector('.acp-harness__fs-activity-icon')?.textContent).toBe('✏️');
    expect(body.querySelector('.acp-harness__fs-activity-verb')?.textContent).toBe('wrote');
    row.dispose();
  });

  it('emits the failure chip and drops --err when a later payload succeeds', () => {
    const payload: FsActivityPayload = { method: 'write', path: 'src/ui/component.ts', ok: false, error: 'EACCES' };
    const { row, body } = mount(payload);
    expect(body.className)
      .toBe('acp-harness__msg-body acp-harness__fs-activity acp-harness__fs-activity--err');
    expect(body.querySelector('.acp-harness__fs-activity-icon')?.textContent).toBe('✗');
    expect(body.querySelector('.acp-harness__fs-activity-verb')?.textContent).toBe('write failed');
    expect(body.querySelector('.acp-harness__fs-activity-error')?.textContent).toBe('EACCES');

    payload.ok = true;
    payload.error = undefined;
    row.update(props(payload));
    expect(body.className).toBe('acp-harness__msg-body acp-harness__fs-activity');
    expect(body.querySelector('.acp-harness__fs-activity-error')).toBeNull();
    row.dispose();
  });

  it('keeps the three cell nodes across an update and writes nothing when nothing moved', () => {
    const payload: FsActivityPayload = { method: 'read', path: 'a.ts', ok: true };
    const { row, body } = mount(payload);
    const cells = [...body.children];

    payload.path = 'b.ts';
    row.update(props(payload));
    expect([...body.children]).toEqual(cells);
    expect(body.querySelector('.acp-harness__fs-activity-path')?.textContent).toBe('b.ts');

    const observer = watch(row.el);
    row.update(props(payload));
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    row.dispose();
  });

  it('keeps a cell for an empty path', () => {
    const { row, body } = mount({ method: 'read', path: '', ok: true });
    const path = body.querySelector<HTMLElement>('.acp-harness__fs-activity-path');
    expect(path?.textContent).toBe('«empty»');
    expect(path?.title).toBe('');
    row.dispose();
  });

  it('falls back to the item text when the payload is missing', () => {
    const { row, body } = mount(undefined);
    expect(body.className).toBe('acp-harness__msg-body');
    expect(body.textContent).toBe('fs');
    row.dispose();
  });

  it('detaches the entrance listener on dispose', () => {
    const payload: FsActivityPayload = { method: 'read', path: 'a.ts', ok: true };
    const row = new FsActivityRow(props(payload, true));
    row.update(props(payload, true));
    row.dispose();
    row.el.dispatchEvent(animationEnd('acp-harness-msg-enter'));
    expect(row.el.classList.contains('acp-harness__msg--enter')).toBe(true);
  });
});
