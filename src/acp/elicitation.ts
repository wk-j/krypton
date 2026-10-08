// spec 279 — ACP form elicitation ↔ question card.
// `elicitation/create` carries a flat JSON-Schema object; each property becomes
// one card question, and the card's selected labels map back to wire values.
// Pure functions: no DOM, no IPC.

import type { AskUserQuestion, AskUserReply, QuestionWire } from './ask-user-question';

export type ElicitationFieldKind = 'enum' | 'multi' | 'boolean' | 'text' | 'number' | 'integer';

export interface ElicitationField {
  name: string;
  kind: ElicitationFieldKind;
  /** Wire values for enum/multi, index-aligned with `labels`. */
  values: string[];
  /** Card labels for enum/multi/boolean, index-aligned with `values`. */
  labels: string[];
  /** Listed in the schema's `required`; an empty answer cancels instead of accepting. */
  required: boolean;
}

export interface ElicitationForm {
  questions: AskUserQuestion[];
  fields: ElicitationField[];
}

/** A parked question the card answers: which request, on which wire. */
export interface QuestionTarget {
  requestId: number;
  wire: QuestionWire;
  /** Present when `wire === 'elicitation'`. */
  fields?: ElicitationField[];
}

export type ElicitationValue = string | number | boolean | string[];

export type ElicitationResponse =
  | { action: 'accept'; content: Record<string, ElicitationValue> }
  | { action: 'decline' }
  | { action: 'cancel' };

const BOOLEAN_LABELS = ['Yes', 'No'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** `enum: [...]` or `oneOf|anyOf: [{ const, title }]` → aligned values/labels. */
function enumChoices(schema: Record<string, unknown>): { values: string[]; labels: string[] } | null {
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v): v is string => typeof v === 'string');
    return values.length > 0 ? { values, labels: values } : null;
  }
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (!titled) return null;
  const values: string[] = [];
  const labels: string[] = [];
  for (const raw of titled) {
    const opt = asRecord(raw);
    if (!opt || typeof opt.const !== 'string') continue;
    values.push(opt.const);
    labels.push(str(opt.title) ?? opt.const);
  }
  // The card answers by label, so labels must map 1:1 back to values: two
  // entries sharing a title (e.g. same-named branches) get their const appended.
  const unique = labels.map((label, i) =>
    labels.indexOf(label) !== labels.lastIndexOf(label) ? `${label} (${values[i]})` : label,
  );
  return values.length > 0 ? { values, labels: unique } : null;
}

function joinDetail(...parts: Array<string | undefined>): string | undefined {
  const text = parts.map((p) => p?.trim()).filter((p): p is string => !!p).join('\n\n');
  return text || undefined;
}

/**
 * Build the card for a form elicitation. Returns `null` when the schema has no
 * renderable property, so the caller declines instead of showing an empty card.
 */
