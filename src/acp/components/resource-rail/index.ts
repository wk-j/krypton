// Spec 302 §3.16 — `ResourceRail`.
//
// The flat REFERENCES rail beneath a sealed assistant body (spec 206), with the
// spec 286 thumbnail cell. Markup is the builder's, unchanged:
// `.acp-harness__resources > .acp-harness__resource[data-response-resource]`.
//
// It is a CHILD component of the row, which is the structural replacement for
// `patchReferenceRails()` (`acp-harness-view.ts:7646-7660`): late Git state and
// late thumbnails move this component's own deps only, so the owning row never
// repaints its markdown, svg cards or annotations to show a `+12/−3` that
// arrived a second after the turn ended. The owner calls `rail.update(props)`;
// nothing else in the row moves.
//
// Clicks stay delegated on `[data-response-resource]` at the view level, so the
// rail attaches no listeners of its own.

import './resource-rail.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { isOpenableImage } from '../../harness-images';
import { resolveResourceImage, resourceGlyph } from '../../message-resource-thumb';
import { resourceDisplayTarget } from '../../message-resources';
import type { HarnessImage, HarnessLane, HarnessTranscriptItem, MessageResource } from '../../harness-view-types';
import type { ComponentDef } from '../types';

/** Thumbnails may be borrowed from another row of the lane (spec 286). */
export type ThumbLane = Pick<HarnessLane, 'imageState' | 'transcript'>;

export interface ResourceRailProps {
  readonly item: HarnessTranscriptItem;
  readonly projectDir: string | null;
  readonly lane: ThumbLane | null;
}

const GIT_STATUS_WORD: Readonly<Record<string, string>> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  '?': 'Untracked',
  '!': 'Conflicted',
};

/** The accessible sentence appended to a reference's title and aria-label. */
export function referenceGitAccessibleSummary(git: NonNullable<MessageResource['git']>): string {
  const status = GIT_STATUS_WORD[git.status];
  if (git.countKind === 'binary') return `${status}, binary file`;
  if (git.countKind === 'unavailable') return `${status}, line counts unavailable`;
  const added = git.added ?? 0;
  const removed = git.removed ?? 0;
  return `${status}, ${added} ${added === 1 ? 'line' : 'lines'} added, ${removed} ${removed === 1 ? 'line' : 'lines'} removed`;
}

function railRow(item: HarnessTranscriptItem, lane: ThumbLane | null, resource: MessageResource): string {
  const image = resolveResourceImage(lane, item, resource);
  return [
    resource.key,
    resource.kind,
    resource.label,
    resource.target,
    resource.line ?? '',
    resource.column ?? '',
    resource.hintLabel ?? '',
    resource.git?.status ?? '',
    resource.git?.added ?? '',
    resource.git?.removed ?? '',
    resource.git?.countKind ?? '',
    image ? `${image.imageId}:${image.state}:${image.objectUrl ?? ''}` : '',
  ].join('\u001e');
}

/**
 * Identity of everything the rail paints.
 *
 * Git state and the resolved thumbnail are IN, because they are the two things
 * that arrive late and must repaint the rail; they are deliberately out of the
 * owning row's tuple.
 */
export function resourceRailSignature(item: HarnessTranscriptItem, lane: ThumbLane | null): string {
  const rows = (item.resources ?? []).map((resource) => railRow(item, lane, resource)).join('\u001f');
  return `${rows}|${item.resourceOverflow ?? 0}`;
}

export class ResourceRail extends Component<ResourceRailProps> {
  private readonly count: HTMLElement;

  constructor() {
    super(el('section', { class: 'acp-harness__resources', attrs: { 'aria-label': 'Message references' } }));
    this.count = el('span', { class: 'acp-harness__resource-count' });
    this.el.appendChild(
      el('div', { class: 'acp-harness__resources-head' }, el('span', { text: 'REFERENCES' }), this.count),
    );
  }

  /** True when the owner must not mount the rail at all. */
  static isEmpty(item: HarnessTranscriptItem): boolean {
    return (item.resources ?? []).length === 0;
  }

  protected readDeps(next: ResourceRailProps): readonly unknown[] {
    return [resourceRailSignature(next.item, next.lane), next.projectDir];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__resources';
  }

