// Krypton — Harness word-autocomplete model (spec 285)
// Pure unigram + bigram model over the user's prompt history. Words come from
// Intl.Segmenter, so Thai (no inter-word spaces) segments like any other
// language. Runs inside word-predict-worker.ts; kept DOM-free for tests.

interface WordSegment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}

interface WordSegmenter {
  segment(input: string): Iterable<WordSegment>;
}

function createWordSegmenter(): WordSegmenter {
  // lib is ES2021; Intl.Segmenter typings arrive with ES2022.
  const Ctor = (Intl as typeof Intl & {
    Segmenter?: new (locale: string | undefined, options: { granularity: 'word' }) => WordSegmenter;
  }).Segmenter;
  if (!Ctor) throw new Error('Intl.Segmenter unavailable');
  return new Ctor(undefined, { granularity: 'word' });
}

/** Only the tail of a long draft matters for the word at the cursor. */
const TAIL_CHARS = 256;
/** Paths, hashes, and URLs are not vocabulary. */
const MAX_WORD_LENGTH = 40;
/** Prefix must carry at least this many base (non-mark) characters. */
const MIN_PREFIX_CHARS = 2;
/** Contiguous word segments tried as one prefix (Thai partial words may split). */
const MAX_PREFIX_SEGMENTS = 3;
/** Upper bound on keys scanned for one prefix. */
const MAX_SCAN = 5000;
const BIGRAM_WEIGHT = 3;
/** Suggest only when the best word was seen at least this much, */
const MIN_SCORE = 2;
/** owns this share of every word the prefix could still be (the typed prefix
 *  as a finished word included), */
const MIN_SHARE = 0.2;
/** and leads the runner-up by this factor. Tuned on real prompt history:
 *  `thai la` → `language` (23%, 1.3×) shows; `please re` (11%) and ties stay silent. */
const MIN_LEAD = 1.2;

const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const CONTEXT_BREAK = /[\n.!?;:。ฯ]/u;

function baseCharCount(text: string): number {
  let count = 0;
  for (const ch of text) if (!MARK.test(ch)) count += 1;
  return count;
}

function lowerBound(keys: readonly string[], target: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class WordModel {
  private readonly segmenter: WordSegmenter = createWordSegmenter();
  private readonly unigram = new Map<string, number>();
  private readonly bigram = new Map<string, Map<string, number>>();
  private readonly surfaceCount = new Map<string, number>();
  private readonly bestSurface = new Map<string, string>();
  private sortedKeys: string[] | null = null;

  observe(text: string): void {
    let prev: string | null = null;
    for (const seg of this.segmenter.segment(text.normalize('NFC'))) {
      if (!seg.isWordLike) {
        if (CONTEXT_BREAK.test(seg.segment)) prev = null;
        continue;
      }
      const word = seg.segment;
      if (!LETTER.test(word) || word.length > MAX_WORD_LENGTH) {
        prev = null;
        continue;
      }
      const key = word.toLowerCase();
      const seen = this.unigram.get(key);
      if (seen === undefined) this.sortedKeys = null;
      this.unigram.set(key, (seen ?? 0) + 1);
      const surfaceSeen = (this.surfaceCount.get(word) ?? 0) + 1;
      this.surfaceCount.set(word, surfaceSeen);
      const best = this.bestSurface.get(key);
      if (best === undefined || (best !== word && surfaceSeen > (this.surfaceCount.get(best) ?? 0))) {
        this.bestSurface.set(key, word);
      }
      if (prev !== null) {
        let next = this.bigram.get(prev);
        if (!next) {
          next = new Map();
          this.bigram.set(prev, next);
        }
        next.set(key, (next.get(key) ?? 0) + 1);
      }
      prev = key;
    }
  }

  /** Suffix completing the word that ends exactly at the end of `before`, or null. */
  complete(before: string): string | null {
    const tail = before.slice(-TAIL_CHARS).normalize('NFC');
    const segs = Array.from(this.segmenter.segment(tail));
    const last = segs[segs.length - 1];
    if (!last?.isWordLike || last.index + last.segment.length !== tail.length) return null;
    let groupStart = segs.length - 1;
    while (
      groupStart > 0
      && segs.length - groupStart < MAX_PREFIX_SEGMENTS
      && segs[groupStart - 1].isWordLike
    ) {
      groupStart -= 1;
    }
    // Longest joined prefix first: a Thai partial word can arrive split.
    for (let start = groupStart; start < segs.length; start++) {
      const prefix = segs.slice(start).map((s) => s.segment).join('');
      const suffix = this.rank(prefix, this.contextBefore(segs, start));
      if (suffix) return suffix;
    }
    return null;
  }

  private contextBefore(segs: readonly WordSegment[], start: number): string | null {
    for (let i = start - 1; i >= 0; i--) {
      const seg = segs[i];
      if (seg.isWordLike) return LETTER.test(seg.segment) ? seg.segment.toLowerCase() : null;
      if (CONTEXT_BREAK.test(seg.segment) || seg.segment.trim() !== '') return null;
    }
    return null;
  }

  private rank(prefix: string, prev: string | null): string | null {
    if (baseCharCount(prefix) < MIN_PREFIX_CHARS) return null;
    const p = prefix.toLowerCase();
    const keys = this.keys();
    const context = prev === null ? undefined : this.bigram.get(prev);
    let best: string | null = null;
    let bestScore = 0;
    let runnerUp = 0;
    let total = 0;
    const from = lowerBound(keys, p);
    for (let i = from; i < keys.length && i - from < MAX_SCAN && keys[i].startsWith(p); i++) {
      const key = keys[i];
      const score = (this.unigram.get(key) ?? 0) + BIGRAM_WEIGHT * (context?.get(key) ?? 0);
      // The typed prefix as a finished word competes for share but is never offered.
      total += score;
      if (key.length === p.length) continue;
      if (score > bestScore) {
        runnerUp = bestScore;
        bestScore = score;
        best = key;
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
    if (
      best === null
      || bestScore < MIN_SCORE
      || bestScore / total < MIN_SHARE
      || bestScore < MIN_LEAD * runnerUp
    ) {
      return null;
    }
    const surface = this.bestSurface.get(best) ?? best;
    const suffix = surface.toLowerCase().startsWith(p) && surface.length === best.length
      ? surface.slice(p.length)
      : best.slice(p.length);
    return suffix || null;
  }

  private keys(): string[] {
    if (!this.sortedKeys) this.sortedKeys = Array.from(this.unigram.keys()).sort();
    return this.sortedKeys;
  }
}
