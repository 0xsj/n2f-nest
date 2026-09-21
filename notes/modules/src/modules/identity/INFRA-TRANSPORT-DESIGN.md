# Identity infrastructure and transport

The first integration slice wires Identity through process-local adapters and
Nest HTTP without changing the framework-free domain or application layers.

The module also exports the narrow `GetIdentity` query for composition with
other product modules. Consumers receive the safe `IdentityView` read model;
they do not receive Identity repositories, credentials or session internals.

## Origin

This note records the first point where the Identity ports are composed into a
running Nest process. The goal is a curlable vertical slice while keeping the
future PostgreSQL, NATS and deployment-specific adapters replaceable.

## Boundary shape

```text
HTTP request
    ↓
IdentityController
    ↓  DTO translation, bearer extraction, problem mapping
application commands and query
    ↓
Identity ports
    ↓
in-memory adapters + Node crypto adapters
```

The controller does not construct domain entities and does not know the
in-memory maps. The application layer still owns orchestration and event
creation. Infrastructure implements the application-owned ports.

## In-memory adapter

`InMemoryIdentityStore` is a process-local integration harness. It keeps
identities, credentials, password hashes, verification challenges, sessions
and event envelopes in maps. It is intentionally not presented as a durable
repository:

- restarting the process loses all state;
- the writer models the application atomic-commit boundary inside one isolate;
- event envelopes are retained so a future outbox/publisher seam can be tested;
- reader adapters return domain entities only where the application port asks
  for them, and the current-identity query still returns a safe read model.

The replacement path is direct: implement the same ports under a PostgreSQL
adapter, keep the command dependencies unchanged, and move the event handoff
behind an outbox or shared event publisher.

## First PostgreSQL writer

`PostgresRegistrationWriter` is the first durable adapter for that path. It
uses the framework-free `Database` transaction capability to insert the
Identity row, Credential row and shared outbox envelope in order. The outbox
insert is part of the same transaction; no publisher is called before commit.

The adapter validates that the event's `WorkContext` matches the write scope,
preserving the same provenance invariant as the in-memory writer. The password
hash is revealed only for the parameterized database write and is never placed
in the event payload. Database failures are mapped to shared `Failure` values.

This is intentionally a first persistence increment, not a provider switch.
The local Nest composition remains in-memory until migration startup and a
complete provider configuration are chosen.

The next persistence increment adds PostgreSQL rehydration for Identity,
Credential, VerificationChallenge and Session, plus verification, challenge
and session writers. Rows are passed through explicit domain `restore(...)`
factories instead of being treated as trusted plain objects. Every state
writer follows the same state-then-outbox order as registration. Verification
challenge and session tables use new `0004` and `0005` migrations so earlier
migrations do not need to be edited after they could have been applied.

## Runtime composition

`PlatformRuntimeModule` selects all current Identity and Audit adapters as one
runtime set using `N2F_IDENTITY_STORAGE`. Memory mode is the default.
PostgreSQL mode opens the shared `Database`, applies the ordered application
migration list through Organization `0007` and starts a post-bootstrap outbox worker.
The worker currently uses a durable in-process publisher while Audit persists
through PostgreSQL; NATS can replace that publisher token later.

## Crypto adapter

`NodePasswordCodec` uses Node's built-in asynchronous `scrypt` with a random
salt and an explicit encoded hash format. `NodeTokenCodec` creates opaque
random bearer tokens and stores only SHA-256 digests. The raw password and raw
tokens are wrapped in `SecretString`; they are revealed only at the transport
edge or inside the crypto adapter.

These are integration choices, not domain rules. A production deployment can
replace the adapters with Argon2id, a managed identity provider or another
token strategy without importing those dependencies into `domain/` or `app/`.

## Nest composition

TypeScript interfaces disappear at runtime, so
`infra/identity.providers.ts` uses private symbol tokens for the application
ports. Provider factories make the mapping visible at the module boundary,
while `IdentityModule` remains a thin Nest declaration:

- concrete Nest classes provide clocks, ID generation, provenance factory,
  policy and crypto capabilities;
- symbol tokens provide readers and writers;
- command/query classes are constructed with those port implementations;
- the controller and request-work helper are the only transport providers.

This preserves normal Nest module composition without making Nest metadata part
of the domain or application code.

## HTTP transport

