# Jobs infrastructure layer

The in-memory reader/writer is the default local adapter. The PostgreSQL
adapter persists the Job lifecycle and enqueues the same facts through the
outbox boundary. Queue clients, workers, schedulers and delivery adapters are
still platform/infrastructure concerns; the Job aggregate does not depend on
BullMQ, NATS, PostgreSQL or a particular worker runtime.
