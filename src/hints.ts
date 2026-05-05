// Krypton — Hint Mode Controller
// Scans the visible terminal buffer for configurable regex patterns,
// overlays keyboard labels on matches, and executes actions when a label
// is selected. Inspired by Rio Terminal hints.

import { invoke } from './profiler/ipc';
import type { Terminal } from '@xterm/xterm';
import type { HintsConfig, HintRule } from './config';

// ─── Types ────────────────────────────────────────────────────────

/** A single match found in the terminal buffer */
interface HintMatch {
  /** Row in the buffer (absolute, not viewport-relative) */
  row: number;
  /** Column offset within the row */
  col: number;
  /** Length of the matched text in characters */
  length: number;
  /** The matched text content */
  text: string;
  /** Which rule produced this match */
  rule: HintRule;
  /** The assigned keyboard label */
  label: string;
}

/** A single match found by the DOM scanner. Coordinates are viewport-relative. */
interface DomHintMatch {
  /** Viewport-relative x of the start of the match (px). */
  viewportX: number;
  /** Viewport-relative y of the start of the match (px). */
  viewportY: number;
  /** The matched text content */
  text: string;
  /** Which rule produced this match */
  rule: HintRule;
  /** The assigned keyboard label */
  label: string;
}

type HintScanMode = 'terminal' | 'dom';

/** Default hints config used when no config is loaded */
const DEFAULT_HINTS_CONFIG: HintsConfig = {
  alphabet: 'asdfghjklqweruiop',
  rules: [
    {
      name: 'url',
      regex: 'https?://[^\\s<>"\\x60{}()\\[\\]]+(?:\\([^\\s<>"\\x60{}()\\[\\]]*\\))*[^\\s<>"\\x60{}()\\[\\]]*',
      action: 'Open',
      enabled: true,
    },
    {
      name: 'filepath',
      regex: '~?/?(?:[\\w@.\\-]+/)+[\\w@.\\-]+',
      action: 'Copy',
      enabled: true,
    },
    {
      name: 'email',
      regex: '[\\w.+\\-]+@[\\w.\\-]+\\.[a-zA-Z]{2,}',
      action: 'Copy',
      enabled: true,
    },
  ],
};

// ─── Label Generator ──────────────────────────────────────────────

/**
 * Generate prefix-free labels from an alphabet.
 * If count <= alphabet.length, returns single-character labels.
 * Otherwise, generates two-character labels as needed.
 */
function generateLabels(alphabet: string, count: number): string[] {
  const chars = [...alphabet];
  const labels: string[] = [];

  if (count <= chars.length) {
    // Single-character labels
    for (let i = 0; i < count; i++) {
      labels.push(chars[i]);
    }
  } else {
    // Need multi-character labels. Use a prefix-free scheme:
    // Reserve some chars as single-char labels, use the rest as prefixes.
    // Simple approach: all labels are two characters.
    for (let i = 0; i < chars.length && labels.length < count; i++) {
      for (let j = 0; j < chars.length && labels.length < count; j++) {
        labels.push(chars[i] + chars[j]);
      }
    }
  }

  return labels;
}

// ─── Hint Controller ──────────────────────────────────────────────

export class HintController {
  private config: HintsConfig = DEFAULT_HINTS_CONFIG;
  private active = false;
  private scanMode: HintScanMode = 'terminal';
  private matches: HintMatch[] = [];
  private domMatches: DomHintMatch[] = [];
  private typedChars = '';
  private overlayEl: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;
  private toastTimeout: ReturnType<typeof setTimeout> | null = null;
  private terminal: Terminal | null = null;
  private terminalContainer: HTMLElement | null = null;

  /** Callbacks for when hint mode should exit */
  private exitCallbacks: Array<() => void> = [];

  /** Register callback for hint mode exit (so InputRouter returns to Normal) */
  onExit(cb: () => void): void {
    this.exitCallbacks.push(cb);
  }

  /** Update config (called when config loads or hot-reloads) */
  applyConfig(config: HintsConfig): void {
    this.config = config;
  }

