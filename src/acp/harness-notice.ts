// Spec 371 — a harness notice: a `system` row raised by one subsystem.
//
// The row draws the source as its label, the action as a flat-ink legend with
// a status LED before it when the tone asks for the human, then the subject.
// `noticeText()` is the one place the portable `item.text` line is built, so
// Live Assist, the orchestrator feed and the control API (which read `text`
// only) keep a whole sentence.

export type NoticeSource =
  | 'inter-lane' | 'triage' | 'xenon' | 'review' | 'usage' | 'lesson' | 'system'
  | 'peer' | 'docs' | 'remote' | 'session' | 'device' | 'model' | 'prompt'
  | 'turn' | 'ask' | 'perm' | 'steer' | 'handoff' | 'shell' | 'write';

/** `info`: no LED. `attention`: amber LED, the human should weigh in. `fault`: fault LED, it failed. */
export type NoticeTone = 'info' | 'attention' | 'fault';

export interface HarnessNotice {
  readonly source: NoticeSource;
  /** Short verb phrase drawn as the legend; omitted when the subject says it all. */
  readonly action?: string;
  readonly tone: NoticeTone;
  readonly subject: string;
}

/** The row label for each source. Inter-lane notices keep their `event` label (spec 302 §3.14). */
export const NOTICE_LABEL: Readonly<Record<NoticeSource, string>> = {
  'inter-lane': 'event',
  triage: 'triage',
  xenon: 'xenon',
  review: 'review',
  usage: 'usage',
  lesson: 'lesson',
  system: 'system',
  peer: 'peer',
  docs: 'docs',
  remote: 'remote',
  session: 'session',
  device: 'device',
  model: 'model',
  prompt: 'prompt',
  turn: 'turn',
  ask: 'ask',
  perm: 'perm',
  steer: 'steer',
  handoff: 'handoff',
  shell: 'shell',
  write: 'write',
};

/** `[source] action: subject`, or `[source] subject` when there is no action. */
export function noticeText(notice: HarnessNotice): string {
  const action = notice.action ? `${notice.action}: ` : '';
  return `[${notice.source}] ${action}${notice.subject}`;
}
