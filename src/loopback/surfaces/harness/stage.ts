// Spec 381 — the gallery stage: framework-free, mounted into a kit `Island`
// so React never owns component DOM (spec 361). Each state is one block: a
// caption outside a Krypton preview containing a `.acp-harness` root whose
// lane body holds the state's rows as direct siblings (spec 379 connector),
// then the canonical input as JSON for the `s` toggle outside the preview.

import { createTranscriptRow } from '../../../acp/components/transcript/rows';
import type { RowProps, TranscriptRow } from '../../../acp/components/transcript-row';
import { buildState } from './build';
import type { GalleryEntry } from './examples/types';

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class HarnessStage {
  private rows: TranscriptRow[] = [];
  private sources: HTMLElement[] = [];
  private host: HTMLElement | null = null;

  constructor(private readonly entry: GalleryEntry) {}

  mount(host: HTMLElement, sourceOpen: boolean): void {
    if (this.host !== null) return;
    this.host = host;
    const now = performance.now();
    this.entry.states.forEach((state, index) => {
      const block = document.createElement('section');
      block.className = 'lb-harness__block';
      block.dataset.state = state.label;
      const preview = div('lb-harness__stage');
      const root = div('acp-harness lb-harness__lane');
      const body = div('acp-harness__lane-body');
      root.appendChild(body);
      preview.appendChild(root);
      for (const item of buildState(this.entry.id, index, state, now)) {
        const props: RowProps = {
          item,
          isNew: false,
          streaming: state.streaming === true,
          // A gallery row has no lane: it paints as a cold row would (spec 381).
          lane: null,
          projectDir: null,
          resolveLocalImages: false,
        };
        const row = createTranscriptRow(props);
        row.update(props);
        body.appendChild(row.el);
        this.rows.push(row);
      }
      const source = document.createElement('pre');
      source.className = 'lb-code lb-code--wrap lb-harness__source';
      source.textContent = JSON.stringify(state.inputs, null, 2);
      source.hidden = !sourceOpen;
      this.sources.push(source);
      block.append(div('lb-harness__caption', state.label), preview, source);
      host.appendChild(block);
    });
  }

  setSourceOpen(open: boolean): void {
    for (const source of this.sources) source.hidden = !open;
  }

  /** Every row's `dispose()`: listeners, parsers and image state go with it. */
  dispose(): void {
    for (const row of this.rows) row.dispose();
    this.rows = [];
    this.sources = [];
    this.host?.replaceChildren();
    this.host = null;
  }
}
