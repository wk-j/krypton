// Krypton — bash (readline) editing keys for a native <textarea>.
// The ACP Harness composer's set (help overlay "Composer (readline)"): ⌃A ⌃E
// ⌃B ⌃F ⌃← ⌃→ ⌃H ⌃D ⌃W ⌃U ⌃K ⌃Y ⌃T. A textarea holds many lines, so a "line"
// is the textarea's line and, as in zsh, ⌃U at a line start and ⌃K at a line
// end kill the newline. Words come from Intl.Segmenter, so Thai (no spaces
// between words) steps and kills one word at a time.

export interface ReadlineKey {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What a key does to the text with the selection [start, end): nothing (the
 *  key is still consumed), a caret move, or replacing [from, to) with
 *  `insert`, the caret after it. `kill` is the new kill buffer, if any. */
export type ReadlineAction =
  | { kind: 'none' }
  | { kind: 'move'; caret: number }
  | { kind: 'edit'; from: number; to: number; insert: string; kill: string | null };

interface Segment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}

interface Segments extends Iterable<Segment> {
  containing(index: number): Segment | undefined;
}

interface Segmenter {
  segment(input: string): Segments;
}

// lib is ES2021; Intl.Segmenter typings arrive with ES2022.
function makeSegmenter(granularity: 'grapheme' | 'word'): Segmenter | null {
  const Ctor = (Intl as typeof Intl & {
    Segmenter?: new (locale: string | undefined, options: { granularity: 'grapheme' | 'word' }) => Segmenter;
  }).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity }) : null;
}

const graphemes = makeSegmenter('grapheme');
const words = makeSegmenter('word');

const NONE: ReadlineAction = { kind: 'none' };

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineEnd(text: string, pos: number): number {
  const i = text.indexOf('\n', pos);
  return i < 0 ? text.length : i;
}

/** One code point back: what Backspace removes (a Thai mark on its own). */
function pointBack(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const low = text.charCodeAt(pos - 1);
  const high = pos >= 2 ? text.charCodeAt(pos - 2) : 0;
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? pos - 2 : pos - 1;
}

/** The start of the grapheme cluster before `pos`: where ← puts the caret. */
function graphemeBack(text: string, pos: number): number {
  if (pos <= 0) return 0;
  return graphemes?.segment(text).containing(pos - 1)?.index ?? pointBack(text, pos);
}

/** The end of the grapheme cluster after `pos`: where → puts the caret. */
function graphemeForward(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  const seg = graphemes?.segment(text).containing(pos);
  if (seg) return seg.index + seg.segment.length;
  const c = text.charCodeAt(pos);
  return c >= 0xd800 && c <= 0xdbff && pos + 1 < text.length ? pos + 2 : pos + 1;
}

/** The start of the word before `pos`, skipping the spaces and punctuation in between. */
export function wordBackward(text: string, pos: number): number {
  const head = text.slice(0, pos);
  if (!words) {
    let i = pos;
    while (i > 0 && !/\w/.test(head[i - 1])) i--;
    while (i > 0 && /\w/.test(head[i - 1])) i--;
    return i;
  }
  let start = 0;
  for (const seg of words.segment(head)) if (seg.isWordLike) start = seg.index;
  return start;
}

/** The end of the word after `pos`, skipping the spaces and punctuation in between. */
export function wordForward(text: string, pos: number): number {
  const tail = text.slice(pos);
  if (!words) {
    let i = 0;
    while (i < tail.length && !/\w/.test(tail[i])) i++;
    while (i < tail.length && /\w/.test(tail[i])) i++;
    return pos + i;
  }
  for (const seg of words.segment(tail)) if (seg.isWordLike) return pos + seg.index + seg.segment.length;
  return text.length;
}

function move(caret: number): ReadlineAction {
  return { kind: 'move', caret };
}

function cut(text: string, from: number, to: number, kill: boolean): ReadlineAction {
  if (from >= to) return NONE;
  return { kind: 'edit', from, to, insert: '', kill: kill ? text.slice(from, to) : null };
}

/** ⌃T: swap the two grapheme clusters around the caret; at a line end, the two before it. */
function transpose(text: string, pos: number): ReadlineAction {
  const atEnd = pos === lineEnd(text, pos);
  const mid = atEnd ? graphemeBack(text, pos) : pos;
  const from = graphemeBack(text, mid);
  const to = atEnd ? pos : graphemeForward(text, pos);
  if (from >= mid || mid >= to || text.slice(from, to).includes('\n')) return NONE;
  return { kind: 'edit', from, to, insert: text.slice(mid, to) + text.slice(from, mid), kill: null };
}

/** The readline action for `e`, or null when `e` is not one of the keys. */
export function readlineAction(
  e: ReadlineKey,
  text: string,
  start: number,
  end: number,
  killed: string,
): ReadlineAction | null {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const selected = start !== end;
  switch (e.code) {
    case 'KeyA':
      return move(lineStart(text, start));
    case 'KeyE':
      return move(lineEnd(text, end));
    case 'KeyB':
      return move(selected ? start : graphemeBack(text, start));
    case 'KeyF':
      return move(selected ? end : graphemeForward(text, end));
    case 'ArrowLeft':
      return move(wordBackward(text, start));
    case 'ArrowRight':
      return move(wordForward(text, end));
    case 'KeyH':
      return selected ? cut(text, start, end, false) : cut(text, pointBack(text, start), start, false);
    case 'KeyD':
      return selected ? cut(text, start, end, false) : cut(text, start, graphemeForward(text, start), false);
    case 'KeyW':
      return cut(text, selected ? start : wordBackward(text, start), end, true);
    case 'KeyU': {
      const from = lineStart(text, start);
      return cut(text, from === start && !selected ? Math.max(0, start - 1) : from, end, true);
    }
    case 'KeyK': {
      const to = lineEnd(text, end);
      return cut(text, start, to === end && !selected ? Math.min(text.length, end + 1) : to, true);
    }
    case 'KeyY':
      return killed ? { kind: 'edit', from: start, to: end, insert: killed, kill: null } : NONE;
    case 'KeyT':
      return selected ? NONE : transpose(text, start);
    default:
      return null;
  }
}

/** The kill buffer one editor's ⌃W ⌃U ⌃K fill and ⌃Y yanks. */
export interface KillBuffer {
  text: string;
}

/** Run `e` on `ta` when it is a readline key; returns what it did, or null to
 *  leave the key to the textarea. Edits go through `execCommand`, so they
 *  land on the textarea's undo stack and fire its `input` event. */
export function applyReadlineKey(
  e: KeyboardEvent,
  ta: HTMLTextAreaElement,
  kill: KillBuffer,
): ReadlineAction | null {
  if (e.isComposing) return null;
  const action = readlineAction(e, ta.value, ta.selectionStart, ta.selectionEnd, kill.text);
  if (!action) return null;
  e.preventDefault();
  if (action.kind === 'move') {
    ta.setSelectionRange(action.caret, action.caret);
  } else if (action.kind === 'edit') {
    if (action.kill !== null) kill.text = action.kill;
    ta.setSelectionRange(action.from, action.to);
    if (action.insert) document.execCommand('insertText', false, action.insert);
    else document.execCommand('delete');
  }
  return action;
}
