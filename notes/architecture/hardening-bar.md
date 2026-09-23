# The hardening bar: what "secure and resilient" means here

**Status:** In progress

The boilerplate is done when every item below is met and each met item names
the test or check that proves it.

## Origin

A four-part read-only review (2026-09-23) of Identity, Organization,
Document/Jobs/Audit and the shared infrastructure found careful domain models
but defects at the adapter edges: blind PostgreSQL updates, collapsed database
error mapping, lossy event delivery, workflows with no exit, and two endpoints
that disclosed secrets or every tenant. The decision followed that n2f-nest
remains a domain-neutral boilerplate whose end state must be secure and
resilient, so forks inherit the guarantees rather than the defects.

## What and why

An item is ticked only when an executable check pins it. A prose claim without
a test is not a met item, because forks copy code and tests, not intentions.

Status: ✅ met · 🟡 partial · ⬜ open.

### Security

| # | Item | Status | Proof |
| --- | --- | --- | --- |
| S1 | No endpoint lets an unproven caller take over an identity | ✅ | Verification tokens leave the process only by mail; the development mailbox (`GET /dev/mail`) needs `N2F_DEV_ENDPOINTS` and the capture transport (`mail.spec.ts`), and production refuses both (`config.spec.ts`) |
| S2 | Sign-up and login do not reveal whether an account exists, by response or by timing | ✅ | Login: one refusal and a decoy verification for unknown emails (`authenticate-identity.spec.ts`; measured 143 ms vs 142 ms). Sign-up and resend: `202` alike for new, taken and unknown emails, the outcome delivered by mail (`sign-up.spec.ts`, `resend-verification.spec.ts`, `identity.integration.spec.ts`), held to `N2F_SIGNUP_FLOOR_MS` (measured 802 ms new vs 802 ms taken; without the floor 365 vs 314) |
| S3 | Password hashing meets current OWASP parameters | ✅ | `crypto.spec.ts`: `scrypt-v2` (N=2^15, r=8, p=3) records its cost; `scrypt-v1` still verifies; hostile stored costs are refused |
| S4 | Every endpoint is explicitly public or authenticated | ✅ | `tenant-isolation.integration.spec.ts` (401 without a session); `/metrics` needs `N2F_METRICS_TOKEN` (`http-hardening.integration.spec.ts`); dev listings gated |
| S5 | No tenant can read or change another tenant's data through any endpoint | ✅ | `test/tenant-isolation.integration.spec.ts` (organization, memberships, invitations, audit) and `test/document-tenant-isolation.integration.spec.ts` (documents, jobs): every tenant route refuses another organization's owner (403) and finds nothing through the intruder's own organization (404); authorization precedes lookups |
| S6 | Audit entries are readable per organization only | ✅ | `GET /organizations/:id/audit/entries` for owners and admins, scoped by the envelope `tenant` (`tenant-isolation.integration.spec.ts`) |
| S7 | Rate limits bound per client, per account and per endpoint | ✅ | Identity: per client, per account and per client+account; every tenant controller: per client; organization creation: stricter (`rate-limit.interceptor.spec.ts`, `config.spec.ts`) |
| S8 | Request bodies and list responses are bounded | ✅ | 64 KB JSON-only bodies (`http-hardening.integration.spec.ts`); documents, jobs and audit are keyset-paginated with list-bound cursors (`tenant-isolation.integration.spec.ts` for audit, `document-tenant-isolation.integration.spec.ts`, Document contract spec) |
| S9 | Security headers, deny-by-default CORS, no internal detail in errors | ✅ | `http-hardening.integration.spec.ts`: headers, no `X-Powered-By`, CORS only for `N2F_CORS_ORIGINS`, every error a sanitized problem with a request ID |
| S10 | Client-supplied request and correlation IDs cannot be forged into trusted provenance | ✅ | `http-hardening.integration.spec.ts`: work IDs are server-generated; a client `x-request-id` is echoed as `x-client-request-id` and never recorded |
| S11 | Production refuses unsafe configuration and names the offending variable | ✅ | `config.spec.ts`: `N2F_ENV=production` refuses memory storage, dev endpoints and a missing metrics token, naming each variable |
| S12 | Dependencies are audited in CI | ✅ | `make audit` in CI on every push and weekly; Dependabot for npm and Actions; `qs` overridden past advisories in a dev-only path |
| S13 | Sessions end after inactivity, are capped per identity, and ended sessions are deleted | ✅ | Idle expiry: `session.spec.ts`, `get-current-identity.spec.ts`; cap: `authenticate-identity.spec.ts`, Identity contract spec (eviction in the login transaction, stale eviction refused), `test/session-limits.integration.spec.ts`; pruning: `prune-sessions.spec.ts`, contract spec |

