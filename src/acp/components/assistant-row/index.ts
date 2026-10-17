// Spec 302 §3.1 — `AssistantRow` (live).
//
// The agent's reply: streaming-markdown while the turn runs, cached GFM once
// it is sealed, plus the lane-mail provenance line, the ```svg / ```mermaid
// fence cards, the annotation marks and the REFERENCES rail.
//
// Ports `harness-transcript-render.ts:299-347` (the build), the pre-signature
// fast path at `acp-harness-view.ts:12193-12213` and
// `sealAssistantStreamingMarkdown` (`:14521-14583`) into one object whose live
// state is a field instead of three lane globals.
//
// Parser ownership. The parser is created in `openParser()` and dropped in
// `onSeal()` / `onDispose()`, so a row that leaves the DOM takes its parser
// with it — the structural replacement for the spec-117 orphan guard at
// `acp-harness-view.ts:12166-12175`, which could only notice the leak and warn.
// `lane.streamingMarkdownParser / …Body / …ItemId` are still written, because
// the rest of the view reads them, but they are now a MIRROR of this field:
// the component, not the lane, decides when a parser exists.

import './assistant-row.css';

import * as smd from 'streaming-markdown';

import { el } from '../../../ui/dom';
import {
  applyCoordinatorProvenanceToItem,
  formatLaneMailProvenanceLine,
  scanMessageResourceBody,
} from '../../harness-transcript-render';
import {
  STREAMING_MARKDOWN_LIVE_CLASS,
  makeSafeRenderer,
  md,
  rerenderAssistantMarkdownWithMarked,
  resolveLocalImageSrcs,
  streamingMarkdownDroppedTable,
} from '../../harness-markdown';
import { clearLiveSvgFences, decorateSvgFences, updateLiveSvgFences } from '../../harness-svg-fence';
import { decorateUiFences, patchUiHints, syncUiPanel } from '../genui-card';
import { applyTranscriptAnnotations } from '../../transcript-annotation';
import type { HarnessLane, HarnessTranscriptItem } from '../../harness-view-types';
import { AnnotationRail } from '../annotation-rail';
import { ResourceRail } from '../resource-rail';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';

const MARKDOWN_CLASS = 'acp-harness__msg-body--markdown';
const STREAM_MARKDOWN_CLASS = 'acp-harness__msg-body--stream-markdown';

export class AssistantRow extends TranscriptRow {
  private current: RowProps;
  private parser: smd.Parser | null = null;
  /** A parser has been opened on this row at least once. */
  private streamed = false;
  private provenance: HTMLElement | null = null;
  private rail: ResourceRail | null = null;
  private annoRail: AnnotationRail | null = null;

  constructor(props: RowProps) {
    super(props, props.streaming);
    this.current = props;
    this.body.dataset.annotatable = '1';
  }

  update(next: RowProps): void {
    this.current = next;
    super.update(next);
  }

  seal(next: RowProps): void {
    this.current = next;
    super.seal(next);
  }

  /**
   * Late Git refs and late thumbnails (spec 286) repaint the rail alone — the
   * structural replacement for `patchReferenceRails()`. A live row has no rail
   * yet, exactly as the old method skipped `lane.currentAssistantId`.
   */
  patchResources(): void {
    if (this.isLive) return;
    this.syncRail(this.current);
  }

  patchUiHints(): void {
    if (!this.isLive) patchUiHints(this.body, this.current.item);
  }

  /**
   * Spec 310 — seat the view's single live panel in one of this row's cards.
   * Returns whether it found a slot here; the view collapses when no mounted
   * row claims the open fence.
   */
  mountUiPanel(target: { readonly index: number; readonly panel: HTMLElement } | null): boolean {
    return this.isLive ? false : syncUiPanel(this.body, target);
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    // While the parser owns the body, text arrives through appendChunk(); a
    // text dep here would rebuild the row on every chunk.
    if (this.isLive) return ['live'];
    const provenance = next.item.replyingToLaneMail;
    return [
      // `item.text`, not `item.markdownHtml`: the HTML is a CACHE this paint
      // writes, so depending on it would make readDeps() unstable across paint.
      next.item.text,
      provenance?.peerDisplayName ?? '',
      provenance?.envelopeCount ?? 0,
      // `drifted` is deliberately absent: applyTranscriptAnnotations() WRITES
      // it from the DOM it just searched, so a dep carrying it would differ
      // before and after paint() and force a repaint on every pass.
      (next.item.annotations ?? []).map((a) => `${a.id}:${a.status}`).join('\u001f'),
      // spec 283: only NON-default card state. A freshly decorated row writes
      // `item.svgFences` from the DOM paint() just built, all of it default, so
      // depending on the raw list would make readDeps() unstable across paint;
      // a label or a Source toggle is real state and must repaint the body.
      (next.item.svgFences ?? [])
        .filter((fence) => fence.hintLabel !== null || fence.showSource)
        .map((fence) => `${fence.index}:${fence.hintLabel ?? ''}:${fence.showSource ? '1' : '0'}`)
        .join('\u001f'),
      next.projectDir,
      next.resolveLocalImages,
    ];
  }

