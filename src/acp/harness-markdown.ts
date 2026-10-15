// Krypton — ACP Harness View: markdown rendering & URL sanitisation.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Owns the shared
// `marked` instance, the safe streaming-markdown (smd) renderer `AssistantRow`
// installs, and the URL allowlist that keeps agent-authored markdown from
// navigating the single app webview. Spec 301 phase 3 moved the per-row
// streaming body writers into `AssistantRow`, `UserRow` and `ThoughtRow`.

import { Marked, type Token } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import * as smd from 'streaming-markdown';
import { convertFileSrc } from '@tauri-apps/api/core';

export const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

// Spec 117 sanitisation. streaming-markdown@0.2.15 has no HTML tag tokens
// (raw HTML in markdown source is written via document.createTextNode in the
// default renderer, which is XSS-safe), so the only attack surface is URL
// schemes on LINK / RAW_URL / IMAGE attrs. We allowlist common schemes for
// HREF/SRC; everything else falls back to '#' (href) or drops the attribute
// (src). Normalisation strips leading/trailing whitespace and ASCII control
// chars (0x00-0x1F, 0x7F) — these are the classic bypass vectors.
const CTRL_RE = /[\x00-\x1F\x7F]/g;

export function normalizeUrl(value: string): string {
  return value.replace(CTRL_RE, '').trim();
}

function isSafeRelative(value: string): boolean {
  if (value === '') return true;
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return true;
  }
  return false;
}

export function sanitizeHref(value: string): string {
  const v = normalizeUrl(value);
  if (isSafeRelative(v)) return v;
  const colon = v.indexOf(':');
  if (colon === -1) return v; // bare token, treat as relative
  const scheme = v.slice(0, colon).toLowerCase();
  // `file:` remains inert on click (agentLinkOpenAction suppresses it), but is
  // retained in the sealed DOM so spec 206 can classify it as a file resource.
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'file') return v;
  return '#';
}

export function sanitizeSrc(value: string): string | null {
  const v = normalizeUrl(value);
  if (isSafeRelative(v)) return v;
  const colon = v.indexOf(':');
  if (colon === -1) return v;
  const scheme = v.slice(0, colon).toLowerCase();
  if (scheme === 'http' || scheme === 'https') return v;
  return null;
}

/** Decide what a click on a transcript anchor does. The chrome never creates
 *  <a> elements, so every anchor in this view is agent-rendered markdown — and
 *  the single app webview must never navigate away, so every click is
 *  intercepted: http/https/mailto always open in the OS browser; anything else
 *  (sanitizeHref '#' fallbacks, fragments, relative paths) is suppressed. */
export function agentLinkOpenAction(href: string): 'external' | 'suppress' {
  return /^(https?|mailto):/i.test(normalizeUrl(href)) ? 'external' : 'suppress';
}

/** Resolve local <img src> in a rendered transcript body to Tauri asset URLs so
 *  agent-generated images load inside the webview. Agents (e.g. Grok's image_gen)
 *  emit markdown `![alt](/abs/path.jpg)` with a bare absolute filesystem path; the
 *  webview origin can't fetch raw FS paths, so they show as broken-image boxes.
 *  convertFileSrc() maps an on-disk path under the assetProtocol scope ($HOME/**)
 *  to a loadable asset URL. Idempotent: already-resolved / remote / data sources
 *  are skipped, so it is safe to re-run on cached HTML across re-renders.
 *  Unlike markdown-view's rewriter, a leading "/" is treated as a TRUE absolute
 *  path (agent output), not as a cwd-root-relative path. */
