# HTTP module notes

The HTTP shared layer defines framework-neutral request, reply, problem and
completion values; Nest or another server adapter owns sockets and transport
lifecycle.

## Origin

This is the transport boundary that the old backend had accumulated around its
feature routes. It is retained as a reusable boundary, but it does not import
Nest, controllers or product modules.

## What and why

- `problemOf` maps public failure kinds to stable HTTP status and problem
  values. Internal diagnostics remain inside the failure projection.
- `classifyCompletion` distinguishes a refused business response from a
  failed transport or handler. A 409 is not automatically an infrastructure
  error, while a 500 is.
- `Active` makes completion idempotent and measures duration with monotonic
  time. Observation sinks are isolated; one broken sink cannot break response
  handling.
- Cookies, reply headers and reply statuses are allowlisted. This keeps the
  eventual Nest adapter from becoming a generic header/value passthrough.
- The JSON parser rejects duplicate keys and bounds nesting. This is useful at
  request boundaries where permissive parser behavior can create signature or
  validation differences.

## Gotchas

- `Reply` supports only the current shared status set. Domain modules should
  return domain results; the HTTP adapter decides when to build a reply.
- `Refuse` carries transport-facing headers and cookies while preserving the
  original classified error for problem projection.
- The module does not authenticate requests. Identity owns admission and the
  transport adapter turns that result into an `Admission`.

## Used in

- `src/shared/http/problem.ts`
- `src/shared/http/policy.ts`
- `src/shared/http/lifecycle.ts`
- `src/shared/http/json.ts`
- `src/shared/http/feature.ts`
- `src/shared/http/http.spec.ts`
- `src/shared/http/feature.spec.ts`

## Related

- [`errors`](../errors/README.md)
- [`provenance`](../provenance/README.md)
- [`telemetry`](../telemetry/README.md)
- [`httpclient`](../httpclient/README.md)
