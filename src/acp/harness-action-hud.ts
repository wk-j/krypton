// Krypton — ACP Harness live-action HUD (spec 231).
//
// Pure mapping + markup for the rail action card. The view owns the slot and
// the 1 s tick; this module never touches AcpHarnessView. Peek reuses the same
// markup so a busy peeked lane speaks the same instrument language.

import type { ToolCall, ToolCallUpdate } from './types';
import type { LaneActivity } from './harness-view-types';
import { esc } from './harness-format';
import { actionHudIcon } from './harness-icons';
import {
  cleanToolTitle,
  extractCommandLineRaw,
  inferToolLabel,
  looksLikeShellCommand,
} from './harness-tool-render';

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

/** Empty live-action frames keep the last HUD this long so thinking/writing
 *  interleave does not hide+remount the card (entrance flicker). */
export const ACTION_HUD_HIDE_MS = 2000;

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

export interface RailLiveActionLane extends LiveActionSource {
  id: string;
  displayName: string;
  active: boolean;
  /** Spec 231 rev 2: false once the lane's turn has ended (status is not
   *  busy / needs_permission). A tool call the adapter never closed — a
   *  background terminal that keeps running after the turn, for instance —
   *  stays `in_progress` in `toolCalls` forever and used to pin its card on
   *  the rail indefinitely. Lane status is authoritative: a lane that is not
   *  live has no live action, whatever its tool map says. */
  live?: boolean;
}

export interface RailLiveAction {
  laneId: string;
  displayName: string;
  action: LiveAction;
  active: boolean;
}

export interface DeriveRailLiveActionsInput {
  lanes: RailLiveActionLane[];
  thoughtLaneId: string | null;
  thoughtLive: boolean;
  /** Peeked lane already painting the same HUD inside the 109 card. */
  peekHudLaneId: string | null;
}

export type ActionHudPaint = ActionHudOwner | {
  owner?: ActionHudOwner;
  laneId?: string;
  laneName?: string | null;
};

function normalizePaint(paint: ActionHudPaint): {
  owner: ActionHudOwner;
  laneId: string;
  laneName: string | null;
} {
  if (typeof paint === 'string') return { owner: paint, laneId: '', laneName: null };
  return {
    owner: paint.owner ?? 'rail',
    laneId: paint.laneId ?? '',
    laneName: paint.laneName ?? null,
  };
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

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Head/…/basename so the filename survives CSS ellipsis. Avoids
 *  `abbreviatePath` (that helper reads `location.pathname`). Last-2 kept a
 *  40-char ticket folder as the visible prefix and let the basename clip. */
function hudPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return path;
  if ((parts[0] === 'Users' || parts[0] === 'home') && parts.length > 4) {
    parts.splice(0, 2);
  }
  if (parts.length <= 3) return parts.join('/');
  return `${parts[0]}/…/${parts[parts.length - 1]}`;
}

/** Command / sentence for the subject. Never run `hudPath` on a shell line —
 *  slashes inside `cd /tmp; rg foo` would crop to a nonsense tail. */
function hudSubject(text: string): string | null {
  const line = oneLine(text);
  if (!line) return null;
  if (!/[\s;|&]/.test(line) && line.includes('/')) return hudPath(line);
  return line;
}

function shortOtherTitle(raw: string): string {
  const line = oneLine(raw);
  if (!line || line.toLowerCase() === 'tool') return 'tool';
  if (line.length <= 28 && !/\s/.test(line)) return line;
  return line.split(/[\s:/]/)[0]?.slice(0, 28) || 'tool';
}

function isGenericExecuteTitle(text: string): boolean {
  const lower = oneLine(text).toLowerCase();
  return !lower || lower === 'tool' || KIND_WORDS[lower] === 'execute';
}

export function actionHudKindFromLabel(label: string): ActionHudKind {
  const trimmed = oneLine(label).toLowerCase();
  if (!trimmed) return 'other';
  const exact = KIND_WORDS[trimmed];
  if (exact) return exact;
  const head = trimmed.split(/[\s:/]/)[0] ?? '';
  if (KIND_WORDS[head]) return KIND_WORDS[head];
  if (looksLikeShellCommand(trimmed)) return 'execute';
  return 'other';
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
  const cleaned = oneLine(title);
  if (!cleaned) return null;
  const stripped = cleaned.replace(LEADING_VERB, '').trim();
  if (!stripped) return null;
  if (stripped === cleaned && KIND_WORDS[cleaned.toLowerCase()]) return null;
  return hudSubject(stripped);
}

