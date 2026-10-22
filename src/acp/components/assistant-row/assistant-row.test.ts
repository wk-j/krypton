import { describe, expect, it } from 'vitest';

import type { HarnessLane, HarnessTranscriptItem, MessageResource } from '../../harness-view-types';
import type { RowProps } from '../transcript-row';
import { AssistantRow } from './index';

function makeLane(): HarnessLane {
  return {
    id: 'lane-1',
    transcript: [],
    imageState: { bytes: 0, live: [], turnPaths: new Map<string, string>(), queue: Promise.resolve() },
    streamingMarkdownParser: null,
    streamingMarkdownBody: null,
    streamingMarkdownItemId: null,
  } as unknown as HarnessLane;
}

function assistant(over: Partial<HarnessTranscriptItem> = {}): HarnessTranscriptItem {
  return { id: 'a1', kind: 'assistant', text: 'the reconciler keeps node identity', ...over };
}

function props(item: HarnessTranscriptItem, streaming: boolean, lane: HarnessLane | null = null): RowProps {
  return { item, isNew: false, streaming, lane, projectDir: null, resolveLocalImages: false };
}

function mount(item: HarnessTranscriptItem, streaming: boolean, lane: HarnessLane | null = null): {
  row: AssistantRow;
  next: RowProps;
} {
  const next = props(item, streaming, lane);
  const row = new AssistantRow(next);
  row.update(next);
  return { row, next };
}

function resource(): MessageResource {
  return {
    key: 'file:/w/src/ui/list.ts',
    kind: 'file',
    target: '/w/src/ui/list.ts',
    label: 'list.ts',
    source: 'protocol',
    hintLabel: null,
  };
}

