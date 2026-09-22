# Audit module notes

Audit is a durable event projection, not a second source of domain truth. Its
write port is idempotent by source event ID so a consumer can safely persist an
event before an acknowledgement is lost.

## Origin

The in-memory adapter and normal workflow tests already covered duplicate
delivery. The durable boundary also needs an explicit redelivery test because
JetStream acknowledgement and PostgreSQL commit are separate effects.

## What and why

`n2f_audit_entries.event_id` is unique. The PostgreSQL writer inserts with
`ON CONFLICT (event_id) DO NOTHING`, then returns the existing projection when
the same event is delivered again. A consumer may therefore follow this
sequence safely:

```text
persist audit entry -> acknowledgement is lost -> event is redelivered
                     -> return existing entry -> acknowledge successfully
```

The second delivery does not create a second audit fact, and the source event
ID remains the idempotency key across process boundaries.

## Gotchas

- The audit row is not acknowledged by the writer itself; the transport worker
  owns the message acknowledgement after the sink succeeds.
- A different event reusing an existing event ID is a conflict, not a duplicate.
- Durable redelivery tests use an isolated JetStream consumer and a unique
  event, then remove the audit row from PostgreSQL during cleanup.

## Used in

- [`src/modules/audit/infra/postgres/adapters.ts`](../../../../../../src/modules/audit/infra/postgres/adapters.ts)
- [`src/modules/audit/infra/postgres/migrations/0006_audit.sql`](../../../../../../src/modules/audit/infra/postgres/migrations/0006_audit.sql)
- [`test/audit-redelivery.integration.spec.ts`](../../../../../../test/audit-redelivery.integration.spec.ts)
