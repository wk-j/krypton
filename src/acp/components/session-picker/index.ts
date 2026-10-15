// Spec 302 §7.4 — `SessionPicker`.
//
// Resume a previous agent session. Four phases, and `renderSessionPicker`
// (`acp-harness-view.ts:12850-12894`) wrote a different `innerHTML` document
// for each one, so every phase hop threw away the panel and every j/k threw
// away the list.
//
//   backend   pick which installed backend to ask
//   loading   `initializing...`, while the probe client starts
//   error     the probe failed; `b` / `n` / `esc` still work
//   sessions  the list, with an optional "no sessions" note and an
//             optional error note BELOW it — both siblings of the `<ul>`
//
// The four phases are one component because they are one surface: the head
// stays, the body swaps. `acp-harness.css:6568-6571` styles head / list /
// empty / error through `>` child combinators on the root, which is why there
// is no panel wrapper and why the two notes ride in `extras` rather than in
// the shell's `empty` slot (that one REPLACES the body).

import './session-picker.css';

import { Component } from '../../../ui/component';
import { el, frag } from '../../../ui/dom';
import { formatSessionUpdatedAt, normalizePathForCompare, shortId } from '../../harness-format';
import { backendLabel } from '../../harness-lane-identity';
import type { AcpBackendDescriptor, AcpSessionCapabilities, AcpSessionInfo } from '../../types';
import { EmptyState } from '../empty-state';
import { ListPicker } from '../list-picker';
import { OverlayShell, type OverlayShellParts } from '../overlay-shell';
import type { ComponentDef } from '../types';

const BLOCK = 'acp-harness__session';

const PARTS: OverlayShellParts = {
  panel: null,
  head: `${BLOCK}-head`,
  title: null,
  sub: null,
  empty: `${BLOCK}-empty`,
};

const BACKEND_HINTS = 'j/k move · enter list · esc cancel';
const ERROR_HINTS = 'b switch backend · n fresh · esc cancel';
const LOADING_HINTS = 'initializing...';
const LOADING_TEXT = 'loading sessions';
const ERROR_FALLBACK = 'session list unavailable';
const NO_SESSIONS = 'no sessions for this project';

export type SessionPickerPhase = 'backend' | 'loading' | 'error' | 'sessions';

/** One backend row: label, id, and what the row offers to do. */
interface BackendEntry {
  readonly id: string;
  readonly label: string;
  readonly action: string;
}

/** One session row, with everything it prints already resolved. */
interface SessionEntry {
  readonly title: string;
  readonly meta: string;
  readonly action: string;
  readonly disabled: boolean;
}

export interface SessionPickerProps {
  readonly open: boolean;
  readonly phase: SessionPickerPhase;
  /** Backend phase: the installed backends, and the lanes already on each. */
  readonly backends: readonly AcpBackendDescriptor[];
  readonly running: ReadonlyMap<string, number>;
  readonly backendCursor: number;
  /** The backend being listed; names the head in every phase but `backend`. */
  readonly backendId: string | null;
  readonly sessions: readonly AcpSessionInfo[];
  readonly sessionCursor: number;
  /** Decides the per-row action word and whether rows read as disabled. */
  readonly capabilities: AcpSessionCapabilities | null;
  /** A further page exists — adds `· PageDown more` to the head hints. */
  readonly nextCursor: string | null;
  readonly error: string | null;
  /** A session whose cwd differs from this shows its cwd in the row meta. */
  readonly projectDir: string | null;
  onAutoClose?(): void;
}

