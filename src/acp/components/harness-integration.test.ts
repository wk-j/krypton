// Spec 301 — integration cover for the component cutover.
//
// The per-component suites prove each surface in isolation; this one proves the
// WIRING: that the real `AcpHarnessView` paints lane shell, transcript rows and
// composer from real lane state, that the transcript body survives a repaint
// (the regression `LaneShell` exists to make impossible), that no row carries a
// render signature any more, and that a turn-end seal reaches the row
// component.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The view talks to Tauri on mount and on its metric poll; every call returns an
// empty list so the poll parses instead of rejecting.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
  convertFileSrc: (p: string) => p,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));
vi.mock('../../profiler/ipc', () => ({ invoke: vi.fn(async () => []) }));

import { AcpHarnessView } from '../acp-harness-view';
import type { HarnessLane, HarnessTranscriptItem } from '../harness-view-types';
import type { TranscriptAnnotation } from '../types';

let view: AcpHarnessView;

// The view keeps its state and render methods private on purpose (spec 275: a
// controller reaches it only through a host contract). An integration test has
// to drive the real thing, so these three are the deliberate test seam — the
// only unchecked casts in the file, and they assert nothing about shape.
function lanes(v: AcpHarnessView): HarnessLane[] {
  return (v as unknown as { lanes: HarnessLane[] }).lanes;
}

function activate(v: AcpHarnessView, laneId: string): void {
  const state = v as unknown as { activeLaneId: string };
  state.activeLaneId = laneId;
}

function call<T>(v: AcpHarnessView, name: string, ...args: unknown[]): T {
  const fn = (v as unknown as Record<string, (...a: unknown[]) => T>)[name];
  return fn.call(v, ...args);
}

beforeEach(() => {
  document.body.replaceChildren();
  view = new AcpHarnessView('/tmp/proj');
  document.body.appendChild(view.element);
});

describe('harness view integration (spec 301)', () => {
  it('paints lane shell, transcript rows and composer from real view state', () => {
    const lane = call<HarnessLane>(view, 'createLane', 'claude', 'claude-1');
    lanes(view).push(lane);
    activate(view, lane.id);

    const agent: HarnessTranscriptItem = { id: 'a1', kind: 'assistant', text: 'hello world' };
    const tool: HarnessTranscriptItem = {
      id: 't1',
      kind: 'tool',
      text: '',
      tool: {
        glyph: '⠙',
        status: 'in_progress',
        kind: 'execute',
        subject: 'npm run check',
        command: 'npm run check',
        result: '',
        sections: [],
        diffs: [],
      },
    };
    lane.transcript.push(agent, tool);
    lane.currentAssistantId = 'a1';

    call(view, 'renderDashboard');
    call(view, 'renderComposer');

    const root = view.element;
    const shell = root.querySelector('.acp-harness__lane--active');
    expect(shell, 'active lane shell').not.toBeNull();
    const body = root.querySelector('.acp-harness__lane-body');
    expect(body, 'pinned transcript body').not.toBeNull();

    const rows = [...root.querySelectorAll('.acp-harness__msg[data-msg-id]')];
    const ids = rows.map((r) => (r as HTMLElement).dataset.msgId);
    expect(ids.slice(-2)).toEqual(['a1', 't1']);
    expect(rows[rows.length - 2].className).toContain('acp-harness__msg--streaming');
    expect(root.querySelector('.acp-harness__tool-head')).not.toBeNull();
    expect(root.querySelector('.acp-harness__lane-head')).not.toBeNull();
    expect(root.querySelector('.acp-harness__input-line')).not.toBeNull();

    // No signature attribute survives the cutover.
    expect(root.querySelector('[data-render-signature]')).toBeNull();

    // The body node survives a repaint: that is the whole point of LaneShell.
    const bodyNode = body as HTMLElement;
    call(view, 'renderDashboard');
    expect(root.querySelector('.acp-harness__lane-body')).toBe(bodyNode);

    // Sealing drops the streaming class without a repaint of the row.
    call(view, 'sealStreaming', lane);
    const sealed = root.querySelector('.acp-harness__msg[data-msg-id="a1"]') as HTMLElement;
    expect(sealed.className).not.toContain('--streaming');
  });

  // Spec 302 §5.8: the rail is transcript content — it is emitted into the
  // message body by `AssistantRow`, not into a rail slot — and a deleted note
  // leaves its siblings' nodes alone.
  it('paints the annotation rail into the body of the reply it annotates', () => {
    const lane = call<HarnessLane>(view, 'createLane', 'claude', 'claude-1');
    lanes(view).push(lane);
    activate(view, lane.id);

    const note = (id: string, body: string): TranscriptAnnotation => ({
      id,
      itemId: 'a1',
      quote: 'hello',
      quoteIndex: 0,
      body,
      status: 'unsent',
      createdAt: 0,
    });
    const item: HarnessTranscriptItem = {
      id: 'a1',
      kind: 'assistant',
      text: 'hello world',
      annotations: [note('n1', 'first note'), note('n2', 'second note')],
    };
    lane.transcript.push(item);

    call(view, 'renderDashboard');

    const row = view.element.querySelector('.acp-harness__msg[data-msg-id="a1"]') as HTMLElement;
    const rail = row.querySelector('.acp-harness__anno-rail');
    expect(rail?.parentElement?.className).toContain('acp-harness__msg-body');
    expect(view.element.querySelector('.acp-harness__lane-rail .acp-harness__anno-rail')).toBeNull();
    expect(rail?.querySelector('.acp-harness__anno-send')?.textContent).toBe('send 2');
    const kept = rail?.querySelectorAll('.acp-harness__anno-item')[1];

    // The owner edits the array in place, as `deleteAnnotationById` does.
    item.annotations?.splice(0, 1);
    call(view, 'renderDashboard');

    const items = [...row.querySelectorAll('.acp-harness__anno-item')];
    expect(items.length).toBe(1);
    expect(items[0]).toBe(kept);
    expect(row.querySelector('.acp-harness__anno-send')?.textContent).toBe('send 1');
  });
});
