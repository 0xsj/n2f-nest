# Forking n2f-nest

n2f-nest is a boilerplate. A product starts as a fork: it keeps the platform
and the core modules, deletes the examples, renames what it must, and adds its
own modules. This guide covers those four steps. The rules they rely on are in
[README.md](README.md#shape) and the
[hardening bar](notes/architecture/hardening-bar.md).

## 1. Decide what to keep

| Area | Keep? | Why |
| --- | --- | --- |
| `src/shared/`, `src/platform/` | Keep | Errors, IDs, events, outbox and inbox, PostgreSQL, NATS, HTTP hardening, rate limits, metrics, runtime |
| `src/modules/identity` | Keep | Registration, verification, sessions, password hashing |
| `src/modules/organization` | Keep | Tenants, memberships, invitations, organization access |
| `src/modules/audit` | Keep | Every event recorded per tenant; never reads payloads |
| `src/modules/document`, `src/modules/jobs` | Example | Delete, or keep as a reference until your first module lands |
| `src/workflows/document-processing` | Example | Shows a workflow coordinating two modules through events |

## 2. Delete the examples

`make fork-check` does this in a temporary copy and proves the result builds,
lints and passes (CI runs it on every push). To do it for real:

```sh
rm -rf src/modules/document src/modules/jobs src/workflows/document-processing \
  src/integration/document-access.ts src/integration/jobs-access.ts \
  test/document-processing.integration.spec.ts \
  test/document-tenant-isolation.integration.spec.ts \
  test/contracts/job-events.contract.spec.ts
# Then delete every line ending in `// example` (src/) or `# example` (Makefile).
grep -rnE '(//|#) example$' src Makefile
make check test-memory
```

Nothing else changes: no core module imports an example, and no table has a
foreign key into another module's tables.

The durable suites (`test/postgres.integration.spec.ts`,
`test/persistent-e2e.integration.spec.ts`, `test/process-restart.integration.spec.ts`)
use document processing as their end-to-end workload. They still pass while
the examples exist. After deleting them, point those flows at your own
module's routes. `make fork-check` does not cover these suites.

Migrations keep their version numbers. After the deletion, the chain is 1, 2,
3, 6, 7, 8, which is valid because versions only need to increase. Your first
migration takes the next number after the last one in `src/app/migrations.ts`.

## 3. Rename the namespace (optional, before first deploy)

The `n2f` name appears in:

| Where | Default | Change it |
| --- | --- | --- |
| Environment variables | `N2F_*` | `src/platform/runtime/config.ts`, `Makefile`, `compose.yaml`, `scripts/`, tests |
| Tables and ledger | `n2f_*`, `n2f_migrations` | Every `baseline.sql`, the adapters' SQL, `src/shared/postgres` |
| NATS | stream `n2f_events`, subjects `n2f.events.*` | `N2F_NATS_STREAM` and `N2F_NATS_SUBJECT_PREFIX`; no code change |
| Metrics | `n2f_*` | `src/platform/metrics`, `src/platform/events`, `src/platform/runtime/event-maintenance.ts`, `src/platform/http/request-logger.middleware.ts` |
| Package and compose project | `n2f-nest`, `n2f-nest-test` | `package.json`, `compose.yaml` |

Rename tables only before the first production migration. Baselines are
checksummed, so after that a rename is a new migration.

Also remove the legacy adoption, which exists only for databases created by
this repository before the baselines:

- delete `legacyHistory` from `src/app/migrations.ts`, and call
  `PlatformRuntimeModule.forRoot(appMigrations)` in `src/app.module.ts`;
- delete `test/migration-baseline.integration.spec.ts` and
  `test/fixtures/legacy-schema-v26.sql`, then remove the spec from `test:postgres` in `package.json`.

## 4. Add a module

Copy the shape of `src/modules/audit` (the smallest core module):

```
src/modules/<name>/
  api.ts                  the only file other code imports
  commands.ts             (optional) commands only workflows may call
  <name>.module.ts        Nest module; register({ requires }) if it needs others
  domain/                 aggregates, invariants, events; Result values, no throw
  app/                    commands, queries, ports, failures; no throw
  infra/requires.ts       <NAME>_REQUIRES tokens for capabilities from outside
  infra/in-memory/        memory adapters
  infra/postgres/         adapters, codec, migration.ts, migrations/*.sql
  transport/http/         controllers; the only layer that speaks HTTP
```

Checklist:

- [ ] **Boundaries.** Import only your module, `src/shared/` and `src/platform/`.
  `bun run check:architecture` fails otherwise.
- [ ] **Needs from other modules.** Declare a port and a token in
  `infra/requires.ts`, and export both from `api.ts`. Implement the port in
  `src/integration/` with `OrganizationAccessBridgeModule.provide<YourPort>()`
  or a bridge of your own, then pass it in `app.module.ts`.
- [ ] **Commands across modules.** Only a workflow (`src/workflows/<name>/`)
  may call another module's commands, and it imports them from `commands.ts`.
- [ ] **Events.** Publish from the adapter that saves the aggregate. In
  PostgreSQL mode that means enqueueing to the outbox in the same transaction
  as the write (see `src/modules/organization/infra/postgres/writer.ts`).
  Set the envelope's `subject` and `tenant` so Audit files it under the right
  organization. Consumers decode events themselves (see
  `src/workflows/document-processing/infra/job-events.ts`), and every handler
  must be idempotent by event ID, because delivery is at least once.
- [ ] **Concurrency.** Aggregates carry a `version` (`src/shared/version`).
  Updates use `WHERE version = $loaded` and return `<name>.stale_write` when
  the version has moved (`missingOrStale` in `src/shared/postgres`).
- [ ] **Migrations.** Add `migration.ts` next to the adapters, and append it to
  `src/app/migrations.ts` with the next version number. Never edit an applied
  migration; the checksum refuses it.
- [ ] **Contract spec.** Write `infra/adapters.contract.spec.ts` on
  `test/support/adapter-contract.ts`, so memory and PostgreSQL adapters obey
  the same contract.
- [ ] **Tenancy.** Every tenant route checks organization access. Add your
  routes to a tenant-isolation suite modeled on
  `test/tenant-isolation.integration.spec.ts`.
- [ ] **Rate limits.** Put a `@RateLimit(perClient(...))` on each controller,
  and a stricter one on writes that are costly or create tenants.
- [ ] **Notes.** Add a README under `notes/modules/src/modules/<name>/` for
  intent the code cannot show.