export class SessionPicker extends Component<SessionPickerProps> {
  private readonly shell: OverlayShell;
  private readonly backendList = new ListPicker<BackendEntry>();
  private readonly sessionList = new ListPicker<SessionEntry>();
  private readonly emptyNote = new EmptyState();
  private readonly errorNote = new EmptyState();
  private backendEntries: readonly BackendEntry[] = [];
  private backendKey: string | null = null;
  private sessionEntries: readonly SessionEntry[] = [];
  private sessionKey: string | null = null;
  private extras: readonly Node[] = [];
  private extrasKey: string | null = null;
  private autoClose: (() => void) | undefined;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
  }

  update(next: SessionPickerProps): void {
    this.autoClose = next.onAutoClose;
    super.update(next);
  }

  protected readDeps(next: SessionPickerProps): readonly unknown[] {
    return [
      next.open,
      next.phase,
      next.backendId,
      next.error,
      next.nextCursor,
      this.backendKeyFor(next),
      next.backendCursor,
      this.sessionKeyFor(next),
      next.sessionCursor,
    ];
  }

  /** Owned by `OverlayShell`, the two `ListPicker`s and the two notes. */
  protected syncClasses(): void {
    /* no classes of its own */
  }

  protected paint(next: SessionPickerProps): void {
    const backendName = next.backendId === null ? 'backend' : backendLabel(next.backendId);
    if (next.phase === 'backend') {
      this.backendList.update({
        items: this.backendEntriesFor(next),
        cursor: next.backendCursor,
        renderRow: this.renderBackendRow,
        block: BLOCK,
        separator: '-',
        name: 'session',
        indexAttr: false,
        rowAttrs: backendRowAttrs,
        listClass: `${BLOCK}-list`,
      });
      this.shell.update({
        ...this.frame(next),
        title: '// resume session',
        sub: BACKEND_HINTS,
        body: this.backendList.el,
      });
      return;
    }
    if (next.phase === 'loading' || next.phase === 'error') {
      this.shell.update({
        ...this.frame(next),
        title: `// ${backendName} sessions`,
        sub: next.phase === 'loading' ? LOADING_HINTS : ERROR_HINTS,
        // `empty` replaces the body, which is exactly what these two phases
        // do: one `<div class="acp-harness__session-empty">`, no list.
        body: this.sessionList.el,
        empty: next.phase === 'loading' ? LOADING_TEXT : next.error ?? ERROR_FALLBACK,
      });
      return;
    }

    const action = sessionAction(next.capabilities);
    this.sessionList.update({
      items: this.sessionEntriesFor(next),
      cursor: next.sessionCursor,
      renderRow: this.renderSessionRow,
      rowClasses: sessionRowClasses,
      block: BLOCK,
      separator: '-',
      name: 'session',
      indexAttr: false,
      listClass: `${BLOCK}-list`,
    });
    const page = next.nextCursor === null ? '' : ' · PageDown more';
    this.shell.update({
      ...this.frame(next),
      title: `// ${backendName} sessions`,
      sub: `enter ${action} · b backend · n fresh${page} · esc cancel`,
      body: this.sessionList.el,
      extras: this.extrasFor(next),
    });
  }

  /** The props every phase shares; the body and the head text differ. */
  private frame(next: SessionPickerProps): {
    open: boolean;
    rootClass: string;
    block: string;
    parts: OverlayShellParts;
    onAutoClose: () => void;
  } {
    return {
      open: next.open,
      rootClass: `${BLOCK}-picker`,
      block: BLOCK,
      parts: PARTS,
      onAutoClose: this.emitAutoClose,
    };
  }

  private readonly renderBackendRow = (entry: BackendEntry): Node =>
    frag(
      el('span', { class: `${BLOCK}-title`, text: entry.label }),
      el('span', { class: `${BLOCK}-meta`, text: entry.id }),
      el('span', { class: `${BLOCK}-action`, text: entry.action }),
    );

  private readonly renderSessionRow = (entry: SessionEntry): Node =>
    frag(
      el('span', { class: `${BLOCK}-title`, text: entry.title }),
      el('span', { class: `${BLOCK}-meta`, text: entry.meta }),
      el('span', { class: `${BLOCK}-action`, text: entry.action }),
    );

  private readonly emitAutoClose = (): void => {
    this.autoClose?.();
  };

  /** `[]`, `[empty]`, `[error]` or `[empty, error]` — a stable array each. */
  private extrasFor(next: SessionPickerProps): readonly Node[] | undefined {
    const showEmpty = next.sessions.length === 0;
    const key = `${showEmpty}\u0000${next.error ?? ''}`;
    if (key === this.extrasKey) return this.extras.length === 0 ? undefined : this.extras;
    this.extrasKey = key;
    const nodes: Node[] = [];
    if (showEmpty) {
      this.emptyNote.update({ block: `${BLOCK}-empty`, text: NO_SESSIONS });
      nodes.push(this.emptyNote.el);
    }
    if (next.error !== null) {
      this.errorNote.update({ block: `${BLOCK}-error`, text: next.error });
      nodes.push(this.errorNote.el);
    }
    this.extras = nodes;
    return nodes.length === 0 ? undefined : nodes;
  }

  private backendEntriesFor(next: SessionPickerProps): readonly BackendEntry[] {
    const key = this.backendKeyFor(next);
    if (key === this.backendKey) return this.backendEntries;
    this.backendKey = key;
    this.backendEntries = next.backends.map((backend) => {
      const running = next.running.get(backend.id) ?? 0;
      return {
        id: backend.id,
        label: backendLabel(backend.id),
        action: running > 0 ? `${running} running` : 'select',
      };
    });
    return this.backendEntries;
  }

  private backendKeyFor(next: SessionPickerProps): string {
    return next.backends
      .map((backend) => `${backend.id}\u0000${next.running.get(backend.id) ?? 0}`)
      .join('\u0001');
  }

  private sessionEntriesFor(next: SessionPickerProps): readonly SessionEntry[] {
    const key = this.sessionKeyFor(next);
    if (key === this.sessionKey) return this.sessionEntries;
    this.sessionKey = key;
    const capabilities = next.capabilities;
    const disabled = !(capabilities !== null && (capabilities.canResume || capabilities.canLoad));
    const action = sessionAction(capabilities);
    const project = next.projectDir === null ? null : normalizePathForCompare(next.projectDir);
    this.sessionEntries = next.sessions.map((session) => {
      const meta = [shortId(session.sessionId)];
      const updated = formatSessionUpdatedAt(session.updatedAt);
      if (updated !== null) meta.push(updated);
      if (session.cwd && project !== null && normalizePathForCompare(session.cwd) !== project) {
        meta.push(session.cwd);
      }
      return {
        title: session.title?.trim() || 'untitled session',
        meta: meta.join(' · '),
        action,
        disabled,
      };
    });
    return this.sessionEntries;
  }

  private sessionKeyFor(next: SessionPickerProps): string {
    const capabilities = next.capabilities;
    const head = `${capabilities?.canResume ?? false}\u0000${capabilities?.canLoad ?? false}\u0000${next.projectDir ?? ''}`;
    return next.sessions
      .map((session) =>
        [session.sessionId, session.title ?? '', session.updatedAt ?? '', session.cwd].join('\u0000'),
      )
      .join('\u0001')
      .concat('\u0002', head);
  }

  protected onDispose(): void {
    this.backendList.dispose();
    this.sessionList.dispose();
    this.emptyNote.dispose();
    this.errorNote.dispose();
    this.shell.dispose();
  }
}

/** The word a session row offers, and the head's `enter …` hint. */
function sessionAction(capabilities: AcpSessionCapabilities | null): string {
  if (capabilities?.canResume === true) return 'resume';
  if (capabilities?.canLoad === true) return 'load';
  return 'list only';
}

/** Backend rows are addressed by id, not by index — they always have been. */
function backendRowAttrs(entry: BackendEntry): Readonly<Record<string, string>> {
  return { 'data-session-backend': entry.id };
}

function sessionRowClasses(entry: SessionEntry): readonly string[] {
  return entry.disabled ? [`${BLOCK}-row--disabled`] : [];
}

export const def: ComponentDef = { id: 'session-picker', blocks: [BLOCK] };
