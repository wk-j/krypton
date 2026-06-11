# Frontend remains the authority for harness control

> Status: accepted
> Date: 2026-06-11

## Context

Live ACP Harness state already belongs to the TypeScript `AcpHarnessView`.
Mirroring lanes, queues, transcripts, and permissions in Rust would create
competing state and stale-control failure modes.

## Decision

The authenticated Rust control server validates and forwards typed operations to
the owning frontend view through a Tauri round-trip. It does not maintain a
second copy of harness state. A missing or unresponsive owner causes the request
to fail or time out.

## Considered Options

- Move harness authority into Rust. Rejected because it is a broad architectural
  migration unrelated to exposing a CLI.
- Mirror state in Rust. Rejected because mutations could target stale state.

## Consequences

The control endpoint is unavailable until the frontend bridge is ready, and
request latency includes a frontend round-trip. Typed operations remain shared
with the UI's domain behavior instead of bypassing it.
