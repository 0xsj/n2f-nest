# PostgreSQL module notes

PostgreSQL is a concrete infrastructure capability: it owns pools, transaction
lifetime, migration checksums and safe driver-to-failure mapping.

## Origin

The database boundary is being rebuilt before Identity and Audit so those
domains can depend on a transaction seam without importing `pg` types into
their application or domain layers.

## What and why

- `Database.transaction` leases a client, begins and commits or rolls back the
  transaction, and releases the client in one owner-controlled scope.
- A callback receives an `AbortSignal` but cannot own the client lifetime. It
  must await its work before returning.
- Timeouts and cancellation destroy the leased client. A timeout during commit
  is reported as `database.commit_uncertain` because the caller cannot safely
  assume whether PostgreSQL committed.
- Migrations are ordered, checksummed and serialized with a PostgreSQL
  advisory transaction lock. Changed historical SQL is drift, not a silent
  rewrite.
- Driver errors are mapped to shared `Failure` values. Credentials and pg
  diagnostics do not cross the boundary.
- Unique violations (`23505`) map to `database.conflict`, but adapters first
  ask `violatedUnique` for the constraint name so they can report the domain
  conflict (`identity.email_taken`) rather than a generic one. The in-memory
  adapters must report the same type, or tests against memory prove nothing
  about PostgreSQL.
- Serialization failures and deadlocks (`40001`, `40P01`) map to
  `unavailable`/`database.serialization`: the request was not wrong, and the
  same operation can succeed when retried.
- Updates are version-checked: `SET ..., version=version+1 WHERE id=$1 AND
  version=$loaded`. When no row matches, `missingOrStale` tells a missing
  record from a read another writer has superseded, so the adapter can report
  not-found or a stale-write conflict. See the [version leaf](../version/README.md).

## Gotchas

- `Database.open` pings the pool. Startup policy may choose to fail fast or
  expose a degraded health state, but the capability itself returns a result.
- Applied migrations are recorded in `n2f_migrations`. Versions 1–7 are
  baselines squashed from the v1.0.8 history; `Database.migrate` adopts a
  database whose legacy `signals_migrations` ledger holds that entire history
  (proven schema-identical by `test/migration-baseline.integration.spec.ts`)
  and refuses any partial one.
- Integration tests need `N2F_RUN_POSTGRES_INTEGRATION=1` and a disposable `N2F_DATABASE_URL`; unit tests validate
  configuration and mapping without starting a database.

## Used in

- `src/shared/postgres/index.ts`
- `src/shared/postgres/postgres.spec.ts`

## Related

- [`events`](../events/README.md)
- [`env`](../env/README.md)
- [`errors`](../errors/README.md)
