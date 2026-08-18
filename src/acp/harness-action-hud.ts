// Krypton — ACP Harness live-action HUD (spec 231).
//
// Pure mapping + markup for the rail action card. The view owns the slot and
// the 1 s tick; this module never touches AcpHarnessView. Peek reuses the same
// markup so a busy peeked lane speaks the same instrument language.

import type { ToolCall, ToolCallUpdate } from './types';
import type { LaneActivity } from './harness-view-types';
import { esc } from './harness-format';
import { actionHudIcon } from './harness-icons';
import { cleanToolTitle, inferToolLabel } from './harness-tool-render';

export type ActionHudKind =
  | 'edit'
  | 'read'
  | 'search'
  | 'execute'
  | 'delete'
  | 'move'
  | 'fetch'
  | 'thinking'
  | 'writing'
  | 'other';

export type ActionHudOwner = 'rail' | 'peek';

export interface LiveAction {
  kind: ActionHudKind;
  title: string;
  subject: string | null;
  /** Untruncated path (or title) for the tooltip. */
  detail: string | null;
  sig: string;
}

export interface LiveActionSource {
  activity: LaneActivity | null;
  toolCalls: Iterable<ToolCall | ToolCallUpdate> | Map<string, ToolCall | ToolCallUpdate>;
}

const KIND_WORDS: Record<string, ActionHudKind> = {
  edit: 'edit',
  write: 'edit',
  create: 'edit',
  modify: 'edit',
  patch: 'edit',
  read: 'read',
  open: 'read',
  cat: 'read',
  search: 'search',
  grep: 'search',
  rg: 'search',
  find: 'search',
  execute: 'execute',
  bash: 'execute',
  shell: 'execute',
  run: 'execute',
  exec: 'execute',
  command: 'execute',
  delete: 'delete',
  move: 'move',
  rename: 'move',
  fetch: 'fetch',
  http: 'fetch',
  web: 'fetch',
  think: 'thinking',
  thinking: 'thinking',
  writing: 'writing',
};

const LEADING_VERB = new RegExp(
  `^(${Object.keys(KIND_WORDS).join('|')})\\s+`,
  'i',
);

/** Tail-2 path for the subject line. Avoids `abbreviatePath` so unit tests do
 *  not need a `location` global (that helper reads `location.pathname`). */
function hudPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

export function actionHudKindFromLabel(label: string): ActionHudKind {
  const trimmed = label.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!trimmed) return 'other';
  const exact = KIND_WORDS[trimmed];
  if (exact) return exact;
  const head = trimmed.split(/[\s:/]/)[0] ?? '';
  return KIND_WORDS[head] ?? 'other';
}

export function liveActionSig(kind: ActionHudKind, title: string, subject: string | null): string {
  return `${kind}|${title}|${subject ?? ''}`;
}

export function makeLiveAction(
  kind: ActionHudKind,
  title: string,
  subject: string | null,
  detail: string | null = subject,
): LiveAction {
  return { kind, title, subject, detail, sig: liveActionSig(kind, title, subject) };
}

function iterateToolCalls(
  tools: LiveActionSource['toolCalls'],
): Iterable<ToolCall | ToolCallUpdate> {
  return tools instanceof Map ? tools.values() : tools;
}

function subjectFromTitle(title: string): string | null {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const stripped = cleaned.replace(LEADING_VERB, '').trim();
  if (!stripped || stripped === cleaned) return null;
  return hudPath(stripped);
}

export function liveActionFromToolCall(call: ToolCall | ToolCallUpdate): LiveAction {
  const label = inferToolLabel(call);
  const kind = actionHudKindFromLabel(label);
  const rawTitle = cleanToolTitle(call.title, 'tool');
  const title = kind === 'other' ? (rawTitle || label || 'tool') : kind;
  const loc = call.locations?.[0]?.path ?? null;
  const subject = loc ? hudPath(loc) : subjectFromTitle(call.title ?? '');
  const detail = loc ?? (subject ? (call.title ?? subject) : title);
  return makeLiveAction(kind, title, subject, detail);
}

export function liveActionFromToolLabel(label: string): LiveAction {
  const kind = actionHudKindFromLabel(label);
  const title = kind === 'other' ? label.replace(/\s+/g, ' ').trim() || 'tool' : kind;
  const subject = subjectFromTitle(label);
  return makeLiveAction(kind, title, subject, label);
}

