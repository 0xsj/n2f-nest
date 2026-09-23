# Logger module notes

The logger is a process boundary for diagnostics, not a second domain event
system. It accepts immutable snapshots, projects trusted provenance and
classified failures, and hands bounded records to a replaceable sink.

## Origin

This slice adapts the useful parts of the old shared logger while removing its
contract-document dependency. The behavior is guarded by specification tests
because logging failures must not become application failures or disclosure
paths.

## What and why

- `Logger` is an immutable builder. `with`, `withScope`, `withError` and
  `withTrace` create child views without changing the parent.
- `fields.snapshot` accepts plain data only. Accessors, cycles, custom
  prototypes and unsupported values are refused rather than coerced into an
  unsafe string representation.
- `SecretString` becomes `[REDACTED]` at the snapshot boundary. The logger
  never needs a general-purpose recursive redaction registry.
- The delivery queue is bounded. Once full, a record is dropped and counted;
  an unbounded diagnostic queue could become a memory failure during an
  incident.
- JSON output uses Pino as the process adapter. Console and no-op formats stay
  explicit so tests and local development do not depend on a global logger.
- `close` has a deadline and returns a `Result`; sink errors are observable in
  runtime stats without being thrown from a business call.

## Example

```ts
const runtime = create({
  format: 'json',
  level: 'info',
  clock,
  resource: { name: 'n2f-nest' },
  sink,
});

if (runtime.ok) {
  runtime.value.log.with({ component: 'identity' }).info('started');
}
```

## Gotchas

- The logger records diagnostic facts; Audit will record product/business
  facts. Do not use logger output as the durable audit trail.
- Provenance projection is intentionally read-only and validates the scope
  before reading its snapshot. A forged lookalike should not enter output.
- The logger is framework-free. Nest wiring belongs in the process composition
  root and can later be replaced by another runtime adapter.
- The bounded queue is an operational policy, not delivery durability. Events
  that must be recovered belong behind the event/outbox seam.

## Used in

- `src/shared/logger/config.ts`
- `src/shared/logger/fields.ts`
- `src/shared/logger/projection.ts`
- `src/shared/logger/delivery.ts`
- `src/shared/logger/runtime.ts`
- `src/shared/logger/logger.spec.ts`

## Related

- [`events`](../events/README.md)
- [`secret`](../secret/README.md)
- [`provenance`](../provenance/README.md)
- [`telemetry`](../telemetry/README.md)
