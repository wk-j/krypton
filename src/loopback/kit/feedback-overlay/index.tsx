// Spec 341 — the `/doc` reader's corner overlays, ported from the two inline
// scripts of the old docs page:
//
// * comments (spec 172): `c` arms a picker, a click anchors a passage, the
//   composer saves a pin (⌘/Ctrl+Enter) or cancels (Esc), `s` POSTs the unsent
//   batch to `/doc-feedback`, `j`/`k` cycle the pins. The anchor is the QUOTED
//   TEXT plus its heading trail, never a DOM selector: the lane edits the
//   source `.md`, not this comrak output. Unsent pins, the open draft and the
//   batch id survive a reload in sessionStorage `kdf:<harness>:<path>`.
// * artifact export (spec 174): `a` (or the pill) POSTs `/doc-artifact`; the
//   harness's active lane writes the artifact.
//
// A 2.5 s `/doc-state` poll reloads the page when the file's hash moves, but
// never while the picker is armed or the composer is open — the reload waits
// for them to close.
//
// Spec 361: a component the reader page portals to `<body>`. The annotated
// `scope` article is Rust-rendered markup: it is only read (queries, rects)
// and listened to through `document`, never rendered or reparented by React.
// Harness, path and scope are read once; key the component on them.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';

import { Button } from '../button';
import { useKeymap, useLatest, useModal } from '../hooks';
import { fetchJson, HttpError, postJson } from '../lib/fetch-json';
import { poll } from '../lib/poll';

import './feedback-overlay.css';

export interface DocPin {
  readonly id: string;
  readonly pinNumber: number;
  readonly body: string;
  readonly quote: string;
  readonly headingPath: readonly string[];
  readonly createdAt: number;
  readonly sent: boolean;
  readonly drifted: boolean;
}

interface Draft {
  readonly quote: string;
  readonly headingPath: readonly string[];
  readonly body: string;
}

/** The persisted half of the overlay, written to sessionStorage as is. */
interface DocState {
  readonly pins: readonly DocPin[];
  readonly pinSeq: number;
  readonly draft: Draft | null;
  readonly batchId: string | null;
}

interface SavedState {
  pins?: DocPin[];
  pinSeq?: number;
  draft?: Draft | null;
  batchId?: string | null;
}

type ArtifactState = 'ready' | 'sending' | 'queued' | 'error';

