import { describe, expect, it } from 'vitest';

import { StatList, StatRow, type StatListProps, type StatRowProps } from './index';

const paint = (props: StatListProps, root?: HTMLElement): StatList => {
  const list = new StatList(props.layout, root);
  list.update(props);
  return list;
};

describe('StatList — inline (lane stats)', () => {
  it('emits bare sibling spans, the separator staying CSS', () => {
    // harness-lane-chrome.ts:464 — `sess 4f2a9c · krypton · in 12.4k out 3.1k`.
    const list = paint({
      layout: 'inline',
      block: 'acp-harness__lane-stats',
      rootClass: 'acp-harness__lane-stats',
      rows: [
        { label: 'sess 4f2a9c', value: '' },
        { label: 'krypton', value: '' },
        { label: 'in 12.4k out 3.1k', value: '' },
      ],
    });

    expect(list.el.outerHTML).toBe(
      '<div class="acp-harness__lane-stats">' +
        '<span>sess 4f2a9c</span>' +
        '<span>krypton</span>' +
        '<span>in 12.4k out 3.1k</span>' +
        '</div>',
    );
  });

  it('leads an iconified cell with the glyph and keeps the dropped noun in the title', () => {
    const list = paint({
      layout: 'inline',
      block: 'acp-harness__lane-stats',
      rows: [
        {
          label: '',
          value: '128.4k/200.0k (64%)',
          icon: { id: 'gauge' },
          title: 'context 128.4k/200.0k (64%)',
        },
      ],
    });
    const cell = list.el.firstElementChild;

    expect(cell?.hasAttribute('class')).toBe(false);
    expect(cell?.getAttribute('title')).toBe('context 128.4k/200.0k (64%)');
    expect(cell?.textContent).toBe('128.4k/200.0k (64%)');
    const icon = cell?.firstElementChild;
    expect(icon?.nodeName).toBe('svg');
    expect(icon?.getAttribute('class')).toBe('acp-harness__icon');
    expect(icon?.firstElementChild?.getAttribute('href')).toBe('#krypton-icon-gauge');
  });

  it('takes a prebuilt node for a cell that interleaves glyphs with counts', () => {
    const value = document.createDocumentFragment();
    value.append('90.0k', document.createElement('i'), '8.0k');
    const list = paint({
      layout: 'inline',
      block: 'acp-harness__lane-stats',
      rows: [{ label: 'cache ', value, title: 'cache read 90.0k, write 8.0k' }],
    });

    expect(list.el.firstElementChild?.textContent).toBe('cache 90.0k8.0k');
    expect(list.el.firstElementChild?.querySelector('i')).not.toBeNull();
  });

  it('adopts an existing container instead of wrapping it', () => {
    const host = document.createElement('div');
    host.className = 'acp-harness__lane-stats';
    host.append(document.createElement('b'));

    const list = paint({ layout: 'inline', block: 'acp-harness__lane-stats', rows: [{ label: 'sess pending', value: '' }] }, host);

    expect(list.el).toBe(host);
    expect(host.className).toBe('acp-harness__lane-stats');
    expect(host.outerHTML).toBe('<div class="acp-harness__lane-stats"><span>sess pending</span></div>');
  });
});

describe('StatList — dl (#usage metrics)', () => {
  const turnsRow: StatRowProps = { key: 'Turns', label: 'Turns', value: '14', tone: 'turns' };
  const inputRow: StatRowProps = { key: 'Input', label: 'Input', value: '182.0k', tone: 'input' };
  const usage: StatListProps = {
    layout: 'dl',
    block: 'acp-harness__usage-metric',
    rootClass: 'acp-harness__usage-metrics acp-harness__usage-metrics--2',
    rows: [turnsRow, inputRow],
  };

  it('emits the dt/dd metric grid', () => {
    // harness-transcript-render.ts:178-189.
    const list = paint(usage);

    expect(list.el.outerHTML).toBe(
      '<dl class="acp-harness__usage-metrics acp-harness__usage-metrics--2">' +
        '<div class="acp-harness__usage-metric acp-harness__usage-metric--turns"><dt>Turns</dt><dd>14</dd></div>' +
        '<div class="acp-harness__usage-metric acp-harness__usage-metric--input"><dt>Input</dt><dd>182.0k</dd></div>' +
        '</dl>',
    );
  });

  it('keeps every untouched row node when a row is appended', () => {
    const list = paint(usage);
    const [turns, input] = [...list.el.children];
    const turnsText = turns?.querySelector('dd')?.firstChild;

    list.update({
      ...usage,
      rootClass: 'acp-harness__usage-metrics acp-harness__usage-metrics--3',
      rows: [...usage.rows, { key: 'Output', label: 'Output', value: '12.4k', tone: 'output' }],
    });

    expect(list.el.children[0]).toBe(turns);
    expect(list.el.children[1]).toBe(input);
    expect(turns?.querySelector('dd')?.firstChild).toBe(turnsText);
    expect(list.el.children[2]?.outerHTML).toBe(
      '<div class="acp-harness__usage-metric acp-harness__usage-metric--output"><dt>Output</dt><dd>12.4k</dd></div>',
    );
    expect(list.el.className).toBe('acp-harness__usage-metrics acp-harness__usage-metrics--3');
  });

  it('writes only the row whose value moved', () => {
    const list = paint(usage);
    const [turns, input] = [...list.el.children];
    const turnsText = turns?.querySelector('dd')?.firstChild;
    const inputDd = input?.querySelector('dd');

    list.update({
      ...usage,
      rows: [turnsRow, { key: 'Input', label: 'Input', value: '184.2k', tone: 'input' }],
    });

    // The untouched row keeps even its text node; the changed row keeps its
    // elements and only their content is rewritten.
    expect(turns?.querySelector('dd')?.firstChild).toBe(turnsText);
    expect(list.el.children[1]).toBe(input);
    expect(input?.querySelector('dd')).toBe(inputDd);
    expect(inputDd?.textContent).toBe('184.2k');
  });

  it('drops a tone modifier that is no longer supplied', () => {
    const list = paint(usage);
    list.update({ ...usage, rows: [{ key: 'Turns', label: 'Turns', value: '14' }] });

    expect(list.el.firstElementChild?.className).toBe('acp-harness__usage-metric');
  });

  it('removes the rows that fell out of the list', () => {
    const list = paint(usage);
    const dropped = list.el.children[1];

    list.update({ ...usage, rows: [turnsRow] });

    expect(list.el.children.length).toBe(1);
    expect(dropped?.isConnected).toBe(false);
  });

  it('skips the whole pass when the same rows come back', () => {
    const list = paint(usage);
    const turnsText = list.el.firstElementChild?.querySelector('dd')?.firstChild;

    list.update({ ...usage, rows: [...usage.rows] });

    expect(list.el.firstElementChild?.querySelector('dd')?.firstChild).toBe(turnsText);
  });

  it('empties its container on dispose', () => {
    const list = paint(usage);
    const row = list.el.firstElementChild;
    list.dispose();

    expect(list.el.children.length).toBe(0);
    expect(row?.isConnected).toBe(false);
  });
});

