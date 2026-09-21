# Identity domain design

The Identity domain models an actor's authentication-facing lifecycle as a
framework-free immutable entity; persistence, transport and authentication
mechanisms remain outside the domain.

## Origin

This note records the first domain slice built while restarting the Signals
backend from a clean NestJS scaffold. The design follows the Signals product
vision and the agreed modular-monolith boundary:

- a fan profile is not automatically an authenticated account
- organization membership is owned by the Organization module
- Identity owns authentication state, not product activity
- domain code must remain portable if a module later moves behind a remote
  adapter

The first slice was implemented directly and then covered with executable
tests. The tests are the behavioral authority; this note preserves the
language, reasoning and techniques that the code alone cannot communicate.

## Domain question

Identity answers:

> Who is this actor, and are they currently allowed to authenticate?

That question is intentionally narrower than:

> What do we know about this fan?

The second question belongs to fan profile and relationship domains. This
distinction lets Signals support anonymous or imported fan activity before a
fan chooses to create or claim an authenticated Identity.

## Ubiquitous language

### Identity

An Identity is the stable authentication subject for an actor. It has its own
stable ID and lifecycle state. It is not a fan profile, organization, role,
credential, session or access token.

The first implementation represented the Identity lifecycle only. The next
slice now models email/password credential metadata separately; it still does
not contain a raw password or password hash.

### Credential

A Credential is one method by which an Identity can authenticate. The first
planned method is email/password. An Identity may eventually have multiple
credentials, such as a password, magic link or external provider.

Raw passwords and password hashes are secret material. They are not domain
events, public fields or generic Identity state. Password hashing will be
provided through an application port and implemented by infrastructure.

The current credential entity owns the stable binding between an Identity and
its normalized email login identifier. It records the authentication method and
credential lifecycle, but deliberately does not own password hashing or
password comparison.

### Verification challenge

A Verification Challenge proves control of an authentication channel. It has an
owner, purpose, expiration and consumed state. It is single-use; consuming or
accepting an expired challenge is invalid.

The challenge is a separate lifecycle from the Identity. Verification changes
the Identity state, but the Identity entity does not generate or validate
delivery tokens itself.

### Session

A Session is temporary authenticated continuity for an Identity. It has its own
expiration and revocation state. A session is not the Identity and is not the
same thing as a long-lived credential.

Session validity will depend on both session state and the current Identity
status. A suspended or disabled Identity cannot create new sessions.

### Recovery challenge

A Recovery Challenge permits an actor to regain access without creating a new
Identity. It is separate from ordinary verification and is single-use and
time-bounded.

## Current entity state

The implemented `Identity` entity contains:

| Field | Meaning |
| --- | --- |
| `id` | Branded shared UUID identifying the Identity |
| `status` | Current lifecycle state |
| `createdAt` | Time the Identity entered the system |
| `updatedAt` | Time of the latest lifecycle transition |
| `verifiedAt` | Time verification completed, or `null` |

The current status vocabulary is a closed union:

```text
pending_verification
active
suspended
disabled
```

The status list is exported as a frozen value and the type is derived from it.
This keeps runtime validation data and compile-time exhaustiveness aligned.

## Lifecycle transitions

The current transition policy is:

```text
pending_verification ── verify ──> active

active ── suspend ──> suspended
suspended ── reactivate ──> active

pending_verification ── disable ──> disabled
active                ── disable ──> disabled
suspended             ── disable ──> disabled
```

`disabled` is terminal in this first slice. Re-enabling a disabled Identity is
not silently allowed because that policy will eventually require an explicit
administrative or compliance decision.

Invalid transitions return a domain `Failure` with a module-specific `type`.
They do not throw exceptions.

## Invariants

The entity enforces these rules directly:

- registration creates a `pending_verification` Identity
- only a pending Identity can be verified
- verification records `verifiedAt`
- only an active Identity can be suspended
- only a suspended Identity can be reactivated
- a disabled Identity cannot be reactivated
- disabling an already-disabled Identity is rejected
- lifecycle timestamps must be valid dates
- transition time cannot move backward
- an Identity transition does not mutate the previous instance
- secret material is not part of the Identity entity