  /** Whether hint mode is currently active */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Enter hint mode: scan the visible buffer and show overlays.
   * Returns true if hints were found, false if no matches.
   */
  enter(terminal: Terminal): boolean {
    if (this.active) return false;

    this.scanMode = 'terminal';
    this.terminal = terminal;
    this.typedChars = '';

    // Find the positioned container for overlay positioning.
    // For regular panes this is .krypton-pane, for the quick terminal it's .krypton-window__body.
    const xtermEl = terminal.element;
    if (!xtermEl) return false;
    this.terminalContainer = xtermEl.closest('.krypton-pane') as HTMLElement
      ?? xtermEl.closest('.krypton-window__body') as HTMLElement
      ?? null;
    if (!this.terminalContainer) return false;

    // Scan visible buffer for matches
    this.matches = this.scanBuffer(terminal);
    console.log('[HintController] enter: found', this.matches.length, 'matches');

    if (this.matches.length === 0) {
      this.showToast('No hints found');
      return false;
    }

    // Generate labels
    const labels = generateLabels(this.config.alphabet, this.matches.length);
    for (let i = 0; i < this.matches.length; i++) {
      this.matches[i].label = labels[i];
    }
    console.log('[HintController] enter: labels assigned, rendering overlay');

    // Render overlays
    this.renderOverlay(terminal);
    this.active = true;
    return true;
  }

  /**
   * Enter hint mode for a DOM subtree. Walks visible text nodes inside
   * `rootEl`, runs the configured regex rules, and overlays labels.
   * Returns true if at least one match was found.
   */
  enterDom(rootEl: HTMLElement): boolean {
    if (this.active) return false;

    this.scanMode = 'dom';
    this.terminal = null;
    this.terminalContainer = null;
    this.typedChars = '';

    this.domMatches = this.scanDom(rootEl);

    if (this.domMatches.length === 0) {
      this.showToast('No hints found');
      return false;
    }

    const labels = generateLabels(this.config.alphabet, this.domMatches.length);
    for (let i = 0; i < this.domMatches.length; i++) {
      this.domMatches[i].label = labels[i];
    }

    this.renderDomOverlay();
    this.active = true;
    return true;
  }

  /** Exit hint mode and clean up */
  exit(): void {
    this.active = false;
    this.matches = [];
    this.domMatches = [];
    this.typedChars = '';
    this.terminal = null;
    this.terminalContainer = null;
    this.removeOverlay();
  }

  /**
   * Handle a key event while in hint mode.
   * Returns: 'continue' to stay in mode, 'exit' to leave, or 'selected' when an action fires.
   */
  handleKey(e: KeyboardEvent): 'continue' | 'exit' | 'selected' {
    if (!this.active) return 'exit';

    if (e.key === 'Escape') {
      this.exit();
      return 'exit';
    }

    if (e.key === 'Backspace') {
      if (this.typedChars.length > 0) {
        this.typedChars = this.typedChars.slice(0, -1);
        this.updateOverlay();
      }
      return 'continue';
    }

    // Only accept characters that are in the alphabet
    const ch = e.key.toLowerCase();
    if (ch.length !== 1 || !this.config.alphabet.includes(ch)) {
      return 'continue';
    }

    this.typedChars += ch;
    this.updateOverlay();

    // Check for exact match
    const all: Array<{ label: string; text: string; rule: HintRule }> =
      this.scanMode === 'terminal' ? this.matches : this.domMatches;
    const exactMatch = all.find((m) => m.label === this.typedChars);
    if (exactMatch) {
      this.executeActionForText(exactMatch.text, exactMatch.rule);
      this.exit();
      return 'selected';
    }

    // Check if any labels still match the prefix
    const hasPrefix = all.some((m) => m.label.startsWith(this.typedChars));
    if (!hasPrefix) {
      // No labels match — exit
      this.exit();
      return 'exit';
    }

    return 'continue';
  }

  // ─── Buffer Scanning ──────────────────────────────────────────

