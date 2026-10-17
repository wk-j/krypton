// Krypton — generative UI catalog (spec 309).
// THE source of truth: `validate.ts` checks against it, `evaluate.ts` normalises
// props by it, the renderer map is keyed by it (`satisfies Record<ComponentName, …>`
// so an entry without a renderer fails `tsc`), and `genUiPrompt` is generated from
// it so the prompt can never drift from what the parser accepts.

export type ParamKind =
  | 'string'    // plain one-line text
  | 'text'      // may carry inline markdown
  | 'number'
  | 'boolean'
  | 'list'
  | 'object'
  | 'any'       // list or object, shape checked by the renderer
  | 'nodes'     // children: nested lists flatten, strings become Text, null drops
  | 'actions'   // one action or a list of actions
  | 'binding'   // must be written literally as `$name`
  | 'enum'
  | 'series';   // list of numbers, or list of { name, values }

export type StateKind = 'text' | 'number' | 'boolean' | 'scalar' | 'list';

export interface ParamSpec {
  readonly name: string;
  readonly kind: ParamKind;
  readonly required?: boolean;
  /** `enum` only. */
  readonly values?: readonly string[];
  /** `binding` only: the value kind the input writes. */
  readonly holds?: StateKind;
}

export type ComponentGroup = 'Layout' | 'Content' | 'Data' | 'Inputs' | 'Form';

export interface ComponentSpec {
  readonly name: string;
  readonly group: ComponentGroup;
  readonly summary: string;
  readonly params: readonly ParamSpec[];
}

export const TONES = ['neutral', 'good', 'warn', 'bad', 'info'] as const;

const tone: ParamSpec = { name: 'tone', kind: 'enum', values: TONES };
const label: ParamSpec = { name: 'label', kind: 'string' };
const children: ParamSpec = { name: 'children', kind: 'nodes', required: true };