The entity does not enforce rules that require other records or external
capabilities. For example, uniqueness of an email address belongs to the
application and repository boundary, not to one Identity instance.

The Credential entity similarly does not enforce global email uniqueness. It
normalizes the identifier consistently; the repository must enforce uniqueness
against other credentials, normally with a database constraint.

## Credential slice

The current credential slice adds:

- a closed `email_password` method vocabulary
- `active` and `revoked` credential states
- a branded `EmailAddress` value produced by `normalizeEmail`
- ownership through the Identity ID
- immutable revocation with an explicit timestamp
- defensive date copying and monotonic transition time

Email normalization currently trims surrounding whitespace, lowercases the
address and applies a bounded pragmatic syntax check. It is not intended to be
a complete RFC email parser or a deliverability check. Delivery and ownership
verification belong to the verification workflow.

Password behavior is intentionally split:

```text
application port: PasswordHasher / PasswordVerifier
infrastructure:   Argon2, bcrypt or another selected implementation
domain:           credential method, identifier and lifecycle
```

This means the domain can express that an email/password credential exists and
can be revoked without importing a crypto library or storing secret material in
an object that may be logged, serialized or included in an event.

## Aggregate decision

The current working decision is that `Identity` is the domain owner of its own
lifecycle. Credentials, verification challenges, sessions and recovery
challenges remain separate state-bearing concepts because they have independent
lifecycle, expiration, revocation and concurrency behavior.

This does not require every concept to become a separate Nest module. It means
we do not hide unrelated state and policies inside one large Identity class.
The final aggregate and persistence boundaries will be confirmed as those
slices are implemented.

## Implementation techniques

### Framework-free domain code

`src/modules/identity/domain/identity.ts` imports only shared framework-free
capabilities. It does not import NestJS, TypeORM, PostgreSQL, HTTP, NATS or a
configuration framework.

This makes the domain testable without starting an application and keeps the
in-process-to-remote seam available later.

### Private construction and a named factory

The constructor is private. Callers create an Identity through
`Identity.register(...)`, which gives registration a named domain operation and
ensures the initial state is always valid.

The factory returns `Result<Identity, Failure>` so invalid input remains visible
at the type boundary rather than becoming an incidental exception.

### Immutable transitions

Methods such as `verify`, `suspend`, `disable` and `reactivate` return a new
Identity instance. They do not mutate the existing instance.

This makes before-and-after state explicit, prevents a caller from retaining a
reference that changes unexpectedly, and gives tests a direct way to verify
that a transition occurred.

### Result-based expected failures

Expected business refusals use the shared `Result` type and `Failure` values:

- `ok(value)` represents a successful transition
- `err(failure)` represents an expected refusal
- shared `kind` values remain broad categories such as `invalid`
- the Identity module owns stable condition types such as
  `identity.invalid_verification`

The domain does not decide HTTP status codes, response envelopes, logs or retry
policy. Those belong to transport and application boundaries.

### Branded shared IDs

Identity accepts the shared branded `ID` rather than an arbitrary string. The
shared parser is the runtime entry point for canonical UUID values; the brand
prevents accidentally passing unrelated strings through typed code.

Identity-specific ID generation is not hidden inside the entity. Generation is
an explicit application or infrastructure effect and can be replaced in tests.

Credentials use the same shared branded `ID` for both the credential and its
owning Identity. The relationship is explicit rather than inferred from an
email address.

### Explicit time

Registration and transitions receive their time as input. The domain does not
call `new Date()` internally and does not read process time.

This makes lifecycle behavior deterministic and allows application services to
bind the shared clock once at the boundary. The current implementation also
enforces non-decreasing transition time so `updatedAt` cannot move backward.

### Defensive Date ownership

JavaScript `Date` objects are mutable even when exposed through a `readonly`
TypeScript property. The entity therefore copies dates on construction and
when returning them from getters.

`Object.freeze` protects the state object's property structure, but it does not
freeze the internal value of a `Date`. Copying is the technique that prevents a
caller from mutating the entity through a returned date reference.