### Resilience

| # | Item | Status | Proof |
| --- | --- | --- | --- |
| R1 | Concurrent writes conflict instead of overwriting (version-checked updates) | ✅ | `src/modules/*/infra/adapters.contract.spec.ts` on both adapters: stale verify and session revoke; role change vs revoke, accept vs revoke, double accept; archive vs completion; double job start. Mutation-checked: removing any guard fails these specs |
| R2 | Database constraint violations map to precise domain failures; serialization failures are retryable | ✅ | `shared/postgres/postgres.spec.ts`; taken email, slug, duplicate membership/invitation/document, job subject in the contract specs; `jobs/app/commands/submit-workflow-job.spec.ts` (a lost subject race returns the winner) |
| R3 | In-memory and PostgreSQL adapters have the same observable semantics | ✅ | Storage: every module's `adapters.contract.spec.ts`. Delivery: `src/shared/events/inbox.contract.spec.ts` runs one inbox contract against `InMemoryInbox` and the PostgreSQL `Mailbox` |
| R4 | No accepted event is lost: bounded stream retention, backoff, requeue of dead events, poison-row quarantine, independent subscribers | ✅ | `inbox.contract.spec.ts` (independent consumers, backoff, dead-letter and requeue, inbox and outbox quarantine); `broker.integration.spec.ts` (NAK redelivery); NATS stream discards oldest at age/size bounds instead of refusing publishes; `bun run events:requeue` |
| R5 | Every workflow state has an exit; abandoned running jobs are reclaimed | ✅ | `test/document-processing.integration.spec.ts` (re-process after cancel, retry instead of duplicate, cancel after failure, archive mid-processing, each settling with no unsettled delivery); `document.spec.ts` (processing runs: stale, repeated and out-of-order outcomes); `expire-stale-jobs.spec.ts` and the Jobs contract spec (expiry) |
| R6 | PostgreSQL or NATS outages degrade to retryable failures, never corruption | ✅ | `make test-e2e` (in CI): the HTTP workflow after NATS and PostgreSQL restart underneath a running process; `test:recovery`, `test:chaos`, `inbox.contract.spec.ts` |
| R7 | Readiness drains before the server stops accepting work | ✅ | `src/app/shutdown.spec.ts` (drain, wait, close); `make test-e2e` sends SIGTERM and asserts readiness 503 before a clean exit |
| R8 | Outbox and mailbox growth is bounded; dead events and outbox lag are observable | ✅ | Pruning: `EventMaintenance`, `inbox.contract.spec.ts`. Metrics: delivery outcomes, inbox backlog, outbox rows and lag (`chaos.integration.spec.ts` asserts dead letters appear in `/metrics`) |
| R9 | Migrations have explicit timeouts and safe concurrent startup | ✅ | `src/shared/postgres/migration.integration.spec.ts`: a migration outlasts the operation budget, one exceeding `N2F_MIGRATION_TIMEOUT_MS` fails, concurrent migrators serialize |

### Boundaries

