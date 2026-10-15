// Spec 302 §3.6 — `PermissionRow`.
//
// One row carries the whole `pending → accepted | rejected | auto_allowed |
// failed` lifecycle (spec 107). Today that is a full row rebuild driven by
// `transcriptRenderSignature`, which hashes twelve permission fields; here the
// decision is a dependency, so a resolve repaints this body and nothing else,
// and a repeated resolve writes nothing at all.
//
// `HarnessPermission` is mutated in place by the harness bus, so `bodyDeps()`
// spells out the fields `paintBody()` reads. The payload object reference is
// deliberately NOT a dependency — it never changes.
//
// Ported from `harness-transcript-render.ts:952-1018` (`renderPermissionBody`)
// plus its dispatcher branch at `:352-354`. Markup is unchanged.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import type { PermissionPayload } from '../../harness-view-types';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';
import './permission-row.css';

export function permissionDecisionLabel(perm: PermissionPayload): string {
  if (perm.decisionLabel) return perm.decisionLabel;
  switch (perm.decision) {
    case 'pending': return 'pending';
    case 'accepted': return 'accepted';
    case 'rejected': return 'rejected';
    case 'auto_allowed': return 'auto-allowed';
    case 'failed': return 'failed';
  }
}

/** `a accept · r reject` — the hint line on a pending row. */
export function permissionActionsHint(options: PermissionPayload['options']): string {
  const labels: string[] = [];
  for (const option of options) {
    if (option.action === 'accept') labels.push('a accept');
    else if (option.action === 'reject') labels.push('r reject');
  }
  return [...new Set(labels)].join(' · ');
}

/** The head line: glyph + decision chip (resolved only), tool tag, subject. */
class PermissionHead extends Component<PermissionPayload> {
  private readonly subject = el('span', { class: 'acp-harness__perm-subject' });

  constructor() {
    super(el('div', { class: 'acp-harness__perm-row' }));
  }

  protected readDeps(next: PermissionPayload): readonly unknown[] {
    return [next.decision, next.decisionLabel, next.toolName, next.subject];
  }

  protected syncClasses(_next: PermissionPayload): void {
    this.el.className = 'acp-harness__perm-row';
  }

  protected paint(next: PermissionPayload): void {
    this.syncClasses(next);
    const nodes: Node[] = [];
    // spec 167: a resolved row leads with its decision; a pending row drops the
    // redundant family/"pending" noise — the actions line already says it waits.
    if (next.decision !== 'pending') {
      // `auto_allowed` reads as an accept; only a reject or a failure is ✗.
      const glyph = next.decision === 'rejected' || next.decision === 'failed' ? '✗' : '✓';
      nodes.push(
        el('span', {
          class: `acp-harness__perm-glyph acp-harness__perm-glyph--${next.decision}`,
          text: glyph,
        }),
        // The glyph carries the ✓/✗, so strip it from the chip text.
        el('span', {
          class: 'acp-harness__perm-decision',
          text: permissionDecisionLabel(next).replace(/^[✓✗]\s*/u, ''),
        }),
      );
    }
    // For execute permissions the toolName IS the subject, so printing both
    // would print the command twice.
    if (next.toolName && next.toolName !== next.subject) {
      nodes.push(el('span', { class: 'acp-harness__perm-tool', text: next.toolName }));
    }
    this.subject.textContent = next.subject;
    this.subject.title = next.subject;
    nodes.push(this.subject);
    this.el.replaceChildren(...nodes);
  }
}

export class PermissionRow extends TranscriptRow {
  private readonly head = new PermissionHead();

  constructor(props: RowProps) {
    super(props, false);
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    return next.item.permission ? ['acp-harness__perm'] : [];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    const perm = next.item.permission;
    if (!perm) return [undefined, undefined, undefined, undefined, undefined, undefined, undefined, next.item.text];
    return [
      perm.decision,
      perm.decisionLabel,
      perm.toolName,
      perm.subject,
      perm.suffix,
      perm.autoReason,
      perm.argsPreview,
      permissionActionsHint(perm.options),
    ];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const perm = next.item.permission;
    if (!perm) {
      body.removeAttribute('data-decision');
      body.textContent = next.item.text;
      return;
    }
    const pending = perm.decision === 'pending';
    body.dataset.decision = perm.decision;
    this.head.update(perm);
    const nodes: Node[] = [this.head.el];
    // spec 167: a resolved row stays strictly one line. The cross-touch suffix,
    // the auto-allow reason and the args preview carry decision-time signal
    // only, so they render on the pending row alone.
    if (pending && perm.suffix) {
      nodes.push(el('span', { class: 'acp-harness__perm-suffix', text: perm.suffix }));
    }
    if (pending && perm.autoReason) {
      nodes.push(el('div', { class: 'acp-harness__perm-reason', text: perm.autoReason }));
    }
    if (pending && perm.argsPreview) {
      nodes.push(el('div', { class: 'acp-harness__perm-preview', text: perm.argsPreview }));
    }
    if (pending) {
      nodes.push(
        el('div', { class: 'acp-harness__perm-actions', text: permissionActionsHint(perm.options) }),
      );
    }
    body.replaceChildren(...nodes);
  }

  protected onDispose(): void {
    this.head.dispose();
    super.onDispose();
  }
}

export const def: ComponentDef = { id: 'permission-row', blocks: ['acp-harness__perm'] };