The current routes are intentionally small:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/identity/register` | create a pending identity |
| `POST` | `/identity/verification-challenges` | issue a demo challenge for an identity |
| `POST` | `/identity/verify` | consume the one-time challenge |
| `POST` | `/identity/login` | create a revocable session |
| `GET` | `/identity/me` | resolve the bearer token to a safe identity view |
| `POST` | `/identity/logout` | revoke the current session |

The challenge endpoint returns the token only because this is a local
integration example. A real transport would hand it to an email or messaging
adapter and would not include it in the API response.

Request work is opened with anonymous attribution and the `n2f-nest-http`
service executor. The process-level request context carries the validated
`x-request-id` into `IdentityHttpWork`, which uses it as the root
`work_id` when opening the provenance scope. The provenance factory creates
the root `correlation_id` according to its scope rules. Authentication admission
can later enrich the request lineage with the authenticated actor; it does not
belong in the shared HTTP DTO mapper.

Failures remain `Result` values through the application boundary. The Nest
controller maps them to the shared problem shape and status policy at the
framework edge. That is the intended exception boundary.

The process-level `RequestLoggerMiddleware` logs completion status, method,
path, duration, termination and a generated or validated `x-request-id`. It
does not inspect request bodies, cookies, authorization headers or response
bodies. This keeps access logging useful for Kulala and curl without turning
credentials into diagnostics.

## Verification

With `PORT=7300 bun run start:dev`, the complete local path is:

```sh
curl -X POST http://127.0.0.1:7300/identity/register \
  -H 'content-type: application/json' \
  --data '{"email":"demo@example.com","password":"correct-horse-7"}'
```

Use the returned identity ID to issue a challenge, then pass its challenge ID
and token to `/identity/verify`. After that, login, call `/identity/me` with
`Authorization: Bearer <token>`, and call `/identity/logout`. A subsequent
`/identity/me` returns `401` because the session is revoked.

## Gotchas and next seams

- The in-memory writer is not a substitute for a transaction or outbox.
- The PostgreSQL registration writer now establishes the state-plus-outbox
  pattern for the command set, but the module still uses in-memory providers
  locally. Partial activation would create inconsistent read behavior.
- The durable adapters currently cover every Identity port used by the first
  HTTP flow, but are intentionally not activated independently. Provider
  selection, migration startup and database readiness still belong to the
  composition root.
- The controller currently uses explicit body checks; shared request-schema
  validation can be introduced when the transport surface grows.
- NATS is not involved in the synchronous request path yet. The durable event
  handoff should be added after the persistence/outbox boundary is selected,
  while keeping the application ports stable.
- The module wiring uses the platform `EVENT_BUS` token and `EventBus` contract;
  Identity does not inject `InMemoryEventBus` directly. This keeps the local
  adapter convenient for development while preserving the replacement seam for
  a durable dispatcher or NATS-backed implementation.
- The platform `OutboxDispatcher` coordinates one delivery attempt but does not
  own lease, retry or scheduling policy. Those remain in the shared PostgreSQL
  outbox store and process composition, respectively.
- Audit is still a consumer of identity facts, not a dependency of Identity.

## Used in

- `src/modules/identity/identity.module.ts`
- `src/modules/identity/infra/identity.providers.ts`
- `src/modules/identity/infra/in-memory/`
- `src/modules/identity/infra/postgres/registration-writer.ts`
- `src/modules/identity/infra/postgres/readers.ts`
- `src/modules/identity/infra/postgres/challenge-writer.ts`
- `src/modules/identity/infra/postgres/verification-writer.ts`
- `src/modules/identity/infra/postgres/sessions.ts`
- `src/modules/identity/infra/postgres/migrations/0002_identity.sql`
- `src/modules/identity/infra/postgres/migrations/0004_verification_challenges.sql`
- `src/modules/identity/infra/postgres/migrations/0005_sessions.sql`
- `src/modules/identity/transport/http/`
- `src/modules/identity/app/queries/get-identity.ts`
- `src/modules/identity/app/commands/issue-verification-challenge.ts`
- `src/platform/http/request-logger.middleware.ts`
- `src/platform/http/request-context.ts`
- `src/platform/events/event-bus.ts`
- `src/platform/events/outbox-dispatcher.ts`
- `src/platform/runtime/runtime.module.ts`
- `src/platform/runtime/outbox-worker.ts`

## Related

- [Application design](APPLICATION-DESIGN.md)
- [Verification design](VERIFICATION-DESIGN.md)
- [Session design](SESSION-DESIGN.md)
- [Shared events notes](../../shared/events/README.md)
