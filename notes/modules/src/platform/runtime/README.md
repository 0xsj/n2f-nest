# Platform runtime notes

The runtime composition owns process configuration, database startup,
migration ordering and lifecycle cleanup. Product modules receive selected
ports; they do not read environment variables or open database connections.

## Runtime modes

`N2F_STORAGE=memory` is the default. It keeps the local curl flow
self-contained and uses the in-memory Identity and Audit adapters.

`N2F_STORAGE=postgres` requires `N2F_DATABASE_URL`, opens the shared
PostgreSQL capability, applies migrations in this order, and selects the
PostgreSQL implementation for each module's application ports:

`N2F_IDENTITY_STORAGE` remains accepted as a compatibility alias for existing
local environments. New modules use the domain-neutral `storage` runtime
property and must not make provider selection depend on Identity.

In PostgreSQL mode, `N2F_EVENT_TRANSPORT` defaults to `nats`. Set it to
`local` for a self-contained process-local publisher.

1. shared events (`0001`)
2. Identity and credentials (`0002`)
3. mailbox receipts (`0003`)
4. verification challenges (`0004`)
5. sessions (`0005`)
6. Audit entries (`0006`)
7. Organization (`0007`)
8. Organization invitations (`0008`)
9. Document metadata (`0009`)
10. Jobs (`0010`)
11. Job subjects (`0011`)
12. Document processing (`0012`)
13. Persistence namespace rename (`0013`)

The migration files are configured as Nest assets because `import.meta.url`
resolves against `dist` in a built application. A database pool is closed by
the Nest application shutdown lifecycle.

## Event delivery in PostgreSQL mode

Identity writes state and outbox rows transactionally. `OutboxWorker` claims
one event at a time through the shared outbox store and hands it to the
`DURABLE_EVENT_PUBLISHER` token. Local transport forwards to the in-process
event bus and returns a durable receipt only after subscribers complete. NATS
transport publishes to JetStream and returns its server acknowledgement;
`NatsEventWorker` separately transfers messages into local subscribers and
acknowledges JetStream only after those subscribers complete. Audit itself uses
PostgreSQL in this mode, and duplicate delivery remains safe because the
projection is idempotent by event ID.

The transport is selected by `N2F_EVENT_TRANSPORT=local|nats`. NATS requires
PostgreSQL mode because the durable outbox is its source of truth. Provisioning
is performed by the runtime composition provider before the workers start, and
the NATS connection closes with the Nest application.

`N2F_NATS_STREAM` defaults to the local `n2f_events` stream and
`N2F_NATS_SUBJECT_PREFIX` defaults to `n2f.events.`. A legacy deployment can
temporarily use `N2F_NATS_STREAM=signals` and
`N2F_NATS_SUBJECT_PREFIX=signals.events.` during rollback or compatibility
work.

## Real database verification

The default Vitest suite intentionally remains infrastructure-free. The gated
`test:postgres` command boots the real Nest application with PostgreSQL mode,
walks an Identity through registration, verification, login, current-user
lookup and logout over HTTP, waits for the outbox worker to deliver the events,
reads the Audit projection, and verifies the durable rows directly. This
catches migration, provider-selection, lifecycle and asynchronous delivery
mistakes that adapter unit tests cannot see.

```bash
N2F_DATABASE_URL=postgres://n2f:n2f_local@127.0.0.1:7620/n2f \
bun run test:postgres
```

The test uses a unique email per run and is intended for an isolated local
database. It does not reset the database or drop migrations.

`test:nats` runs the same lifecycle through JetStream and also exercises the
redelivery boundary by failing a destination publisher once before allowing
the message to be acknowledged.

## Selection rule

The provider factories choose the complete Identity port set together. They do
not allow a request to combine a PostgreSQL writer with in-memory readers or
vice versa. Partial provider switching would produce misleading authentication
behavior and is therefore rejected by composition rather than left to runtime
luck.

## Used in

- `src/platform/runtime/config.ts`
- `src/platform/runtime/runtime.module.ts`
- `src/platform/runtime/outbox-worker.ts`
- `src/platform/runtime/nats-event-worker.ts`
- `src/platform/runtime/tokens.ts`
- `src/app/migrations.ts`
- `nest-cli.json`
- `test/postgres.integration.spec.ts`

## Related

- [Platform events](../events/README.md)
- [Identity infrastructure and transport](../../modules/identity/INFRA-TRANSPORT-DESIGN.md)
- [Shared PostgreSQL notes](../../shared/postgres/README.md)
