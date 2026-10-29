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

import { invoke } from '@tauri-apps/api/core';

import { AcpHarnessView } from '../acp-harness-view';
import type { HarnessLane, HarnessTranscriptItem } from '../harness-view-types';
import type { TranscriptAnnotation } from '../types';

/** A 1×1 PNG: 70 bytes once decoded. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Uint8Array.from(atob(PNG_BASE64), (ch) => ch.charCodeAt(0));

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

/** Spec 343: Zen mode swaps the collapsed lanes for the left rail. */
function enterZen(v: AcpHarnessView): void {
  const state = v as unknown as { zenMode: boolean };
  state.zenMode = true;
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
  it('opens a tool image while the lane turn is still busy', () => {
    const lane = call<HarnessLane>(view, 'createLane', 'claude', 'claude-1');
    lanes(view).push(lane);
    activate(view, lane.id);
    lane.status = 'busy';
    const imageId = 'image-in-progress';
    lane.transcript.push({
      id: 'tool-image',
      kind: 'tool',
      text: '',
      tool: {
        glyph: '⠙', status: 'in_progress', kind: 'read', subject: 'image.png', command: '',
        result: '', sections: [], diffs: [],
      },
      images: [{
        imageId, itemId: 'tool-image', origin: 'bytes', path: null, discovery: 'explicit',
        state: 'live', mimeType: 'image/png', bytes: 1024, objectUrl: 'blob:live-image',
        label: 'image 1', source: 'tool', key: 'live-image', hintLabel: null,
      }],
    });

    call(view, 'renderDashboard');
    const thumb = view.element.querySelector<HTMLElement>(`[data-image-id="${imageId}"]`);
    expect(thumb, 'tool image thumbnail during a busy turn').not.toBeNull();
    thumb?.click();
    const viewer = view.element.querySelector<HTMLElement>('.acp-harness__image-viewer-overlay');
    expect(viewer?.hidden).toBe(false);
    expect(viewer?.querySelector('img')?.getAttribute('src')).toBe('blob:live-image');

    // Streaming updates continue underneath an open viewer.
    call(view, 'renderActiveTranscript', lane);
    expect(viewer?.hidden).toBe(false);
    view.onKeyDown(new KeyboardEvent('keydown', { key: '=', cancelable: true }));
    expect(viewer?.querySelector<HTMLImageElement>('img')?.style.transform).toContain('scale(1.25)');
  });

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

  it('auto-expands the last GenUI fence without stealing focus and focuses a user-opened fence', () => {
    const lane = call<HarnessLane>(view, 'createLane', 1, 'omp', 'OMP-1');
    lanes(view).push(lane);
    activate(view, lane.id);
    const item: HarnessTranscriptItem = {
      id: 'focus-ui', kind: 'assistant',
      text: [
        '```krypton-ui', 'Card("First card", [Text("First result")])', '```',
        '```krypton-ui', 'Card("Last card", [Text("Last result")])', '```',
      ].join('\n'),
    };
    const other: HarnessTranscriptItem = {
      id: 'another-item', kind: 'assistant',
      text: '```krypton-ui\nCard("Other card", [Text("Other result")])\n```',
    };
    lane.transcript.push(item, other);
    call(view, 'renderDashboard');
    view.element.focus();
    const panel = genUiPanel(view);
    call(view, 'autoOpenGenUi', lane, item.id);
    expect(panel.isOpen).toBe(true);
    expect(panel.el.textContent).toContain('Last result');
    expect(document.activeElement).toBe(view.element);

    call(view, 'autoOpenGenUi', lane, 'another-item');
    expect(panel.el.textContent).toContain('Last result');
    expect(document.activeElement).toBe(view.element);
    call(view, 'openGenUi', item.id, 1);
    call(view, 'openGenUi', item.id, 0);
    expect(panel.el.textContent).toContain('First result');
    expect(panel.el.contains(document.activeElement)).toBe(true);

    call(view, 'openGenUi', item.id, 0);
    const background = call<HarnessLane>(view, 'createLane', 2, 'omp', 'OMP-2');
    background.transcript.push(item);
    lanes(view).push(background);
    call(view, 'autoOpenGenUi', background, item.id);
    expect(panel.isOpen).toBe(false);
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

  // A path image that loads after its tool row mounted patches that row through
  // `syncImageStrip`. That patch once threw on a `ToolRow`, left the tile at
  // LOADING and rejected the lane's load queue, so every later path image in
  // the lane stayed LOADING for good.
  it('lands late path images on mounted tool rows and keeps loading later ones', async () => {
    const path = '/tmp/fixture/crsv.png';
    let exists = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== 'read_image_file') return [];
      if (!exists) throw 'not found';
      return PNG.slice().buffer;
    });
    const lane = call<HarnessLane>(view, 'createLane', 'omp', 'omp-1');
    lanes(view).push(lane);
    activate(view, lane.id);
    call(view, 'renderDashboard');
    // Mount the row synchronously so the queued load resolves onto a mounted row.
    const read = async (toolCallId: string): Promise<HTMLElement | null> => {
      call(view, 'onLaneEvent', lane, {
        type: 'tool_call',
        call: { toolCallId, title: 'Read crsv.png', kind: 'read', status: 'pending', locations: [{ path }] },
      });
      call(view, 'renderActiveTranscript', lane);
      await lane.imageState.queue;
      return view.element.querySelector<HTMLElement>(`[data-msg-id="${lane.toolTranscriptIds.get(toolCallId)}"]`);
    };

    try {
      const missing = await read('r1');
      expect(missing?.querySelector('.acp-harness__image-tile--missing')?.textContent)
        .toBe(`IMG MISSING // ${path}`);

      exists = true;
      const loaded = await read('r2');
      expect(loaded?.querySelector('.acp-harness__image-tile--loading')).toBeNull();
      expect(loaded?.querySelector('.acp-harness__image-thumb figcaption')?.textContent).toBe('crsv.png · 70 B');
    } finally {
      vi.mocked(invoke).mockImplementation(async () => []);
    }
  });

  // omp sends `locations` only on the `tool_call` start and the read's bytes on
  // the completed update. The bytes must pair with that start path, whichever
  // of the disk load and the bytes lands first, so the file shows once.
  it('shows an omp read image once whether its path load or its bytes land first', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === 'read_image_file' ? PNG.slice().buffer : []));
    const lane = call<HarnessLane>(view, 'createLane', 'omp', 'omp-1');
    lanes(view).push(lane);
    activate(view, lane.id);
    call(view, 'renderDashboard');
    const start = (toolCallId: string, path: string): void => {
      call(view, 'onLaneEvent', lane, {
        type: 'tool_call',
        call: { toolCallId, title: 'Read', kind: 'read', status: 'pending', locations: [{ path }] },
      });
      call(view, 'renderActiveTranscript', lane);
    };
    const complete = (toolCallId: string): void => {
      call(view, 'onLaneEvent', lane, {
        type: 'tool_call_update',
        update: {
          toolCallId,
          status: 'completed',
          content: [{ type: 'content', content: { type: 'image', data: PNG_BASE64, mimeType: 'image/webp' } }],
        },
      });
      call(view, 'renderActiveTranscript', lane);
    };
    const captions = (toolCallId: string): string[] => {
      const row = view.element.querySelector(`[data-msg-id="${lane.toolTranscriptIds.get(toolCallId)}"]`);
      return [...(row?.querySelectorAll('.acp-harness__images > *') ?? [])].map((node) => node.textContent ?? '');
    };

    try {
      start('disk-first', '/tmp/fixture/a.png');
      await lane.imageState.queue;
      complete('disk-first');
      expect(captions('disk-first')).toEqual(['a.png · 70 B']);

      start('bytes-first', '/tmp/fixture/b.png');
      complete('bytes-first');
      await lane.imageState.queue;
      expect(captions('bytes-first')).toEqual(['b.png · 70 B']);
    } finally {
      vi.mocked(invoke).mockImplementation(async () => []);
    }
  });
});

