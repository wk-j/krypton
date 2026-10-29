// Spec 186 (+ spec 341) — the built-in MCP tool reference. One fetch of
// `/tools.json`, no polling: the descriptors are compile-time data served
// straight from `bus_tool_descriptors()` in Rust, plus a page-only category.

import { el } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';
import { card, chip, DataTable, emptyState, fetchJson, HttpError, StatBar } from '../../kit';

import './tools.css';

export interface ToolSchema {
  readonly type?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly items?: ToolSchema;
  readonly properties?: Readonly<Record<string, ToolSchema>>;
  readonly required?: readonly string[];
}

export interface ToolDescriptor {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly inputSchema?: ToolSchema;
}

interface Param {
  readonly name: string;
  readonly schema: ToolSchema;
  readonly required: boolean;
}

/** Preferred section order + titles; a category not listed here still renders, after these. */
const KNOWN_SECTIONS: readonly (readonly [id: string, title: string])[] = [
  ['memory', 'Handoff — resume documents'],
  ['lessons', 'Lessons — global rules learned from corrections'],
  ['peering', 'Peering — inter-lane messaging'],
  ['artifacts', 'Artifacts — browser HTML views'],
  ['attention', 'Attention — human judgement queue'],
  ['timeline', 'Timeline — project events & conflict checks'],
  ['review', 'Review — diff triage & quality matrix'],
  ['issues', 'Issues & tickets — progress tracking'],
  ['e2e', 'E2E — test adapter wiring'],
  ['other', 'Other'],
];

/** Sections in preferred order, then every unknown category in payload order. */
export function toolSections(tools: readonly ToolDescriptor[]): { id: string; title: string; tools: ToolDescriptor[] }[] {
  const present = [...new Set(tools.map((t) => t.category))];
  const known = new Map(KNOWN_SECTIONS);
  const order = [...KNOWN_SECTIONS.map(([id]) => id).filter((id) => present.includes(id)), ...present.filter((id) => !known.has(id))];
  return order.map((id) => ({ id, title: known.get(id) ?? id, tools: tools.filter((t) => t.category === id) }));
}

/** Constraint chips for one property schema (enum, default, bounds). */
function chips(schema: ToolSchema): HTMLSpanElement[] {
  const out = (schema.enum ?? []).map((v) => String(v));
  if (schema.default !== undefined) out.push(`default ${JSON.stringify(schema.default)}`);
  if (schema.minimum !== undefined) out.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) out.push(`max ${schema.maximum}`);
  if (schema.maxLength !== undefined) out.push(`max ${schema.maxLength}`);
  if (schema.minItems !== undefined) out.push(`min ${schema.minItems}`);
  if (schema.maxItems !== undefined) out.push(`max ${schema.maxItems}`);
  return out.map((text) => chip(text, { muted: true }));
}

function typeLabel(schema: ToolSchema): string {
  if (schema.enum) return 'enum';
  if (schema.type === 'array') return `${schema.items?.type ?? 'any'}[]`;
  return schema.type ?? 'any';
}

const star = (): HTMLSpanElement => el('span', { class: 'lb-tools__req', text: '*', title: 'required' });

/** Inline summary of an array-of-object item shape: `file`* · `level` high routine · … */
function itemShape(schema: ToolSchema): ElChild[] {
  const item = schema.items;
  if (!item?.properties) return [];
  const required = item.required ?? [];
  return Object.entries(item.properties).flatMap(([key, sub], i) => [
    i > 0 ? ' · ' : null,
    el('code', { text: key }),
    required.includes(key) ? star() : null,
    ...chips(sub).flatMap((node) => [' ', node]),
  ]);
}

