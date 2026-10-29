import { afterEach, describe, expect, it, vi } from 'vitest';

import { toolSections, ToolsView } from './index';
import type { ToolDescriptor } from './index';

// The real payload comes from Rust (`bus_tool_descriptors()` — covered by a
// Rust test); this fixture in the same descriptor shape guards the page's
// rendering contract (field names, schema traversal, chips).
const TOOLS: ToolDescriptor[] = [
  {
    name: 'handoff_set',
    category: 'memory',
    description: "Write your lane's single handoff document.",
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One short headline.' },
        detail: { type: 'string', maxLength: 8000, description: 'The full body.' },
      },
      required: ['summary', 'detail'],
    },
  },
  {
    name: 'peer_list',
    category: 'peering',
    description: 'List live peer lanes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mark_review_priority',
    category: 'review',
    description: 'Tell the Diff Window where to spend reading attention.',
    inputSchema: {
      type: 'object',
      properties: {
        ranges: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              level: { enum: ['high', 'routine'] },
            },
            required: ['file', 'level'],
          },
        },
      },
      required: ['ranges'],
    },
  },
  {
    name: 'timeline_list',
    category: 'timeline',
    description: 'List recorded project events.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
  },
  {
    name: 'e2e_adapter_check',
    category: 'e2e',
    description: "Validate this project's Krypton e2e wiring.",
    inputSchema: { type: 'object', properties: { result_path: { type: 'string' } }, required: ['result_path'] },
  },
  {
    name: 'future_tool',
    category: 'brand-new',
    description: 'A category this page has never heard of.',
  },
];

describe('toolSections', () => {
  it('keeps the preferred order and appends unknown categories', () => {
    const sections = toolSections(TOOLS);
    expect(sections.map((s) => s.id)).toEqual(['memory', 'peering', 'timeline', 'review', 'e2e', 'brand-new']);
    expect(sections[sections.length - 1].title).toBe('brand-new');
  });
});

describe('ToolsView', () => {
  let view: ToolsView;

  async function mount(response: () => Promise<Response>): Promise<void> {
    vi.stubGlobal('fetch', vi.fn(response));
    view = new ToolsView();
    document.body.append(view.el);
    await view.load();
  }

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('renders descriptor-shaped tools from /tools.json, every category included', async () => {
    await mount(async () => new Response(JSON.stringify({ tools: TOOLS })));

    const cards = [...view.el.querySelectorAll('.lb-tools__tool')];
    expect(cards.map((c) => c.querySelector('.lb-tools__name')?.textContent)).toEqual([
      'handoff_set',
      'peer_list',
      'timeline_list',
      'mark_review_priority',
      'e2e_adapter_check',
      'future_tool',
    ]);
    // The category is a text label, nothing more.
    expect(cards[3].querySelector('.lb-tools__cat')?.textContent).toBe('review');
    const titles = [...view.el.querySelectorAll('.lb-tools__section h2')].map((h) => h.textContent);
    expect(titles).toContain('Timeline — project events & conflict checks');
    expect(titles).toContain('E2E — test adapter wiring');

    const handoff = cards[0];
    // Params table: required star + maxLength chip.
    expect(handoff.querySelectorAll('.lb-tools__param .lb-tools__req')).toHaveLength(2);
    expect([...handoff.querySelectorAll('.lb-chip.lb-chip--muted')].map((c) => c.textContent)).toEqual(['max 8000']);
    // Zero-param and schema-less fallbacks.
    expect(cards[1].querySelector('.lb-tools__noparams')?.textContent).toBe('no parameters');
    expect(cards[5].querySelector('.lb-tools__noparams')?.textContent).toBe('no parameters');
    // Array-of-object item shape renders sub-params with enum chips; the array's own bounds sit on the type.
    const review = cards[3];
    expect(review.querySelector('td.lb-tools__type')?.textContent).toBe('object[] max 50');
    const desc = review.querySelector('td.lb-tools__pdesc') as HTMLElement;
    expect(desc.textContent).toBe('Each: file* · level* high routine');
    expect([...desc.querySelectorAll('.lb-chip')].map((c) => c.textContent)).toEqual(['high', 'routine']);
    // Scalar bounds and defaults.
    expect([...cards[2].querySelectorAll('.lb-chip')].map((c) => c.textContent)).toEqual([
      'default 50',
      'min 1',
      'max 200',
    ]);
    // The full agent-facing description sits behind a disclosure.
    expect(handoff.querySelector('details.lb-tools__full .lb-tools__desc')?.textContent).toBe(TOOLS[0].description);

    // Stats reflect the payload, not hardcoded numbers.
    const stats = [...view.el.querySelectorAll('.lb-stat')].map((s) => s.textContent);
    expect(stats).toEqual(['6tools', '6categories', '5parameters']);
  });

  it('explains an empty payload, an HTTP error and an unreachable server', async () => {
    await mount(async () => new Response(JSON.stringify({ tools: [] })));
    expect(view.el.textContent).toContain('no tool descriptors — is the hook server running?');

    await mount(async () => new Response('down', { status: 503 }));
    expect(view.el.textContent).toContain('no tool descriptors');

    await mount(async () => Promise.reject(new TypeError('offline')));
    expect(view.el.textContent).toContain('could not load /tools.json — is the hook server running?');
  });
});
