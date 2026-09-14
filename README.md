# n2f-nest

The NestJS member of **nine to five**: backend blueprints with familiar ownership,
explicit dependencies, and a record of what we learn while building. Each blueprint
stands on its own. Shared behavior will make them useful comparisons and future
backends for Flover; that compatibility has not been demonstrated yet.

## Current state

Errors, clock, UUIDs, secrets, env parsing, provenance and logging are implemented
with local contracts and executable tests. The composition root owns typed config,
service identity and bounded output delivery. The [foundations command](FOUNDATIONS.md)
exercises them together through console, JSON and no-op adapters.

The logger uses a hand-written console formatter and Pino 10.3.1.
A tested Nest LoggerService bridge lives at root.
Validation/pagination, PostgreSQL transactions and migrations, readiness, outbound
HTTP, WebSockets and a transactional outbox with a replaceable publisher are now
implemented. [JetStream](JETSTREAM.md) is also implemented and verified as a second
publisher, with a durable handoff into the PostgreSQL mailbox. See [the infrastructure guide](INFRASTRUCTURE_BUILD.md) for contracts,
commands and limits. [Identity principal leaves](src/modules/identity/domain/CONTRACT.md) now implement
registration values, restoration and versioned suspend/activate transitions.
[Domain ownership and order](DOMAINS.md) describe the remaining application/
persistence work and org workflow. The first audit ingestion slice includes per-consumer
receipts, replaceable PostgreSQL/JetStream delivery and an authenticated
`GET /v1/audit/records` projection. The org domain, create/invite/accept/role
application operations, PostgreSQL transaction adapter and root-composed
authenticated organization routes are implemented behind replaceable ports.
The live verifier proves the owner→invitee acceptance→admin promotion workflow;
ownership transfer, removal and suspension remain separate policy slices.
The org request collection is [`tools/org.http`](tools/org.http); see
[`tools/http-README.md`](tools/http-README.md) for VS Code, Neovim and curl use.
[Built-in authentication](AUTHENTICATION.md) is required baseline scope; its
email, password, token digest, credential, auth epoch, session and challenge leaves
are implemented and mutation-checked, identity-owned Argon2id hashing and token codec adapters pass shared
cross-language vectors, and the register, verify, login, logout, change and reset
operations run against fake ports, a PostgreSQL store verified against the real
database, and `/v1/auth` routes with cookies, origin and CSRF admission that root
composes into the process per [AUTH_BUILD.md](AUTH_BUILD.md). Verification and reset mail is delivered over SMTP, so the real process
completes register, verify, login, logout and reset against local Mailpit. The
shared Redis limiter and trusted-proxy policy are implemented and verified with
two independent HTTP processes; Redis state is digest-only and its URL is
redacted. Audit's real-broker slice and selected audit/limiter mutations are
also verified; full-suite evidence remains.

The [telemetry into HTTP slice](TELEMETRY_HTTP.md) now runs a diagnostic server:
provenance admission, safe problem responses, isolated request context, completion
logs and OTLP traces/metrics/logs. The guide includes settings and verification.


The Nest HTTP greeting remains independent.

## Start

The [errors implementation guide](src/shared/errors/README.md) maps the APIs across Go,
Rust and Nest, explains intentional differences, and points to the local example.

Use the Node.js version in [.nvmrc](.nvmrc) and pnpm. Validation of this foundation
used pnpm 11.22.0. The committed lockfile records the dependency resolution.

```sh
pnpm install --frozen-lockfile
pnpm run start:dev
```

The server listens on `PORT`, defaulting to `3000`. No external service credentials
are needed. For a compiled run:

```sh
pnpm run build
pnpm run start:prod
```

## Local infrastructure

PostgreSQL 18, Redis, Mailpit, S3-compatible storage and observability run through
this repository's [compose.yaml](compose.yaml):

```sh
docker compose up -d --wait
```

See [INFRASTRUCTURE.md](INFRASTRUCTURE.md) for ports, optional environment overrides,
data lifecycle, and selected events/WebSocket direction.
[OBSERVABILITY.md](OBSERVABILITY.md) contains the synthetic telemetry example and
shared instrumentation expectations. The diagnostic HTTP adapter exports all three
signals; see [its run guide](TELEMETRY_HTTP.md).

## Layout

```text
src/main.ts       process entry point
src/root/         Nest composition and the temporary HTTP smoke example
src/modules/      business modules, starting with identity principal leaves
src/shared/       implemented foundations, HTTP and telemetry adapters
test/             tests that exercise the assembled application
notes/            discoveries, techniques, and unresolved questions
decisions/        consequential choices and their alternatives
STATUS.md         current state and verification limits
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) for dependency direction and the module
shape. Read [AGENTS.md](AGENTS.md) before changing the project. Keep learning in
[notes](notes/README.md), consequential choices in [decisions](decisions/README.md),
and the [current status](STATUS.md) accurate.

## Verify

```sh
pnpm run build
pnpm run lint
pnpm exec tsc --noEmit --incremental false
pnpm run test
pnpm run test:e2e
```

The tests cover shared foundations, HTTP/telemetry, foundations root and the
independent generated greeting. The greeting HTTP test opens a local socket.
HTTP/telemetry have regression tests and a separate real-process verifier.
For just the errors contract, run `pnpm exec tsc -p tsconfig.errors.json`
and `pnpm exec vitest run src/shared/errors`.
[example.spec.ts](src/shared/errors/example.spec.ts) demonstrates a refusal reaching
an exception boundary with a safe public projection. These checks do not establish
business workflows, architecture conformance or Flover compatibility.

## Targeted foundation mutations

After installing the normal toolchain/dependencies, run:

```sh
python3 tools/mutations/foundations.py
```

The runner builds and tests isolated temporary copies, retaining logs and hashes.
Its selected mutations probe clock/ID contracts; they are not an exhaustive score.
See the [notes index](notes/README.md) for language walkthroughs and recorded evidence.

## Process verification

`python3 tools/verify_foundations.py` builds the real executable and verifies eleven
process scenarios, including terminal color and safe invalid-config exit.
`python3 tools/mutations/process.py` probes selected secret/env/provenance/logger/root
faults in isolated copies. These are targeted checks, not exhaustive guarantees.
