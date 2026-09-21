# PostgreSQL event delivery notes

The PostgreSQL event adapter provides a transactional outbox, a mailbox and
consumer-scoped receipts without changing the domain-facing `Publisher` seam.

## What and why

- `enqueue` writes an event into the outbox using the same transaction as the
  domain state change. This is the commit-safe handoff Identity and other
  domains need.
- `Store` claims, dispatches, acknowledges or releases bounded leases. A
  publisher receipt is checked for both durability and event identity.
- `Mailbox` gives a local consumer a durable inbox and per-consumer receipt.
  The same event may therefore be processed by Audit and another consumer
  independently.
- Savepoints allow a consumer failure to roll back its business work while
  recording a retry/dead-letter transition in the outer transaction.

## Gotchas

- This is an infrastructure adapter, not the event contract. Domain code only
  sees `Envelope`, `Publisher` and its own event payload type.
- The polling and retry intervals are intentionally bounded constants for the
  first slice. Operational tuning can be added without changing the seam.
- Database integration tests require `SIGNALS_TEST_DATABASE_URL`; unit tests
  exercise validation and the adapter's pure branches without PostgreSQL.

## Used in

- `src/shared/events/postgres/store.ts`
- `src/shared/events/postgres/migrations/0001_events.sql`
- `src/shared/events/postgres/migrations/0003_mailbox_receipts.sql`

## Related

- [`events`](../README.md)
- [`postgres`](../../postgres/README.md)
