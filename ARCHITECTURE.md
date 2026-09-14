# Architecture

## First domain slice

[Identity, audit and org ownership](DOMAINS.md) is defined. Identity implements
authentication, persistence and transport; audit ingestion and org value leaves
are also implemented. The org application port, transactional persistence and
domain transport follow those leaves. Principal references alone confer no
authentication or org authority.
[Authentication](AUTHENTICATION.md) is required within identity, independent of an
account/profile domain. Credential/session/challenge contracts precede their adapters.

Build a modular monolith with boundaries around domain ownership. Keep the useful
responsibilities familiar across the nine to five family while using TypeScript
and NestJS where they fit. Folder similarity alone establishes neither behavioral
compatibility nor the ability to extract a module into a service.

These are review-held rules. There is no architecture checker yet. The foundations
command composes the implemented shared modules; Nest's greeting remains an
independent HTTP example at `src/root/`. Domain and application boundaries below
are now concrete in the identity, audit and org domain slices.

## Dependency direction

`domain` owns business values, invariants, and lifecycle rules. `app` depends on
that domain and declares the ports its use cases need. Both are ordinary TypeScript
without Nest decorators, HTTP request objects, database drivers, or SDK types.

`infra` implements application ports. `transport` translates external requests into
use-case inputs and results into caller-facing responses. These edges can depend on
the application and domain; the application and domain cannot depend on the edges.

`root` selects implementations and assembles the process. Keep Nest module
registration, provider bindings, injection tokens, and factory providers here, with
controllers and infrastructure providers at their owning edges. Construct plain
application objects through explicit factories. A TypeScript interface describes
a dependency; it is not a runtime injection token.

## A business module

Create only the directories a real feature needs:

```text
src/modules/<name>/
  domain/            values, invariants, lifecycle rules
  app/
    command/         state-changing use cases and their consequences
    query/           reads and projections
  infra/             concrete adapters, with storage details owned here
  transport/         module-local HTTP or other protocol handling
```

A module owns its application interfaces and storage translation. A persistence
adapter should keep its queries, mapping, and migrations together when those exist.
Queries may use dedicated read models; they need not reconstruct aggregates only to
return a projection. The command/query split is an organization convention and
does not require separate databases or buses.

Modules do not import peer modules, including their public application surfaces.
A consumer declares the capability it needs; `root` composes an adapter against the
other module's deliberate application surface. Cross-domain workflows and composed
reads must make that coordination visible. Add events only when a real interaction
establishes their contract.

## Shared foundations and effects

`src/shared/` is reserved for capabilities with a named responsibility and concrete
consumer, which may be the process itself. Separate framework-free shared values
from infrastructure integrations as they appear. Avoid a catch-all utilities
directory or a base abstraction that makes
unrelated domains depend on one another. Errors, clock, IDs, secrets, env parsing,
provenance and logging are implemented shared foundations. Root owns typed config
and the foundations command. HTTP/telemetry, PostgreSQL, outbound HTTP, WebSockets
and events now have concrete adapters and executable diagnostics.

Clocks, identifier generation, persistence, and publishing belong in explicit use-case
dependencies when needed. Make success and failure meaningful at the application
boundary, then translate them at transport boundaries without exposing internal
details.

Before introducing a command that both writes state and publishes an event, define
its transaction owner, commit boundary, and delivery guarantee. A decorator or a
sequence of awaited calls does not itself make the two effects atomic. A database
transaction, durable event recording, retries, and receipts each need concrete
implementation and verification before callers can rely on them. The shared
outbox/mailbox adapter now establishes these infrastructure guarantees against
PostgreSQL; each domain must still place its effects inside that boundary.

## Process and evidence

`src/main.ts` owns entering the process; `src/root/` owns construction and wiring.
As resources and workers arrive, make startup validation and shutdown ownership
explicit there. Product rules belong in their business modules, not in bootstrap
or global Nest middleware.

Keep unit tests near their subject and assembled HTTP checks in `test/`. Add checks
for the guarantees introduced by a feature, including meaningful failure paths.
Comparable scenarios across backends matter more than matching implementation
details. Real Flover integrations will establish which compatibility assumptions
hold.

