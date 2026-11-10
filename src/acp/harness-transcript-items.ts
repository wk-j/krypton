// Spec 380 — transcript row payloads from canonical lane data.
//
// Pure functions shared by `AcpHarnessView` and the spec 381 component
// gallery, so the gallery paints exactly what a lane paints. Nothing here reads
// wire JSON or imports Tauri.

import { permissionSubject } from './adapters/permission';
import type { PermissionRequest, ToolView } from './adapters/types';
import { harnessToolFamily, permissionToolFamily } from './harness-permission-scan';
import { cleanToolTitle, statusGlyph } from './harness-tool-render';
import type { PermissionPayload, ToolPayload } from './harness-view-types';

export interface ToolTiming {
  readonly startedAt?: number;
  readonly endedAt?: number;
}

/**
 * The tool row's payload: the view plus what the row owns (glyph, result,
 * timing). Output arrays pass through by reference so an update that changed
 * nothing in them repaints nothing. A result, once shown, stays shown.
 */
export function toolPayloadFromView(
  view: ToolView,
  timing: ToolTiming,
  prior: ToolPayload | undefined,
): ToolPayload {
  const result = view.exit !== null && view.exit !== 0
    ? `exit ${view.exit}`
    : view.status === 'failed' ? 'failed' : '';
  return {
    glyph: statusGlyph(view.status),
    status: view.status,
    kind: view.kind,
    subject: view.subject,
    command: view.command,
    result: result || prior?.result || '',
    exitCode: view.exit,
    sections: view.sections,
    diffs: view.diffs,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    ...(view.subagents ? { subagents: view.subagents } : {}),
    ...(view.execution ? { execution: view.execution } : {}),
    ...(view.jobs ? { jobs: view.jobs } : {}),
    ...(view.guardianReview ? { guardianReview: view.guardianReview } : {}),
  };
}

export interface PermissionExtras {
  /** `· also <lane> <age> ago` when another lane touched the subject recently. */
  readonly suffix?: string;
  /** spec 133: the input is an artifact's HTML; show a placeholder instead. */
  readonly hideArgs: boolean;
}

/** The permission row's payload for a decoded request (spec 380 phase 2b). */
export function permissionPayloadFromRequest(
  request: PermissionRequest,
  extras: PermissionExtras,
): PermissionPayload {
  const { view } = request;
  const toolName = request.harnessTool ?? (cleanToolTitle(view.title, view.kind) || view.title || view.kind);
  return {
    id: request.requestId,
    toolName,
    toolFamily: harnessToolFamily(toolName) ?? permissionToolFamily(view.kind),
    serverName: request.serverName,
    kind: view.kind,
    subject: permissionSubject(view),
    suffix: extras.suffix,
    argsPreview: extras.hideArgs ? 'html artifact · contents hidden' : request.argsPreview,
    options: request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      action: option.kind.startsWith('allow') ? 'accept' : option.kind.startsWith('reject') ? 'reject' : 'other',
    })),
    decision: 'pending',
  };
}
