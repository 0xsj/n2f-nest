# n2f-nest

NestJS integration example for N2F. This is a fresh backend scaffold for
exploring idiomatic Nest module composition alongside explicit
`app/`, `domain/`, `infra/` and `transport/` boundaries.

## Development

```bash
bun install
bun run start:dev
```

Useful commands:

```bash
bun run build
bun run test
bun run lint
bun run check:architecture
bun run check
bun run format
```

The normal test command does not require infrastructure. To exercise the
PostgreSQL migrations, durable Identity and Organization writes, outbox worker
and Audit projection together, provide a PostgreSQL URL and run the gated
integration check:

```bash
N2F_DATABASE_URL=postgres://n2f:n2f_local@127.0.0.1:7220/n2f \
bun run test:postgres
```

Use an isolated local database for this check. The test creates one unique
Identity and leaves the database schema in place for subsequent runs.

To exercise the NATS JetStream publisher and consumer seam as well, provide a
NATS URL and run:

```bash
N2F_DATABASE_URL=postgres://n2f:n2f_local@127.0.0.1:7220/n2f \
N2F_NATS_URL=nats://127.0.0.1:7222 \
bun run test:nats
```

NATS mode provisions and verifies the configured stream and durable consumer.
The outbox publishes to JetStream, and the NATS worker forwards deliveries to
the local Audit subscriber before acknowledging them. The command also checks
that a failed destination is redelivered before ACK.

The outbox recovery check exercises the durable ambiguous-publish window. Run
it with the application process stopped so no second outbox worker can claim
the fixture row:

```bash
N2F_DATABASE_URL=postgres://n2f:n2f_local@127.0.0.1:7220/n2f \
N2F_NATS_URL=nats://127.0.0.1:7222 \
bun run test:recovery
```

It verifies that a lost publisher acknowledgement leaves the PostgreSQL
outbox pending, a replay marks it sent, and JetStream delivers the event once
because the event ID is the deduplication key.

For a network-level smoke against the running persistent backend, start it
from the integration workspace and run the TCP E2E target:

```bash
make backend-persistent
make backend-test-persistent-e2e
```

This exercises the real HTTP boundary for registration, verification, login,
organization and document-processing workflows, session revocation and
asynchronous Audit delivery. The in-process durable integration remains the
broader persistence and adapter test.

The [`requests/identity.http`](requests/identity.http) file contains the
Kulala-friendly register, verify, login, current-identity and logout flow.
The [`requests/organization.http`](requests/organization.http) file contains
the authenticated organization create and list requests. The
[`requests/document.http`](requests/document.http) file contains the
organization-scoped Document create, list, get, process and archive flow. Run
the backend first, then execute each request from top to bottom in Neovim.

The default runtime uses process-local Identity and Audit state. To run the
durable local stack, provide the PostgreSQL and NATS settings before startup:

```bash
N2F_STORAGE=postgres \
N2F_EVENT_TRANSPORT=nats \
N2F_DATABASE_URL=postgres://n2f:n2f_local@127.0.0.1:7220/n2f \
N2F_NATS_URL=nats://127.0.0.1:7222 \
N2F_NATS_STREAM=n2f_events \
N2F_NATS_SUBJECT_PREFIX=n2f.events. \
bun run start:dev
```

PostgreSQL mode runs the shared event, Identity, challenge, session, Audit,
Organization, Document, Jobs and namespace migrations, then starts the outbox
worker. NATS replaces the local publisher with JetStream and starts a consumer
that delivers to the PostgreSQL-backed Audit projection. Set
`N2F_EVENT_TRANSPORT=local` when a self-contained process-local publisher is
preferred.

The Organization module currently supports authenticated listing, creation,
adding an existing active Identity, owner-authorized role changes and
owner-authorized revocation of non-owner memberships. Invitations remain a
separate pending state targeting an existing active Identity; acceptance and
membership creation now occur atomically through the acceptance path. Owners
can also revoke pending invitations; expiry is currently evaluated at
acceptance time rather than materialized by a scheduler. Email-based discovery
and delivery remain future seams.

The baseline module set is Identity, Organization, Document, Jobs and Audit.
Document now has a metadata and processing-lifecycle slice with in-memory and
PostgreSQL adapters. Jobs now has an organization-scoped execution lifecycle
with bounded retries, opaque subject references and in-memory/PostgreSQL
adapters. The Document Processing workflow composes the two without importing
either domain into the other, and Audit remains the event-observing foundation.

The repository-level `Makefile` also provides the normal frontend, backend and
infrastructure commands.

## Shape

- `src/modules/` contains product modules.
- `src/shared/` contains framework-free capabilities shared by modules.
- `src/platform/` contains process and runtime adapters.
- `src/common/` is reserved for genuinely cross-cutting application concerns.
- `src/app.module.ts` is the Nest composition root.

Product modules follow the agreed `app/`, `domain/`, `infra/` and `transport/`
separation. The seam between in-process delivery and NATS adapters belongs at
the owning boundary; shared leaves should not depend on Nest or a transport.

Expected failures are values in module and workflow `domain/` and `app/` code.
Those core layers must not use `throw` or `catch`; the repository enforces this
with `bun run check:architecture`. Infrastructure catches exceptions from
external systems and converts them to failures. Transport may translate a
failure into a framework response, and startup may fail fast for invalid
configuration.

## Notes

The [`notes/`](notes/README.md) directory explains intent that code and tests
cannot fully show: language behavior, runtime ownership, patterns, alternatives
and verification techniques. Start with the [errors module notes](notes/modules/src/shared/errors/README.md).
