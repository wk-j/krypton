import { describe, expect, it } from 'vitest';

import { readlineAction, type ReadlineKey } from './textarea-readline';

function ctrl(code: string, mods: Partial<ReadlineKey> = {}): ReadlineKey {
  return { code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

/** Press ⌃`code` on `marked`, whose `|` is the caret; returns the text with
 *  the new caret marked, and what the key put in the kill buffer. */
function press(code: string, marked: string, killed = ''): { text: string; kill: string | null } {
  const caret = marked.indexOf('|');
  const text = marked.replace('|', '');
  const action = readlineAction(ctrl(code), text, caret, caret, killed);
  if (!action) throw new Error(`⌃${code} is not a readline key`);
  if (action.kind === 'none') return { text: marked, kill: null };
  if (action.kind === 'move') {
    return { text: `${text.slice(0, action.caret)}|${text.slice(action.caret)}`, kill: null };
  }
  const out = text.slice(0, action.from) + action.insert + text.slice(action.to);
  const at = action.from + action.insert.length;
  return { text: `${out.slice(0, at)}|${out.slice(at)}`, kill: action.kill };
}

describe('readline keys on a textarea', () => {
  it('moves to the start and end of the caret line, not of the whole draft', () => {
    expect(press('KeyA', 'one\ntw|o\nthree').text).toBe('one\n|two\nthree');
    expect(press('KeyE', 'one\ntw|o\nthree').text).toBe('one\ntwo|\nthree');
  });

  it('kills to the line edge, and kills the newline when already there, as zsh does', () => {
    expect(press('KeyU', 'one\ntw|o')).toEqual({ text: 'one\n|o', kill: 'tw' });
    expect(press('KeyU', 'one\n|two')).toEqual({ text: 'one|two', kill: '\n' });
    expect(press('KeyK', 'on|e\ntwo')).toEqual({ text: 'on|\ntwo', kill: 'e' });
    expect(press('KeyK', 'one|\ntwo')).toEqual({ text: 'one|two', kill: '\n' });
  });

  it('kills one word back with ⌃W, Thai words included', () => {
    expect(press('KeyW', 'hello wor|ld')).toEqual({ text: 'hello |ld', kill: 'wor' });
    expect(press('KeyW', 'foo bar  |')).toEqual({ text: 'foo |', kill: 'bar  ' });
    expect(press('KeyW', 'กินข้าวหรือยัง|')).toEqual({ text: 'กินข้าวหรือ|', kill: 'ยัง' });
  });

  it('yanks the last kill at the caret, and does nothing with an empty buffer', () => {
    expect(press('KeyY', 'a|b', 'XY').text).toBe('aXY|b');
    expect(press('KeyY', 'a|b').text).toBe('a|b');
  });

  it('transposes the grapheme clusters around the caret, the last two at a line end', () => {
    expect(press('KeyT', 'ab|c').text).toBe('acb|');
    expect(press('KeyT', 'abc|\nx').text).toBe('acb|\nx');
    expect(press('KeyT', 'กข้|').text).toBe('ข้ก|');
  });

  it('steps and forward-deletes whole Thai clusters, while ⌃H removes one mark like Backspace', () => {
    expect(press('KeyB', 'ข้|').text).toBe('|ข้');
    expect(press('KeyD', '|ข้า').text).toBe('|า');
    expect(press('KeyH', 'ข้|').text).toBe('ข|');
  });

  it('leaves ⌃⇧, ⌘ and ⌥ chords and other ⌃ keys to the app', () => {
    expect(readlineAction(ctrl('KeyU', { shiftKey: true }), 'ab', 1, 1, '')).toBeNull();
    expect(readlineAction(ctrl('KeyA', { metaKey: true }), 'ab', 1, 1, '')).toBeNull();
    expect(readlineAction(ctrl('KeyW', { altKey: true }), 'ab', 1, 1, '')).toBeNull();
    expect(readlineAction(ctrl('KeyN'), 'ab', 1, 1, '')).toBeNull();
  });
});
