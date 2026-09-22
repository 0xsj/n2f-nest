# Platform HTTP notes

The HTTP boundary owns request identifiers and trace propagation without
making product domains depend on a tracing SDK.

## Origin

Requests already received an `x-request-id` and carried that value into
provenance work contexts. The shared telemetry capability and HTTP client also
understood W3C trace identity, but inbound Nest requests did not establish a
trace context.

## What and why

- The middleware accepts a valid W3C `traceparent` or creates a new trace.
- Every request gets a fresh span ID. An incoming trace ID is retained, but the
  caller's span is never reused as the server span.
- The current traceparent is returned on the response and retained in
  `AsyncLocalStorage` beside the request ID.
- Invalid or forged trace headers are ignored and replaced with a safe local
  context; they never become response headers or domain input.
- The request logger records trace and span IDs, while vendor SDK/exporter
  integration remains a later platform adapter.
- The global Nest exception filter adds the current `request_id` to structured
  HTTP exception bodies, allowing clients to correlate a refusal with logs.

## Example

```text
request:  traceparent: 00-<trace-id>-<caller-span>-01
response: traceparent: 00-<trace-id>-<new-server-span>-01
```

## Gotchas

- `TraceRef` is a module-created capability. Formatting an untrusted forged
  object is rejected by the shared telemetry module.
- Sampling is carried as the W3C sampled bit, not interpreted as an access
  decision.
- Request trace context is transport metadata. Domain ports remain free of
  Nest, Express and observability SDK types.
- The filter only enriches HTTP exceptions. It does not expose private failure
  causes or replace the shared failure-to-problem projection.

## Used in

- [`src/platform/http/request-logger.middleware.ts`](../../../../../src/platform/http/request-logger.middleware.ts)
- [`src/platform/http/request-context.ts`](../../../../../src/platform/http/request-context.ts)
- [`src/shared/telemetry/index.ts`](../../../../../src/shared/telemetry/index.ts)
- [`test/persistent-e2e.integration.spec.ts`](../../../../../test/persistent-e2e.integration.spec.ts)

## Related

- [Shared telemetry notes](../../../shared/telemetry/README.md)
- [Shared HTTP client](../../../shared/httpclient/README.md)
