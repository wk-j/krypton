import { describe, expect, it } from 'vitest';

import {
  DICTATION_LANG_ENGLISH,
  DICTATION_LANG_THAI,
  collectDictationResults,
  combineDictationText,
  dictationErrorMessage,
  dictationLanguageFromShift,
  dictationLanguageLabel,
  dictationPreviewParts,
  insertDictationText,
  speechRecognitionConstructor,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultLike,
} from './harness-dictation';

function recognitionResult(transcript: string, isFinal: boolean): SpeechRecognitionResultLike {
  return Object.assign([{ transcript }], { isFinal }) as SpeechRecognitionResultLike;
}

function recognitionEvent(
  results: SpeechRecognitionResultLike[],
  resultIndex = 0,
): SpeechRecognitionEventLike {
  return { results, resultIndex } as unknown as SpeechRecognitionEventLike;
}

class FakeRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = '';
  onstart: ((event: Event) => void) | null = null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror = null;
  onend: ((event: Event) => void) | null = null;
  start(): void {}
  stop(): void {}
  abort(): void {}
}

describe('speechRecognitionConstructor', () => {
  it('prefers the standard constructor and falls back to WebKit', () => {
    class StandardRecognition extends FakeRecognition {}
    class WebKitRecognition extends FakeRecognition {}
    expect(speechRecognitionConstructor({
      SpeechRecognition: StandardRecognition,
      webkitSpeechRecognition: WebKitRecognition,
    })).toBe(StandardRecognition);
    expect(speechRecognitionConstructor({ webkitSpeechRecognition: WebKitRecognition }))
      .toBe(WebKitRecognition);
  });

  it('returns null for unsupported runtimes', () => {
    expect(speechRecognitionConstructor({})).toBeNull();
    expect(speechRecognitionConstructor(null)).toBeNull();
  });
});

describe('collectDictationResults', () => {
  it('reconstructs final and replaceable interim portions from the whole list', () => {
    const first = collectDictationResults(recognitionEvent([
      recognitionResult('สวัสดี ', true),
      recognitionResult('ชาวโลก', false),
    ], 1));
    const replacement = collectDictationResults(recognitionEvent([
      recognitionResult('สวัสดี ', true),
      recognitionResult('ทุกคน', false),
    ], 1));
    expect(first).toEqual({ finalText: 'สวัสดี ', interimText: 'ชาวโลก' });
    expect(replacement).toEqual({ finalText: 'สวัสดี ', interimText: 'ทุกคน' });
  });
});

describe('dictation text insertion', () => {
  it('inserts at the saved cursor with readable boundary spacing', () => {
    expect(insertDictationText('explainmigration', 7, 'the old rows')).toEqual({
      text: 'explain the old rows migration',
      cursor: 21,
    });
  });

  it('does not add spaces around punctuation', () => {
    expect(insertDictationText('hello', 5, ', world')).toEqual({
      text: 'hello, world',
      cursor: 12,
    });
    expect(insertDictationText('()', 1, 'value')).toEqual({
      text: '(value)',
      cursor: 6,
    });
  });

  it('supports Thai and clamps a stale cursor', () => {
    expect(insertDictationText('เริ่ม', 99, 'ทดสอบ')).toEqual({
      text: 'เริ่ม ทดสอบ',
      cursor: 11,
    });
  });

  it('keeps final and interim text visually distinct with the same spacing', () => {
    expect(combineDictationText('migration', 'plan')).toBe('migration plan');
    expect(dictationPreviewParts('showrows', 4, 'old', 'records')).toEqual({
      before: 'show',
      leading: ' ',
      finalText: 'old ',
      interimText: 'records',
      trailing: ' ',
      after: 'rows',
    });
  });
});

describe('dictation language chords', () => {
  it('maps Cmd+D to English and Cmd+Shift+D to Thai', () => {
    expect(dictationLanguageFromShift(false)).toBe(DICTATION_LANG_ENGLISH);
    expect(dictationLanguageFromShift(true)).toBe(DICTATION_LANG_THAI);
    expect(dictationLanguageLabel('en-US')).toBe('EN');
    expect(dictationLanguageLabel('th-TH')).toBe('TH');
    expect(dictationLanguageLabel('th')).toBe('TH');
  });
});

describe('dictation errors', () => {
  it('maps browser error codes to short actionable status text', () => {
    expect(dictationErrorMessage('not-allowed')).toBe('microphone permission denied');
    expect(dictationErrorMessage('audio-capture')).toBe('microphone unavailable');
    expect(dictationErrorMessage('network')).toBe('dictation network error');
    expect(dictationErrorMessage('language-not-supported')).toBe('dictation language unavailable');
    expect(dictationErrorMessage('unknown')).toBe('dictation failed');
  });
});
