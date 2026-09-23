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

### Verification

`make` drives everything CI runs; `make help` lists the targets.

```bash
make check                # build, lint (architecture checks + oxlint), unit and in-memory suites
make audit                # fail on known-vulnerable dependencies
make infra-up             # PostgreSQL and NATS JetStream from compose.yaml
make ci                   # check + every in-memory, durable and end-to-end suite
make infra-down           # remove the test infrastructure and its data
make mutation             # Stryker over the domain layers (slow; CI runs it weekly)
```

`compose.yaml` uses its own project name (`n2f-nest-test`), so it never takes
over another stack's containers. Its ports default to 7220/7222/7223; to run it
beside a development stack on those ports, move it:

```bash
export N2F_POSTGRES_PORT=17220 N2F_NATS_PORT=17222 N2F_NATS_MONITOR_PORT=17223
make infra-up ci infra-down
```

`make test-e2e` starts the compiled backend itself, runs the HTTP workflow,
restarts NATS and then PostgreSQL underneath it and reruns the workflow each
time, then checks that it drains (readiness 503) and exits cleanly.
`.github/workflows/ci.yml` runs `make check` and `make audit`, then `make
test-memory` and `make test-durable` against the compose stack.

The individual suites below remain available for focused work.

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

The durable Audit redelivery check exercises the consumer side separately. It
writes the audit projection, simulates an acknowledgement failure, redelivers
the same JetStream event and verifies that the event-ID uniqueness boundary
leaves exactly one PostgreSQL audit row:

```bash
make backend-test-audit-redelivery
```

The opt-in chaos check exercises the same acknowledgement and replay boundaries
with the in-process fault-injection harness:

```bash
make backend-test-chaos
```

The environment-level NATS recovery check restarts the project-owned NATS
container, waits for readiness to recover, and then reruns the durable HTTP and
Audit workflow:

```bash
make backend-test-nats-restart
```

The PostgreSQL recovery check briefly stops and starts the project-owned
database, waits for the pool and readiness probe to recover, and reruns the
same durable workflow:

```bash
make backend-test-postgres-restart
```

The process-restart check starts the compiled backend on port `7301`, creates
durable Identity, session, Organization and Document state, terminates the
process, starts it again with the same NATS consumer, and verifies the state
through the HTTP API:

```bash
make backend-test-restart
```

For a network-level smoke against the running persistent backend, start it
from the integration workspace and run the TCP E2E target:

```bash
make backend-persistent
make backend-test-persistent-e2e
```

This exercises the real HTTP boundary for registration, verification, login,
organization and document-processing workflows, session revocation and
asynchronous Audit delivery. The target clears only the E2E registration
rate-limit buckets through the supplied database URL so repeated local runs do
not inherit the previous run's client-IP quota. The in-process durable
integration remains the broader persistence and adapter test.

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

PostgreSQL mode also selects the durable rate-limit store. Memory mode keeps
rate-limit buckets inside the process for lightweight development; the shared
rate-limit port remains asynchronous so another distributed store can be
introduced without changing endpoint policies.

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

Events are delivered at least once to named consumers (`audit`,
`document-processing`) through an inbox that follows the storage mode: the
PostgreSQL `n2f_mailbox` tables, or an in-memory inbox with the same
semantics. Publishing never runs a consumer, so a failing consumer cannot fail
the write that produced the event; each consumer retries with exponential
backoff and is dead-lettered after its attempt budget. After fixing the cause,
return dead events to delivery:

```bash
N2F_DATABASE_URL=postgres://n2f:n2f_local@127.0.0.1:7220/n2f \
bun run events:requeue --consumer audit          # or --outbox; add --event <id>
```

Sessions last `N2F_SESSION_LIFETIME_HOURS` (default 24) and end sooner after
`N2F_SESSION_IDLE_MINUTES` (default 60) without use. A login beyond
`N2F_SESSION_MAX_PER_IDENTITY` (default 10) revokes that identity's oldest
session, and ended sessions are deleted after `N2F_SESSION_RETENTION_DAYS`
(default 7).

Jobs left `running` longer than `N2F_JOB_RUNNING_TIMEOUT_MINUTES` (default 60)
are failed with `job.timed_out`, so a dead executor cannot strand a job or the
document waiting on it.

Event delivery is observable in `/metrics`: `n2f_event_deliveries_total`
(by consumer and outcome), `n2f_event_inbox_backlog` (pending and dead per
consumer), `n2f_event_outbox_rows` and `n2f_event_outbox_oldest_pending_seconds`
(outbox lag). Alert on any dead backlog and on growing outbox lag.

On SIGTERM or SIGINT the process reports not-ready (`/health/ready` 503) for
`N2F_SHUTDOWN_DRAIN_MS` (default 10 s in production, 0 otherwise) so load
balancers stop routing to it, then stops its workers and closes. Migrations run
at startup under `N2F_MIGRATION_TIMEOUT_MS` (default 2 minutes), separate from
the ordinary database operation budget, and concurrent starts serialize on a
migration lock.

Sent outbox rows and processed inbox events are pruned after
`N2F_EVENT_RETENTION_HOURS` (default 168). The NATS stream keeps messages for
`N2F_NATS_STREAM_MAX_AGE_HOURS` (default 168) within `N2F_NATS_STREAM_MAX_MB`
(default 64), discarding the oldest first.

Security-relevant settings:

