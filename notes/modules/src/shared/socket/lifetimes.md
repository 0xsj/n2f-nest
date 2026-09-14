# Connection and message are different owners

A connection scope survives several application messages. Each message opens fresh
child work and an execution scope; the client's message id is only an echo key.
That preserves correlation without trusting the peer to choose internal IDs or an
authenticated identity. The diagnostic never derives tenant access from Origin.

The leaf owns a small versioned JSON message codec. The adapter owns upgrade,
control frames, byte limits, heartbeat and close. Origin and subprotocol admission
happen before a session becomes usable. Text payloads are private and never generic
logger fields. A successful write is not a consumer acknowledgement.

[Native lifetime details](ws/cleanup.md) explain the runtime-specific implementation.

[Ticketed authentication](ticketed-authentication.md) records the identity-owned
upgrade proof and the revalidation rule for an already-open socket.

Real wire checks exercise four admission refusals, repeated messages and fresh
scopes, ping/pong, malformed/binary/oversize close codes and shutdown while connected.
They exercise control frames, but do not yet wait out a missing-pong heartbeat or
stress slow-consumer saturation. Scoped local logs are implemented; dedicated
socket OTLP spans, metrics and dashboards are not part of the current adapter.
