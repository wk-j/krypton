// Spec 302 §7.15 — `TimelineCapture`.
//
// The local-timeline capture / suggestion-review form (`timeline-capture.ts:90-430`).
// Today the markup, the listeners and the controller (debounced semantic
// suggestion, duplicate detection, validation, save) are one 518-line class, so
// nothing about the form can be rendered without also owning the save path.
//
// This component is the form: every value is a prop and every edit is a
// callback, so the controller keeps the async work and the component keeps the
// DOM. Inputs are written only when the incoming value differs from what the
// field already holds — otherwise a repaint mid-typing would move the caret.
//
// Thai strings are verbatim; they are the UI, not placeholders.

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { ActionButton } from '../action-button';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './timeline-capture.css';

/** The text fields, in the order the form lays them out. */
export type TimelineField =
  | 'topic'
  | 'summary'
  | 'madeBy'
  | 'occurredAt'
  | 'sourceRef'
  | 'rationale'
  | 'impact';

/** The two `<select>`s, which carry ids rather than free text. */
export type TimelineChoice = 'relation' | 'relatedEvent';

interface FieldSpec {
  readonly name: TimelineField;
  readonly label: string;
  readonly type: string;
  readonly maxLength: number;
  readonly placeholder?: string;
  /** `textarea` instead of `input`. */
  readonly multiline?: boolean;
}

const BEFORE_RELATION: readonly FieldSpec[] = [
  { name: 'summary', label: 'สรุป', type: 'text', maxLength: 500 },
  {
    name: 'madeBy',
    label: 'ผู้ขอหรือผู้อนุมัติ',
    type: 'text',
    maxLength: 120,
    placeholder: 'ใครเป็นผู้ขอหรืออนุมัติเรื่องนี้',
  },
  { name: 'occurredAt', label: 'เกิดขึ้นเมื่อ', type: 'datetime-local', maxLength: 0 },
  {
    name: 'sourceRef',
    label: 'แหล่งอ้างอิง',
    type: 'text',
    maxLength: 2048,
    placeholder: 'URL, commit หรือเอกสารที่อ้างจาก project',
  },
];

const AFTER_RELATION: readonly FieldSpec[] = [
  { name: 'rationale', label: 'เหตุผล', type: 'text', maxLength: 4096, multiline: true },
  { name: 'impact', label: 'ผลกระทบ', type: 'text', maxLength: 4096, multiline: true },
];

export interface TimelineOption {
  readonly value: string;
  readonly label: string;
}

export interface TimelineSemanticMatch {
  readonly title: string;
  /** 0..1; rendered as a whole percent. */
  readonly confidence: number;
  /** Which of the two buttons is marked `data-selected="true"`. */
  readonly decision: 'existing' | 'new' | null;
}

export interface TimelineCaptureProps {
  readonly open: boolean;
  /** Review-a-suggestion mode: different title and submit label, plus evidence. */
  readonly suggestion: boolean;
  readonly values: Readonly<Record<TimelineField, string>>;
  readonly relation: string;
  readonly relatedEvent: string;
  /** Topic titles for the `<datalist>`, newest first. */
  readonly topicOptions: readonly string[];
  /** `ความสัมพันธ์` options after the leading `ไม่มี`. */
  readonly relations: readonly TimelineOption[];
  /** `เหตุการณ์ที่เกี่ยวข้อง` options after the leading `ไม่มี`. */
  readonly relatedEvents: readonly TimelineOption[];
  /** Up to five ranked topic buttons; empty hides the row (`:empty`). */
  readonly topicMatches: readonly TimelineOption[];
  readonly semantic: TimelineSemanticMatch | null;
  /** Non-null when near-duplicate topics exist; the text is the whole warning. */
  readonly duplicateWarning: string | null;
  readonly duplicateChecked: boolean;
  readonly evidence: { readonly lane: string; readonly excerpt: string } | null;
  /** `''` keeps the reserved line without an alert. */
  readonly error: string;
  readonly saving: boolean;
  /** A suggestion can be refused; a fresh capture cannot. */
  readonly canDismiss: boolean;
  onEdit(field: TimelineField, value: string): void;
  onChoose(choice: TimelineChoice, value: string): void;
  onPickTopic(value: string): void;
  onSemanticDecision(decision: 'existing' | 'new'): void;
  onDuplicateToggle(checked: boolean): void;
  onSubmit(): void;
  onCancel(): void;
  onDismiss(): void;
  onAutoClose?(): void;
}

