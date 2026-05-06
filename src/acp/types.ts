// Krypton — ACP wire types.
// Mirrors the subset of agentclientprotocol.com types we actually consume.

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallContent {
  type: 'content' | 'diff' | 'terminal';
  // Diff-shaped:
  path?: string;
  oldText?: string | null;
  newText?: string;
  // Content-shaped:
  content?: ContentBlock;
  // Terminal-shaped:
  terminalId?: string;
}

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntry {
  content: string;
  priority?: 'low' | 'medium' | 'high';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AgentInfo {
  agent_protocol_version: number;
  auth_methods: unknown[];
  agent_capabilities: {
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    [k: string]: unknown;
  };
  session_id: string;
}

export interface AcpBackendDescriptor {
  id: string;
  display_name: string;
  command: string;
}

export interface AcpHttpHeader {
  name: string;
  value: string;
}

export interface AcpEnvVar {
  name: string;
  value: string;
}

export interface AcpMcpServerStdio {
  name: string;
  type?: 'stdio';
  command: string;
  args: string[];
  env: AcpEnvVar[];
}

export interface AcpMcpServerHttp {
  name: string;
  type: 'http';
  url: string;
  headers: AcpHttpHeader[];
}

export interface AcpMcpServerSse {
  name: string;
  type: 'sse';
  url: string;
  headers: AcpHttpHeader[];
}

export type AcpMcpServerDescriptor = AcpMcpServerStdio | AcpMcpServerHttp | AcpMcpServerSse;

/** Subset of `agentCapabilities.mcpCapabilities` from the `initialize` response.
 *  Used by the harness to skip http/sse servers when an adapter doesn't advertise them. */
export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface HarnessMemoryEntry {
  lane: string;
  summary: string;
  detail: string;
  updatedAt: number;
}

export interface HarnessMemorySession {
  harnessId: string;
  hookPort: number;
}

export interface HarnessMcpLaneStats {
  laneLabel: string;
  initializeCount: number;
  toolsListCount: number;
  toolsCallCount: number;
  lastMethod: string | null;
  lastSeenAt: number;
}

export interface UsageInfo {
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string };
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
  inputHint?: string;
}

export interface AcpAgentMode {
  id: string;
  name: string;
  description?: string;
}

export type AcpEvent =
  | { type: 'message_chunk'; text: string }
  | { type: 'thought_chunk'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_update'; update: ToolCallUpdate }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'permission_request'; requestId: number; toolCall: ToolCall; options: PermissionOption[] }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'available_commands'; commands: AcpAvailableCommand[] }
  | { type: 'mode_update'; modeId: string }
  | { type: 'fs_activity'; method: 'read' | 'write'; path: string; ok: boolean; error?: string }
  | { type: 'fs_write_pending'; requestId: number; path: string; oldText: string; newText: string }
  | { type: 'stop'; stopReason: StopReason }
  | { type: 'error'; message: string };
