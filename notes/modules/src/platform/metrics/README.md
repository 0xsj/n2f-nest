# Platform metrics notes

The platform records bounded HTTP metrics without coupling the application to
Prometheus, OpenTelemetry or another vendor SDK.

## Origin

The backend already emitted request logs, request IDs and trace context, but it
had no machine-readable operational view of traffic volume, latency or active
work.

## What and why

- `MetricsRegistry` is a small shared observation capability with counters,
  gauges and histograms.
- `PlatformMetricsModule` owns the process-local registry and exposes a
  Prometheus-compatible `GET /metrics` adapter.
- HTTP instrumentation records method, route template, status and bounded
  outcome labels. It never uses the raw request URL as a label.
- Metrics are intentionally process-local and best-effort. Durable business
  state and audit records remain the responsibility of their domains and event
  projections.

## Example

```text
GET /metrics

# HELP n2f_http_requests_total Completed HTTP requests.
# TYPE n2f_http_requests_total counter
n2f_http_requests_total{method="GET",route="/health/live",status="200",outcome="success"} 1
```

The registry ignores undeclared labels and invalid numeric observations so an
instrumentation mistake cannot make a request fail.

## Gotchas

- A separate registry exists in each process; aggregation belongs to the
  scraper or metrics backend.
- Route labels use Express route templates when available and `unmatched`
  otherwise, avoiding unbounded cardinality from IDs in URL paths.
- `/metrics` is an operational endpoint and should be network-restricted by the
  deployment boundary when the service is exposed beyond a trusted network.
- The registry is an adapter seam, not a replacement for distributed tracing;
  request IDs and W3C trace context remain in the HTTP layer.

## Used in

- `src/shared/metrics/index.ts`
- `src/platform/metrics/metrics.module.ts`
- `src/platform/metrics/metrics.controller.ts`
- `src/platform/http/request-logger.middleware.ts`
- `test/persistent-e2e.integration.spec.ts`

## Related

- [Platform HTTP notes](../http/README.md)
- [Shared telemetry notes](../../../shared/telemetry/README.md)