export function liveActionFromToolCall(call: ToolCall | ToolCallUpdate): LiveAction {
  const label = inferToolLabel(call);
  let kind = actionHudKindFromLabel(label);
  const command = extractCommandLineRaw(call.rawInput) || null;
  if (command) kind = 'execute';
  else if (kind === 'other' && looksLikeShellCommand(call.title ?? '')) kind = 'execute';
  const rawTitle = cleanToolTitle(call.title, 'tool');
  const loc = call.locations?.[0]?.path ?? null;
  const title = kind === 'other' ? shortOtherTitle(rawTitle || label) : kind;
  let subject: string | null = null;
  if (loc) subject = hudPath(loc);
  else if (command) subject = hudSubject(command);
  else if (kind === 'execute' && rawTitle && !isGenericExecuteTitle(rawTitle)) subject = hudSubject(rawTitle);
  else if (kind === 'other') {
    const leftover = oneLine(rawTitle);
    subject = leftover && leftover !== title ? leftover : null;
  } else {
    subject = subjectFromTitle(call.title ?? '');
  }
  const detail = loc ?? command ?? rawTitle ?? title;
  return makeLiveAction(kind, title, subject, oneLine(detail));
}

export function liveActionFromToolLabel(label: string): LiveAction {
  const kind = actionHudKindFromLabel(label);
  const cleaned = oneLine(label);
  const title = kind === 'other' ? shortOtherTitle(cleaned) : kind;
  let subject: string | null = null;
  if (kind === 'execute' && cleaned && !isGenericExecuteTitle(cleaned)) subject = hudSubject(cleaned);
  else if (kind === 'other') subject = cleaned && cleaned !== title ? cleaned : null;
  else subject = subjectFromTitle(cleaned);
  return makeLiveAction(kind, title, subject, cleaned || title);
}

export function liveActionFromPeekTool(tool: { name: string; subject: string | null }): LiveAction {
  const kind = actionHudKindFromLabel(tool.name);
  const title = kind === 'other' ? tool.name : kind;
  const subject = tool.subject ? hudPath(tool.subject) : null;
  const detail = tool.subject ?? title;
  return makeLiveAction(kind, title, subject, detail);
}

export function deriveLiveAction(lane: LiveActionSource): LiveAction | null {
  // In-flight tools win thinking/writing. Claude interleaves empty thought
  // chunks with Read/Bash; preferring thinking swapped the well and restarted
  // the scan on every gap.
  for (const call of iterateToolCalls(lane.toolCalls)) {
    if (call.status !== 'in_progress' && call.status !== 'pending') continue;
    return liveActionFromToolCall(call);
  }
  const act = lane.activity;
  if (act?.kind === 'thinking') return makeLiveAction('thinking', 'thinking', null, 'thinking');
  if (act?.kind === 'writing') return makeLiveAction('writing', 'writing', null, 'writing');
  if (act?.kind === 'tool' && act.label.trim()) return liveActionFromToolLabel(act.label);
  return null;
}

export function shouldOmitActionHud(
  action: LiveAction | null,
  opts: { laneId: string; thoughtLaneId: string | null; thoughtLive: boolean },
): boolean {
  if (!action) return true;
  if (action.kind !== 'thinking') return false;
  return opts.thoughtLive && opts.thoughtLaneId === opts.laneId;
}

function omitOpts(input: DeriveRailLiveActionsInput, laneId: string): {
  laneId: string;
  thoughtLaneId: string | null;
  thoughtLive: boolean;
} {
  return {
    laneId,
    thoughtLaneId: input.thoughtLaneId,
    thoughtLive: input.thoughtLive,
  };
}

/** True when a lane has a live action that the rail stack will not paint
 *  (thinking omitted because the thought slot already owns that lane). The
 *  hide timer must not fire in this case — the last Read/edit card stays. */
export function hasOmittedRailLiveAction(input: DeriveRailLiveActionsInput): boolean {
  for (const lane of input.lanes) {
    if (lane.live === false) continue;
    if (input.peekHudLaneId && lane.id === input.peekHudLaneId) continue;
    const action = deriveLiveAction(lane);
    if (action && shouldOmitActionHud(action, omitOpts(input, lane.id))) return true;
  }
  return false;
}

/** Every live lane action for the rail stack. Peek-embedded HUD is skipped
 *  so a busy peeked peer is not painted twice. Order follows `lanes`. */
