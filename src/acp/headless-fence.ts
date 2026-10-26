// Krypton — the fence every headless ACP caller puts around its session
// (assist sidecar, spec 306; Inline AI, spec 333).
//
// Nobody sits behind a headless session to answer the agent, so every request
// it can raise is answered here: permissions declined, file writes refused,
// questions cancelled. Declining is not politeness — an unanswered request
// parks the agent (`acp.rs` holds it with no timeout) and `session/prompt`
// would never resolve.

import type { AcpClient } from './client';
import type { AcpEvent } from './types';

/** Answer `event` if it is a request the fence owns. True when it was one. */
export function answerFencedRequest(client: AcpClient, event: AcpEvent): boolean {
  switch (event.type) {
    case 'permission_request':
      void client.respondPermission(event.requestId, null).catch(() => undefined);
      return true;
    case 'fs_write_pending':
      void client.respondFsWrite(event.requestId, false).catch(() => undefined);
      return true;
    case 'ask_user_question':
    case 'elicitation_request':
      void client.cancel().catch(() => undefined);
      return true;
    default:
      return false;
  }
}