interface ArtifactView {
  readonly state: ArtifactState;
  readonly detail: string;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The hover box: `rect` outlives `shown`, as the old inline style did. */
interface Highlight {
  readonly rect: Rect | null;
  readonly shown: boolean;
}

export interface FeedbackOverlayProps {
  readonly harness: string;
  /** The doc's project-relative path, as the `/doc` query carries it. */
  readonly path: string;
  /** The rendered document: passages anchor and resolve inside it only. */
  readonly scope: HTMLElement;
  /** `/doc-state` cadence. Default 2500 ms. */
  readonly pollMs?: number;
  /** What a moved `/doc-state` hash does. Default `location.reload()`. */
  readonly reload?: () => void;
}

const BODY_MAX = 4000;
const QUOTE_MAX = 2000;
const FLASH_MS = 2200;
const ANCHORABLE = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,code,a,strong,em';
const EMPTY: DocState = { pins: [], pinSeq: 0, draft: null, batchId: null };
const NO_HIGHLIGHT: Highlight = { rect: null, shown: false };

function cap(value: string | null | undefined, max: number): string {
  const text = value ?? '';
  return text.length > max ? text.slice(0, max) : text;
}

function randomHex(): string {
  return Math.random().toString(16).slice(2);
}

function displayPath(path: string): string {
  return path.split('/').filter((part) => part && part !== '.').join('/') || path || 'document.md';
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || 'document.md';
}

function defaultReload(): void {
  location.reload();
}

/** The most specific (shortest-text) element of `scope` containing `quote`. */
function resolveByQuote(scope: HTMLElement, quote: string | null | undefined): Element | null {
  const needle = (quote ?? '').trim();
  if (!needle) return null;
  let best: Element | null = null;
  let bestLen = Infinity;
  for (const node of scope.querySelectorAll(ANCHORABLE)) {
    const text = node.textContent ?? '';
    if (text.includes(needle) && text.length < bestLen) {
      best = node;
      bestLen = text.length;
    }
  }
  return best;
}

/** The nearest preceding heading plus its higher-level ancestors. */
function headingPathFor(scope: HTMLElement, node: Element): string[] {
  const headText = (h: Element): string => cap((h.textContent ?? '').trim(), 120);
  const heads = [...scope.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const preceding = heads.filter(
    (h) => h === node || (node.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
  );
  if (preceding.length === 0) return [];
  let index = preceding.length - 1;
  let level = Number(preceding[index].tagName.slice(1));
  const path = [headText(preceding[index])];
  for (index -= 1; index >= 0 && level > 1; index--) {
    const lv = Number(preceding[index].tagName.slice(1));
    if (lv < level) {
      path.unshift(headText(preceding[index]));
      level = lv;
    }
  }
  return path;
}

/** Saved state, with every restored pin reconciled against the DOM: drifted = quote gone. */
function restore(storageKey: string, scope: HTMLElement): DocState {
  let state = EMPTY;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as SavedState | null;
    if (saved) {
      const pins = (saved.pins ?? []).filter((pin) => !pin.sent);
      state = { pins, pinSeq: saved.pinSeq ?? pins.length, draft: saved.draft ?? null, batchId: saved.batchId ?? null };
    }
  } catch {
    /* unreadable state starts fresh */
  }
  return { ...state, pins: state.pins.map((pin) => ({ ...pin, drifted: !resolveByQuote(scope, pin.quote) })) };
}

function persist(storageKey: string, state: DocState): void {
  try {
    const saved: SavedState = {
      pins: [...state.pins],
      pinSeq: state.pinSeq,
      draft: state.draft,
      batchId: state.batchId,
    };
    sessionStorage.setItem(storageKey, JSON.stringify(saved));
  } catch {
    /* storage full or disabled */
  }
}

function targetText(draft: Draft | null): string {
  if (!draft) return '';
  const head = draft.headingPath.join(' › ');
  return (head ? `${head}  ` : '') + (draft.quote ? `“${cap(draft.quote, 48)}”` : '');
}

/** The highlight update that outlines `node` (rect read now), or hides the box when `node` is null. */
function outline(node: Element | null): (prev: Highlight) => Highlight {
  if (!node) return (prev) => (prev.shown ? { ...prev, shown: false } : prev);
  const { left, top, width, height } = node.getBoundingClientRect();
  return (prev) => {
    const same =
      prev.rect && prev.rect.left === left && prev.rect.top === top && prev.rect.width === width && prev.rect.height === height;
    return prev.shown && same ? prev : { rect: { left, top, width, height }, shown: true };
  };
}

export function FeedbackOverlay({ harness, path, scope, pollMs = 2500, reload }: FeedbackOverlayProps): JSX.Element {
  const query = `harness=${encodeURIComponent(harness)}&path=${encodeURIComponent(path)}`;
  const feedUrl = `/doc-feedback?${query}`;
  const stateUrl = `/doc-state?${query}`;
  const artifactUrl = `/doc-artifact?${query}`;
  const storageKey = `kdf:${harness}:${path}`;
  const artifactTitle = `Docs artifact · ${basename(displayPath(path))}`;

  // `docRef` is the synchronous source of truth (async POST results read it);
  // `doc` is its last committed render.
  const [doc, setDoc] = useState<DocState>(() => restore(storageKey, scope));
  const docRef = useRef(doc);
  const [target, setTarget] = useState(() => targetText(docRef.current.draft));
  /** Bumped per composer open; a restored draft opens on mount. */
  const [openSeq, setOpenSeq] = useState(() => (docRef.current.draft ? 1 : 0));
  const [armed, setArmed] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [flashMsg, setFlashMsg] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Highlight>(NO_HIGHLIGHT);
  const [artifact, setArtifactView] = useState<ArtifactView>({ state: 'ready', detail: 'press a' });
  /** Counts `/doc-state` hash moves; a non-zero count reloads once nothing is open. */
  const [moved, setMoved] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const disabledRef = useRef(false);
  const cycleIdx = useRef(-1);
  const lastHash = useRef<string | null>(null);
  const artifactBatch = useRef<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const highlightTimer = useRef<number | undefined>(undefined);
  const artifactTimer = useRef<number | undefined>(undefined);

  const composerOpen = doc.draft !== null;
  const armedNow = useLatest(armed);
  const reloadNow = useLatest(reload ?? defaultReload);

  const commit = (next: DocState, save: boolean): void => {
    docRef.current = next;
    setDoc(next);
    if (save) persist(storageKey, next);
  };

  // ── highlight ──────────────────────────────────────────────────────────

  const flashHighlight = (node: Element): void => {
    setHighlight(outline(node));
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => {
      if (!armedNow.current) setHighlight(outline(null));
    }, 1200);
  };

  // ── pills ──────────────────────────────────────────────────────────────

  const flash = (message: string): void => {
    setFlashMsg(message);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashMsg(null), FLASH_MS);
  };