export function liveActionFromPeekTool(tool: { name: string; subject: string | null }): LiveAction {
  const kind = actionHudKindFromLabel(tool.name);
  const title = kind === 'other' ? tool.name : kind;
  const subject = tool.subject ? hudPath(tool.subject) : null;
  const detail = tool.subject ?? title;
  return makeLiveAction(kind, title, subject, detail);
}

export function deriveLiveAction(lane: LiveActionSource): LiveAction | null {
  const act = lane.activity;
  if (act?.kind === 'thinking') return makeLiveAction('thinking', 'thinking', null, 'thinking');
  if (act?.kind === 'writing') return makeLiveAction('writing', 'writing', null, 'writing');
  for (const call of iterateToolCalls(lane.toolCalls)) {
    if (call.status !== 'in_progress' && call.status !== 'pending') continue;
    return liveActionFromToolCall(call);
  }
  if (act?.kind === 'tool' && act.label.trim()) return liveActionFromToolLabel(act.label);
  return null;
}

export function shouldOmitActionHud(
  action: LiveAction | null,
  opts: { activeLaneId: string; thoughtLaneId: string | null; thoughtLive: boolean },
): boolean {
  if (!action) return true;
  if (action.kind !== 'thinking') return false;
  return opts.thoughtLive && opts.thoughtLaneId === opts.activeLaneId;
}

function wellFx(kind: ActionHudKind): string {
  switch (kind) {
    case 'edit':
      return '<i class="acp-harness__action-fx-trail"></i><i class="acp-harness__action-fx-head"></i>';
    case 'read':
      return '<i class="acp-harness__action-fx-scan"></i>';
    case 'search':
      return '<i class="acp-harness__action-fx-ping"></i>';
    case 'execute':
      return (
        '<span class="acp-harness__action-hex" aria-hidden="true">' +
        '<b>A7</b><b>3C</b><b>F1</b><b>09</b><b>BE</b><b>64</b>' +
        '</span>'
      );
    case 'move':
      return '<i class="acp-harness__action-fx-chev"></i>';
    case 'fetch':
      return '<i class="acp-harness__action-fx-pkt"></i>';
    case 'thinking':
      return (
        '<i class="acp-harness__action-fx-bar"></i>' +
        '<i class="acp-harness__action-fx-bar"></i>' +
        '<i class="acp-harness__action-fx-bar"></i>'
      );
    case 'writing':
      return '<i class="acp-harness__action-fx-us"></i><i class="acp-harness__action-fx-caret"></i>';
    default:
      return '';
  }
}

export function actionHudMarkup(action: LiveAction, owner: ActionHudOwner = 'rail'): string {
  const tip = action.detail ?? action.subject ?? action.title;
  const subject = action.subject
    ? `<div class="acp-harness__action-subject">${esc(action.subject)}</div>`
    : '';
  return (
    `<div class="acp-harness__action-hud" data-kind="${esc(action.kind)}" data-sig="${esc(action.sig)}" data-owner="${owner}" role="status" aria-live="polite" title="${esc(tip)}">` +
      `<div class="acp-harness__action-well" aria-hidden="true">` +
        actionHudIcon(action.kind) +
        wellFx(action.kind) +
      `</div>` +
      `<div class="acp-harness__action-copy">` +
        `<div class="acp-harness__action-kind">${esc(action.title)}</div>` +
        subject +
      `</div>` +
    `</div>`
  );
}

export function renderActionHud(action: LiveAction, owner: ActionHudOwner = 'rail'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = actionHudMarkup(action, owner);
  const el = wrap.firstElementChild;
  if (!(el instanceof HTMLElement)) {
    throw new Error('action HUD markup produced no element');
  }
  return el;
}

export function patchActionHud(root: HTMLElement, action: LiveAction): void {
  root.dataset.kind = action.kind;
  root.dataset.sig = action.sig;
  root.title = action.detail ?? action.subject ?? action.title;
  const kindEl = root.querySelector('.acp-harness__action-kind');
  if (kindEl) kindEl.textContent = action.title;
  const copy = root.querySelector('.acp-harness__action-copy');
  if (!copy) return;
  let subjectEl = copy.querySelector('.acp-harness__action-subject');
  if (action.subject) {
    if (!subjectEl) {
      subjectEl = document.createElement('div');
      subjectEl.className = 'acp-harness__action-subject';
      copy.appendChild(subjectEl);
    }
    subjectEl.textContent = action.subject;
  } else if (subjectEl) {
    subjectEl.remove();
  }
}