  /** The three body classes `initLaneStreamingMarkdown()` used to add by hand. */
  protected bodyClasses(): readonly string[] {
    if (this.isLive) return [MARKDOWN_CLASS, STREAM_MARKDOWN_CLASS, STREAMING_MARKDOWN_LIVE_CLASS];
    return this.streamed ? [MARKDOWN_CLASS, STREAM_MARKDOWN_CLASS] : [MARKDOWN_CLASS];
  }

  /**
   * Deps and classes both read `isLive`, not `props.streaming`: a caller that
   * seals and then keeps passing `streaming: true` can neither leave
   * `--streaming` / `--stream-live` behind nor force a repaint of the sealed row.
   */
  protected readDeps(next: RowProps): readonly unknown[] {
    return super.readDeps(!this.isLive && next.streaming ? { ...next, streaming: false } : next);
  }

  protected syncClasses(next: RowProps): void {
    super.syncClasses(!this.isLive && next.streaming ? { ...next, streaming: false } : next);
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    if (next.lane) applyCoordinatorProvenanceToItem(next.lane, next.item);
    if (this.isLive) {
      if (!this.parser) this.openParser(next);
      this.syncProvenance(next);
      return;
    }
    this.paintSealed(body, next);
  }

  protected appendChunk(next: RowProps): void {
    const { item } = next;
    const written = item.streamingMarkdownWritten ?? 0;
    if (!this.parser) {
      this.openParser(next);
    } else if (item.text.length < written) {
      console.warn('[spec117] streaming text backtracked; rebuilding parser');
      this.openParser(next);
    }
    const start = item.streamingMarkdownWritten ?? 0;
    if (item.text.length <= start) return;
    try {
      smd.parser_write(this.parser!, item.text.slice(start));
    } catch (e) {
      console.warn('[spec117] parser_write failed', e);
    }
    item.streamingMarkdownWritten = item.text.length;
    // spec 283 rev 2: draw ```svg fences in as they stream.
    updateLiveSvgFences(this.body);
  }

  protected onSeal(): void {
    const next = this.current;
    const { item } = next;
    if (!this.parser) {
      // Never streamed in the foreground: paint the finished text from scratch.
      this.paintSealed(this.body, next);
      item.streamingMarkdownWritten = undefined;
      item.streamPlainLength = undefined;
      return;
    }
    const written = item.streamingMarkdownWritten ?? 0;
    // Seal-drain: the residual delta between the last chunk and the stop event.
    if (item.text.length > written) {
      try {
        smd.parser_write(this.parser, item.text.slice(written));
      } catch (e) {
        console.warn('[spec117] parser_write during seal failed', e);
      }
    }
    try {
      smd.parser_end(this.parser);
    } catch (e) {
      console.warn('[spec117] parser_end during seal failed', e);
    }
    this.parser = null;
    this.releaseLane(next.lane, item);
    // spec 283: drop the live cards so decorateSvgFences can build the real ones.
    clearLiveSvgFences(this.body);
    if (streamingMarkdownDroppedTable(this.body, item.text)) {
      rerenderAssistantMarkdownWithMarked(this.body, item.text, next.projectDir, next.resolveLocalImages);
    } else if (next.resolveLocalImages) {
      resolveLocalImageSrcs(this.body, next.projectDir);
    }
    item.markdownHtml = this.captureMarkdown();
    item.markdownSource = item.text;
    item.streamingMarkdownWritten = undefined;
    item.streamPlainLength = undefined;
    // After the capture — the cache stays pure markdown.
    decorateSvgFences(this.body, item);
    decorateUiFences(this.body, item);
    scanMessageResourceBody(this.body, item, next.projectDir);
    this.syncRail(next);
  }

  protected onDispose(): void {
    super.onDispose();
    this.parser = null;
    this.releaseLane(this.current.lane, this.current.item);
    this.rail?.dispose();
    this.rail = null;
    this.annoRail?.dispose();
    this.annoRail = null;
  }