// Spec 343 — the reported bug: `#push` uploads for seconds while its lane reads
// plain `idle`, with nothing naming the command once the 2 s flash clears.
describe('running built-in command chips (spec 343)', () => {
  it('names a slow # command on the lane head and the Zen rail until it settles', async () => {
    vi.useFakeTimers();
    // Executor form: tsconfig's ES2021 lib has no `Promise.withResolvers`.
    let failPush: (error: Error) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'xenon_push') return new Promise((_resolve, reject) => { failPush = reject; });
      return [];
    });
    const runChip = (): Element | null => view.element.querySelector('.acp-harness__lane-run');
    try {
      const lane = call<HarnessLane>(view, 'createLane', 'claude', 'claude-1');
      lanes(view).push(lane);
      activate(view, lane.id);
      lane.status = 'idle';

      const pushing = call<Promise<void>>(view, 'submitLanePrompt', lane, '#push review', []);
      call(view, 'renderDashboard');
      expect(runChip(), 'not shown before the reveal delay').toBeNull();

      await vi.advanceTimersByTimeAsync(500);
      call(view, 'renderDashboard');
      const chip = runChip();
      expect(chip?.textContent).toBe('#push review · 0:00');
      expect(view.element.querySelector('.acp-harness__lane-status')?.textContent).toBe('idle');

      // The 1 Hz clock writes the chip in place, without a dashboard render.
      await vi.advanceTimersByTimeAsync(1000);
      expect(runChip()).toBe(chip);
      expect(chip?.textContent).toBe('#push review · 0:01');

      enterZen(view);
      call(view, 'renderDashboard');
      expect(view.element.querySelector('.acp-harness__rail-meta')?.textContent).toBe('#push review');

      failPush(new Error('offline'));
      await pushing;
      call(view, 'renderDashboard');
      expect(runChip()).toBeNull();
      expect(view.element.querySelector('.acp-harness__rail-meta')?.textContent).toBe('idle');
    } finally {
      vi.useRealTimers();
      vi.mocked(invoke).mockImplementation(async () => []);
    }
  });
});