export class TimelineCapture extends Component<TimelineCaptureProps> {
  private readonly shell: OverlayShell;
  private readonly form: HTMLFormElement;
  private readonly fields = new Map<TimelineField, HTMLInputElement | HTMLTextAreaElement>();
  private readonly selects = new Map<TimelineChoice, HTMLSelectElement>();
  private readonly datalist: HTMLDataListElement;
  private readonly topicMatches: HTMLElement;
  private readonly semanticEl: HTMLElement;
  private readonly duplicateBox: HTMLElement;
  private readonly duplicateInput: HTMLInputElement;
  private readonly duplicateText: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly cancel = new ActionButton();
  private readonly dismiss = new ActionButton();
  private readonly submit = new ActionButton();
  private evidenceEl: HTMLElement | null = null;
  private props: TimelineCaptureProps | null = null;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.form = el('form', { class: 'acp-timeline__form' });

    this.datalist = el('datalist', { attrs: { id: 'timeline-topics' } });
    const topic = this.field({ name: 'topic', label: 'หัวข้อ', type: 'text', maxLength: 120 });
    setAttr(topic, 'list', 'timeline-topics');
    this.form.appendChild(this.datalist);

    this.topicMatches = el('div', { class: 'acp-timeline__topic-matches' });
    this.semanticEl = el('section', {
      class: 'acp-timeline__semantic-match',
      attrs: { 'aria-live': 'polite' },
    });
    this.semanticEl.hidden = true;
    this.duplicateInput = el('input', { attrs: { type: 'checkbox' } });
    this.duplicateText = el('span', { data: { 'timeline-duplicate-text': '' } });
    this.duplicateBox = el('label', { class: 'acp-timeline__duplicate' }, this.duplicateInput, this.duplicateText);
    this.duplicateBox.hidden = true;
    this.form.append(this.topicMatches, this.semanticEl, this.duplicateBox);

    for (const spec of BEFORE_RELATION) this.field(spec);
    this.select('relation', 'ความสัมพันธ์');
    this.select('relatedEvent', 'เหตุการณ์ที่เกี่ยวข้อง');
    for (const spec of AFTER_RELATION) this.field(spec);

    this.errorEl = el('p', { class: 'acp-timeline__error', attrs: { role: 'alert' } });
    this.actions = el('footer', { class: 'acp-timeline__actions' });
    this.form.append(this.errorEl, this.actions);

    // Five delegated listeners for the whole form, attached once; `paint()`
    // never attaches another one.
    this.bag.listen(this.form, 'submit', (event: Event) => {
      event.preventDefault();
      this.props?.onSubmit();
    });
    this.bag.listen(this.form, 'input', (event: Event) => this.handleEdit(event));
    this.bag.listen(this.form, 'change', (event: Event) => this.handleEdit(event));
    this.bag.listen(this.topicMatches, 'click', (event: Event) => {
      const value = buttonData(event, 'topicValue');
      if (value !== null) this.props?.onPickTopic(value);
    });
    this.bag.listen(this.semanticEl, 'click', (event: Event) => {
      const decision = buttonData(event, 'decision');
      if (decision === 'existing' || decision === 'new') this.props?.onSemanticDecision(decision);
    });
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  update(next: TimelineCaptureProps): void {
    this.props = next;
    super.update(next);
  }

