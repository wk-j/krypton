export interface LiveAssistLaneSummary {
  harnessId: string;
  cwd: string | null;
  laneId: string;
  displayName: string;
  backendId: string;
  status: string;
  modelName: string | null;
  queueDepth: number;
  pendingPermissions: number;
  permissionMode: string;
  active: boolean;
}

export interface LiveAssistBootstrap {
  lanes: LiveAssistLaneSummary[];
  suggestedLane: string | null;
}

export interface LiveAssistLaneStatus {
  laneId: string;
  displayName: string;
  backendId: string;
  status: string;
  modelName: string | null;
  queueDepth: number;
  pendingPermissions: number;
  permissionMode: string;
  activity: string | null;
}

export interface LiveAssistTranscriptItem {
  id: string;
  kind: string;
  text: string;
  createdAt: number | null;
  status: string | null;
}

export interface LiveAssistPermission {
  requestId: number;
  tool: string;
  options: unknown[];
}

export interface LiveAssistSnapshot {
  lane: LiveAssistLaneSummary;
  status: LiveAssistLaneStatus;
  transcript: LiveAssistTranscriptItem[];
  permissions: LiveAssistPermission[];
}

export interface LiveAssistStreamEvent {
  harnessId: string;
  lane: string | null;
  kind: string;
  seq: number;
  payload: unknown;
}

export interface LiveAssistControlErrorShape {
  code: string;
  message: string;
  retryable: boolean;
}

export interface LiveAssistControlReply<T> {
  result?: T;
  error?: LiveAssistControlErrorShape;
}
