# Events module notes

The first event slice is a versioned, bounded envelope and a replaceable
publisher capability. Domain modules own event types and payload meaning;
delivery adapters own handoff, retry and consumer receipts.

An envelope carries an event ID, versioned type, occurrence time, full producer
work context and a bounded object payload. Decode reconstructs trusted
provenance values instead of accepting lookalike objects. Publisher durability
does not mean subscriber completion, which is why consumer receipts remain a
separate concern for the Identity/Audit integration slice.

PostgreSQL outbox/mailbox storage and the NATS JetStream adapter implement the
`Publisher` seam. The domain-facing envelope remains independent of either
transport.

The shared `assertEventWork` guard is used by persistence writers to ensure an
outbox envelope was created for the same provenance scope as the state write.
This invariant belongs with events rather than with any product module.

See [`src/shared/events/`](../../../../../src/shared/events/).

- [PostgreSQL adapter notes](postgres/README.md)
- [NATS adapter notes](nats/README.md)
