// Krypton — AI Agent Session Persistence
// Saves and restores agent conversation using localStorage.
// Key: 'krypton_agent_session'

const STORAGE_KEY = 'krypton_agent_session';
const MAX_MESSAGES = 80;

export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
  isError?: boolean;
}

export function saveSession(messages: StoredMessage[]): void {
  try {
    const trimmed = messages.slice(-MAX_MESSAGES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full or unavailable — silently skip
  }
}

export function loadSession(): StoredMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredMessage[];
  } catch {
    return [];
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
