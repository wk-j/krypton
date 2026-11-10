// Spec 380 phase 2b — permission requests, decoded once.
//
// The policy facts below use the exact functions that decided them before
// spec 380 (spec 96 built-in identity, spec 143 high-risk gating), now called
// here instead of by the view, so no surface reads the request's wire call.

import {
  extractHarnessServerName,
  harnessAutoAllowToolName,
  permissionArgsPreview,
} from '../harness-permission-scan';
import { permissionCommandIsHighRisk } from '../harness-tool-render';
import type { PermissionOption, ToolCall } from '../types';
import type { ToolCallDecoder } from './tool';
import type { PermissionRequest, ToolView } from './types';

/** The file a permission is about, else its title (what the card's subject shows). */
export function permissionSubject(view: Pick<ToolView, 'modifiedPath' | 'locations' | 'title'>): string {
  return view.modifiedPath ?? view.locations[0] ?? (view.title || 'unknown target');
}

export function decodePermission(
  tools: ToolCallDecoder,
  requestId: number,
  toolCall: ToolCall,
  options: PermissionOption[],
): PermissionRequest {
  const view = tools.view(toolCall);
  return {
    requestId,
    view,
    options,
    harnessTool: harnessAutoAllowToolName({ toolCall, options }),
    highRisk: permissionCommandIsHighRisk(toolCall),
    argsPreview: permissionArgsPreview(toolCall.rawInput, permissionSubject(view)),
    serverName: extractHarnessServerName(toolCall),
  };
}