describe('StatList — grid (lane peek)', () => {
  it('emits the prefix/value row', () => {
    // lane-peek.ts:419 — renderLanePeekRow('tool', 'Edit · lane-peek.ts').
    const list = paint({
      layout: 'grid',
      block: 'acp-harness__lane-peek',
      rows: [{ label: 'tool', value: 'Edit · lane-peek.ts' }],
    });

    expect(list.el.firstElementChild?.outerHTML).toBe(
      '<div class="acp-harness__lane-peek-row">' +
        '<span class="acp-harness__lane-peek-prefix">tool</span>' +
        '<span class="acp-harness__lane-peek-value">Edit · lane-peek.ts</span>' +
        '</div>',
    );
  });

  it('places a caller-built node in the value half', () => {
    const bold = document.createElement('b');
    bold.textContent = 'wire composer meta segments';
    const list = paint({
      layout: 'grid',
      block: 'acp-harness__lane-peek',
      rows: [{ label: 'plan', value: bold, tone: 'busy' }],
    });

    expect(list.el.firstElementChild?.className).toBe('acp-harness__lane-peek-row acp-harness__lane-peek-row--busy');
    expect(list.el.querySelector('.acp-harness__lane-peek-value')?.firstElementChild).toBe(bold);
  });

  it('rebuilds the rows when the caller changes block, so no row keeps a dead class', () => {
    const list = paint({
      layout: 'grid',
      block: 'acp-harness__lane-peek',
      rows: [{ label: 'tool', value: 'Edit' }],
    });
    const first = list.el.firstElementChild;

    list.update({ layout: 'grid', block: 'acp-triage__row', rows: [{ label: 'tool', value: 'Edit' }] });

    expect(list.el.firstElementChild).not.toBe(first);
    expect(list.el.firstElementChild?.outerHTML).toBe(
      '<div class="acp-triage__row-row">' +
        '<span class="acp-triage__row-prefix">tool</span>' +
        '<span class="acp-triage__row-value">Edit</span>' +
        '</div>',
    );
  });

  it('refuses to repaint under another layout instead of emitting foreign markup', () => {
    const list = paint({ layout: 'grid', block: 'b', rows: [] });

    expect(() => list.update({ layout: 'dl', block: 'b', rows: [] })).toThrow(/layout 'grid'/);
  });
});

describe('StatRow', () => {
  it('removes a title that is no longer supplied', () => {
    const row = new StatRow('dl', 'acp-harness__usage-metric');
    row.update({ label: 'Cost', value: '$0.44', title: 'USD' });
    row.update({ label: 'Cost', value: '$0.44' });

    expect(row.el.hasAttribute('title')).toBe(false);
  });

  it('keeps its dt/dd nodes across a value change', () => {
    const row = new StatRow('dl', 'acp-harness__usage-metric');
    row.update({ label: 'Cost', value: '$0.44' });
    const [dt, dd] = [row.el.querySelector('dt'), row.el.querySelector('dd')];

    row.update({ label: 'Cost', value: '$0.51' });

    expect(row.el.querySelector('dt')).toBe(dt);
    expect(row.el.querySelector('dd')).toBe(dd);
    expect(dd?.textContent).toBe('$0.51');
  });

  it('drops an icon that is no longer supplied', () => {
    const row = new StatRow('inline', 'acp-harness__lane-stats');
    row.update({ label: '', value: '37', icon: { id: 'tool' } });
    expect(row.el.querySelector('svg')).not.toBeNull();

    row.update({ label: '', value: '37' });
    expect(row.el.querySelector('svg')).toBeNull();
    expect(row.el.outerHTML).toBe('<span>37</span>');
  });

  it('puts text through the DOM rather than a string builder', () => {
    const row = new StatRow('grid', 'acp-harness__lane-peek');
    row.update({ label: 'tool', value: '<img src=x onerror=alert(1)>' });

    expect(row.el.querySelector('img')).toBeNull();
    expect(row.el.querySelector('.acp-harness__lane-peek-value')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
