# Jobs infrastructure layer

The in-memory reader/writer is the default local adapter. The PostgreSQL
adapter is selected as a complete reader/writer pair by the platform runtime,
persists the Job lifecycle and enqueues the same facts through the outbox
boundary. Queue clients, workers, schedulers and delivery adapters are still
platform/infrastructure concerns; the Job aggregate does not depend on
BullMQ, NATS, PostgreSQL or a particular worker runtime.

Adapter contract tests cover the in-memory write/read path, rollback when event
publication fails, PostgreSQL state-before-outbox ordering, opaque subject
rehydration and safe database failure mapping.
