// Krypton — AI Agent Session Persistence
// Saves and restores agent conversation as a JSON file per project.
// Location: <projectDir>/.krypton/agent-session.json

import { invoke } from '@tauri-apps/api/core';

const SESSION_FILENAME = '.krypton/agent-session.json';
const MAX_MESSAGES = 80;

export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
  isError?: boolean;
}

function sessionPath(projectDir: string): string {
  return `${projectDir}/${SESSION_FILENAME}`;
}

export async function saveSession(messages: StoredMessage[], projectDir: string | null): Promise<void> {
  if (!projectDir) return;
  try {
    const trimmed = messages.slice(-MAX_MESSAGES);
    await invoke('write_file', { path: sessionPath(projectDir), content: JSON.stringify(trimmed, null, 2) });
  } catch {
    // Write failed — silently skip
  }
}

export async function loadSession(projectDir: string | null): Promise<StoredMessage[]> {
  if (!projectDir) return [];
  try {
    const raw = await invoke<string>('read_file', { path: sessionPath(projectDir) });
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredMessage[];
  } catch {
    return [];
  }
}

export async function clearSession(projectDir: string | null): Promise<void> {
  if (!projectDir) return;
  try {
    await invoke('write_file', { path: sessionPath(projectDir), content: '[]' });
  } catch {
    // ignore
  }
}