  /**
   * A "logical line" is one or more buffer rows joined together when the
   * terminal has soft-wrapped a long line. We need this because URLs and
   * file paths often span multiple visual rows.
   */
  private buildLogicalLines(terminal: Terminal): Array<{
    text: string;
    /** The first buffer row of this logical line */
    startRow: number;
    /** Length (in chars) of each constituent buffer row, in order */
    rowLengths: number[];
  }> {
    const buffer = terminal.buffer.active;
    const startRow = buffer.viewportY;
    const endRow = startRow + terminal.rows;
    const result: Array<{ text: string; startRow: number; rowLengths: number[] }> = [];

    let current: { text: string; startRow: number; rowLengths: number[] } | null = null;

    for (let row = startRow; row < endRow; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;

      const text = line.translateToString(false);

      if (line.isWrapped && current) {
        // Continuation of the previous logical line
        current.text += text;
        current.rowLengths.push(text.length);
      } else {
        // Start of a new logical line
        if (current) result.push(current);
        current = { text, startRow: row, rowLengths: [text.length] };
      }
    }
    if (current) result.push(current);

    return result;
  }

  /**
   * Convert a character offset within a logical line back to a buffer
   * row + column, accounting for wrapped rows.
   */
  private offsetToRowCol(
    logicalLine: { startRow: number; rowLengths: number[] },
    offset: number,
  ): { row: number; col: number } {
    let remaining = offset;
    for (let i = 0; i < logicalLine.rowLengths.length; i++) {
      if (remaining < logicalLine.rowLengths[i]) {
        return { row: logicalLine.startRow + i, col: remaining };
      }
      remaining -= logicalLine.rowLengths[i];
    }
    // Fallback: last row
    const lastIdx = logicalLine.rowLengths.length - 1;
    return {
      row: logicalLine.startRow + lastIdx,
      col: logicalLine.rowLengths[lastIdx] - 1,
    };
  }

  private scanBuffer(terminal: Terminal): HintMatch[] {
    const matches: HintMatch[] = [];
    const logicalLines = this.buildLogicalLines(terminal);
    const enabledRules = this.config.rules.filter((r) => r.enabled);

    for (const ll of logicalLines) {
      for (const rule of enabledRules) {
        let regex: RegExp;
        try {
          regex = new RegExp(rule.regex, 'g');
        } catch {
          console.warn(`[HintController] Invalid regex for rule "${rule.name}": ${rule.regex}`);
          continue;
        }

        let match: RegExpExecArray | null;
        while ((match = regex.exec(ll.text)) !== null) {
          if (match[0].length === 0) {
            regex.lastIndex++;
            continue;
          }

          // Post-process: strip trailing punctuation that is likely not part
          // of the match (markdown, prose artifacts)
          let text = match[0];
          text = this.stripTrailingPunctuation(text);
          if (text.length === 0) continue;

          const { row, col } = this.offsetToRowCol(ll, match.index);

          matches.push({
            row,
            col,
            length: text.length,
            text,
            rule,
            label: '',
          });
        }
      }
    }

    return this.deduplicateMatches(matches);
  }

  /**
   * Strip trailing characters that are commonly not part of URLs/paths
   * but get captured by greedy regexes (markdown syntax, trailing commas, etc.).
   * Also balances parentheses: if URL has unbalanced closing `)`, strip it
   * (common in markdown `[text](url)`).
   */
  private stripTrailingPunctuation(text: string): string {
    // Strip common trailing chars that aren't part of URLs
    let result = text.replace(/[)>\].,;:!?'"]+$/, '');

    // But if there are balanced parens in the URL (e.g., Wikipedia links),
    // we should keep them. Re-add closing parens if they're balanced.
    const openCount = (result.match(/\(/g) || []).length;
    const closeCount = (result.match(/\)/g) || []).length;
    if (openCount > closeCount) {
      // Check if the original text had matching closing parens we stripped
      const stripped = text.slice(result.length);
      for (const ch of stripped) {
        if (ch === ')' && openCount > (result.match(/\)/g) || []).length) {
          result += ch;
        } else {
          break;
        }
      }
    }