  private paintSealed(body: HTMLElement, next: RowProps): void {
    const { item } = next;
    if (item.markdownSource !== item.text || item.markdownHtml === undefined) {
      try {
        item.markdownHtml = md.parse(item.text, { async: false }) as string;
        item.markdownSource = item.text;
      } catch {
        item.markdownHtml = undefined;
        item.markdownSource = undefined;
      }
    }
    if (item.markdownHtml !== undefined) {
      // The one allowed innerHTML: markdown already parsed and sanitised.
      body.innerHTML = item.markdownHtml;
      // Agent-emitted local image paths (cold-load output, or a cached seal)
      // resolve to loadable asset URLs.
      if (next.resolveLocalImages) resolveLocalImageSrcs(body, next.projectDir);
    } else {
      body.textContent = item.text;
    }
    this.syncProvenance(next);
    // spec 283: before annotations so SKIP_WRAP keeps toolbar text out of offsets.
    decorateSvgFences(body, item);
    decorateUiFences(body, item);
    applyTranscriptAnnotations(body, item);
    this.syncAnnoRail(body, item);
    scanMessageResourceBody(body, item, next.projectDir);
    this.syncRail(next);
  }

  /**
   * The provenance line is a node this component owns, so it survives the
   * parser wipe and the `innerHTML` assignment that silently dropped it in the
   * builder (`harness-transcript-render.ts:301-306` then `:333`).
   */
  private syncProvenance(next: RowProps): void {
    const provenance = next.item.replyingToLaneMail;
    if (!provenance) {
      this.provenance?.remove();
      this.provenance = null;
      return;
    }
    this.provenance ??= el('div', { class: 'acp-harness__lane-mail-provenance' });
    this.provenance.textContent = formatLaneMailProvenanceLine(provenance);
    if (this.body.firstChild !== this.provenance) {
      this.body.insertBefore(this.provenance, this.body.firstChild);
    }
  }

  private openParser(next: RowProps): void {
    this.body.replaceChildren();
    this.parser = smd.parser(makeSafeRenderer(this.body));
    this.streamed = true;
    next.item.streamingMarkdownWritten = 0;
    next.item.streamPlainLength = undefined;
    if (next.lane) {
      next.lane.streamingMarkdownParser = this.parser;
      next.lane.streamingMarkdownBody = this.body;
      next.lane.streamingMarkdownItemId = next.item.id;
    }
  }

  private releaseLane(lane: HarnessLane | null, item: HarnessTranscriptItem): void {
    if (!lane || lane.streamingMarkdownItemId !== item.id) return;
    lane.streamingMarkdownParser = null;
    lane.streamingMarkdownBody = null;
    lane.streamingMarkdownItemId = null;
  }

  /** `item.markdownHtml` caches the markdown only — never the provenance node. */
  private captureMarkdown(): string {
    const provenance = this.provenance;
    if (!provenance || provenance.parentNode !== this.body) return this.body.innerHTML;
    provenance.remove();
    const html = this.body.innerHTML;
    this.body.insertBefore(provenance, this.body.firstChild);
    return html;
  }

  private syncRail(next: RowProps): void {
    if (ResourceRail.isEmpty(next.item)) {
      if (!this.rail) return;
      this.rail.el.remove();
      this.rail.dispose();
      this.rail = null;
      return;
    }
    this.rail ??= new ResourceRail();
    this.rail.update({ item: next.item, projectDir: next.projectDir, lane: next.lane });
    // The rail is the body's last child, after the annotation rail.
    if (this.body.lastChild !== this.rail.el) this.body.appendChild(this.rail.el);
  }

  /**
   * The annotation rail (spec 302 §5.8) is transcript content, not a panel: it
   * sits in the message body, under the reply it annotates. The `innerHTML`
   * assignment in `paintSealed` detaches it, so the component survives the
   * repaint and only its own nodes are re-appended — a deleted note no longer
   * rebuilds the ones that stayed.
   */
  private syncAnnoRail(body: HTMLElement, item: HarnessTranscriptItem): void {
    const annotations = item.annotations ?? [];
    if (annotations.length === 0) {
      if (!this.annoRail) return;
      this.annoRail.el.remove();
      this.annoRail.dispose();
      this.annoRail = null;
      return;
    }
    this.annoRail ??= new AnnotationRail();
    this.annoRail.update({ annotations });
    if (body.lastChild !== this.annoRail.el) body.appendChild(this.annoRail.el);
  }
}

export const def: ComponentDef = { id: 'assistant-row', blocks: ['acp-harness__lane-mail-provenance'] };