Record discoveries in [notes](notes/README.md), durable choices in
[decisions](decisions/README.md), and implemented behavior and verification limits in
[STATUS.md](STATUS.md). Update this document when an accepted boundary changes.

## Local dependency topology

[Compose](compose.yaml) owns this clone's PostgreSQL, Redis, Mailpit, S3 and
observability containers, network and data volumes. [INFRASTRUCTURE.md](INFRASTRUCTURE.md) describes local operation.
Applications run separately for now. Adding a container does not select a driver,
create a migration, or supply an application port implementation.

## Selected foundation boundaries

[Observability](OBSERVABILITY.md) is a first-class process responsibility, with OTLP
as the export boundary and shared meaning across logs, traces and metrics. WebSocket
is the chosen realtime transport. SMTP and S3 clients live in owned infrastructure
adapters. Their SDK types must not become domain APIs.

For state-changing event workflows, atomically record the event in an outbox. Keep
delivery separately owned so JetStream or a simpler dispatcher can be supplied
without moving the transaction boundary. Swapping adapters requires equivalent
failure/retry/duplicate scenarios; an interface alone does not establish parity.
The event and WebSocket contracts and concrete diagnostics are implemented;
see [the infrastructure guide](INFRASTRUCTURE_BUILD.md).

## Provenance ownership

[src/shared/provenance](src/shared/provenance/README.md) implements immutable execution
scopes and stable WorkContext. Initiator, executor, represented principal and
tenant have explicit lifetimes. Replays open a new chain linked to original work;
extra causal links belong beside an owning envelope. Public correlation hints
and validated persisted work are different admission paths.

The core consumes shared IDs/errors and narrow clock/generation capabilities.
The logger's explicit scope projection is implemented. Runtime context carriers,
HTTP/WebSocket propagation, broker codecs, tracing and public/audit projections
remain adapters. Scope is not an authorization context, transaction receipt,
deduplication record or domain evidence model. P01–P19/P23 have core evidence;
P20–P22/P24 remain adapter/integration requirements.

## Telemetry into HTTP

[The diagnostic HTTP slice](TELEMETRY_HTTP.md) is implemented and verified with real
requests and stored OTLP signals.
Telemetry owns trace/outcome values and concrete SDK delivery. HTTP owns safe wire
projection, ingress admission and request completion, and declares the observation
capability its adapter needs. Root wires providers and shares service resources
and the shutdown budget. SDK types stay within root and concrete adapters; shared
value leaves and application contracts do not import them.

Use a real diagnostic request before introducing a business domain. Keep failures,
refusals, sampling and transport termination distinct. Neither an SDK dependency
nor an interface demonstrates export, delivery or frontend compatibility.

## Implemented request boundary

The diagnostic HTTP process composes existing foundations with the native adapter
and concrete OTel providers. One validated service instance is shared by logging
and SDK resources. Completion classification preserves application failure meaning
separately from the server's final response/termination facts.

Root stops admission, drains admitted work, then closes providers and local logging
with the remaining process budget. Collector failure has no response-policy branch.
Exact queue drops are not inferred from generic SDK diagnostics. The first consumer
is bounded JSON. PostgreSQL, outbound HTTP, sockets and events now have separate
owners and concrete diagnostics. Authentication and streaming business workflows
remain domain work.

## Infrastructure ownership before domains

The [implemented slice](INFRASTRUCTURE_BUILD.md) adds pure validation/pagination,
PostgreSQL, readiness, outbound HTTP, sockets and events in that order. Root owns
resource construction, readiness dependencies, diagnostic consumers and shutdown.
Database transactions expose driver types only to concrete persistence adapters;
domain/application ports must use their own vocabulary. No generic repository or
shared business transaction interface has been imposed before a domain needs one.

An outbox is an atomic recording mechanism. Publisher is a separate durable-delivery
capability. PostgreSQL mailbox and JetStream are implemented publisher adapters;
[real JetStream checks](JETSTREAM.md) cover publication and durable handoff. Mailbox deduplication and consumer effects
share a transaction. This single destination does not establish fanout, global
ordering, exactly-once processing or a future audit retention policy.
