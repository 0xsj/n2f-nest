# Telemetry module notes

Telemetry keeps trace identity and outcome vocabulary SDK-free. `TraceRef` is a
module-created capability whose snapshot can be handed to an adapter later; the
shared layer does not import OpenTelemetry or own exporter lifecycle.

Trace and span IDs are lowercase non-zero hexadecimal values. Outcomes are a
closed set for consistent projections: success, refused, failed, canceled and
timed out. Sampling is preserved as data, not interpreted as authorization.

See [`src/shared/telemetry/`](../../../../../src/shared/telemetry/).
