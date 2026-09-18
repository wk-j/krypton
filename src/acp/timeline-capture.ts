import {
  TIMELINE_RELATIONS,
  findExistingTopic,
  latestTimelineTopics,
  similarTimelineTopics,
  topicMatchScore,
  uniqueTopicIdForTitle,
  validateTimelineRecord,
  type TimelineEvent,
  type TimelineRecordRequest,
  type TimelineSuggestion,
} from './timeline';

export interface TimelineCaptureOptions {
  mount: HTMLElement;
  events: TimelineEvent[];
  recorderLane: string;
  initialTopic?: string;
  suggestion?: TimelineSuggestion;
  save: (request: TimelineRecordRequest) => Promise<TimelineEvent>;
  dismiss?: () => Promise<void>;
  close: () => void;
  saved: (event: TimelineEvent) => void;
  dismissed?: () => void;
}

function field<T extends HTMLElement>(form: HTMLFormElement, name: string): T {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLElement)) throw new Error(`missing timeline field ${name}`);
  return element as T;
}

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function appendTextOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

export class TimelineCapture {
  readonly element: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly options: TimelineCaptureOptions;
  private readonly topicInput: HTMLInputElement;
  private readonly duplicateBox: HTMLElement;
  private readonly duplicateConfirm: HTMLInputElement;
  private readonly errorEl: HTMLElement;
  private readonly topicMatches: HTMLElement;
  private selectedTopicId: string | null = null;
  private saving = false;

