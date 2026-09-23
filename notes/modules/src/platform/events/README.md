# Platform events notes

Event delivery is one path in every storage mode: a producer's write records
the event, an inbox holds one delivery per named consumer, and a loop per
consumer delivers it with retries. No consumer runs inside a producer's write.

## Origin

Until 2026-09-23 `EVENT_BUS` was a synchronous in-process bus. In memory mode a
writer's `publish` ran every subscriber inline, so a failing Audit or workflow
subscriber failed, and rolled back, the producer's write. Durable modes fanned
one delivery out to all subscribers, so one failure redelivered to every
subscriber, retried at a fixed 100 ms and gave up after 5 attempts. NATS held
each acknowledgement open while subscribers ran, inside a 1 s deadline. See
the [hardening bar](../../../../architecture/hardening-bar.md), items R4, R8, B3
and B4.

## What and why

- **Publishing never runs a subscriber.** `EventDelivery` (the `EVENT_BUS`
  provider) records each published event in the inbox for every subscribed
  consumer and returns. Writers call it directly in memory mode; in
  PostgreSQL mode the outbox dispatcher (local transport) or `NatsEventWorker`
  (NATS transport) calls it after the writer's transaction committed.
- **Consumers are named and independent.** `subscribe('audit', handler)`.
  `EventDelivery` runs one loop per consumer that leases the next due event,
  runs the handler outside any transaction, and records processed, retrying
  (exponential backoff with jitter, `DEFAULT_RETRY`) or dead. A failing
  consumer never redelivers to another.
- **The inbox follows the storage mode.** PostgreSQL uses `Mailbox`
  (`n2f_mailbox` plus `n2f_mailbox_receipts`, leased with `SKIP LOCKED`, so
  several processes share the work); memory mode uses `InMemoryInbox` with the
  same semantics. `src/shared/events/inbox.contract.spec.ts` runs one contract
  against both.
- **Delivery is at least once.** Handlers must be idempotent by event ID.
  Audit is (`event_id UNIQUE`); the document-processing workflow must treat a
  transition it has already applied as done (hardening item R5).
- **Dead events wait for an operator.** `bun run events:requeue --consumer
  <name> [--event <id>]` or `--outbox` returns them with a fresh budget.

`OutboxDispatcher` still coordinates exactly one outbox attempt; lease and
retry state belong to the store, scheduling to `OutboxWorker`.

## Example

A consumer that keeps failing (the chaos spec arms `event.consume.before` for
`audit` only): registration still answers 201, `document-processing` processes
the event, and Audit's delivery is dead-lettered after its attempt budget
(`test/chaos.integration.spec.ts`).

## Gotchas

- A consumer receives events published after it subscribed. A consumer added
  in a later release does not see earlier events.
- Ordering is by availability, not strict per aggregate: a retried event can
  be delivered after a later one. Handlers must not assume order.
- Tests observe delivery by polling (`test/support/eventually.ts`); in memory
  mode it usually completes within milliseconds but is never synchronous.
- `InMemoryEventBus` remains only as a synchronous test double.

## Used in

- `src/platform/events/event-delivery.ts`
- `src/platform/events/events.module.ts`
- `src/platform/events/outbox-dispatcher.ts`
- `src/platform/runtime/{outbox-worker,nats-event-worker,event-maintenance}.ts`
- `src/shared/events/{inbox,in-memory-inbox,retry}.ts`
- `src/shared/events/postgres/store.ts`

## Related

- [Shared events notes](../../shared/events/README.md)
- [Platform runtime](../runtime/README.md)
- [Chaos and fault injection](../chaos/README.md)
