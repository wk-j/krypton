// Krypton — ACP Harness live voice (spec 280), pure half.
//
// The wire protocol of the Codex realtime voice session ("Frameless Bidi"),
// the transcript and delegation bookkeeping, and the spoken-surface prompt.
// `harness-live-voice-controller.ts` owns the media, IPC and lane wiring.

export type LivePhase = 'connecting' | 'listening' | 'working' | 'speaking' | 'muted' | 'error';
export type LiveRole = 'user' | 'assistant';
export type LiveContextChannel = 'speakable' | 'commentary';

/** Voices the Codex realtime endpoint accepts (OMP `voices.ts`). */
export const LIVE_VOICES: readonly string[] = [
  'arbor', 'breeze', 'cove', 'ember', 'juniper', 'maple', 'sol', 'spruce', 'vale',
];
export const DEFAULT_LIVE_VOICE = 'sol';

/** Maximum UTF-8 bytes per context append. */
export const CONTEXT_CHUNK_BYTES = 500;

export type LiveServerEvent =
  | { type: 'session.started' }
  | { type: 'input_transcript.added'; text: string }
  | { type: 'output_transcript.added'; text: string }
  | { type: 'turn.done'; role: LiveRole; transcript: string }
  | { type: 'delegation.created'; id: string; text: string }
  | { type: 'session.closed'; reason: string | null }
  | { type: 'error'; message: string }
  | { type: 'ignored'; wireType: string };

export type LiveClientMessage =
  | { type: 'delegation.context.append'; delegation_item_id: string; channel?: LiveContextChannel; content: Array<{ type: 'input_text'; text: string }> }
  | { type: 'session.context.append'; channel?: LiveContextChannel; content: Array<{ type: 'input_text'; text: string }> }
  | { type: 'session.close' };

/**
 * Server frame fields the parser reads. JSON from the wire is untrusted, so
 * every field stays `unknown` (or an optional-field object) and is narrowed
 * with `typeof` / `Array.isArray` where it is used.
 */
interface WireFrame {
  type?: unknown;
  item?: { type?: unknown; target?: unknown; id?: unknown; text?: unknown; content?: unknown } | null;
  turn?: { role?: unknown; transcript?: unknown } | null;
  reason?: unknown;
  message?: unknown;
  error?: { message?: unknown } | string | null;
}

/** Parse one server frame. Returns null for malformed or unrecognizable payloads. */
export function parseLiveServerEvent(raw: string): LiveServerEvent | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  // Narrowed to a non-array object above; WireFrame keeps every field unknown.
  const frame = decoded as WireFrame;
  if (typeof frame.type !== 'string') return null;
  switch (frame.type) {
    case 'session.started':
      return { type: 'session.started' };
    case 'input_transcript.added':
    case 'output_transcript.added': {
      const text = frame.item?.text;
      return typeof text === 'string' ? { type: frame.type, text } : null;
    }
    case 'turn.done': {
      const role = frame.turn?.role;
      const transcript = frame.turn?.transcript;
      if ((role !== 'user' && role !== 'assistant') || typeof transcript !== 'string') return null;
      return { type: 'turn.done', role, transcript };
    }
    case 'delegation.created': {
      const item = frame.item;
      const id = item?.id;
      if (item?.type !== 'delegation' || item.target !== 'client' || typeof id !== 'string') return null;
      if (!Array.isArray(item.content)) return null;
      const parts: string[] = [];
      for (const block of item.content as Array<{ type?: unknown; text?: unknown } | null>) {
        if (block?.type === 'input_text' && typeof block.text === 'string') parts.push(block.text);
      }
      return { type: 'delegation.created', id, text: parts.join('\n').trim() };
    }
    case 'session.closed':
      return { type: 'session.closed', reason: typeof frame.reason === 'string' ? frame.reason : null };
    case 'error': {
      const nested = typeof frame.error === 'object' ? frame.error?.message : frame.error;
      const message = typeof frame.message === 'string' ? frame.message : nested;
      return { type: 'error', message: typeof message === 'string' ? message : 'live session error' };
    }
    default:
      return { type: 'ignored', wireType: frame.type };
  }
}