function paramsTable(schema: ToolSchema | undefined): HTMLElement {
  const props = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const params: Param[] = Object.entries(props).map(([name, p]) => ({ name, schema: p, required: required.includes(name) }));
  if (params.length === 0) return el('p', { class: 'lb-tools__noparams', text: 'no parameters' });
  const table = new DataTable<Param>({
    key: (p) => p.name,
    columns: [
      {
        id: 'param',
        label: 'param',
        class: 'lb-tools__param',
        render: (p) => el('span', {}, el('b', { text: p.name }), p.required ? star() : null),
      },
      {
        id: 'type',
        label: 'type',
        class: 'lb-tools__type',
        render: (p) => {
          const s = p.schema;
          const c = s.type === 'array' ? chips({ maxItems: s.maxItems, minItems: s.minItems }) : chips(s);
          return el('span', {}, typeLabel(s), ...c.flatMap((node) => [' ', node]));
        },
      },
      {
        id: 'desc',
        label: 'description',
        class: 'lb-tools__pdesc',
        render: (p) => {
          const desc = p.schema.description ?? '';
          const shape = p.schema.type === 'array' ? itemShape(p.schema) : [];
          return el('span', {}, desc, ...(shape.length > 0 ? [desc ? el('br') : null, 'Each: ', ...shape] : []));
        },
      },
    ],
  });
  table.el.classList.add('lb-tools__params');
  table.setRows(params);
  return table.el;
}

function toolCard(tool: ToolDescriptor): HTMLElement {
  return card(
    { tag: 'article', class: 'lb-tools__tool' },
    el(
      'header',
      { class: 'lb-tools__head' },
      el('h3', { class: 'lb-tools__name', text: tool.name }),
      el('span', { class: 'lb-tools__cat', text: tool.category }),
    ),
    el('p', { class: 'lb-tools__excerpt', text: tool.description }),
    paramsTable(tool.inputSchema),
    el(
      'details',
      { class: 'lb-tools__full' },
      el('summary', { text: 'agent-facing description' }),
      el('div', { class: 'lb-tools__desc', text: tool.description }),
    ),
  );
}

export class ToolsView {
  readonly el: HTMLElement;
  private readonly stats = new StatBar([], { align: 'end' });
  private readonly content = el('div', { class: 'lb-tools__content' }, emptyState('loading…'));

  constructor() {
    this.el = el(
      'div',
      { class: ['lb-page', 'lb-tools'] },
      el(
        'div',
        { class: 'lb-tools__bar' },
        el('p', { class: 'lb-tools__sub', text: 'krypton-harness-bus · served from the live tools/list descriptors' }),
        this.stats.el,
      ),
      el(
        'p',
        { class: 'lb-tools__note' },
        'Every lane gets all of these tools. Descriptions are the verbatim agent-facing contract — exactly what the lane reads. ',
        star(),
        ' = required parameter.',
      ),
      this.content,
      el('footer', {
        class: 'lb-tools__footer',
        text: 'rendered from the same descriptors the MCP tools/list handler serves — zero drift by construction',
      }),
    );
  }

  async load(): Promise<void> {
    try {
      const data = await fetchJson<{ tools?: ToolDescriptor[] }>('/tools.json');
      this.render(data.tools ?? []);
    } catch (error) {
      // A non-2xx answer reads as "no descriptors", as the old page did.
      if (error instanceof HttpError) this.render([]);
      else this.content.replaceChildren(emptyState('could not load /tools.json — is the hook server running?'));
    }
  }

  private render(tools: readonly ToolDescriptor[]): void {
    if (tools.length === 0) {
      this.content.replaceChildren(emptyState('no tool descriptors — is the hook server running?'));
      return;
    }
    const sections = toolSections(tools);
    this.content.replaceChildren(
      ...sections.map((s) =>
        el(
          'section',
          { class: 'lb-tools__section', data: { category: s.id } },
          el('h2', { class: 'lb-h3', text: s.title }),
          el('div', { class: 'lb-tools__cards' }, ...s.tools.map(toolCard)),
        ),
      ),
    );
    this.stats.update([
      { key: 'tools', label: 'tools', value: tools.length },
      { key: 'categories', label: 'categories', value: sections.length },
      {
        key: 'params',
        label: 'parameters',
        value: tools.reduce((n, t) => n + Object.keys(t.inputSchema?.properties ?? {}).length, 0),
      },
    ]);
  }
}
