// Krypton — Harness word autocomplete client (spec 285)
// One shared prompt history for every harness lane (Rust SQLite store) feeds one
// n-gram model in a Web Worker; the composer shows its suffix as ghost text.

import { invoke } from '@tauri-apps/api/core';

export type WordPredictRequest =
  | { type: 'load'; texts: string[] }
  | { type: 'observe'; text: string }
  | { type: 'complete'; id: number; before: string };

export interface WordPredictResponse {
  id: number;
  suffix: string | null;
}

/** A suggestion is valid only for the exact draft/cursor it was computed for. */
export interface GhostSuggestion {
  laneId: string;
  draft: string;
  cursor: number;
  suffix: string;
}

/** Scripts written without spaces between words: Tab must not append one. */
const NO_SPACE_SCRIPT = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD_CHAR = /[\p{L}\p{M}]/u;

/** Worth asking the model: cursor at a line end, right after a word character. */
export function ghostRequestable(draft: string, cursor: number): boolean {
  if (cursor === 0) return false;
  if (cursor !== draft.length && draft[cursor] !== '\n') return false;
  return WORD_CHAR.test(draft[cursor - 1]);
}

/** Insert `suffix` at the cursor; Tab adds a space unless the word's script has none. */
export function acceptGhost(
  draft: string,
  cursor: number,
  suffix: string,
  withSpace: boolean,
): { draft: string; cursor: number } {
  const lastChar = Array.from(suffix).pop() ?? '';
  const insert = withSpace && !NO_SPACE_SCRIPT.test(lastChar) ? `${suffix} ` : suffix;
  return {
    draft: draft.slice(0, cursor) + insert + draft.slice(cursor),
    cursor: cursor + insert.length,
  };
}

/** Typing the ghost's own next characters keeps the rest visible (no flicker). */
export function typeThrough(ghost: GhostSuggestion, draft: string, cursor: number): GhostSuggestion | null {
  if (cursor <= ghost.cursor) return null;
  const head = ghost.draft.slice(0, ghost.cursor);
  const tail = ghost.draft.slice(ghost.cursor);
  if (!draft.startsWith(head) || draft.slice(cursor) !== tail) return null;
  const typed = draft.slice(ghost.cursor, cursor);
  if (typed.length >= ghost.suffix.length || !ghost.suffix.startsWith(typed)) return null;
  return { laneId: ghost.laneId, draft, cursor, suffix: ghost.suffix.slice(typed.length) };
}

let enabled = true;

/** `[acp_harness] word_autocomplete`; applied on startup and Reload Config. */
export function setWordAutocompleteEnabled(value: boolean | undefined): void {
  enabled = value !== false;
}

export function wordAutocompleteEnabled(): boolean {
  return enabled;
}

class WordPredictClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (suffix: string | null) => void>();
  private failed = false;

  predict(before: string): Promise<string | null> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ type: 'complete', id, before } satisfies WordPredictRequest);
    });
  }

  observe(text: string): void {
    this.worker?.postMessage({ type: 'observe', text } satisfies WordPredictRequest);
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.failed) return this.worker;
    try {
      const worker = new Worker(new URL('./word-predict-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<WordPredictResponse>) => {
        const resolve = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        resolve?.(e.data.suffix);
      };
      worker.onerror = (e: ErrorEvent) => {
        console.warn('[word-predict] worker failed; autocomplete off', e.message);
        this.failed = true;
        this.worker = null;
        for (const resolve of this.pending.values()) resolve(null);
        this.pending.clear();
      };
      this.worker = worker;
    } catch (e) {
      console.warn('[word-predict] worker unavailable; autocomplete off', e);
      this.failed = true;
      return null;
    }
    void invoke<string[]>('harness_word_corpus')
      .then((texts) => this.worker?.postMessage({ type: 'load', texts } satisfies WordPredictRequest))
      .catch((e: unknown) => console.warn('[word-predict] corpus load failed', e));
    return this.worker;
  }
}

const client = new WordPredictClient();

export function predictWordSuffix(before: string): Promise<string | null> {
  return client.predict(before);
}

/** Record a submitted prompt in the shared all-lane history; a new row also
 *  teaches the live model immediately. Logging runs even when ghosts are off. */
export async function logHarnessPrompt(text: string, backendId: string | null, cwd: string | null): Promise<void> {
  try {
    const isNew = await invoke<boolean>('harness_prompt_log', { text, backendId, cwd });
    if (isNew) client.observe(text);
  } catch (e) {
    console.warn('[word-predict] prompt history write failed', e);
  }
}
