import { describe, expect, it } from 'vitest';

import { computerApprovalPayload, type ComputerApprovalRequest } from './computer-approval';

function request(over: Partial<ComputerApprovalRequest> = {}): ComputerApprovalRequest {
  return {
    requestId: 'r1',
    harnessId: 'h1',
    laneLabel: 'OMP-1',
    spawnEpoch: 3,
    computerId: 'tli-dev-server',
    target: 'root@tli-dev-service:22',
    cwd: null,
    command: "docker ps --format '{{.Names}}\t{{.Status}}'",
    ...over,
  };
}

describe('computerApprovalPayload', () => {
  it('carries the resolved SSH identity, the login-home default, and the exact command', () => {
    const payload = computerApprovalPayload(request(), -1);

    expect(payload.subject).toBe('tli-dev-server · root@tli-dev-service:22');
    expect(payload.suffix).toBe('· login home · approval applies once');
    // Verbatim, never summarized: the human decides on these bytes.
    expect(payload.argsPreview).toBe("docker ps --format '{{.Names}}\t{{.Status}}'");
    expect(payload.decision).toBe('pending');
  });

  it('shows the remote directory when the request pins one', () => {
    const payload = computerApprovalPayload(request({ cwd: '/srv/tli' }), -2);

    expect(payload.suffix).toBe('· /srv/tli · approval applies once');
  });

  it('offers exactly one accept and one reject, so the row renders both actions', () => {
    const actions = computerApprovalPayload(request(), -3).options.map((option) => option.action);

    expect(actions).toEqual(['accept', 'reject']);
  });
});
