# Current Identity query design

`GetCurrentIdentity` is a read-side application capability that resolves a
usable session into a safe Identity projection without returning domain
entities, token material or producing state-changing events.

## Origin

This slice establishes the first explicit query in the Identity application
layer after registration, verification and session authentication commands.
It makes Command–Query Separation concrete without introducing a separate
database or full CQRS infrastructure.

## Query workflow

```text
session token
→ current-session reader
→ session expiry/revocation check
→ Identity view reader
→ safe current-Identity projection
```

The query accepts a `SecretString` session token. The transport adapter is
responsible for extracting the token from a cookie or authorization header and
wrapping it before calling the query.

The `CurrentSessionReader` owns token-to-session resolution. It does not expose
the stored digest to the query. The query then asks the Session domain object
to enforce expiry and revocation semantics.

## Read model

The query returns:

- `identityId`
- current Identity status
- `verifiedAt`

It does not return:

- the Identity domain object
- password or credential data
- session token or token digest
- ORM rows
- transport-specific response envelopes

The result is copied at the boundary, including `Date` values, so a caller
cannot mutate the read projection through a shared object reference.

## Query ports

### CurrentSessionReader

This outbound port resolves a session from a transport credential. The adapter
may hash the token and query a database, but those details remain outside the
application layer.

### IdentityViewReader

This outbound port returns a read-side `IdentityView`, not the domain Identity
entity. It is intentionally separate from `IdentityReader`, which is used by
commands that need domain behavior.

This distinction leaves room for a projection-optimized query later without
forcing commands and queries to share persistence models.

## Failure policy

Missing sessions, expired sessions, revoked sessions and inactive Identities
are all treated as unavailable current identity state. The query does not
reveal whether a particular session or Identity existed.

The current implementation uses the shared `unauthenticated` failure category
and the stable `identity.current_unavailable` type for inactive read-side
Identity state. Session-domain expiry and revocation failures remain visible
when the session itself rejects use.

## CQS boundary

This query does not:

- mutate Identity or Session state
- revoke or rotate a session
- publish an event
- write Audit records
- require a provenance work context for business attribution

Request tracing may still attach provenance at the transport or runtime
boundary. Durable Audit is reserved for state-changing facts and explicit
security-event policy.

The corresponding logout operation will be a command because it changes Session
state. It should not be implemented by adding a mutation to this query.

## Testing approach

Tests cover:

- resolving an active Identity from a usable session
- no Identity lookup when the session is missing
- rejecting an expired session
- rejecting a suspended Identity
- returning no session token in the projection

The query tests use fake reader ports and a deterministic clock. They do not
start NestJS, PostgreSQL or an HTTP server.

## Audit decision

No Audit domain is introduced for this slice. Reading the current Identity is
not itself a durable state-changing business fact. The existing shared
provenance and event envelope remain available for request diagnostics.

Audit will receive its own domain record and consumer/projector ports when we
implement the first durable event consumer. It will project facts from event
envelopes rather than duplicate Session or Identity entities.

## Deliberately deferred

- HTTP `GET /me` or equivalent transport route
- cookie versus bearer-token extraction
- richer profile projection
- organization membership projection
- session refresh and rotation
- logout/revocation command
- read-model caching
- Audit access logging policy

## Used in

- [`src/modules/identity/app/queries/get-current-identity.ts`](../../../../../src/modules/identity/app/queries/get-current-identity.ts)
- [`src/modules/identity/app/queries/get-current-identity.spec.ts`](../../../../../src/modules/identity/app/queries/get-current-identity.spec.ts)
- [`src/modules/identity/app/ports/current-session-reader.ts`](../../../../../src/modules/identity/app/ports/current-session-reader.ts)
- [`src/modules/identity/app/ports/identity-view-reader.ts`](../../../../../src/modules/identity/app/ports/identity-view-reader.ts)
- [`src/modules/identity/domain/session.ts`](../../../../../src/modules/identity/domain/session.ts)

## Related

- [Identity module overview](README.md)
- [Session and authentication design](SESSION-DESIGN.md)
- [Application design](APPLICATION-DESIGN.md)
- [Shared provenance notes](../../shared/provenance/README.md)
