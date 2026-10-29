// Spec 330: raw PTY bytes from `termctrl logs NAME --ansi` → plain text lines
// for the Log view. Krypton's backend does no VT parsing, so this keeps just
// enough state to read a log the way a terminal would show it: `\r` and line
// edits overwrite the open line, colours and controls drop, and full-screen
// apps (alternate screen) become one marker line. Columns count characters,
// with combining marks joined to the one before.

const TAB_STOP = 8;
export const HIDDEN_MARKER = '⟨full-screen app output hidden⟩';
const COMBINING = /^(?:\p{M}|\u200d|[\ufe00-\ufe0f])$/u;

export interface AnsiTextOptions {
  /** After termctrl drops the ring's head, the first line starts mid-way. */
  readonly dropFirstLine?: boolean;
}

export interface AnsiTextChunk {
  /** Lines committed by this read. */
  readonly lines: string[];
  /** The still-open last line. */
  readonly open: string;
}

export interface AnsiText {
  push(bytes: Uint8Array): AnsiTextChunk;
}

type State = 'text' | 'esc' | 'skip1' | 'csi' | 'str' | 'str-esc';

export function createAnsiText(options: AnsiTextOptions = {}): AnsiText {
  const decoder = new TextDecoder('utf-8');
  let state: State = 'text';
  let params = '';
  let line: string[] = [];
  let col = 0;
  let alt = false;
  let dropping = options.dropFirstLine === true;
  let out: string[] = [];

  const commit = (): void => {
    out.push(line.join(''));
    line = [];
    col = 0;
  };

  const put = (ch: string): void => {
    if (COMBINING.test(ch) && col > 0 && col <= line.length) {
      line[col - 1] += ch;
      return;
    }
    while (line.length < col) line.push(' ');
    line[col] = ch;
    col += 1;
  };

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < line.length; i++) line[i] = ' ';
  };

  const csi = (final: string): void => {
    const priv = params.charAt(0) === '?';
    const list = (priv ? params.slice(1) : params).split(';');
    if (priv) {
      const alternate = list.some((p) => p === '1049' || p === '1047' || p === '47');
      if (alternate && final === 'h' && !alt) {
        if (line.length) commit();
        if (!dropping) out.push(HIDDEN_MARKER);
        alt = true;
      } else if (alternate && final === 'l' && alt) {
        alt = false;
        line = [];
        col = 0;
      }
      return;
    }
    if (alt || dropping) return;
    const n = parseInt(list[0], 10);
    const count = isNaN(n) || n < 1 ? 1 : n;
    if (final === 'K') {
      if (isNaN(n) || n === 0) line.length = Math.min(line.length, col);
      else if (n === 1) blank(0, col + 1);
      else line = [];
    } else if (final === 'C') col += count;
    else if (final === 'D') col = Math.max(0, col - count);
    else if (final === 'G') col = count - 1;
    else if (final === 'P') line.splice(col, count);
    else if (final === 'X') blank(col, col + count);
    else if (final === '@' && col < line.length) line.splice(col, 0, ...new Array<string>(count).fill(' '));
    // Everything else, including SGR colour and H/J, is ignored: a clear never
    // erases what the log already holds.
  };

  const feed = (text: string): void => {
    for (const ch of text) {
      if (state === 'esc') {
        if (ch === '[') {
          state = 'csi';
          params = '';
        } else if (ch === ']' || ch === 'P' || ch === '_' || ch === '^' || ch === 'X') state = 'str';
        else if ('()*+#%'.includes(ch)) state = 'skip1';
        else state = 'text';
        continue;
      }
      if (state === 'skip1') {
        state = 'text';
        continue;
      }
      if (state === 'csi') {
        const code = ch.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          csi(ch);
          state = 'text';
        } else if (code === 0x1b) state = 'esc';
        else if (params.length < 64) params += ch;
        continue;
      }
      if (state === 'str') {
        if (ch === '\u0007') state = 'text';
        else if (ch === '\u001b') state = 'str-esc';
        continue;
      }
      if (state === 'str-esc') {
        state = ch === '\\' ? 'text' : ch === '\u001b' ? 'str-esc' : 'str';
        continue;
      }
      if (ch === '\u001b') {
        state = 'esc';
        continue;
      }
      if (alt) continue;
      if (ch === '\n') {
        if (dropping) {
          dropping = false;
          line = [];
          col = 0;
        } else commit();
        continue;
      }
      if (dropping) continue;
      if (ch === '\r') {
        col = 0;
        continue;
      }
      if (ch === '\b') {
        if (col > 0) col -= 1;
        continue;
      }
      if (ch === '\t') {
        col = (Math.floor(col / TAB_STOP) + 1) * TAB_STOP;
        continue;
      }
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) continue;
      put(ch);
    }
  };

  return {
    push(bytes: Uint8Array): AnsiTextChunk {
      out = [];
      feed(decoder.decode(bytes, { stream: true }));
      return { lines: out, open: alt || dropping ? '' : line.join('') };
    },
  };
}
