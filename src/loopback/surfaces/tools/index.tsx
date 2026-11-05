// Spec 186 (+ spec 341) — the built-in MCP tool reference. One fetch of
// `/tools.json`, no polling: the descriptors are compile-time data served
// straight from `bus_tool_descriptors()` in Rust, plus a page-only category.
// Spec 361: a React page; one card per descriptor.

import { Fragment, useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import { Card, Chip, DataTable, EmptyState, fetchJson, HttpError, StatBar } from '../../kit';
import type { Column } from '../../kit';

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

type Load = { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ok'; readonly tools: readonly ToolDescriptor[] };

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

/** Constraint chips for one property schema (enum, default, bounds), each preceded by a space. */
function chips(schema: ToolSchema): ReactNode[] {
  const out = (schema.enum ?? []).map((v) => String(v));
  if (schema.default !== undefined) out.push(`default ${JSON.stringify(schema.default)}`);
  if (schema.minimum !== undefined) out.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) out.push(`max ${schema.maximum}`);
  if (schema.maxLength !== undefined) out.push(`max ${schema.maxLength}`);
  if (schema.minItems !== undefined) out.push(`min ${schema.minItems}`);
  if (schema.maxItems !== undefined) out.push(`max ${schema.maxItems}`);
  return out.map((text, i) => (
    <Fragment key={i}>
      {' '}
      <Chip text={text} muted />
    </Fragment>
  ));
}

function typeLabel(schema: ToolSchema): string {
  if (schema.enum) return 'enum';
  if (schema.type === 'array') return `${schema.items?.type ?? 'any'}[]`;
  return schema.type ?? 'any';
}

function Star(): JSX.Element {
  return (
    <span className="lb-tools__req" title="required">
      *
    </span>
  );
}

/** Inline summary of an array-of-object item shape: `file`* · `level` high routine · … */
function itemShape(schema: ToolSchema): ReactNode[] {
  const item = schema.items;
  if (!item?.properties) return [];
  const required = item.required ?? [];
  return Object.entries(item.properties).map(([key, sub], i) => (
    <Fragment key={key}>
      {i > 0 ? ' · ' : null}
      <code>{key}</code>
      {required.includes(key) ? <Star /> : null}
      {chips(sub)}
    </Fragment>
  ));
}

const PARAM_COLUMNS: readonly Column<Param>[] = [
  {
    id: 'param',
    label: 'param',
    class: 'lb-tools__param',
    render: (p) => (
      <span>
        <b>{p.name}</b>
        {p.required ? <Star /> : null}
      </span>
    ),
  },
  {
    id: 'type',
    label: 'type',
    class: 'lb-tools__type',
    render: (p) => {
      const s = p.schema;
      return (
        <span>
          {typeLabel(s)}
          {s.type === 'array' ? chips({ maxItems: s.maxItems, minItems: s.minItems }) : chips(s)}
        </span>
      );
    },
  },
  {
    id: 'desc',
    label: 'description',
    class: 'lb-tools__pdesc',
    render: (p) => {
      const desc = p.schema.description ?? '';
      const shape = p.schema.type === 'array' ? itemShape(p.schema) : [];
      return (
        <span>
          {desc}
          {shape.length > 0 ? (
            <>
              {desc ? <br /> : null}
              {'Each: '}
              {shape}
            </>
          ) : null}
        </span>
      );
    },
  },
];

function ParamsTable({ schema }: { readonly schema: ToolSchema | undefined }): JSX.Element {
  const props = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const params: Param[] = Object.entries(props).map(([name, p]) => ({ name, schema: p, required: required.includes(name) }));
  if (params.length === 0) return <p className="lb-tools__noparams">no parameters</p>;
  return <DataTable<Param> className="lb-tools__params" columns={PARAM_COLUMNS} rows={params} itemKey={(p) => p.name} />;
}

function ToolCard({ tool }: { readonly tool: ToolDescriptor }): JSX.Element {
  return (
    <Card tag="article" className="lb-tools__tool">
      <header className="lb-tools__head">
        <h3 className="lb-tools__name">{tool.name}</h3>
        <span className="lb-tools__cat">{tool.category}</span>
      </header>
      <p className="lb-tools__excerpt">{tool.description}</p>
      <ParamsTable schema={tool.inputSchema} />
      <details className="lb-tools__full">
        <summary>agent-facing description</summary>
        <div className="lb-tools__desc">{tool.description}</div>
      </details>
    </Card>
  );
}

export function ToolsPage(): JSX.Element {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    fetchJson<{ tools?: ToolDescriptor[] }>('/tools.json').then(
      (data) => {
        if (live) setLoad({ kind: 'ok', tools: data.tools ?? [] });
      },
      (error: unknown) => {
        // A non-2xx answer reads as "no descriptors", as the old page did.
        if (live) setLoad(error instanceof HttpError ? { kind: 'ok', tools: [] } : { kind: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const tools = load.kind === 'ok' ? load.tools : [];
  const sections = toolSections(tools);
  let content: ReactNode;
  if (load.kind === 'loading') content = <EmptyState text="loading…" />;
  else if (load.kind === 'error') content = <EmptyState text="could not load /tools.json — is the hook server running?" />;
  else if (tools.length === 0) content = <EmptyState text="no tool descriptors — is the hook server running?" />;
  else {
    content = sections.map((s) => (
      <section key={s.id} className="lb-tools__section" data-category={s.id}>
        <h2 className="lb-h3">{s.title}</h2>
        <div className="lb-tools__cards">
          {s.tools.map((tool) => (
            <ToolCard key={tool.name} tool={tool} />
          ))}
        </div>
      </section>
    ));
  }

  return (
    <div className="lb-page lb-tools">
      <div className="lb-tools__bar">
        <p className="lb-tools__sub">krypton-harness-bus · served from the live tools/list descriptors</p>
        <StatBar
          align="end"
          stats={
            tools.length > 0
              ? [
                  { key: 'tools', label: 'tools', value: tools.length },
                  { key: 'categories', label: 'categories', value: sections.length },
                  {
                    key: 'params',
                    label: 'parameters',
                    value: tools.reduce((n, t) => n + Object.keys(t.inputSchema?.properties ?? {}).length, 0),
                  },
                ]
              : []
          }
        />
      </div>
      <p className="lb-tools__note">
        Every lane gets all of these tools. Descriptions are the verbatim agent-facing contract — exactly what the lane reads.{' '}
        <Star /> = required parameter.
      </p>
      <div className="lb-tools__content">{content}</div>
      <footer className="lb-tools__footer">
        rendered from the same descriptors the MCP tools/list handler serves — zero drift by construction
      </footer>
    </div>
  );
}
