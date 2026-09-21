# NATS event delivery notes

The NATS JetStream adapter is the remote transport option behind the same
`Publisher` seam used by the PostgreSQL mailbox and future in-process adapter.

## What and why

- Stream and durable-consumer provisioning is explicit and verifies the
  important configuration rather than silently accepting drift.
- Publish uses the event ID as the NATS message ID. A duplicate acknowledgement
  is verified against the stored event bytes before it is treated as durable.
- `transfer` moves one received event to another `Publisher` and acknowledges
  the source only after the destination reports a matching durable receipt.
- Network operations have a bounded deadline and caller cancellation. NATS
  connection details do not leak into shared domain contracts.

The platform runtime uses one `Broker` instance in two directions: the
PostgreSQL outbox hands events to its `Publisher` implementation, while
`NatsEventWorker` calls `transfer` to deliver the durable consumer stream into
the current process's `EventBus`. The latter acknowledges JetStream only after
Audit and any other local subscribers finish successfully.

The gated NATS integration test deliberately fails the destination publisher
once, waits past the configured acknowledgement window, and verifies that the
same event is delivered again. This protects the important boundary: a local
subscriber failure must not become a successful JetStream ACK.

The redelivery test reuses the application `signals` stream and creates a
unique consumer with `deliver_policy: new`. This keeps repeated test runs from
creating unbounded temporary streams while preventing historical application
events from being mistaken for the test event.

## Gotchas

- NATS is a transport adapter, not the architecture. Identity and Audit should
  depend on `Publisher` or an application-owned port, never on `Broker`.
- JetStream provisioning is intentionally not performed by module import or a
  constructor. The process composition root decides when infrastructure is
  ready.
- The adapter has no retry loop beyond JetStream's configured delivery policy;
  the outbox and receipt state machines remain the recovery authority.

## Used in

- `src/shared/events/nats/broker.ts`
- `src/shared/events/nats/broker.spec.ts`
- `src/shared/events/nats/broker.integration.spec.ts`
- `src/platform/runtime/nats-event-worker.ts`

## Related

- [`events`](../README.md)
- [`PostgreSQL event delivery`](../postgres/README.md)
