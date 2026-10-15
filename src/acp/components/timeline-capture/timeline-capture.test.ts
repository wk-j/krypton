import { afterEach, describe, expect, it, vi } from 'vitest';

import { TimelineCapture, type TimelineCaptureProps } from './index';

const forms: TimelineCapture[] = [];

const props = (over: Partial<TimelineCaptureProps> = {}): TimelineCaptureProps => ({
  open: true,
  suggestion: false,
  values: {
    topic: '',
    summary: '',
    madeBy: '',
    occurredAt: '2026-10-15T09:00',
    sourceRef: '',
    rationale: '',
    impact: '',
  },
  relation: '',
  relatedEvent: '',
  topicOptions: ['ย้าย harness UI เป็น component'],
  relations: [{ value: 'supersedes', label: 'แทนที่' }],
  relatedEvents: [{ value: 'ev-1', label: '2026-10-01 · หัวข้อ · สรุป' }],
  topicMatches: [],
  semantic: null,
  duplicateWarning: null,
  duplicateChecked: false,
  evidence: null,
  error: '',
  saving: false,
  canDismiss: false,
  onEdit: () => undefined,
  onChoose: () => undefined,
  onPickTopic: () => undefined,
  onSemanticDecision: () => undefined,
  onDuplicateToggle: () => undefined,
  onSubmit: () => undefined,
  onCancel: () => undefined,
  onDismiss: () => undefined,
  ...over,
});

const mount = (over: Partial<TimelineCaptureProps> = {}): TimelineCapture => {
  const form = new TimelineCapture();
  forms.push(form);
  form.update(props(over));
  return form;
};

afterEach(() => {
  for (const form of forms.splice(0)) form.dispose();
});