describe('AssistantRow', () => {
  it('decorates only sealed krypton-ui fences and keeps pure markdown for remounts', () => {
    const spec = 'Card("Answer", [Text("<img src=x onerror=alert(1)>")])';
    const item = assistant({ text: `Before\n\n\`\`\`krypton-ui\n${spec}\n\`\`\`` });
    const { row } = mount(item, false);
    const card = row.el.querySelector('.acp-genui-card');
    expect(card?.textContent).toContain('Answer');
    expect(row.el.querySelector('img')).toBeNull();
    expect(item.markdownHtml).toContain('language-krypton-ui');
    expect(item.markdownHtml).not.toContain('acp-genui-card');
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body')!;
    item.uiFences![0].hintLabel = 'a';
    row.patchUiHints();
    expect(body.querySelector('.acp-genui-card__hint')?.textContent).toBe('a');
    expect(row.el.querySelector('.acp-harness__msg-body')).toBe(body);
    row.dispose();
    const remounted = mount(item, false).row;
    expect(remounted.el.querySelector('.acp-genui-card')?.textContent).toContain('Answer');
    remounted.dispose();
  });
  it('renders a sealed reply as annotatable markdown and caches the parse', () => {
    const item = assistant({ text: 'first **bold**' });
    const { row } = mount(item, false);

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--assistant');
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body acp-harness__msg-body--markdown');
    expect(body?.dataset.annotatable).toBe('1');
    expect(body?.querySelector('strong')?.textContent).toBe('bold');
    expect(item.markdownSource).toBe('first **bold**');
    expect(item.markdownHtml).toContain('<strong>bold</strong>');
  });

  it('keeps the lane-mail provenance line as the body\'s first child', () => {
    const item = assistant({
      text: 'answered',
      replyingToLaneMail: { envelopeId: 'e1', peerDisplayName: 'Scout', envelopeCount: 2 },
    });
    const { row } = mount(item, false);

    const body = row.el.querySelector('.acp-harness__msg-body');
    const prov = body?.firstElementChild;
    expect(prov?.className).toBe('acp-harness__lane-mail-provenance');
    expect(prov?.textContent).toBe('↩ replying to lane mail (2 messages) from scout');
  });

  it('opens a parser bound to its own body and mirrors it onto the lane', () => {
    const lane = makeLane();
    const item = assistant({ text: '' });
    const { row } = mount(item, true, lane);

    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--assistant acp-harness__msg--streaming');
    expect(body?.className).toBe(
      'acp-harness__msg-body acp-harness__msg-body--markdown acp-harness__msg-body--stream-markdown acp-harness__msg-body--stream-live',
    );
    expect(lane.streamingMarkdownParser).not.toBeNull();
    expect(lane.streamingMarkdownBody).toBe(body);
    expect(lane.streamingMarkdownItemId).toBe('a1');
  });

  it('writes both chunks into the one body the component owns', () => {
    const lane = makeLane();
    const item = assistant({ text: 'the reconciler ' });
    const { row, next } = mount(item, true, lane);
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    const paragraph = body?.firstElementChild;

    item.text = 'the reconciler keeps node ';
    row.update(next);
    item.text = 'the reconciler keeps node identity';
    row.update(next);

    expect(row.el.querySelector('.acp-harness__msg-body')).toBe(body);
    expect(body?.firstElementChild).toBe(paragraph);
    // streaming-markdown holds the last character back until the next write or
    // parser_end, so the seal is what completes the paragraph.
    expect(body?.textContent).toBe('the reconciler keeps node identit');
    expect(item.streamingMarkdownWritten).toBe('the reconciler keeps node identity'.length);

    row.seal(next);

    expect(body?.firstElementChild).toBe(paragraph);
    expect(body?.textContent).toBe('the reconciler keeps node identity');
  });

  it('streams a box diagram onto the cell grid and seals it without replacing a node', () => {
    const lane = makeLane();
    const diagram = '╭──╮\n│ok│\n╰──╯';
    const full = 'Plan:\n\n```\n' + diagram + '\n```\nend';
    const item = assistant({ text: 'Plan:\n\n```\n╭─' });
    const { row, next } = mount(item, true, lane);
    item.text = full;
    row.update(next);
    const code = row.el.querySelector<HTMLElement>('pre > code')!;
    expect(code.classList.contains('acp-cellgrid')).toBe(true);
    const nodes = [...code.querySelectorAll('*')];

    row.seal(next);

    expect(row.el.querySelector('pre > code')).toBe(code);
    expect(nodes.every((node) => code.contains(node))).toBe(true);
    expect(code.textContent?.replace(/\n$/, '')).toBe(diagram);
    expect(item.markdownHtml).toContain('acp-cellgrid__cell--u256d');
  });

  it('lays out and caches the grid for a reply that never streamed', () => {
    const item = assistant({ text: '```\n┌─┐\n└─┘\n```' });
    const { row } = mount(item, false);
    expect(row.el.querySelector('pre > code.acp-cellgrid')).not.toBeNull();
    expect(item.markdownHtml).toContain('acp-cellgrid__cell--u250c');
  });

  it('seals by draining the parser, caching the html and releasing the lane', () => {
    const lane = makeLane();
    const item = assistant({ text: 'drained' });
    const { row, next } = mount(item, true, lane);

    row.seal(next);

    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--assistant');
    expect(body?.className).toBe(
      'acp-harness__msg-body acp-harness__msg-body--markdown acp-harness__msg-body--stream-markdown',
    );
    expect(item.markdownSource).toBe('drained');
    expect(item.markdownHtml).toContain('drained');
    expect(item.streamingMarkdownWritten).toBeUndefined();
    expect(lane.streamingMarkdownParser).toBeNull();
    expect(lane.streamingMarkdownBody).toBeNull();
    expect(lane.streamingMarkdownItemId).toBeNull();
  });

  it('keeps the provenance line out of the cached markdown', () => {
    const lane = makeLane();
    const item = assistant({
      text: 'reply text',
      replyingToLaneMail: { envelopeId: 'e1', peerDisplayName: 'Scout', envelopeCount: 1 },
    });
    const { row, next } = mount(item, true, lane);

    row.seal(next);

    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.firstElementChild?.className).toBe('acp-harness__lane-mail-provenance');
    expect(item.markdownHtml).not.toContain('acp-harness__lane-mail-provenance');
    expect(item.markdownHtml).toContain('reply text');
  });

  it('writes nothing on the update that follows seal', () => {
    const lane = makeLane();
    const item = assistant({ text: 'settled' });
    const { row, next } = mount(item, true, lane);
    row.seal(next);
    const observer = new MutationObserver(() => undefined);
    observer.observe(row.el, { childList: true, subtree: true, attributes: true, characterData: true });

    row.update(next);

    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it('appends the REFERENCES rail last and repaints only it for late Git state', () => {
    const item = assistant({ text: 'see the list', resources: [resource()] });
    const { row } = mount(item, false);
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    const rail = body?.querySelector('.acp-harness__resources');
    const markdown = body?.firstElementChild;
    expect(body?.lastElementChild).toBe(rail);

    const payload = (item.resources ?? [])[0];
    payload.git = { status: 'M', countKind: 'lines', added: 2, removed: 1 };
    row.patchResources();

    expect(body?.firstElementChild).toBe(markdown);
    expect(body?.querySelector('.acp-harness__resources')).toBe(rail);
    expect(rail?.querySelector('.acp-harness__resource-git-status')?.textContent).toBe('M');
    expect(rail?.querySelector('.acp-harness__resource-git-add')?.textContent).toBe('+2');
  });

  it('a live row has no rail to patch', () => {
    const lane = makeLane();
    const item = assistant({ text: 'still writing', resources: [resource()] });
    const { row } = mount(item, true, lane);

    row.patchResources();

    expect(row.el.querySelector('.acp-harness__resources')).toBeNull();
  });

  it('tears the parser down on dispose instead of leaving it on the lane', () => {
    const lane = makeLane();
    const item = assistant({ text: 'half a thought' });
    const { row } = mount(item, true, lane);
    expect(lane.streamingMarkdownParser).not.toBeNull();

    row.dispose();

    expect(lane.streamingMarkdownParser).toBeNull();
    expect(lane.streamingMarkdownBody).toBeNull();
    expect(lane.streamingMarkdownItemId).toBeNull();
  });
});

// Spec 283, moved from `harness-svg-fence.test.ts:166-187`, where it was
// expressed against `transcriptRenderSignature`. Decoration WRITES
// `item.svgFences` from the body paint() just built, so the default state it
// produces must not count as a change; a label or a Source toggle must.
describe('AssistantRow svg fence cards', () => {
  const FENCE = '```svg\n<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>\n```';

  it('keeps its dependency tuple when decoration adds default-state cards', () => {
    const item = assistant({ text: FENCE });
    const { row, next } = mount(item, false);
    expect(item.svgFences?.length).toBe(1);
    expect(item.svgFences?.[0]).toMatchObject({ index: 0, kind: 'svg', hintLabel: null, showSource: false });

    const observer = new MutationObserver(() => undefined);
    observer.observe(row.el, { childList: true, subtree: true, attributes: true, characterData: true });
    row.update(next);

    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    row.dispose();
  });

  it('repaints the card when it is labelled or toggled to source', () => {
    const item = assistant({ text: FENCE });
    const { row, next } = mount(item, false);
    const card = (): HTMLElement | null => row.el.querySelector('.acp-harness__svg-card');
    expect(card()?.classList.contains('acp-harness__svg-card--source')).toBe(false);

    item.svgFences![0].showSource = true;
    row.update(next);
    expect(card()?.classList.contains('acp-harness__svg-card--source')).toBe(true);

    item.svgFences![0].showSource = false;
    item.svgFences![0].hintLabel = 'a';
    row.update(next);
    expect(card()?.classList.contains('acp-harness__svg-card--source')).toBe(false);
    expect(card()?.classList.contains('acp-harness__svg-card--hinted')).toBe(true);
    expect(row.el.querySelector('.acp-harness__svg-card-hint')?.textContent).toBe('a');
    row.dispose();
  });
});

// Spec 309 revision — a streaming `krypton-ui` fence is collapsed to a strip
// instead of painting its source, and the strip must not survive into the
// sealed row or the cached markdown.
describe('AssistantRow krypton-ui fence streaming', () => {
  const SPEC = '$seats = 10\nCard("Estimate", [Slider($seats, 1, 50)])';

  it('collapses the fence while it streams and swaps in the card at seal', () => {
    const lane = makeLane();
    const item = assistant({ text: 'Here:\n\n```krypton-ui\n' });
    const { row, next } = mount(item, true, lane);
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body')!;

    item.text += `${SPEC}\n`;
    row.update(next);
    const strip = body.querySelector('.acp-genui-card--live');
    expect(strip).not.toBeNull();
    expect(strip?.nextElementSibling?.tagName).toBe('PRE');
    expect(body.querySelector('pre > code.krypton-ui')).not.toBeNull();

    item.text += '```\n';
    row.seal(next);

    expect(body.querySelector('.acp-genui-card--live')).toBeNull();
    expect(body.querySelector('.acp-genui-card__title')?.textContent).toBe('Estimate');
    expect(body.querySelector('pre')).toBeNull();
    expect(item.markdownHtml).not.toContain('acp-genui-card');
    row.dispose();
  });
});

// Spec 323 — follow-up actions arrive seconds after the reply sealed. They
// must land under it without repainting its body (AGENTS.md constraint 10).
describe('AssistantRow follow-up rail', () => {
  const ACTION = { followUpKind: 'run', label: 'install the app', target: 'make install', hintLabel: null } as const;

  it('adds the rail as the last child of a sealed row without touching the body', () => {
    const item = assistant({ text: 'Run `make install` to try it.' });
    const { row } = mount(item, false);
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body')!;
    const observer = new MutationObserver(() => undefined);
    observer.observe(body, { childList: true, subtree: true, attributes: true, characterData: true });

    item.followUps = [{ ...ACTION }];
    row.syncFollowUps();

    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    expect(row.el.lastElementChild?.className).toBe('acp-harness__followups');
    expect(row.el.querySelector('.acp-harness__followups-target')?.textContent).toBe('make install');
    row.dispose();
  });

  it('paints the rail from data when the row mounts later, and drops it when cleared', () => {
    const item = assistant({ text: 'Run `make install`.', followUps: [{ ...ACTION }] });
    const { row } = mount(item, false);
    expect(row.el.querySelectorAll('.acp-harness__followups-btn')).toHaveLength(1);

    item.followUps = undefined;
    row.syncFollowUps();
    expect(row.el.querySelector('.acp-harness__followups')).toBeNull();
    row.dispose();
  });

  it('never shows a rail on a live row', () => {
    const item = assistant({ text: 'Run `make', followUps: [{ ...ACTION }] });
    const { row } = mount(item, true, makeLane());
    row.syncFollowUps();
    expect(row.el.querySelector('.acp-harness__followups')).toBeNull();
    row.dispose();
  });
});
