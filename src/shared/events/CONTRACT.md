# Events contract

E01: Envelope owns event ID, versioned type, occurred-at Unix milliseconds, stable
producer WorkContext and a JSON object payload. IDs are valid nonzero shared UUIDs;
type is 1..128 lowercase ASCII letters/digits/dot/underscore/hyphen ending .vN
(N is 1..999999, without leading zeroes). Time is 0..253402300799999 inclusive. Wire version is 1 and
encoded envelope is at most 65536 bytes. Decode restores validated provenance,
including attribution, causation, depth and replay. Unknown versions refuse.
E02: Enqueue is a concrete Postgres adapter operation on the caller's existing
transaction. State and outbox insertion commit together. Event ID reuse with a
different envelope is Conflict; an identical repeat is idempotent. No publish
occurs before commit and no domain-owned table is created by this module.
E03: Dispatcher claims one pending event with a fresh lease token, SKIP LOCKED,
30-second expiry, and at most five attempts. Claim commits before network I/O.
An expired lease can be reclaimed; old lease owners cannot acknowledge/release it.
Failed delivery schedules another attempt after 100 ms (diagnostic policy); the
fifth failure/expired fifth lease becomes dead. Dead rows remain inspectable.
E04: Publisher is the replaceable seam, owned by the dispatcher consumer. It accepts
an envelope and returns a durable receipt naming the same event. Missing/mismatched
receipt cannot acknowledge the outbox. Success means transport accepted durable
responsibility, not that subscribers finished. No fire-and-forget/no-op publisher.
The JetStream adapter maps PubAck to this promise; Core NATS publish alone
does not satisfy it. See jetstream/CONTRACT.md and its real adapter tests.
E05: The first publisher is a durable PostgreSQL mailbox in a separate transaction.
It deduplicates event IDs and refuses conflicting reuse. Crash after mailbox commit
but before outbox ack can redeliver; the mailbox must retain one matching event.
Mailbox rows hold one envelope each; they are not the processing state of any one
consumer. The mailbox is a single local delivery destination, not broker fanout or
ordered streams.
E06: Consumer callback takes an explicit consumer name. The selected mailbox row
and that consumer's receipt are locked, and the callback's local effects commit in
the same database transaction as that receipt's processed marker. A receipt is
keyed by (event ID, consumer), so two consumers may process the same envelope
independently. Savepoint isolates callback failure so its effects roll back while
that consumer's retry/dead metadata can commit. At most five committed attempts;
a whole-transaction abort can roll back attempt metadata, so this is not a
physical invocation limit. No external effects or peer-module calls inside this
transaction. Consumer names are lowercase ASCII letters, digits, dot, underscore
or hyphen, at most 64 bytes.
E07: Root owns the polling cadence, generator, stop signal, observation and shutdown.
One dispatch call is one attempt; there is no hidden global worker. All concrete
database operations are bounded. Publisher implementations honor cancellation and
a finite budget. Event payloads/attribution are persisted private data, never public
health output or generic logger fields.
E08: Real Postgres scenarios cover enqueue rollback, durable publication, duplicate
delivery, conflicting reuse, failed publisher retaining pending work, stale lease
ack refusal, consumer effect rollback/retry, poison retention and concurrency.
The separate JetStream integration tests exercise a second real publisher and its
durable handoff into the mailbox. Delivery is at least once, never exactly once.
