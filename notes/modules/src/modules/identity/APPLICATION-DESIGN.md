# Identity registration application design

The registration use case orchestrates Identity and Credential creation,
secret handling and provenance-bearing event recording without importing
database, crypto, NestJS or transport implementations.

## Origin

This note records the first application-layer slice after the Identity and
Credential domain slices. The goal is to make one real workflow explicit:

```text
registration request
→ password policy
→ Identity + Credential domain state
→ password hashing port
→ provenance-bearing event envelope
→ atomic state and outbox commit
```

The workflow is intentionally not an HTTP controller and does not require a
database to test. The first PostgreSQL registration adapter now wraps the
commit boundary without changing this application contract; the remaining
Identity persistence operations will follow the same port shape.

## Command boundary

`RegisterIdentity` accepts:

- an email candidate
- a `SecretString` password
- a trusted `WorkContext` provenance value
- an optional cancellation signal

The transport boundary will convert the raw HTTP password into `SecretString`
before calling the use case. The application layer therefore has an explicit
secret wrapper and does not pass ordinary strings through the workflow.

The use case returns only Identity and Credential IDs plus the initial status.
It does not return the password, hash, event bytes, verification token or
session information.

## Ports

A port is a narrow, technology-neutral capability boundary owned by the layer
that needs the interaction. It describes what the caller needs, not how an
adapter will implement it.

In this architecture there are two directions:

- an inbound application port is a use-case capability offered to transport or
  another composition boundary; `RegisterIdentity.execute(...)` is currently
  this capability even though the class is not named `Port`
- an outbound application port is an interface owned by the application and
  implemented by infrastructure; `PasswordHasher`, `PasswordPolicy` and
  `RegistrationWriter` are examples

A valid port has a clear owner, a narrow purpose, and a stable language of
capabilities. It does not expose NestJS decorators, TypeORM entities, `pg`
clients, NATS subjects, HTTP responses or vendor-specific crypto options.
Ports are not a generic service bag and not a second shared utility layer.

Expected failures use the shared `Result`/`Failure` boundary. Cancellation is
accepted where an operation may wait on external work. Provenance belongs on
the application command or event envelope when the capability needs lineage;
it does not become an incidental field on every domain object.

### PasswordPolicy

`PasswordPolicy` validates product security requirements without making the
use case responsible for password-strength rules. The first port is
synchronous because it only evaluates the provided secret.

The policy is deliberately separate from hashing. A change in minimum length,
breached-password checks or tenant policy should not require changing the
cryptographic adapter.

### PasswordHasher

`PasswordHasher` is the crypto seam. It receives a `SecretString` and returns a
redacted `SecretString` containing the password hash.

The port does not name Argon2, bcrypt or any other implementation. The concrete
adapter belongs under Identity infrastructure and can be replaced in tests.
Password verification will use a corresponding application port when login is
implemented.

### RegistrationWriter

`RegistrationWriter` is intentionally one atomic capability rather than three
independent repository calls. Its commit input contains:

- the new Identity
- the new Credential
- the password hash for persistence
- the `identity.registered.v1` event envelope
- the same provenance work context

The adapter must make Identity state, Credential state and the outbox event
durable as one transaction. It must not publish the event before the state is
committed.

This keeps the application independent from PostgreSQL while preserving the
outbox invariant needed for reliable Audit consumption.

## Registration ordering

The current use case follows this order:

1. reject an empty password
2. apply the password policy
3. read one explicit wall-clock timestamp
4. generate an Identity ID
5. create a pending Identity
6. generate a Credential ID
7. create and normalize the email/password Credential
8. hash the password through the port
9. generate an event ID
10. create the versioned event envelope
11. ask the writer to atomically commit state and outbox fact
12. return public identifiers and status

Failures stop the workflow before the writer is called. The use case does not
attempt compensation because no external state is written before the atomic
writer boundary.

## Provenance role

Provenance belongs at the application and event boundaries, not inside the
Identity or Credential entities.

The registration command carries a `WorkContext` that identifies:

- the logical work and correlation lineage
- the initiating actor, which may be anonymous
- the operation name, currently `identity.register`
- origin and causation information when supplied by the caller

The event envelope retains this work context. Audit can therefore project the
registration into actor, subject, action and outcome records without Identity
importing Audit or storing an execution trace in its own state.

For a public registration, the initiator is normally anonymous. That is a
valid provenance attribution and must not be replaced with the newly created
Identity before authentication has succeeded.

For an administrative registration, the transport/application boundary will
provide the authenticated operator and any organization context. The domain
entity itself remains unaware of that attribution.

Provenance is not authorization. The use case or an authorization policy must
decide whether an actor may perform an operation; provenance records who and
what lineage the operation had after it is admitted.

## Event payload boundary

The event type is `identity.registered.v1`.

The current payload contains only:

- `identity_id`
- `credential_id`
- `credential_method`
- initial Identity status

It intentionally excludes:

- raw password
- password hash
- email address
- session token
- verification or recovery code

The email address remains available to the persistence/verification workflow
without being placed in the generic registration event. Whether a later
verification event needs a delivery address is a separate product and privacy
decision.

## Testing technique

The application tests use small in-memory fakes for each port:

- a deterministic ID generator
- a fake clock
- an allowing or rejecting password policy
- a recording password hasher
- a recording atomic writer

This tests orchestration without a database, crypto library or Nest container.
The tests assert both positive behavior and ordering boundaries:

- domain objects are composed correctly
- the password reaches the hasher but not the event
- normalized email reaches the Credential
- provenance is present on the envelope
- secret fields are absent from the payload
- policy rejection prevents hashing and writing
- hashing failure prevents writing

The writer contract is responsible for transaction atomicity. Its adapter
tests will later verify rollback, outbox durability and database error mapping.

## What this slice does not decide yet

- concrete password hashing algorithm and cost parameters
- password breach-list or tenant-specific policy
- database schema and ORM mapping
- email verification delivery
- duplicate-email repository behavior
- HTTP request and response shapes
- session cookies or bearer tokens
- whether registration itself requires an organization invitation

## Used in

- [`src/modules/identity/app/commands/register-identity.ts`](../../../../../src/modules/identity/app/commands/register-identity.ts)
- [`src/modules/identity/app/commands/register-identity.spec.ts`](../../../../../src/modules/identity/app/commands/register-identity.spec.ts)
- [`src/modules/identity/app/ports/password-policy.ts`](../../../../../src/modules/identity/app/ports/password-policy.ts)
- [`src/modules/identity/app/ports/password-hasher.ts`](../../../../../src/modules/identity/app/ports/password-hasher.ts)
- [`src/modules/identity/app/ports/registration-writer.ts`](../../../../../src/modules/identity/app/ports/registration-writer.ts)
- [`src/modules/identity/app/index.ts`](../../../../../src/modules/identity/app/index.ts)
- [`src/shared/provenance/index.ts`](../../../../../src/shared/provenance/index.ts)
- [`src/shared/events/index.ts`](../../../../../src/shared/events/index.ts)

## Related

- [Identity module overview](README.md)
- [Identity domain design](DOMAIN-DESIGN.md)
- [Shared provenance notes](../../shared/provenance/README.md)
- [Shared events notes](../../shared/events/README.md)
- [Shared secret notes](../../shared/secret/README.md)
- [Shared PostgreSQL notes](../../shared/postgres/README.md)
