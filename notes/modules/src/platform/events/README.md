# Platform events notes

The platform event layer composes delivery implementations without making
product modules know whether events are delivered in-process or remotely.

## Event bus boundary

`EVENT_BUS` is the Nest provider token for the current process-local
`InMemoryEventBus`. Identity publishes through the `EventBus` contract and
Audit subscribes through that same boundary. The concrete provider can be
replaced without changing either module's domain or application layer.

## Outbox coordination

`OutboxDispatcher` coordinates exactly one durable delivery attempt. It asks
an `IDGenerator` for a lease token, then delegates claim, retry, acknowledgement
and release behavior to the injected `OutboxStore`. The shared PostgreSQL
outbox `Store` is one implementation of that capability; the NATS `Broker` is
the durable publisher it can hand events to.

Keeping this class to one attempt is intentional. Scheduling, backoff,
shutdown and operational policy belong to the process composition layer, while
lease correctness belongs to the outbox store. This prevents a timer loop from
becoming an accidental second source of delivery semantics.

## Current status

The local Nest application uses the in-memory bus when
`N2F_EVENT_TRANSPORT=local`, so curl and Kulala remain self-contained. In
PostgreSQL/NATS mode, the outbox publisher is the NATS JetStream broker and a
separate runtime worker transfers messages to the current-process subscribers
before acknowledging them. The product modules still see only `Publisher` and
`EventBus` contracts.

## Used in

- `src/platform/events/event-bus.ts`
- `src/platform/events/events.module.ts`
- `src/platform/events/in-memory-event-bus.ts`
- `src/platform/events/durable-in-process-publisher.ts`
- `src/platform/events/outbox-dispatcher.ts`
- `src/platform/events/outbox-dispatcher.spec.ts`
- `src/platform/runtime/nats-event-worker.ts`

## Related

- [Shared events notes](../../shared/events/README.md)
- [Identity infrastructure and transport](../../modules/identity/INFRA-TRANSPORT-DESIGN.md)
- [Audit module](../../modules/audit/README.md)