  constructor(options: TimelineCaptureOptions) {
    this.options = options;
    this.element = document.createElement('aside');
    this.element.className = 'acp-harness__timeline-overlay';

    const panel = document.createElement('section');
    panel.className = 'acp-timeline__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'timeline-capture-title');

    const title = document.createElement('h2');
    title.id = 'timeline-capture-title';
    title.textContent = options.suggestion ? 'Review timeline suggestion' : 'Record timeline event';
    const subtitle = document.createElement('p');
    subtitle.className = 'acp-timeline__subtitle';
    subtitle.textContent = 'Saves locally under .krypton/timeline — not tracked by Git';
    panel.append(title, subtitle);

    this.form = document.createElement('form');
    this.form.className = 'acp-timeline__form';
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });

    const topicList = document.createElement('datalist');
    topicList.id = `timeline-topics-${Date.now()}`;
    const seenTopics = new Set<string>();
    for (const event of [...options.events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))) {
      if (seenTopics.has(event.topicId)) continue;
      seenTopics.add(event.topicId);
      const option = document.createElement('option');
      option.value = event.topicTitle;
      topicList.appendChild(option);
    }
    this.topicInput = this.addInput('topic', 'Topic', 'text');
    this.topicInput.setAttribute('list', topicList.id);
    this.topicInput.maxLength = 120;
    this.topicInput.value = options.suggestion?.topicTitle ?? options.initialTopic ?? '';
    this.topicInput.addEventListener('input', () => {
      this.selectedTopicId = null;
      this.refreshDuplicateWarning();
    });
    this.form.appendChild(topicList);

    this.topicMatches = document.createElement('div');
    this.topicMatches.className = 'acp-timeline__topic-matches';
    this.form.appendChild(this.topicMatches);

    this.duplicateBox = document.createElement('label');
    this.duplicateBox.className = 'acp-timeline__duplicate';
    this.duplicateBox.hidden = true;
    this.duplicateConfirm = document.createElement('input');
    this.duplicateConfirm.type = 'checkbox';
    const duplicateText = document.createElement('span');
    duplicateText.dataset.timelineDuplicateText = '';
    this.duplicateBox.append(this.duplicateConfirm, duplicateText);
    this.form.appendChild(this.duplicateBox);

    const summary = this.addInput('summary', 'Summary', 'text');
    summary.maxLength = 500;
    summary.value = options.suggestion?.summary ?? '';
    const madeBy = this.addInput('madeBy', 'Made by', 'text');
    madeBy.maxLength = 120;
    madeBy.placeholder = 'Who requested or approved this?';
    madeBy.value = options.suggestion?.madeBy ?? '';
    const occurredAt = this.addInput('occurredAt', 'Occurred at', 'datetime-local');
    occurredAt.value = localDateTimeValue(
      options.suggestion ? new Date(options.suggestion.occurredAt) : new Date(),
    );
    const sourceRef = this.addInput('sourceRef', 'Source reference', 'text');
    sourceRef.maxLength = 2048;
    sourceRef.placeholder = 'URL, commit, or project-relative document';
    sourceRef.value = options.suggestion?.sourceRef ?? '';

    if (options.suggestion) {
      const evidence = document.createElement('section');
      evidence.className = 'acp-timeline__evidence';
      const evidenceTitle = document.createElement('h3');
      evidenceTitle.textContent = `Evidence · ${options.suggestion.suggestedByLane}`;
      const evidenceText = document.createElement('p');
      evidenceText.textContent = options.suggestion.evidenceExcerpt;
      evidence.append(evidenceTitle, evidenceText);
      this.form.appendChild(evidence);
    }

    const relation = this.addSelect('relation', 'Relation');
    appendTextOption(relation, '', 'none');
    for (const value of TIMELINE_RELATIONS) appendTextOption(relation, value, value.replace('_', ' '));
    const relatedEvent = this.addSelect('relatedEvent', 'Related event');
    appendTextOption(relatedEvent, '', 'none');
    for (const event of [...options.events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))) {
      appendTextOption(relatedEvent, event.id, `${event.occurredAt.slice(0, 10)} · ${event.topicTitle} · ${event.summary}`);
    }
    relatedEvent.addEventListener('change', () => {
      const selected = options.events.find((event) => event.id === relatedEvent.value);
      if (selected) {
        const latestTopic = latestTimelineTopics(options.events).find((topic) => topic.id === selected.topicId);
        this.selectedTopicId = selected.topicId;
        this.topicInput.value = latestTopic?.title ?? selected.topicTitle;
        this.refreshDuplicateWarning();
      }
    });

    const rationale = this.addTextarea('rationale', 'Rationale', 4096);
    rationale.value = options.suggestion?.rationale ?? '';
    const impact = this.addTextarea('impact', 'Impact', 4096);
    impact.value = options.suggestion?.impact ?? '';

    this.errorEl = document.createElement('p');
    this.errorEl.className = 'acp-timeline__error';
    this.errorEl.setAttribute('role', 'alert');
    this.form.appendChild(this.errorEl);

    const actions = document.createElement('footer');
    actions.className = 'acp-timeline__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel · Esc';
    cancel.addEventListener('click', () => options.close());
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'acp-timeline__save';
    submit.textContent = options.suggestion ? 'Confirm · Cmd/Ctrl+Enter' : 'Save · Cmd/Ctrl+Enter';
    actions.appendChild(cancel);
    if (options.suggestion && options.dismiss) {
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'acp-timeline__dismiss';
      dismiss.textContent = 'Dismiss · Cmd/Ctrl+D';
      dismiss.addEventListener('click', () => void this.dismiss());
      actions.appendChild(dismiss);
    }
    actions.appendChild(submit);
    this.form.appendChild(actions);
    panel.appendChild(this.form);
    this.element.appendChild(panel);
    options.mount.appendChild(this.element);
    this.refreshDuplicateWarning();
    this.topicInput.focus();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!this.saving) this.options.close();
      return true;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void this.submit();
      return true;
    }
    if (event.key.toLowerCase() === 'd' && (event.metaKey || event.ctrlKey) && this.options.dismiss) {
      event.preventDefault();
      void this.dismiss();
      return true;
    }
    return false;
  }

  dispose(): void {
    this.element.remove();
  }

  private addLabel(name: string, labelText: string): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'acp-timeline__field';
    const text = document.createElement('span');
    text.textContent = labelText;
    label.appendChild(text);
    this.form.appendChild(label);
    return label;
  }

  private addInput(name: string, labelText: string, type: string): HTMLInputElement {
    const label = this.addLabel(name, labelText);
    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    label.appendChild(input);
    return input;
  }

  private addSelect(name: string, labelText: string): HTMLSelectElement {
    const label = this.addLabel(name, labelText);
    const select = document.createElement('select');
    select.name = name;
    label.appendChild(select);
    return select;
  }

  private addTextarea(name: string, labelText: string, maxLength: number): HTMLTextAreaElement {
    const label = this.addLabel(name, labelText);
    const textarea = document.createElement('textarea');
    textarea.name = name;
    textarea.maxLength = maxLength;
    textarea.rows = 3;
    label.appendChild(textarea);
    return textarea;
  }

  private refreshDuplicateWarning(): void {
    const exact = findExistingTopic(this.topicInput.value, this.options.events);
    const similar = exact ? [] : similarTimelineTopics(this.topicInput.value, this.options.events);
    this.duplicateBox.hidden = similar.length === 0;
    this.duplicateConfirm.checked = false;
    const text = this.duplicateBox.querySelector<HTMLElement>('[data-timeline-duplicate-text]');
    if (text) text.textContent = `Create a new topic despite similar topic: ${similar.map((topic) => topic.title).join(', ')}`;
    this.refreshTopicMatches();
  }

  private refreshTopicMatches(): void {
    const query = this.topicInput.value.trim();
    this.topicMatches.replaceChildren();
    if (!query) return;
    const byTopic = new Map<string, { event: TimelineEvent; score: number }>();
    for (const event of this.options.events) {
      const score = topicMatchScore(query, event);
      if (score === 0) continue;
      const current = byTopic.get(event.topicId);
      if (!current || score > current.score || (score === current.score && event.occurredAt > current.event.occurredAt)) {
        byTopic.set(event.topicId, { event, score });
      }
    }
    const latest = new Map(latestTimelineTopics(this.options.events).map((topic) => [topic.id, topic]));
    [...byTopic.values()]
      .sort((left, right) => right.score - left.score || right.event.occurredAt.localeCompare(left.event.occurredAt))
      .slice(0, 5)
      .forEach(({ event }) => {
        const topic = latest.get(event.topicId);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${topic?.title ?? event.topicTitle} · ${event.summary}`;
        button.addEventListener('click', () => {
          this.selectedTopicId = event.topicId;
          this.topicInput.value = topic?.title ?? event.topicTitle;
          this.refreshDuplicateWarning();
          this.topicInput.focus();
        });
        this.topicMatches.appendChild(button);
      });
  }

  private request(): TimelineRecordRequest {
    const topicTitle = this.topicInput.value.trim();
    const relatedId = field<HTMLSelectElement>(this.form, 'relatedEvent').value;
    const related = this.options.events.find((event) => event.id === relatedId);
    const exact = findExistingTopic(topicTitle, this.options.events);
    const occurredValue = field<HTMLInputElement>(this.form, 'occurredAt').value;
    const sourceRef = field<HTMLInputElement>(this.form, 'sourceRef').value.trim();
    const relationValue = field<HTMLSelectElement>(this.form, 'relation').value;
    return {
      topicId: related?.topicId ?? this.selectedTopicId ?? exact?.id ?? uniqueTopicIdForTitle(topicTitle, this.options.events),
      topicTitle,
      summary: field<HTMLInputElement>(this.form, 'summary').value.trim(),
      occurredAt: occurredValue ? new Date(occurredValue).toISOString() : '',
      madeBy: field<HTMLInputElement>(this.form, 'madeBy').value.trim(),
      rationale: field<HTMLTextAreaElement>(this.form, 'rationale').value.trim(),
      impact: field<HTMLTextAreaElement>(this.form, 'impact').value.trim(),
      sourceRef: sourceRef || undefined,
      relation: relationValue ? relationValue as TimelineRecordRequest['relation'] : undefined,
      relatedEvent: relatedId || undefined,
      recorderLane: this.options.recorderLane,
    };
  }

  private async submit(): Promise<void> {
    if (this.saving) return;
    let request: TimelineRecordRequest;
    try {
      request = this.request();
    } catch {
      this.errorEl.textContent = 'occurred at must be a valid date';
      return;
    }
    const error = validateTimelineRecord(request);
    if (error) {
      this.errorEl.textContent = error;
      return;
    }
    if (!this.duplicateBox.hidden && !this.duplicateConfirm.checked) {
      this.errorEl.textContent = 'confirm the similar topic before creating a new one';
      return;
    }
    this.saving = true;
    this.errorEl.textContent = '';
    this.setDisabled(true);
    try {
      const saved = await this.options.save(request);
      this.options.saved(saved);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.errorEl.textContent = message;
      this.saving = false;
      this.setDisabled(false);
    }
  }

  private async dismiss(): Promise<void> {
    if (this.saving || !this.options.dismiss) return;
    this.saving = true;
    this.errorEl.textContent = '';
    this.setDisabled(true);
    try {
      await this.options.dismiss();
      this.options.dismissed?.();
    } catch (cause) {
      this.errorEl.textContent = cause instanceof Error ? cause.message : String(cause);
      this.saving = false;
      this.setDisabled(false);
    }
  }

  private setDisabled(disabled: boolean): void {
    for (const control of Array.from(this.form.elements)) {
      if ('disabled' in control) (control as HTMLInputElement).disabled = disabled;
    }
  }
}
