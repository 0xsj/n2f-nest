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

## Gotchas

- `Database.open` pings the pool. Startup policy may choose to fail fast or
  expose a degraded health state, but the capability itself returns a result.
- The migration table is intentionally process-specific (`signals_migrations`)
  and should be owned by the deployment that owns the database.
- Integration tests need `SIGNALS_TEST_DATABASE_URL`; unit tests validate
  configuration and mapping without starting a database.

## Used in

- `src/shared/postgres/index.ts`
- `src/shared/postgres/postgres.spec.ts`

## Related

- [`events`](../events/README.md)
- [`env`](../env/README.md)
- [`errors`](../errors/README.md)