### Closed runtime and compile-time vocabulary

`IDENTITY_STATUSES` is a frozen runtime list and `IdentityStatus` is derived
from it. This avoids maintaining two independent lists and gives switch-like
consumers a finite vocabulary for exhaustiveness checks.

### Explicit ESM imports

Source imports use `.js` extensions because the backend emits and runs as Node
ESM. TypeScript resolves an import such as `./identity.js` to the source
`identity.ts`, while the emitted JavaScript continues to reference the actual
runtime filename.

## Persistence boundary

The domain entity is not a TypeORM entity. When persistence is added, the
expected shape is:

```text
identity/
├── domain/
│   └── identity.ts
├── app/
│   └── ports and use cases
├── infra/
│   └── persistence adapter and ORM mapping
└── transport/
    └── HTTP or other external adapters
```

An ORM model may contain database column names, decorators and persistence-only
fields. A repository adapter will map between that model and the domain
Identity. This adds mapping code, but prevents the domain from inheriting ORM
identity, lazy-loading, transaction and decorator behavior.

## Events and Audit boundary

The current Identity entity does not publish events directly. Event recording
belongs to the application transaction and shared event seam.

Future state-changing facts may include:

- `identity.registered`
- `identity.verified`
- `identity.suspended`
- `identity.reactivated`
- `identity.disabled`

These events describe committed business facts. They must not contain raw
passwords, password hashes, session tokens, recovery secrets or delivery
codes. Audit consumes the facts through the publisher seam and does not import
Identity internals.

## Testing approach

The first tests are executable domain specifications in
`src/modules/identity/domain/identity.spec.ts`.

They currently cover:

- registration starts in pending verification
- verification produces a new active Identity
- the original Identity remains pending
- verification cannot be repeated after leaving the pending state
- active identities can be suspended
- suspended identities can be reactivated
- disabled identities are terminal
- lifecycle time cannot move backward

The credential tests in `src/modules/identity/domain/credential.spec.ts` also
cover:

- email/password credential creation
- case and whitespace normalization
- invalid email rejection
- absence of a `passwordHash` field from the domain object
- immutable revocation
- repeated revocation rejection
- non-monotonic revocation time rejection

The test helper creates a valid branded ID through the shared parser rather
than bypassing the shared ID boundary. This keeps the domain tests realistic
without bringing persistence or NestJS into the test process.

Persistence rehydration uses explicit `restore(...)` factories on Identity,
Credential and VerificationChallenge. A restore factory validates the stored
lifecycle state and copies mutable dates before constructing the immutable
domain object. This keeps database rows from bypassing domain invariants while
still allowing an adapter to load an already-verified or already-consumed
record.

The next tests should be added only when the next behavior is designed:

1. credential rules
2. verification challenge rules
3. session rules
4. recovery challenge rules
5. application use-case orchestration
6. transport and `curl` behavior

## What this design deliberately does not decide yet

- whether every fan can self-register
- whether email verification is mandatory before all authentication methods
- whether organization users and fans use identical credential policies
- whether email addresses are modeled as credentials, contact methods or both
- how password strength and breached-password policy are enforced
- session cookie versus bearer-token transport
- account lockout, rate limits and suspicious-login policy
- exact ORM, table and migration shape
- exact event payload versions and retention policy

Those are application, infrastructure, transport or product-policy decisions.
They should not be smuggled into the first lifecycle entity.

## Used in

- [`src/modules/identity/domain/identity.ts`](../../../../../src/modules/identity/domain/identity.ts)
- [`src/modules/identity/domain/identity.spec.ts`](../../../../../src/modules/identity/domain/identity.spec.ts)
- [`src/modules/identity/domain/index.ts`](../../../../../src/modules/identity/domain/index.ts)

## Related

- [Identity module overview](README.md)
- [Shared errors notes](../../shared/errors/README.md)
- [Shared ID notes](../../shared/id/README.md)
- [Shared clock notes](../../shared/clock/README.md)
- [Shared events notes](../../shared/events/README.md)
- [Notes index](../../../../README.md)
