# Audit domain contract

The audit domain owns durable business facts derived from identity events. It is
the only writer of audit records and has no dependency on identity internals.

## Guarantees

- Each supported identity event becomes at most one audit record per audit
  consumer. Unknown event types are acknowledged without creating a record.
- `occurred_at` comes from the source event. `recorded_at` is assigned when the
  audit consumer persists the record; they are intentionally distinct.
- The audit record and that consumer's mailbox receipt are committed in one
  PostgreSQL transaction. Retries are therefore idempotent.
- The read projection is `GET /v1/audit/records`, requires an authenticated
  session, defaults to 50 records, caps requests at 100, and is not cacheable.
- Ingestion depends on the shared publisher/mailbox ports. PostgreSQL outbox
  delivery and JetStream delivery are composition choices, not audit-domain
  APIs.

## Record value

Records retain actor, subject, action, outcome, provenance, source event ID,
event time, recording time, and structured details. Actor identity is taken from
the event's work attribution; audit does not infer it from the HTTP request.
