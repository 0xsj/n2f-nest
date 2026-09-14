# Local adapters: every attempt counts, and the subject never touches memory

**Origin:** implementing L01–L03, B01–B02 and M01 spec-first on 2026-09-12.

L01 says the counter increments on every admit call, permitted or not. The
consequence the first spec draft got wrong: a subject that is refused three
times still consumed three source attempts, so a fresh subject from the same
source is refused earlier than a per-permit count would suggest. That is the
intended behavior for a limiter that exists to slow abuse, and the spec now
states the arithmetic.

Bucket keys are keyed digests (purpose `rate_limit`) over the operation, a zero
byte and the raw subject or source. The map never holds an email or address,
and the safe view reports only the key count; the spec proves a sentinel
subject is absent from the serialized state.

The store is bounded by evicting expired windows lazily on access and sweeping
only when the bound is reached; a full store answers Unavailable, never permit.
The blocklist folds with NFC and `toLowerCase`, which is simple folding, not full
Unicode caseless matching; the contract asked for exactly that. Comparison is a
set lookup, so a substring of an entry is allowed.

**Limits:** one process, no persistence across restarts; the mail adapter has no
external effect and only counts. Stage 7 replaces both with Redis and Mailpit.

**Used in:** limiter.ts, blocklist.ts, mail.ts and local.spec.ts. See
[the adapters contract](../../../../../../../src/modules/identity/infra/local/CONTRACT.md).