  const setArtifact = (state: ArtifactState, detail: string): void => {
    window.clearTimeout(artifactTimer.current);
    setArtifactView({ state, detail });
  };

  // ── picking ────────────────────────────────────────────────────────────

  /** The comment pill and composer (not the artifact pill). */
  const inCommentOverlay = (eventTarget: EventTarget | null): boolean =>
    eventTarget instanceof Node &&
    ((boxRef.current?.contains(eventTarget) ?? false) || (pillRef.current?.contains(eventTarget) ?? false));

  /** A passage of the document, never the overlay itself. */
  const pickable = (eventTarget: EventTarget | null): Element | null => {
    if (!(eventTarget instanceof Element)) return null;
    const inOverlay = (rootRef.current?.contains(eventTarget) ?? false) || eventTarget === highlightRef.current;
    if (inOverlay || !scope.contains(eventTarget)) return null;
    return eventTarget;
  };

  const arm = (): void => {
    if (disabled) return;
    setArmed(true);
  };

  const disarm = (): void => {
    setArmed(false);
    setHighlight(outline(null));
  };

  const openComposer = (draft: Draft): void => {
    commit({ ...docRef.current, draft }, false);
    setTarget(targetText(draft));
    setOpenSeq((seq) => seq + 1);
  };

  const onMove = (event: MouseEvent): void => {
    if (!armed) return;
    setHighlight(outline(pickable(event.target)));
  };

  const onClick = (event: MouseEvent): void => {
    if (!armed) return;
    const node = pickable(event.target);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    setArmed(false);
    let selection = '';
    try {
      selection = String(window.getSelection() ?? '').trim();
    } catch {
      /* no selection API */
    }
    const quote = selection || (node.textContent ?? '').trim();
    openComposer({ quote: cap(quote, QUOTE_MAX), headingPath: headingPathFor(scope, node), body: '' });
  };

  const onScroll = (): void => {
    if (armed) setHighlight(outline(null));
  };

  // ── composer ───────────────────────────────────────────────────────────

  /** Drop the draft (saved or cancelled), persist, and close the composer. */
  const closeComposer = (): void => {
    commit({ ...docRef.current, draft: null }, true);
    setHighlight(outline(null));
  };

  const saveComposer = (): void => {
    const current = docRef.current;
    const draft = current.draft;
    if (!draft) return;
    const body = cap((textRef.current?.value ?? '').trim(), BODY_MAX);
    if (!body) {
      flash('comment is empty');
      return;
    }
    const pinSeq = current.pinSeq + 1;
    const pin: DocPin = {
      id: `d-${Date.now()}-${randomHex().slice(0, 6)}`,
      pinNumber: pinSeq,
      body,
      quote: draft.quote,
      headingPath: draft.headingPath,
      createdAt: Date.now(),
      sent: false,
      drifted: false,
    };
    docRef.current = { ...current, pins: [...current.pins, pin], pinSeq };
    closeComposer();
  };

