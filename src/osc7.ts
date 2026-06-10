// OSC 7 working-directory reporting.
//
// Shells configured to report their cwd emit, on every prompt (bash
// PROMPT_COMMAND, zsh precmd, fish fish_prompt), the escape sequence:
//
//   ESC ] 7 ; file://<hostname>/<path>  (terminated by BEL or ESC \)
//
// This is the event-driven signal that a `cd` happened — far better than
// polling the shell process. The hostname is non-empty for remote shells
// (SSH), which lets callers distinguish a local cwd update from a remote one.
//
// PTY output arrives in arbitrarily-sized chunks, so a sequence can be split
// across two reads. Streaming callers should carry the trailing partial across
// chunks using `trailingEscStart` (see `pty-bridge.ts`).

export interface Osc7Cwd {
  /** URI authority — empty for local shells, the remote host for SSH shells. */
  hostname: string;
  /** Absolute path the shell reported as its current working directory. */
  path: string;
}

/**
 * Scan a raw PTY output chunk for OSC 7 sequences and return every cwd report
 * found, in order. Callers that only want the current directory should use the
 * last entry (a single chunk can carry more than one prompt).
 */
export function parseOsc7Sequences(data: number[]): Osc7Cwd[] {
  const results: Osc7Cwd[] = [];
  // OSC 7 start: ESC ] 7 ;  →  0x1b 0x5d 0x37 0x3b
  for (let i = 0; i <= data.length - 4; i++) {
    if (data[i] !== 0x1b || data[i + 1] !== 0x5d || data[i + 2] !== 0x37 || data[i + 3] !== 0x3b) {
      continue;
    }
    // Collect until BEL (0x07) or ST (ESC \ → 0x1b 0x5c).
    let end = -1;
    for (let j = i + 4; j < data.length; j++) {
      if (data[j] === 0x07) {
        end = j;
        break;
      }
      if (data[j] === 0x1b && j + 1 < data.length && data[j + 1] === 0x5c) {
        end = j;
        break;
      }
    }
    if (end <= i + 4) continue;
    const uri = new TextDecoder().decode(new Uint8Array(data.slice(i + 4, end)));
    // file://<hostname>/<path> — hostname may be empty (file:///path).
    const match = uri.match(/^file:\/\/([^/]*)(\/.*)$/);
    if (match) {
      // PTY output is untrusted: a malformed percent-escape makes
      // decodeURIComponent throw, which must not escape the caller's listener.
      try {
        results.push({
          hostname: decodeURIComponent(match[1]),
          path: decodeURIComponent(match[2]),
        });
      } catch {
        /* ignore a malformed OSC 7 URI */
      }
    }
    i = end; // resume past this sequence
  }
  return results;
}

/**
 * Index of a trailing escape sequence that has no terminator within `data`, or
 * -1 if the chunk ends cleanly. A streaming caller carries `data.slice(idx)`
 * into the next chunk so an OSC 7 split across reads is still parsed. We anchor
 * on the last ESC (0x1b) rather than the 4-byte OSC 7 prefix so a split landing
 * mid-prefix (e.g. chunk ends `…ESC ]`) is also carried.
 */
export function trailingEscStart(data: number[]): number {
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] !== 0x1b) continue;
    // Terminated within this chunk? Then nothing to carry.
    for (let j = i + 1; j < data.length; j++) {
      if (data[j] === 0x07) return -1;
      if (data[j] === 0x1b && j + 1 < data.length && data[j + 1] === 0x5c) return -1;
    }
    return i;
  }
  return -1;
}
