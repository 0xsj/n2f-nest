# Jobs application layer

`failures.ts` defines the Jobs application error contract. It preserves typed
domain failures and translates open reader/writer failures into operation-aware
dependency failures, so a queue, database or broker adapter cannot widen the
use-case result to an unstructured error.

The first application slice exposes `SubmitJob`, `ListJobs` and explicit
lifecycle commands for start, complete, fail, retry and cancel. Organization
owners/admins submit and transition jobs; active members can list them.

The commands use Job reader/writer ports and emit versioned facts. They do not
know whether a worker, queue, PostgreSQL transaction or NATS delivery performs
the underlying execution.