  protected readDeps(next: TimelineCaptureProps): readonly unknown[] {
    return [
      next.open,
      next.suggestion,
      next.values,
      ...Object.values(next.values),
      next.relation,
      next.relatedEvent,
      next.topicOptions.join('\u0001'),
      next.relations.map((option) => option.value).join('\u0001'),
      next.relatedEvents.map((option) => option.value).join('\u0001'),
      next.topicMatches.map((match) => `${match.value}\u0001${match.label}`).join('\u0002'),
      next.semantic?.title ?? null,
      next.semantic?.confidence ?? null,
      next.semantic?.decision ?? null,
      next.duplicateWarning,
      next.duplicateChecked,
      next.evidence?.lane ?? null,
      next.evidence?.excerpt ?? null,
      next.error,
      next.saving,
      next.canDismiss,
    ];
  }

  protected syncClasses(_next: TimelineCaptureProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: TimelineCaptureProps): void {
    this.syncDatalist(next.topicOptions);
    for (const [name, node] of this.fields) {
      const value = next.values[name];
      if (node.value !== value) node.value = value;
    }
    this.syncSelect('relation', next.relations, next.relation);
    this.syncSelect('relatedEvent', next.relatedEvents, next.relatedEvent);
    this.syncTopicMatches(next);
    this.syncSemantic(next);
    this.syncDuplicate(next);
    this.syncEvidence(next);
    this.errorEl.textContent = next.error;
    this.syncActions(next);

    this.shell.update({
      open: next.open,
      name: 'timeline',
      block: 'acp-timeline',
      title: next.suggestion ? 'ตรวจทานข้อเสนอ Timeline' : 'บันทึกเหตุการณ์ใน Timeline',
      sub: '.krypton/timeline เก็บไว้เฉพาะเครื่องนี้ Git ไม่ติดตามไฟล์',
      body: this.form,
      onAutoClose: next.onAutoClose,
    });
  }

  /** Focus the topic field — the caller's cue that the form just opened. */
  focusTopic(): void {
    this.fields.get('topic')?.focus();
  }

  private handleEdit(event: Event): void {
    const target = event.target;
    const props = this.props;
    if (!props) return;
    if (target === this.duplicateInput) {
      props.onDuplicateToggle(this.duplicateInput.checked);
      return;
    }
    if (target instanceof HTMLSelectElement) {
      for (const [choice, node] of this.selects) {
        if (node === target) props.onChoose(choice, target.value);
      }
      return;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      for (const [name, node] of this.fields) {
        if (node === target) props.onEdit(name, target.value);
      }
    }
  }

  private field(spec: FieldSpec): HTMLInputElement | HTMLTextAreaElement {
    const label = el('label', { class: 'acp-timeline__field' }, el('span', { text: spec.label }));
    const node = spec.multiline
      ? el('textarea', { attrs: { name: spec.name, maxlength: spec.maxLength, rows: 3 } })
      : el('input', { attrs: { name: spec.name, type: spec.type } });
    if (!spec.multiline && spec.maxLength > 0) setAttr(node, 'maxlength', spec.maxLength);
    if (spec.placeholder) setAttr(node, 'placeholder', spec.placeholder);
    label.appendChild(node);
    this.form.appendChild(label);
    this.fields.set(spec.name, node);
    return node;
  }

  private select(name: TimelineChoice, labelText: string): void {
    const label = el('label', { class: 'acp-timeline__field' }, el('span', { text: labelText }));
    const node = el('select', { attrs: { name } });
    label.appendChild(node);
    this.form.appendChild(label);
    this.selects.set(name, node);
  }

  private syncDatalist(options: readonly string[]): void {
    this.datalist.replaceChildren(...options.map((value) => el('option', { attrs: { value } })));
  }

  private syncSelect(name: TimelineChoice, options: readonly TimelineOption[], value: string): void {
    const node = this.selects.get(name);
    if (!node) return;
    node.replaceChildren(
      el('option', { attrs: { value: '' }, text: 'ไม่มี' }),
      ...options.map((option) => el('option', { attrs: { value: option.value }, text: option.label })),
    );
    node.value = value;
  }