describe('TimelineCapture', () => {
  it('emits the Thai head, every field label in order and the action row', () => {
    const form = mount();
    expect(form.el.className).toBe('acp-harness__timeline-overlay');
    expect(form.el.querySelector('.acp-timeline__title')?.textContent)
      .toBe('บันทึกเหตุการณ์ใน Timeline');
    expect(form.el.querySelector('.acp-timeline__sub')?.textContent)
      .toBe('.krypton/timeline เก็บไว้เฉพาะเครื่องนี้ Git ไม่ติดตามไฟล์');
    expect([...form.el.querySelectorAll('.acp-timeline__field > span')].map((s) => s.textContent))
      .toEqual([
        'หัวข้อ',
        'สรุป',
        'ผู้ขอหรือผู้อนุมัติ',
        'เกิดขึ้นเมื่อ',
        'แหล่งอ้างอิง',
        'ความสัมพันธ์',
        'เหตุการณ์ที่เกี่ยวข้อง',
        'เหตุผล',
        'ผลกระทบ',
      ]);
    expect([...form.el.querySelectorAll('.acp-timeline__actions button')].map((b) => b.textContent))
      .toEqual(['ยกเลิก · Esc', 'บันทึก · Cmd/Ctrl+Enter']);
    expect(form.el.querySelector('.acp-timeline__actions .acp-timeline__save')?.getAttribute('type'))
      .toBe('submit');
  });

  it('switches to the suggestion wording and offers the dismiss button', () => {
    const form = mount({ suggestion: true, canDismiss: true, evidence: { lane: 'codex-1', excerpt: 'จาก transcript' } });
    expect(form.el.querySelector('.acp-timeline__title')?.textContent)
      .toBe('ตรวจทานข้อเสนอ Timeline');
    expect([...form.el.querySelectorAll('.acp-timeline__actions button')].map((b) => b.textContent))
      .toEqual(['ยกเลิก · Esc', 'ไม่รับข้อเสนอ · Cmd/Ctrl+D', 'ยืนยัน · Cmd/Ctrl+Enter']);
    expect(form.el.querySelector('.acp-timeline__evidence h3')?.textContent).toBe('หลักฐาน · codex-1');
    expect(form.el.querySelector('.acp-timeline__evidence p')?.textContent).toBe('จาก transcript');
  });

  it('writes the values into the fields and reports an edit back', () => {
    const onEdit = vi.fn();
    const form = mount({ onEdit });
    const topic = form.el.querySelector<HTMLInputElement>('input[name="topic"]');
    expect(topic?.value).toBe('');
    expect(topic?.getAttribute('list')).toBe('timeline-topics');
    expect([...form.el.querySelectorAll('datalist option')].map((o) => o.getAttribute('value')))
      .toEqual(['ย้าย harness UI เป็น component']);
    if (topic) {
      topic.value = 'ย้าย harness';
      topic.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(onEdit).toHaveBeenCalledWith('topic', 'ย้าย harness');
  });

  it('leaves a field alone when the prop already matches what it holds', () => {
    const form = mount();
    const summary = form.el.querySelector<HTMLTextAreaElement | HTMLInputElement>('[name="summary"]');
    if (summary) summary.value = 'เขียนไปครึ่งทาง';
    form.update(props({ values: { ...props().values, summary: 'เขียนไปครึ่งทาง' } }));
    expect(summary?.value).toBe('เขียนไปครึ่งทาง');
  });

  it('fills both selects with a leading ไม่มี and reports a choice', () => {
    const onChoose = vi.fn();
    const form = mount({ onChoose });
    const relation = form.el.querySelector<HTMLSelectElement>('select[name="relation"]');
    expect([...(relation?.options ?? [])].map((o) => o.textContent)).toEqual(['ไม่มี', 'แทนที่']);
    if (relation) {
      relation.value = 'supersedes';
      relation.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(onChoose).toHaveBeenCalledWith('relation', 'supersedes');
  });

  it('renders topic match buttons and reports the pick through one delegated listener', () => {
    const onPickTopic = vi.fn();
    const form = mount({
      topicMatches: [{ value: 'topic-1', label: 'หัวข้อ · สรุป' }],
      onPickTopic,
    });
    const button = form.el.querySelector<HTMLButtonElement>('.acp-timeline__topic-matches button');
    expect(button?.textContent).toBe('หัวข้อ · สรุป');
    button?.click();
    expect(onPickTopic).toHaveBeenCalledWith('topic-1');
  });

  it('shows the semantic match with its confidence and marks the chosen button', () => {
    const onSemanticDecision = vi.fn();
    const form = mount({
      semantic: { title: 'ย้าย harness UI', confidence: 0.87, decision: 'existing' },
      onSemanticDecision,
    });
    const box = form.el.querySelector<HTMLElement>('.acp-timeline__semantic-match');
    expect(box?.hidden).toBe(false);
    expect(box?.querySelector('p')?.textContent)
      .toBe('หัวข้อที่น่าจะตรง · ย้าย harness UI · confidence 87%');
    const buttons = [...(box?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    expect(buttons.map((b) => b.dataset.selected)).toEqual(['true', 'false']);
    buttons[1].click();
    expect(onSemanticDecision).toHaveBeenCalledWith('new');
  });

  it('hides the duplicate box until a near-duplicate exists', () => {
    const onDuplicateToggle = vi.fn();
    const form = mount({ onDuplicateToggle });
    const box = form.el.querySelector<HTMLElement>('.acp-timeline__duplicate');
    expect(box?.hidden).toBe(true);
    form.update(props({
      duplicateWarning: 'สร้างหัวข้อใหม่แม้มีหัวข้อใกล้เคียง: ย้าย harness UI',
      onDuplicateToggle,
    }));
    expect(box?.hidden).toBe(false);
    expect(box?.querySelector('[data-timeline-duplicate-text]')?.textContent)
      .toBe('สร้างหัวข้อใหม่แม้มีหัวข้อใกล้เคียง: ย้าย harness UI');
    const checkbox = box?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(onDuplicateToggle).toHaveBeenCalledWith(true);
  });

  it('submits through the form and disables the buttons while saving', () => {
    const onSubmit = vi.fn();
    const form = mount({ onSubmit });
    form.el.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    form.update(props({ saving: true, onSubmit }));
    expect([...form.el.querySelectorAll<HTMLButtonElement>('.acp-timeline__actions button')]
      .map((b) => b.disabled)).toEqual([true, true]);
  });

  it('shows the error line and clears it again', () => {
    const form = mount({ error: 'หัวข้อห้ามว่าง' });
    expect(form.el.querySelector('.acp-timeline__error')?.textContent).toBe('หัวข้อห้ามว่าง');
    form.update(props());
    expect(form.el.querySelector('.acp-timeline__error')?.textContent).toBe('');
  });

  it('drops every listener on dispose', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const form = mount({ onSubmit, onCancel });
    const cancel = form.el.querySelector<HTMLButtonElement>('.acp-timeline__actions button');
    const node = form.el.querySelector('form');
    form.dispose();
    cancel?.click();
    node?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('writes nothing when the dependency tuple holds', () => {
    const values = props().values;
    const form = mount({ values });
    const observer = new MutationObserver(() => undefined);
    observer.observe(form.el, { childList: true, subtree: true, attributes: true, characterData: true });
    form.update(props({ values }));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
