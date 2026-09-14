# Audit ingestion: receipts and an authenticated projection

The audit consumer can be added without taking acknowledgement state away from
another consumer, and its record becomes visible only with its durable receipt.

**Origin:** implementing the first stage-8 audit slice and running
'python3 tools/verify_audit.py' against disposable PostgreSQL 18 and NATS
JetStream processes on 2026-09-13.

**What and why:** migration 3 replaces mailbox-wide processing columns with
'(event_id, consumer)' receipts. A legacy mailbox row is preserved as the
'events-example' receipt, so upgrading does not silently forget pending work.
The audit record and its receipt are inserted in one PostgreSQL transaction
with 'ON CONFLICT(event_id) DO NOTHING'; a retry therefore cannot duplicate
the projection. The root owns dispatch and lifecycle, while the audit module
translates the versioned event wire shape without importing identity internals.

**Example:** the real-process verifier registered, verified and logged in one
principal, observed three audit actions, checked their distinct occurred and
recorded millisecond timestamps, and found three processed 'audit' receipts in
each transport mode. The authenticated 'GET /v1/audit/records' route returned
the projection with 'Cache-Control: no-store'; anonymous access and a limit of
101 were refused, and the configured fixture secret was absent from the
projection and logs.

**Gotchas:** the old pending index depends on the columns that migration 3
drops, so the index must be removed before the columns. The root passes the
identity migration into the audit composition so the ordered migration ledger
remains complete without making the audit module import a peer domain. Audit is
asynchronous, refused logins emit no identity event, and this slice defines
neither retention nor a historical backfill.

**Used in:** 'src/modules/audit', 'src/shared/events/postgres', 'src/root/http.ts'
and the authenticated HTTP route. See [the contract](../../../../../src/modules/audit/CONTRACT.md),
[the live evidence](audit-verification-evidence.json) and [the mutation evidence](audit-mutation-evidence.json).

**Related:** [durable receipts](../../shared/events/durable-receipts.md).