function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** Split text into chunks of at most CONTEXT_CHUNK_BYTES UTF-8 bytes, never inside a code point. */
export function chunkLiveContext(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (bytes + size > CONTEXT_CHUNK_BYTES && current) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Context appends for one delegation, chunked to the wire limit. */
export function delegationAppends(id: string, text: string, channel?: LiveContextChannel): LiveClientMessage[] {
  return chunkLiveContext(text).map((chunk) => ({
    type: 'delegation.context.append',
    delegation_item_id: id,
    ...(channel ? { channel } : {}),
    content: [{ type: 'input_text', text: chunk }],
  }));
}

export const SESSION_CLOSE: LiveClientMessage = { type: 'session.close' };

export function finalMessageText(text: string): string {
  return `"Agent Final Message":\n\n${text.trim() || '(no text reply)'}`;
}

export const TURN_CANCELLED_TEXT = '"Agent Turn Cancelled": the work stopped before it finished.';

export function permissionRequestText(title: string): string {
  return `"Agent Permission Request": ${title.trim() || 'a tool call'}`;
}

export function permissionResolvedText(action: 'accept' | 'reject'): string {
  return action === 'accept'
    ? '"Agent Permission Resolved": approved on screen; the work continues.'
    : '"Agent Permission Resolved": rejected on screen; the agent will not run that tool.';
}

export function rejectedDelegationText(reason: string): string {
  return `"Agent Could Not Start": ${reason}`;
}

/** A busy lane that cannot be steered: the request is dropped, never queued. */
export function busyDelegationText(laneName: string, status: string): string {
  return `"Agent Busy": ${laneName} is ${status}; this request was not sent or queued.`;
}

export interface LiveTranscriptLine {
  role: LiveRole;
  text: string;
  final: boolean;
}

/**
 * The latest spoken line per role. Incremental `*_transcript.added` pieces
 * accumulate until `turn.done` carries the authoritative transcript; the next
 * piece after a finished turn starts a new line.
 */
export class LiveTranscript {
  private readonly lines: Record<LiveRole, { text: string; final: boolean }> = {
    user: { text: '', final: false },
    assistant: { text: '', final: false },
  };
  private last: LiveTranscriptLine | null = null;

  add(role: LiveRole, piece: string): void {
    if (!piece) return;
    const line = this.lines[role];
    let next: string;
    if (!line.text || line.final) next = piece;
    else if (piece.startsWith(line.text)) next = piece;
    else if (line.text.endsWith(piece)) next = line.text;
    else next = line.text + piece;
    this.store(role, next, false);
  }

  finish(role: LiveRole, transcript: string): void {
    if (!transcript.trim()) return;
    this.store(role, transcript, true);
  }

  latest(): LiveTranscriptLine | null {
    return this.last;
  }

  private store(role: LiveRole, text: string, final: boolean): void {
    this.lines[role] = { text, final };
    const trimmed = text.trim();
    if (trimmed) this.last = { role, text: trimmed, final };
  }
}

/** `busy`: the lane was mid-turn and could not be steered, so nothing was delivered. */
export type LiveDelivery = 'started' | 'steered' | 'queued' | 'busy' | 'rejected';

/**
 * Which delegation owns the lane's running turn, and the assistant text it
 * produced since the last tool call. Only a turn that carries a delegation
 * reports back; untagged turns (peer mail, typed prompts) stay silent.
 */
export class LiveDelegationLedger {
  private currentId: string | null = null;
  private buffer = '';

  /** A delegation was handed to the lane. Queued ones bind when their turn starts. */
  delivered(id: string, outcome: LiveDelivery): void {
    if (outcome === 'started' || outcome === 'steered') this.bind(id);
  }

  /** A queued, delegation-tagged prompt started its turn. */
  promptStarted(id: string): void {
    this.bind(id);
  }

  get current(): string | null {
    return this.currentId;
  }

  appendText(text: string): void {
    if (this.currentId) this.buffer += text;
  }

  /** Text since the last tool call, for a `commentary` append; null when silent. */
  flushProgress(): { id: string; text: string } | null {
    const id = this.currentId;
    const text = this.buffer.trim();
    this.buffer = '';
    return id && text ? { id, text } : null;
  }

  /** The turn ended: its owner and final text. Clears the binding. */
  takeFinal(): { id: string; text: string } | null {
    const id = this.currentId;
    const text = this.buffer;
    this.currentId = null;
    this.buffer = '';
    return id ? { id, text } : null;
  }

  reset(): void {
    this.currentId = null;
    this.buffer = '';
  }

  private bind(id: string): void {
    // A newer delegation takes over the turn; text so far stays with it.
    this.currentId = id;
  }
}

export type LiveCommand =
  | { kind: 'start'; voice: string }
  | { kind: 'stop' }
  | { kind: 'mute' }
  | { error: string };

/** `#live [voice] | stop | mute` — the tokens after `#live`. */
export function parseLiveCommand(args: string[]): LiveCommand {
  const first = args[0]?.toLowerCase();
  if (args.length > 1) return { error: '#live takes at most one argument' };
  if (first === undefined) return { kind: 'start', voice: DEFAULT_LIVE_VOICE };
  if (first === 'stop') return { kind: 'stop' };
  if (first === 'mute') return { kind: 'mute' };
  if (LIVE_VOICES.includes(first)) return { kind: 'start', voice: first };
  return { error: `unknown voice "${first}" (${LIVE_VOICES.join(', ')})` };
}

/** Human text for a Rust error sentinel (spec 280). */
export function liveErrorMessage(raw: string): string {
  if (raw === 'codex-not-connected') return 'Codex not signed in — run `codex` once';
  if (raw === 'codex-token-expired') return 'Codex token expired — run `codex` once to refresh';
  if (raw === 'codex-auth-rejected') return 'Codex auth rejected — run `codex` once to refresh';
  if (raw.startsWith('signaling-failed:')) {
    const [, status, ...body] = raw.split(':');
    return `live signaling failed (${status})${body.length ? `: ${body.join(':')}` : ''}`;
  }
  if (raw === 'signaling-network') return 'live signaling: network error';
  if (raw.startsWith('sideband-closed:')) return `live connection closed (${raw.slice('sideband-closed:'.length)})`;
  if (raw.startsWith('sideband')) return 'live connection lost';
  return raw;
}

const LIVE_INSTRUCTIONS = `You: Krypton Live, realtime voice surface of the {{lane}} coding lane.

<critical>
- You + the {{lane}} coding agent: one assistant, not separate agents.
- MUST delegate repository work, coding, tool use, verification to the client backend.
- MUST keep conversation natural while the client backend works.
</critical>

The user speaks to you. Respond directly, briefly, conversationally, with speech-friendly phrasing, in the language the user speaks. NEVER use markdown, code blocks, long lists, or read implementation detail aloud unless requested.

Client backend: the same assistant's execution surface; repository context, coding model, tools. Coding, investigation, repository changes, commands, or verification: promptly create a client delegation with a complete plain-language request and all relevant conversational context; NEVER attempt tool work yourself. A new request during active work MUST create a new delegation, steering the same backend.

Treat delegation context as your own internal progress and results. NEVER describe the backend as another assistant. MAY briefly acknowledge active work; NEVER claim changes, findings, or verification before the backend reports. Commentary context: silent progress for continuity; NEVER recite it. Context beginning with "Agent Final Message": the backend's final visible answer; present the useful result naturally as your own, NEVER mention the label, protocol, delegation, or backend.

Context beginning with "Agent Permission Request": the backend is paused until the user approves a tool call on screen in Krypton. Tell the user briefly what needs approval and that they approve it on screen; NEVER claim it was approved before "Agent Permission Resolved" arrives. "Agent Permission Resolved": the user already answered that request; NEVER ask for it again, and only mention a rejection if it matters. "Agent Turn Cancelled" or "Agent Could Not Start": tell the user plainly that the work did not finish. "Agent Busy": the backend is still on earlier work and did NOT receive that request; say so briefly and offer to ask again once the current work finishes — never imply it will run later on its own.

Greetings, clarification, and ordinary conversation needing no repository or tools: answer directly without delegation. Ask a concise clarifying question only when an execution request is genuinely underspecified.`;

export function renderLiveInstructions(laneName: string): string {
  return LIVE_INSTRUCTIONS.replaceAll('{{lane}}', laneName);
}