export function parseElicitationForm(message: string, schema: unknown): ElicitationForm | null {
  const root = asRecord(schema);
  const props = asRecord(root?.properties);
  if (!props) return null;
  const required = new Set(Array.isArray(root?.required) ? root.required.filter((r): r is string => typeof r === 'string') : []);
  const names = Object.keys(props);
  if (names.length === 0) return null;

  const trimmed = message.trim();
  const newline = trimmed.indexOf('\n');
  const head = newline >= 0 ? trimmed.slice(0, newline).trim() : trimmed;
  const rest = newline >= 0 ? trimmed.slice(newline + 1) : '';

  const questions: AskUserQuestion[] = [];
  const fields: ElicitationField[] = [];
  for (const [i, name] of names.entries()) {
    const prop = asRecord(props[name]);
    if (!prop) return null;
    const title = str(prop.title);
    const description = str(prop.description);
    // One field (OMP's `value`): the message is the question. Several fields:
    // each field is titled, and the message leads the first one.
    const question = names.length === 1
      ? head || title || name
      : title || name;
    const detail = names.length === 1
      ? joinDetail(rest, head && title ? title : undefined, description)
      : joinDetail(i === 0 ? trimmed : undefined, description);
    const base = { question, detail, optional: !required.has(name) };

    if (prop.type === 'string' && (prop.enum || prop.oneOf)) {
      const choices = enumChoices(prop);
      if (!choices) return null;
      const def = typeof prop.default === 'string' ? choices.values.indexOf(prop.default) : -1;
      questions.push({
        ...base,
        options: choices.labels.map((label) => ({ label, description: '' })),
        allowOther: false,
        defaultOption: def >= 0 ? def : undefined,
      });
      fields.push({ name, kind: 'enum', ...choices, required: !base.optional });
    } else if (prop.type === 'array') {
      const choices = enumChoices(asRecord(prop.items) ?? {});
      if (!choices) return null;
      questions.push({
        ...base,
        options: choices.labels.map((label) => ({ label, description: '' })),
        multiSelect: true,
        allowOther: false,
      });
      fields.push({ name, kind: 'multi', ...choices, required: !base.optional });
    } else if (prop.type === 'boolean') {
      questions.push({
        ...base,
        options: BOOLEAN_LABELS.map((label) => ({ label, description: '' })),
        allowOther: false,
        defaultOption: prop.default === false ? 1 : 0,
      });
      fields.push({ name, kind: 'boolean', values: [], labels: BOOLEAN_LABELS, required: !base.optional });
    } else if (prop.type === 'string' || prop.type === 'number' || prop.type === 'integer') {
      const kind = prop.type === 'string' ? 'text' : prop.type;
      const def = prop.default;
      questions.push({
        ...base,
        options: [],
        textOnly: true,
        textKind: kind,
        defaultText: typeof def === 'string' || typeof def === 'number' ? String(def) : undefined,
      });
      fields.push({ name, kind, values: [], labels: [], required: !base.optional });
    } else {
      return null;
    }
  }
  return { questions, fields };
}

/** Map accepted card labels back to `content`; `null` if a label is foreign or a required field is empty. */
export function elicitationContent(
  fields: ElicitationField[],
  selected: string[][],
): Record<string, ElicitationValue> | null {
  const content: Record<string, ElicitationValue> = {};
  for (const [i, field] of fields.entries()) {
    const labels = selected[i] ?? [];
    if (labels.length === 0) {
      if (field.required) return null;
      continue; // optional field left empty
    }
    const toValue = (label: string): string | undefined => {
      const at = field.labels.indexOf(label);
      return at >= 0 ? field.values[at] : undefined;
    };
    switch (field.kind) {
      case 'enum': {
        const value = toValue(labels[0]);
        if (value === undefined) return null;
        content[field.name] = value;
        break;
      }
      case 'multi': {
        const values = labels.map(toValue);
        if (values.some((v) => v === undefined)) return null;
        content[field.name] = values as string[];
        break;
      }
      case 'boolean':
        if (!BOOLEAN_LABELS.includes(labels[0])) return null;
        content[field.name] = labels[0] === 'Yes';
        break;
      case 'number':
      case 'integer': {
        const value = Number(labels[0]);
        if (!Number.isFinite(value) || (field.kind === 'integer' && !Number.isInteger(value))) return null;
        content[field.name] = value;
        break;
      }
      case 'text':
        content[field.name] = labels[0];
        break;
    }
  }
  return content;
}

export function elicitationResponse(fields: ElicitationField[], reply: AskUserReply): ElicitationResponse {
  if (reply.kind === 'decline') return { action: 'decline' };
  if (reply.kind === 'cancel' || reply.decision.outcome !== 'accepted') return { action: 'cancel' };
  const content = elicitationContent(fields, reply.decision.answers.map((a) => a.selected_labels));
  return content ? { action: 'accept', content } : { action: 'cancel' };
}
