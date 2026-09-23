# ADR-001: Replace the legacy Signals persistence and event namespace

**Status:** Completed — namespace renamed, history squashed into baselines (2026-09-23)

## Context

The backend is now the reusable `n2f-nest` boilerplate, but its first
PostgreSQL and JetStream implementation still carries names from the earlier
Signals product:

- PostgreSQL objects use the `signals_` prefix;
- the migration ledger is `signals_migrations`;
- the NATS adapter publishes on `signals.events.<stream>`;
- the local deployment currently provisions a `signals` stream.

The runtime storage selector is already domain-neutral (`N2F_STORAGE`), but the
persistence and event namespaces are still product-specific. Renaming them is
stateful infrastructure work and cannot be treated as a source-only cleanup.

## Decision

The target boilerplate namespace is:

- PostgreSQL application objects: `n2f_...`;
- NATS subject prefix: `n2f.events.`;
- default JetStream stream: `n2f_events` once the deployment account is
  permitted to provision it.

The current `signals` database objects and `signals.events.*` subject remain
the compatibility namespace until the cutover is explicitly run. The stream
name is deployment configuration, not domain language; it may remain
`signals` during the transition if the subject and permissions are handled by
an explicit compatibility plan.

The NATS adapter exposes the subject prefix as
`N2F_NATS_SUBJECT_PREFIX`. The local target configuration is
`N2F_NATS_STREAM=n2f_events` with `N2F_NATS_SUBJECT_PREFIX=n2f.events.`.
Legacy deployments can explicitly use the old stream and prefix during
rollback.

The migration ledger is treated separately. The first cutover may retain
`signals_migrations` so the existing migration runner can recognize its own
history. Renaming the ledger is a later migration-runner change, not something
to fold into the application-table rename.

## Namespace inventory

The database rename must cover tables, indexes and any explicitly named
constraints for:

- shared events: outbox, mailbox and mailbox receipts;
- Identity: identities, credentials, verification challenges and sessions;
- Audit entries;
- Organization: organizations, memberships and invitations;
- Document metadata;
- Jobs and job subject uniqueness.

Foreign-key references are preserved by PostgreSQL table renames, but all SQL
queries, migration checks and adapter tests must move together. No table is
dropped as part of the rename.

## Migration sequence

### 1. Prepare

- Take a verified PostgreSQL backup or snapshot.
- Confirm the current migration ledger and row counts for every legacy table.
- Confirm JetStream permissions for the target stream and subject.
- Stop writes or place the application in a maintenance window.
- Keep the current `signals` NATS stream available for rollback.

### 2. Rename PostgreSQL objects

Add a versioned, transactional migration that renames the application tables,
indexes and named constraints from `signals_` to `n2f_`. Preserve all rows and
leave `signals_migrations` unchanged during this phase. The migration must be
tested against a clone containing real data, not only an empty database.

### 3. Cut the adapters over

Update the shared PostgreSQL event store and every module adapter to use the
`n2f_` object names. Update query-spy assertions and the live PostgreSQL
integration. The application must not run with mixed old/new table names.

### 4. Cut over JetStream

Provision the target `n2f.events.<stream>` subject and consumer. Drain or
replay the old outbox delivery path, verify Audit has caught up, then switch
the runtime default. Retain the old stream for the agreed retention window;
do not delete it as part of the first deployment.

### 5. Remove compatibility artifacts

After the rollback window, remove the old subject and rename the migration
ledger through a separately tested runner change. Only then should a repository
search be expected to find no `signals_` namespace references, apart from
historical migration documentation.

## Rollback

The PostgreSQL rename is reversible while the maintenance window is open by
applying the inverse table/index/constraint renames. Because the migration
does not delete or transform rows, rollback does not require data restoration
unless a separate application write occurred after cutover.

JetStream rollback keeps the old stream and consumer available. The runtime
can be pointed back to the old subject while the database remains on the
chosen namespace; database and event cutovers must therefore be verified as
independent steps.

## Verification gates

- migration dry run against a populated database clone;
- migration checksum and ordering checks;
- row-count and foreign-key checks before and after rename;
- full unit and architecture suite;
- live PostgreSQL lifecycle through Identity, Organization, Document, Jobs and
  Audit;
- live NATS/JetStream delivery and redelivery tests;
- a repository namespace scan with only documented historical references left.

## Dry-run evidence

On 2026-09-22, the draft was applied to a populated PostgreSQL clone copied
from the local `n2f` database. The clone contained migration versions 1–12
and preserved these representative row counts after the rename: 34
identities, 34 memberships, 23 documents, 38 jobs, and 432 outbox events.

The registered application migration `0013` was then executed against a fresh
clone through `Database.migrate(appMigrations)`. The verification SQL passed,
including the full table inventory, legacy table absence, legacy
index/constraint absence, compatibility ledger preservation, and row-count
checks. At the time of this clone validation, the live application database
and NATS stream were not changed.

The target NATS configuration was also exercised on a disposable JetStream
server: `n2f_events` provisioned successfully with the `n2f.events.` subject
prefix, and both redelivery and lost-ack recovery tests passed. The shared
local `signals` stream was not modified.

After the clone validation, migration `0013` was applied to the local `n2f`
database. The ledger is now at version 13, all 13 application tables use the
`n2f_` namespace, and the PostgreSQL lifecycle integration passed 2/2 tests.
The project-owned local NATS server now provisions and uses `n2f_events`; the
legacy `signals` stream remains available for rollback and was not deleted.
The NATS blueprint's JetStream file-store ceiling was increased from 256MB to
1GB because the existing persisted streams had exhausted the original limit.

## Consequences

This keeps the boilerplate free of accidental Signals branding without hiding
a stateful infrastructure change inside a normal refactor. It requires one
coordinated database deployment and one JetStream permission/cutover window,
but it preserves a clear rollback path and makes the next application start
predictable.

## Related

- [Platform runtime](../modules/src/platform/runtime/README.md)
- [Shared PostgreSQL](../modules/src/shared/postgres/README.md)
- [Shared NATS adapter](../modules/src/shared/events/nats/README.md)
- [0013 namespace rename draft](ADR-001-0013-namespace-rename.sql)
- [Namespace verification SQL](ADR-001-namespace-verification.sql)

## Addendum: migration baseline (2026-09-23)

The rename left every new database replaying the old product's history:
tables were created as `signals_*` and renamed by migration 0013, recorded in a
`signals_migrations` ledger. With the hardening work the history reached 26
migrations.

That history is now squashed into one baseline per owning module (versions
1–7, `migrations/baseline.sql` beside each module's adapters), recorded in
`n2f_migrations`. Constraint and index names are unchanged, because adapters
map them to domain failures.

Existing databases are not rebuilt. `Database.migrate` adopts a database whose
`signals_migrations` ledger holds exactly the 26-migration history (verified by
the checksum of its final migration): it records the baselines as applied and
drops the old ledger. `test/migration-baseline.integration.spec.ts` restores
the legacy schema (`test/fixtures/legacy-schema-v26.sql`), adopts it, and
proves its catalog is identical to a fresh baseline database. A database with
only part of that history (for example one migrated by v1.0.8, which had 14
migrations) is refused with `database.legacy_history` and must be reset; no
such database was deployed.

The SQL files kept beside this note document the original cutover and are no
longer executed.

