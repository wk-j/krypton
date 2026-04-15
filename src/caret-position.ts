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

export function getCaretCoordinates(
  element: HTMLTextAreaElement,
  position: number,
): CaretCoordinates {
  const div = document.createElement('div');
  div.id = 'krypton-caret-mirror';
  document.body.appendChild(div);

  const style = div.style;
  const computed = window.getComputedStyle(element);

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

  div.textContent = element.value.substring(0, position);

  const span = document.createElement('span');
  span.textContent = element.value.substring(position) || '.';
  div.appendChild(span);

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
