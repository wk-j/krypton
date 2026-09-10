export type DictationPhase = 'idle' | 'starting' | 'listening' | 'stopping';

export interface DictationResultSnapshot {
  finalText: string;
  interimText: string;
}

export const DICTATION_LANG_ENGLISH = 'en-US';
export const DICTATION_LANG_THAI = 'th-TH';

export interface HarnessDictationSession {
  token: number;
  laneId: string;
  phase: Exclude<DictationPhase, 'idle'>;
  lang: string;
  baseDraft: string;
  insertAt: number;
  finalText: string;
  interimText: string;
  cancelRequested: boolean;
}

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message: string;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionScope {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export interface DictationPreviewParts {
  before: string;
  leading: string;
  finalText: string;
  interimText: string;
  trailing: string;
  after: string;
}

function isScope(value: unknown): value is SpeechRecognitionScope {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isWordLike(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

function needsSpaceBetween(left: string, right: string): boolean {
  return isWordLike(left) && isWordLike(right);
}

export function speechRecognitionConstructor(
  scope: unknown = globalThis,
): SpeechRecognitionConstructor | null {
  if (!isScope(scope)) return null;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** `Cmd+D` listens in English; `Cmd+Shift+D` listens in Thai. */
export function dictationLanguageFromShift(shiftKey: boolean): string {
  return shiftKey ? DICTATION_LANG_THAI : DICTATION_LANG_ENGLISH;
}

export function dictationLanguageLabel(lang: string): string {
  return lang.toLowerCase().startsWith('th') ? 'TH' : 'EN';
}

export function collectDictationResults(
  event: SpeechRecognitionEventLike,
): DictationResultSnapshot {
  let finalText = '';
  let interimText = '';
  for (let index = 0; index < event.results.length; index++) {
    const result = event.results[index];
    const transcript = result?.[0]?.transcript ?? '';
    if (result?.isFinal) finalText += transcript;
    else interimText += transcript;
  }
  return { finalText, interimText };
}

export function combineDictationText(finalText: string, interimText: string): string {
  const finalPart = finalText.trim();
  const interimPart = interimText.trim();
  if (!finalPart) return interimPart;
  if (!interimPart) return finalPart;
  const separator = needsSpaceBetween(finalPart[finalPart.length - 1] ?? '', interimPart[0] ?? '') ? ' ' : '';
  return `${finalPart}${separator}${interimPart}`;
}

export function insertDictationText(
  base: string,
  cursor: number,
  speech: string,
): { text: string; cursor: number } {
  const insertAt = Math.max(0, Math.min(cursor, base.length));
  const spoken = speech.trim();
  if (!spoken) return { text: base, cursor: insertAt };

  const before = base.slice(0, insertAt);
  const after = base.slice(insertAt);
  const leading = needsSpaceBetween(before[before.length - 1] ?? '', spoken[0] ?? '') ? ' ' : '';
  const trailing = needsSpaceBetween(spoken[spoken.length - 1] ?? '', after[0] ?? '') ? ' ' : '';
  const inserted = `${leading}${spoken}${trailing}`;
  return {
    text: `${before}${inserted}${after}`,
    cursor: insertAt + inserted.length,
  };
}

export function dictationPreviewParts(
  base: string,
  cursor: number,
  finalText: string,
  interimText: string,
): DictationPreviewParts {
  const insertAt = Math.max(0, Math.min(cursor, base.length));
  const before = base.slice(0, insertAt);
  const after = base.slice(insertAt);
  const finalPart = finalText.trim();
  const interimPart = interimText.trim();
  const separator = finalPart && interimPart
    && needsSpaceBetween(finalPart[finalPart.length - 1] ?? '', interimPart[0] ?? '')
    ? ' '
    : '';
  const spoken = `${finalPart}${separator}${interimPart}`;
  return {
    before,
    leading: spoken && needsSpaceBetween(before[before.length - 1] ?? '', spoken[0] ?? '') ? ' ' : '',
    finalText: `${finalPart}${separator}`,
    interimText: interimPart,
    trailing: spoken && needsSpaceBetween(spoken[spoken.length - 1] ?? '', after[0] ?? '') ? ' ' : '',
    after,
  };
}

export function dictationErrorMessage(error: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'microphone permission denied';
    case 'audio-capture':
      return 'microphone unavailable';
    case 'network':
      return 'dictation network error';
    case 'no-speech':
      return 'no speech heard';
    case 'language-not-supported':
      return 'dictation language unavailable';
    default:
      return 'dictation failed';
  }
}