  protected paint(next: ResourceRailProps): void {
    this.syncClasses();
    const resources = next.item.resources ?? [];
    const overflow = next.item.resourceOverflow ?? 0;
    this.count.textContent = overflow > 0 ? `${resources.length} · +${overflow} hidden` : String(resources.length);
    // The head node is this component's own; only the reference rows are rebuilt.
    while (this.el.childNodes.length > 1) this.el.lastChild!.remove();
    for (const resource of resources) {
      this.el.appendChild(
        renderResource(resource, next.projectDir, resolveResourceImage(next.lane, next.item, resource)),
      );
    }
  }
}

function renderResource(
  resource: MessageResource,
  projectDir: string | null,
  image: HarnessImage | null,
): HTMLButtonElement {
  const displayTarget = resourceDisplayTarget(resource, projectDir);
  const gitSummary = resource.git ? referenceGitAccessibleSummary(resource.git) : null;
  const imageProblem =
    image && (image.state === 'missing' || image.state === 'rejected')
      ? `image ${image.rejectReason ?? image.state}`
      : null;
  const viewable = image !== null && isOpenableImage(image);
  const verb = resource.kind === 'url' ? 'Open URL' : viewable ? 'View image' : 'Open file';
  const row = el('button', {
    class: [
      'acp-harness__resource',
      `acp-harness__resource--${resource.kind}`,
      resource.hintLabel ? 'acp-harness__resource--hinted' : null,
    ],
    title: [displayTarget, gitSummary, imageProblem].filter((part) => part !== null).join(' · '),
    // `el`'s `data` option prefixes the key verbatim, so the kebab form is the
    // one that reaches `dataset.responseResource` / `[data-response-resource]`.
    data: { 'response-resource': resource.key },
    attrs: {
      type: 'button',
      'aria-label': `${verb} ${displayTarget}${gitSummary ? `. ${gitSummary}` : ''}`,
    },
  });

  const thumb = renderThumb(resource, image);
  if (resource.hintLabel) {
    thumb.appendChild(el('span', { class: 'acp-harness__resource-hint', text: resource.hintLabel }));
  }
  const content = el(
    'span',
    { class: 'acp-harness__resource-content' },
    el('span', { class: 'acp-harness__resource-label', text: resource.label }),
    el('span', { class: 'acp-harness__resource-target', text: displayTarget }),
  );
  const action = el('span', {
    class: 'acp-harness__resource-action',
    text: resource.kind === 'url' ? 'OPEN ↗' : viewable ? 'VIEW ↗' : 'OPEN TAB ↗',
  });
  row.append(thumb, content, renderGit(resource), action);
  return row;
}

function renderGit(resource: MessageResource): HTMLElement {
  const git = el('span', { class: 'acp-harness__resource-git' });
  if (!resource.git) {
    setAttr(git, 'aria-hidden', 'true');
    return git;
  }
  const status = el('span', {
    class: 'acp-harness__resource-git-status',
    data: { status: resource.git.status },
    text: resource.git.status,
  });
  const counts = el('span', { class: 'acp-harness__resource-git-counts' });
  if (resource.git.countKind === 'lines') {
    counts.append(
      el('span', { class: 'acp-harness__resource-git-add', text: `+${resource.git.added ?? 0}` }),
      el('span', { class: 'acp-harness__resource-git-remove', text: `−${resource.git.removed ?? 0}` }),
    );
  } else {
    counts.textContent = resource.git.countKind === 'binary' ? 'BIN' : 'N/A';
  }
  git.append(status, counts);
  return git;
}

/** spec 286: 48×34 leading cell — the image's pixels when live, else a glyph. */
function renderThumb(resource: MessageResource, image: HarnessImage | null): HTMLElement {
  if (image?.state === 'live' && image.objectUrl) {
    return el(
      'span',
      { class: 'acp-harness__resource-thumb acp-harness__resource-thumb--image' },
      el('img', { attrs: { src: image.objectUrl, alt: '', decoding: 'async', loading: 'lazy' } }),
    );
  }
  const glyph = resourceGlyph(resource);
  const thumb = el('span', {
    class: 'acp-harness__resource-thumb acp-harness__resource-thumb--glyph',
    data: {
      glyph: glyph.kind,
      state: image?.state === 'missing' || image?.state === 'rejected' ? image.state : undefined,
    },
  });
  thumb.appendChild(
    glyph.kind === 'url'
      ? globeIcon()
      : el('span', { class: 'acp-harness__resource-glyph', text: glyph.text }),
  );
  return thumb;
}

function globeIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#krypton-icon-globe');
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(use);
  return svg;
}

export const def: ComponentDef = {
  id: 'resource-rail',
  blocks: ['acp-harness__resources', 'acp-harness__resource'],
};
