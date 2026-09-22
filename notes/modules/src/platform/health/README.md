# Platform health notes

The Nest health module exposes a small operational boundary while the shared
`Gate` owns the lifecycle and bounded readiness semantics.

## Origin

The shared health primitive already modeled startup, serving and draining, but
the running process had no HTTP probe that orchestrators or local operators
could use.

## What and why

- `GET /health/live` is a liveness probe. It answers whether the process can
  serve HTTP and does not depend on PostgreSQL or NATS.
- `GET /health/ready` and `GET /health` are readiness probes. They run bounded
  checks against configured durable dependencies and return `503` when the
  process is starting, draining or a dependency is unavailable.
- The module observes platform runtime tokens, while the shared `Gate` remains
  framework-free and receives checks as `Result`-returning functions.
- Nest shutdown hooks drain readiness before the process closes its resources,
  preventing a draining instance from advertising itself as available.

## Example

```text
GET /health/live   -> 200 {"status":"live"}
GET /health/ready  -> 200 {"status":"ready"}
GET /health        -> 503 {"status":"not_ready"}  # during startup/drain
```

## Gotchas

- A liveness success does not prove that PostgreSQL or JetStream is healthy.
- Readiness intentionally returns no dependency details; diagnostics belong in
  logs and metrics rather than an unauthenticated endpoint.
- The NATS check is a JetStream API ping, not a publish. Readiness must not
  mutate the event stream.
- In memory/local mode there are no external dependency checks, so the gate
  becomes ready after application bootstrap.

## Used in

- [`src/platform/health/health.module.ts`](../../../../../src/platform/health/health.module.ts)
- [`src/platform/health/health.controller.ts`](../../../../../src/platform/health/health.controller.ts)
- [`src/shared/health/index.ts`](../../../../../src/shared/health/index.ts)
- [`test/persistent-e2e.integration.spec.ts`](../../../../../test/persistent-e2e.integration.spec.ts)

## Related

- [Shared health notes](../../../shared/health/README.md)
- [Platform runtime notes](../runtime/README.md)
