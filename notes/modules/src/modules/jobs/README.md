# Jobs module notes

Jobs use cases return `JobsApplicationFailure`, which includes the closed
`JobFailure` domain union and explicit application policy failures. Port
failures are mapped by failure kind to operation-aware Jobs dependency codes;
the underlying failure is retained only as diagnostic cause. This prevents a
queue or database adapter from becoming part of the Jobs public language.

## Why Jobs is a domain

Jobs is not a queue wrapper. It is a domain because execution work has
business-visible state, ownership, retry budget, attempts, failure reasons and
observable completion. A queue or worker may change later; those changes must
not rewrite the meaning of a submitted Job.

## Domain language and invariants

`Job` is an immutable aggregate with an organization reference and a validated
kind such as `document.process`. It starts `queued`, becomes `running` when an
attempt begins, and can become `succeeded`, `failed` or `canceled`.

The retry budget is bounded from one to ten attempts. Starting work increments
the attempt count. Failure records a failure code; retry returns the failed job
to `queued` only when another attempt remains. Terminal success and cancellation
cannot be transitioned again. `restore(...)` checks the persisted lifecycle
invariants before a row becomes a trusted Job value.

The aggregate returns the closed `JobFailure` union. Event names are owned by
`domain/events.ts`; the application layer is responsible for constructing the
shared envelope and choosing the outbox writer. This separates Job meaning
from queue, worker and broker implementations.

Dates are copied at aggregate boundaries and transitions are monotonic. Job
kind and failure code are small product-neutral vocabularies; they are opaque
to the aggregate and can be extended by owning workflows later.

## Application coordination

`SubmitJob`, `ListJobs` and the explicit lifecycle commands use ports for
organization access, reading and writing. The Jobs module does not import
Document and does not decide what a particular job kind means. A Job may carry
an opaque subject reference (`type` plus ID), which lets an owning workflow
correlate execution without coupling Jobs to the referenced domain.

The first HTTP policy lets owners/admins submit and transition jobs while any
active organization member can list them. This is a template policy for
inspection, not a final worker authentication design. A later worker adapter
can invoke the same application seam with service identity or messages.

Each state change emits a versioned fact with the shared `Envelope` and
`WorkContext`. Audit observes those facts; it is not called by Job commands.
The writer owns the state-plus-outbox boundary, which preserves the seam for a
future remote worker or NATS-based deployment.

## Infrastructure and transport

The in-memory reader/writer supports fast local development. PostgreSQL stores
the Job lifecycle and uses `Job.restore(...)` when rehydrating rows. Both
writers publish through the same event boundary. The queue, worker, scheduler
and handler remain replaceable infrastructure and are intentionally not part of
this first slice. The workflow that interprets a `document.process` subject
lives outside both Jobs and Document.

That opaque subject is deliberate. Jobs may refer to a Document without
importing the Document aggregate, which preserves the bounded-context seam and
allows the worker side to be extracted later.

## Shared package review

No new shared package was needed. Jobs reuses existing IDs, clocks, errors,
provenance, event envelopes, PostgreSQL transactions and HTTP problem mapping.
Retry policy remains in the Jobs domain because its attempt budget is part of
Job meaning. A generic queue policy should only move to shared after multiple
domains prove that they need identical semantics.

## Verification

Domain tests cover submission, immutable lifecycle transitions, failure and
retry, attempt exhaustion and invalid kinds. The runtime integration exercises
the HTTP lifecycle and Audit projection. PostgreSQL and NATS integration cover
durable Job state and event delivery.

## Next decisions

- Should worker transitions use service identities rather than organization
  owner/admin bearer sessions?
- Should scheduling, deadlines and backoff be Job state or worker policy?
- Which additional generic subject constraints, if any, should Jobs enforce?
