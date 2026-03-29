// Krypton — AI Agent Session Persistence (pi-mono compatible JSONL format)
//
// Stores sessions as append-only JSONL files via Rust backend commands.
// File location: ~/.config/krypton/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl
//
// Each line is a JSON object with a "type" discriminator matching
// @mariozechner/pi-agent-core's SessionManager format.

import { invoke } from '@tauri-apps/api/core';

// ─── Types ────────────────────────────────────────────────────────────

/** Handle returned by create/continue commands. */
export interface SessionHandle {
  sessionId: string;
  filePath: string;
}

/** Summary for listing sessions. */
export interface SessionInfo {
  sessionId: string;
  filePath: string;
  timestamp: string;
  entryCount: number;
}

/** Session header (first line of JSONL). */
export interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

/** A message entry in the session. */
export interface SessionMessageEntry {
  type: 'message';
  id: string;
  parentId: string | null;
  message: Record<string, unknown>;
}

/** A compaction summary entry. */
export interface SessionCompactionEntry {
  type: 'compaction';
  id: string;
  parentId: string | null;
  summary: string;
  firstKeptEntryId: string;
}

/** Union of all entry types stored in JSONL. */
export type SessionEntry = SessionHeader | SessionMessageEntry | SessionCompactionEntry;

// ─── ID generation ────────────────────────────────────────────────────

let entryCounter = 0;

/** Generate a unique entry ID (timestamp + counter). */
function generateEntryId(): string {
  return `${Date.now()}-${++entryCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── IPC Wrappers ─────────────────────────────────────────────────────

/** Create a new session JSONL file for a project directory. */
export async function createSession(cwd: string): Promise<SessionHandle> {
  const raw = await invoke<{ session_id: string; file_path: string }>('session_create', { cwd });
  return { sessionId: raw.session_id, filePath: raw.file_path };
}

/** Find and open the most recent session for a project directory. */
export async function continueRecentSession(cwd: string): Promise<SessionHandle | null> {
  const handle = await invoke<{ session_id: string; file_path: string } | null>(
    'session_continue_recent',
    { cwd },
  );
  if (!handle) return null;
  return { sessionId: handle.session_id, filePath: handle.file_path };
}

/** Append a single entry to a session file. */
export async function appendEntry(filePath: string, entry: SessionEntry): Promise<void> {
  await invoke('session_append', { filePath, entry });
}

/** Load all entries from a session file. */
export async function loadEntries(filePath: string): Promise<SessionEntry[]> {
  return invoke<SessionEntry[]>('session_load', { filePath });
}

/** List all sessions for a project directory (newest first). */
export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  const raw = await invoke<Array<{
    session_id: string;
    file_path: string;
    timestamp: string;
    entry_count: number;
  }>>('session_list', { cwd });
  return raw.map((s) => ({
    sessionId: s.session_id,
    filePath: s.file_path,
    timestamp: s.timestamp,
    entryCount: s.entry_count,
  }));
}

// ─── High-level helpers ───────────────────────────────────────────────

/** Append a message entry and return its ID. */
export async function appendMessage(
  filePath: string,
  parentId: string | null,
  message: Record<string, unknown>,
): Promise<string> {
  const id = generateEntryId();
  const entry: SessionMessageEntry = { type: 'message', id, parentId, message };
  await appendEntry(filePath, entry);
  return id;
}

/** Extract message entries from loaded session entries. */
export function extractMessages(entries: SessionEntry[]): SessionMessageEntry[] {
  return entries.filter((e): e is SessionMessageEntry => e.type === 'message');
}