  private syncTopicMatches(next: TimelineCaptureProps): void {
    this.topicMatches.replaceChildren(...next.topicMatches.map((match) => el('button', {
      attrs: { type: 'button' },
      data: { 'topic-value': match.value },
      text: match.label,
    })));
  }

  private syncSemantic(next: TimelineCaptureProps): void {
    const match = next.semantic;
    if (!match) {
      this.semanticEl.hidden = true;
      this.semanticEl.replaceChildren();
      return;
    }
    this.semanticEl.hidden = false;
    const label = el('p', {
      text: `หัวข้อที่น่าจะตรง · ${match.title} · confidence ${Math.round(match.confidence * 100)}%`,
    });
    const useExisting = el('button', {
      attrs: { type: 'button' },
      data: { decision: 'existing', selected: String(match.decision === 'existing') },
      text: 'ใช้หัวข้อนี้',
    });
    const createNew = el('button', {
      attrs: { type: 'button' },
      data: { decision: 'new', selected: String(match.decision === 'new') },
      text: 'สร้างหัวข้อใหม่',
    });
    this.semanticEl.replaceChildren(label, el('div', {}, useExisting, createNew));
  }

  private syncDuplicate(next: TimelineCaptureProps): void {
    this.duplicateBox.hidden = next.duplicateWarning === null;
    this.duplicateText.textContent = next.duplicateWarning ?? '';
    this.duplicateInput.checked = next.duplicateChecked;
  }

  private syncEvidence(next: TimelineCaptureProps): void {
    if (!next.evidence) {
      this.evidenceEl?.remove();
      this.evidenceEl = null;
      return;
    }
    const node = this.evidenceEl ?? el('section', { class: 'acp-timeline__evidence' }, el('h3'), el('p'));
    this.evidenceEl = node;
    const heading = node.querySelector('h3');
    const text = node.querySelector('p');
    if (heading) heading.textContent = `หลักฐาน · ${next.evidence.lane}`;
    if (text) text.textContent = next.evidence.excerpt;
    // Evidence sits between the last text field and the relation selects, the
    // place the builder appended it.
    const relation = this.selects.get('relation')?.parentElement ?? null;
    if (node.parentNode !== this.form || node.nextSibling !== relation) {
      this.form.insertBefore(node, relation);
    }
  }

  private syncActions(next: TimelineCaptureProps): void {
    this.cancel.update({
      block: '',
      label: 'ยกเลิก · Esc',
      disabled: next.saving,
      onClick: () => next.onCancel(),
    });
    this.submit.update({
      block: '',
      modifier: 'acp-timeline__save',
      type: 'submit',
      label: next.suggestion ? 'ยืนยัน · Cmd/Ctrl+Enter' : 'บันทึก · Cmd/Ctrl+Enter',
      disabled: next.saving,
    });
    const children: HTMLElement[] = [this.cancel.el];
    if (next.suggestion && next.canDismiss) {
      this.dismiss.update({
        block: '',
        modifier: 'acp-timeline__dismiss',
        label: 'ไม่รับข้อเสนอ · Cmd/Ctrl+D',
        disabled: next.saving,
        onClick: () => next.onDismiss(),
      });
      children.push(this.dismiss.el);
    }
    children.push(this.submit.el);
    this.actions.replaceChildren(...children);
  }

  protected onDispose(): void {
    this.cancel.dispose();
    this.dismiss.dispose();
    this.submit.dispose();
    this.shell.dispose();
  }
}

/** The `data-*` value of the `<button>` a delegated click landed on, if any. */
function buttonData(event: Event, key: string): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const button = target.closest<HTMLElement>('button');
  return button?.dataset[key] ?? null;
}

export const def: ComponentDef = {
  id: 'timeline-capture',
  blocks: ['acp-harness__timeline-overlay', 'acp-timeline'],
};
