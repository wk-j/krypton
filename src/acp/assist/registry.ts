// Krypton — harness assist sidecar (spec 306): the registry.
//
// Adding a task is one file plus one line here. The engine, the guards, the
// breaker, the keys, the hash command and the config merge all derive from it.

import { nextPrompt } from './tasks/next-prompt';
import type { RegisteredAssistTask } from './types';

export const ASSIST_TASKS: readonly RegisteredAssistTask[] = [nextPrompt];

export function assistTask(id: string): RegisteredAssistTask | undefined {
  return ASSIST_TASKS.find((task) => task.id === id);
}
