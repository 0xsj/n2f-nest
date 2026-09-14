# Notes

## First domain leaves

- [Built-in authentication boundaries](modules/src/modules/identity/domain/authentication-boundaries.md).
- [Auth leaves: TypeScript walkthrough and mutation evidence](modules/src/modules/identity/domain/auth-leaves-walkthrough.md).
- [Password hashing adapter: allowlist, dummy work and admission](modules/src/modules/identity/password-hash/README.md).
- [Token codec adapter: canonical form and purpose binding](modules/src/modules/identity/token-codec/README.md).
- [Identity application operations: ports, order and safe events](modules/src/modules/identity/app/README.md).
- [Identity PostgreSQL store: locks, rollback markers and real-database evidence](modules/src/modules/identity/infra/postgres/README.md).
- [Identity HTTP transport: cookies, CSRF and admission](modules/src/modules/identity/transport/http/README.md).
- [Identity local adapters: limiter, blocklist, undelivered mail](modules/src/modules/identity/infra/local/README.md).
- [Shared Redis limiter and trusted proxy policy](modules/src/modules/identity/infra/redis/README.md).
- [Keyed digest](modules/src/shared/keyed/README.md).
- [HTTP feature routes and admission](modules/src/shared/http/feature-routes.md).
- [Root: auth composition](modules/src/root/auth-composition.md).
- [Identity SMTP mail delivery: bounds, outcomes and evidence](modules/src/modules/identity/infra/smtp/README.md).
- [Audit ingestion: receipts and an authenticated projection](modules/src/modules/audit/README.md).
- [Organization and membership value leaves](modules/src/modules/org/domain/README.md).
- [Organization membership workflows](modules/src/modules/org/app/README.md).
- [Organization PostgreSQL persistence](modules/src/modules/org/infra/postgres/README.md).
- [Organization authenticated HTTP transport and request collection](modules/src/modules/org/transport/http/README.md).

- [Principal invariants and verification](modules/src/modules/identity/domain/README.md).
- [TypeScript ownership and syntax](modules/src/modules/identity/domain/language-walkthrough.md).
- [Identity, audit and org ownership](../DOMAINS.md).

## JetStream replacement

- [Broker protocol and language findings](modules/src/shared/events/jetstream/protocol-and-ownership.md).
- [Root selection and real verification](modules/src/root/jetstream-verification.md).
- [Persistent broker setup](../JETSTREAM.md).

## Infrastructure before domains

- [validation: ownership and failure behavior](modules/src/shared/validation/ownership-and-failures.md).
- [pagination: ownership and failure behavior](modules/src/shared/pagination/ownership-and-failures.md).
- [postgres: ownership and failure behavior](modules/src/shared/postgres/ownership-and-failures.md).
- [health: ownership and failure behavior](modules/src/shared/health/ownership-and-failures.md).
- [Outbound HTTP lifecycle](modules/src/shared/httpclient/lifetimes.md).
- [WebSocket lifetime and protocol](modules/src/shared/socket/lifetimes.md).
- [Ticketed WebSocket admission and ongoing revalidation](modules/src/shared/socket/ticketed-authentication.md).
- [Events and durable receipts](modules/src/shared/events/durable-receipts.md).
- [Runtime verification and language comparison](modules/src/root/infrastructure-verification.md).


Write what the code cannot explain, while the work is fresh. A useful note
preserves an alternative that lost, a failure mode, a surprising dependency
behavior, or reasoning that would otherwise have to be rediscovered.

Do not write a note just to describe a newly created folder.

## Telemetry into HTTP: implemented slice

- [Slice and leaf order](../TELEMETRY_HTTP.md).
- [Telemetry design/language notes](modules/src/shared/telemetry/README.md).
- [HTTP completion and error-presence notes](modules/src/shared/http/README.md).
- [Root signal wiring](modules/src/root/telemetry-http.md).

These notes record the implemented native adapters, language-specific lifecycle
choices and real process/collector verification.

## Implemented process foundations

The [runnable example](../FOUNDATIONS.md) composes all shared foundations.
Module notes mirror their full source directories:

- [Secret](modules/src/shared/secret/README.md): native presentation and disclosure.
- [Env](modules/src/shared/env/README.md): presence, strict parsing and safe manifests.
- [Provenance](modules/src/shared/provenance/README.md): identity lifetimes and transitions.
- [Logger](modules/src/shared/logger/README.md): projections, native adapters and delivery.
- [Root](modules/src/root/README.md): configuration, process ownership and actual executable checks.

## Clock and ID foundations

- [Clock walkthrough](modules/src/shared/clock/language-walkthrough.md): wall time,
  elapsed units, fake ownership and native syntax.
