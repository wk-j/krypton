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

/** Spec 310: the one inline panel the view owns and moves between cards. */
function genUiPanel(v: AcpHarnessView): { el: HTMLElement; isOpen: boolean } {
  return (v as unknown as { genUiPanel: { el: HTMLElement; isOpen: boolean } }).genUiPanel;
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

  // Spec 310: the generative-UI panel is seated in the card inside the sealed
  // row, so the two hazards an overlay did not have are a repaint of that row
  // and the row leaving the tail window.
  it('seats the generative-UI panel in the card, re-seats it across a repaint, and collapses when the row goes', () => {
    const lane = call<HarnessLane>(view, 'createLane', 'claude', 'claude-1');
    lanes(view).push(lane);
    activate(view, lane.id);

    const item: HarnessTranscriptItem = {
      id: 'a1',
      kind: 'assistant',
      text: [
        'here it is',
        '',
        '```krypton-ui',
        '$seats = 10',
        'Card("Estimate", [',
        '  Slider($seats, 1, 50, label: "Seats"),',
        '  Metric("Total", "$" + ($seats * 29))',
        '])',
        '```',
      ].join('\n'),
    };
    lane.transcript.push(item);
    call(view, 'renderDashboard');

    const row = view.element.querySelector('.acp-harness__msg[data-msg-id="a1"]') as HTMLElement;
    const card = row.querySelector('.acp-genui-card') as HTMLElement;
    expect(card, 'the fence decorated into a card').not.toBeNull();
    expect(card.querySelector('[data-genui-slot="0"]')?.children).toHaveLength(0);

    const panel = genUiPanel(view);
    call(view, 'openGenUi', 'a1', 0);
    expect(panel.isOpen).toBe(true);
    expect(panel.el.parentElement).toBe(row.querySelector('[data-genui-slot="0"]'));
    expect(row.querySelector('.acp-genui-card')?.className).toContain('acp-genui-card--open');
    expect(row.querySelector('[data-genui-index="0"]')?.getAttribute('aria-expanded')).toBe('true');

    // The input recomputes in place, inside the sealed row.
    const range = panel.el.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = '20';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.el.textContent).toContain('$580');

    // A dep change repaints the row: `paintSealed` rebuilds the card from pure
    // markdown, and the same panel node must come back with its state.
    item.annotations = [{
      id: 'n1', itemId: 'a1', quote: 'here', quoteIndex: 0, body: 'note', status: 'unsent', createdAt: 0,
    }];
    call(view, 'renderDashboard');
    const repainted = view.element.querySelector('.acp-harness__msg[data-msg-id="a1"] [data-genui-slot="0"]');
    expect(panel.isOpen).toBe(true);
    expect(panel.el.parentElement).toBe(repainted);
    expect(panel.el.querySelector('input[type="range"]')).toBe(range);
    expect(panel.el.textContent).toContain('$580');

    // The row leaves the tail window: nothing can host the panel, so it
    // collapses on its own and the inputs stay in the view's LRU.
    lane.transcriptWindow = 0;
    call(view, 'renderDashboard');
    expect(panel.isOpen).toBe(false);
    expect(panel.el.isConnected).toBe(false);

    lane.transcriptWindow = Number.POSITIVE_INFINITY;
    call(view, 'renderDashboard');
    call(view, 'openGenUi', 'a1', 0);
    expect(panel.el.textContent).toContain('$580');

    // Toggling the same card collapses it.
    call(view, 'openGenUi', 'a1', 0);
    expect(panel.isOpen).toBe(false);
    expect(view.element.querySelector('.acp-genui-card--open')).toBeNull();
  });

  // Spec 310: the panel is inline, so an overlay drawn over it must own the
  // keyboard — the `OverlayShell` registry no longer closes the panel.
  it('gives an open overlay the keyboard ahead of the inline panel', () => {
    const lane = call<HarnessLane>(view, 'createLane', 'claude', 'claude-1');
    lanes(view).push(lane);
    activate(view, lane.id);
    lane.transcript.push({
      id: 'a1',
      kind: 'assistant',
      text: ['```krypton-ui', '$n = 1', 'Card("Pick", [Slider($n, 1, 9)])', '```'].join('\n'),
    });
    call(view, 'renderDashboard');
    const panel = genUiPanel(view);
    call(view, 'openGenUi', 'a1', 0);
    expect(panel.isOpen).toBe(true);

    call(view, 'toggleHelp', true);
    view.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect((view as unknown as { helpOpen: boolean }).helpOpen).toBe(false);
    expect(panel.isOpen, 'the help overlay consumed the key, not the panel').toBe(true);

    view.onKeyDown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(panel.isOpen).toBe(false);
  });
});
