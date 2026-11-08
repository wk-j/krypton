// Krypton — Textarea caret-position helper
// Ported from https://github.com/component/textarea-caret-position (MIT).
// Returns pixel coordinates of the caret inside a textarea using a mirrored
// div that reproduces the textarea's typography and wrapping behavior.

const MIRRORED_PROPS = [
  'direction',
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'MozTabSize',
] as const;

export interface CaretCoordinates {
  top: number;
  left: number;
  height: number;
}

/** Where a run of the textarea's text is drawn: its inline box (the glyphs'
 *  content area, not the line box), unrounded, relative to the textarea's
 *  border box, scroll subtracted. */
export interface TextRangeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A hidden div laid out like `element`, holding its text split around a span
 *  that starts at `start`. The span holds `element.value.slice(start, end)`
 *  and the rest of the text follows it, so the span wraps where the textarea
 *  wraps. Without `end` the span holds everything from `start` on. */
function mirror(
  element: HTMLTextAreaElement,
  computed: CSSStyleDeclaration,
  start: number,
  end?: number,
): { div: HTMLDivElement; span: HTMLSpanElement } {
  const div = document.createElement('div');
  div.id = 'krypton-caret-mirror';
  document.body.appendChild(div);

  const style = div.style;
  style.whiteSpace = 'pre-wrap';
  style.overflowWrap = 'break-word';
  style.position = 'absolute';
  style.visibility = 'hidden';
  style.top = '0';
  style.left = '-9999px';

  const styleBag = style as unknown as Record<string, string>;
  const computedBag = computed as unknown as Record<string, string>;
  for (const prop of MIRRORED_PROPS) {
    styleBag[prop] = computedBag[prop];
  }

  const value = element.value;
  div.textContent = value.substring(0, start);
  const span = document.createElement('span');
  div.appendChild(span);
  if (end === undefined) {
    span.textContent = value.substring(start) || '.';
  } else {
    span.textContent = value.substring(start, end);
    div.appendChild(document.createTextNode(value.substring(end)));
  }
  return { div, span };
}

export function getCaretCoordinates(
  element: HTMLTextAreaElement,
  position: number,
): CaretCoordinates {
  const computed = window.getComputedStyle(element);
  const { div, span } = mirror(element, computed, position);

  const coordinates: CaretCoordinates = {
    top:
      span.offsetTop +
      parseInt(computed.borderTopWidth, 10) -
      element.scrollTop,
    left:
      span.offsetLeft +
      parseInt(computed.borderLeftWidth, 10) -
      element.scrollLeft,
    height: parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10),
  };

  document.body.removeChild(div);
  return coordinates;
}

/** The box of `element.value.slice(start, end)`, which must not wrap. Unlike
 *  `getCaretCoordinates` nothing is rounded, so a copy of the text placed at
 *  this box covers the textarea's own glyphs exactly. */
export function getTextRangeBox(
  element: HTMLTextAreaElement,
  start: number,
  end: number,
): TextRangeBox {
  const computed = window.getComputedStyle(element);
  const { div, span } = mirror(element, computed, start, end);
  const outer = div.getBoundingClientRect();
  const inner = span.getBoundingClientRect();
  document.body.removeChild(div);
  return {
    left: inner.left - outer.left - element.scrollLeft,
    top: inner.top - outer.top - element.scrollTop,
    width: inner.width,
    height: inner.height,
  };
}