- [ID walkthrough](modules/src/shared/id/language-walkthrough.md): UUID values,
  explicit generation, failures and deterministic fixtures.
- [Clock mutations](modules/src/shared/clock/mutations.md) and
  [ID mutations](modules/src/shared/id/mutations.md): exact faults and observed results.


## Error foundation review

Start with [the TypeScript / JavaScript code walkthrough](modules/src/shared/errors/language-walkthrough.md)
for a reading order, links to the implementation and a worked example. The
language notes explain the syntax, the technique it supports and its gotchas:

1. [Literal inference, generics and distributed unions](language/typescript-literals-generics-and-distributed-unions.md).
2. [Copies, freezing and WeakMap provenance](language/javascript-freezing-copying-and-weakmap-provenance.md).
3. [Results, unknown caught values and exception edges](language/typescript-results-unknown-and-exception-edges.md).

Two reusable testing notes capture the method and the concrete fixture lesson:

- [Specification tests and targeted mutations](techniques/specification-tests-and-targeted-mutations.md).
- [Metadata tests need distinct keys](techniques/metadata-tests-need-distinct-keys.md).

## Recorded findings

- [Mutation checks after the errors consistency refactor](modules/src/shared/errors/mutations.md)
  — selected faults caught, and the field-loss bug only E10 detects.

- [A common public shape still needs different absence semantics](modules/src/shared/errors/consistency.md)
  — preserving unknown failures while aligning the three public projections.

- [The first errors slice](modules/src/shared/errors/first-slice.md) — initial failing tests,
  implementation choices and targeted fault-check results.

- [Typed failure values still need runtime boundaries](modules/src/shared/errors/typescript-adaptation.md)
  — reasoning behind the [draft errors contract](../src/shared/errors/index.ts).

- [PostgreSQL 18 changed the Docker data-volume boundary](substrate/postgres-18-docker-volume-layout.md)
  — used by [compose.yaml](../compose.yaml).

- [OTLP metric names can change on ingestion](substrate/otlp-metric-names-change-on-ingestion.md)
  — used by the [synthetic probe](../tools/telemetry/smoke.py) and
  [retrieval guide](../OBSERVABILITY.md).

## Choose by lifespan

| Directory | What the finding is true of | When to revisit |
| --- | --- | --- |
| `modules/<source-directory>/` | This implementation, mirroring its source directory | Its code or caller changes |
| `substrate/` | A dependency at a particular version | That dependency changes |
| `patterns/` | An architectural approach | Its assumptions change |
| `techniques/` | A broadly reusable method | New evidence contradicts it |
| `language/` | Language behavior | The language or toolchain changes |
| `concepts/` | A domain concept | The domain understanding changes |

A module note may link to a transferable note. Keep transferable notes independent
of repository-specific paths; put concrete usage links in the module note or a
local index. Package documentation can hold short module reasoning without a
second copy here.

## Module note paths

Use `notes/modules/<repository-relative source directory>/<topic>.md`.
Mirror the full directory path 1:1, including `pkg/`, `internal/` or `src/`;
do not flatten it into module-name filename prefixes. A note for a nested
domain, application, adapter or transport directory mirrors that narrower path.

The current error module maps like this:

| Source directory | Module notes |
| --- | --- |
| `src/shared/errors/` | [notes/modules/src/shared/errors/](modules/src/shared/errors/README.md) |

The module directory owns short topic filenames such as `first-slice.md`,
`language-walkthrough.md` and `mutations.md`. Keep associated evidence beside
its note and use a local README to navigate the module's documents. Rebase both
incoming links and links from the moved notes whenever the source owner moves.

Create directories when there are findings to record. A matching directory tree
does not require a note for every source file or empty copies of every code
directory. Reusable language and technique notes retain their separate categories.

## Shape

Use a descriptive filename, a title, and a one-sentence claim that adds something
to the title. Then record:

- **Origin:** what taught this, and whether it was observed, tested or read.
- **What and why:** the useful finding and the alternative or failure behind it.
- **Example:** the smallest useful demonstration, when needed.
- **Gotchas:** assumptions and limits.
- **Used in:** actual use; module notes name local files, transferable notes name
  the usage context without depending on one repository.
- **Related:** relevant notes, contracts or decisions.

Mark unsettled claims **WORKING**. Substrate notes name the dependency version,
verification date and primary source. Distinguish reading documentation from
measuring behavior.

Keep progress and command logs in [STATUS.md](../STATUS.md). Record consequential
choices in [decisions/](../decisions/README.md). Notes must not conceal unfinished
work behind a retrospective explanation.
