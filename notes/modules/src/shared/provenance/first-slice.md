# The first provenance slice: attribution and causality without authority

Provenance explains where work came from and who performed it. It does not prove
that the claim is authorized, persisted or successfully completed.

## Origin

Reviewed and adapted from the predecessor product's provenance contract on 2026-09-18.
The fresh implementation keeps the core transitions and ownership guarantees,
adds `message` as a first-class origin for NATS-style consumers and reuses the
shared `WallClock` and `IDGenerator` capabilities.

## What it does

- Represents named user, service and system actors, plus explicit anonymous
  actors; absent initiator remains distinct from anonymous.
- Records optional delegation, tenant context, operation and typed references.
- Separates logical `WorkContext` from an execution `Scope`.
- Opens local roots, children, prepared work, executions, retries and replays.
- Preserves retry lineage without treating a retry as a new logical child hop.
- Inspects public incoming correlation hints without adopting attribution,
  tenant, depth, origin, executor or authority.
- Bounded `LinkSet` values retain additional inputs without selecting a parent.
- Copies snapshots and Dates so caller mutation cannot rewrite existing values.
- Forwards ID-generator failures without relabeling or retrying them internally.

## Domain ownership boundary

The shared field is called `tenant` because the primitive remains product-neutral.
An owning domain may define that its tenant value is an organization, workspace
or another bounded-context identifier. Product-specific membership and
authorization semantics remain owned by their domains.

## Deliberately deferred

HTTP headers, NATS message envelopes, WebSocket connection identity, tracing
context, authentication, producer verification, persistence codecs, audit
retention and outcome/commit records are adapter or domain responsibilities.
`restoreWork` and `restoreScope` validate trusted typed snapshots; a JSON or
remote decoder must authenticate and construct values at its own boundary.

## Used in

- [`factory.ts`](../../../../../src/shared/provenance/factory.ts)
- [`work.ts`](../../../../../src/shared/provenance/work.ts)
- [`scope.ts`](../../../../../src/shared/provenance/scope.ts)
- [`provenance.spec.ts`](../../../../../src/shared/provenance/provenance.spec.ts)
