# Notes

Notes preserve reasoning that the code alone cannot communicate: language
behavior, design alternatives, failure modes, testing techniques and ownership
decisions.

They are not a replacement for types or tests, and they are not required for
every file. A useful note should answer at least one question a future reader
would otherwise have to rediscover.

## Current notes

- [Errors module](modules/src/shared/errors/README.md): the first shared leaf
  in the fresh backend.
- [Clock module](modules/src/shared/clock/README.md): explicit wall and
  monotonic time for deterministic foundations.
- [ID module](modules/src/shared/id/README.md): branded UUID values and
  explicit UUIDv7 generation effects.
- [Provenance module](modules/src/shared/provenance/README.md): attribution,
  logical work, execution scopes and causality.
- [Validation](modules/src/shared/validation/README.md), [secret](modules/src/shared/secret/README.md),
  [keyed](modules/src/shared/keyed/README.md) and [pagination](modules/src/shared/pagination/README.md):
  reusable input, disclosure, digest and query-boundary capabilities.
- [Rate limiting](modules/src/shared/ratelimit/README.md) and [platform rate limiting](modules/src/platform/ratelimit/README.md):
  reusable quota mechanics separated from transport and endpoint policy.
- [Telemetry](modules/src/shared/telemetry/README.md), [health](modules/src/shared/health/README.md)
  and [events](modules/src/shared/events/README.md): SDK-free observation,
  readiness and the first event envelope seam.
- [Platform metrics](modules/src/platform/metrics/README.md): bounded HTTP
  counters, latency histograms and active-request instrumentation.
- [Logger](modules/src/shared/logger/README.md) and [environment](modules/src/shared/env/README.md):
  bounded diagnostics and typed process configuration.
- [HTTP](modules/src/shared/http/README.md), [HTTP client](modules/src/shared/httpclient/README.md),
  [PostgreSQL](modules/src/shared/postgres/README.md) and [socket](modules/src/shared/socket/README.md):
  framework-free transport and infrastructure boundaries.
- [Identity module](modules/src/modules/identity/README.md), its [domain design](modules/src/modules/identity/DOMAIN-DESIGN.md),
  [registration application design](modules/src/modules/identity/APPLICATION-DESIGN.md), [verification design](modules/src/modules/identity/VERIFICATION-DESIGN.md)
  [session design](modules/src/modules/identity/SESSION-DESIGN.md) and [current Identity query design](modules/src/modules/identity/CURRENT-IDENTITY-DESIGN.md): the first product-domain lifecycle, application orchestration, provenance, verification, authentication and read-side boundaries.
- [Identity failure design](modules/src/modules/identity/FAILURE-DESIGN.md): the first typed failure union and exhaustive application match.
- [Identity infrastructure and transport](modules/src/modules/identity/INFRA-TRANSPORT-DESIGN.md): the process-local adapters, Nest provider tokens, HTTP mapping and curlable vertical slice.
- [Audit module](modules/src/modules/audit/README.md): the first event consumer, idempotent projection boundary and provenance-preserving audit read model.
- [Organization module](modules/src/modules/organization/README.md): the agency/team operating context, memberships and initial role contract.
- Document and Jobs module notes also record their bounded-context language, aggregate invariants, typed failures and domain-owned event vocabularies.
- [Platform events](modules/src/platform/events/README.md): the replaceable in-process event bus and one-at-a-time durable outbox dispatcher seam.
- [Platform runtime](modules/src/platform/runtime/README.md): explicit memory/PostgreSQL provider selection, migration startup and lifecycle ownership.
- [Platform health](modules/src/platform/health/README.md): liveness, bounded dependency readiness and graceful drain behavior.
- [Platform HTTP](modules/src/platform/http/README.md): request IDs, W3C trace propagation and transport-only observability context.
- [Chaos and fault injection](modules/src/platform/chaos/README.md): opt-in resilience testing at the event acknowledgement and replay boundary.
- [TypeScript literals and generics](language/typescript-literals-generics-and-distributed-unions.md):
  how the closed kind union and narrow failure types work.
- [JavaScript ownership and provenance](language/javascript-freezing-copying-and-weakmap-provenance.md):
  why the implementation copies, freezes and uses private `WeakMap`s.
- [Results and exception edges](language/typescript-results-unknown-and-exception-edges.md):
  why ordinary failures are returned while framework edges may throw.
- [Error values and exception boundaries](architecture/error-values-and-exception-boundaries.md):
  the enforceable rule for Result-oriented domain and application code.
- [Integration bridges](modules/src/integration/README.md): how modules stay
  islands while one module's port is fulfilled by another module's query.
- [The hardening bar](architecture/hardening-bar.md): the security and
  resilience checklist the boilerplate must meet, with the proof for each item.
- [ADR-001: persistence and event namespace](architecture/ADR-001-persistence-and-event-namespace.md):
  the renamed persistence and event namespace and the migration baseline.
- [Specification tests](techniques/specification-tests-and-targeted-mutations.md):
  how the tests express behavior and expose tempting implementation mistakes.

## Note shape

Use a descriptive title and a one-sentence claim. Then record:

- **Origin:** what prompted the note and whether it was observed, tested or reasoned.
- **What and why:** the useful decision and the alternative or failure it avoids.
- **Example:** the smallest useful code or scenario.
- **Gotchas:** assumptions, limits and future pressure points.
- **Used in:** concrete source paths.
- **Related:** nearby notes, decisions or specifications.

Keep module notes under `notes/modules/<source-directory>/` so they mirror the
source tree. Keep transferable language and technique findings in their own
categories. Mark unsettled claims **WORKING**.
