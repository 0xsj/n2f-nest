# Chaos and fault-injection notes

## Boundary

Chaos is a test-support capability, not a production domain and not a default
`AppModule` import. It gives resilience tests deterministic control over named
adapter seams while keeping recovery policy in the system under test.

`FaultInjector` supports one-shot, repeated and always-on failures, plus
bounded delays and cancellation. It records observations so a test can assert
that the intended fault actually occurred. `ChaosEventBus` wraps the real
`EventDelivery` and injects faults before and after publication or around one
consumer's handler; a fault's optional `consumer` field limits it to one named
consumer, so a test can fail Audit while `document-processing` proceeds.

The same injector can wrap the generic `Publisher`, `OutboxStore` and
`TransactionDatabase` seams through `ChaosPublisher`, `ChaosOutboxStore` and
`ChaosTransactionDatabase`. This lets one fault vocabulary exercise local
delivery, NATS publishers, outbox lease/ack coordination and PostgreSQL-backed
module adapters without importing domain internals.

## Why the failure is placed after delivery

An `event.consume.after` failure models a subscriber that has completed its
write but lost its acknowledgement. An `event.publish.after` failure models a
publisher that cannot tell whether the downstream handoff completed. These are
more useful than simply replacing the whole bus with a fake because they test
idempotency and replay behavior at the ambiguous boundary.

The first harness proves that Audit does not duplicate an entry when the same
event is replayed. It does not claim that the local bus retries automatically;
the caller or durable outbox owns that recovery policy.

Live infrastructure coverage now includes a PostgreSQL transaction
acknowledgement-loss scenario in `test/postgres.integration.spec.ts` and a
JetStream publisher acknowledgement-loss/deduplication scenario in
`src/shared/events/nats/broker.integration.spec.ts`. The existing JetStream
redelivery test also covers a destination that fails before ACK. The NATS
adapter now retains a reconnecting client after a successful initial connect;
an environment-level restart should therefore produce a temporary readiness
failure followed by recovery without replacing the backend process. The root
`make backend-test-nats-restart` target automates that interruption and then
walks the durable HTTP/Audit workflow.

The PostgreSQL pool similarly discards failed clients and establishes new
connections after the dependency returns. `make backend-test-postgres-restart`
automates a short database stop/start window and verifies the same durable
workflow after readiness recovers.

## Limits

The current adapter covers the local EventBus only. The wrappers cover the
transaction and publisher seams, but live PostgreSQL connection loss and lease
expiry still need environment-level scenarios.
They should be added as separate
fault points rather than making one universal chaos object know every module's
internals. A transaction `after` fault deliberately models an uncertain
outcome; it cannot prove whether a real database commit happened without a
database-backed integration test.

Run the opt-in integration with:

```sh
bun run test:chaos
```

The ordinary application and test commands do not enable chaos.