    return result;
  }

  private deduplicateMatches(matches: HintMatch[]): HintMatch[] {
    // Sort by row, then col
    matches.sort((a, b) => a.row - b.row || a.col - b.col);

    const result: HintMatch[] = [];
    for (const m of matches) {
      const last = result[result.length - 1];
      if (last && last.row === m.row && last.col + last.length > m.col) {
        // Overlapping — keep the longer one
        if (m.length > last.length) {
          result[result.length - 1] = m;
        }
      } else {
        result.push(m);
      }
    }
    return result;
  }

  // ─── Overlay Rendering ────────────────────────────────────────

  private renderOverlay(terminal: Terminal): void {
    this.removeOverlay();

    const container = this.terminalContainer;
    if (!container) return;

    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'krypton-hint-overlay';

    // Compute cell dimensions from the xterm screen element
    const screenEl = container.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screenEl) return;
    const rect = screenEl.getBoundingClientRect();
    const cellWidth = rect.width / terminal.cols;
    const cellHeight = rect.height / terminal.rows;
    const viewportY = terminal.buffer.active.viewportY;

    for (const m of this.matches) {
      const hintEl = document.createElement('div');
      hintEl.className = 'krypton-hint';

      const x = m.col * cellWidth;
      const y = (m.row - viewportY) * cellHeight;
      hintEl.style.left = `${x}px`;
      hintEl.style.top = `${y}px`;

      const labelEl = document.createElement('span');
      labelEl.className = 'krypton-hint__label';
      labelEl.textContent = m.label;
      hintEl.appendChild(labelEl);

      hintEl.dataset.label = m.label;
      this.overlayEl.appendChild(hintEl);
    }

    container.appendChild(this.overlayEl);
  }

  private updateOverlay(): void {
    if (!this.overlayEl) return;

    const hints = this.overlayEl.querySelectorAll('.krypton-hint');
    for (const hint of hints) {
      const hintEl = hint as HTMLElement;
      const label = hintEl.dataset.label ?? '';
      const labelSpan = hintEl.querySelector('.krypton-hint__label') as HTMLElement | null;
      if (!labelSpan) continue;

      if (this.typedChars.length > 0 && !label.startsWith(this.typedChars)) {
        // This hint doesn't match — dim it
        hintEl.classList.add('krypton-hint--dimmed');
      } else {
        hintEl.classList.remove('krypton-hint--dimmed');

        // Render with matched/unmatched character styling
        labelSpan.innerHTML = '';
        for (let i = 0; i < label.length; i++) {
          const span = document.createElement('span');
          span.textContent = label[i];
          if (i < this.typedChars.length) {
            span.className = 'krypton-hint__label-matched';
          }
          labelSpan.appendChild(span);
        }
      }
    }
  }

  private removeOverlay(): void {
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }

  // ─── DOM Scanner ──────────────────────────────────────────────

  /**
   * Walk visible text nodes inside `rootEl`, run the configured regex rules,
   * and return matches with viewport-relative coordinates.
   */
  private scanDom(rootEl: HTMLElement): DomHintMatch[] {
    const containerRect = rootEl.getBoundingClientRect();
    const enabledRules = this.config.rules.filter((r) => r.enabled);
    if (enabledRules.length === 0) return [];

    const SKIP_SELECTOR =
      'input, textarea, [contenteditable=""], [contenteditable="true"], script, style, [aria-hidden="true"], .krypton-hint-overlay, .krypton-hint, .krypton-hint-toast';

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        // Skip hidden subtrees (display:none, visibility:hidden ancestor).
        if (parent.offsetParent === null && parent.tagName !== 'BODY') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!(node.textContent ?? '').trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const results: DomHintMatch[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
      const text = node.textContent ?? '';
      for (const rule of enabledRules) {
        let regex: RegExp;
        try {
          regex = new RegExp(rule.regex, 'g');
        } catch {
          console.warn(`[HintController] Invalid regex for rule "${rule.name}": ${rule.regex}`);
          continue;
        }

        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
          if (m[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          let matched = m[0];
          matched = this.stripTrailingPunctuation(matched);
          if (matched.length === 0) continue;

          const range = document.createRange();
          try {
            range.setStart(node, m.index);
            range.setEnd(node, m.index + matched.length);
          } catch {
            continue;
          }
          const rects = range.getClientRects();
          if (rects.length === 0) continue;
          const rect = rects[0];
          if (rect.width === 0 || rect.height === 0) continue;

          // Visibility filter: keep only matches whose first rect is inside
          // the container's viewport rect. A small slack handles sub-pixel
          // rounding at the edges.
          const slack = 2;
          if (
            rect.bottom < containerRect.top - slack ||
            rect.top > containerRect.bottom + slack ||
            rect.right < containerRect.left - slack ||
            rect.left > containerRect.right + slack
          ) {
            continue;
          }

          results.push({
            viewportX: rect.left,
            viewportY: rect.top,
            text: matched,
            rule,
            label: '',
          });
        }
      }
      node = walker.nextNode();
    }

    // Sort by visual top-to-bottom, left-to-right so labels read sensibly.
    results.sort((a, b) => a.viewportY - b.viewportY || a.viewportX - b.viewportX);
    return results;
  }

  /**
   * Render label overlays for DOM matches. The overlay is appended to
   * document.body and uses position: fixed so it stacks above the view
   * without requiring a positioned ancestor.
   */
  private renderDomOverlay(): void {
    this.removeOverlay();

    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'krypton-hint-overlay krypton-hint-overlay--dom';
    this.overlayEl.style.position = 'fixed';
    this.overlayEl.style.top = '0';
    this.overlayEl.style.left = '0';
    this.overlayEl.style.width = '100%';
    this.overlayEl.style.height = '100%';
    this.overlayEl.style.pointerEvents = 'none';
    this.overlayEl.style.zIndex = '999';

    for (const m of this.domMatches) {
      const hintEl = document.createElement('div');
      hintEl.className = 'krypton-hint';
      hintEl.style.position = 'absolute';
      hintEl.style.left = `${m.viewportX}px`;
      hintEl.style.top = `${m.viewportY}px`;

      const labelEl = document.createElement('span');
      labelEl.className = 'krypton-hint__label';
      labelEl.textContent = m.label;
      hintEl.appendChild(labelEl);
      hintEl.dataset.label = m.label;
      this.overlayEl.appendChild(hintEl);
    }

    document.body.appendChild(this.overlayEl);
  }

  // ─── Action Execution ─────────────────────────────────────────

  private executeActionForText(text: string, rule: HintRule): void {
    const action = rule.action;

    switch (action) {
      case 'Copy':
        navigator.clipboard.writeText(text).catch((err) => {
          console.error('[HintController] Failed to copy to clipboard:', err);
        });
        break;

      case 'Open':
        invoke('open_url', { url: text }).catch((err) => {
          console.error('[HintController] Failed to open URL:', err);
        });
        break;

      case 'Paste':
        // Paste only makes sense for terminal panes (writes to the PTY via
        // xterm's paste API which triggers onData). For DOM panes there is
        // no PTY target, so fall back to Copy.
        if (this.scanMode === 'terminal' && this.terminal) {
          this.terminal.paste(text);
        } else {
          navigator.clipboard.writeText(text).catch((err) => {
            console.error('[HintController] Paste fallback (Copy) failed:', err);
          });
        }
        break;
    }
  }

  // ─── Toast Notification ───────────────────────────────────────

  private showToast(message: string): void {
    this.removeToast();

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'krypton-hint-toast';
    this.toastEl.textContent = message;
    document.body.appendChild(this.toastEl);

    // Trigger reflow then show
    requestAnimationFrame(() => {
      if (this.toastEl) {
        this.toastEl.classList.add('krypton-hint-toast--visible');
      }
    });

    this.toastTimeout = setTimeout(() => {
      this.removeToast();
      // Also notify exit since we never entered active mode
      for (const cb of this.exitCallbacks) {
        cb();
      }
    }, 1000);
  }

  private removeToast(): void {
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
      this.toastTimeout = null;
    }
    if (this.toastEl) {
      this.toastEl.remove();
      this.toastEl = null;
    }
  }
}
