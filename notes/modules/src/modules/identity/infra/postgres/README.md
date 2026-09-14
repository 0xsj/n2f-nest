# TypeScript: identity store transactions on pg

**Origin:** implementing the stage 5 store contract (S01–S16) spec-first against a
real PostgreSQL database on 2026-09-12, then six mutations against it.

The shared transaction wrapper commits whenever the callback returns `ok`, and
PostgreSQL answers ROLLBACK to a COMMIT in an aborted transaction. A duplicate
email is therefore not an `ok('duplicate_email')` from inside the callback: the
unique violation has already aborted the transaction. Every value that must roll
back (`duplicate_email`, `stale`, `absent`, `already_inactive`, `rejected`) is
returned as a private `identity.store_rollback` failure carrying the outcome in a
field, and translated back to `ok(outcome)` after the wrapper has rolled back.
The marker never escapes the store. The alternative, a savepoint around the
credential insert, would have kept the transaction alive only to roll it back
anyway.

The canonical-email race is detected by the constraint name, not by a pre-read:
`n2f_identity_credentials_canonical_email_key` is PostgreSQL's generated name for
a column-level UNIQUE. Any other 23505 (a reused principal ID, a reused digest)
is rethrown and reaches the caller as the shared `database.conflict`. Eight
concurrent registrations block on the unique index until the winner commits,
then each loser sees its own violation; the spec asserts one `created` and one
credential row.

`resolve` cannot lock the session first without inverting the S04 order, so it
peeks at the session row without a lock, locks auth state, principal and
credential by that principal, then re-reads the session `FOR UPDATE`. Between the
peek and the lock a logout can commit; the re-read observes it. The latch on
observed expiry writes `revoked_at_ms` and commits before the refusal returns,
which is the one refusal path that commits rather than rolls back.

`pg` returns bigint columns as strings and integer columns as numbers; every
millisecond column goes through `Number()` before the domain sees it, and a NULL
becomes an omitted key so the domain's presence rule holds unchanged. Digests
travel as `Buffer` and are copied into a fresh `Uint8Array` before
`TokenDigest.parse`.

A stored row the domain refuses surfaces as Internal `identity.record_corrupt`
with the domain type in a public field. The spec provokes it by upper-casing a
stored canonical email: `Email.parse` would happily lowercase it again, so the
store compares the parsed value with the stored text instead of trusting parse.

A hand-written first draft of `resolve` reused the mutation helper, which settles
the rollback marker into a bare string; the resolver's `Resolution` object needs
its own settling. The first green run caught it.

**Limits:** the first real-database run used a local PostgreSQL 16.4 stand-in
because the Docker VM disk was full; after the disk was reclaimed the same spec
and the six mutations were rerun on PostgreSQL 18 through
`tools/verify_identity_store.py` and the isolated harness (see
[store mutation evidence](store-mutation-evidence.json)). Uncertain commit is not
reproduced; the store passes the shared classification through.
The `issueChallenge` port carries no events, so its rollback probe is the
version guard, not an enqueue failure.

**Used in:** index.ts, migrations/0001_identity.sql and integration.spec.ts.
See [the store contract](../../../../../../../src/modules/identity/infra/postgres/CONTRACT.md)
and [the application note](../../app/README.md).
