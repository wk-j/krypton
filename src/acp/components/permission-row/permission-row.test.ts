import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem, PermissionPayload } from '../../harness-view-types';
import type { RowProps } from '../transcript-row';
import { PermissionRow, permissionActionsHint, permissionDecisionLabel } from './index';

function permission(over: Partial<PermissionPayload> = {}): PermissionPayload {
  return {
    id: 7,
    toolName: 'Bash',
    toolFamily: 'shell',
    serverName: null,
    kind: 'execute',
    subject: 'git push origin main',
    argsPreview: '',
    options: [
      { optionId: 'allow', name: 'Allow', action: 'accept' },
      { optionId: 'allow_always', name: 'Allow always', action: 'accept' },
      { optionId: 'reject', name: 'Reject', action: 'reject' },
    ],
    decision: 'pending',
    ...over,
  };
}

function props(perm: PermissionPayload | undefined, over: Partial<RowProps> = {}): RowProps {
  const item: HarnessTranscriptItem = { id: 'p1', kind: 'permission', text: 'permission', permission: perm };
  return { item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false, ...over };
}

/** Synchronous "did anything in this subtree change" probe. */
function watch(node: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
  return observer;
}

/** happy-dom has no `AnimationEvent`; the row's handler only reads `animationName`. */
function animationEnd(name: string): Event {
  const event = new Event('animationend');
  Object.defineProperty(event, 'animationName', { value: name });
  return event;
}

describe('PermissionRow', () => {
  it('emits the pending row: no decision chip, tool tag, subject, actions hint', () => {
    const row = new PermissionRow(props(permission()));
    row.update(props(permission()));

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--permission');
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body acp-harness__perm');
    expect(body?.dataset.decision).toBe('pending');
    expect(body?.innerHTML).toBe(
      '<div class="acp-harness__perm-row">' +
        '<span class="acp-harness__perm-tool">Bash</span>' +
        '<span class="acp-harness__perm-subject" title="git push origin main">git push origin main</span>' +
      '</div>' +
      '<div class="acp-harness__perm-actions">a accept · r reject</div>',
    );
  });

  it('carries the whole lifecycle on ONE row and writes nothing on an idempotent repeat', () => {
    const perm = permission();
    const row = new PermissionRow(props(perm));
    row.update(props(perm));
    const head = row.el.querySelector('.acp-harness__perm-row');
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');

    // The harness mutates the payload in place (spec 107) — same object, new decision.
    perm.decision = 'accepted';
    row.update(props(perm));

    expect(row.el.querySelectorAll('.acp-harness__msg-body')).toHaveLength(1);
    expect(row.el.querySelector('.acp-harness__perm-row')).toBe(head);
    expect(body?.dataset.decision).toBe('accepted');
    expect(body?.innerHTML).toBe(
      '<div class="acp-harness__perm-row">' +
        '<span class="acp-harness__perm-glyph acp-harness__perm-glyph--accepted">✓</span>' +
        '<span class="acp-harness__perm-decision">accepted</span>' +
        '<span class="acp-harness__perm-tool">Bash</span>' +
        '<span class="acp-harness__perm-subject" title="git push origin main">git push origin main</span>' +
      '</div>',
    );

    const observer = watch(row.el);
    row.update(props(perm));
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it('drops the pending-only lines when the decision lands, and brings them back on a re-ask', () => {
    const perm = permission({ suffix: '· also touches src/', autoReason: 'harness bus', argsPreview: '{"cmd":"ls"}' });
    const row = new PermissionRow(props(perm));
    row.update(props(perm));
    expect(row.el.querySelector('.acp-harness__perm-suffix')?.textContent).toBe('· also touches src/');
    expect(row.el.querySelector('.acp-harness__perm-reason')?.textContent).toBe('harness bus');
    expect(row.el.querySelector('.acp-harness__perm-preview')?.textContent).toBe('{"cmd":"ls"}');

    perm.decision = 'auto_allowed';
    row.update(props(perm));
    expect(row.el.querySelector('.acp-harness__perm-suffix')).toBeNull();
    expect(row.el.querySelector('.acp-harness__perm-reason')).toBeNull();
    expect(row.el.querySelector('.acp-harness__perm-preview')).toBeNull();
    expect(row.el.querySelector('.acp-harness__perm-glyph')?.className)
      .toBe('acp-harness__perm-glyph acp-harness__perm-glyph--auto_allowed');
    expect(row.el.querySelector('.acp-harness__perm-decision')?.textContent).toBe('auto-allowed');

    perm.decision = 'pending';
    row.update(props(perm));
    expect(row.el.querySelector('.acp-harness__perm-glyph')).toBeNull();
    expect(row.el.querySelector('.acp-harness__perm-preview')?.textContent).toBe('{"cmd":"ls"}');
  });

  it('hides the tool tag when the tool name IS the subject', () => {
    const row = new PermissionRow(props(permission({ toolName: 'git push origin main' })));
    row.update(props(permission({ toolName: 'git push origin main' })));
    expect(row.el.querySelector('.acp-harness__perm-tool')).toBeNull();
  });

  it('strips the leading glyph out of a supplied decision label', () => {
    const perm = permission({ decision: 'rejected', decisionLabel: '✗ rejected by policy' });
    const row = new PermissionRow(props(perm));
    row.update(props(perm));
    expect(row.el.querySelector('.acp-harness__perm-decision')?.textContent).toBe('rejected by policy');
    expect(row.el.querySelector('.acp-harness__perm-glyph')?.textContent).toBe('✗');
  });

  it('re-derives the wrapper class when the row status goes back to unset', () => {
    const item: HarnessTranscriptItem = {
      id: 'p1', kind: 'permission', text: '', permission: permission(), status: 'failed',
    };
    const row = new PermissionRow({ item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false });
    row.update({ item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false });
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--permission acp-harness__msg--failed');

    item.status = undefined;
    row.update({ item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false });
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--permission');
  });

  it('falls back to the item text when the payload is missing, as the dispatcher does', () => {
    const row = new PermissionRow(props(undefined));
    row.update(props(undefined));
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body');
    expect(body?.textContent).toBe('permission');
    expect(body?.hasAttribute('data-decision')).toBe(false);
  });

  it('detaches the entrance listener on dispose', () => {
    const row = new PermissionRow(props(permission(), { isNew: true }));
    row.update(props(permission(), { isNew: true }));
    expect(row.el.classList.contains('acp-harness__msg--enter')).toBe(true);

    row.dispose();
    row.el.dispatchEvent(animationEnd('acp-harness-msg-enter'));
    expect(row.el.classList.contains('acp-harness__msg--enter')).toBe(true);
  });

  it('releases the entrance class on animationend while live', () => {
    const row = new PermissionRow(props(permission(), { isNew: true }));
    row.update(props(permission(), { isNew: true }));
    row.el.dispatchEvent(animationEnd('acp-harness-msg-enter'));
    expect(row.el.classList.contains('acp-harness__msg--enter')).toBe(false);
  });

  it('dedupes the actions hint across accept variants and keeps accept before reject', () => {
    expect(permissionActionsHint(permission().options)).toBe('a accept · r reject');
    expect(permissionActionsHint([{ optionId: 'o', name: 'Other', action: 'other' }])).toBe('');
  });

  it('spells the decision label the payload does not supply', () => {
    expect(permissionDecisionLabel(permission({ decision: 'auto_allowed' }))).toBe('auto-allowed');
    expect(permissionDecisionLabel(permission({ decision: 'failed', decisionLabel: 'bus error' }))).toBe('bus error');
  });
});