export const COMPONENTS: readonly ComponentSpec[] = [
  // ── Layout ────────────────────────────────────────────────────────────────
  {
    name: 'Card', group: 'Layout', summary: 'Titled frame; the outermost one is the panel frame',
    params: [{ name: 'title', kind: 'string', required: true }, children],
  },
  { name: 'Row', group: 'Layout', summary: 'Equal-width wrapping row', params: [children] },
  { name: 'Stack', group: 'Layout', summary: 'Vertical stack', params: [children] },
  {
    name: 'Grid', group: 'Layout', summary: 'Tile grid',
    params: [children, { name: 'columns', kind: 'number' }],
  },
  {
    name: 'Tabs', group: 'Layout', summary: 'Tabbed panes; one label per child',
    params: [{ name: 'labels', kind: 'list', required: true }, children],
  },
  {
    name: 'Details', group: 'Layout', summary: 'Collapsible section',
    params: [{ name: 'title', kind: 'string', required: true }, children, { name: 'open', kind: 'boolean' }],
  },
  { name: 'Divider', group: 'Layout', summary: 'Horizontal rule', params: [] },

  // ── Content ───────────────────────────────────────────────────────────────
  {
    name: 'Text', group: 'Content', summary: 'Paragraph with inline markdown',
    params: [{ name: 'text', kind: 'text', required: true }, tone],
  },
  {
    name: 'Callout', group: 'Content', summary: 'Boxed note',
    params: [{ name: 'text', kind: 'text', required: true }, tone, { name: 'title', kind: 'string' }],
  },
  {
    name: 'Metric', group: 'Content', summary: 'One key number with a label',
    params: [
      { name: 'label', kind: 'string', required: true },
      { name: 'value', kind: 'string', required: true },
      { name: 'note', kind: 'string' },
      tone,
    ],
  },
  {
    name: 'Badge', group: 'Content', summary: 'Short status pill',
    params: [{ name: 'text', kind: 'string', required: true }, tone],
  },
  {
    name: 'KeyValue', group: 'Content', summary: 'Object or [[key, value]] pairs',
    params: [{ name: 'pairs', kind: 'any', required: true }],
  },
  {
    name: 'List', group: 'Content', summary: 'Rows of { title, detail?, value?, tone?, action? }',
    params: [{ name: 'items', kind: 'list', required: true }],
  },
  {
    name: 'Sources', group: 'Content', summary: 'Citation list of urls or { url, title?, note? }',
    params: [{ name: 'links', kind: 'list', required: true }],
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  {
    name: 'Table', group: 'Data', summary: 'Table; a cell may be a component',
    params: [
      { name: 'columns', kind: 'list', required: true },
      { name: 'rows', kind: 'list', required: true },
    ],
  },
  {
    name: 'Chart', group: 'Data', summary: 'Chart of one or more series',
    params: [
      { name: 'type', kind: 'enum', required: true, values: ['bar', 'line', 'area', 'pie', 'scatter', 'funnel', 'heatmap'] },
      { name: 'labels', kind: 'list', required: true },
      { name: 'series', kind: 'series', required: true },
      { name: 'unit', kind: 'string' },
      { name: 'stacked', kind: 'boolean' },
    ],
  },
  {
    name: 'Sparkline', group: 'Data', summary: 'Inline trend line',
    params: [{ name: 'values', kind: 'list', required: true }, tone],
  },
  {
    name: 'Progress', group: 'Data', summary: 'Progress bar; a percentage when max is omitted',
    params: [
      { name: 'value', kind: 'number', required: true },
      { name: 'max', kind: 'number' },
      label,
      tone,
    ],
  },
  {
    name: 'Gauge', group: 'Data', summary: 'Dial reading; max defaults to 100',
    params: [
      { name: 'value', kind: 'number', required: true },
      { name: 'min', kind: 'number' },
      { name: 'max', kind: 'number' },
      label,
      tone,
    ],
  },
  {
    name: 'SegmentedBar', group: 'Data', summary: 'Shares of one whole: { label, value, tone? }',
    params: [{ name: 'parts', kind: 'list', required: true }, { name: 'unit', kind: 'string' }],
  },
  {
    name: 'Steps', group: 'Data', summary: 'Ordered steps: { title, detail?, status?: done|current|blocked }',
    params: [{ name: 'items', kind: 'list', required: true }],
  },
  {
    name: 'Timeline', group: 'Data', summary: 'Events: { time, title, detail?, tone? }',
    params: [{ name: 'items', kind: 'list', required: true }],
  },
  {
    name: 'Tree', group: 'Data', summary: 'Paths, or { label, children?, note? }',
    params: [{ name: 'items', kind: 'list', required: true }],
  },
  {
    name: 'Code', group: 'Data', summary: 'Code block with copy',
    params: [{ name: 'code', kind: 'string', required: true }, { name: 'language', kind: 'string' }],
  },
  {
    name: 'Diff', group: 'Data', summary: 'Unified patch for one file',
    params: [{ name: 'patch', kind: 'string', required: true }, { name: 'path', kind: 'string' }],
  },
  {
    name: 'Diagram', group: 'Data', summary: 'Mermaid diagram',
    params: [{ name: 'mermaid', kind: 'string', required: true }],
  },

  // ── Inputs ────────────────────────────────────────────────────────────────
  {
    name: 'Slider', group: 'Inputs', summary: 'Numeric slider',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'number' },
      { name: 'min', kind: 'number', required: true },
      { name: 'max', kind: 'number', required: true },
      { name: 'step', kind: 'number' },
      label,
    ],
  },
  {
    name: 'Stepper', group: 'Inputs', summary: 'Plus/minus counter',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'number' },
      { name: 'min', kind: 'number' },
      { name: 'max', kind: 'number' },
      { name: 'step', kind: 'number' },
      label,
    ],
  },
  {
    name: 'Toggle', group: 'Inputs', summary: 'On/off switch',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'boolean' },
      { name: 'label', kind: 'string', required: true },
    ],
  },
  {
    name: 'Choice', group: 'Inputs', summary: 'Segmented picker',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'scalar' },
      { name: 'options', kind: 'list', required: true },
      label,
    ],
  },
  {
    name: 'Radio', group: 'Inputs', summary: 'Vertical radio list; an option may be { value, detail }',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'scalar' },
      { name: 'options', kind: 'list', required: true },
      label,
    ],
  },
  {
    name: 'Select', group: 'Inputs', summary: 'Dropdown',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'scalar' },
      { name: 'options', kind: 'list', required: true },
      label,
    ],
  },
  {
    name: 'Checklist', group: 'Inputs', summary: 'Multi-select into a list input',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'list' },
      { name: 'options', kind: 'list', required: true },
      label,
    ],
  },
  {
    name: 'Input', group: 'Inputs', summary: 'One-line text field',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'text' },
      label,
      { name: 'placeholder', kind: 'string' },
    ],
  },
  {
    name: 'TextArea', group: 'Inputs', summary: 'Multi-line text field',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'text' },
      label,
      { name: 'placeholder', kind: 'string' },
    ],
  },
  {
    name: 'Rating', group: 'Inputs', summary: 'Star rating; 0 is unrated',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'number' },
      { name: 'max', kind: 'number' },
      label,
    ],
  },
  {
    name: 'EditableTable', group: 'Inputs', summary: 'Editable grid of row objects',
    params: [
      { name: 'value', kind: 'binding', required: true, holds: 'list' },
      { name: 'columns', kind: 'list', required: true },
      label,
    ],
  },
  {
    name: 'Button', group: 'Inputs', summary: 'Runs its actions; with none it drafts its own label',
    params: [
      { name: 'label', kind: 'string', required: true },
      { name: 'action', kind: 'actions' },
      { name: 'variant', kind: 'enum', values: ['primary', 'secondary', 'destructive'] },
    ],
  },

  // ── Form ──────────────────────────────────────────────────────────────────
  {
    name: 'Form', group: 'Form', summary: 'Field group; submit drafts one message of every field',
    params: [children, { name: 'submit', kind: 'string' }],
  },
  {
    name: 'FollowUps', group: 'Form', summary: 'Suggested next questions; choosing one drafts it',
    params: [{ name: 'prompts', kind: 'list', required: true }],
  },
];