- `N2F_ENV=production` refuses unsafe configuration at startup and names each
  offending variable: memory storage, `N2F_DEV_ENDPOINTS=true`, a missing
  `N2F_METRICS_TOKEN`, the capture mailer, or a missing `N2F_APP_URL`.
- Sign-up does not disclose which emails have accounts. `POST
  /identity/register` answers `202` alike for a new and a taken email: the
  new one is mailed a verification link (`<N2F_APP_URL>/verify?challenge=…&token=…`,
  which the application posts to `POST /identity/verify`), the taken one a
  notice to its owner. `POST /identity/verification-challenges {email}` mails a
  fresh link to an unverified address and answers `202` for any address. Both
  answer no sooner than `N2F_SIGNUP_FLOOR_MS` (default 1000 in production, 0
  otherwise), so response time does not reveal the outcome either.
- Mail goes out through `N2F_MAIL_TRANSPORT`: `capture` (the default) keeps
  messages in process for the development mailbox, `smtp` delivers through
  `N2F_SMTP_URL` (`smtps://user:pass@host:465`) from `N2F_MAIL_FROM`, retrying
  in the background. Production requires `smtp`.
- `N2F_METRICS_TOKEN` (32+ characters) must accompany every `/metrics` scrape
  as a bearer token.
- `N2F_CORS_ORIGINS` lists the exact browser origins allowed to call the API;
  unset, no cross-origin browser call is allowed.
- Request bodies are JSON only and at most 64 KB. Every response carries
  security headers, and every error is a problem document with a request ID.
- Request IDs are generated by the server; a client's `x-request-id` is echoed
  as `x-client-request-id` for correlation only.
- Document, job and audit lists are paginated: `?limit=` (1–100, default 25)
  and `?cursor=` from the previous response's `X-Next-Cursor` header.
- `GET /organizations/:id/audit/entries` returns an organization's audit trail
  to its owners and admins.

Two endpoints exist only for local development and integration checks:
`GET /dev/mail?to=<email>` shows the messages the capture mailer kept for an
address (including verification links), and `GET /audit/entries` lists every
organization's audit entries without authentication. Both answer `404` unless
`N2F_DEV_ENDPOINTS=true`. The
workspace `Makefile` and the Vitest configuration enable it; production
deployments must not.

Behind a load balancer or reverse proxy, set `N2F_TRUST_PROXY` so rate limits
key on the real client address rather than the proxy's. It accepts `false`
(the default: use the socket address), a hop count from `1` to `9`, or a
comma-separated list of proxy addresses, CIDR ranges and the names
`loopback`, `linklocal` and `uniquelocal`. `true` is refused, because it would
let any client forge its address through `X-Forwarded-For`.

The backend exposes unauthenticated operational probes:

```text
GET /health/live   # process liveness; does not query dependencies
GET /health/ready  # bounded PostgreSQL and JetStream readiness
GET /health        # readiness alias
GET /metrics       # process-local HTTP counters and latency histograms
```

Readiness drains during graceful shutdown while liveness remains a process
probe. The probe response intentionally does not disclose dependency details.

HTTP requests also accept and return W3C `traceparent` headers. Each request
creates a fresh server span while retaining the incoming trace ID; malformed
trace headers are ignored and replaced with a local context. Trace and span
identifiers are included in the request-completion logs without adding
observability SDK types to domain ports.

The `/metrics` endpoint renders bounded process-local HTTP metrics in
Prometheus text format. It uses route templates rather than raw URLs to avoid
turning path identifiers into unbounded metric labels; deployment boundaries
should restrict access to the operational endpoint.

## Shape

- `src/modules/` contains product modules. Each is an island: it imports only
  itself, `src/shared/` and `src/platform/`. Its `api.ts` is the only file
  other code may import; `commands.ts`, where present, is importable by
  workflows alone.
- `src/integration/` contains bridges: each implements one module's required
  port (declared as a token in that module's `api.ts`) by calling another
  module's public query.
- `src/workflows/` contains process coordinators, the only code that issues
  commands across modules.
- `src/shared/` contains framework-free capabilities shared by modules.
- `src/platform/` contains process and runtime adapters.
- `src/app.module.ts` is the Nest composition root: it registers each module
  once and hands it the bridges it requires.

`bun run check:architecture` enforces these import rules
(`scripts/check-module-boundaries.ts`). Modules keep no foreign keys into one
another's tables; references across modules are opaque IDs.

Product modules follow the agreed `app/`, `domain/`, `infra/` and `transport/`
separation. The seam between in-process delivery and NATS adapters belongs at
the owning boundary; shared leaves should not depend on Nest or a transport.

Expected failures are values in module and workflow `domain/` and `app/` code.
Those core layers must not use `throw` or `catch`; the repository enforces this
with `bun run check:architecture`. Infrastructure catches exceptions from
external systems and converts them to failures. Transport may translate a
failure into a framework response, and startup may fail fast for invalid
configuration.

## Forking

[FORKING.md](FORKING.md) covers starting a product from this repository:
deleting the example modules (`make fork-check` proves it works), renaming the
namespace, and adding a module.

## Notes

The [`notes/`](notes/README.md) directory explains intent that code and tests
cannot fully show: language behavior, runtime ownership, patterns, alternatives
and verification techniques. Start with the [errors module notes](notes/modules/src/shared/errors/README.md).