export function deriveRailLiveActions(input: DeriveRailLiveActionsInput): RailLiveAction[] {
  const out: RailLiveAction[] = [];
  for (const lane of input.lanes) {
    // Not live → no card, even with a stale in_progress tool (see RailLiveActionLane.live).
    if (lane.live === false) continue;
    if (input.peekHudLaneId && lane.id === input.peekHudLaneId) continue;
    const action = deriveLiveAction(lane);
    if (shouldOmitActionHud(action, omitOpts(input, lane.id))) continue;
    if (!action) continue;
    out.push({
      laneId: lane.id,
      displayName: lane.displayName,
      action,
      active: lane.active,
    });
  }
  return out;
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
      return '<i class="acp-harness__action-fx-pty"></i>';
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

export function actionHudWellMarkup(kind: ActionHudKind): string {
  return actionHudIcon(kind) + wellFx(kind);
}

export function actionHudMarkup(action: LiveAction, paint: ActionHudPaint = 'rail'): string {
  const { owner, laneId, laneName } = normalizePaint(paint);
  const tip = action.detail ?? action.subject ?? action.title;
  const subject = action.subject
    ? `<div class="acp-harness__action-subject"><span>${esc(action.subject)}</span></div>`
    : '';
  const kind = `<div class="acp-harness__action-kind">${esc(action.title)}</div>`;
  const kindBlock = laneName
    ? `<div class="acp-harness__action-kind-row">${kind}<span class="acp-harness__action-lane">${esc(laneName)}</span></div>`
    : kind;
  const laneAttr = laneId ? ` data-lane-id="${esc(laneId)}"` : '';
  const labeledAttr = laneName ? ' data-labeled="1"' : '';
  return (
    `<div class="acp-harness__action-hud" data-kind="${esc(action.kind)}" data-sig="${esc(action.sig)}" data-owner="${owner}"${laneAttr}${labeledAttr} role="status" aria-live="polite" title="${esc(tip)}">` +
      `<div class="acp-harness__action-well" aria-hidden="true">` +
        actionHudWellMarkup(action.kind) +
      `</div>` +
      `<div class="acp-harness__action-copy">` +
        kindBlock +
        subject +
      `</div>` +
    `</div>`
  );
}

/** Remount only when labeled chrome (the lane-name row) appears or disappears.
 *  Kind and subject updates patch in place so `acp-action-deploy` does not
 *  replay — a new execute/edit must not flicker the card. */
export function actionHudMustRemount(
  el: { dataset: { labeled?: string } },
  labeled: boolean,
): boolean {
  return (el.dataset.labeled ?? '') !== (labeled ? '1' : '');
}

export function renderActionHud(action: LiveAction, paint: ActionHudPaint = 'rail'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = actionHudMarkup(action, paint);
  const el = wrap.firstElementChild;
  if (!(el instanceof HTMLElement)) {
    throw new Error('action HUD markup produced no element');
  }
  return el;
}

export function patchActionHud(root: HTMLElement, action: LiveAction, laneName?: string | null): void {
  const kindChanged = root.dataset.kind !== action.kind;
  root.dataset.kind = action.kind;
  root.dataset.sig = action.sig;
  root.title = action.detail ?? action.subject ?? action.title;
  if (kindChanged) {
    const well = root.querySelector('.acp-harness__action-well');
    if (well) well.innerHTML = actionHudWellMarkup(action.kind);
  }
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
    let span = subjectEl.querySelector('span');
    if (!span) {
      span = document.createElement('span');
      subjectEl.replaceChildren(span);
    }
    span.textContent = action.subject;
  } else if (subjectEl) {
    subjectEl.remove();
  }
  const nameEl = root.querySelector('.acp-harness__action-lane');
  if (nameEl && laneName != null) nameEl.textContent = laneName;
}

/** Reconcile the rail stack by lane id. Same lane → patch (card stays, well
 *  swaps only on kind change). Remount only for labeled-chrome mismatch. */
export function syncActionHudSlot(
  slot: HTMLElement,
  rows: RailLiveAction[],
  labeled: boolean,
): void {
  const keep = new Set(rows.map((row) => row.laneId));
  for (const child of Array.from(slot.children)) {
    if (!(child instanceof HTMLElement) || !keep.has(child.dataset.laneId ?? '')) {
      child.remove();
    }
  }
  const byId = new Map<string, HTMLElement>();
  for (const child of Array.from(slot.children)) {
    if (child instanceof HTMLElement && child.dataset.laneId) {
      byId.set(child.dataset.laneId, child);
    }
  }
  rows.forEach((row, index) => {
    const name = labeled ? row.displayName : null;
    let el = byId.get(row.laneId) ?? null;
    if (el && actionHudMustRemount(el, labeled)) {
      const next = renderActionHud(row.action, { owner: 'rail', laneId: row.laneId, laneName: name });
      el.replaceWith(next);
      el = next;
      byId.set(row.laneId, el);
    } else if (el) {
      patchActionHud(el, row.action, name);
    } else {
      el = renderActionHud(row.action, { owner: 'rail', laneId: row.laneId, laneName: name });
      byId.set(row.laneId, el);
    }
    el.dataset.active = row.active ? '1' : '';
    el.classList.toggle('acp-harness__action-hud--foreign', !row.active);
    const at = slot.children[index] ?? null;
    if (at !== el) slot.insertBefore(el, at);
  });
}