describe('focused Rails dock keys (spec 337)', () => {
  interface DockSeam {
    dock: { setAvailable(tab: 'ticket' | 'rails', available: boolean): void; select(tab: 'ticket' | 'rails'): void };
    railsCtl: { dockEl: HTMLElement; handleDockKey(e: KeyboardEvent): boolean };
  }

  function focusedRailsDock(): { lane: HarnessLane; seam: DockSeam } {
    const lane = call<HarnessLane>(view, 'createLane', 'claude', 'claude-1');
    lanes(view).push(lane);
    activate(view, lane.id);
    lane.draft = 'keep me';
    lane.cursor = lane.draft.length;
    const seam = view as unknown as DockSeam;
    seam.dock.setAvailable('rails', true);
    seam.dock.select('rails');
    seam.railsCtl.dockEl.focus();
    expect(document.activeElement).toBe(seam.railsCtl.dockEl);
    return { lane, seam };
  }

  function press(key: string, init: KeyboardEventInit = {}): boolean {
    return view.onKeyDown(new KeyboardEvent('keydown', { key, cancelable: true, ...init }));
  }

  it('swallows typing, editing keys and Ctrl editing chords so the hidden draft never changes', () => {
    const { lane } = focusedRailsDock();

    for (const key of ['x', 'Backspace', 'Delete', 'ArrowLeft', 'Home', 'End', 'Tab']) {
      expect(press(key), key).toBe(true);
    }
    expect(press('Tab', { shiftKey: true })).toBe(true);
    for (const key of ['u', 'k', 'w', 'd', 'a', 'e']) {
      expect(press(key, { ctrlKey: true }), `Ctrl+${key}`).toBe(true);
    }
    expect(lane.draft).toBe('keep me');
  });

  it('lets a pending permission answer first', () => {
    const { lane, seam } = focusedRailsDock();
    const dockKey = vi.spyOn(seam.railsCtl, 'handleDockKey');
    lane.pendingPermissions.push({} as HarnessLane['pendingPermissions'][number]);

    expect(press('j')).toBe(true);
    expect(press('1')).toBe(true);
    expect(dockKey).not.toHaveBeenCalled();

    lane.pendingPermissions.length = 0;
    press('j');
    expect(dockKey).toHaveBeenCalledTimes(1);
  });
});