Modules are islands. A module imports only itself, `shared/` and `platform/`.
It states what it provides in its own `api.ts` and what it requires as ports in
`app/ports/`. Bridges in `src/integration/` implement one module's port by
calling another module's `api.ts`; workflows in `src/workflows/` coordinate
several modules; `app.module.ts` wires bridges into ports. Nothing imports a
module's internals.

| # | Item | Status | Proof |
| --- | --- | --- | --- |
| B1 | No module imports another module; only `integration/`, `workflows/` and the composition root import a module's `api.ts` | ✅ | `scripts/check-module-boundaries.ts` in `bun run lint` (probed with a module→module, bridge→command and root→internals import) |
| B2 | No foreign keys between modules; cross-module references are opaque IDs | ✅ | The per-module baselines declare no cross-module foreign keys (they were dropped before the squash); contract specs run on PostgreSQL with IDs no other module ever stored |
| B3 | Consumers decode events with their own decoders; integration contract tests prove producers' events still decode | ✅ | Envelope `subject` (Audit no longer reads payloads: `record-audit-event.spec.ts`); workflow decoder `job-events.ts` proven by `test/contracts/job-events.contract.spec.ts` |
| B4 | A subscriber failure never undoes or fails the producer's write, in any storage mode | ✅ | `test/chaos.integration.spec.ts`: an always-failing Audit consumer leaves registration at 201 and dead-letters only Audit's delivery |
| B5 | Commands cross modules only from workflows; cross-module queries go through bridges | ✅ | `commands.ts` importable by `workflows/` only, enforced by `scripts/check-module-boundaries.ts` |
| B6 | A fork can delete the example modules (Document, Jobs, the workflow) and still build and pass | ✅ | `make fork-check` (CI, every push) deletes them in a temporary copy and runs `make check test-memory`; wiring lines carry an `example` marker; see FORKING.md. The durable suites still use document processing as their workload |

Deferred deliberately: an RPC bus, protobuf/gRPC contracts, per-module database
schemas and roles, and authentication at the HTTP edge. Bridges keep each of
these a change to adapters rather than to modules.

### Enforcement

| # | Item | Status | Proof |
| --- | --- | --- | --- |
| E1 | CI runs build, lint, unit and PostgreSQL/NATS integration suites | ✅ | `.github/workflows/ci.yml` → `make check`, `make audit`, `make test-memory`, `make test-durable`; the same `make ci` passed locally against a fresh compose stack |
| E2 | Race and cross-tenant tests run in CI | ✅ | Contract specs (races) in `test:postgres`; tenant isolation and HTTP hardening run in `make check` without infrastructure |
| E3 | The error-boundary check also rejects `Promise.reject` and throwing helpers | ✅ | `scripts/check-error-boundaries.ts` rejects `throw`, `catch`, `Promise.reject`, `.catch()` and `new Promise` in core layers (probed with each) |
| E4 | Core layers are mutation-tested | ✅ | `make mutation` (Stryker) weekly in CI, failing below 90%. 2026-09-23: 93.1% overall, every domain aggregate at 91–95%, no uncovered mutants. The survivors are failure-message text, `Object.freeze` of private state, and equivalent mutants. Mutation testing found and fixed a cursor that `encode` could issue but `decode` refused (`pagination.spec.ts`) |

### Known open decisions

- An unverified sign-up holds its email: its owner, signing up later, is told
  the address has an account but cannot verify it. Expiring unverified
  identities (and a password reset flow) would release it.
- An organization owner can add an existing identity as a member without the
  identity's consent; restricting that to invitations is a product decision.

## Gotchas

- `N2F_DEV_ENDPOINTS=true` reopens S1 and S4 by design. S11 must refuse it in
  production.
- R1 changes every writer's contract. A fork that adds a module must follow the
  same versioned-update pattern or it silently reintroduces lost updates.

## Used in

- [`README.md`](../../README.md) configuration notes
- [Platform rate limiting](../modules/src/platform/ratelimit/README.md)
