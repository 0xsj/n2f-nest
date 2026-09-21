# Identity module

Identity owns the authentication-facing identity of an actor while remaining
separate from profiles, organizations, memberships, consent and product
activity.

## Boundary

Identity answers:

> Who is this actor, and are they currently allowed to authenticate?

The module owns:

- identity subjects and their lifecycle
- authentication credentials
- verification challenges
- authentication and recovery workflows
- revocable sessions
- identity security facts

The module does not own:

- profiles or relationship history
- organizations, memberships or roles
- consent or marketing preferences
- domain-specific resources, audiences or messages
- business activity timelines

A profile may exist without having an Identity. Other modules may reference an
Identity ID, but they do not manage Identity state.

## Current implementation

The implemented slices currently cover the framework-free Identity lifecycle,
email/password credential metadata, registration, verification challenges,
the `VerifyIdentity` command, session-based authentication, the
`GetCurrentIdentity` query, idempotent session revocation and a Nest HTTP
transport backed by process-local infrastructure. Recovery and Audit
projection remain separate slices rather than being hidden inside one large
entity.

Identity's domain event vocabulary is defined in `domain/events.ts`. Its
aggregate and value-like models return typed domain failures, while the
application layer normalizes adapter failures at the module boundary.

See [the domain design note](DOMAIN-DESIGN.md) for the language, invariants,
techniques and reasoning behind this slice.
See [the application design note](APPLICATION-DESIGN.md) for orchestration,
ports, atomic persistence and provenance.
See [the infrastructure and transport note](INFRA-TRANSPORT-DESIGN.md) for
the Nest composition, adapter seams and curlable flow.

## Current and planned capabilities

- email/password credential metadata and normalized login identifiers
- password hashing through an application port and infrastructure adapter
- registration orchestration with an atomic state-and-event writer boundary
- email verification challenge lifecycle and verification orchestration
- email verification
- session creation with revocable, expiring sessions
- password verification and session-token issuance through ports
- current-Identity read projection through the query layer
- idempotent logout through session revocation
- authentication and session creation
- current-session inspection
- logout and session revocation
- Nest HTTP transport for the registration, verification, login, current-user
  and logout path
- credential recovery and reset
- durable identity events consumed by Audit

## Architectural rules

- domain and application logic remain independent of NestJS
- transport translates external requests into application commands
- infrastructure owns persistence and external adapters
- TypeORM or another ORM belongs under `infra/`, not in the domain model
- credential material, session tokens and recovery secrets never enter domain events
- expected domain refusals use `Result` values with typed Identity failure
  unions; adapter failures are normalized at application boundaries
- Audit consumes published business facts without importing Identity internals
