// Krypton — Harness word-autocomplete worker (spec 285)
// Hosts WordModel off the main thread: corpus ingest and the sorted-key rebuild
// never stall composer keystrokes.

import { WordModel } from './word-predict-model';
import type { WordPredictRequest, WordPredictResponse } from './word-predict';

const model = new WordModel();

self.onmessage = (e: MessageEvent<WordPredictRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'load':
      for (const text of msg.texts) model.observe(text);
      break;
    case 'observe':
      model.observe(msg.text);
      break;
    case 'complete': {
      const response: WordPredictResponse = { id: msg.id, suffix: model.complete(msg.before) };
      self.postMessage(response);
      break;
    }
  }
};
