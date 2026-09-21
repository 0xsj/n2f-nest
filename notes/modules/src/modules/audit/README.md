# Audit module

The Audit application layer exposes a closed `AuditApplicationFailure` union.
Malformed event subjects and domain failures remain typed Audit failures;
reader, writer and event-boundary failures are normalized with an operation
label before they leave the module. The open ports intentionally still accept
shared `Failure` values, which lets infrastructure vary without changing the
domain or application contract.

Audit is an event consumer and projection owner. It records security-relevant
facts emitted by other modules without becoming a dependency of those modules.

## Boundary

Audit owns:

- immutable audit-entry metadata;
- source event identity and version;
- occurred and recorded timestamps;
- provenance needed to explain who initiated work and which logical work it
  belongs to;
- a small subject reference when an event identifies one.

Audit does not own Identity state, authentication decisions, credentials,
session tokens or authorization. It does not call Identity to reconstruct
facts after receiving an event.

## DDD shape

Audit is a projection bounded context rather than a source-of-truth context
for the other modules. `AuditEntry` is an immutable projection aggregate: its
source event ID, versioned event type, subject reference, timestamps and
provenance are validated once at the domain boundary. The domain returns the
closed `AuditEntryFailure` union, so malformed event data is an expected
outcome rather than an exception-driven branch.

The Audit application layer consumes the shared `Envelope` and translates it
into the Audit-owned model. The envelope remains a shared transport contract;
the Audit subject vocabulary and persistence idempotency remain local to this
bounded context. This keeps Audit useful as an event consumer without making
every producing domain depend on Audit types.

## First slice

`RecordAuditEvent` consumes a shared `Envelope`, creates an immutable
`AuditEntry`, and records it through an idempotent writer keyed by the source
event ID. Identity events with an `identity_id` payload become an `identity`
subject reference. Domain events with `document_id` or `job_id` become
`document` or `job` subjects; a generic `{ type, id }` subject is used as a
fallback. Raw event payloads are not copied into the audit entry, so
secret-bearing event shapes do not automatically become audit storage.

The local harness exposes `GET /audit/entries` so the projection can be
inspected while developing through curl or Kulala. It is a development read
surface, not yet the final audit administration API.

## Event seam

The platform exposes an `EVENT_BUS` token backed locally by
`InMemoryEventBus`. Identity and Audit depend on the platform `EventBus`
contract rather than on that concrete class. The contract extends the shared
`Publisher` and adds subscription for in-process consumers.

Identity persists its event in its local outbox-shaped store and then hands the
envelope to the bus. Audit subscribes during module initialization. A future
PostgreSQL outbox dispatcher or NATS adapter can replace the provider behind
the token without changing the Audit command or domain model.

The local bus is deliberately not durable and returns `durable: false` in its
receipt. The event remains in the Identity process-local event collection for
inspection; production delivery needs the existing outbox and NATS adapters.

When `N2F_IDENTITY_STORAGE=postgres`, Audit switches to a PostgreSQL projection
with a unique source-event constraint. The local outbox worker still uses the
in-process subscriber as its delivery target, so the complete local durable
path is PostgreSQL state → PostgreSQL outbox → in-process event bus →
PostgreSQL Audit projection. The remote NATS publisher/consumer topology is
still a later transport substitution.

## Idempotency

Event delivery can be retried. `InMemoryAuditEntryWriter` checks the source
event ID before adding an entry and returns the existing entry with
`created: false` when it has already been projected. This behavior belongs at
the consumer-owned write boundary, where a durable implementation can enforce
the same rule with a unique constraint.

## Provenance

Audit stores a copied `WorkSnapshot`, including work ID, correlation ID,
operation and initiator attribution. The request ID is used as the root work
ID by the HTTP transport; the provenance factory still creates the correlation
ID according to its root-scope rules. Audit therefore preserves both the HTTP
lineage anchor and the logical correlation scope.

## Used in

- `src/modules/audit/domain/`
- `src/modules/audit/app/`
- `src/modules/audit/infra/`
- `src/modules/audit/transport/http/`
- `src/platform/events/event-bus.ts`
- `src/platform/events/in-memory-event-bus.ts`
- `src/modules/audit/infra/postgres/adapters.ts`
- `src/modules/audit/infra/postgres/migrations/0006_audit.sql`

## Related

- [Identity infrastructure and transport](../identity/INFRA-TRANSPORT-DESIGN.md)
- [Shared events notes](../../shared/events/README.md)
