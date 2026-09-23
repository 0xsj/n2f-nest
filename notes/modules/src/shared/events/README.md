# Events module notes

The first event slice is a versioned, bounded envelope and a replaceable
publisher capability. Domain modules own event types and payload meaning;
delivery adapters own handoff, retry and consumer receipts.

An envelope carries an event ID, versioned type, occurrence time, full producer
work context, a bounded object payload and, optionally, a `subject`: the
aggregate the event is about, named by the producing module
(`{ kind: 'document', id }`). Consumers such as Audit read the subject from the
envelope instead of interpreting another module's payload; envelopes written
before `subject` existed still decode. Decode reconstructs trusted provenance
values instead of accepting lookalike objects.

Publisher durability does not mean consumer completion. The `Inbox` contract
(`inbox.ts`) is the per-consumer delivery ledger: `accept` opens one delivery
per named consumer, `deliver` leases one consumer's next due event, and
`retry.ts` schedules failures with exponential backoff and jitter until a
delivery is dead. `InMemoryInbox` and the PostgreSQL `Mailbox` implement it;
`inbox.contract.spec.ts` runs one contract against both.

A consumer that reads another module's payload decodes it with its own
decoder, reading only the fields it needs; a contract spec in `test/contracts/`
proves the producer's real events still decode (for example
`test/contracts/job-events.contract.spec.ts` for the document-processing
workflow).

PostgreSQL outbox/mailbox storage and the NATS JetStream adapter implement the
`Publisher` seam. The domain-facing envelope remains independent of either
transport.

The shared `assertEventWork` guard is used by persistence writers to ensure an
outbox envelope was created for the same provenance scope as the state write.
This invariant belongs with events rather than with any product module.

See [`src/shared/events/`](../../../../../src/shared/events/).

- [PostgreSQL adapter notes](postgres/README.md)
- [NATS adapter notes](nats/README.md)
