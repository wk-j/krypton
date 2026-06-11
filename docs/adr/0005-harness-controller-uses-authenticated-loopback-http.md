# Harness Controller uses authenticated loopback HTTP

> Status: accepted
> Date: 2026-06-11

## Context

The Harness Controller can mutate live ACP Harness state. Extending the existing
unauthenticated hook server would expose that authority to any local caller.

## Decision

Krypton exposes a dedicated versioned HTTP control API bound only to
`127.0.0.1`. It publishes one macOS user-private runtime descriptor containing
its PID, control URL, API/app versions, and a random bearer token. The CLI
validates PID liveness and authenticates every request. Krypton rotates the
token on application start and removes the descriptor during graceful shutdown.

## Considered Options

- Extend the hook server without authentication. Rejected because the controller
  can mutate harness state.
- Use a Unix socket. Rejected because HTTP keeps the protocol portable even
  though v1 packaging and descriptor permissions are macOS-specific.

## Consequences

Multiple simultaneous Krypton processes are out of scope. A live process refuses
to overwrite another live process's descriptor. A later multi-instance design
must replace the single descriptor and qualify lane addressing across processes.
