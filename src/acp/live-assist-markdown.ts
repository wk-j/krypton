// Live Assist conversation markdown.
//
// Assistant rows share the Harness marked / streaming-markdown pipeline
// (spec 117) so the popup shows the same formatting as the full Harness.
// User, thought, and activity rows stay plain text.

import * as smd from 'streaming-markdown';

import {
  agentLinkOpenAction,
  hasMarkdownTable,
  makeSafeRenderer,
  md,
  rerenderAssistantMarkdownWithMarked,
  resolveLocalImageSrcs,
  sanitizeHref,
  sanitizeSrc,
} from './harness-markdown';

export { agentLinkOpenAction };

const STREAM_CLASS = 'live-assist__message-body--stream-markdown';
const MARKDOWN_CLASS = 'live-assist__message-body--markdown';

export function liveAssistUsesMarkdown(kind: string): boolean {
  return kind === 'assistant' || kind === 'message_chunk';
}

export function liveAssistMarkdownHtml(text: string): string {
  return md.parse(text, { async: false }) as string;
}

export function parkLiveAssistCaret(body: HTMLElement): HTMLElement | null {
  const caret = body.querySelector<HTMLElement>('.live-assist__stream-caret');
  caret?.remove();
  return caret;
}

export function beginLiveAssistMarkdown(body: HTMLElement, text: string): smd.Parser {
  body.replaceChildren();
  body.classList.add(MARKDOWN_CLASS, STREAM_CLASS);
  const parser = smd.parser(makeSafeRenderer(body));
  if (text) writeParser(parser, text);
  body.dataset.mdSource = text;
  return parser;
}

export function writeLiveAssistMarkdown(
  parser: smd.Parser,
  body: HTMLElement,
  chunk: string,
  nextSource: string,
): void {
  if (!chunk) {
    body.dataset.mdSource = nextSource;
    return;
  }
  const caret = parkLiveAssistCaret(body);
  writeParser(parser, chunk);
  body.dataset.mdSource = nextSource;
  if (caret) body.appendChild(caret);
}

export function sealLiveAssistMarkdown(
  parser: smd.Parser,
  body: HTMLElement,
  text: string,
  cwd: string | null,
): void {
  parkLiveAssistCaret(body);
  const written = body.dataset.mdSource?.length ?? 0;
  if (text.length > written) writeParser(parser, text.slice(written));
  try {
    smd.parser_end(parser);
  } catch (error) {
    console.warn('[live-assist] parser_end failed', error);
  }
  if (hasMarkdownTable(text)) {
    rerenderAssistantMarkdownWithMarked(body, text, cwd);
  } else {
    resolveImages(body, cwd);
  }
  sanitizeRenderedMarkdown(body);
  body.classList.remove(STREAM_CLASS);
  body.dataset.mdSource = text;
}

export function renderLiveAssistMarkdown(
  body: HTMLElement,
  text: string,
  cwd: string | null,
): void {
  if (
    body.dataset.mdSource === text
    && body.childNodes.length > 0
    && !body.classList.contains(STREAM_CLASS)
  ) {
    return;
  }
  body.classList.add(MARKDOWN_CLASS);
  body.classList.remove(STREAM_CLASS);
  try {
    body.innerHTML = liveAssistMarkdownHtml(text);
  } catch (error) {
    console.warn('[live-assist] marked parse failed', error);
    body.textContent = text;
    body.dataset.mdSource = text;
    return;
  }
  sanitizeRenderedMarkdown(body);
  resolveImages(body, cwd);
  body.dataset.mdSource = text;
}

export function isUnsafeMarkdownAttribute(name: string): boolean {
  return /^on/i.test(name);
}

export function sanitizeRenderedMarkdown(body: HTMLElement): void {
  for (const node of Array.from(body.querySelectorAll('*'))) {
    for (const attribute of Array.from(node.attributes)) {
      if (isUnsafeMarkdownAttribute(attribute.name)) {
        node.removeAttribute(attribute.name);
      }
    }
  }
  for (const anchor of Array.from(body.querySelectorAll('a[href]'))) {
    anchor.setAttribute('href', sanitizeHref(anchor.getAttribute('href') ?? ''));
  }
  for (const image of Array.from(body.querySelectorAll('img[src]'))) {
    const src = image.getAttribute('src') ?? '';
    // Already-resolved asset URLs must not go through sanitizeSrc — `asset:`
    // is not in the markdown allowlist and would be stripped.
    if (/^(https?:|data:|asset:|blob:|file:)/i.test(src) || src.startsWith('//')) continue;
    const safe = sanitizeSrc(src);
    if (safe === null) image.removeAttribute('src');
    else image.setAttribute('src', safe);
  }
}

function writeParser(parser: smd.Parser, chunk: string): void {
  try {
    smd.parser_write(parser, chunk);
  } catch (error) {
    console.warn('[live-assist] parser_write failed', error);
  }
}

function resolveImages(body: HTMLElement, cwd: string | null): void {
  try {
    resolveLocalImageSrcs(body, cwd);
  } catch (error) {
    console.warn('[live-assist] local image resolve failed', error);
  }
}
