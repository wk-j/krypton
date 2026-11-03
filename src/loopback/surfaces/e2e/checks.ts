// Spec 0328 rev 5 — the optional check fields as the run pane reads them:
// step links, the by-step layout, row text, and the JSON Pointer the evidence
// viewer resolves. Pure, so the layout rules are testable without the page.
// Krypton validates every Result before serving it (`validate_result`), so the
// field types below hold for any run the page shows.

export interface CheckTarget {
  readonly type: string;
  readonly name: string;
}

export interface CheckEvidence {
  /** The `label` of an entry in the Result's `artifacts`. */
  readonly artifact: string;
  /** RFC 6901 JSON Pointer into that artifact when it is a `.json` file. */
  readonly pointer?: string;
}

export interface Check {
  readonly group?: string;
  readonly label: string;
  readonly status: string;
  readonly detail?: string;
  readonly at?: unknown;
  readonly kind?: string;
  readonly step?: string;
  readonly target?: CheckTarget;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  readonly evidence?: CheckEvidence;
  readonly expected?: string;
  readonly actual?: string;
}

export interface StepLinks {
  /** Per check: the index of the step row it links to, or null. */
  readonly linkOf: readonly (number | null)[];
  /** Per check: a `step` key that no `kind: "step"` row declares, or null. */
  readonly unknownStep: readonly (string | null)[];
  /** Step heads in Result order: the first `kind: "step"` row of each key, and every keyless step row. */
  readonly heads: readonly number[];
}

export interface StepLayout {
  readonly preconditions: readonly number[];
  readonly steps: readonly { readonly head: number; readonly rows: readonly number[] }[];
  readonly other: readonly number[];
}

/** Values longer than this are cut with `…`; the full value is in the evidence. */
export const VALUE_CHARS = 500;

/**
 * Who links to which step. A `kind: "step"` row with a key declares it; a later
 * step row repeating the key declares nothing and links to nothing, so it lands
 * under "Other checks". Any other row with a `step` links to its declaration.
 */
export function stepLinks(checks: readonly Check[]): StepLinks {
  const declared = new Map<string, number>();
  const heads: number[] = [];
  checks.forEach((check, index) => {
    if (check.kind !== 'step') return;
    if (check.step === undefined) heads.push(index);
    else if (!declared.has(check.step)) {
      declared.set(check.step, index);
      heads.push(index);
    }
  });
  const linked = (check: Check): boolean => check.kind !== 'step' && check.step !== undefined;
  return {
    linkOf: checks.map((check) => (linked(check) ? (declared.get(check.step ?? '') ?? null) : null)),
    unknownStep: checks.map((check) => (linked(check) && !declared.has(check.step ?? '') ? (check.step ?? null) : null)),
    heads,
  };
}

/** Preconditions without a step link, one block per step head with its linked rows, then everything else. */
export function stepLayout(checks: readonly Check[], links: StepLinks): StepLayout {
  const rowsOf = new Map<number, number[]>(links.heads.map((head) => [head, []]));
  const preconditions: number[] = [];
  const other: number[] = [];
  checks.forEach((check, index) => {
    if (rowsOf.has(index)) return;
    const link = links.linkOf[index];
    const rows = link === null ? undefined : rowsOf.get(link);
    if (rows) rows.push(index);
    else if (check.kind === 'precondition') preconditions.push(index);
    else other.push(index);
  });
  return { preconditions, steps: links.heads.map((head) => ({ head, rows: rowsOf.get(head) ?? [] })), other };
}

export function kindTag(kind: string | undefined): string | null {
  if (kind === 'precondition') return 'pre';
  if (kind === 'step' || kind === 'expect') return kind;
  return null;
}

/** `k=v · k=v`, keys sorted, so two runs of a step read the same way. */
export function paramsText(params: Readonly<Record<string, string | number | boolean>>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join(' · ');
}

export function clip(text: string, max = VALUE_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** What a JSON Pointer reaches: the value, or nothing. */
export type PointerHit = { readonly found: true; readonly value: unknown } | { readonly found: false };

/** RFC 6901: `""` is the whole document; `~1` is `/` and `~0` is `~` inside a token. */
export function resolvePointer(doc: unknown, pointer: string): PointerHit {
  if (pointer === '') return { found: true, value: doc };
  if (!pointer.startsWith('/')) return { found: false };
  let current = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) return { found: false };
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