export function resolveLocalImageSrcs(root: HTMLElement, cwd: string | null): void {
  const imgs = root.querySelectorAll('img[src]');
  for (const img of Array.from(imgs) as HTMLImageElement[]) {
    const src = img.getAttribute('src') ?? '';
    // Leave remote / data / already-resolved sources untouched (also keeps the
    // pass idempotent on cached HTML that was rewritten on a prior render).
    if (/^(https?:|data:|asset:|blob:|file:)/i.test(src) || src.startsWith('//')) continue;

    // Strip ?query / #fragment before FS resolution.
    const raw = src.replace(/[?#].*$/, '');
    if (!raw) continue;

    let abs: string;
    if (raw.startsWith('/')) {
      abs = raw; // true absolute path from the agent
    } else if (cwd) {
      // Relative path — resolve against the lane's project dir.
      const joined = `${cwd}/${raw}`;
      const parts: string[] = [];
      for (const seg of joined.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
      }
      abs = '/' + parts.join('/');
    } else {
      continue; // relative path with no base — cannot resolve
    }

    const original = src;
    img.src = convertFileSrc(abs);
    img.addEventListener(
      'error',
      () => {
        const breach = document.createElement('span');
        breach.className = 'acp-harness__img-breach';
        breach.textContent = `IMG BREACH // ${original}`;
        img.replaceWith(breach);
      },
      { once: true },
    );
  }
}

export function makeSafeRenderer(root: HTMLElement): smd.Default_Renderer {
  const base = smd.default_renderer(root);
  return {
    data: base.data,
    add_token: base.add_token,
    end_token: base.end_token,
    // smd's default creates one Text node per call, and streamed chunks often
    // split a base letter from its combining marks (Thai ่ ั ิ, Latin e+U+0301).
    // WebKit shapes each Text node alone, so the marks lose their anchor and
    // render displaced with a gap. Extend the trailing Text node instead.
    add_text: (data, text) => {
      const parent = data.nodes[data.index];
      const last = parent.lastChild;
      if (last?.nodeType === Node.TEXT_NODE) (last as Text).appendData(text);
      else parent.appendChild(document.createTextNode(text));
    },
    set_attr: (data, type, value) => {
      if (type === smd.HREF) {
        base.set_attr(data, type, sanitizeHref(value));
      } else if (type === smd.SRC) {
        const safe = sanitizeSrc(value);
        if (safe !== null) base.set_attr(data, type, safe);
      } else {
        base.set_attr(data, type, value);
      }
    },
  };
}

/** Marks the parser-owned body of a still-streaming assistant row. Unlike
 *  `--stream-markdown` it is removed at seal; spec 283 collapses a ```svg
 *  fence to a placeholder only while it is present, until its live card draws. */
export const STREAMING_MARKDOWN_LIVE_CLASS = 'acp-harness__msg-body--stream-live';

// Spec 117 table guard. The seal used to swap every table-bearing message to
// marked because an older streaming-markdown desynced its table state when a
// chunk boundary landed mid-table. smd 0.2.15 renders GFM tables identically at
// every chunk boundary, so a blanket swap only rebuilt the whole message body at
// turn end (a visible repaint). Seal now keeps smd's DOM and falls back to marked
// only when smd dropped a table marked would render (e.g. a table without outer
// pipes, which smd does not recognise).
// The guard matches a GFM delimiter row (the |---|---| line under the header)
// with at least two columns.
const MARKDOWN_TABLE_DELIMITER =
  /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m;

export function hasMarkdownTable(text: string): boolean {
  return MARKDOWN_TABLE_DELIMITER.test(text);
}

function countTableTokens(tokens: readonly Token[]): number {
  let count = 0;
  for (const token of tokens) {
    if (token.type === 'table') count++;
    else if (token.type === 'list') {
      for (const listItem of token.items) count += countTableTokens(listItem.tokens);
    } else if (token.type === 'blockquote' && token.tokens) count += countTableTokens(token.tokens);
  }
  return count;
}

/** True when the smd-rendered `body` holds fewer tables than marked finds in
 *  `text` — the only case where the seal must re-render with marked. */
export function streamingMarkdownDroppedTable(body: HTMLElement, text: string): boolean {
  if (!hasMarkdownTable(text)) return false;
  let expected: number;
  try {
    expected = countTableTokens(md.lexer(text));
  } catch (e) {
    console.warn('[spec117] table guard lex failed; keeping stream output', e);
    return false;
  }
  return body.querySelectorAll('table').length < expected;
}

// Re-render assistant markdown into `body` with marked (robust GFM tables),
// preserving a leading lane-mail provenance node the streaming body may carry.
// On parse failure the existing streaming-markdown body is left untouched.
export function rerenderAssistantMarkdownWithMarked(
  body: HTMLElement,
  text: string,
  projectDir: string | null,
  resolveLocalImages = true,
): void {
  const prov = body.querySelector<HTMLElement>(
    ':scope > .acp-harness__lane-mail-provenance',
  );
  let html: string;
  try {
    html = md.parse(text, { async: false }) as string;
  } catch (e) {
    console.warn('[spec117] marked table re-render failed; keeping stream output', e);
    return;
  }
  body.innerHTML = html;
  if (prov) body.insertBefore(prov, body.firstChild);
  if (resolveLocalImages) resolveLocalImageSrcs(body, projectDir);
}

/** Spec 216: peek thought uses the same marked GFM as sealed assistant rows. */
export function peekThoughtMarkdownHtml(text: string): string {
  return md.parse(text, { async: false }) as string;
}

export function renderPeekThoughtMarkdown(
  body: HTMLElement,
  text: string,
  projectDir: string | null = null,
): void {
  body.classList.remove(
    'acp-harness__msg-body--thought-veil',
    'acp-harness__msg-body--stream-plain',
  );
  body.classList.add('acp-harness__msg-body--markdown');
  if (body.dataset.peekSrc === text && body.childNodes.length > 0) return;
  try {
    body.innerHTML = peekThoughtMarkdownHtml(text);
  } catch (e) {
    console.warn('[spec216] peek thought markdown parse failed', e);
    body.textContent = text;
    body.dataset.peekSrc = text;
    return;
  }
  resolveLocalImageSrcs(body, projectDir);
  body.dataset.peekSrc = text;
}

// Veiled thinking: providers that keep reasoning server-side (Claude Code on
// current Opus models) stream thought deltas whose text is EMPTY — the model
// is thinking, but the content never reaches the client. Instead of an empty
// body, show a small text animation ("thinking" + pulsing dots). The row is
// dropped at seal (dropVeiledThoughtRow) if no text ever arrived, so the veil
// only ever exists on a streaming row.
export function installThoughtVeil(body: HTMLElement): void {
  if (body.classList.contains('acp-harness__msg-body--thought-veil')) return;
  body.classList.remove('acp-harness__msg-body--stream-plain');
  body.classList.add('acp-harness__msg-body--thought-veil');
  const veil = document.createElement('span');
  veil.className = 'acp-harness__thought-veil';
  const word = document.createElement('span');
  word.className = 'acp-harness__thought-veil-word';
  word.textContent = 'thinking';
  veil.appendChild(word);
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'acp-harness__thought-veil-dot';
    dot.textContent = '·';
    veil.appendChild(dot);
  }
  body.replaceChildren(veil);
}