export const GROUP_ORDER: readonly ComponentGroup[] = ['Layout', 'Content', 'Data', 'Inputs', 'Form'];

export const COMPONENT_BY_NAME: Readonly<Record<string, ComponentSpec>> = Object.fromEntries(
  COMPONENTS.map((component) => [component.name, component]),
);

export type ActionName = 'Draft' | 'Set' | 'Copy' | 'OpenUrl';

export interface ActionSpec {
  readonly name: ActionName;
  readonly summary: string;
  readonly params: readonly ParamSpec[];
}

export const ACTIONS: readonly ActionSpec[] = [
  {
    name: 'Draft', summary: 'Load the composer draft; the user presses Enter to send',
    params: [{ name: 'text', kind: 'string', required: true }],
  },
  {
    name: 'Set', summary: 'Assign a declared input',
    params: [
      { name: 'target', kind: 'binding', required: true },
      { name: 'value', kind: 'any', required: true },
    ],
  },
  {
    name: 'Copy', summary: 'Copy text to the clipboard',
    params: [{ name: 'text', kind: 'string', required: true }],
  },
  {
    name: 'OpenUrl', summary: 'Open an http(s) url in the browser',
    params: [{ name: 'url', kind: 'string', required: true }],
  },
];

export const ACTION_BY_NAME: Readonly<Record<string, ActionSpec>> = Object.fromEntries(
  ACTIONS.map((action) => [action.name, action]),
);

export type Arity = readonly [min: number, max: number];

/** Global functions: name → arity. */
export const FUNCTIONS: Readonly<Record<string, Arity>> = {
  round: [1, 2],
  fmt: [1, 2],
  sum: [1, 1],
  min: [1, 8],
  max: [1, 8],
  abs: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  pow: [2, 2],
  keys: [1, 1],
  values: [1, 1],
  entries: [1, 1],
  len: [1, 1],
};

/** Methods allowed on a list value: name → arity. */
export const LIST_METHODS: Readonly<Record<string, Arity>> = {
  map: [1, 1],
  filter: [1, 1],
  find: [1, 1],
  some: [1, 1],
  every: [1, 1],
  join: [0, 1],
  slice: [1, 2],
  includes: [1, 1],
  indexOf: [1, 1],
};

/** Methods whose first argument must be an arrow. */
export const LAMBDA_METHODS: Readonly<Record<string, true>> = {
  map: true, filter: true, find: true, some: true, every: true,
};

export const STRING_METHODS: Readonly<Record<string, Arity>> = {
  includes: [1, 1],
  slice: [1, 2],
  split: [1, 1],
  trim: [0, 0],
  toUpperCase: [0, 0],
  toLowerCase: [0, 0],
  startsWith: [1, 1],
  endsWith: [1, 1],
};

export const NUMBER_METHODS: Readonly<Record<string, Arity>> = {
  toFixed: [0, 1],
};

// Computed keys, so `__proto__` becomes an own property instead of setting the
// prototype; `as const` because TS widens a property named `constructor` to boolean.
export const FORBIDDEN_PROPERTIES: Readonly<Record<string, true>> = {
  ['__proto__']: true, prototype: true, ['constructor']: true as const,
};

/**
 * Own-property lookup. Catalog tables are plain objects, so a spec naming
 * `constructor` or `toString` must not reach `Object.prototype`.
 */
export function tableHas(table: Readonly<Record<string, unknown>>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, name);
}

/** Max parameters an arrow may declare: `(item, index)`. */
export const MAX_ARROW_PARAMS = 2;

function paramSignature(param: ParamSpec): string {
  const optional = param.required ? '' : '?';
  if (param.kind === 'enum') return `${param.name}${optional}: ${(param.values ?? []).join('|')}`;
  if (param.kind === 'binding') return `$${param.name}`;
  return `${param.name}${optional}`;
}

/** One prompt line per component, e.g. `Gauge(value, min?, max?, label?, tone?) — Dial reading…`. */
export function componentSignature(component: ComponentSpec): string {
  return `${component.name}(${component.params.map(paramSignature).join(', ')}) — ${component.summary}`;
}

export function actionSignature(action: ActionSpec): string {
  return `${action.name}(${action.params.map(paramSignature).join(', ')}) — ${action.summary}`;
}