  const onInput = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const current = docRef.current;
    if (!current.draft) return;
    commit({ ...current, draft: { ...current.draft, body: event.currentTarget.value } }, true);
  };

  // ── send the unsent batch (idempotent on batchId) ──────────────────────

  const sendBatch = (): void => {
    if (disabledRef.current) return;
    const current = docRef.current;
    const unsent = current.pins.filter((pin) => !pin.sent && !pin.drifted);
    if (unsent.length === 0) {
      flash('nothing to send');
      return;
    }
    const batchId = current.batchId ?? `b-${Date.now()}-${randomHex()}`;
    commit({ ...current, batchId }, true);
    const payload = {
      batchId,
      comments: unsent.map((pin) => ({
        id: pin.id,
        pinNumber: pin.pinNumber,
        body: pin.body,
        quote: pin.quote,
        headingPath: pin.headingPath,
        createdAt: pin.createdAt,
      })),
    };
    flash('sending…');
    postJson<unknown>(feedUrl, payload).then(
      () => {
        const sent = new Set(unsent.map((pin) => pin.id));
        const latest = docRef.current;
        const pins = latest.pins.map((pin) => (sent.has(pin.id) ? { ...pin, sent: true } : pin));
        commit({ ...latest, pins, batchId: null }, true);
        flash(`queued ${payload.comments.length} ✓`);
      },
      (error: unknown) => {
        if (!(error instanceof HttpError)) flash('offline — press s to retry');
        else if (error.status === 409) flash('no active lane — open one in this harness');
        else if (error.status === 404) {
          disabledRef.current = true;
          setDisabled(true);
          flash('doc no longer available');
        } else if (error.status === 413) flash('too large — trim a comment');
        else if (error.status === 503) flash('queued — retrying, press s');
        else flash(`send failed (${error.status})`);
      },
    );
  };

  const cyclePins = (direction: number): void => {
    const pins = docRef.current.pins;
    if (pins.length === 0) return;
    cycleIdx.current = (cycleIdx.current + direction + pins.length) % pins.length;
    const pin = pins[cycleIdx.current];
    const anchor = resolveByQuote(scope, pin.quote);
    if (anchor) {
      anchor.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      flashHighlight(anchor);
    }
    flash(`pin #${pin.pinNumber}: ${cap(pin.body, 40)}`);
  };

  // ── artifact ───────────────────────────────────────────────────────────

  const requestArtifact = (): void => {
    if (artifact.state === 'sending' || artifact.state === 'queued') return;
    artifactBatch.current ??= `da-${Date.now()}-${randomHex()}`;
    setArtifact('sending', artifactTitle);
    postJson<unknown>(artifactUrl, { batchId: artifactBatch.current, title: artifactTitle }).then(
      () => {
        artifactBatch.current = null;
        setArtifact('queued', 'active lane will create it');
        artifactTimer.current = window.setTimeout(() => setArtifact('ready', 'press a'), FLASH_MS);
      },
      (error: unknown) => {
        if (!(error instanceof HttpError)) setArtifact('error', 'press a to retry');
        else if (error.status === 409) setArtifact('error', 'no active lane');
        else if (error.status === 404) setArtifact('error', 'doc unavailable');
        else if (error.status === 413) setArtifact('error', 'title too long');
        else if (error.status === 503) setArtifact('error', 'press a to retry');
        else setArtifact('error', `failed ${error.status}`);
      },
    );
  };

  // ── wiring ─────────────────────────────────────────────────────────────

  const documentHandlers = useLatest({ onMove, onClick, onScroll });
  useEffect(() => {
    const move = (event: MouseEvent): void => documentHandlers.current.onMove(event);
    const click = (event: MouseEvent): void => documentHandlers.current.onClick(event);
    const scroll = (): void => documentHandlers.current.onScroll();
    document.addEventListener('mousemove', move, { capture: true });
    document.addEventListener('click', click, { capture: true });
    window.addEventListener('scroll', scroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousemove', move, { capture: true });
      document.removeEventListener('click', click, { capture: true });
      window.removeEventListener('scroll', scroll, { capture: true });
    };
  }, [documentHandlers]);

  const group = 'Doc comments';
  useModal(composerOpen);
  useKeymap([
    { key: 'c', label: 'Comment on a passage', group, run: () => arm() },
    { key: 's', label: 'Send unsent comments', group, run: () => sendBatch() },
    { key: 'j', label: 'Next comment pin', group, run: () => cyclePins(1) },
    { key: 'k', label: 'Previous comment pin', group, run: () => cyclePins(-1) },
    { key: 'Escape', label: 'Stop picking', group, when: () => armed, run: () => disarm() },
    {
      key: 'a',
      label: 'Generate an HTML artifact from this doc',
      group,
      run: (event) => {
        if (armed || inCommentOverlay(event.target)) return false;
        requestArtifact();
      },
    },
    {
      key: 'Escape',
      label: 'Cancel the comment',
      group,
      modal: true,
      inInput: true,
      when: () => composerOpen,
      run: () => closeComposer(),
    },
    {
      key: 'Enter',
      mod: true,
      label: 'Save the comment',
      group,
      modal: true,
      inInput: true,
      when: () => composerOpen,
      run: () => saveComposer(),
    },
  ]);

  // Each open loads the draft into the (uncontrolled) textarea, outlines its
  // anchor and focuses the composer, once the box is no longer hidden.
  useLayoutEffect(() => {
    const draft = docRef.current.draft;
    if (openSeq === 0 || !draft) return;
    const text = textRef.current;
    if (text) text.value = draft.body;
    setHighlight(outline(resolveByQuote(scope, draft.quote)));
    text?.focus();
  }, [openSeq, scope]);

  // Live reload: a moved hash reloads, but never under the picker or the composer.
  useEffect(() => {
    if (moved > 0 && !armed && !composerOpen) reloadNow.current();
  }, [moved, armed, composerOpen, reloadNow]);

  useEffect(() => {
    const poller = poll<{ hash?: string } | null>({
      intervalMs: pollMs,
      load: async (signal) => {
        if (disabledRef.current) return null;
        try {
          return await fetchJson<{ hash?: string }>(stateUrl, { signal });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          if (error.status === 404) {
            disabledRef.current = true;
            setDisabled(true);
            poller.dispose();
          }
          return null;
        }
      },
      apply: (state) => {
        if (!state?.hash) return;
        if (lastHash.current === null) {
          lastHash.current = state.hash;
          return;
        }
        if (state.hash === lastHash.current) return;
        lastHash.current = state.hash;
        setMoved((count) => count + 1);
      },
    });
    return () => poller.dispose();
  }, [stateUrl, pollMs]);

  useEffect(
    () => () => {
      window.clearTimeout(flashTimer.current);
      window.clearTimeout(highlightTimer.current);
      window.clearTimeout(artifactTimer.current);
    },
    [],
  );

  // ── render ─────────────────────────────────────────────────────────────

  const unsent = doc.pins.filter((pin) => !pin.sent).length;
  const drifted = doc.pins.filter((pin) => pin.drifted).length;
  let main: string;
  let sub: string;
  if (disabled) {
    main = '✦ doc no longer available';
    sub = 'the file or harness is gone';
  } else if (armed) {
    main = '✦ click a passage';
    sub = 'esc to cancel';
  } else {
    main = `✦ doc comments (${doc.pins.length})`;
    const bits = ['c add'];
    if (unsent > 0) bits.push(`s send ${unsent}`);
    if (doc.pins.length > 0) bits.push('j/k cycle');
    sub = bits.join(' · ');
  }
  if (flashMsg) sub = flashMsg;
  else if (drifted > 0) sub += ` · ${drifted} drifted`;

  const artifactLabel =
    artifact.state === 'queued'
      ? 'queued'
      : artifact.state === 'sending'
        ? 'sending…'
        : artifact.state === 'error'
          ? 'retry'
          : 'artifact';
  const rect = highlight.rect;

  return (
    <>
      <div ref={rootRef} className="lb-feedback">
        <div ref={boxRef} className="lb-feedback__box" hidden={!composerOpen}>
          <div className="lb-feedback__target">{target}</div>
          <textarea
            ref={textRef}
            className="lb-input lb-feedback__text"
            placeholder="describe the change…"
            aria-label="Comment"
            onChange={onInput}
          />
          <div className="lb-feedback__row">
            <span className="lb-feedback__keys">⌘↵ save · esc cancel</span>
            <span className="lb-feedback__actions">
              <Button label="cancel" variant="ghost" onClick={closeComposer} />
              <Button label="save" onClick={saveComposer} />
            </span>
          </div>
        </div>
        <button
          className="lb-feedback__pill"
          type="button"
          title="Generate an HTML artifact from this doc"
          data-state={artifact.state}
          onClick={requestArtifact}
        >
          <b className="lb-feedback__main">{artifactLabel}</b>
          <span className="lb-feedback__sub">{artifact.detail}</span>
        </button>
        <button
          ref={pillRef}
          className="lb-feedback__pill"
          type="button"
          title="Comment on a passage of this doc"
          disabled={disabled}
          onClick={() => {
            if (armed) disarm();
            else arm();
          }}
        >
          <b className="lb-feedback__main">{main}</b>
          <span className="lb-feedback__sub">{sub}</span>
        </button>
      </div>
      <div
        ref={highlightRef}
        className="lb-feedback__hi"
        hidden={!highlight.shown}
        style={
          rect
            ? { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }
            : undefined
        }
      />
    </>
  );
}
